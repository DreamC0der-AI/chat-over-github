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

/** How many GitHub reads one listing runs at once: well under GitHub's limit on concurrent requests. */
export /** Days of mail listed directly from a cursor (see mailbox.list); a longer gap lists the folder. */
const MAIL_SPAN_DAYS = 8;
const READ_CONCURRENCY = 6;

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

export function githubProvider(o: GitHubProviderOptions): StorageProvider & { client: GitHubClient } {
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
    const b = await gh.call('GET', `${repoPath(owner, repo)}/git/blobs/${enc(f.sha)}`);
    if (b.status === 200 && typeof b.data?.content === 'string') return fromB64(b.data.content);
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
      if (r.status === 200 || r.status === 201) return 'ok';
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
      if (r.status === 200) return 'ok';
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
    const data = files.map((f) => f.data);
    const fail = async (what: string, status: number): Promise<never> => {
      if (status === 403 || status === 404) return denied(ow, re, what, status);
      throw new KeyholdError('config', `${what}: ${status}`);
    };
    // The blobs go up side by side; they belong to no commit until the ref moves.
    const blobs = await Promise.all(
      data.map(async (d) => {
        const r = await gh.call('POST', `${repo}/git/blobs`, { content: toB64(d), encoding: 'base64' }, undefined, true);
        if (r.status !== 201) await fail('write blob', r.status);
        return r.data.sha as string;
      }),
    );
    const tree = files.map((f, i) => ({ path: f.path, mode: '100644', type: 'blob', sha: blobs[i] }));
    let branch = branches.get(repo);
    for (let attempt = 0; attempt < 5; attempt++) {
      const [head, info] = await Promise.all([gh.call('GET', `${repo}/commits/HEAD`), branch ? undefined : gh.call('GET', repo)]);
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
      if (r.status === 200) return;
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
    const files = await inParallel(entries.filter((e) => e.type === 'file'), (e) => getFile(owner, repo, e.path));
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
      await gh.call('PUT', `${repo}/topics`, { names: ['keyhold-chat'] });
      // Members get full write access (GitHub ignores permission 'push' on personal repos).
      // Best effort, as plans without rulesets on private repos refuse: keep the history from
      // being force-pushed away or the branch deleted, and keep Actions workflows from running.
      // The app itself only ever fast-forwards (Contents API, and writeBatch with force: false).
      const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
      await Promise.all([
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
      for (const i of inst.data.installations ?? []) {
        for (let page = 1; page < 50; page++) {
          const r = await gh.expect('GET', `/user/installations/${i.id}/repositories?per_page=100&page=${page}`, [200]);
          for (const repo of r.data.repositories ?? []) if (String(repo.name).startsWith(prefix)) out.add(String(repo.full_name).toLowerCase());
          if ((r.data.repositories ?? []).length < 100) break;
        }
      }
      return [...out];
    },
    async canManage(space) {
      return splitSpace(space)[0] === login;
    },
    async members(space) {
      const [ow, re] = splitSpace(space);
      const c = await gh.expect('GET', `/repos/${enc(ow)}/${enc(re)}/collaborators?affiliation=direct&per_page=100`, [200]);
      const active = (c.data as { login: string }[]).map((u) => toAddress(u.login));
      if (!active.includes(toAddress(ow))) active.push(toAddress(ow));
      const pending: Address[] = [];
      if (ow === login) {
        const inv = await gh.expect('GET', `/repos/${enc(ow)}/${enc(re)}/invitations?per_page=100`, [200]);
        for (const i of inv.data as { invitee: { login: string } }[]) pending.push(toAddress(i.invitee.login));
      }
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

  return {
    name: 'github',
    client: gh,
    capabilities: caps,
    limits: { maxBlobBytes: 50 * 1024 * 1024, maxItemBytes: 1024 * 1024 },
    directory: {
      async read(owner) {
        const ow = userOf(owner);
        return readAll(ow, dirRepo, await listDir(ow, dirRepo, 'dir', false));
      },
      async append(index, entry) {
        await ensureOwnRepo(dirRepo, false, 'Public keys for an end-to-end encrypted chat app.');
        const have = (await listDir(login, dirRepo, 'dir', false)).filter((e) => e.type === 'file');
        if (have.length !== index) return 'conflict';
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
        const direct = (await listDir(ow, re, `log/${shard}`, false)).filter((e) => e.type === 'file' && /^\d{8}$/.test(e.name));
        if (direct.length && !direct.some((e) => Number(e.name) % 1000 === 999)) {
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
          // Appends must be contiguous: refuse to leave a gap.
          const prev = await gh.call('GET', contents(ow, re, logPath(index - 1)));
          if (prev.status === 404) return 'conflict';
        }
        return putFile(ow, re, logPath(index), entry, null);
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
        // Posters bucket by their own clock: re-scan the previous day too, to tolerate skew.
        const min = c && DAY.test(c.d) ? prevDay(c.d) : '';
        const listed: { d: { name: string }; files: DirEntry[] }[] = [];
        // Usually the days to look at are known (the cursor's day, the day before, up to tomorrow
        // for a poster's clock running ahead): list those folders at once, a round trip fewer.
        const span: string[] = [];
        if (min) for (let d = day(now() + 86_400_000); d >= min && span.length <= MAIL_SPAN_DAYS; d = prevDay(d)) span.unshift(d);
        if (span.length && span.length <= MAIL_SPAN_DAYS) {
          const got = await inParallel(span, async (name) => ({ d: { name }, files: (await listDir(ow, re, `mail/${name}`, false)).filter((f) => f.type === 'file') }));
          listed.push(...got.filter((x) => x.files.length));
        }
        // Nothing there (a quiet chat, or no access: the listing below tells), or a long gap.
        if (!listed.length) {
          const days = (await listDir(ow, re, 'mail')).filter((d) => d.type === 'dir' && DAY.test(d.name) && d.name >= min);
          // The trees API, not a Contents listing: a busy day can pass GitHub's 1,000-entry cap.
          // Junk any member wrote (a folder, a symlink) is not mail, and must not block it.
          listed.push(...(await inParallel(days, async (d) => ({ d, files: (await listDir(ow, re, d.path, true, d.sha)).filter((f) => f.type === 'file') }))));
        }
        const items: MailboxItem[] = [];
        const keep: string[] = [];
        const last = listed[listed.length - 1]?.d.name ?? c?.d ?? day(now());
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
          // Not readable yet: not seen, so the next list tries it again.
          if (d.name >= prevDay(last)) for (const f of entries) if (!missing.has(f.name)) keep.push(f.name);
        }
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
        for (const e of await listDir(ow, re, `drop/${seg(tag, 'recipient tag')}`, false)) {
          if (e.type !== 'file') continue;
          const f = await getFile(ow, re, e.path);
          if (f) out.push({ id: e.name, data: f.data });
        }
        return out;
      },
      async delete(space, tag, id) {
        const [ow, re] = splitSpace(space);
        const path = `drop/${seg(tag, 'recipient tag')}/${seg(id, 'drop id')}`;
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
        return (await listDir(login, homeRepo, 'items', false)).filter((e) => e.type === 'file').map((e) => ({ id: e.name, version: e.sha }));
      },
      async get(id) {
        return getFile(login, homeRepo, `items/${seg(id, 'item id')}`);
      },
      async put(id, data, expected) {
        seg(id, 'item id');
        await ensureOwnRepo(homeRepo, true, 'Encrypted settings for an end-to-end encrypted chat app.');
        return putFile(login, homeRepo, `items/${id}`, data, expected);
      },
      async delete(id, expected) {
        return deleteFile(login, homeRepo, `items/${seg(id, 'item id')}`, expected);
      },
    },
    channel,
  };
}
