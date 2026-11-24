/**
 * One tab per account in a browser. Tabs of the same browser share the account's keys and
 * message store, so two running at once would each apply every incoming change: a reaction
 * (a toggle) then cancels itself, and two copies of the group keys could fall out of step.
 *
 * Two locks per account:
 * - "keyhold-chat:<id>" says which tab runs the account. Another tab can take it over ("Use here").
 * - "keyhold-chat-db:<id>" says which tab may write the account's IndexedDB and act on GitHub.
 *   A tab that loses the first lock lets its in-flight work finish (a send, a commit, a sync step
 *   held in a network call), stops for good, and only then gives up the second one. The tab taking
 *   over waits for it, so the two never work on the same group state at once: two sends with the
 *   same key and nonce, or a commit the new tab can't recognise as its own, would break the chat.
 *
 * Browsers without the Web Locks API get the same two steps from a renewed lease in localStorage.
 */
const STEAL_FLAG = 'kh.takeOverTab';

/** How long the old tab may take to finish its work before it stops anyway (and reloads). */
export const QUIESCE_TIMEOUT_MS = 15_000;
/** Last resort for the new tab: if the old one still hasn't let go, take the write lock anyway. */
const DB_WAIT_MS = 25_000;

export type TabLock = { held: true; release: () => void } | { held: false };

/** What the lock needs from the browser; tests pass their own. */
export interface TabEnv {
  locks?: Pick<LockManager, 'request'>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Take the lock from the tab that has it (the "Use here" reload). Read from sessionStorage when left out. */
  steal?: boolean;
  /** Lease timing, without Web Locks. */
  renewMs?: number;
  leaseMs?: number;
  dbWaitMs?: number;
}

/**
 * Get this tab the account. `onLost` runs when another tab takes over; it must stop all of this
 * tab's work and resolve once nothing more can be written. The new tab starts only after that.
 */
export function acquireTabLock(account: string, onLost: () => Promise<unknown> | void, env: TabEnv = browserEnv()): Promise<TabLock> {
  const steal = env.steal ?? readStealFlag();
  if (env.locks) return withLocks(env.locks, account, onLost, steal, env.dbWaitMs ?? DB_WAIT_MS);
  if (env.storage) return withLease(env.storage, account, onLost, steal, env);
  // Neither Web Locks nor storage: nothing to coordinate with, so this tab runs.
  return Promise.resolve({ held: true, release: () => undefined });
}

function browserEnv(): TabEnv {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  let storage: Storage | undefined;
  try {
    storage = typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    /* blocked */
  }
  return { locks, storage };
}

function readStealFlag() {
  try {
    const steal = sessionStorage.getItem(STEAL_FLAG) === '1';
    sessionStorage.removeItem(STEAL_FLAG);
    return steal;
  } catch {
    return false; // storage blocked: just ask normally
  }
}

const runLost = async (onLost: () => Promise<unknown> | void) => {
  try {
    await onLost();
  } catch {
    /* stopped anyway */
  }
};

async function withLocks(locks: Pick<LockManager, 'request'>, account: string, onLost: () => Promise<unknown> | void, steal: boolean, dbWaitMs: number): Promise<TabLock> {
  let releaseOwn = () => undefined as void;
  const keptOwn = new Promise<void>((r) => (releaseOwn = r));
  let releaseDb = () => undefined as void;
  const keptDb = new Promise<void>((r) => (releaseDb = r));
  let lost = false;
  let onLostWhileWaiting: (() => void) | undefined;
  const lose = () => {
    if (lost) return;
    lost = true;
    if (onLostWhileWaiting) return onLostWhileWaiting(); // never started: nothing to stop
    // Let go of the write lock only once this tab can no longer write.
    void runLost(onLost).finally(() => releaseDb());
  };

  const got = await new Promise<boolean>((resolve) => {
    locks
      .request(`keyhold-chat:${account}`, steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
        if (!lock) return resolve(false);
        resolve(true);
        await keptOwn;
      })
      // Rejected when another tab steals the lock.
      .catch(() => lose());
  });
  if (!got) return { held: false };

  // Wait until the tab we took over from has stopped writing.
  const db = `keyhold-chat-db:${account}`;
  const ok = await new Promise<boolean>((resolve) => {
    let done = false;
    const granted = async () => {
      if (done || lost) return; // a late grant after a fallback or a loss: let it go at once
      done = true;
      clearTimeout(t);
      onLostWhileWaiting = undefined;
      resolve(true);
      await keptDb;
    };
    onLostWhileWaiting = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(false);
    };
    locks.request(db, granted).catch(() => lose());
    // The old tab is stuck (it would have reloaded by now): take the write lock from it.
    const t = setTimeout(() => {
      if (done || lost) return;
      locks.request(db, { steal: true }, granted).catch(() => lose());
    }, dbWaitMs);
  });
  if (!ok) {
    releaseOwn();
    return { held: false };
  }
  return {
    held: true,
    release: () => {
      releaseOwn();
      releaseDb();
    },
  };
}

type Lease = { id: string; at: number };

async function withLease(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  account: string,
  onLost: () => Promise<unknown> | void,
  steal: boolean,
  env: TabEnv,
): Promise<TabLock> {
  const renewMs = env.renewMs ?? 1000;
  const leaseMs = env.leaseMs ?? 4000;
  const dbWaitMs = env.dbWaitMs ?? DB_WAIT_MS;
  const me = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const K = `kh.tab:${account}`;
  const D = `kh.tabdb:${account}`;
  const read = (k: string): Lease | undefined => {
    try {
      const v = JSON.parse(storage.getItem(k) ?? 'null') as Lease | null;
      return v && typeof v.id === 'string' && typeof v.at === 'number' ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (k: string) => {
    try {
      storage.setItem(k, JSON.stringify({ id: me, at: Date.now() } satisfies Lease));
    } catch {
      /* storage full or blocked: the next renewal tries again */
    }
  };
  const fresh = (l?: Lease) => !!l && Date.now() - l.at < leaseMs;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const cur = read(K);
  if (!steal && fresh(cur) && cur!.id !== me) return { held: false };
  write(K);
  // Two tabs that wrote at once: the last write wins, the other one backs off.
  await sleep(Math.min(50, renewMs));
  if (read(K)?.id !== me) return { held: false };

  let lost = false;
  let dbHeld = false;
  let stopped = false;
  const renew = setInterval(() => {
    if (stopped) return;
    if (!lost && read(K)?.id !== me) {
      lost = true;
      if (!dbHeld) return;
      // Keep the write lease while this tab finishes its work, then give it up.
      void runLost(onLost).finally(() => {
        stop();
        if (read(D)?.id === me) storage.removeItem(D);
      });
      return;
    }
    if (!lost) write(K);
    if (dbHeld) write(D);
  }, renewMs);
  const stop = () => {
    stopped = true;
    clearInterval(renew);
  };

  const start = Date.now();
  for (;;) {
    if (lost) {
      stop();
      return { held: false };
    }
    const d = read(D);
    if (!fresh(d) || d!.id === me || Date.now() - start > dbWaitMs) break;
    await sleep(Math.min(100, renewMs));
  }
  write(D);
  dbHeld = true;
  return {
    held: true,
    release: () => {
      stop();
      if (read(K)?.id === me) storage.removeItem(K);
      if (read(D)?.id === me) storage.removeItem(D);
    },
  };
}

/** Reload this tab and take the lock from the other one. */
export function takeOverTab() {
  try {
    sessionStorage.setItem(STEAL_FLAG, '1');
  } catch {
    /* without storage the reload asks normally */
  }
  location.reload();
}

/**
 * Counts this tab's work in progress (network calls, IndexedDB transactions), so a stop can wait
 * for it to finish, and fences it: after `fence()` nothing new starts.
 */
export class WorkGate {
  private busy = 0;
  private last = 0;
  private fenced?: Error;

  get isFenced() {
    return !!this.fenced;
  }

  async track<T>(fn: () => Promise<T>): Promise<T> {
    if (this.fenced) throw this.fenced;
    this.busy++;
    this.last = Date.now();
    try {
      return await fn();
    } finally {
      this.busy--;
      this.last = Date.now();
    }
  }

  fence(why = 'This tab has stopped. The chat runs in another tab.') {
    this.fenced ??= new Error(why);
  }

  /**
   * Resolves true once `also` has settled and no work has run for `settleMs` (the gap between one
   * step of an operation and the next is a little local crypto), or false after `timeoutMs`.
   */
  async idle(also: Promise<unknown> | undefined, settleMs = 200, timeoutMs = QUIESCE_TIMEOUT_MS): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    let pending = !!also;
    void also?.finally(() => (pending = false)).catch(() => undefined);
    for (;;) {
      const now = Date.now();
      if (!pending && this.busy === 0 && now - this.last >= settleMs) return true;
      if (now >= end) return false;
      await new Promise((r) => setTimeout(r, Math.min(25, settleMs)));
    }
  }
}
