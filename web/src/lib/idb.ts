/**
 * IndexedDB for this browser: device keystore (box 1), ephemeral keys (box 2), decrypted
 * message cache and small app records. One database per GitHub account.
 */
import type { DeviceKeystore, DeviceStorage, EphemeralKeyStore } from 'keyhold/storage';

const STORES = ['keystore', 'ephemeral', 'kv', 'messages'] as const;
type StoreName = (typeof STORES)[number];

/** How long an open or delete may wait for this app's other tabs to let go of the database. */
const BLOCKED_MS = 5000;
export const BLOCKED_MESSAGE = 'Chat over GitHub is open in another tab. Close it, then try again.';

export interface DbOptions {
  /** Counts and fences this tab's transactions (see WorkGate). */
  gate?: { track<T>(fn: () => Promise<T>): Promise<T> };
  /** Another tab is upgrading or deleting the database: this connection has been closed, reload. */
  onVersionChange?: () => void;
}

export class Db {
  private closed = false;
  private constructor(readonly db: IDBDatabase, readonly name: string, private readonly opts: DbOptions = {}) {
    // Without this, another tab's upgrade (or "Forget this browser") waits on us forever.
    db.onversionchange = () => {
      this.close();
      opts.onVersionChange?.();
    };
  }

  /** `factory` is the browser's indexedDB; tests pass their own, one per simulated browser. */
  static async open(name: string, factory: IDBFactory = indexedDB, opts: DbOptions = {}): Promise<Db> {
    // Open whatever version is there; if a store is missing (a store added in a later build),
    // reopen one version up so the upgrade adds it.
    let db = await openRaw(name, factory);
    if (STORES.some((s) => !db.objectStoreNames.contains(s))) {
      const v = db.version + 1;
      db.close();
      db = await openRaw(name, factory, v);
    }
    return new Db(db, name, opts);
  }

  /** Delete the database; resolves only once it is gone. Rejects if another tab keeps it open. */
  static delete(name: string, factory: IDBFactory = indexedDB): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = factory.deleteDatabase(name);
      let t: ReturnType<typeof setTimeout> | undefined;
      req.onsuccess = () => {
        clearTimeout(t);
        resolve();
      };
      req.onerror = () => {
        clearTimeout(t);
        reject(req.error);
      };
      // Other connections were asked to close (versionchange). Up-to-date tabs do at once; give
      // an old one a moment, then say what to do. The delete still happens once it closes.
      req.onblocked = () => {
        t ??= setTimeout(() => reject(new Error(BLOCKED_MESSAGE)), BLOCKED_MS);
      };
    });
  }

  close() {
    this.closed = true;
    this.db.close();
  }

  private run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const go = () => this.runNow(store, mode, fn);
    return this.opts.gate ? this.opts.gate.track(go) : go();
  }

  private runNow<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The local database is closed. Reload the page.'));
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const s = tx.objectStore(store);
      const req = fn(s);
      let result: T;
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.run(store, 'readonly', (s) => s.get(key));
  }
  put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
    return this.run(store, 'readwrite', (s) => { s.put(value, key); }).then(() => undefined);
  }
  del(store: StoreName, key: IDBValidKey): Promise<void> {
    return this.run(store, 'readwrite', (s) => { s.delete(key); }).then(() => undefined);
  }
  /** Delete several keys in one transaction. */
  delMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
    return this.run(store, 'readwrite', (s) => { for (const k of keys) s.delete(k); }).then(() => undefined);
  }
  async keys(store: StoreName, prefix = ''): Promise<string[]> {
    const all = await this.run<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());
    return (all as string[]).filter((k) => typeof k === 'string' && k.startsWith(prefix));
  }
  /** Delete the stored messages of one chat room, all of them or those up to a time. */
  async deleteMessages(groupId: string, upTo = Infinity): Promise<void> {
    await this.run('messages', 'readwrite', (s) => {
      const req = s.index('byGroup').openKeyCursor(IDBKeyRange.bound([groupId, -Infinity], [groupId, upTo]));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        s.delete(c.primaryKey);
        c.continue();
      };
    });
  }
  /** The newest stored message of one chat room that passes `keep`, walking back from the end. */
  lastMessage<T>(groupId: string, keep: (m: T) => boolean): Promise<T | undefined> {
    let found: T | undefined;
    return this.run('messages', 'readonly', (s) => {
      const req = s.index('byGroup').openCursor(IDBKeyRange.bound([groupId, -Infinity], [groupId, Infinity]), 'prev');
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (keep(c.value as T)) found = c.value as T;
        else c.continue();
      };
    }).then(() => found);
  }
  messages<T>(groupId: string): Promise<T[]> {
    return this.run('messages', 'readonly', (s) =>
      s.index('byGroup').getAll(IDBKeyRange.bound([groupId, -Infinity], [groupId, Infinity])),
    );
  }
}

class IdbKeystore implements DeviceKeystore {
  constructor(private db: Db) {}
  get(key: string) { return this.db.get<Uint8Array>('keystore', key); }
  put(key: string, value: Uint8Array) { return this.db.put('keystore', value, key); }
  delete(key: string) { return this.db.del('keystore', key); }
  keys(prefix?: string) { return this.db.keys('keystore', prefix); }
}

interface EphemeralEntry { v: Uint8Array; exp?: number }

class IdbEphemeral implements EphemeralKeyStore {
  constructor(private db: Db) {}
  async get(key: string) {
    const e = await this.db.get<EphemeralEntry>('ephemeral', key);
    if (!e) return undefined;
    if (e.exp !== undefined && e.exp <= Date.now()) { await this.delete(key); return undefined; }
    return e.v;
  }
  async put(key: string, value: Uint8Array, options?: { expiresAt?: number }) {
    await this.db.put('ephemeral', { v: value, exp: options?.expiresAt } satisfies EphemeralEntry, key);
  }
  async take(key: string) {
    const v = await this.get(key);
    if (v) await this.delete(key);
    return v;
  }
  delete(key: string) { return this.db.del('ephemeral', key); }
  async purgeExpired(now = Date.now()) {
    let n = 0;
    for (const k of await this.db.keys('ephemeral')) {
      const e = await this.db.get<EphemeralEntry>('ephemeral', k);
      if (e?.exp !== undefined && e.exp <= now) { await this.delete(k); n++; }
    }
    return n;
  }
  keys(prefix?: string) { return this.db.keys('ephemeral', prefix); }
}

function openRaw(name: string, factory: IDBFactory, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? factory.open(name) : factory.open(name, version);
    let gaveUp = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue;
        if (s === 'messages') {
          const os = db.createObjectStore(s, { keyPath: ['groupId', 'id'] });
          os.createIndex('byGroup', ['groupId', 'ts']);
        } else db.createObjectStore(s);
      }
    };
    req.onsuccess = () => {
      clearTimeout(t);
      if (gaveUp) req.result.close();
      else resolve(req.result);
    };
    req.onerror = () => {
      clearTimeout(t);
      reject(req.error);
    };
    // An older tab holds the database open at the old version and doesn't close it.
    req.onblocked = () => {
      t ??= setTimeout(() => {
        gaveUp = true;
        reject(new Error(BLOCKED_MESSAGE));
      }, BLOCKED_MS);
    };
  });
}

export function idbDevice(db: Db): DeviceStorage {
  return { keystore: new IdbKeystore(db), ephemeral: new IdbEphemeral(db) };
}
