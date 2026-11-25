/**
 * GitHub storage provider: implements the remote storage kinds with GitHub repos.
 *
 *   {login}/keyhold-id    public  box 3  directory: dir/{index}          (create-only files)
 *                                 box 3b pre-keys: prekeys/{deviceId}    (one per device, replaced)
 *   {login}/keyhold-home  private box 9  vault/{name}, box 12 items/{id} (sealed with K)
 *   {owner}/ghchat-xxxx   private per chat (the "space"):
 *                                 box 5  log/{index}       create-only = compare-and-swap
 *                                 box 6  mail/{day}/{id}
 *                                 box 7  blob/{id}
 *                                 box 8  drop/{tag}/{id}   deleted after read (stays in git history)
 *   Worker                        box 11 invite inbox (invitation ids only)
 *   box 4 (claim-once) is not provided: GitHub can't hand an item to exactly one taker.
 *
 * Compare-and-swap comes from the Contents API: creating a path that exists fails (422), and
 * updating needs the current blob sha (409 on mismatch). Channel side effects use the repo
 * collaborator API; on personal repos only the owner can invite or remove.
 *
 * Everything written is ciphertext or signed public data. Repo names, descriptions and topics
 * are plaintext, so they are neutral and identical for every chat.
 */
import { KeyholdError, randomBytes, toHex } from 'keyhold/util';
import type {
  Address,
  Bytes,
  CasResult,
  Capability,
  ChannelAccess,
  GrantResult,
  InviteInbox,
  MailboxItem,
  SpaceRef,
  StorageProvider,
  Versioned,
} from 'keyhold/storage';
import { GitHubClient, type FetchFn } from './client.js';

export interface GitHubProviderOptions {
  fetch: FetchFn;
  /** GitHub App user access token. */
  token: string;
  /** The signed-in user's login. */
  login: string;
  /** Base URL of the invite-inbox Worker. */
  workerUrl: string;
  apiBase?: string;
  directoryRepo?: string;
  homeRepo?: string;
  chatPrefix?: string;
  /** Shown on every chat repo. Must not contain anything personal. */
  description?: string;
  now?: () => number;
  /** How to wait between retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Where small files that never change under their name are kept across reloads, by git blob
   * sha: log entries, directory entries, the synced store's items. All of it is ciphertext or
   * signed public data, as in the repos. Only a cache: anything missing is fetched again.
   */
  blobStore?: BlobStore;
}

export interface BlobStore {
  get(sha: string): Promise<Uint8Array | undefined>;
  put(sha: string, data: Uint8Array): Promise<void>;
}

export const GITHUB_PREFIX = 'github:';
export const toAddress = (login: string): Address => GITHUB_PREFIX + login.toLowerCase();
export function loginOf(address: Address): string {
  if (!address.startsWith(GITHUB_PREFIX)) throw new KeyholdError('config', `not a GitHub address: ${address}`);
  return address.slice(GITHUB_PREFIX.length);
}

const pad = (n: number) => String(n).padStart(8, '0');
const logPath = (i: number) => `log/${String(Math.floor(i / 1000)).padStart(5, '0')}/${pad(i)}`;
const rid = () => toHex(randomBytes(10));

function toB64(b: Bytes): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Git's id for a file's bytes: sha1("blob <length>\0" + bytes), as the Contents API reports it. */
async function gitBlobSha(b: Bytes): Promise<string> {
  const head = new TextEncoder().encode(`blob ${b.length}\0`);
  const all = new Uint8Array(head.length + b.length);
  all.set(head);
  all.set(b, head.length);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', all)));
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
/** One path segment built from a value we didn't make (an id, ref, tag or name): no '/', no '.' or '..'. */
const SEG = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,200}$/;

function splitSpace(space: SpaceRef): [string, string] {
  const parts = String(space).split('/');
  const [o, r] = parts;
  if (parts.length !== 2 || !o || !r || !LOGIN.test(o) || !REPO.test(r)) throw new KeyholdError('config', `bad space ${space}`);
  return [o, r];
}
/** `v` checked as one safe path segment. */
function seg(v: string, what: string): string {
  if (typeof v !== 'string' || !SEG.test(v)) throw new KeyholdError('bad_format', `bad ${what}`);
  return v;
}
/** The GitHub login of an address, checked. */
function userOf(address: Address): string {
  const l = loginOf(address);
  if (!LOGIN.test(l)) throw new KeyholdError('config', `not a GitHub address: ${address}`);
  return l;
}

/** Contents API folder listings stop at this many entries. */
const LISTING_LIMIT = 1000;
const isRateLimit = (e: unknown) => (e as KeyholdError)?.code === 'too_many_attempts';

interface DirEntry {
  name: string;
  path: string;
  sha: string;
  type: string;
}

/**
 * Days of mail listed directly from a cursor (see mailbox.list): the last day with mail, the day
 * before it, today and tomorrow when the chat had mail yesterday or today. A longer gap lists
 * the folder first, so a chat that has been quiet for days doesn't cost a request per day.
 */
const MAIL_SPAN_DAYS = 4;
/** How many GitHub reads one listing runs at once: well under GitHub's limit on concurrent requests. */
const READ_CONCURRENCY = 6;

/**
 * What this browser knows of one chat repo, so that a check does not list its folders again.
 * It is made complete by a listing (the mailbox's days, the log's shard) and kept up by asking
 * GitHub which files the commits after `head` added: one request, and free when nothing did.
 * In memory only: after a reload the folders are listed again.
 */
interface View {
  /** The commit the view is complete up to. Always read before the listing it goes with. */
  head?: string;
  /** ETag of the last answer to "what changed since head", for a free "nothing". */
  etag?: string;
  /** A check under way: everyone waits for the same one. */
  checking?: Promise<boolean>;
  /** Counts answered checks; `genAt` is when the last one was answered. */
  gen: number;
  genAt: number;
  /** The check the mailbox / the log last built on (see `fresh`). */
  mailGen: number;
  logGen: number;
  /** Goes up when a check brings changes; `readRev` is the one the mailbox last handed out. */
  rev: number;
  readRev: number;
  /** Mail files by day, complete for the days from `mailFloor` on. */
  mail?: Map<string, Map<string, DirEntry>>;
  mailFloor: string;
  /** The log's newest shard. */
  log?: { shard: string; entries: Map<string, DirEntry> };
  /** Asked to list again whatever the view says (the app's safety net). */
  relistMail: boolean;
  relistLog: boolean;
}
/** A check answered this long ago is still good for the sync that follows it. */
const VIEW_FRESH_MS = 1500;
/** A view not checked for this long is rebuilt from a listing: the list of changes could be long. */
const VIEW_STALE_MS = 5 * 60_000;
/** GitHub lists at most this many changed files per comparison. */
const COMPARE_MAX_FILES = 300;
/** Small files kept by blob sha (mail, log entries, keys), so the same bytes are fetched once. */
const BLOB_CACHE_ITEM = 256 * 1024;
const BLOB_CACHE_BYTES = 8 * 1024 * 1024;
const MAIL_FILE = /^mail\/(\d{8})\/([^/]+)$/;
const LOG_FILE = /^log\/(\d{5})\/(\d{8})$/;

/** The change check the app drives (see `View`). */
export interface ChangeWatch {
  /**
   * Has the chat repo changed since the last look? True also when it can't tell, and until the
   * mailbox has handed out what an earlier check found. One request.
   */
  check(space: SpaceRef): Promise<boolean>;
  /** The next mailbox list and log read of this repo list its folders again. */
  relist(space: SpaceRef): void;
  /** The newest commit the checks know of in this repo, if any. No request. */
  head(space: SpaceRef): string | undefined;
  /**
   * The newest commit of each of these repos, asked for in one request (GraphQL): its id, or
   * null for a repo that can't be seen. Throws when the answer as a whole can't be used.
   */
  heads(spaces: SpaceRef[]): Promise<Map<SpaceRef, string | null>>;
}

/** `fn` over every item, a few at a time; results in the items' order. */
export async function inParallel<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = READ_CONCURRENCY): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function githubProvider(o: GitHubProviderOptions): StorageProvider & { client: GitHubClient; changes: ChangeWatch } {
  const gh = new GitHubClient({ fetch: o.fetch, token: o.token, apiBase: o.apiBase, sleep: o.sleep });
  const login = o.login.toLowerCase();
  const self = toAddress(login);
  const dirRepo = o.directoryRepo ?? 'keyhold-id';
  const homeRepo = o.homeRepo ?? 'keyhold-home';
  const prefix = o.chatPrefix ?? 'ghchat-';
  const description = o.description ?? 'Encrypted chat data. Only the chat app of its members can read it.';
  const now = o.now ?? Date.now;
  const enc = encodeURIComponent;
  const contents = (owner: string, repo: string, path: string) => `/repos/${enc(owner)}/${enc(repo)}/contents/${path.split('/').map(enc).join('/')}`;

  const repoPath = (owner: string, repo: string) => `/repos/${enc(owner)}/${enc(repo)}`;

  /**
   * A 403/404 from GitHub. Report access lost (`forbidden`, which keyhold treats as final) only
   * when GitHub confirms it: the repo itself is gone from our view. Anything else (a 403 with the
   * repo still readable) is reported as a passing failure.
   */
  async function denied(owner: string, repo: string, what: string, status: number): Promise<never> {
    const r = await gh.call('GET', repoPath(owner, repo));
    if (r.status === 404 || r.status === 403) throw new KeyholdError('forbidden', `no access to ${owner}/${repo} (${what}: ${status})`);
    throw new KeyholdError('config', `${what}: ${status}`);
  }

  // ---- Small files by blob sha: the same bytes are never fetched twice ---------------------
  const blobCache = new Map<string, Uint8Array<ArrayBuffer>>();
  let blobCacheBytes = 0;
  function remember(sha: string, data: Bytes) {
    if (data.length > BLOB_CACHE_ITEM || blobCache.has(sha)) return;
    blobCache.set(sha, new Uint8Array(data));
    blobCacheBytes += data.length;
    for (const [k, d] of blobCache) {
      if (blobCacheBytes <= BLOB_CACHE_BYTES) break;
      blobCache.delete(k);
      blobCacheBytes -= d.length;
    }
  }

  /** From memory, or from the store kept across reloads (checked against its sha: it is only a cache). */
  async function stored(sha: string): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const have = blobCache.get(sha);
    if (have || !o.blobStore) return have;
    try {
      const d = await o.blobStore.get(sha);
      if (!d || (await gitBlobSha(d)) !== sha) return undefined;
      remember(sha, d);
      return blobCache.get(sha) ?? new Uint8Array(d);
    } catch {
      return undefined;
    }
  }
  /** Remember, also across reloads. */
  function keep(sha: string, data: Bytes) {
    remember(sha, data);
    if (o.blobStore && data.length <= BLOB_CACHE_ITEM) void o.blobStore.put(sha, new Uint8Array(data)).catch(() => undefined);
  }
  /** Files worth keeping across reloads when we write them ourselves. */
  const KEPT = /^(log\/\d{5}\/\d{8}|items\/[^/]+|dir\/[^/]+)$/;

  // ---- What changed in a chat repo, in one request (see View) -------------------------------
  const views = new Map<string, View>();
  const viewKey = (ow: string, re: string) => `${ow}/${re}`.toLowerCase();
  function viewOf(ow: string, re: string): View {
    let v = views.get(viewKey(ow, re));
    if (!v) views.set(viewKey(ow, re), (v = { gen: 0, genAt: -Infinity, mailGen: 0, logGen: 0, rev: 0, readRev: 0, mailFloor: '', relistMail: false, relistLog: false }));
    return v;
  }
  /** Nothing known any more: the next list and read ask GitHub for listings. */
  function forget(v: View) {
    v.head = v.etag = v.mail = v.log = undefined;
  }
  /** One file added, replaced or (no sha) removed, as far as the view covers its folder. */
  function applyChange(v: View, path: string, sha: string | undefined) {
    let m = MAIL_FILE.exec(path);
    if (m) {
      if (!v.mail || m[1]! < v.mailFloor) return;
      let files = v.mail.get(m[1]!);
      if (!files) v.mail.set(m[1]!, (files = new Map()));
      if (sha) files.set(m[2]!, { name: m[2]!, path, sha, type: 'file' });
      else files.delete(m[2]!);
      return;
    }
    if (!(m = LOG_FILE.exec(path)) || !v.log) return;
    // A newer shard has begun: the view of the log is over, the next read lists.
    if (m[1]! > v.log.shard) v.log = undefined;
    else if (m[1] === v.log.shard) {
      if (sha) v.log.entries.set(m[2]!, { name: m[2]!, path, sha, type: 'file' });
      else v.log.entries.delete(m[2]!);
    }
  }
  async function readHead(ow: string, re: string): Promise<string | undefined> {
    const r = await gh.call('GET', `${repoPath(ow, re)}/commits?per_page=1`);
    const sha = r.status === 200 && Array.isArray(r.data) ? r.data[0]?.sha : undefined;
    return typeof sha === 'string' && sha ? sha : undefined;
  }
  /** See ChangeWatch.check. Errors (offline, a rate limit) are the caller's to handle. */
  function check(space: SpaceRef): Promise<boolean> {
    const [ow, re] = splitSpace(space);
    const v = viewOf(ow, re);
    const look = async (): Promise<boolean> => {
      if (v.head && now() - v.genAt > VIEW_STALE_MS) forget(v);
      if (!v.head) {
        // No starting point (first look, or the view was dropped): take one now. It is older
        // than any listing made after it, so nothing can fall between the two.
        v.head = await readHead(ow, re);
        return true;
      }
      const base = v.head;
      const r = await gh.call('GET', `${repoPath(ow, re)}/compare/${enc(base)}...HEAD`, undefined, undefined, false, v.etag ? { 'If-None-Match': v.etag } : undefined);
      if (r.status === 304) return v.rev !== v.readRev;
      const d = r.data;
      if (r.status !== 200 || !d || typeof d !== 'object') {
        // The starting point is gone (history rewritten), or the repo is: the listings tell.
        forget(v);
        return true;
      }
      if (d.status === 'identical' || d.status === 'behind') {
        if (v.head === base) v.etag = r.etag;
        return v.rev !== v.readRev;
      }
      const tip = Array.isArray(d.commits) ? d.commits[d.commits.length - 1]?.sha : undefined;
      if (d.status !== 'ahead' || typeof tip !== 'string' || !tip || !Array.isArray(d.files) || d.commits.length !== d.total_commits || d.files.length >= COMPARE_MAX_FILES) {
        // More than one answer carries (a long gap), or an answer we don't understand.
        forget(v);
        return true;
      }
      for (const f of d.files as { filename?: unknown; previous_filename?: unknown; status?: unknown; sha?: unknown }[]) {
        if (typeof f?.filename !== 'string') continue;
        if (typeof f.previous_filename === 'string') applyChange(v, f.previous_filename, undefined);
        applyChange(v, f.filename, f.status !== 'removed' && typeof f.sha === 'string' ? f.sha : undefined);
      }
      // A write of ours that landed meanwhile moved the start itself: keep that one (the
      // answer may be older), and let the next check repeat what it must.
      if (v.head === base) {
        v.head = tip;
        v.etag = undefined;
      }
      v.rev++;
      return true;
    };
    v.checking ??= look()
      .then((changed) => {
        // Only an answer counts as a look: after a failure the next caller asks again.
        v.gen++;
        v.genAt = now();
        return changed;
      })
      .finally(() => {
        v.checking = undefined;
      });
    return v.checking;
  }
  /**
   * The view, checked for this caller. The app usually checks first and syncs right after: the
   * mailbox and the log then build on that check, each once, and ask nothing. Any other caller
   * (a send that syncs first, a join) gets a check of its own.
   */
  async function fresh(space: SpaceRef, part: 'mailGen' | 'logGen'): Promise<View> {
    const [ow, re] = splitSpace(space);
    const v = viewOf(ow, re);
    if (v.checking) await v.checking;
    else if (!(v[part] < v.gen && now() - v.genAt <= VIEW_FRESH_MS)) await check(space);
    v[part] = v.gen;
    return v;
  }
  /**
   * Our own write landed as `commit` on top of `parent`. If that is where the view stood, nothing
   * of anyone else's came between: the view moves along, and the next check has nothing to say.
   */
  async function wrote(ow: string, re: string, files: { path: string; data?: Bytes; sha?: string }[], commit: unknown, parent: unknown) {
    const v = views.get(viewKey(ow, re));
    const mine = !!v?.head && typeof commit === 'string' && !!commit && parent === v.head;
    const shas = await Promise.all(files.map(async (f) => (!f.data ? undefined : (f.sha ?? (mine || f.data.length <= BLOB_CACHE_ITEM ? await gitBlobSha(f.data) : undefined)))));
    files.forEach((f, i) => f.data && shas[i] && (KEPT.test(f.path) ? keep : remember)(shas[i]!, f.data));
    // Checked again: the view may have moved while the hashes were made.
    if (!mine || v!.head !== parent) return;
    v!.head = commit as string;
    v!.etag = undefined;
    files.forEach((f, i) => applyChange(v!, f.path, shas[i]));
  }

  /** A file's bytes and blob sha; undefined when missing or not a file (a folder, a symlink). */
  async function getFile(owner: string, repo: string, path: string): Promise<Versioned | undefined> {
    const r = await gh.call('GET', contents(owner, repo, path));
    if (r.status === 404) return undefined;
    if (r.status === 403) return denied(owner, repo, `read ${path}`, r.status);
    if (r.status !== 200) throw new KeyholdError('config', `read ${path}: ${r.status}`);
    // Anyone with write access can put a folder or a symlink where a file should be: not ours.
    if (Array.isArray(r.data) || r.data?.type !== 'file' || typeof r.data.sha !== 'string') return undefined;
    let data: Uint8Array<ArrayBuffer> | undefined;
    if (r.data.encoding === 'base64' && typeof r.data.content === 'string' && (r.data.content.length > 0 || r.data.size === 0)) {
      data = fromB64(r.data.content);
      // The Contents API may "detect" a text encoding in binary data (e.g. UTF-16) and hand back
      // the bytes converted to UTF-8, which garbles anything sealed. Keep the content only if it
      // is exactly the blob GitHub stored.
      if ((await gitBlobSha(data)) !== r.data.sha) data = undefined;
    }
    if (!data) {
      // Files over 1 MB come without content, and converted content is useless: the git blob
      // endpoint always returns the stored bytes.
      const b = await gh.call('GET', `${repoPath(owner, repo)}/git/blobs/${enc(r.data.sha)}`);
      if (b.status === 404) return undefined;
      if (b.status === 403) return denied(owner, repo, `read ${path}`, b.status);
      if (b.status !== 200 || typeof b.data?.content !== 'string') throw new KeyholdError('config', `read ${path}: ${b.status}`);
      data = fromB64(b.data.content);
    }
    return { data, version: r.data.sha };
  }

  /** A folder's entries from the Git trees API (no 1,000-entry cap), by the folder's tree sha. */
  async function listTree(owner: string, repo: string, path: string, sha: string): Promise<DirEntry[] | undefined> {
    const r = await gh.call('GET', `${repoPath(owner, repo)}/git/trees/${enc(sha)}`);
    if (r.status === 404) return undefined;
    if (r.status === 403) return denied(owner, repo, `list ${path}`, r.status);
    if (r.status !== 200 || !Array.isArray(r.data?.tree)) throw new KeyholdError('config', `list ${path}: ${r.status}`);
    const type = (t: string) => (t === 'blob' ? 'file' : t === 'tree' ? 'dir' : t === 'commit' ? 'submodule' : t);
    return (r.data.tree as { path: string; type: string; sha: string; mode: string }[])
      .map((e) => ({ name: e.path, path: `${path}/${e.path}`, sha: e.sha, type: e.mode === '120000' ? 'symlink' : type(e.type) }))
      .sort(byName);
  }

  const byName = (a: DirEntry, b: DirEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  /**
   * A folder's entries, sorted by name. `sha` (the folder's tree sha, from its parent's listing)
   * reads it with the trees API straight away; without it, a Contents listing that hit GitHub's
   * 1,000-entry cap is read again with the trees API.
   */
  /** A mail file's bytes, by the blob sha its listing gave; undefined while GitHub can't serve it yet. */
  async function readMail(owner: string, repo: string, f: DirEntry): Promise<Versioned['data'] | undefined> {
    const have = blobCache.get(f.sha);
    if (have) return have;
    const b = await gh.call('GET', `${repoPath(owner, repo)}/git/blobs/${enc(f.sha)}`);
    if (b.status === 200 && typeof b.data?.content === 'string') {
      const data = fromB64(b.data.content);
      remember(f.sha, data);
      return data;
    }
    if (b.status === 403) return denied(owner, repo, `read ${f.path}`, b.status);
    if (b.status !== 404) throw new KeyholdError('config', `read ${f.path}: ${b.status}`);
    return (await getFile(owner, repo, f.path))?.data;
  }

  async function listDir(owner: string, repo: string, path: string, mustExist = true, sha?: string): Promise<DirEntry[]> {
    if (sha) {
      const t = await listTree(owner, repo, path, sha);
      if (t) return t;
    }
    const r = await gh.call('GET', contents(owner, repo, path));
    if (r.status === 404) {
      // GitHub answers 404 both for "no such folder" and "no access to a private repo".
      if (mustExist && (await gh.call('GET', repoPath(owner, repo))).status === 404) {
        throw new KeyholdError('forbidden', `no access to ${owner}/${repo}`);
      }
      return [];
    }
    if (r.status === 403) return denied(owner, repo, `list ${path}`, r.status);
    if (r.status !== 200 || !Array.isArray(r.data)) throw new KeyholdError('config', `list ${path}: ${r.status}`);
    const entries = (r.data as DirEntry[]).sort(byName);
    if (entries.length >= LISTING_LIMIT) {
      // Maybe truncated: find the folder's tree sha in its parent's listing and read the tree.
      const cut = path.lastIndexOf('/');
      const parent = await gh.call('GET', contents(owner, repo, cut < 0 ? '' : path.slice(0, cut)));
      const me = Array.isArray(parent.data) ? (parent.data as DirEntry[]).find((e) => e.path === path && e.type === 'dir') : undefined;
      const t = me && (await listTree(owner, repo, path, me.sha));
      if (t) return t;
    }
    return entries;
  }

  /**
   * Create (`sha` null) or replace (`sha` = the current blob sha) a file, compare-and-swap.
   * Safe to repeat: a 409 that only means "another commit landed on the branch meanwhile" is
   * retried, and finding our exact bytes already there (a reply lost after the write landed, or a
   * retry of a caller-chosen path) counts as done.
   */
  async function putFile(owner: string, repo: string, path: string, data: Bytes, sha: string | null): Promise<CasResult> {
    const body: Record<string, unknown> = { message: 'update', content: toB64(data) };
    if (sha) body.sha = sha;
    let mine: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await gh.backoff(attempt - 1);
      const r = await gh.call('PUT', contents(owner, repo, path), body, undefined, true);
      if (r.status === 200 || r.status === 201) {
        await wrote(owner, repo, [{ path, data }], r.data?.commit?.sha, r.data?.commit?.parents?.[0]?.sha);
        return 'ok';
      }
      if (r.status === 409 || r.status === 422) {
        const cur = await getFile(owner, repo, path);
        mine ??= await gitBlobSha(data);
        if (cur?.version === mine) return 'ok';
        // 409 with the file as we expected it: a concurrent commit elsewhere on the branch.
        if (r.status === 409 && (sha === null ? !cur : cur?.version === sha)) continue;
        return 'conflict';
      }
      if (r.status === 404 && sha === null) {
        // A create can 404 on a race over a new folder, but also because the repo is gone (deleted,
        // or our access ended). Only the first is worth a retry.
        if ((await gh.call('GET', repoPath(owner, repo))).status === 404) throw new KeyholdError('forbidden', `no access to ${owner}/${repo}`);
        continue;
      }
      if (r.status === 403 || r.status === 404) return denied(owner, repo, `write ${path}`, r.status);
      throw new KeyholdError('config', `write ${path}: ${r.status}`);
    }
    return 'conflict';
  }

  async function deleteFile(owner: string, repo: string, path: string, sha: string): Promise<CasResult> {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await gh.backoff(attempt - 1);
      const r = await gh.call('DELETE', contents(owner, repo, path), { message: 'update', sha }, undefined, true);
      if (r.status === 200) {
        await wrote(owner, repo, [{ path }], r.data?.commit?.sha, r.data?.commit?.parents?.[0]?.sha);
        return 'ok';
      }
      if (r.status === 404) return 'conflict';
      if (r.status === 409 || r.status === 422) {
        const cur = await getFile(owner, repo, path);
        if (!cur) return 'conflict';
        if (r.status === 409 && cur.version === sha) continue;
        return 'conflict';
      }
      if (r.status === 403) return denied(owner, repo, `delete ${path}`, r.status);
      throw new KeyholdError('config', `delete ${path}: ${r.status}`);
    }
    return 'conflict';
  }

  /** Default branch of each chat repo we posted a batch to. */
  const branches = new Map<string, string>();

  /** Mail ids for a batch: same time stamp, then a counter, so they sort in the order given. */
  const batchIds = (t: number, n: number) => Array.from({ length: n }, (_, i) => `${t.toString(36)}-${i.toString(16).padStart(2, '0')}${toHex(randomBytes(9))}`);

  /**
   * Mail ids for `mailbox.newId`: the time, a counter within that millisecond, then randomness,
   * so ids made one after another sort in that order (like batchIds).
   */
  let lastIdTime = 0;
  let idSeq = 0;
  const nextId = () => {
    let t = now();
    if (t <= lastIdTime) {
      t = lastIdTime;
      if (++idSeq > 0xff) {
        t = ++lastIdTime;
        idSeq = 0;
      }
    } else idSeq = 0;
    lastIdTime = t;
    return `${t.toString(36)}-${idSeq.toString(16).padStart(2, '0')}${toHex(randomBytes(9))}`;
  };
  /** Ids from newId() not tried yet: nothing can be at them, so a first post needs no check. */
  const issued = new Set<string>();
  const MAIL_ID = /^([0-9a-z]{1,11})-[0-9a-f]{8,64}$/;

  /**
   * Where items with caller-chosen ids go (see Mailbox in keyhold). The day folder comes from the
   * id's time. An id that may have been tried before (a retry, maybe after a reload) is looked up
   * first: the same bytes there are a success (`done`), other bytes a conflict. A day older than
   * yesterday is behind every reader's cursor, so an item not there yet gets a fresh id instead.
   */
  async function placeWithIds(ow: string, re: string, items: { id: string; data: Bytes }[]) {
    const oldest = prevDay(day(now()));
    const out: { id: string; path: string; data: Bytes; done: boolean }[] = [];
    for (const it of items) {
      const m = MAIL_ID.exec(seg(it.id, 'mail id'));
      const t = m ? parseInt(m[1]!, 36) : NaN;
      if (!Number.isFinite(t) || t <= 0) throw new KeyholdError('bad_format', 'bad mail id');
      const fresh = issued.delete(it.id);
      const d = day(t);
      if (!fresh) {
        const cur = await getFile(ow, re, `mail/${d}/${it.id}`);
        if (cur) {
          if (cur.version !== (await gitBlobSha(it.data))) throw new KeyholdError('conflict', 'another item has this id');
          out.push({ ...it, path: `mail/${d}/${it.id}`, done: true });
          continue;
        }
      }
      if (d < oldest) {
        const id = nextId();
        out.push({ id, data: it.data, path: `mail/${day(parseInt(id.split('-')[0]!, 36))}/${id}`, done: false });
        continue;
      }
      out.push({ ...it, path: `mail/${d}/${it.id}`, done: false });
    }
    return out;
  }


  /** New files as ONE commit (Git Data API): blobs side by side, then tree, commit and ref. */
  async function writeBatch(space: SpaceRef, files: { path: string; data: Bytes }[]): Promise<void> {
    const [ow, re] = splitSpace(space);
    const repo = `/repos/${enc(ow)}/${enc(re)}`;
    // One or two files: plain writes, a round trip each, where a commit built by hand takes four.
    if (files.length <= 2) {
      for (const f of files) {
        if ((await putFile(ow, re, f.path, f.data, null)) !== 'ok') throw new KeyholdError('conflict', 'could not post');
      }
      return;
    }
    const data = files.map((f) => f.data);
    const fail = async (what: string, status: number): Promise<never> => {
      if (status === 403 || status === 404) return denied(ow, re, what, status);
      throw new KeyholdError('config', `${what}: ${status}`);
    };
    let branch = branches.get(repo);
    const tip = () => Promise.all([gh.call('GET', `${repo}/commits/HEAD`), branch ? undefined : gh.call('GET', repo)]);
    // The blobs go up side by side (they belong to no commit until the ref moves), and the
    // branch's head is asked for meanwhile.
    const first = tip();
    first.catch(() => undefined);
    const blobs = await Promise.all(
      data.map(async (d) => {
        const r = await gh.call('POST', `${repo}/git/blobs`, { content: toB64(d), encoding: 'base64' }, undefined, true);
        if (r.status !== 201) await fail('write blob', r.status);
        return r.data.sha as string;
      }),
    );
    const tree = files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: blobs[i] }));
    for (let attempt = 0; attempt < 5; attempt++) {
      const [head, info] = await (attempt ? tip() : first);
      if (head.status !== 200) await fail('read head', head.status);
      if (info) {
        if (info.status !== 200) await fail('read repo', info.status);
        branch = String(info.data.default_branch ?? 'main');
        branches.set(repo, branch);
      }
      const nt = await gh.call('POST', `${repo}/git/trees`, { base_tree: head.data.commit.tree.sha, tree }, undefined, true);
      if (nt.status !== 201) await fail('write tree', nt.status);
      const c = await gh.call('POST', `${repo}/git/commits`, { message: 'update', tree: nt.data.sha, parents: [head.data.sha] }, undefined, true);
      if (c.status !== 201) await fail('write commit', c.status);
      // Fast-forward only (so a ruleset blocking force-pushes never gets in the way): another
      // write landed first -> build on top of it and try again. A lost reply is retried the same
      // way: if the first update landed, the retry commits the same files again, changing nothing.
      const r = await gh.call('PATCH', `${repo}/git/refs/heads/${enc(branch!)}`, { sha: c.data.sha, force: false }, undefined, true);
      if (r.status === 200) {
        await wrote(ow, re, files.map((f, i) => ({ ...f, sha: blobs[i] })), c.data.sha, head.data.sha);
        return;
      }
      if (r.status !== 409 && r.status !== 422) await fail('move branch', r.status);
    }
    throw new KeyholdError('conflict', 'could not post');
  }

  /** Create one of the user's own repos if it doesn't exist yet. */
  const ensured = new Set<string>();
  async function ensureOwnRepo(name: string, priv: boolean, desc: string) {
    if (ensured.has(name)) return;
    const r = await gh.call('GET', `/repos/${enc(login)}/${enc(name)}`);
    if (r.status === 404) {
      await gh.expect('POST', '/user/repos', [201, 422], { name, private: priv, auto_init: true, description: desc, has_issues: false, has_wiki: false, has_projects: false });
    } else if (r.status !== 200) throw new KeyholdError('forbidden', `cannot open ${name}`);
    ensured.add(name);
  }

  /** The files' bytes, skipping entries that aren't files or are gone. */
  // A folder's files are read several at a time: one by one, a new browser catching up on a chat
  // (every log entry, every mail) took minutes on a phone.
  const readAll = async (owner: string, repo: string, entries: DirEntry[]) => {
    const files = await inParallel(entries.filter((e) => e.type === 'file'), async (e) => {
      const have = await stored(e.sha);
      if (have) return { data: have, version: e.sha };
      const f = await getFile(owner, repo, e.path);
      if (f) keep(f.version, f.data);
      return f;
    });
    return files.filter((f) => !!f).map((f) => f.data);
  };

  // ---- Mailbox with day buckets -----------------------------------------------------------
  const day = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
  const DAY = /^\d{8}$/;
  const prevDay = (d: string) => day(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - 86_400_000);

  const channel: ChannelAccess = {
    self,
    async createSpace() {
      const name = prefix + rid();
      // 422 can only be our own create landing behind a lost reply: the name is random.
      await gh.expect('POST', '/user/repos', [201, 422], { name, private: true, auto_init: true, description, has_issues: false, has_wiki: false, has_projects: false });
      const repo = repoPath(login, name);
      // Members get full write access (GitHub ignores permission 'push' on personal repos).
      // Best effort, as plans without rulesets on private repos refuse: keep the history from
      // being force-pushed away or the branch deleted, and keep Actions workflows from running.
      // The app itself only ever fast-forwards (Contents API, and writeBatch with force: false).
      const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
      // The three settings go out together: nothing reads them before the first invitation.
      await Promise.all([
        gh.call('PUT', `${repo}/topics`, { names: ['keyhold-chat'] }),
        quietly(
          gh.call('POST', `${repo}/rulesets`, {
            name: 'protect history',
            target: 'branch',
            enforcement: 'active',
            conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
            rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }],
          }),
        ),
        quietly(gh.call('PUT', `${repo}/actions/permissions`, { enabled: false })),
      ]);
      return `${login}/${name}`;
    },
    async listSpaces() {
      const out = new Set<string>();
      const inst = await gh.expect('GET', '/user/installations?per_page=100', [200]);
      // One installation per account we share a chat with: asked side by side.
      await inParallel((inst.data.installations ?? []) as { id: number }[], async (i) => {
        for (let page = 1; page < 50; page++) {
          const r = await gh.expect('GET', `/user/installations/${i.id}/repositories?per_page=100&page=${page}`, [200]);
          for (const repo of r.data.repositories ?? []) if (String(repo.name).startsWith(prefix)) out.add(String(repo.full_name).toLowerCase());
          if ((r.data.repositories ?? []).length < 100) break;
        }
      });
      return [...out].sort();
    },
    async canManage(space) {
      return splitSpace(space)[0] === login;
    },
    async members(space) {
      const [ow, re] = splitSpace(space);
      const [c, inv] = await Promise.all([
        gh.expect('GET', `/repos/${enc(ow)}/${enc(re)}/collaborators?affiliation=direct&per_page=100`, [200]),
        ow === login ? gh.expect('GET', `/repos/${enc(ow)}/${enc(re)}/invitations?per_page=100`, [200]) : undefined,
      ]);
      const active = (c.data as { login: string }[]).map((u) => toAddress(u.login));
      if (!active.includes(toAddress(ow))) active.push(toAddress(ow));
      const pending: Address[] = [];
      for (const i of (inv?.data ?? []) as { invitee: { login: string } }[]) pending.push(toAddress(i.invitee.login));
      return { active, pending };
    },
    async grant(space, address): Promise<GrantResult> {
      const [ow, re] = splitSpace(space);
      if (ow !== login) return { status: 'needs-manager' };
      const r = await gh.expect('PUT', `/repos/${enc(ow)}/${enc(re)}/collaborators/${enc(userOf(address))}`, [201, 204], { permission: 'push' });
      if (r.status === 204) return { status: 'already-member' };
      return { status: 'invited', pointer: `${space}#${r.data.id}` };
    },
    async acceptGrant(pointer) {
      const id = pointer.split('#').pop()!;
      if (!/^\d{1,20}$/.test(id)) throw new KeyholdError('bad_format', 'bad invitation pointer');
      const r = await gh.call('PATCH', `/user/repository_invitations/${enc(id)}`);
      // 404/410: already accepted, withdrawn or expired. The inbox can lag (KV is eventually consistent).
      if (![204, 404, 410].includes(r.status)) throw new KeyholdError('forbidden', `accept invitation: ${r.status}`);
    },
    async revoke(space, address) {
      const [ow, re] = splitSpace(space);
      if (ow !== login) return 'needs-manager';
      const who = userOf(address).toLowerCase();
      if (who === login) return 'done';
      await gh.expect('DELETE', `/repos/${enc(ow)}/${enc(re)}/collaborators/${enc(who)}`, [204, 404]);
      const inv = await gh.expect('GET', `/repos/${enc(ow)}/${enc(re)}/invitations?per_page=100`, [200]);
      for (const i of inv.data as { id: number; invitee: { login: string } }[]) {
        if (i.invitee.login.toLowerCase() === who) await gh.expect('DELETE', `/repos/${enc(ow)}/${enc(re)}/invitations/${i.id}`, [204, 404]);
      }
      return 'done';
    },
  };

  const worker = o.workerUrl.replace(/\/$/, '');
  const workerCall = async (method: string, path: string, body?: unknown) => {
    gh.requests++;
    const res = await o.fetch(worker + path, {
      method,
      headers: { Authorization: `Bearer ${o.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    return { status: res.status, data: t ? JSON.parse(t) : undefined };
  };
  const inviteInbox: InviteInbox = {
    async send(_to, notice) {
      // The Worker checks the invitation exists on the caller's own repo and files it under the invitee.
      const [space, id] = notice.pointer.split('#');
      const [, repo] = splitSpace(space!);
      // An optional note (sealed to the invitee's devices by Keyhold) rides along; the Worker only stores it.
      const note = notice.payload ? toB64(notice.payload) : undefined;
      const r = await workerCall('POST', '/invites', { invite_id: Number(id), repo, ...(note ? { note } : {}) });
      if (r.status === 429) throw new KeyholdError('too_many_attempts', 'invite rate limit reached');
      if (r.status !== 201) throw new KeyholdError('config', `invite inbox: ${r.status}`);
    },
    async list() {
      const r = await workerCall('GET', '/invites');
      if (r.status !== 200) throw new KeyholdError('forbidden', `invite inbox: ${r.status}`);
      return (r.data.invites as { id: number; from: string; expires_at: string; note?: string }[]).map((i) => ({
        id: String(i.id),
        from: toAddress(i.from),
        pointer: String(i.id),
        expiresAt: Date.parse(i.expires_at),
        ...(i.note ? { payload: fromB64(i.note) } : {}),
      }));
    },
    async delete(id) {
      await workerCall('DELETE', `/invites/${enc(id)}`);
    },
  };

  const caps = new Set<Capability>(['owner-managed-spaces', 'pre-keys', 'inbox-payload']);
  /** Directory reads under way, by owner. */
  const dirReads = new Map<string, Promise<Bytes[]>>();
  /** The synced store's last listing: which version each item had, and when. */
  let itemsListed: { at: number; shas: Map<string, string>; asked: Set<string> } | undefined;
  const ITEMS_LISTED_MS = 10_000;
  /** The last log entry this browser wrote, by chat: the next one needs no look at it. */
  const appended = new Map<string, number>();
  /** Versions of drops read, for their delete. */
  const dropVersions = new Map<string, string>();
  /** How many entries our own directory had when last read, and when (see directory.append). */
  let ownDir: { at: number; n: number } | undefined;

  return {
    name: 'github',
    client: gh,
    capabilities: caps,
    limits: { maxBlobBytes: 50 * 1024 * 1024, maxItemBytes: 1024 * 1024 },
    directory: {
      read(owner) {
        const ow = userOf(owner);
        // Several chats looking up the same person at once (after a reload, all of them) share
        // one read. Entries are create-only files: one read before stays read.
        let run = dirReads.get(ow);
        if (!run) {
          run = (async () => {
            const entries = await listDir(ow, dirRepo, 'dir', false);
            if (ow === login) ownDir = { at: now(), n: entries.filter((e) => e.type === 'file').length };
            return readAll(ow, dirRepo, entries);
          })().finally(() => dirReads.delete(ow));
          dirReads.set(ow, run);
        }
        return run;
      },
      async append(index, entry) {
        await ensureOwnRepo(dirRepo, false, 'Public keys for an end-to-end encrypted chat app.');
        // The writer has just read the directory to make this entry: that count will do. (If
        // another browser appended since, the create below fails, as a conflict should.)
        const known = ownDir && now() - ownDir.at <= ITEMS_LISTED_MS ? ownDir.n : undefined;
        ownDir = undefined;
        if (known !== index) {
          const have = (await listDir(login, dirRepo, 'dir', false)).filter((e) => e.type === 'file');
          if (have.length !== index) return 'conflict';
        }
        return putFile(login, dirRepo, `dir/${pad(index)}`, entry, null);
      },
    },
    preKeys: {
      async publish(deviceId, data) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) throw new KeyholdError('bad_format', 'bad device id');
        await ensureOwnRepo(dirRepo, false, 'Public keys for an end-to-end encrypted chat app.');
        for (let attempt = 0; attempt < 5; attempt++) {
          const cur = await getFile(login, dirRepo, `prekeys/${deviceId}`);
          if ((await putFile(login, dirRepo, `prekeys/${deviceId}`, data, cur?.version ?? null)) === 'ok') return;
        }
        throw new KeyholdError('conflict', 'could not publish the pre-key');
      },
      async read(owner) {
        const ow = userOf(owner);
        return readAll(ow, dirRepo, (await listDir(ow, dirRepo, 'prekeys', false)).filter((e) => e.type === 'file'));
      },
    },
    inviteInbox,
    orderedLog: {
      // log/{shard}/{index}: a GitHub folder listing stops at 1,000 entries, so 1,000 per shard.
      async read(space, from) {
        const [ow, re] = splitSpace(space);
        // Most reads are the tail of one shard: list it directly, one round trip fewer. Not when
        // it is empty (maybe no access: the listing below tells) or full (more shards follow).
        const first = Math.floor(from / 1000);
        const shard = String(first).padStart(5, '0');
        const usable = (es: DirEntry[]) => es.length > 0 && !es.some((e) => Number(e.name) % 1000 === 999);
        const v = await fresh(space, 'logGen');
        const head = v.head;
        if (head && v.log?.shard === shard && !v.relistLog) {
          // Known from a listing plus the changes since: no listing, and entries read before
          // (the last one is read again each time, to see that the log was not rewritten) cost nothing.
          const known = [...v.log.entries.values()].sort(byName);
          if (usable(known)) return readAll(ow, re, known.filter((e) => Number(e.name) >= from));
        }
        const direct = (await listDir(ow, re, `log/${shard}`, false)).filter((e) => e.type === 'file' && /^\d{8}$/.test(e.name));
        if (usable(direct)) {
          // Only if the view still starts where it did before the listing: a check that moved it
          // meanwhile may know of an entry this listing was too early for.
          if (head && v.head === head) {
            v.log = { shard, entries: new Map(direct.map((e) => [e.name, { name: e.name, path: e.path, sha: e.sha, type: e.type }])) };
            v.relistLog = false;
          }
          return readAll(ow, re, direct.filter((e) => Number(e.name) >= from));
        }
        const shards = (await listDir(ow, re, 'log')).filter((d) => d.type === 'dir' && /^\d{5}$/.test(d.name) && Number(d.name) >= Math.floor(from / 1000));
        const out: Bytes[] = [];
        for (const sh of shards) {
          // Junk any member put in a shard (folders, other names) is not part of the log.
          const entries = (await listDir(ow, re, sh.path)).filter((e) => e.type === 'file' && /^\d{8}$/.test(e.name) && Number(e.name) >= from);
          out.push(...(await readAll(ow, re, entries)));
        }
        return out;
      },
      async append(space, index, entry) {
        const [ow, re] = splitSpace(space);
        if (index > 0) {
          // Appends must be contiguous: refuse to leave a gap. Usually the entry before is known
          // (listed, named by a check, or written by us); otherwise ask.
          const before = LOG_FILE.exec(logPath(index - 1))!;
          const v = views.get(viewKey(ow, re));
          const known = appended.get(viewKey(ow, re)) === index - 1 || (v?.head && v.log && v.log.shard === before[1] && v.log.entries.has(before[2]!));
          if (!known) {
            const prev = await gh.call('GET', contents(ow, re, logPath(index - 1)));
            if (prev.status === 404) return 'conflict';
          }
        }
        const r = await putFile(ow, re, logPath(index), entry, null);
        if (r === 'ok') appended.set(viewKey(ow, re), index);
        return r;
      },
    },
    mailbox: {
      /** A fresh mail id, made here (no network). Ids sort by time, then in the order made. */
      newId() {
        const id = nextId();
        issued.add(id);
        return id;
      },
      async post(space, data, options) {
        const [ow, re] = splitSpace(space);
        if (options?.id) {
          const [item] = await placeWithIds(ow, re, [{ id: options.id, data }]);
          if (item!.done) return item!.id;
          if ((await putFile(ow, re, item!.path, data, null)) === 'ok') return item!.id;
          // The same id holding other bytes: not ours to overwrite.
          throw new KeyholdError('conflict', 'another item has this id');
        }
        const t = now();
        for (let attempt = 0; attempt < 3; attempt++) {
          // putFile is idempotent for this path: a lost reply, retried, finds our bytes and succeeds.
          const id = `${t.toString(36)}-${rid()}`;
          if ((await putFile(ow, re, `mail/${day(t)}/${id}`, data, null)) === 'ok') return id;
          // 'conflict' on a create = something else at a random id: pick another.
        }
        throw new KeyholdError('conflict', 'could not post');
      },
      /**
       * Several items as ONE commit (Git Data API), so a burst costs one write however long it
       * is. Readers still see one ordinary file per item; ids sort in the order given.
       */
      async postMany(space, data, options) {
        const [ow, re] = splitSpace(space);
        let ids: string[];
        let files: { path: string; data: Bytes }[];
        if (options?.ids && options.ids.length === data.length) {
          const placed = await placeWithIds(ow, re, data.map((d, i) => ({ id: options.ids![i]!, data: d })));
          ids = placed.map((p) => p.id);
          // Items a lost reply already landed are not written again.
          files = placed.filter((p) => !p.done).map((p) => ({ path: p.path, data: p.data }));
          if (!files.length) return ids;
        } else {
          const t = now();
          ids = batchIds(t, data.length);
          files = data.map((d, i) => ({ path: `mail/${day(t)}/${ids[i]}`, data: d }));
        }
        try {
          await writeBatch(space, files);
        } catch (e) {
          // Lost access is final, and a rate limit must not turn into N more writes. Anything else
          // (an API surprise, a lost reply) falls back to one file per item, at the same paths, so
          // items the batch did write are found and not posted twice.
          if ((e as KeyholdError).code === 'forbidden' || isRateLimit(e)) throw e;
          for (const f of files) {
            if ((await putFile(ow, re, f.path, f.data, null)) !== 'ok') throw new KeyholdError('conflict', 'could not post');
          }
        }
        return ids;
      },
      async list(space, cursor) {
        const [ow, re] = splitSpace(space);
        const c = cursor ? (JSON.parse(cursor) as { d: string; s: string[] }) : undefined;
        const seen = new Set(c?.s ?? []);
        // No cursor day lies past tomorrow: a member whose clock runs far ahead (or who made up a
        // folder) must not move everyone's cursor away from the days mail is really posted in.
        const horizon = day(now() + 86_400_000);
        const cd = c && DAY.test(c.d) ? (c.d > horizon ? horizon : c.d) : undefined;
        // Posters bucket by their own clock: re-scan the previous day too, to tolerate skew.
        const min = cd ? prevDay(cd) : '';
        const listed: { d: { name: string }; files: DirEntry[] }[] = [];
        const v = await fresh(space, 'mailGen');
        const head = v.head;
        const rev = v.rev;
        if (head && v.mail && !v.relistMail && v.mailFloor <= min) {
          // Known from a listing plus the changes since: nothing to list.
          for (const name of [...v.mail.keys()].sort()) {
            const files = name >= min ? [...v.mail.get(name)!.values()].sort(byName) : [];
            if (files.length) listed.push({ d: { name }, files });
          }
        } else {
          // Usually the days to look at are known (the cursor's day, the day before, up to tomorrow
          // for a poster's clock running ahead): list those folders at once, a round trip fewer.
          const span: string[] = [];
          if (min) for (let d = horizon; d >= min && span.length <= MAIL_SPAN_DAYS; d = prevDay(d)) span.unshift(d);
          if (span.length && span.length <= MAIL_SPAN_DAYS) {
            const got = await inParallel(span, async (name) => ({ d: { name }, files: (await listDir(ow, re, `mail/${name}`, false)).filter((f) => f.type === 'file') }));
            listed.push(...got.filter((x) => x.files.length));
          }
          // Nothing there (a quiet chat, or no access: the listing below tells), or a long gap.
          if (!listed.length) {
            // (With a starting point, a check has just reached the repo: a missing folder is
            // only a chat without mail yet, and needs no second look at the repo.)
            const days = (await listDir(ow, re, 'mail', !head)).filter((d) => d.type === 'dir' && DAY.test(d.name) && d.name >= min);
            // The trees API, not a Contents listing: a busy day can pass GitHub's 1,000-entry cap.
            // Junk any member wrote (a folder, a symlink) is not mail, and must not block it.
            listed.push(...(await inParallel(days, async (d) => ({ d, files: (await listDir(ow, re, d.path, true, d.sha)).filter((f) => f.type === 'file') }))));
          }
          // The view starts from this listing, if it still stands where it did before it: a
          // check that moved it meanwhile may know of a file this listing was too early for.
          if (head && v.head === head) {
            v.mail = new Map(listed.map((x) => [x.d.name, new Map(x.files.map((f) => [f.name, { name: f.name, path: f.path, sha: f.sha, type: f.type }]))]));
            v.mailFloor = min;
            v.relistMail = false;
          }
        }
        const items: MailboxItem[] = [];
        const keep: string[] = [];
        let unread = false;
        const last = [...listed].reverse().find((x) => x.d.name <= horizon)?.d.name ?? cd ?? day(now());
        for (const { d, files: entries } of listed) {
          const want = entries.filter((f) => !seen.has(f.name));
          // By blob sha from the listing: a path read can still 404 for a moment after the commit
          // that listed it (GitHub replicas), and a file marked seen then was lost for good.
          const files = await inParallel(want, (f) => readMail(ow, re, f));
          const missing = new Set<string>();
          want.forEach((f, i) => {
            if (files[i]) items.push({ id: f.name, data: files[i]! });
            else missing.add(f.name);
          });
          if (missing.size) unread = true;
          // Not readable yet: not seen, so the next list tries it again.
          if (d.name >= prevDay(last)) for (const f of entries) if (!missing.has(f.name)) keep.push(f.name);
        }
        // Everything the checks up to `rev` found has been handed out (or is in the cursor).
        if (!unread && v.readRev < rev) v.readRev = rev;
        return { items, cursor: JSON.stringify({ d: last, s: keep }) };
      },
    },
    blobs: {
      async put(space, data) {
        const [ow, re] = splitSpace(space);
        for (let attempt = 0; attempt < 3; attempt++) {
          const id = rid();
          if ((await putFile(ow, re, `blob/${id}`, data, null)) === 'ok') return id;
        }
        throw new KeyholdError('conflict', 'could not store the attachment');
      },
      async get(space, ref) {
        const [ow, re] = splitSpace(space);
        return (await getFile(ow, re, `blob/${seg(ref, 'attachment ref')}`))?.data;
      },
      async delete(space, ref) {
        const [ow, re] = splitSpace(space);
        const path = `blob/${seg(ref, 'attachment ref')}`;
        const f = await getFile(ow, re, path);
        if (f) await deleteFile(ow, re, path, f.version);
      },
    },
    dropBox: {
      async put(space, tag, data) {
        const [ow, re] = splitSpace(space);
        seg(tag, 'recipient tag');
        for (let attempt = 0; attempt < 3; attempt++) {
          const id = rid();
          if ((await putFile(ow, re, `drop/${tag}/${id}`, data, null)) === 'ok') return id;
        }
        throw new KeyholdError('conflict', 'could not write the drop');
      },
      /** Tickets and Welcomes for several invitees as one commit. */
      async putMany(space, items) {
        const ids = items.map(() => rid());
        const files = items.map((it, i) => ({ path: `drop/${seg(it.tag, 'recipient tag')}/${ids[i]}`, data: it.data }));
        try {
          await writeBatch(space, files);
        } catch (e) {
          if ((e as KeyholdError).code === 'forbidden' || isRateLimit(e)) throw e;
          const [ow, re] = splitSpace(space);
          for (const f of files) {
            if ((await putFile(ow, re, f.path, f.data, null)) !== 'ok') throw new KeyholdError('conflict', 'could not write the drop');
          }
        }
        return ids;
      },
      async list(space, tag) {
        const [ow, re] = splitSpace(space);
        const out: MailboxItem[] = [];
        const entries = (await listDir(ow, re, `drop/${seg(tag, 'recipient tag')}`, false)).filter((e) => e.type === 'file');
        const files = await inParallel(entries, (e) => getFile(ow, re, e.path));
        entries.forEach((e, i) => {
          const f = files[i];
          if (!f) return;
          out.push({ id: e.name, data: f.data });
          // For the delete that follows a read: no second look for the file's version.
          dropVersions.set(`${viewKey(ow, re)}/${e.path}`, f.version);
        });
        return out;
      },
      async delete(space, tag, id) {
        const [ow, re] = splitSpace(space);
        const path = `drop/${seg(tag, 'recipient tag')}/${seg(id, 'drop id')}`;
        const key = `${viewKey(ow, re)}/${path}`;
        const known = dropVersions.get(key);
        dropVersions.delete(key);
        // A drop is written once under a random id: the version read is the version there.
        if (known && (await deleteFile(ow, re, path, known)) === 'ok') return;
        const f = await getFile(ow, re, path);
        if (f) await deleteFile(ow, re, path, f.version);
      },
    },
    vault: {
      async get(name) {
        return getFile(login, homeRepo, `vault/${seg(name, 'vault name')}`);
      },
      async put(name, data, expected) {
        seg(name, 'vault name');
        await ensureOwnRepo(homeRepo, true, 'Encrypted settings for an end-to-end encrypted chat app.');
        return putFile(login, homeRepo, `vault/${name}`, data, expected);
      },
    },
    personal: {
      async list() {
        const items = (await listDir(login, homeRepo, 'items', false)).filter((e) => e.type === 'file').map((e) => ({ id: e.name, version: e.sha }));
        itemsListed = { at: now(), shas: new Map(items.map((i) => [i.id, i.version])), asked: new Set() };
        return items;
      },
      async get(id) {
        // The first get after a listing (a pull lists, then gets what changed) is a read as of
        // that listing: the listed version, from the files kept by sha when we have it, so a
        // reload re-reads only what did change. Any later get asks GitHub (a write reads the
        // current version first, and must not build on an older one).
        seg(id, 'item id');
        const listed = itemsListed && now() - itemsListed.at <= ITEMS_LISTED_MS && !itemsListed.asked.has(id) ? itemsListed : undefined;
        itemsListed?.asked.add(id);
        const sha = listed?.shas.get(id);
        // Not in the listing: no such item (as of then), without asking for a 404.
        if (listed && !sha) return undefined;
        const have = sha && (await stored(sha));
        if (have) return { data: have, version: sha };
        const f = await getFile(login, homeRepo, `items/${seg(id, 'item id')}`);
        if (f) keep(f.version, f.data);
        return f;
      },
      async put(id, data, expected) {
        seg(id, 'item id');
        await ensureOwnRepo(homeRepo, true, 'Encrypted settings for an end-to-end encrypted chat app.');
        itemsListed?.asked.add(id);
        return putFile(login, homeRepo, `items/${id}`, data, expected);
      },
      async delete(id, expected) {
        itemsListed?.asked.add(id);
        return deleteFile(login, homeRepo, `items/${seg(id, 'item id')}`, expected);
      },
    },
    channel,
    changes: {
      check,
      relist(space) {
        const [ow, re] = splitSpace(space);
        const v = viewOf(ow, re);
        v.relistMail = v.relistLog = true;
      },
      head(space) {
        const [ow, re] = splitSpace(space);
        return views.get(viewKey(ow, re))?.head;
      },
      async heads(spaces) {
        const out = new Map<SpaceRef, string | null>();
        if (!spaces.length) return out;
        // Names go in as JSON strings, which GraphQL reads the same way.
        const parts = spaces.map((sp, i) => {
          const [ow, re] = splitSpace(sp);
          return `r${i}: repository(owner: ${JSON.stringify(ow)}, name: ${JSON.stringify(re)}) { defaultBranchRef { target { oid } } }`;
        });
        const r = await gh.call('POST', '/graphql', { query: `query { ${parts.join(' ')} }` });
        const data = r.status === 200 ? (r.data as { data?: Record<string, unknown> } | undefined)?.data : undefined;
        if (!data || typeof data !== 'object') throw new KeyholdError('config', `heads: ${r.status}`);
        spaces.forEach((sp, i) => {
          const oid = (data[`r${i}`] as { defaultBranchRef?: { target?: { oid?: unknown } } } | null | undefined)?.defaultBranchRef?.target?.oid;
          out.set(sp, typeof oid === 'string' && oid ? oid : null);
        });
        return out;
      },
    },
  };
}
