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
  constructor(readonly login: string, readonly s: Session, readonly idb: IDBFactory) {}

  /** First browser of a new account: identity and recovery code. */
  async setup(): Promise<string> {
    const code = await this.s.createIdentity();
    await this.s.finishSetup();
    return code;
  }
  /** Another browser of an existing account. */
  restore(code: string) {
    return this.s.restoreIdentity(code);
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
      for (const m of (await this.s.messages(r.groupId)) as MsgRecord[]) {
        if (m.kind !== 'system' && !m.deleted && !((r.clearedAt ?? 0) >= m.ts)) out.push(m.body ?? m.caption ?? m.file?.name ?? '');
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
  stop(): void;
}

export async function world(): Promise<World> {
  const backend = mockBackend();
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ORIGIN)) return realFetch(input, init);
    w.requests.push({ method: init?.method ?? 'GET', url: url.slice(ORIGIN.length - 1) });
    if (w.offline) return Promise.reject(new TypeError('Failed to fetch'));
    return backend.fetch(url, { method: init?.method, headers: init?.headers as Record<string, string>, body: init?.body as string | undefined });
  }) as typeof fetch;
  const all: Browser[] = [];

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
      all.push(b);
      return b;
    },
    async reopen(b) {
      b.s.stop();
      all.splice(all.indexOf(b), 1);
      return w.browser(b.login, b.idb);
    },
    async dm(a, b) {
      await a.s.startDm(b.login);
      await w.until(() => !!b.inviteFrom(a.login), `${b.login} sees ${a.login}'s invitation`);
      await b.s.acceptInvite(b.inviteFrom(a.login)!.key);
      await w.until(() => !!b.chat(a.login)?.live && (a.chat(b.login)?.live?.members().length ?? 0) > 1, `${b.login} joined the DM`);
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
    stop() {
      for (const b of all) b.s.stop();
      globalThis.fetch = realFetch;
    },
  };
  return w;
}
