/**
 * Contacts: the people this account talks to, with the root key each browser trusts for them.
 *
 * Each browser keeps its own copy of the pins (IndexedDB, `pin:<address>`), so lookups work
 * offline and before sync has started. The account's browsers share them through the encrypted
 * personal store (collection `contacts`), so "first contact" with a person happens once per
 * account, not once per browser.
 *
 * Safety rule: sync by itself never replaces a pinned key. A new browser takes the synced pin as
 * its own (it has none yet). A browser whose pin differs from the synced one keeps its pin and
 * reports a conflict. Only a person choosing to trust the key GitHub serves now (Invite again, or
 * Accept on an invitation from someone who reset their key) writes a different key up; the
 * account's other browsers then take it once they see the person publishes that key (adoptSynced).
 */
import type { MergeRule, PersonalData, Pin, PinStore } from 'keyhold/chat';
import type { Db } from './idb';

/** A pin as this browser keeps it. */
export interface LocalPin extends Pin {
  /** When this account first saw this person's key (synced, earliest write wins). */
  firstSeen?: number;
}

/** A contact as the account's browsers share it. */
export interface SyncedContact {
  /** Root key fingerprint plus the directory head it was checked at (one field, so they never mix). */
  pin?: { fingerprint: string; index: number; hash: string };
  firstSeen?: number;
  login?: string;
}

export const CONTACT_RULES: Record<string, MergeRule> = { firstSeen: 'once' };

export class ContactBook implements PinStore {
  private local = new Map<string, LocalPin>();
  private synced = new Map<string, SyncedContact>();
  /** Addresses whose next pin write is the user accepting a new key. */
  private accepting = new Set<string>();
  personal?: PersonalData;

  constructor(
    private db: Db,
    private loginOf: (address: string) => string,
    /** What the account's other browsers trust for a contact changed. */
    private onChange: (address: string) => void = () => undefined,
    private now: () => number = Date.now,
  ) {}

  async load() {
    for (const k of await this.db.keys('kv', 'pin:')) {
      const p = await this.db.get<LocalPin>('kv', k);
      if (p) this.local.set(k.slice('pin:'.length), p);
    }
  }

  // ---- PinStore (what keyhold's IdentityRegistry reads and writes) ----

  async get(address: string): Promise<Pin | undefined> {
    const l = this.local.get(address);
    if (l) return l;
    const s = this.synced.get(address);
    if (s?.pin) return { ...s.pin };
    return undefined;
  }

  async set(address: string, pin: Pin): Promise<void> {
    const prev = this.local.get(address);
    const s = this.synced.get(address);
    const next: LocalPin = {
      fingerprint: pin.fingerprint,
      index: pin.index,
      hash: pin.hash,
      firstSeen: (prev?.fingerprint === pin.fingerprint ? prev.firstSeen : undefined) ?? s?.firstSeen ?? this.now(),
    };
    this.local.set(address, next);
    await this.db.put('kv', next, `pin:${address}`);
    const force = this.accepting.delete(address);
    await this.push(address, next, force);
  }

  // ---- sync ----

  /** The next pin write for this address is the user accepting a new key: it goes up even if it differs. */
  willAccept(address: string) {
    this.accepting.add(address);
  }

  /** Queue what this browser knows that the synced record lacks. Never overwrites a different synced key unless `force`. */
  private async push(address: string, p: LocalPin, force = false) {
    const personal = this.personal;
    if (!personal) return;
    const s = this.synced.get(address) ?? {};
    const sameKey = s.pin?.fingerprint === p.fingerprint;
    if (s.pin && !sameKey && !force) return; // a conflict: shown to the user, not settled by sync
    const fields: Record<string, unknown> = {};
    if (!s.pin || !sameKey || p.index > s.pin.index) fields.pin = { fingerprint: p.fingerprint, index: p.index, hash: p.hash };
    if (!s.firstSeen && p.firstSeen) fields.firstSeen = p.firstSeen;
    if (!s.login) fields.login = this.loginOf(address);
    if (!Object.keys(fields).length) return;
    this.synced.set(address, { ...s, ...fields });
    await personal.set('contacts', address, fields, CONTACT_RULES);
  }

  /** Every local pin goes up once: browsers that pinned keys before contacts synced. */
  async migrate() {
    for (const [address, p] of this.local) await this.push(address, p);
  }

  /** A contact record from the synced store (another browser wrote it, or this one). */
  async applyRemote(address: string, v: Record<string, unknown>) {
    const before = this.synced.get(address);
    const s: SyncedContact = {
      pin: isPin(v.pin) ? v.pin : undefined,
      firstSeen: typeof v.firstSeen === 'number' ? v.firstSeen : undefined,
      login: typeof v.login === 'string' ? v.login : undefined,
    };
    this.synced.set(address, s);
    const l = this.local.get(address);
    if (l && s.pin && l.fingerprint === s.pin.fingerprint) {
      // Same key: take the first-seen time from the other browsers.
      if (s.firstSeen && s.firstSeen !== l.firstSeen) {
        l.firstSeen = s.firstSeen;
        await this.db.put('kv', l, `pin:${address}`);
      }
    }
    if (JSON.stringify(before) !== JSON.stringify(s)) this.onChange(address);
  }

  // ---- reading ----

  /** This browser trusts one key for the person and the account's other browsers another. */
  conflict(address: string): boolean {
    const l = this.local.get(address);
    const s = this.synced.get(address)?.pin;
    return !!l && !!s && l.fingerprint !== s.fingerprint;
  }

  firstSeen(address: string): number | undefined {
    return this.local.get(address)?.firstSeen ?? this.synced.get(address)?.firstSeen;
  }

  /** The root key this browser trusts for the person (its own pin, else the account's), without a lookup. */
  pinned(address: string): string | undefined {
    return this.local.get(address)?.fingerprint ?? this.synced.get(address)?.pin?.fingerprint;
  }

  /** The root key the account's browsers share for the person, if any. */
  syncedKey(address: string): string | undefined {
    return this.synced.get(address)?.pin?.fingerprint;
  }

  /** Take the account's key for the person as this browser's own (see the safety rule above). */
  async adoptSynced(address: string) {
    const s = this.synced.get(address);
    if (!s?.pin) return;
    const next: LocalPin = { ...s.pin, firstSeen: s.firstSeen ?? this.now() };
    this.local.set(address, next);
    await this.db.put('kv', next, `pin:${address}`);
  }

  /** Everyone with a pin here or in the synced store. */
  addresses(): string[] {
    return [...new Set([...this.local.keys(), ...this.synced.keys()])];
  }
}

function isPin(v: unknown): v is NonNullable<SyncedContact['pin']> {
  const p = v as SyncedContact['pin'];
  return !!p && typeof p.fingerprint === 'string' && typeof p.index === 'number' && typeof p.hash === 'string';
}
