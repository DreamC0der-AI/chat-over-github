/**
 * An in-memory GitHub (REST subset) plus the invite-inbox Worker, as a fetch function.
 * Emulates the behaviour the provider relies on:
 *  - private repos: only owner and accepted collaborators read and write; public: anyone reads
 *  - Contents API compare-and-swap: create of an existing path -> 422, wrong sha -> 409
 *  - files over 1 MB come back without content (use the git blob endpoint)
 *  - Git Data API commits of several files: blobs, a tree on the head, a commit, a fast-forward ref update
 *  - only the owner manages collaborators and invitations; invitations are accepted by the invitee
 *  - a GitHub App installed on "select repositories" with every repo the owner creates auto-added
 *  - the Worker inbox: keyed by invitee, checks the invitation is on the caller's repo
 * Plus test hooks: rewrite a file behind everyone's back (force-push), rate-limit, request log.
 *
 * Also emulated: Git trees API reads (GET git/trees/{sha}, the sha a Contents listing gives a
 * folder), repo rulesets (non_fast_forward and deletion rules are enforced on ref updates) and
 * the Actions permissions switch.
 *
 * Fault injection (opt-in; nothing below happens unless a test sets `faults`):
 *
 *   gh.faults = {
 *     seed: 7,                                  // PRNG seed for `probability` (default 1)
 *     conflict: { times: 2 },                   // 409 on a Contents PUT/DELETE, nothing written,
 *                                               //   as when another commit lands on the branch meanwhile
 *     secondaryLimit: { match: 'GET .*contents/mail', retryAfter: 30 },
 *                                               // 403 "secondary rate limit", retry-after header,
 *                                               //   x-ratelimit-remaining stays non-zero
 *     tooMany: { probability: 0.1 },            // 429 with retry-after
 *     serverError: { times: 1, status: 502 },   // 5xx (default 502), nothing done
 *     lostReply: { match: '^PUT .*contents/mail/' },
 *                                               // the request IS applied, then fetch rejects with
 *                                               //   TypeError('Failed to fetch')
 *     listingLimit: 1000,                       // Contents folder listings stop after N entries
 *                                               //   (sorted by name), as GitHub's do at 1,000
 *   };
 *
 * Each rule (`FaultRule`) fires on requests whose "METHOD /decoded/path" matches `match` (a regexp
 * source or RegExp, or a predicate). `times` = fire on the next N matching requests then stop;
 * `probability` = fire on each matching request with that chance, drawn from the seeded PRNG (so
 * a run is reproducible); both = at most N times, each with that chance; neither = once. A rule may
 * be an array of rules. Default `match`: Contents API PUT/DELETE for `conflict`, every request
 * otherwise. Checked in this order: secondaryLimit, tooMany, serverError, conflict, lostReply.
 * Assigning `gh.faults` resets the PRNG; `gh.faultLog` lists each fault fired ("kind METHOD path").
 * `gh.faults = undefined` turns everything off.
 */
import { createHash } from 'node:crypto';

interface File {
  sha: string;
  content: Buffer;
}
interface Repo {
  owner: string;
  name: string;
  private: boolean;
  collaborators: Set<string>;
  invitations: Map<number, string>;
  files: Map<string, File>;
  topics: string[];
  description: string;
  /** Head commit id; every write moves it, so a stale Git Data API commit can't fast-forward. */
  head: number;
  /** Rulesets: rule types in force on the default branch. */
  rules: Set<string>;
  actionsEnabled: boolean;
}

/** Git Data API objects not yet on a branch (blobs, trees, commits), shared by all repos. */
interface GitObjects {
  blobs: Map<string, Buffer>;
  trees: Map<string, { base: string; entries: { path: string; sha: string }[] }>;
  commits: Map<string, { tree: string; parent: string }>;
}

type Init = { method?: string; headers?: Record<string, string>; body?: string };

/** Git's blob id, like GitHub's file "sha". */
const sha = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

/** What GitHub's Contents API does to a file it takes for UTF-16 text: re-encode it as UTF-8. */
export type FaultMatch = string | RegExp | ((req: { method: string; path: string; user?: string }) => boolean);
export interface FaultRule {
  match?: FaultMatch;
  /** Fire on the next N matching requests (counts down as it fires). */
  times?: number;
  /** Chance to fire on each matching request, from the seeded PRNG. */
  probability?: number;
}
type Rules<T = object> = (FaultRule & T) | (FaultRule & T)[];
export interface Faults {
  seed?: number;
  conflict?: Rules;
  secondaryLimit?: Rules<{ retryAfter?: number }>;
  tooMany?: Rules<{ retryAfter?: number }>;
  serverError?: Rules<{ status?: number }>;
  lostReply?: Rules;
  listingLimit?: number;
}

/** mulberry32: small, seeded, deterministic. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTENTS_WRITE = /^(PUT|DELETE) \/repos\/[^/]+\/[^/]+\/contents\//;

const asUtf16ToUtf8 = (b: Buffer) => Buffer.from(b.subarray(0, b.length & ~1).swap16().toString('utf16le'), 'utf8');

export class MockGitHub {
  readonly users = new Map<string, { id: number; token: string }>();
  readonly repos = new Map<string, Repo>();
  readonly inbox = new Map<number, { id: number; from: string; from_id: number; created_at: string; expires_at: string; note?: string }[]>();
  readonly log: string[] = [];
  /** Test hook: paths whose Contents API content GitHub "converts" from UTF-16 (the blob stays intact). */
  readonly transcoded = new Set<string>();
  /** Remaining requests before a 403 rate-limit response (per token). */
  readonly budget = new Map<string, number>();
  private nextId = 1000;
  private git: GitObjects = { blobs: new Map(), trees: new Map(), commits: new Map() };
  /** Test hook: moves the head right before the next ref update, as another writer would. */
  raceNextRefUpdate = 0;
  /** Test hook: the Git Data API answers 500 (as an unexpected outage would). */
  gitDataDown = false;
  /** Every fault fired, as "kind METHOD /path". */
  readonly faultLog: string[] = [];
  private faultState?: { f: Faults; rnd: () => number; left: Map<object, number> };
  /** Tree snapshots handed out by Contents folder listings, by tree sha. */
  private trees = new Map<string, Map<string, File>>();
  /** Opt-in fault injection; see the header comment. */
  get faults(): Faults | undefined {
    return this.faultState?.f;
  }
  set faults(f: Faults | undefined) {
    this.faultState = f ? { f, rnd: prng(f.seed ?? 1), left: new Map() } : undefined;
  }

  /** The first rule of this kind that fires for the request, consuming one of its `times`. */
  private fault<T extends object>(rules: Rules<T> | undefined, req: { method: string; path: string; user?: string }, dflt?: RegExp): (FaultRule & T) | undefined {
    const st = this.faultState;
    if (!st || !rules) return undefined;
    const key = `${req.method} ${req.path}`;
    for (const r of Array.isArray(rules) ? rules : [rules]) {
      const m = r.match ?? dflt;
      const hit = m === undefined ? true : typeof m === 'function' ? m(req) : (typeof m === 'string' ? new RegExp(m) : m).test(key);
      if (!hit) continue;
      const left = st.left.get(r) ?? r.times ?? (r.probability !== undefined ? Infinity : 1);
      if (left <= 0) continue;
      if (r.probability !== undefined && st.rnd() >= r.probability) continue;
      st.left.set(r, left - 1);
      return r;
    }
    return undefined;
  }
  readonly api = 'https://api.github.test';
  readonly worker = 'https://worker.test';

  addUser(login: string) {
    const id = this.nextId++;
    const token = `tok-${login}`;
    this.users.set(login.toLowerCase(), { id, token });
    return { login: login.toLowerCase(), id, token };
  }

  private who(init?: Init): string | undefined {
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization;
    const tok = auth?.replace(/^Bearer /, '');
    for (const [login, u] of this.users) if (u.token === tok) return login;
    return undefined;
  }

  canRead(r: Repo, u?: string) {
    return !r.private || (u !== undefined && (u === r.owner || r.collaborators.has(u)));
  }
  canWrite(r: Repo, u?: string) {
    return u !== undefined && (u === r.owner || r.collaborators.has(u));
  }

  /** Test hook: the repo owner (or GitHub) rewrites a file, as a force-push would. */
  rewrite(fullName: string, path: string, content: Uint8Array) {
    const r = this.repos.get(fullName)!;
    const b = Buffer.from(content);
    r.files.set(path, { sha: sha(b), content: b });
    r.head++;
  }

  fetch = async (url: string, init: Init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    const user = this.who(init);
    this.log.push(`${method} ${u.pathname}`);
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (user) {
      const left = this.budget.get(user);
      if (left !== undefined) {
        if (left <= 0) return resp(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
        this.budget.set(user, left - 1);
      }
    }
    if (url.startsWith(this.worker)) return this.workerRoute(method, u, user, body);
    const path = decodeURIComponent(u.pathname);
    const f = this.faultState?.f;
    if (f) {
      const req = { method, path, user };
      const fired = (kind: string) => this.faultLog.push(`${kind} ${method} ${path}`);
      let r;
      if ((r = this.fault(f.secondaryLimit, req))) {
        fired('secondaryLimit');
        return resp(403, { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' }, { 'retry-after': String(r.retryAfter ?? 60), 'x-ratelimit-remaining': '4321' });
      }
      if ((r = this.fault(f.tooMany, req))) {
        fired('tooMany');
        return resp(429, { message: 'Too Many Requests' }, { 'retry-after': String(r.retryAfter ?? 60) });
      }
      if ((r = this.fault(f.serverError, req))) {
        fired('serverError');
        return resp(r.status ?? 502, { message: 'Server Error' });
      }
      if (this.fault(f.conflict, req, CONTENTS_WRITE)) {
        fired('conflict');
        return resp(409, { message: `is at ${'0'.repeat(40)} but expected ${'f'.repeat(40)}` });
      }
      if (this.fault(f.lostReply, req)) {
        fired('lostReply');
        this.route(method, path, u.searchParams, user, body);
        throw new TypeError('Failed to fetch');
      }
    }
    return this.route(method, path, u.searchParams, user, body);
  };

  /** A folder's tree sha (from its files), remembering the snapshot for GET git/trees/{sha}. */
  private treeOf(files: Map<string, File>) {
    const h = createHash('sha1');
    for (const [p, f] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) h.update(`${p}\0${f.sha}\n`);
    const id = h.digest('hex');
    this.trees.set(id, files);
    return id;
  }

  private route(method: string, path: string, q: URLSearchParams, user: string | undefined, body: any) {
    let m: RegExpMatchArray | null;
    if (method === 'POST' && path === '/user/repos') {
      if (!user) return resp(401, {});
      const full = `${user}/${body.name}`.toLowerCase();
      if (this.repos.has(full)) return resp(422, { message: 'name already exists on this account' });
      this.repos.set(full, { owner: user, name: body.name.toLowerCase(), private: !!body.private, collaborators: new Set(), invitations: new Map(), files: new Map(), topics: [], description: body.description ?? '', head: 1, rules: new Set(), actionsEnabled: true });
      if (body.auto_init) this.repos.get(full)!.files.set('README.md', { sha: sha(Buffer.from('')), content: Buffer.from('') });
      return resp(201, { full_name: full, name: body.name, private: !!body.private });
    }
    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/)) && method === 'GET') {
      const r = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (!r || !this.canRead(r, user)) return resp(404, { message: 'Not Found' });
      return resp(200, { full_name: `${r.owner}/${r.name}`, private: r.private, default_branch: 'main' });
    }
    if ((m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/(.*)$/))) {
      const r = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (!r || !this.canRead(r, user)) return resp(404, { message: 'Not Found' });
      return this.repoRoute(r, method, m[3]!, user, body);
    }
    if (method === 'GET' && path === '/user/installations') {
      if (!user) return resp(401, {});
      const owners = new Set<string>();
      for (const r of this.repos.values()) if (this.canWrite(r, user)) owners.add(r.owner);
      return resp(200, { installations: [...owners].map((o) => ({ id: this.users.get(o)!.id, account: { login: o } })) });
    }
    if ((m = path.match(/^\/user\/installations\/(\d+)\/repositories$/)) && method === 'GET') {
      const owner = [...this.users].find(([, v]) => v.id === Number(m![1]))?.[0];
      const page = Number(q.get('page') ?? 1);
      const all = [...this.repos.values()].filter((r) => r.owner === owner && this.canWrite(r, user));
      const slice = all.slice((page - 1) * 100, page * 100);
      return resp(200, { total_count: all.length, repositories: slice.map((r) => ({ name: r.name, full_name: `${r.owner}/${r.name}` })) });
    }
    if ((m = path.match(/^\/user\/repository_invitations\/(\d+)$/)) && method === 'DELETE') {
      const id = Number(m[1]);
      for (const r of this.repos.values()) {
        if (r.invitations.get(id) !== user) continue;
        r.invitations.delete(id);
        return resp(204, undefined);
      }
      return resp(404, { message: 'Not Found' });
    }
    if ((m = path.match(/^\/user\/repository_invitations\/(\d+)$/)) && method === 'PATCH') {
      const id = Number(m[1]);
      for (const r of this.repos.values()) {
        const who = r.invitations.get(id);
        if (who === undefined) continue;
        if (who !== user) return resp(404, {});
        r.invitations.delete(id);
        r.collaborators.add(user);
        return resp(204, undefined);
      }
      return resp(404, { message: 'Not Found' });
    }
    return resp(404, { message: `mock: no route ${method} ${path}` });
  }

  private repoRoute(r: Repo, method: string, rest: string, user: string | undefined, body: any) {
    let m: RegExpMatchArray | null;
    const isOwner = user === r.owner;
    if ((m = rest.match(/^contents\/(.*)$/))) {
      const path = m[1]!;
      if (method === 'GET') {
        const f = r.files.get(path);
        if (f) {
          const big = f.content.length > 1024 * 1024;
          return resp(200, { type: 'file', name: path.split('/').pop(), path, sha: f.sha, size: f.content.length, encoding: big ? 'none' : 'base64', content: big ? '' : (this.transcoded.has(path) ? asUtf16ToUtf8(Buffer.from(f.content)) : f.content).toString('base64').replace(/(.{60})/g, '$1\n') });
        }
        const prefix = path + '/';
        const names = new Map<string, { type: string; sha: string; size: number }>();
        const sub = new Map<string, Map<string, File>>();
        for (const [p, file] of r.files) {
          if (!p.startsWith(prefix)) continue;
          const restp = p.slice(prefix.length);
          const [first, ...more] = restp.split('/');
          if (more.length) {
            if (!sub.has(first!)) sub.set(first!, new Map());
            sub.get(first!)!.set(more.join('/'), file);
          } else names.set(first!, { type: 'file', sha: file.sha, size: file.content.length });
        }
        for (const [name, files] of sub) names.set(name, { type: 'dir', sha: this.treeOf(files), size: 0 });
        if (names.size === 0) return resp(404, { message: 'Not Found' });
        let list = [...names].map(([name, v]) => ({ name, path: prefix + name, sha: v.sha, size: v.size, type: v.type }));
        const limit = this.faultState?.f.listingLimit;
        if (limit !== undefined && list.length > limit) {
          list = list.sort((a, b) => (a.name < b.name ? -1 : 1)).slice(0, limit);
          this.faultLog.push(`listingLimit GET ${path}`);
        }
        return resp(200, list);
      }
      if (!this.canWrite(r, user)) return resp(r.private ? 404 : 403, { message: 'no write access' });
      if (method === 'PUT') {
        const cur = r.files.get(path);
        if (cur && !body.sha) return resp(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        if (cur && body.sha !== cur.sha) return resp(409, { message: `${path} does not match ${body.sha}` });
        if (!cur && body.sha) return resp(422, { message: 'sha given for a new file' });
        const content = Buffer.from(body.content, 'base64');
        r.files.set(path, { sha: sha(content), content });
        r.head++;
        return resp(cur ? 200 : 201, { content: { sha: sha(content) } });
      }
      if (method === 'DELETE') {
        const cur = r.files.get(path);
        if (!cur) return resp(404, {});
        if (body.sha !== cur.sha) return resp(409, { message: 'sha mismatch' });
        r.files.delete(path);
        r.head++;
        return resp(200, {});
      }
    }
    if ((m = rest.match(/^git\/blobs\/([0-9a-f]+)$/)) && method === 'GET') {
      for (const f of r.files.values()) if (f.sha === m[1]) return resp(200, { sha: f.sha, encoding: 'base64', content: f.content.toString('base64') });
      return resp(404, {});
    }
    if ((m = rest.match(/^git\/trees\/([0-9a-f]+)$/)) && method === 'GET') {
      const files = this.trees.get(m[1]!);
      if (!files) return resp(404, { message: 'Not Found' });
      const tree = new Map<string, { path: string; mode: string; type: string; sha: string; size?: number }>();
      const sub = new Map<string, Map<string, File>>();
      for (const [p, f] of files) {
        const [first, ...more] = p.split('/');
        if (more.length) {
          if (!sub.has(first!)) sub.set(first!, new Map());
          sub.get(first!)!.set(more.join('/'), f);
        } else tree.set(first!, { path: first!, mode: '100644', type: 'blob', sha: f.sha, size: f.content.length });
      }
      for (const [name, fs] of sub) tree.set(name, { path: name, mode: '040000', type: 'tree', sha: this.treeOf(fs) });
      return resp(200, { sha: m[1], truncated: false, tree: [...tree.values()].sort((a, b) => (a.path < b.path ? -1 : 1)) });
    }
    if (rest === 'rulesets' && method === 'POST') {
      if (!isOwner) return resp(403, { message: 'Must have admin rights to Repository.' });
      for (const rule of body.rules ?? []) r.rules.add(rule.type);
      return resp(201, { id: this.nextId++, name: body.name, enforcement: body.enforcement });
    }
    if (rest === 'actions/permissions' && method === 'PUT') {
      if (!isOwner) return resp(403, { message: 'Must have admin rights to Repository.' });
      r.actionsEnabled = !!body.enabled;
      return resp(204, undefined);
    }
    if (rest === 'actions/permissions' && method === 'GET') return resp(200, { enabled: r.actionsEnabled });
    if ((m = rest.match(/^git\/refs\/heads\/(.+)$/)) && method === 'DELETE') {
      if (!this.canWrite(r, user)) return resp(r.private ? 404 : 403, { message: 'no write access' });
      if (r.rules.has('deletion')) return resp(422, { message: 'Repository rule violations found: Cannot delete this branch' });
      return resp(204, undefined);
    }
    if (rest === 'commits/HEAD' && method === 'GET') {
      return resp(200, { sha: `c-${r.owner}/${r.name}@${r.head}`, commit: { tree: { sha: `t-${r.owner}/${r.name}@${r.head}` } } });
    }
    if (rest.startsWith('git/') && method !== 'GET' && !this.canWrite(r, user)) return resp(r.private ? 404 : 403, { message: 'no write access' });
    if (this.gitDataDown && rest.startsWith('git/') && method !== 'GET') return resp(500, { message: 'mock: down' });
    if (rest === 'git/blobs' && method === 'POST') {
      if (body.encoding !== 'base64') return resp(422, { message: 'mock: base64 only' });
      const content = Buffer.from(body.content, 'base64');
      this.git.blobs.set(sha(content), content);
      return resp(201, { sha: sha(content) });
    }
    if (rest === 'git/trees' && method === 'POST') {
      const id = `t-${this.nextId++}`;
      for (const e of body.tree) if (!this.git.blobs.has(e.sha) && ![...r.files.values()].some((f) => f.sha === e.sha)) return resp(422, { message: 'mock: unknown blob' });
      this.git.trees.set(id, { base: body.base_tree, entries: body.tree.map((e: { path: string; sha: string }) => ({ path: e.path, sha: e.sha })) });
      return resp(201, { sha: id });
    }
    if (rest === 'git/commits' && method === 'POST') {
      const id = `c-${this.nextId++}`;
      if (!this.git.trees.has(body.tree)) return resp(422, { message: 'mock: unknown tree' });
      this.git.commits.set(id, { tree: body.tree, parent: body.parents[0] });
      return resp(201, { sha: id });
    }
    if ((m = rest.match(/^git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      if (m[1] !== 'main') return resp(422, { message: 'Reference does not exist' });
      if (this.raceNextRefUpdate > 0) {
        this.raceNextRefUpdate--;
        r.head++;
      }
      const c = this.git.commits.get(body.sha);
      if (!c) return resp(422, { message: 'Object does not exist' });
      const t = this.git.trees.get(c.tree)!;
      const headId = `c-${r.owner}/${r.name}@${r.head}`;
      const ff = c.parent === headId && t.base === `t-${r.owner}/${r.name}@${r.head}`;
      if (!ff && body.force && r.rules.has('non_fast_forward')) return resp(422, { message: 'Repository rule violations found: Cannot force-push to this branch' });
      // A forced update (no ruleset) is applied as an overlay: enough to show it went through.
      if (!ff && !body.force) return resp(422, { message: 'Update is not a fast forward' });
      for (const e of t.entries) {
        const content = this.git.blobs.get(e.sha) ?? [...r.files.values()].find((f) => f.sha === e.sha)!.content;
        r.files.set(e.path, { sha: e.sha, content });
      }
      r.head++;
      return resp(200, { object: { sha: body.sha } });
    }
    if (rest === 'topics' && method === 'PUT') {
      if (!isOwner) return resp(403, {});
      r.topics = body.names;
      return resp(200, { names: r.topics });
    }
    if (rest.startsWith('collaborators') && method === 'GET' && rest.split('?')[0] === 'collaborators') {
      if (!this.canWrite(r, user)) return resp(403, {});
      return resp(200, [r.owner, ...r.collaborators].map((login) => ({ login })));
    }
    if ((m = rest.match(/^collaborators\/([^/]+)$/))) {
      const who = m[1]!.toLowerCase();
      // A collaborator may remove themselves (leave the repo).
      if (!isOwner && !(method === 'DELETE' && who === user)) return resp(403, { message: 'Must have admin rights to Repository.' });
      if (method === 'PUT') {
        if (!this.users.has(who)) return resp(404, {});
        if (r.collaborators.has(who) || who === r.owner) return resp(204, undefined);
        for (const [id, w] of r.invitations) if (w === who) return resp(201, { id, invitee: { login: who } });
        const id = this.nextId++;
        r.invitations.set(id, who);
        return resp(201, { id, invitee: { login: who } });
      }
      if (method === 'DELETE') {
        r.collaborators.delete(who);
        return resp(204, undefined);
      }
    }
    if (rest === 'invitations' && method === 'GET') {
      if (!isOwner) return resp(403, {});
      return resp(200, [...r.invitations].map(([id, login]) => ({ id, invitee: { login } })));
    }
    if ((m = rest.match(/^invitations\/(\d+)$/)) && method === 'DELETE') {
      if (!isOwner) return resp(403, {});
      r.invitations.delete(Number(m[1]));
      return resp(204, undefined);
    }
    return resp(404, { message: `mock: no repo route ${method} ${rest}` });
  }

  private workerRoute(method: string, u: URL, user: string | undefined, body: any) {
    if (!user) return resp(401, { error: 'unauthorized' });
    const me = this.users.get(user)!;
    if (method === 'POST' && u.pathname === '/invites') {
      const r = this.repos.get(`${user}/${String(body.repo).toLowerCase()}`);
      const invitee = r?.invitations.get(Number(body.invite_id));
      if (!r || !invitee) return resp(404, { error: 'no such invitation on your repo' });
      const inv = this.users.get(invitee)!;
      const list = this.inbox.get(inv.id) ?? [];
      const now = Date.now();
      list.push({ id: Number(body.invite_id), from: user, from_id: me.id, created_at: new Date(now).toISOString(), expires_at: new Date(now + 7 * 86_400_000).toISOString(), ...(typeof body.note === 'string' ? { note: body.note } : {}) });
      this.inbox.set(inv.id, list);
      return resp(201, { ok: true, invitee_id: inv.id });
    }
    if (method === 'GET' && u.pathname === '/invites') return resp(200, { invites: this.inbox.get(me.id) ?? [] });
    const m = u.pathname.match(/^\/invites\/(\d+)$/);
    if (method === 'DELETE' && m) {
      this.inbox.set(me.id, (this.inbox.get(me.id) ?? []).filter((i) => i.id !== Number(m[1])));
      return resp(200, { ok: true });
    }
    return resp(404, { error: 'not found' });
  }
}

function resp(status: number, data: unknown, headers: Record<string, string> = {}) {
  const text = data === undefined ? '' : JSON.stringify(data);
  return {
    status,
    /** The response headers as a plain record, for wrappers that pass them on. */
    rawHeaders: headers,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    json: async () => (text ? JSON.parse(text) : undefined),
    text: async () => text,
  };
}
