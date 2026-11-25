// Two tabs of one browser: "Use here" hands the account over only once the old tab's work is done.
import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { world, type Browser, type World } from './harness';
import { Session } from '../src/lib/session';
import { acquireTabLock, type TabEnv, type TabLock } from '../src/lib/tab-lock';
import { Db } from '../src/lib/idb';
import { isImage, servedType } from '../src/lib/mime';

let w: World;
const extra: Session[] = [];
afterEach(() => {
  for (const s of extra.splice(0)) s.stop();
  w?.stop();
});

/** Web Locks for tabs of one simulated browser: exclusive, with ifAvailable and steal. */
class FakeLocks {
  private held = new Map<string, object>();
  private queue = new Map<string, (() => void)[]>();
  request(name: string, a: LockOptions | LockGrantedCallback<unknown>, b?: LockGrantedCallback<unknown>): Promise<unknown> {
    const opts = typeof a === 'function' ? {} : a;
    const cb = (typeof a === 'function' ? a : b)!;
    return new Promise((resolve, reject) => {
      const entry = { reject };
      const grant = () => {
        this.held.set(name, entry);
        Promise.resolve()
          .then(() => cb({ name, mode: 'exclusive' } as Lock))
          .then(resolve, reject)
          .finally(() => {
            if (this.held.get(name) !== entry) return;
            this.held.delete(name);
            this.queue.get(name)?.shift()?.();
          });
      };
      const cur = this.held.get(name) as { reject: (e: unknown) => void } | undefined;
      if (opts.steal) {
        if (cur) {
          this.held.delete(name);
          cur.reject(new DOMException('stolen', 'AbortError'));
        }
        return grant();
      }
      if (cur || this.queue.get(name)?.length) {
        if (opts.ifAvailable) return void Promise.resolve(cb(null)).then(resolve, reject);
        const q = this.queue.get(name) ?? [];
        q.push(grant);
        this.queue.set(name, q);
        return;
      }
      grant();
    });
  }
}

/** Pause the first request that matches until release(). */
function holdNext(match: (method: string, url: string) => boolean) {
  const inner = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let arrive!: () => void;
  const arrived = new Promise<void>((r) => (arrive = r));
  let done = false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!done && match(init?.method ?? 'GET', url)) {
      done = true;
      arrive();
      await gate;
    }
    return inner(input, init);
  }) as typeof fetch;
  return { arrived, release };
}

const ticks = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The app's tab start (App.tsx): take the lock, then start; on loss, hand over. */
function runTab(s: Session, locks: FakeLocks, steal: boolean): Promise<TabLock> {
  return acquireTabLock(String(s.auth.id), () => s.handOver(), { locks, steal }).then(async (lock) => {
    if (lock.held && s.phase === 'loading') await s.start();
    return lock;
  });
}

/** A second tab of this browser: a new app on the same IndexedDB, taking over with "Use here". */
function useHere(b: Browser, locks: FakeLocks) {
  const token = `tok-${b.login}`;
  const s = new Session({ token, login: b.login, id: b.s.auth.id }, { token: async () => token, indexedDB: b.idb });
  extra.push(s);
  let started = false;
  const ready = runTab(s, locks, true).then((lock) => {
    started = lock.held;
    return s;
  });
  return { ready, started: () => started };
}

async function noDecryptErrors(b: Browser, title: string) {
  expect((await b.notes(b.chat(title))).filter((n) => /could not be decrypted/.test(n))).toEqual([]);
}

describe('taking over from another tab', () => {
  it('a send in flight in the old tab finishes before the new tab starts: no reused message key', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const locks = new FakeLocks();
    expect((await runTab(alice.s, locks, false)).held).toBe(true);

    // Tab 1's send asks what is new first (held here), then encrypts, saves, and posts (held too).
    const pull = holdNext((m, u) => m === 'GET' && (u.includes('/contents/mail') || u.includes('/compare/')));
    const sending = alice.s.send(alice.chat('bob')!.live!, 'from tab 1');
    await pull.arrived;
    const tab2 = useHere(alice, locks);
    // Tab 2 sends once tab 1's message is on its way, as soon as it runs.
    let go!: () => void;
    const posting = new Promise<void>((r) => (go = r));
    const sent2 = Promise.all([tab2.ready, posting]).then(async ([s2]) => {
      expect(s2.phase).toBe('ready');
      await s2.send(s2.conversations().find((c) => c.title === 'bob')!.live!, 'from tab 2');
    });
    await ticks(300);
    expect(tab2.started()).toBe(false); // waits for tab 1's send
    const post = holdNext((m, u) => m === 'PUT' && u.includes('/contents/mail/'));
    pull.release();
    await post.arrived;
    go();
    await ticks(300);
    expect(tab2.started()).toBe(false);
    post.release();
    await sending;
    await sent2;
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('from tab 2'), 'bob got tab 2');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('from tab 1'), 'bob got tab 1');
    expect((await bob.texts(bob.chat('alice'))).sort()).toEqual(['from tab 1', 'from tab 2']);
    await noDecryptErrors(bob, 'alice');
  });

  it('a commit in flight in the old tab lands before the new tab syncs: no fork', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await alice.s.createGroup('Hikers', ['bob', 'carol']);
    await w.until(() => !!bob.inviteFrom('alice') && !!carol.inviteFrom('alice'), 'invited');
    for (const b of [bob, carol]) await b.s.acceptInvite(b.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Hikers')?.live && !!carol.chat('Hikers')?.live && alice.chat('Hikers')!.live!.members().every((m) => !m.pending), 'both joined');
    const locks = new FakeLocks();
    expect((await runTab(alice.s, locks, false)).held).toBe(true);

    const g = alice.chat('Hikers')!.live!;
    const hold = holdNext((m, u) => m === 'PUT' && u.includes('/contents/log/'));
    const removing = alice.s.removeMember(g, g.members().find((m) => m.address === 'github:carol')!.fingerprint).catch(() => undefined);
    await hold.arrived;
    const tab2 = useHere(alice, locks);
    await ticks(300);
    expect(tab2.started()).toBe(false);
    hold.release();
    await removing;
    const s2 = await tab2.ready;
    for (let i = 0; i < 3; i++) {
      await s2.syncNow();
      await w.rounds(1);
    }
    const g2 = s2.conversations().find((c) => c.title === 'Hikers')!.live!;
    expect(g2.members().map((m) => m.address).sort()).toEqual(['github:alice', 'github:bob']);
    await s2.send(g2, 'after the removal');
    await w.until(async () => (await bob.texts(bob.chat('Hikers'))).includes('after the removal'), 'bob reads tab 2');
    await bob.s.send(bob.chat('Hikers')!.live!, 'bob back');
    for (let i = 0; i < 5 && !(await s2.messages(g2.id)).some((m) => (m as { body?: string }).body === 'bob back'); i++) {
      await w.rounds(1);
      await s2.syncNow();
    }
    expect((await s2.messages(g2.id)).some((m) => (m as { body?: string }).body === 'bob back')).toBe(true);
    expect(s2.groupErrors.get(g2.id)).toBeUndefined();
  });

  it('the same tab reopening its chat waits for the old chat\'s work first', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const before = alice.s.chat;
    const pull = holdNext((m, u) => m === 'GET' && (u.includes('/contents/mail') || u.includes('/compare/')));
    const sending = alice.s.send(alice.chat('bob')!.live!, 'first');
    await pull.arrived;
    void alice.s.stop(); // the install check failed, say
    const reopening = alice.s.recheckInstall(); // and came back
    let go!: () => void;
    const posting = new Promise<void>((r) => (go = r));
    const second = Promise.all([reopening, posting]).then(() => alice.s.send(alice.chat('bob')!.live!, 'second'));
    await ticks(300);
    expect(alice.s.chat).toBe(before); // no second chat while the first one's send runs
    const post = holdNext((m, u) => m === 'PUT' && u.includes('/contents/mail/'));
    pull.release();
    await post.arrived;
    go();
    await ticks(300);
    expect(alice.s.chat).toBe(before);
    post.release();
    await sending;
    await second;
    expect(alice.s.phase).toBe('ready');
    expect(alice.s.chat).not.toBe(before);
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('second'), 'bob got the second');
    expect(await bob.texts(bob.chat('alice'))).toEqual(['first', 'second']);
    await noDecryptErrors(bob, 'alice');
  });

  it('after handing over, the old tab calls GitHub and writes IndexedDB no more', async () => {
    w = await world();
    const alice = await w.browser('alice');
    await alice.setup();
    expect(await alice.s.handOver()).toBe(true);
    const n = w.requests.length;
    await expect(alice.s.db.put('kv', 1, 'x')).rejects.toThrow();
    await expect(alice.s.ghFetch('http://mock.test/gh/user')).rejects.toThrow(/another tab/);
    expect(w.requests.length).toBe(n);
  });
});

describe('tab lock without Web Locks', () => {
  const shared = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  const env = (storage: ReturnType<typeof shared>, steal: boolean): TabEnv => ({ storage, steal, renewMs: 10, leaseMs: 60, dbWaitMs: 5000 });

  it('a second tab sees the first one, and "Use here" waits for it to stop', async () => {
    const storage = shared();
    let finish!: () => void;
    let lost = false;
    const first = await acquireTabLock('7', () => {
      lost = true;
      return new Promise<void>((r) => (finish = r));
    }, env(storage, false));
    expect(first.held).toBe(true);
    expect((await acquireTabLock('7', () => undefined, env(storage, false))).held).toBe(false);

    let second: TabLock | undefined;
    const p = acquireTabLock('7', () => undefined, env(storage, true)).then((l) => (second = l));
    await ticks(150);
    expect(lost).toBe(true);
    expect(second).toBeUndefined(); // the first tab is still finishing
    finish();
    await p;
    expect(second?.held).toBe(true);
    if (second?.held) second.release();
  });

  it('a lock left by a closed tab expires', async () => {
    const storage = shared();
    storage.setItem('kh.tab:8', JSON.stringify({ id: 'gone', at: Date.now() - 10_000 }));
    storage.setItem('kh.tabdb:8', JSON.stringify({ id: 'gone', at: Date.now() - 10_000 }));
    const l = await acquireTabLock('8', () => undefined, env(storage, false));
    expect(l.held).toBe(true);
    if (l.held) l.release();
  });
});

describe('IndexedDB across tabs', () => {
  it('another tab deleting the database closes this connection and tells the app', async () => {
    const f = new IDBFactory();
    let told = false;
    const db = await Db.open('t', f, { onVersionChange: () => (told = true) });
    await db.put('kv', 1, 'a');
    await Db.delete('t', f); // resolves only once it is really gone
    expect(told).toBe(true);
    const again = await Db.open('t', f);
    expect(await again.get('kv', 'a')).toBeUndefined();
    again.close();
  });

  it('a delete blocked by a tab that keeps the database open fails instead of reporting success', async () => {
    const f = new IDBFactory();
    await (await Db.open('t', f)).close();
    const old = await new Promise<IDBDatabase>((r) => {
      const req = f.open('t');
      req.onsuccess = () => r(req.result);
    }); // an old build: no versionchange handler
    await expect(Db.delete('t', f)).rejects.toThrow(/another tab/);
    old.close();
  }, 10_000);

  it('a store missing from an existing database is added', async () => {
    const f = new IDBFactory();
    await new Promise<void>((r) => {
      const req = f.open('t', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => {
        req.result.close();
        r();
      };
    });
    const db = await Db.open('t', f);
    await db.put('ephemeral', { v: 1 }, 'k');
    expect(await db.get('ephemeral', 'k')).toEqual({ v: 1 });
    expect(db.db.version).toBe(2);
    db.close();
  });
});

describe('attachment types', () => {
  it('SVG from anyone is a file to download, served as a type no browser renders', () => {
    expect(isImage('image/svg+xml')).toBe(false);
    expect(servedType('image/svg+xml')).toBe('application/octet-stream');
    expect(servedType('text/html')).toBe('application/octet-stream');
    expect(isImage('image/png')).toBe(true);
    expect(servedType('image/png')).toBe('image/png');
  });
});
