/**
 * Runs the chat app's logic (Session) for several people and browsers in one process, against
 * the in-memory GitHub + Worker backend, with no browser and no timers: each browser's sync step
 * runs only when a scenario asks (until / rounds), so a scenario reads as a sequence of steps and
 * gives the same result on a fast or a slow machine. One `world()` per scenario.
 */
import { IDBFactory } from 'fake-indexeddb';
import { mockBackend } from '../tools/mock-backend';
import { Session, type Convo, type MsgRecord, type PendingInvite } from '../src/lib/session';

const ORIGIN = 'http://mock.test/';

/** One browser: a signed-in app with its own IndexedDB. */
export class Browser {
  /** When this browser got its identity (set up or restored): it can't have messages from before. */
  since = Infinity;
  /** The last Delete chat in this browser, per conversation key. */
  cleared = new Map<string, number>();
  constructor(readonly login: string, readonly s: Session, readonly idb: IDBFactory) {}

  /** First browser of a new account: identity and recovery code. */
  async setup(): Promise<string> {
    const code = await this.s.createIdentity();
    await this.s.finishSetup();
    this.since = Date.now();
    return code;
  }
  /** Another browser of an existing account. */
  async restore(code: string) {
    await this.s.restoreIdentity(code);
    this.since = Date.now();
  }
  /** Run this browser's sync step n times. */
  async sync(n = 1) {
    for (let i = 0; i < n; i++) await this.s.syncNow();
  }
  chats(): Convo[] {
    return this.s.conversations();
  }
  /** The chat-list entry with this title (a DM's title is the other person's login). */
  chat(title: string): Convo | undefined {
    return this.s.conversations().find((c) => c.title === title);
  }
  invites(): PendingInvite[] {
    return this.s.pendingInvites();
  }
  /** The invitation from this person still waiting for Accept or Decline. */
  inviteFrom(who: string): PendingInvite | undefined {
    return this.s.pendingInvites().find((i) => i.from.includes(who) && i.status === 'invited');
  }
  async messages(c: Convo | undefined): Promise<MsgRecord[]> {
    if (!c) return [];
    const out: MsgRecord[] = [];
    for (const r of c.rooms) out.push(...((await this.s.messages(r.groupId)) as MsgRecord[]));
    return out;
  }
  /** What the chat shows as messages: texts, captions or file names, without deleted or cleared ones. */
  async texts(c: Convo | undefined): Promise<string[]> {
    if (!c) return [];
    const out: string[] = [];
    for (const r of c.rooms) {
      // What Delete chat removed is gone from the store; nothing else hides a message.
      for (const m of (await this.s.messages(r.groupId)) as MsgRecord[]) {
        if (m.kind !== 'system' && !m.deleted) out.push(m.body ?? m.caption ?? m.file?.name ?? '');
      }
    }
    return out;
  }
  /** The chat's system lines (invitations, joins, closes...). */
  async notes(c: Convo | undefined): Promise<string[]> {
    return (await this.messages(c)).filter((m) => m.kind === 'system').map((m) => m.body ?? '');
  }
  /** The message with this text, in this chat. */
  async msg(c: Convo | undefined, text: string): Promise<MsgRecord | undefined> {
    return (await this.messages(c)).find((m) => (m.body ?? m.caption) === text);
  }
}

/** A request as the fault helpers see it: who sent it (from the token), method, path. */
export interface Req {
  login?: string;
  method: string;
  /** Path after the origin, e.g. /gh/repos/alice/ghchat-x/contents/mail/... */
  url: string;
  body?: string;
}
/** Which requests a fault applies to: a substring of the path, a pattern, or a test. */
export type Match = string | RegExp | ((r: Req) => boolean);

/** A message a scenario sent, and the devices that were in the room when it went out. */
interface Sent {
  from: Browser;
  groupId: string;
  body: string;
  at: number;
  devices: Set<string>;
}

export interface World {
  backend: ReturnType<typeof mockBackend>;
  /** Every request the apps made to GitHub or the Worker, in order. */
  requests: { method: string; url: string }[];
  /** While true, every request fails as if the network were down. */
  offline: boolean;
  /** A browser signed in as `login`. Not set up yet: call setup() or restore(). */
  browser(login: string, idb?: IDBFactory): Promise<Browser>;
  /** The same browser after a reload: a new app on the same IndexedDB. */
  reopen(b: Browser): Promise<Browser>;
  /** Both people set up already: a DM from a to b, accepted and live on both sides. */
  dm(a: Browser, b: Browser): Promise<void>;
  /** Sync every browser, round after round, until `cond` holds (at most `rounds` rounds). */
  until(cond: () => boolean | Promise<boolean>, what: string, rounds?: number): Promise<void>;
  /** A few full sync rounds, for checking that something does NOT happen. */
  rounds(n?: number): Promise<void>;
  /**
   * Hold the next request matching `m` before it reaches the backend, so a scenario can act while
   * it is in flight. `started` resolves when it arrives; `release()` lets it go on.
   */
  hold(m: Match): { started: Promise<Req>; release(): void };
  /** The reply is lost: the next matching request is applied, then fails as "Failed to fetch". */
  loseReply(m: Match): Promise<Req>;
  /** The next `times` matching requests get this answer from "GitHub", and nothing is applied. */
  fail(m: Match, status: number, opts?: { times?: number; headers?: Record<string, string>; body?: string }): void;
  /**
   * End-of-scenario invariant: all browsers of each person list the same chats (and the same live
   * rooms), every message sent through w is on every browser that was in the room when it went
   * out (unless that browser deleted the chat since), no "could not be decrypted" notes, no group
   * errors. Throws with what differs.
   */
  checkConverged(): Promise<void>;
  /** Every browser still running. */
  browsers(): Browser[];
  stop(): void;
}

function matches(m: Match, r: Req) {
  if (typeof m === 'string') return r.url.includes(m);
  if (m instanceof RegExp) return m.test(`${r.method} ${r.url}`);
  return m(r);
}

export async function world(): Promise<World> {
  const backend = mockBackend();
  const realFetch = globalThis.fetch;
  /** Faults waiting for their request, first match wins; each is used up once it fires. */
  const faults: { m: Match; left: number; run: (r: Req, go: () => Promise<Response>) => Promise<Response> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ORIGIN)) return realFetch(input, init);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    const req: Req = { login: auth?.replace(/^Bearer tok-/, ''), method: init?.method ?? 'GET', url: url.slice(ORIGIN.length - 1), body: init?.body as string | undefined };
    w.requests.push({ method: req.method, url: req.url });
    if (w.offline) throw new TypeError('Failed to fetch');
    const go = () => backend.fetch(url, { method: init?.method, headers, body: init?.body as string | undefined });
    const f = faults.find((x) => x.left > 0 && matches(x.m, req));
    if (!f) return go();
    if (--f.left === 0) faults.splice(faults.indexOf(f), 1);
    return f.run(req, go);
  }) as typeof fetch;
  const all: Browser[] = [];
  const sent: Sent[] = [];
  const watch = (b: Browser) => {
    const send = b.s.send.bind(b.s);
    b.s.send = async (g, body) => {
      const devices = new Set(g.members().filter((m) => !m.pending).flatMap((m) => m.devices.map((d) => d.deviceId)));
      const at = Date.now();
      await send(g, body);
      // Only what went out: a send that failed shows "Not sent" to the person, nothing is promised.
      if (!b.s.sending.get(g.id)?.some((p) => p.body === body && p.failed)) sent.push({ from: b, groupId: g.id, body, at, devices });
    };
    const del = b.s.deleteHistory.bind(b.s);
    b.s.deleteHistory = async (key) => {
      b.cleared.set(key, Date.now());
      await del(key);
    };
  };

  const w: World = {
    backend,
    requests: [],
    offline: false,
    async browser(login, idb = new IDBFactory()) {
      const token = `tok-${login}`;
      const me = (await (await backend.fetch(`${ORIGIN}gh/user`, { headers: { authorization: `Bearer ${token}` } })).json()) as { id: number };
      const s = new Session({ token, login, id: me.id }, { token: async () => token, indexedDB: idb });
      await s.start();
      const b = new Browser(login, s, idb);
      watch(b);
      all.push(b);
      return b;
    },
    async reopen(b) {
      b.s.stop();
      all.splice(all.indexOf(b), 1);
      const again = await w.browser(b.login, b.idb);
      again.since = b.since;
      again.cleared = b.cleared;
      for (const x of sent) if (x.from === b) x.from = again;
      return again;
    },
    async dm(a, b) {
      await a.s.startDm(b.login);
      await w.until(() => !!b.inviteFrom(a.login), `${b.login} sees ${a.login}'s invitation`);
      await b.s.acceptInvite(b.inviteFrom(a.login)!.key);
      await w.until(() => !!b.chat(a.login)?.live && (a.chat(b.login)?.live?.members().filter((m) => !m.pending).length ?? 0) > 1, `${b.login} joined the DM`);
    },
    async until(cond, what, rounds = 15) {
      for (let i = 0; i < rounds; i++) {
        if (await cond()) return;
        for (const b of all) await b.s.syncNow();
      }
      if (await cond()) return;
      throw new Error(`still not true after ${rounds} sync rounds: ${what}`);
    },
    async rounds(n = 3) {
      for (let i = 0; i < n; i++) for (const b of all) await b.s.syncNow();
    },
    hold(m) {
      let release!: () => void;
      let started!: (r: Req) => void;
      const gate = new Promise<void>((r) => (release = r));
      const arrived = new Promise<Req>((r) => (started = r));
      faults.push({ m, left: 1, run: async (r, go) => {
        started(r);
        await gate;
        return go();
      } });
      return { started: arrived, release };
    },
    loseReply(m) {
      return new Promise<Req>((done) => {
        faults.push({ m, left: 1, run: async (r, go) => {
          await go();
          done(r);
          throw new TypeError('Failed to fetch');
        } });
      });
    },
    fail(m, status, opts = {}) {
      faults.push({ m, left: opts.times ?? 1, run: async () =>
        new Response(opts.body ?? JSON.stringify({ message: `mock ${status}` }), { status, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Remaining': '4999', ...(opts.headers ?? {}) } }) });
    },
    async checkConverged() {
      const problems: string[] = [];
      const list = (b: Browser) => b.chats().map((c) => `${c.title}${c.live ? ` live:${c.live.id.slice(0, 8)}` : ' not live'}`).sort().join(', ');
      for (const login of new Set(all.map((b) => b.login))) {
        const mine = all.filter((b) => b.login === login && b.since !== Infinity);
        for (const b of mine.slice(1)) if (list(b) !== list(mine[0]!)) problems.push(`${login}'s browsers list different chats: [${list(mine[0]!)}] vs [${list(b)}]`);
      }
      for (const b of all) {
        if (b.since === Infinity) continue;
        for (const [id, e] of b.s.groupErrors) problems.push(`${b.login}: chat ${id.slice(0, 8)} has an error: ${e}`);
        for (const c of b.chats()) {
          if ((await b.notes(c)).some((n) => n.includes('could not be decrypted'))) problems.push(`${b.login}: "could not be decrypted" in ${c.title}`);
        }
      }
      for (const x of sent) {
        const owner = x.from.s.records.get(x.groupId);
        const peer = owner?.kind === 'dm' ? x.from.s.address : undefined;
        for (const b of all) {
          const dev = b.s.identity?.deviceId;
          if (!dev || !x.devices.has(dev) || b.since > x.at) continue;
          // The conversation that room belongs to here; a DM's other room (rule 2) counts as the same chat.
          const c = b.chats().find((cv) => cv.rooms.some((r) => r.groupId === x.groupId)) ?? (peer ? b.chats().find((cv) => cv.dm && cv.peer === peer) : undefined);
          if (c && (b.cleared.get(c.key) ?? 0) >= x.at) continue;
          if (b === x.from && !c) continue; // the sender deleted the chat
          if (!(await b.texts(c)).includes(x.body)) problems.push(`${b.login} never got "${x.body}" from ${x.from.login}`);
        }
      }
      if (problems.length) throw new Error(`not converged:\n  ${problems.join('\n  ')}`);
    },
    browsers() {
      return [...all];
    },
    stop() {
      for (const b of all) b.s.stop();
      globalThis.fetch = realFetch;
    },
  };
  return w;
}
