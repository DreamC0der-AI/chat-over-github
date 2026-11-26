/**
 * One signed-in account in this browser: Keyhold chat over the GitHub provider, the local
 * stores, and a polling loop that keeps chats up to date without burning the rate limit.
 */
import { githubProvider, toAddress, loginOf, retryAfterOf, inParallel } from 'chat-over-github-provider';
import type { ChangeWatch, FetchFn } from 'chat-over-github-provider';
import { resolveFeatures } from 'keyhold/storage';
import type { DeviceStorage, StorageProvider } from 'keyhold/storage';
import {
  Chat,
  createDeviceIdentity,
  createRootKey,
  DirectoryWriter,
  IdentityRegistry,
  loadDeviceIdentity,
  newDeviceId,
  safetyNumber,
  verifyDirectory,
  wipeRoot,
  fingerprint,
  backupRootKey,
  restoreRootKey,
  PersonalData,
  unsentMessages,
  type AppMessage,
  type MergeRule,
  type DeviceIdentity,
  type Group,
  type GroupEvent,
  type ReceivedMessage,
  type RootKey,
  type DeviceCertificate,
  type LookupResult,
} from 'keyhold/chat';
import type { AppContent, AttachmentRef } from 'keyhold/chat';
import { sha256, toHex } from 'keyhold/util';
import { generateRecoveryCode, parseRecoveryCode } from 'keyhold/keys';
import { hkdfAesKey, hkdfBytes } from 'keyhold/util';
import { CONFIG, installUrl } from '../config';
import { currentToken, SignedOutError, type AuthState } from './auth';
import { Activities, instrument, type Activity, type PlanStep, type Tracker } from './activity';
import { InboxSocket } from './inbox-socket';
import { Db, idbDevice } from './idb';
import { WorkGate } from './tab-lock';
import { servedType } from './mime';
import { ContactBook } from './contacts';
import { safeAvatar } from './group-avatar';

export type Phase = 'loading' | 'install' | 'new-identity' | 'restore' | 'ready' | 'error';

export interface MsgRecord {
  groupId: string;
  id: string;
  ts: number;
  from: string;
  fromFp: string;
  mine: boolean;
  kind: 'text' | 'attachment' | 'system';
  body?: string;
  file?: AttachmentRef;
  caption?: string;
  edited?: boolean;
  deleted?: boolean;
  reactions?: Record<string, string[]>;
  /** Reaction messages already counted, so one that arrives twice can't toggle twice. */
  rxIds?: string[];
  reply?: string;
  /** The device that sent it (absent on messages stored by older versions). */
  fromDevice?: string;
  /** Rule 2: this device sent a copy of it into the room that stayed (the copy's id). */
  movedTo?: string;
  /** This is such a copy: the original's id. */
  movedFrom?: string;
}

/** An outgoing message that isn't in the chat yet. A file has a local preview until it's sent. */
export interface Sending {
  id: string;
  ts: number;
  body?: string;
  file?: File;
  preview?: string;
  caption?: string;
  failed?: string;
  /** Sent: the id it has in the chat. The bubble stays until the chat shows the real message. */
  sentId?: string;
  /**
   * The chat message keyhold encrypted and saved for it, once a send failed after that: Retry
   * posts this very message again (never a fresh one, which could arrive twice), Remove drops it.
   */
  msgId?: string;
  /** Size of the file, for a "Not sent" file found after a reload (only its name and size are known then). */
  size?: number;
}

/** A reaction on its way out. `add` is what the person asked for; `sent` once GitHub has it. */
export interface Reacting {
  add: boolean;
  sent?: boolean;
}

/** What the chat list shows for a message: deleted text never shows there, and an edit shows its new text. */
export function previewText(m: MsgRecord): string {
  if (m.deleted) return 'Message deleted';
  if (m.kind === 'attachment' && m.file) return m.caption || (m.file.mime?.startsWith('image/') ? '📷 Photo' : `📎 ${m.file.name ?? 'file'}`);
  return m.body ?? '';
}

/** How long a finished action keeps its local state, so the screen never shows a gap before the stored copy appears. */
const SETTLE_MS = 2_000;
/** "Inviting @bob", "Inviting @bob and @carol", "Inviting @bob and 2 others". */
function inviteLabel(logins: string[]) {
  const [a, b] = logins;
  if (logins.length === 1) return `Inviting @${a}`;
  if (logins.length === 2) return `Inviting @${a} and @${b}`;
  return `Inviting @${a} and ${logins.length - 1} others`;
}
const JOIN_UNLOCK = 'Unlocking the encryption';
const JOIN_LOAD = 'Loading messages';
/** The steps of making a chat's repo, started by Keyhold's own storage calls. */
const NEW_ROOM: PlanStep[] = [
  { label: 'Creating a private repo', when: 'channel.createSpace' },
  { label: 'Setting up encryption', when: 'orderedLog.append' },
];

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface ChatRecord {
  groupId: string;
  invited: string[];
  createdAt: number;
  lastTs: number;
  lastText?: string;
  unread: number;
  hidden?: boolean;
  lastName?: string;
  /** Group picture (a data URL) from the newest admin meta message, kept for when the group state is gone. '' = removed. */
  avatar?: string;
  deviceCount?: number;
  /** The room's repo, kept so the room can still be shown after its group state is gone. */
  space?: string;
  kind?: 'dm' | 'group';
  /** DM only: the other person. A conversation is the pair of people, across rooms. */
  peer?: string;
  /** The room ended for good (closed, quit, removed). Its history stays until Delete chat. */
  ended?: { how: 'closed' | 'moved' | 'quit' | 'removed'; by?: string; at: number };
  /**
   * Delete chat: messages up to here were deleted. The time of the newest message the deleting
   * browser had (the senders' clocks, like every message's ts), never the deleting browser's clock.
   */
  clearedAt?: number;
  /** Synced with clearedAt: the newest message the deleting browser had, by id. */
  clearedId?: string;
  /**
   * This browser only: another browser deleted the chat, and this one hasn't caught up to the last
   * message that browser had (clearedId), so messages it fetches up to dropTo were deleted there.
   * Without dropUntil (a delete from an older app), the cut-off is by time only.
   */
  dropTo?: number;
  dropUntil?: string;
  /** This browser only: the newest read mark known (any browser), so later fetches don't count as unread. */
  readTo?: number;
  /** DM owner side: the other person quit. */
  peerLeft?: boolean;
  /** Ended and deleted: nothing of it is shown or kept, only this tombstone. */
  purged?: boolean;
  /** When it was deleted (synced, newest wins): a later rejoin outranks it. */
  purgedAt?: number;
  /**
   * Joined again after it ended for us (quit, removed, then invited back). The synced `ended` and
   * `purged` are set-once, so this, being newer, is what says they no longer hold (synced, newest wins).
   */
  rejoinedAt?: number;
  /**
   * This browser only (not synced): when this browser joined a chat the account was already in,
   * so earlier messages, which stay in each browser, aren't here.
   */
  joinedAt?: number;
}

/** What the chat list shows: a DM is one entry per person, whatever rooms it went through. */
export interface Convo {
  key: string;
  dm: boolean;
  peer?: string;
  /** Rooms oldest first. */
  rooms: ChatRecord[];
  /** The room messages go to now. */
  live?: Group;
  /** The newest room that still has group state (live, or unavailable). */
  current?: Group;
  title: string;
  /** Group picture an admin set (data URL), if any. */
  avatar?: string;
  lastTs: number;
  lastText?: string;
  unread: number;
  /** Not live only because GitHub refuses us right now (it may come back): retrying, not ended. */
  unreachable?: boolean;
}

export interface PendingInvite {
  key: string;
  /** The chat's repo, once it shows up among the repos we can open. */
  space?: string;
  from: string;
  /**
   * invited: waiting for the user to accept or decline. joining: accepted, trying to join now.
   * waiting: asked the inviter's app to confirm our identity. error: the last try failed.
   */
  status: 'invited' | 'joining' | 'waiting' | 'error';
  /** When the inviter sent it (from the inbox), to tell it apart from a later close. */
  created?: number;
  /** Accepting answered 404/410: the repo or invitation is gone. */
  gone?: boolean;
  /** The GitHub invitation id, while it isn't accepted yet. The inbox doesn't name the repo. */
  pointer?: string;
  /** The invite inbox entry that told us about it. */
  noticeId?: string;
  error?: string;
  since: number;
  attempts: number;
  nextTry: number;
  dismissed?: boolean;
  /** This browser is joining it right now (others wait their turn: a few join at once). */
  busy?: boolean;
  /**
   * The account is already in this chat (another of our browsers made or joined it): this browser
   * is only catching up, nobody invited us.
   */
  mine?: boolean;
  /** What the inviter's app told us about the chat, sealed to our devices (absent from older apps). */
  details?: InviteDetails;
  /** Invited back to a room that had ended for us: joining it again lifts that end. */
  rejoin?: boolean;
}

/**
 * The invite note: sealed by Keyhold to the invitee's device pre-keys, so only their apps can read
 * it before accepting. The Worker and GitHub see only ciphertext. The real name shows once joined.
 */
export interface InviteDetails {
  kind: 'dm' | 'group';
  /** Group name (encrypted like everything else in the chat). */
  name?: string;
  /** People already in the group, the inviter included. */
  people?: number;
}

/** One person on the Contacts screen. */
export interface Person {
  address: string;
  login: string;
  /** The DM with them (the live one if there is one). */
  dm?: Convo;
  /** Groups you share. */
  groups: Convo[];
  blocked: boolean;
  verified: boolean;
  /** Another browser of this account trusts a different key for them. */
  conflict: boolean;
  firstSeen?: number;
}

export interface PeerInfo {
  address: string;
  /** mismatch: the key they use in this chat is not the one published (and trusted) for them. */
  status: LookupResult['status'] | 'error' | 'mismatch';
  fingerprint?: string;
  safety?: string;
  verified?: boolean;
  /** When this account first saw their key (any of its browsers). */
  firstSeen?: number;
  /** key-changed because another of this account's browsers trusts a different key (not GitHub). */
  otherBrowser?: boolean;
  /** Only what this account remembers: the directory hasn't confirmed the key yet. */
  checking?: boolean;
  error?: string;
}

const ROOT_BACKUP_INFO = 'keyhold-chat-web/v1/root-backup';
/** The account key K for the personal store in the home repo, derived from the root key. */
const PERSONAL_KEY_INFO = 'keyhold-chat-web/v1/personal-store';
const PERSONAL_KEY_SLOT = 'chat-web/personal-key';
/** This browser saw the app installed, with this home repo (kv). */
const INSTALL_KEY = 'install';
/** Snapshots of what this browser last wrote to the synced store (kv). */
const PUSHED_KEY = 'sync:pushed';
/** What each synced chat field does when two browsers change it at once. */
// `ended` stays set-once for older apps; `endedLast` (newest wins) is the end after a rejoin.
const CHAT_RULES: Record<string, MergeRule> = { space: 'once', kind: 'once', peer: 'once', name: 'once', createdAt: 'once', ended: 'once', clearedAt: 'max', peerLeft: 'once', purged: 'once', purgedAt: 'max', rejoinedAt: 'max' };
/**
 * The sync schedule: how often each kind of check runs. One sync step (tick) reads it; the loop
 * only decides when to call that step. The mock build (tests) runs the same schedule on a faster
 * clock, and can ask for a step right away with window.__chat.syncNow(), so tests never wait on
 * real-world timers. Production timings are the numbers below, unscaled.
 */
const SCHEDULE_SCALE = CONFIG.mock ? ((globalThis as { __syncScale?: number }).__syncScale ?? 0.1) : 1;
const at = (ms: number) => Math.round(ms * SCHEDULE_SCALE);
const LOOP_MS = at(1_500);
const ACTIVE_POLL_MS = at(4_000);
const IDLE_POLL_MS = at(20_000);
const WARM_POLL_MS = at(6_000);
const HIDDEN_POLL_MS = at(90_000);
const INVITE_POLL_MS = at(15_000);
const INVITE_PENDING_POLL_MS = at(5_000);
const PERSONAL_FLUSH_MS = at(2_000);
const PERSONAL_PULL_MS = at(8_000);
const PERSONAL_FULL_PULL_MS = at(30_000);
const FULL_SYNC_ACTIVE_MS = at(12_000);
/** A quiet chat's folders are listed in full this often (its change check runs far more often). */
const FULL_SYNC_IDLE_MS = at(10 * 60_000);
const FULL_SYNC_WARM_MS = at(30_000);
/**
 * A tab in the background lists its chats in full this rarely: enough that a message GitHub's
 * change answers missed (they can lag) still arrives before the mail cursor moves past its day.
 */
const FULL_SYNC_HIDDEN_MS = at(30 * 60_000);
const SPACE_SCAN_MS = at(60_000);
const SPACE_SCAN_PENDING_MS = at(15_000);
const INVITE_RETRY_MS = at(10_000);
const INVITE_RETRY_MAX_MS = at(3 * 60_000);
/**
 * A send skips its own sync when the chat was synced less than this long ago. Longer than the
 * gap between two syncs of the chat on screen (FULL_SYNC_ACTIVE_MS plus a poll and a slow
 * request), so a send from an open chat nearly always goes straight out.
 */
const SEND_FRESH_MS = 20_000;
const JOINS_AT_ONCE = 3;
/** Files kept across reloads by content hash (see blobStore), and how many before starting over. */
const BLOB_PREFIX = 'blob:';
const BLOBS_KEPT_MAX = 1500;
const BLOB_PRUNE_MS = 60 * 60_000;
/** A GitHub read that has not answered by then is given up (and retried by the next step). */
const REQUEST_TIMEOUT_MS = 20_000;
/** An answer slower than this is listed in Settings > Connection. */
const SLOW_REQUEST_MS = 5_000;
/**
 * Writes can carry a picture over a slow link: more time, then the same, plus time for the body
 * at a slow upload speed (a 10 MB attachment is about 13 MB of base64). The timer stops when the
 * answer starts, so downloads are never cut off part way.
 */
const WRITE_TIMEOUT_MS = 90_000;
const WRITE_SLOWEST_BYTES_PER_S = 16_000;
/** Chats checked at once in a sync step: each check is a GitHub round trip, slow on a phone. */
const CHECKS_AT_ONCE = 4;
// Rotation itself is weekly (keyhold DEFAULT_PREKEYS); this is only how often to look.
const PREKEY_CHECK_MS = at(10 * 60_000);
/** A chat GitHub refuses us (maybe for a moment) is tried again after this, then less and less often. */
const LOST_RETRY_MS = at(60_000);
const LOST_RETRY_MAX_MS = at(30 * 60_000);
/**
 * An own chat repo with nothing in it (a creation that stopped before its first log entry, on a
 * browser that won't finish it) is deleted once it has looked empty this long. Real time: another
 * browser making a chat fills its repo within seconds.
 */
const ORPHAN_MS = 10 * 60_000;
/** A rate limit without a stated wait pauses syncing this long. */
const RATE_PAUSE_MS = at(60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const loginFrom = (address: string) => {
  try {
    return loginOf(address);
  } catch {
    return address;
  }
};

/** fetch's own failure: no connection (asleep, offline), not an answer from GitHub. Chrome, Safari, Firefox. */
export const isNetworkError = (e: unknown) => e instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(e.message);

/** GitHub's rate limit (primary or secondary), from a keyhold error or a raw answer. */
export const isRateLimit = (e: unknown) => {
  const code = (e as { code?: unknown } | undefined)?.code;
  const m = e instanceof Error ? e.message : String(e);
  return code === 'too_many_attempts' || /rate limit|secondary limit|\b429\b/i.test(m);
};

/** How long the error says to wait, in ms, if it says (read defensively: providers may add it). */
export function retryAfterMs(e: unknown): number | undefined {
  const s = retryAfterOf(e); // the provider's RateLimitError: seconds, like the header
  if (s !== undefined && s > 0) return s * 1000;
  const x = e as { retryAfter?: unknown; retryAfterMs?: unknown } | undefined;
  if (typeof x?.retryAfterMs === 'number' && x.retryAfterMs > 0) return x.retryAfterMs;
  if (typeof x?.retryAfter === 'number' && x.retryAfter > 0) return x.retryAfter * 1000; // seconds, like the header
  return undefined;
}

const OFFLINE = 'Offline. Retrying…';
/** How long a dropped connection may last before the app says it is offline. */
const OFFLINE_GRACE_MS = 10_000;

export function describeError(e: unknown): string {
  if (isNetworkError(e)) return OFFLINE;
  if (isRateLimit(e)) return 'GitHub rate limit reached. Wait a few minutes and try again.';
  return e instanceof Error ? e.message : String(e);
}

export class Session {
  phase: Phase = 'loading';
  error?: string;
  readonly address: string;
  readonly login: string;
  homeRepo = CONFIG.homeRepo;
  installationId?: number;
  /** chat-home exists but the install doesn't include it. */
  homeNotSelected = false;
  db!: Db;
  device!: DeviceStorage;
  provider!: StorageProvider & { client: { requests: number }; changes: ChangeWatch };
  registry!: IdentityRegistry;
  /** Trusted keys and verified marks for the people this account talks to (synced). */
  contacts!: ContactBook;
  identity?: DeviceIdentity;
  chat?: Chat;
  records = new Map<string, ChatRecord>();
  groupErrors = new Map<string, string>();
  /** When each chat's current problem started: a dropped connection is shown only if it lasts. */
  private errorSince = new Map<string, number>();
  private setGroupError(id: string, message: string) {
    if (!this.groupErrors.has(id)) this.errorSince.set(id, Date.now());
    this.groupErrors.set(id, message);
    // Shown once the grace is over, even if nothing else changes by then.
    if (message === OFFLINE) setTimeout(() => this.bump(), OFFLINE_GRACE_MS + 50);
  }
  private clearGroupError(id: string) {
    this.groupErrors.delete(id);
    this.errorSince.delete(id);
  }
  /**
   * The chat's problem to show, if any. A phone that wakes a tab finds its connections dropped:
   * the first requests fail and the next ones work, so "Offline" waits a few seconds to be true.
   */
  chatWarning(id: string): string | undefined {
    const e = this.groupErrors.get(id);
    if (e === OFFLINE && Date.now() - (this.errorSince.get(id) ?? 0) < OFFLINE_GRACE_MS) return undefined;
    return e;
  }
  rateRemaining?: number;
  /** GitHub asked us to slow down: the timed sync steps wait until then (syncNow doesn't). */
  rateLimitedUntil = 0;
  /** GitHub no longer accepts this sign-in (the refresh token is dead): the app shows sign-in. */
  signedOut = false;
  /** The conversation on screen. */
  activeConvo?: string;
  lastPollError?: string;
  /** Messages on their way out, per group, for the "sending…" bubble and the failed state. */
  sending = new Map<string, Sending[]>();
  /** Reactions on their way out, by `groupId/messageId/emoji`. Shown at once, faded until sent. */
  reacting = new Map<string, Reacting>();
  /** Messages being deleted, by `groupId/messageId`. */
  deleting = new Set<string>();
  /** Slow chat-wide actions in progress (close, quit, block), by conversation key: what is happening. */
  chatBusy = new Map<string, string>();
  /** Slow actions as steps, for the progress views (everything goes through GitHub, so most take seconds). */
  readonly activities = new Activities(() => this.bump());
  /** Decrypted attachments this tab has opened or sent, by blob ref. Memory only, so no new plaintext lands on disk. */
  private files = new Map<string, Promise<Blob>>();

  private version = 0;
  private listeners = new Set<() => void>();
  private stopped = false;
  /** This tab's work in progress (GitHub calls, IndexedDB), so a stop can wait for it to finish. */
  private gate = new WorkGate();
  private gated = false;
  /** The sync loop, while it runs. */
  private looping?: Promise<void>;
  /** Set by stop(): resolves once the work running at the stop has finished. */
  private quiescing?: Promise<boolean>;
  private lastCheck = new Map<string, number>();
  private etags = new Map<string, string>();
  private lastInvites = 0;
  private lastSpaceScan = 0;
  private invites = new Map<string, PendingInvite>();
  /** Chats the user declined, so they don't come back on the next scan. */
  private declined = new Set<string>();
  /** When each chat last had a full sync, as a fallback for GitHub's slow change check. */
  private lastFullSync = new Map<string, number>();
  private kick?: () => void;
  /** syncNow() callers waiting for the next sync step to finish. */
  private afterTick: (() => void)[] = [];
  /** People this account blocked: their invitations are declined by themselves. */
  blocked = new Set<string>();
  /** Rooms to end once the current sync is done (a close arrived while syncing). */
  private toEnd = new Map<string, NonNullable<ChatRecord['ended']>>();
  private userIds = new Map<string, Promise<number | undefined>>();
  /** Chat list, marks, blocks and declines shared by all this account's browsers (home repo). */
  personal?: PersonalData;
  syncError?: string;
  private pushed = new Map<string, string>();
  private lastPull = 0;
  private lastFullPull = 0;
  private lastFlush = 0;
  private lastClosures = 0;
  private lastPreKey = 0;
  private rounds = 0;
  /** Start-up read of the synced store, running after the chat is on screen. */
  private syncStarting?: Promise<unknown>;
  private hasSyncKey = false;
  private syncReady = false;
  /** Opened from the stored install check; it gets checked once the chat shows. */
  private verifyInstall = false;
  /** Live connection to the invite inbox; while it is up the inbox isn't polled. */
  private inbox?: InboxSocket;
  private peers = new Map<string, Promise<PeerInfo>>();
  /** Chats GitHub refuses us for now: when to try again, and the wait after that. */
  private lost = new Map<string, { next: number; delay: number; since: number }>();
  /** Synced-store writes on their way into the queue (PersonalData.set is async). */
  private inflight = new Set<Promise<unknown>>();
  /** Snapshots whose change is queued, not yet written. */
  private queuedSnaps = new Map<string, string>();
  /** Snapshots known written (persisted as PUSHED_KEY). */
  private saved = new Map<string, string>();
  private syncOpen?: Promise<void>;

  constructor(
    readonly auth: AuthState,
    /** What a browser provides. The app uses the defaults; the no-browser tests pass their own per simulated browser. */
    private readonly env: { token?: (force: boolean) => Promise<string>; indexedDB?: IDBFactory } = {},
  ) {
    this.login = auth.login.toLowerCase();
    this.address = toAddress(this.login);
  }

  // ---- store plumbing (React subscribes with useSyncExternalStore) ----

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  bump() {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ---- GitHub access ----

  /**
   * Recent GitHub and Worker requests, for Settings > Connection: how many answered, and the
   * last problems (failures, timeouts, slow answers). Paths only, never tokens or bodies.
   */
  readonly net = { since: Date.now(), ok: 0, failed: 0, slow: 0, totalMs: 0, problems: [] as { at: number; what: string; how: string; ms: number }[] };
  private noteNet(url: string, method: string, ms: number, how?: string) {
    const n = this.net;
    if (how) n.failed++;
    else {
      n.ok++;
      n.totalMs += ms;
      if (ms >= SLOW_REQUEST_MS) n.slow++;
    }
    if (!how && ms < SLOW_REQUEST_MS) return;
    let what = url;
    try {
      const u = new URL(url);
      what = `${method} ${u.host}${u.pathname.split('/').slice(0, 5).join('/')}`;
    } catch {
      /* keep it as it is */
    }
    n.problems.unshift({ at: Date.now(), what, how: how ?? 'slow', ms });
    n.problems.length = Math.min(n.problems.length, 20);
  }

  /** fetch with the current (refreshed) token, no HTTP cache, and rate-limit tracking. */
  ghFetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const go = async (force: boolean) => {
      let token: string;
      try {
        token = await (this.env.token ?? currentToken)(force);
      } catch (e) {
        this.noteNet(CONFIG.worker + '/token', 'POST', 0, `sign-in refresh: ${(e as Error).message}`);
        if (e instanceof SignedOutError && !this.signedOut) {
          this.signedOut = true;
          this.bump();
        }
        throw e;
      }
      // A phone switching networks can leave a request hanging for minutes, and every chat's
      // sync with it: give up and let the next step try again, like any dropped connection.
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), !init.method || init.method === 'GET' ? REQUEST_TIMEOUT_MS : WRITE_TIMEOUT_MS + ((init.body?.length ?? 0) * 1000) / WRITE_SLOWEST_BYTES_PER_S);
      const t0 = Date.now();
      try {
        const r = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }, cache: 'no-store', signal: ctl.signal });
        this.noteNet(url, init.method ?? 'GET', Date.now() - t0, r.status >= 500 || r.status === 429 ? `HTTP ${r.status}` : undefined);
        return r;
      } catch (e) {
        this.noteNet(url, init.method ?? 'GET', Date.now() - t0, ctl.signal.aborted ? 'timed out' : (e as Error).message || String(e));
        if (ctl.signal.aborted) throw new TypeError('Failed to fetch (timed out)');
        throw e;
      } finally {
        clearTimeout(t);
      }
    };
    let r = await go(false);
    if (r.status === 401) r = await go(true);
    const left = r.headers.get('x-ratelimit-remaining');
    if (left !== null && url.startsWith(CONFIG.api)) this.rateRemaining = Number(left);
    if (r.status === 429 || (r.status === 403 && (left === '0' || r.headers.get('retry-after') !== null))) {
      const after = Number(r.headers.get('retry-after'));
      const reset = Number(r.headers.get('x-ratelimit-reset'));
      this.pauseFor(after > 0 ? after * 1000 : reset > 0 ? reset * 1000 - Date.now() : undefined);
    }
    return r;
  };

  /** Slow down after a rate limit: the timed sync steps wait this long (at least). */
  private pauseFor(ms: number | undefined) {
    const until = Date.now() + Math.max(ms ?? RATE_PAUSE_MS, 1_000);
    if (until > this.rateLimitedUntil) this.rateLimitedUntil = until;
  }

  /** Remember what a failure means for the schedule; returns what to show. */
  private noteError(e: unknown): string {
    if (isRateLimit(e)) this.pauseFor(retryAfterMs(e));
    return describeError(e);
  }

  private async ghJson<T>(path: string): Promise<{ status: number; data?: T }> {
    const r = await this.ghFetch(CONFIG.api + path, { headers: { Accept: 'application/vnd.github+json' } });
    const t = await r.text();
    return { status: r.status, data: t ? (JSON.parse(t) as T) : undefined };
  }

  // ---- start-up ----

  async start() {
    // Every GitHub and Worker call goes through the gate, so a stop can wait for them and a
    // hand-over to another tab can keep this one from starting new ones.
    if (!this.gated) {
      this.gated = true;
      const ghFetch = this.ghFetch;
      this.ghFetch = (url, init) => this.gate.track(async () => readFully(await ghFetch(url, init)));
    }
    try {
      this.db = await Db.open(`keyhold-chat:${this.auth.id}`, this.env.indexedDB, {
        gate: this.gate,
        onVersionChange: () => {
          // Another tab upgrades or deletes this browser's data: this one must not write any more.
          this.gate.fence();
          this.stop();
          this.phase = 'error';
          this.error = 'Reload to continue.';
          this.bump();
        },
      });
      this.device = idbDevice(this.db);
      await this.decidePhase();
    } catch (e) {
      this.phase = 'error';
      this.error = describeError(e);
    }
    this.bump();
  }

  /**
   * The kept files are only a cache: past the cap, some go (by hash, so any of them), down to
   * three quarters of it. Checked at start and every hour, so a tab left open stays bounded and
   * a reload doesn't download everything again.
   */
  private async pruneBlobs() {
    this.lastBlobPrune = Date.now();
    try {
      const keys = await this.db.keys('kv', BLOB_PREFIX);
      if (keys.length <= BLOBS_KEPT_MAX) return;
      await this.db.delMany('kv', keys.slice(0, keys.length - Math.floor(BLOBS_KEPT_MAX * 0.75)));
    } catch {
      /* the next check tries again */
    }
  }
  private lastBlobPrune = 0;

  /** The provider needs the install: before it, GitHub hides every repo from the app. */
  private async makeProvider() {
    if (this.provider) return;
    this.provider = instrument(githubProvider({
      fetch: this.ghFetch as unknown as FetchFn,
      token: 'set-per-request',
      login: this.login,
      workerUrl: CONFIG.worker,
      apiBase: CONFIG.api,
      directoryRepo: CONFIG.directoryRepo,
      homeRepo: this.homeRepo,
      chatPrefix: CONFIG.chatPrefix,
      description: `End-to-end encrypted chat data. Only the members' chat app can read it. Open it at ${location.origin}`,
      // Log entries, directory entries and synced-store items, kept by content hash so a reload
      // downloads only what changed. Ciphertext or signed public data, as on GitHub.
      blobStore: {
        get: (sha) => this.db.get<Uint8Array>('kv', BLOB_PREFIX + sha),
        put: (sha, data) => this.db.put('kv', data, BLOB_PREFIX + sha),
      },
    }), this.activities) as typeof this.provider;
    void this.pruneBlobs();
    this.contacts = new ContactBook(this.db, loginFrom, (a) => {
      this.peers.delete(a);
      this.bump();
    });
    await this.contacts.load();
    this.registry = new IdentityRegistry(this.provider.directory, this.contacts);
  }

  async decidePhase() {
    // This browser saw the install before: open from what it stored and check GitHub after the
    // chat is on screen, so a reload needs no GitHub round trip before the first screen.
    const known = await this.db.get<{ homeRepo: string }>('kv', INSTALL_KEY);
    this.verifyInstall = !!known;
    if (known) this.homeRepo = known.homeRepo;
    else {
      if (!(await this.isInstalled())) {
        this.phase = 'install';
        return;
      }
      await this.db.put('kv', { homeRepo: this.homeRepo }, INSTALL_KEY);
    }
    await this.makeProvider();
    this.identity = await loadDeviceIdentity(this.device);
    if (this.identity) {
      await this.openChat();
      return;
    }
    const dir = await verifyDirectory(await this.provider.directory.read(this.address));
    this.phase = dir ? 'restore' : 'new-identity';
  }

  /** Polled from the install screen: move on as soon as the install shows up. */
  async pollInstall(): Promise<boolean> {
    if (this.phase !== 'install') return true;
    let ok = false;
    try {
      ok = await this.isInstalled();
    } catch {
      return false;
    }
    if (ok) await this.recheckInstall();
    return ok;
  }

  async recheckInstall() {
    this.phase = 'loading';
    this.bump();
    try {
      await this.decidePhase();
    } catch (e) {
      this.phase = 'error';
      this.error = describeError(e);
    }
    this.bump();
  }

  async isInstalled(): Promise<boolean> {
    const r = await this.ghJson<{ installations: { id: number; account: { login: string } }[] }>('/user/installations?per_page=100');
    if (r.status !== 200) throw new Error(`Could not check the app installation (${r.status})`);
    const mine = (r.data?.installations ?? []).find((i) => i.account.login.toLowerCase() === this.login);
    this.installationId = mine?.id;
    if (!mine) return false;
    // The home repo must be one the app can open. If it exists but wasn't selected in the
    // install, GitHub hides it from the app and the app can't create it either.
    // Accounts made before chat-home keep their keyhold-home.
    const legacy = await this.ghJson(`/repos/${this.login}/${CONFIG.legacyHomeRepo}`);
    const home = legacy.status === 200 ? legacy : await this.ghJson(`/repos/${this.login}/${CONFIG.homeRepo}`);
    if (home.status === 200) {
      this.homeRepo = legacy.status === 200 ? CONFIG.legacyHomeRepo : CONFIG.homeRepo;
      this.homeNotSelected = false;
      return true;
    }
    const created = await this.ghFetch(`${CONFIG.api}/user/repos`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: CONFIG.homeRepo, private: true, auto_init: true, description: 'Private home of my end-to-end encrypted chat app (encrypted settings and key backup).' }),
    });
    this.homeNotSelected = created.status === 422;
    if (!this.homeNotSelected) this.homeRepo = CONFIG.homeRepo;
    return !this.homeNotSelected;
  }

  /** The install's settings page, where the user can add repos to it. */
  installSettingsUrl() {
    return this.installationId ? `https://github.com/settings/installations/${this.installationId}` : installUrl();
  }

  // ---- identity ----

  private async recoveryKey(bytes: Uint8Array) {
    return hkdfAesKey(bytes, ROOT_BACKUP_INFO, ['encrypt', 'decrypt']);
  }

  /** Make a new identity. Returns the recovery code to show once. */
  createIdentity(onStart?: (a: Activity) => void): Promise<string> {
    return this.activities.run('Creating your identity', ['Making your keys', 'Saving your encrypted backup', 'Publishing your identity'], (t) => this.createIdentityNow(t), { onStart });
  }

  private async createIdentityNow(t: Tracker): Promise<string> {
    const root = createRootKey();
    try {
      const code = await generateRecoveryCode();
      // Back up first, so there is never a published identity without a way back in.
      t.step('Saving your encrypted backup');
      await backupRootKey(this.provider.vault, await this.recoveryKey(code.bytes), this.address, root);
      const id = await createDeviceIdentity(this.device, root, this.address, newDeviceId());
      await this.saveSyncKey(root);
      t.step('Publishing your identity');
      try {
        await new DirectoryWriter(this.provider.directory, this.address).publish(root, id.cert, { name: this.login });
      } catch (e) {
        await this.device.keystore.delete('chat/device-identity');
        throw e;
      }
      this.identity = id;
      return code.grouped;
    } finally {
      wipeRoot(root);
    }
  }

  async finishSetup() {
    await this.openChat();
    this.bump();
  }

  private async unlockRoot(codeText: string): Promise<RootKey> {
    const code = await parseRecoveryCode(codeText);
    let root: RootKey | undefined;
    try {
      root = await restoreRootKey(this.provider.vault, await this.recoveryKey(code.bytes), this.address);
    } catch {
      throw new Error('That recovery code does not open your backup.');
    }
    if (!root) throw new Error('No backup was found for this account.');
    const dir = await verifyDirectory(await this.provider.directory.read(this.address));
    if (dir && dir.fingerprint !== fingerprint(root.publicKey)) {
      wipeRoot(root);
      throw new Error('The backup does not match your published identity.');
    }
    return root;
  }

  private async saveSyncKey(root: RootKey) {
    const raw = await hkdfBytes(root.secretKey, PERSONAL_KEY_INFO);
    await this.device.keystore.put(PERSONAL_KEY_SLOT, raw);
    raw.fill(0);
  }

  /** Browsers set up before sync existed: the recovery code unlocks the key once. */
  async enableSync(codeText: string) {
    await this.activities.run('Turning on sync', ['Opening your backup', 'Syncing with your other browsers'], async (t) => {
      const root = await this.unlockRoot(codeText);
      try {
        await this.saveSyncKey(root);
      } finally {
        wipeRoot(root);
      }
      t.step('Syncing with your other browsers');
      await this.startSync();
      this.bump();
    }, { background: true });
  }

  /** On as soon as this browser has the key, even while the first sync is still reading. */
  get syncOn() {
    return this.hasSyncKey || !!this.personal;
  }

  /** Add this browser as a new device of an existing identity. */
  restoreIdentity(codeText: string, onStart?: (a: Activity) => void) {
    return this.activities.run('Adding this browser', ['Opening your backup', 'Adding this browser to your identity'], (t) => this.restoreNow(codeText, t), { onStart });
  }

  private async restoreNow(codeText: string, t: Tracker) {
    const root = await this.unlockRoot(codeText);
    t.step('Adding this browser to your identity');
    try {
      const id = await createDeviceIdentity(this.device, root, this.address, newDeviceId());
      await this.saveSyncKey(root);
      try {
        await new DirectoryWriter(this.provider.directory, this.address).addDevice(root, id.cert);
      } catch (e) {
        await this.device.keystore.delete('chat/device-identity');
        throw e;
      }
      this.identity = id;
    } finally {
      wipeRoot(root);
    }
    await this.openChat();
    this.bump();
  }

  async myDevices(): Promise<{ cert: DeviceCertificate; current: boolean }[]> {
    const dir = await verifyDirectory(await this.provider.directory.read(this.address));
    if (!dir) return [];
    return [...dir.devices.values()]
      .sort((a, b) => a.issuedAt - b.issuedAt)
      .map((cert) => ({ cert, current: !!this.identity && cert.deviceId === this.identity.deviceId }));
  }

  async revokeDevice(devicePublic: string, codeText: string) {
    await this.activities.run('Removing a browser', ['Opening your backup', 'Publishing the removal'], async (t) => {
      const root = await this.unlockRoot(codeText);
      t.step('Publishing the removal');
      try {
        await new DirectoryWriter(this.provider.directory, this.address).revokeDevice(root, devicePublic);
      } finally {
        wipeRoot(root);
      }
    }, { anyCall: true });
  }

  /** Testing aid: delete the identity repos so the account can start fresh. */
  async resetIdentity() {
    this.stop();
    for (const name of [CONFIG.directoryRepo, this.homeRepo]) {
      const r = await this.ghFetch(`${CONFIG.api}/repos/${this.login}/${name}`, { method: 'DELETE', headers: { Accept: 'application/vnd.github+json' } });
      if (![204, 404].includes(r.status)) throw new Error(`Could not delete ${name} (${r.status})`);
    }
    this.db.close();
    await Db.delete(this.db.name, this.env.indexedDB);
  }

  async forgetBrowser() {
    this.stop();
    this.db.close();
    await Db.delete(this.db.name, this.env.indexedDB);
  }

  // ---- chats ----

  private async openChat() {
    // Reopened after a stop (the install came back): the old chat's work must be over first, or
    // its groups and the new ones would both use the same keys.
    if (this.quiescing) await this.quiescing;
    this.quiescing = undefined;
    if (this.gate.isFenced) return;
    this.stopped = false;
    this.chat = await Chat.open({
      provider: this.provider,
      device: this.device,
      identity: this.identity!,
      registry: this.registry,
      features: resolveFeatures(this.provider, { historyBackup: false, preKeys: true }),
      onMessage: (g, m) => this.onMessage(g, m),
      // A chat on screen is synced every few seconds: a send right after one goes straight out
      // (one request instead of three in a row; keyhold re-sends what turns out to be late).
      sendFreshMs: SEND_FRESH_MS,
      // Read the clock on each call (keyhold's default keeps the function it found at load).
      now: () => Date.now(),
    });
    for (const k of await this.db.keys('kv', 'chat:')) {
      const r = await this.db.get<ChatRecord>('kv', k);
      if (r) this.records.set(r.groupId, r);
    }
    await this.repairPreviews();
    for (const g of this.chat.groups.values()) {
      this.fill(g);
      await this.restoreUnsent(g);
    }
    for (const k of await this.db.keys('kv', 'declined:')) this.declined.add(k.slice('declined:'.length));
    for (const k of await this.db.keys('kv', 'block:')) this.blocked.add(k.slice('block:'.length));
    this.hasSyncKey = !!(await this.device.keystore.get(PERSONAL_KEY_SLOT));
    // The chat list and messages are already in this browser: show them now, and read what other
    // browsers changed in the background (the sync step waits for this before its own sync work).
    this.syncStarting = this.startSync()
      .catch((e) => (this.syncError = describeError(e)))
      .then(() => {
        this.syncReady = true;
        this.bump();
      });
    if (this.verifyInstall) {
      this.verifyInstall = false;
      void this.checkInstallStill();
    }
    this.phase = 'ready';
    if (!CONFIG.mock) {
      this.inbox = new InboxSocket(CONFIG.worker, currentToken, () => {
        // Something arrived (or the socket went up or down): look at the inbox on the next tick.
        this.lastInvites = 0;
        this.lastClosures = 0;
        this.kick?.();
      });
      this.inbox.start();
    }
    // Test hooks, mock build only: run a sync step now, and read state when a check fails.
    if (CONFIG.mock) {
      (window as { __chat?: object }).__chat = {
        syncNow: () => this.syncNow(),
        debug: () => ({
          invites: this.pendingInvites(),
          groups: Object.fromEntries(this.groupErrors),
          members: Object.fromEntries([...(this.chat?.groups.values() ?? [])].map((g) => [g.id, g.members().map((m) => `${m.address}${m.pending ? ' (added)' : ''}`)])),
          pollError: this.lastPollError,
          syncError: this.syncError,
        }),
      };
    }
    globalThis.addEventListener?.('online', this.onWake);
    document.addEventListener('visibilitychange', this.onWake);
    this.looping = this.loop();
  }

  /**
   * Back online, or the tab shown again (often after the computer slept): check everything now, so
   * a problem from while it was away clears in seconds instead of waiting out the slow timers.
   */
  private onWake = () => {
    if (this.stopped || !this.chat || document.visibilityState === 'hidden') return;
    this.lastInvites = 0;
    this.lastClosures = 0;
    this.lastPull = 0;
    this.lastCheck.clear();
    for (const g of this.chat.groups.keys()) if (this.groupErrors.has(g)) this.lastFullSync.delete(g);
    for (const l of this.lost.values()) l.next = 0;
    this.kick?.();
    this.openKick?.();
  };

  /** Opened from the stored install check: make sure the install is still there. */
  private async checkInstallStill() {
    let ok: boolean;
    try {
      ok = await this.isInstalled();
    } catch {
      return; // offline or GitHub hiccup: keep going, the next load checks again
    }
    if (this.stopped) return;
    if (ok) {
      await this.db.put('kv', { homeRepo: this.homeRepo }, INSTALL_KEY);
      return;
    }
    await this.db.del('kv', INSTALL_KEY);
    this.stop();
    this.phase = 'install';
    this.bump();
  }

  record(groupId: string): ChatRecord {
    let r = this.records.get(groupId);
    if (!r) {
      r = { groupId, invited: [], createdAt: Date.now(), lastTs: Date.now(), unread: 0 };
      this.records.set(groupId, r);
      void this.saveRecord(r);
    }
    return r;
  }
  /** Rows saved before deletes and edits updated the preview may still hold a deleted message's text: redo them from the stored messages. */
  private async repairPreviews() {
    if (await this.db.get('kv', 'previews:v2')) return;
    for (const r of this.records.values()) {
      if (r.lastText === undefined || r.purged) continue;
      const last = await this.db.lastMessage<MsgRecord>(r.groupId, (m) => m.kind !== 'system');
      if (!last) continue;
      const text = previewText(last);
      if (text !== r.lastText) {
        r.lastText = text;
        await this.db.put('kv', r, `chat:${r.groupId}`);
      }
    }
    await this.db.put('kv', true, 'previews:v2');
  }
  private saveRecord(r: ChatRecord) {
    this.push(r);
    return this.db.put('kv', r, `chat:${r.groupId}`);
  }

  // ---- sync across this account's browsers (personal store in the home repo) ----

  /** Open the synced store once: two calls at once share one opening (a second would replace the first's queue). */
  private startSync(): Promise<void> {
    if (this.personal) return Promise.resolve();
    return (this.syncOpen ??= this.startSyncNow().finally(() => (this.syncOpen = undefined)));
  }

  private async startSyncNow() {
    const raw = await this.device.keystore.get(PERSONAL_KEY_SLOT);
    if (!raw) return;
    this.hasSyncKey = true;
    const key = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
    // What this browser already wrote, so a reload doesn't write it all again.
    const sent = await this.db.get<Record<string, string>>('kv', PUSHED_KEY);
    if (sent) {
      for (const [k, v] of Object.entries(sent)) {
        if (!this.pushed.has(k)) this.pushed.set(k, v);
        if (!this.saved.has(k)) this.saved.set(k, v);
      }
    }
    if (this.personal) return;
    // With a copy of each record in this browser: GitHub can't roll one back or delete it
    // unnoticed (the trusted keys of contacts above all); what this browser knew is written back.
    this.personal = await PersonalData.open(this.provider.personal, key, this.identity!.deviceId, Date.now, { local: this.device.keystore });
    // Everything this browser knows goes up once (only what changed since it last did).
    for (const r of this.records.values()) this.push(r);
    for (const a of this.blocked) await this.syncBlock(a, true);
    for (const sp of this.declined) await this.syncDeclined(sp);
    await this.pull();
    // Keys this browser pinned go up (after the pull, so a different synced key is a conflict, not overwritten).
    this.contacts.personal = this.personal;
    await this.contacts.migrate();
    await this.flushPersonal();
  }

  /**
   * Queue a change for the synced store. `snap` is remembered as written only once the change is
   * in the queue and a flush has written it, so a tab closed in between sends it again on reload.
   */
  private queueSet(k: string, snap: string, run: (p: PersonalData) => Promise<void>): Promise<void> {
    const p = this.personal!;
    this.pushed.set(k, snap);
    const job: Promise<void> = run(p).then(
      () => void this.queuedSnaps.set(k, snap),
      () => {
        if (this.pushed.get(k) === snap) this.pushed.delete(k); // try again next time
      },
    ).finally(() => this.inflight.delete(job));
    this.inflight.add(job);
    return job;
  }

  /** Write queued changes, then remember what has been written. */
  private async flushPersonal() {
    const p = this.personal;
    if (!p) return;
    // Changes still on their way into the queue go in this flush.
    while (this.inflight.size) await Promise.all([...this.inflight]);
    const batch = new Map(this.queuedSnaps);
    this.queuedSnaps.clear();
    try {
      await p.flush();
    } catch (e) {
      for (const [k, v] of batch) if (!this.queuedSnaps.has(k)) this.queuedSnaps.set(k, v);
      throw e;
    }
    if (!batch.size && this.saved.size) return;
    for (const [k, v] of batch) this.saved.set(k, v);
    await this.db.put('kv', Object.fromEntries(this.saved), PUSHED_KEY);
  }

  private async syncBlock(address: string, blocked: boolean) {
    const mark = blocked ? 'on' : 'off';
    if (!this.personal || this.pushed.get(`b/${address}`) === mark) return;
    await this.queueSet(`b/${address}`, mark, (p) => p.set('blocks', address, { blocked: blocked || undefined }));
  }

  private async syncDeclined(space: string) {
    if (!this.personal || this.pushed.has(`d/${space}`)) return;
    await this.queueSet(`d/${space}`, 'on', (p) => p.set('settings', `declined:${space}`, { value: true }, { value: 'once' }));
  }

  /** Queue the synced fields of a chat, if they changed since last time. */
  private push(r: ChatRecord) {
    if (!this.personal) return;
    const fields: Record<string, unknown> = {
      space: r.space, kind: r.kind, peer: r.peer, name: r.lastName, createdAt: r.createdAt,
      ended: r.ended, endedLast: r.ended, clearedAt: r.clearedAt, clearedId: r.clearedId, peerLeft: r.peerLeft || undefined,
      purged: r.purged || undefined, purgedAt: r.purged ? r.purgedAt : undefined, rejoinedAt: r.rejoinedAt,
    };
    // A field never set stays out (older records have no endedLast; set-once fields can't be deleted).
    for (const k of Object.keys(fields)) if (fields[k] === undefined && k !== 'endedLast') delete fields[k];
    if (fields.endedLast === undefined && !r.rejoinedAt) delete fields.endedLast;
    const snap = JSON.stringify(fields);
    // What the synced store already says isn't written again: a new browser that just pulled the
    // chat list would otherwise rewrite every chat, one GitHub commit each.
    if (this.pushed.get(r.groupId) !== snap) {
      void this.queueSet(r.groupId, snap, async (p) => {
        const cur = await p.get('chats', r.groupId, false);
        if (cur && Object.entries(fields).every(([k, v]) => JSON.stringify(cur[k]) === JSON.stringify(v))) return;
        await p.set('chats', r.groupId, fields, CHAT_RULES);
      });
    }
    // Read up to here: other browsers clear their unread count.
    if (!r.unread) {
      const mark = `read:${r.lastTs}`;
      if (this.pushed.get(`r/${r.groupId}`) !== mark) {
        void this.queueSet(`r/${r.groupId}`, mark, async (p) => {
          const cur = await p.get<{ at?: number }>('readMarks', r.groupId, false);
          if (typeof cur?.at === 'number' && cur.at >= r.lastTs) return;
          await p.set('readMarks', r.groupId, { at: r.lastTs }, { at: 'max' });
        });
      }
    }
  }

  /** Apply what other browsers wrote. */
  private async pull() {
    if (!this.personal) return;
    for (const ch of await this.personal.changes()) {
      const v = ch.value;
      if (ch.collection === 'chats') await this.applyChat(ch.key, v);
      else if (ch.collection === 'contacts') await this.contacts.applyRemote(ch.key, v);
      else if (ch.collection === 'readMarks') {
        const r = this.records.get(ch.key);
        // Read up to there on some browser: only messages after it count as unread, here and later.
        if (r && typeof v.at === 'number' && v.at > (r.readTo ?? 0)) {
          r.readTo = v.at;
          r.unread = await this.countUnread(r);
          await this.saveRecord(r);
        }
      } else if (ch.collection === 'blocks') {
        this.pushed.set(`b/${ch.key}`, v.blocked ? 'on' : 'off');
        this.saved.set(`b/${ch.key}`, v.blocked ? 'on' : 'off');
        if (v.blocked) {
          if (!this.blocked.has(ch.key)) {
            this.blocked.add(ch.key);
            await this.db.put('kv', Date.now(), `block:${ch.key}`);
          }
        } else if (this.blocked.delete(ch.key)) await this.db.del('kv', `block:${ch.key}`);
      } else if (ch.collection === 'settings' && ch.key.startsWith('declined:') && v.value) {
        const sp = ch.key.slice('declined:'.length);
        this.pushed.set(`d/${sp}`, 'on');
        this.saved.set(`d/${sp}`, 'on');
        if (!this.declined.has(sp)) {
          this.declined.add(sp);
          await this.db.put('kv', Date.now(), `declined:${sp}`);
        }
      }
    }
    this.bump();
  }

  private async applyChat(groupId: string, v: Record<string, unknown>) {
    let r = this.records.get(groupId);
    if (!r) {
      r = { groupId, invited: [], createdAt: (v.createdAt as number) ?? Date.now(), lastTs: (v.createdAt as number) ?? 0, unread: 0 };
      this.records.set(groupId, r);
    }
    for (const f of ['space', 'kind', 'peer'] as const) if (!r[f] && v[f]) (r as unknown as Record<string, unknown>)[f] = v[f];
    if (!r.lastName && typeof v.name === 'string') r.lastName = v.name;
    if (typeof v.createdAt === 'number' && v.createdAt < r.createdAt) r.createdAt = v.createdAt;
    if (v.peerLeft) r.peerLeft = true;
    if (typeof v.clearedAt === 'number' && v.clearedAt > (r.clearedAt ?? 0)) await this.applyClear(r, v.clearedAt, typeof v.clearedId === 'string' ? v.clearedId : undefined, false);
    // Joined again on another browser: the end (and delete) before that no longer holds.
    if (typeof v.rejoinedAt === 'number' && v.rejoinedAt > (r.rejoinedAt ?? 0)) {
      r.rejoinedAt = v.rejoinedAt;
      if (r.ended && r.ended.at <= v.rejoinedAt) r.ended = undefined;
      if (r.purged && (r.purgedAt ?? 0) <= v.rejoinedAt) r.purged = undefined;
    }
    const ended = (v.endedLast ?? v.ended) as ChatRecord['ended'] | undefined;
    if (ended && !r.ended && ended.at > (r.rejoinedAt ?? 0)) {
      r.ended = ended;
      await this.chat!.groups.get(groupId)?.end();
    }
    const purgedAt = typeof v.purgedAt === 'number' ? v.purgedAt : 0;
    if (v.purged && !r.purged && (!r.rejoinedAt || purgedAt > r.rejoinedAt)) await this.purgeRoom(r, purgedAt || undefined);
    // Already in step with storage: don't echo it back.
    await this.db.put('kv', r, `chat:${r.groupId}`);
  }

  /**
   * Delete chat up to a message: `at` is its time, `id` the message. Here (`local`) that is the
   * newest message this browser had, so whatever arrives later was never seen and shows. Another
   * browser may not have fetched everything the deleting one had: there, what arrives up to `at`
   * is dropped until it reaches message `id`.
   */
  private async applyClear(r: ChatRecord, at: number, id: string | undefined, local: boolean) {
    const had = !local && id ? !!(await this.db.get('messages', [r.groupId, id])) : false;
    r.clearedAt = Math.max(r.clearedAt ?? 0, at);
    if (id) r.clearedId = id;
    await this.db.deleteMessages(r.groupId, at);
    if (local || had) {
      r.dropTo = undefined;
      r.dropUntil = undefined;
    } else {
      // A delete from an older app names no message: drop by time, as it always did.
      r.dropTo = Math.max(r.dropTo ?? 0, at);
      r.dropUntil = id;
    }
    if (r.lastTs <= at) {
      r.lastText = undefined;
      r.unread = 0;
    }
  }

  /** An ended room deleted: drop what's left of it here and keep only a tombstone. */
  private async purgeRoom(r: ChatRecord, at = Date.now()) {
    r.purged = true;
    r.purgedAt = Math.max(r.purgedAt ?? 0, at);
    await this.db.deleteMessages(r.groupId);
    await this.chat!.purge(r.groupId);
    // If GitHub still lists the repo for a while, it must not come back as an invitation.
    if (r.space && !this.declined.has(r.space)) {
      this.declined.add(r.space);
      await this.db.put('kv', Date.now(), `declined:${r.space}`);
      await this.syncDeclined(r.space);
    }
  }

  /** Keep what a room needs for display after its group state is gone. */
  fill(g: Group): ChatRecord {
    const r = this.record(g.id);
    let changed = false;
    if (!r.space) { r.space = g.space; changed = true; }
    const kind = this.isDm(g) ? 'dm' : 'group';
    if (r.kind !== kind) { r.kind = kind; changed = true; }
    if (kind === 'dm') {
      const p = this.dmPeer(g);
      if (p && r.peer !== p) { r.peer = p; changed = true; }
    } else if (g.name && r.lastName !== g.name) { r.lastName = g.name; changed = true; }
    else if (!g.name && !r.lastName) {
      // A new member learns the name only from a message an admin sends once they see the join.
      // Until then, use the name from the invitation note.
      const noted = [...this.invites.values()].find((i) => i.space === g.space && i.details?.kind === 'group')?.details?.name;
      if (noted) { r.lastName = noted; changed = true; }
    }
    if (changed) void this.saveRecord(r);
    return r;
  }

  convoKey(r: ChatRecord) {
    return r.kind === 'dm' && r.peer ? `dm:${r.peer}` : r.groupId;
  }

  /** Is this room part of the conversation on screen? */
  private onScreen(groupId: string) {
    const r = this.records.get(groupId);
    return !!r && !!this.activeConvo && this.convoKey(r) === this.activeConvo;
  }

  conversations(): Convo[] {
    if (!this.chat) return [];
    for (const g of this.chat.groups.values()) this.fill(g);
    const by = new Map<string, ChatRecord[]>();
    for (const r of this.records.values()) {
      if (r.hidden || r.purged) continue;
      const g = this.chat.groups.get(r.groupId);
      if (!g && !r.ended) continue;
      const k = this.convoKey(r);
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    const out: Convo[] = [];
    for (const [key, rooms] of by) out.push(this.makeConvo(key, rooms));
    return out.sort((a, b) => b.lastTs - a.lastTs);
  }

  convo(key: string): Convo | undefined {
    const direct = this.conversations().find((c) => c.key === key);
    if (direct) return direct;
    // An old link to one room of a DM.
    const r = this.records.get(key);
    return r ? this.conversations().find((c) => c.key === this.convoKey(r)) : undefined;
  }

  private makeConvo(key: string, rooms: ChatRecord[]): Convo {
    rooms.sort((a, b) => a.createdAt - b.createdAt);
    const groups = rooms.map((r) => this.chat!.groups.get(r.groupId)).filter((g): g is Group => !!g);
    const active = groups.filter((g) => g.active);
    const dm = rooms[0]!.kind === 'dm';
    // Two live rooms with the same person: the one owned by the lower GitHub user id wins (rule 2).
    const live = active.length > 1 ? this.winner(active) : active[0];
    const current = live ?? groups[groups.length - 1];
    const last = rooms.reduce((a, b) => (b.lastTs >= a.lastTs ? b : a));
    const peer = dm ? rooms.find((r) => r.peer)?.peer : undefined;
    const name = [...rooms].reverse().find((r) => r.lastName)?.lastName;
    const avatar = dm ? undefined : (current?.avatar ?? [...rooms].reverse().find((r) => r.avatar !== undefined)?.avatar);
    return {
      key, dm, peer, rooms, live, current,
      title: dm ? (peer ? loginFrom(peer) : 'Direct message') : current?.name || name || 'Untitled group',
      avatar: avatar || undefined,
      lastTs: last.lastTs,
      lastText: last.lastText,
      unread: rooms.reduce((n, r) => n + r.unread, 0),
      unreachable: !live && this.isUnreachable(current),
    };
  }

  /**
   * Rule 2 tie-break, deterministic on every browser. A room both people are in beats one still
   * waiting for the other to join; then the lowest owner user id; then the lowest room id (the same
   * everywhere, unlike a creation time, which each browser records by itself).
   */
  private winner(rooms: Group[]): Group {
    const both = rooms.filter((g) => g.members().filter((m) => !m.pending).length > 1);
    if (both.length) rooms = both;
    const id = (g: Group) => this.knownUserId(g.space.split('/')[0]!);
    return [...rooms].sort((a, b) => {
      const ia = id(a), ib = id(b);
      if (ia !== undefined && ib !== undefined && ia !== ib) return ia - ib;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0]!;
  }

  private knownIds = new Map<string, number>();
  private knownUserId(login: string) {
    const l = login.toLowerCase();
    if (!this.knownIds.has(l)) void this.userId(l);
    return this.knownIds.get(l);
  }

  /** A GitHub user's numeric id (stable across renames), cached in this browser. */
  userId(login: string): Promise<number | undefined> {
    const l = login.toLowerCase();
    let p = this.userIds.get(l);
    if (!p) {
      p = (async () => {
        const cached = await this.db.get<number>('kv', `uid:${l}`);
        if (cached) return cached;
        const r = await this.ghJson<{ id: number }>(`/users/${encodeURIComponent(l)}`);
        if (r.status !== 200 || typeof r.data?.id !== 'number') return undefined;
        await this.db.put('kv', r.data.id, `uid:${l}`);
        return r.data.id;
      })().then((v) => {
        if (v !== undefined) {
          this.knownIds.set(l, v);
          this.bump();
        } else this.userIds.delete(l);
        return v;
      }, () => {
        this.userIds.delete(l);
        return undefined;
      });
      this.userIds.set(l, p);
    }
    return p;
  }

  group(id: string) {
    return this.chat?.groups.get(id);
  }

  /** Did this account start the room (own its repo)? Only the owner can close it. */
  isOwner(room: { space?: string }) {
    return room.space?.split('/')[0]?.toLowerCase() === this.login;
  }

  /**
   * GitHub refuses us this room for now (keyhold's accessLost): not ended, it may come back. The
   * flag is keyhold's own; a group out of the map, or ended here, is not "unreachable".
   */
  isUnreachable(g: Group | undefined): boolean {
    if (!g || g.active || this.chat?.groups.get(g.id) !== g || this.records.get(g.id)?.ended) return false;
    return (g as unknown as { meta?: { accessLost?: boolean } }).meta?.accessLost === true;
  }

  isDm(g: Group) {
    try {
      return g.policy.kind === 'dm';
    } catch {
      return false;
    }
  }

  /** The other person in a DM, even before they have joined. */
  dmPeer(g: Group): string | undefined {
    const other = g.members().find((m) => m.address !== this.address);
    if (other) return other.address;
    const inv = this.records.get(g.id)?.invited[0];
    if (inv) return inv;
    const owner = g.space.split('/')[0];
    if (owner && owner !== this.login) return toAddress(owner);
    return undefined;
  }

  title(g: Group): string {
    if (this.isDm(g)) {
      const p = this.dmPeer(g);
      return p ? loginFrom(p) : 'Direct message';
    }
    return g.name || this.records.get(g.id)?.lastName || 'Untitled group';
  }

  /** People invited who haven't joined yet (added with pre-keys, or only invited). */
  pending(g: Group): string[] {
    const members = g.members();
    const joined = new Set(members.filter((m) => !m.pending).map((m) => m.address));
    const added = members.filter((m) => m.pending).map((m) => m.address);
    return [...new Set([...added, ...(this.records.get(g.id)?.invited ?? [])])].filter((a) => !joined.has(a));
  }

  /** People in the chat who have joined (not just added while offline). */
  joinedMembers(g: Group) {
    return g.members().filter((m) => !m.pending);
  }

  async userExists(login: string): Promise<{ login: string } | undefined> {
    const r = await this.ghJson<{ login: string; type: string }>(`/users/${encodeURIComponent(login)}`);
    if (r.status === 404) return undefined;
    if (r.status !== 200) throw new Error(`Could not look up ${login} (${r.status})`);
    return { login: r.data!.login };
  }

  private normLogin(input: string) {
    const l = input.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(l)) throw new Error(`"${input}" is not a GitHub username`);
    if (l === this.login) throw new Error('You cannot invite yourself');
    return l;
  }

  /** An invitation from this person that is waiting for Accept. */
  inviteFrom(input: string): PendingInvite | undefined {
    let a: string;
    try {
      a = toAddress(input.trim().replace(/^@/, '').toLowerCase());
    } catch {
      return undefined;
    }
    return this.pendingInvites().find((i) => i.from === a && i.status === 'invited');
  }

  /** The live DM with this person, if any (rule 1: one live room per conversation). */
  liveDm(address: string): Convo | undefined {
    return this.conversations().find((c) => c.dm && c.peer === address && c.live);
  }

  /** Open the chat with this person, or start one. Returns the conversation key. */
  async startDm(input: string, onStart?: (a: Activity) => void): Promise<string> {
    const login = this.normLogin(input);
    const address = toAddress(login);
    if (this.blocked.has(address)) throw new Error(`You blocked ${login}. Unblock them in Account and devices first.`);
    let existing = this.liveDm(address);
    if (existing) return existing.key;
    return this.activities.run(
      `Starting a chat with @${login}`,
      ['Checking for a chat you already have', `Finding @${login} on GitHub`, ...NEW_ROOM, `Inviting @${login}`],
      async (t) => {
        // Another of my devices may have started it already: join my own rooms first.
        await this.checkInvites(true);
        existing = this.liveDm(address);
        if (existing) return existing.key;
        t.step(`Finding @${login} on GitHub`);
        await this.ensurePublished();
        if (!(await this.userExists(login))) throw new Error(`No GitHub user named ${login}`);
        // Rooms that are only unavailable get replaced now: their secrets can go.
        for (const c of this.conversations()) {
          if (c.dm && c.peer === address) for (const r of c.rooms) await this.chat!.groups.get(r.groupId)?.end();
        }
        const g = await this.chat!.createGroup('dm');
        t.space(g.space);
        const r = this.record(g.id);
        r.invited = [address];
        r.kind = 'dm';
        r.peer = address;
        r.space = g.space;
        await this.saveRecord(r);
        t.link(`/c/${encodeURIComponent(this.convoKey(r))}`);
        this.bump();
        t.step(`Inviting @${login}`);
        await g.invite(address, { note: this.inviteNote(g) });
        await this.systemNote(g.id, `Invitation sent to @${login}. The chat opens for them when they accept in this app.`);
        this.bump();
        return this.convoKey(r);
      },
      { key: `dm:${address}`, onStart },
    );
  }

  /** `avatar`: a picture from makeAvatar, sent encrypted with the name. */
  async createGroup(name: string, inputs: string[], onStart?: (a: Activity) => void, avatar?: string): Promise<{ group: Group; failed: string[] }> {
    const logins = [...new Set(inputs.filter((s) => s.trim()).map((s) => this.normLogin(s)))];
    const title = name.trim() || 'new group';
    return this.activities.run(
      `Creating ${title}`,
      [...(logins.length ? ['Checking usernames'] : []), ...NEW_ROOM, ...(logins.length ? [inviteLabel(logins)] : [])],
      async (t) => {
        // Side by side: each lookup is a GitHub round trip.
        const [exists] = await Promise.all([Promise.all(logins.map((l) => this.userExists(l))), logins.length ? this.ensurePublished() : undefined]);
        const missing = logins.find((_, i) => !exists[i]);
        if (missing) throw new Error(`No GitHub user named ${missing}`);
        const g = await this.chat!.createGroup('group', name.trim() || undefined, { avatar: safeAvatar(avatar) });
        t.space(g.space);
        t.link(`/c/${encodeURIComponent(g.id)}`);
        this.fill(g);
        this.bump();
        let failed: string[] = [];
        if (logins.length) {
          t.step(inviteLabel(logins));
          failed = await this.inviteNow(g, logins);
          if (failed.length) t.stepFailed(failed.join('; '));
        }
        return { group: g, failed };
      },
      { onStart },
    );
  }

  /** Invite someone to a group that already exists. */
  async invite(g: Group, input: string, onStart?: (a: Activity) => void) {
    const login = this.normLogin(input);
    await this.activities.run(`Inviting @${login}`, [`Finding @${login} on GitHub`, `Inviting @${login}`], async (t) => {
      await this.ensurePublished();
      if (!(await this.userExists(login))) throw new Error(`No GitHub user named ${login}`);
      t.step(`Inviting @${login}`);
      const [failed] = await this.inviteNow(g, [login]);
      if (failed) throw new Error(failed.replace(/^[^:]+: /, ''));
    }, { key: this.convoKey(this.record(g.id)), space: g.space, onStart });
  }

  private publishedAt = 0;
  /**
   * Invitees' apps accept a Welcome only from a device in the inviter's published directory, so
   * an invitation from a browser missing there (its identity unpublished, or this browser
   * removed) would never let them in. Fail here, where the person sees it. Checked every 10 min.
   */
  private async ensurePublished() {
    if (Date.now() - this.publishedAt < 10 * 60_000) return;
    const dir = await verifyDirectory(await this.provider.directory.read(this.address));
    const me = this.identity!;
    const listed = !!dir && dir.fingerprint === me.fingerprint && [...dir.devices.values()].some((c) => c.deviceId === me.deviceId && c.device === me.cert.device) && !dir.revoked.has(me.cert.device);
    if (!listed) {
      throw new Error(dir ? 'This browser was removed from your identity, so people you invite could not join. Set it up again from Account and devices.' : 'Your identity is not published on GitHub, so people you invite could not join. Reload the app to set it up again.');
    }
    this.publishedAt = Date.now();
  }

  /** What the invitee may read before accepting: kind, group name, how many are in it. */
  private inviteNote(g: Group): Uint8Array {
    const dm = this.records.get(g.id)?.kind === 'dm';
    const details: InviteDetails = dm
      ? { kind: 'dm' }
      : { kind: 'group', name: g.name?.slice(0, 200) || undefined, people: new Set(this.joinedMembers(g).map((m) => m.address)).size };
    return new TextEncoder().encode(JSON.stringify(details));
  }

  /** Read the note sealed for this browser, if any. */
  private async openNote(inv: PendingInvite, n: { from: string; payload?: Uint8Array }) {
    try {
      const raw = await this.chat!.openInviteNote(n);
      if (!raw) return;
      const d = JSON.parse(new TextDecoder().decode(raw)) as Partial<InviteDetails>;
      if (d.kind !== 'dm' && d.kind !== 'group') return;
      inv.details = {
        kind: d.kind,
        name: typeof d.name === 'string' && d.name.trim() ? d.name.trim().slice(0, 200) : undefined,
        people: typeof d.people === 'number' && d.people > 0 && d.people < 10_000 ? Math.floor(d.people) : undefined,
      };
      this.bump();
    } catch {
      // Unreadable notes are ignored: the card falls back to "invited you".
    }
  }

  /** Invite these people together (one commit for all of them). Returns "login: why" for each that failed. */
  private async inviteNow(g: Group, logins: string[]): Promise<string[]> {
    const results = await g.inviteMany(logins.map(toAddress), { note: this.inviteNote(g) });
    const r = this.record(g.id);
    const failed: string[] = [];
    for (const [i, res] of results.entries()) {
      const login = logins[i]!;
      if (res.error) {
        failed.push(`${login}: ${describeError(res.error)}`);
        continue;
      }
      if (!r.invited.includes(res.address)) r.invited.push(res.address);
      await this.systemNote(g.id, `Invitation sent to @${login}.`);
    }
    await this.saveRecord(r);
    this.bump();
    return failed;
  }

  async removeMember(g: Group, fp: string) {
    const who = g.members().find((m) => m.fingerprint === fp);
    const name = who ? `@${loginFrom(who.address)}` : 'them';
    const r = this.record(g.id);
    await this.activities.run(`Removing ${name}`, [`Removing ${name} from the encryption`, 'Updating the chat'], async (t) => {
      await g.remove(fp);
      if (who) r.invited = r.invited.filter((a) => a !== who.address);
      await this.saveRecord(r);
      // Their access to the repo goes with the removal, so their app can't read it there: tell it
      // through the Worker, or it could only say the chat is unavailable.
      if (who && who.address !== this.address) {
        await this.ghFetch(`${CONFIG.worker}/closures`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: loginFrom(who.address), tag: await this.removalTag(g.id) }),
        }).catch(() => undefined);
      }
      t.step('Updating the chat');
      await this.syncGroup(g);
    }, { key: this.convoKey(r), space: g.space });
  }

  /** Tag for closure notices: the members' apps can match it, the Worker can't link it to a repo. */
  private async closureTag(groupId: string) {
    return toHex(await sha256(new TextEncoder().encode(`keyhold-chat-web/v1/closure:${groupId}`))).slice(0, 32);
  }

  /** Tag for "you were removed" notices, sent the same way as closure notices. */
  private async removalTag(groupId: string) {
    return toHex(await sha256(new TextEncoder().encode(`keyhold-chat-web/v1/removal:${groupId}`))).slice(0, 32);
  }

  /**
   * Close chat (repo owner): tell the members, delete the repo, then drop this room's secrets.
   * History stays on every device until someone uses Delete chat.
   */
  async closeChat(g: Group, reason: 'closed' | 'moved' = 'closed') {
    if (!this.isOwner(g)) throw new Error('Only the person who started this chat can close it.');
    const r = this.fill(g);
    // Retiring a duplicate DM room (rule 2): only someone who joined it needs a closure notice. The
    // notice can't name the room, so an invited peer's app would also drop the invitation to the
    // room that stays, which went out at the same moment.
    const others = new Set(
      (reason === 'moved' ? g.members().filter((m) => !m.pending).map((m) => m.address) : [...g.members().map((m) => m.address), ...r.invited]).filter((a) => a !== this.address),
    );
    const tell = g.active && g.members().some((m) => m.address !== this.address);
    const plan = [...(tell ? ['Telling the members'] : []), ...(others.size ? ['Leaving closure notices'] : []), 'Deleting the repo on GitHub', 'Erasing this chat\u2019s keys'];
    await this.activities.run(reason === 'moved' ? 'Retiring the old chat' : 'Closing the chat', plan, async (t) => {
      if (tell) await g.send({ t: 'sys.close', reason }).catch((e) => this.dropUnsent(g, e));
      const tag = await this.closureTag(g.id);
      if (others.size) t.step('Leaving closure notices');
      for (const a of others) {
        t.detail(`Telling @${loginFrom(a)}'s app`);
        await this.ghFetch(`${CONFIG.worker}/closures`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: loginFrom(a), tag }),
        }).catch(() => undefined);
      }
      t.step('Deleting the repo on GitHub');
      const del = await this.ghFetch(`${CONFIG.api}/repos/${g.space}`, { method: 'DELETE', headers: { Accept: 'application/vnd.github+json' } });
      if (del.status !== 204 && del.status !== 404) throw new Error(`GitHub didn't delete the chat's repo (${del.status}). The chat is still open.`);
      t.step('Erasing this chat\u2019s keys');
      await this.endRoom(g.id, { how: reason, by: this.address, at: Date.now() });
    }, { key: this.convoKey(r), space: g.space });
  }

  /** Quit chat (not the owner): leave the group, then the repo. History stays here. */
  async quitChat(g: Group) {
    if (this.isOwner(g)) throw new Error('You started this chat, so you can close it but not quit it.');
    const r = this.fill(g);
    await this.activities.run('Leaving the chat', [...(g.active ? ['Leaving the encryption'] : []), 'Leaving the repo on GitHub', 'Erasing this chat\u2019s keys'], async (t) => {
      if (g.active) await g.leave();
      t.step('Leaving the repo on GitHub');
      // The owner's app removes our access anyway once it sees we left; this is just quicker.
      await this.ghFetch(`${CONFIG.api}/repos/${g.space}/collaborators/${encodeURIComponent(this.login)}`, { method: 'DELETE' }).catch(() => undefined);
      t.step('Erasing this chat\u2019s keys');
      await this.endRoom(g.id, { how: 'quit', by: this.address, at: Date.now() });
    }, { key: this.convoKey(r), space: g.space });
  }

  /** Mark a room ended and delete its secrets (they must not outlive the room). */
  private async endRoom(groupId: string, ended: NonNullable<ChatRecord['ended']>) {
    const r = this.record(groupId);
    if (!r.ended) {
      r.ended = ended;
      await this.saveRecord(r);
    }
    await this.chat!.groups.get(groupId)?.end();
    this.bump();
  }

  /**
   * Delete chat: erase my copy of the history, every room of the conversation. A live room stays
   * live (new messages still arrive); ended rooms go away completely, with their leftovers.
   */
  async deleteHistory(key: string) {
    const c = this.convo(key);
    if (!c) return;
    for (const r of c.rooms) {
      // Up to the newest message this browser has, by its own (sender's) time: never this
      // browser's clock, which may run ahead and would hide what arrives next.
      const newest = await this.db.lastMessage<MsgRecord>(r.groupId, () => true);
      const newestReal = await this.db.lastMessage<MsgRecord>(r.groupId, (m) => m.kind !== 'system');
      if (newest) await this.applyClear(r, newest.ts, newestReal?.id, true);
      const g = this.chat!.groups.get(r.groupId);
      if (!g || !g.active) await this.purgeRoom(r);
      await this.saveRecord(r);
    }
    this.bump();
  }

  async block(address: string) {
    const c = this.liveDm(address);
    const invs = this.pendingInvites().filter((inv) => inv.from === address && inv.status === 'invited');
    await this.activities.run(`Blocking @${loginFrom(address)}`, ['Saving the block', ...(c?.live ? ['Ending your chat'] : []), ...(invs.length ? ['Declining their invitations'] : [])], async (t) => {
      this.blocked.add(address);
      await this.db.put('kv', Date.now(), `block:${address}`);
      await this.syncBlock(address, true);
      if (c?.live) {
        t.step('Ending your chat');
        if (this.isOwner(c.live)) await this.closeChat(c.live);
        else await this.quitChat(c.live);
      }
      if (invs.length) t.step('Declining their invitations');
      for (const inv of invs) await this.declineInvite(inv.key).catch(() => undefined);
      this.bump();
    }, { anyCall: false });
  }

  async unblock(address: string) {
    this.blocked.delete(address);
    await this.db.del('kv', `block:${address}`);
    await this.syncBlock(address, false);
    this.bump();
  }

  async rename(g: Group, name: string) {
    await this.activities.run('Renaming the group', ['Saving the new name', 'Updating the chat'], async (t) => {
      await g.send({ t: 'meta', name }).catch((e) => {
        this.dropUnsent(g, e);
        throw e;
      });
      t.step('Updating the chat');
      await this.syncGroup(g);
    }, { key: this.convoKey(this.record(g.id)), space: g.space, anyCall: false });
  }

  /** Set (a data URL from makeAvatar) or remove ('') the group picture. Admins only, like the name. */
  async setAvatar(g: Group, avatar: string) {
    if (avatar && !safeAvatar(avatar)) throw new Error('This picture can\u2019t be used.');
    await this.activities.run(avatar ? 'Changing the group picture' : 'Removing the group picture', ['Saving the picture', 'Updating the chat'], async (t) => {
      await g.send({ t: 'meta', avatar }).catch((e) => {
        this.dropUnsent(g, e);
        throw e;
      });
      t.step('Updating the chat');
      await this.syncGroup(g);
    }, { key: this.convoKey(this.record(g.id)), space: g.space, anyCall: false });
  }

  // ---- messages ----

  messages(groupId: string) {
    return this.db.messages<MsgRecord>(groupId);
  }

  /** Messages from others after the newest read mark. */
  private async countUnread(r: ChatRecord) {
    const to = r.readTo ?? 0;
    return (await this.messages(r.groupId)).filter((m) => !m.mine && m.kind !== 'system' && !m.deleted && m.ts > to).length;
  }

  /** Send a text. It shows at once as "Sending…", and stays as "Not sent" with Retry if it fails. */
  async send(g: Group, body: string) {
    const item: Sending = { id: Math.random().toString(36).slice(2), body, ts: Date.now() };
    this.sending.set(g.id, [...(this.sending.get(g.id) ?? []), item]);
    this.bump();
    await this.deliver(g, item);
  }

  /** Send files in order. Each shows at once with its local preview, and stays as "not sent" with Retry if it fails. The caption goes with the first. */
  async sendFiles(g: Group, files: File[], caption?: string) {
    const big = files.find((f) => f.size > MAX_FILE_BYTES);
    if (big) throw new Error(`${big.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const items: Sending[] = files.map((file, i) => ({ id: Math.random().toString(36).slice(2), ts: Date.now(), file, caption: i === 0 ? caption : undefined, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }));
    this.sending.set(g.id, [...(this.sending.get(g.id) ?? []), ...items]);
    this.bump();
    for (const item of items) await this.deliver(g, item);
  }

  async retrySend(g: Group, id: string) {
    const item = this.sending.get(g.id)?.find((p) => p.id === id);
    if (!item || !item.failed) return;
    item.failed = undefined;
    this.bump();
    await this.deliver(g, item);
  }

  /** Remove: the bubble goes, and keyhold stops trying to send the saved message. */
  discardSend(groupId: string, id: string) {
    const item = this.sending.get(groupId)?.find((p) => p.id === id);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    this.sending.set(groupId, (this.sending.get(groupId) ?? []).filter((p) => p.id !== id));
    // Not once it is sent: then there is nothing left to stop.
    if (item?.msgId && !item.sentId) void this.chat?.groups.get(groupId)?.discardUnsent(item.msgId).catch(() => undefined);
    this.bump();
  }

  private async deliver(g: Group, item: Sending) {
    let sent: { id: string };
    try {
      if (item.msgId) {
        // Retry: the same encrypted message (and mail id) again. Nothing to post means a copy
        // landed after all (its reply was lost), and the chat has it now.
        await g.resend(item.msgId);
        sent = { id: item.msgId };
      } else if (item.file) {
        const data = new Uint8Array(await item.file.arrayBuffer());
        sent = await g.sendAttachment(data, { name: item.file.name, mime: item.file.type || undefined, caption: item.caption });
      } else sent = await g.send({ t: 'text', body: item.body ?? '' });
    } catch (e) {
      this.claimUnsent(g, item, e);
      await this.syncGroup(g).catch(() => undefined);
      if (item.sentId) return; // the sync found it landed
      item.failed = this.isUnreachable(g) ? "Can't reach this chat right now. Try again in a moment." : !g.active ? 'This chat has ended' : this.noteError(e);
      this.bump();
      return;
    }
    this.markSent(g.id, item, sent.id);
    // No sync right behind the send: the next message typed would wait for it (three requests in
    // a row). The chat's regular check follows in a few seconds, and sees our write as a change.
    this.lastCheck.set(g.id, Date.now());
  }

  /** The real message is stored by now; the screen drops this bubble as soon as it shows that one. */
  private markSent(groupId: string, item: Sending, id: string) {
    if (item.sentId) return;
    item.sentId = id;
    item.failed = undefined;
    this.bump();
    setTimeout(() => this.discardSend(groupId, item.id), SETTLE_MS);
  }

  /** A failed send: which saved, encrypted message is this bubble's (a burst fails together). */
  private claimUnsent(g: Group, item: Sending, e: unknown) {
    if (item.msgId) return;
    const taken = new Set((this.sending.get(g.id) ?? []).map((p) => p.msgId));
    const m = (unsentMessages(e) ?? []).find((u) => !taken.has(u.id) && sameContent(item, u));
    if (m) item.msgId = m.id;
  }

  /**
   * A send the person didn't see as a bubble (a reaction, a delete, a name, a moved copy) failed:
   * keyhold keeps it to send again, but the app sends anew when asked, so drop the saved copy.
   */
  private dropUnsent(g: Group, e: unknown) {
    for (const m of unsentMessages(e) ?? []) if (!isBubble(m)) void g.discardUnsent(m.id).catch(() => undefined);
  }

  /**
   * After a reload: messages keyhold saved but couldn't post show as "Not sent" with Retry and
   * Remove. Other kinds the app sends again itself when needed.
   */
  private async restoreUnsent(g: Group) {
    for (const m of g.unsent()) {
      if (!isBubble(m)) {
        await g.discardUnsent(m.id).catch(() => undefined);
        continue;
      }
      const list = this.sending.get(g.id) ?? [];
      if (list.some((p) => p.msgId === m.id)) continue;
      const item: Sending = { id: `unsent-${m.id}`, msgId: m.id, ts: m.ts, failed: 'Not sent' };
      if (m.t === 'text') item.body = m.body;
      else if (m.t === 'attachment') {
        item.file = new File([], m.file.name ?? 'file', { type: m.file.mime ?? '' });
        item.size = m.file.size;
        item.caption = m.caption;
      }
      this.sending.set(g.id, [...list, item]);
    }
  }

  /** Add or take back my reaction. Shows at once; on failure it goes back and the error is thrown. */
  async react(g: Group, ref: string, emoji: string, add: boolean) {
    const key = `${g.id}/${ref}/${emoji}`;
    const cur = this.reacting.get(key);
    if (cur && !cur.sent) return; // still sending the last tap
    const entry: Reacting = { add };
    this.reacting.set(key, entry);
    this.bump();
    try {
      // Explicit on/off: two of my browsers adding the same reaction must not cancel out. Older
      // apps ignore `on` and toggle, as they always did.
      await g.send({ t: 'react', ref, emoji, on: add } as AppContent);
    } catch (e) {
      this.dropUnsent(g, e);
      this.reacting.delete(key);
      this.bump();
      throw new Error(`Reaction not sent. Try again in a moment.`, { cause: e });
    }
    entry.sent = true;
    this.bump();
    setTimeout(() => {
      if (this.reacting.get(key) === entry) {
        this.reacting.delete(key);
        this.bump();
      }
    }, SETTLE_MS);
  }

  /** Reactions on one message, with mine that are still on their way applied. */
  shownReactions(m: MsgRecord): { emoji: string; who: string[]; pending: boolean }[] {
    const out = Object.entries(m.reactions ?? {}).map(([emoji, who]) => ({ emoji, who, pending: false }));
    const prefix = `${m.groupId}/${m.id}/`;
    for (const [k, r] of this.reacting) {
      if (!k.startsWith(prefix)) continue;
      const emoji = k.slice(prefix.length);
      let row = out.find((x) => x.emoji === emoji);
      if (!row) out.push((row = { emoji, who: [], pending: false }));
      const others = row.who.filter((a) => a !== this.address);
      row.who = r.add ? [...others, this.address] : others;
      row.pending = !r.sent;
    }
    return out.filter((x) => x.who.length > 0 || x.pending);
  }

  async deleteMessage(g: Group, ref: string) {
    const key = `${g.id}/${ref}`;
    this.deleting.add(key);
    this.bump();
    try {
      await g.send({ t: 'delete', ref });
    } catch (e) {
      this.dropUnsent(g, e);
      this.deleting.delete(key);
      this.bump();
      throw new Error(`Message not deleted. Try again in a moment.`, { cause: e });
    }
    setTimeout(() => {
      this.deleting.delete(key);
      this.bump();
    }, SETTLE_MS);
  }

  /** Run a slow chat-wide action; the chat shows `label` and takes no other action until it ends. */
  async chatAction<T>(key: string, label: string, fn: () => Promise<T>): Promise<T> {
    if (this.chatBusy.has(key)) throw new Error('Still working on the last change. Please wait.');
    this.chatBusy.set(key, label);
    this.bump();
    try {
      return await fn();
    } finally {
      this.chatBusy.delete(key);
      this.bump();
    }
  }

  /** Download and decrypt an attachment once per tab; later views reuse it. */
  fetchFile(g: Group, file: AttachmentRef): Promise<Blob> {
    let p = this.files.get(file.ref);
    if (!p) {
      p = g.fetchAttachment(file).then((data) => new Blob([data as Uint8Array<ArrayBuffer>], { type: servedType(file.mime) }));
      p.catch(() => this.files.delete(file.ref));
      this.files.set(file.ref, p);
    }
    return p;
  }

  private async put(m: MsgRecord) {
    await this.db.put('messages', m);
  }

  private async systemNote(groupId: string, body: string) {
    const ts = Date.now();
    await this.put({ groupId, id: `sys-${ts}-${Math.random().toString(36).slice(2, 8)}`, ts, from: '', fromFp: '', mine: false, kind: 'system', body });
  }

  /** A message changed after it arrived: if the chat list shows it, show what it is now. */
  private async refreshPreview(r: ChatRecord, changed: MsgRecord) {
    if (changed.ts < r.lastTs) return;
    const text = previewText(changed);
    if (r.lastText === text) return;
    r.lastText = text;
    await this.saveRecord(r);
  }

  private async onMessage(g: Group, m: ReceivedMessage) {
    const msg = m.message;
    const mine = m.from.fingerprint === this.identity?.fingerprint;
    const base = { groupId: g.id, id: msg.id, ts: msg.ts, from: m.from.address, fromFp: m.from.fingerprint, fromDevice: m.from.deviceId, mine };
    const r = this.fill(g);
    if (mine) {
      // A message of ours that a send or Retry left "Not sent" landed after all.
      const pending = this.sending.get(g.id)?.find((p) => p.msgId === msg.id);
      if (pending) this.markSent(g.id, pending, msg.id);
    }
    if (msg.t === 'sys.close') {
      // Only the repo owner can end the room, under the key this account trusts for them: a
      // member's device that only claims the owner's address can't.
      const owner = toAddress(g.space.split('/')[0]!.toLowerCase());
      if (!mine && m.from.address === owner && m.from.fingerprint === (await this.trustedKey(owner))) {
        this.toEnd.set(g.id, { how: msg.reason === 'moved' ? 'moved' : 'closed', by: owner, at: msg.ts });
      }
      return;
    }
    if (r.purged) return;
    // Another browser deleted the chat and this one is still catching up to what that one had.
    if (r.dropTo !== undefined && msg.ts <= r.dropTo) {
      if (msg.id === r.dropUntil) {
        r.dropTo = undefined;
        r.dropUntil = undefined;
        await this.saveRecord(r);
      }
      return;
    }
    const touch = async (preview: string) => {
      r.lastTs = Math.max(r.lastTs, msg.ts);
      r.lastText = preview;
      if (!mine && !this.onScreen(g.id) && msg.ts > (r.readTo ?? 0)) r.unread++;
      await this.saveRecord(r);
    };
    // Delivery is at least once: a message already stored (maybe edited or reacted to since) stays as it is.
    if ((msg.t === 'text' || msg.t === 'attachment') && (await this.db.get('messages', [g.id, msg.id]))) return;
    switch (msg.t) {
      case 'text': {
        // A copy of a message from a retired duplicate room (rule 2): shown only if not here already.
        const moved = (msg as { moved?: unknown }).moved;
        if (typeof moved === 'string' && (await this.inConvo(r, moved))) break;
        await this.put({ ...base, kind: 'text', body: msg.body, reply: msg.reply, ...(typeof moved === 'string' ? { movedFrom: moved } : {}) });
        await touch(msg.body);
        break;
      }
      case 'attachment': {
        // Our own upload: keep the local copy so the picture shows without downloading it again.
        const local = mine ? this.sending.get(g.id)?.find((p) => p.file && p.file.name === msg.file.name && p.file.size === msg.file.size) : undefined;
        if (local?.file && !this.files.has(msg.file.ref)) this.files.set(msg.file.ref, Promise.resolve(local.file));
        await this.put({ ...base, kind: 'attachment', file: msg.file, caption: msg.caption });
        await touch(previewText({ ...base, kind: 'attachment', file: msg.file, caption: msg.caption }));
        break;
      }
      case 'edit': {
        const cur = await this.db.get<MsgRecord>('messages', [g.id, msg.ref]);
        if (cur && cur.fromFp === m.from.fingerprint && !cur.deleted) {
          const now: MsgRecord = { ...cur, body: msg.body, edited: true };
          await this.put(now);
          await this.refreshPreview(r, now);
        }
        break;
      }
      case 'delete': {
        const cur = await this.db.get<MsgRecord>('messages', [g.id, msg.ref]);
        if (cur && cur.fromFp === m.from.fingerprint) {
          const gone: MsgRecord = { ...cur, deleted: true, body: undefined, file: undefined, caption: undefined };
          await this.put(gone);
          await this.refreshPreview(r, gone);
        }
        break;
      }
      case 'react': {
        const cur = await this.db.get<MsgRecord>('messages', [g.id, msg.ref]);
        // A toggle: if the same reaction message were applied twice it would cancel itself.
        if (cur && !cur.rxIds?.includes(msg.id)) {
          const rx = { ...(cur.reactions ?? {}) };
          const who = new Set(rx[msg.emoji] ?? []);
          const on = (msg as { on?: unknown }).on;
          // New apps say on or off; older ones send a toggle.
          if (on === true) who.add(m.from.address);
          else if (on === false) who.delete(m.from.address);
          else if (who.has(m.from.address)) who.delete(m.from.address);
          else who.add(m.from.address);
          rx[msg.emoji] = [...who];
          if (!rx[msg.emoji]!.length) delete rx[msg.emoji];
          await this.put({ ...cur, reactions: rx, rxIds: [...(cur.rxIds ?? []), msg.id].slice(-200) });
        }
        break;
      }
      case 'meta': {
        // keyhold takes names and pictures only from admins; the notes follow the same rule.
        if (!g.policy.admins.includes(m.from.fingerprint)) break;
        const who = mine ? 'You' : `@${loginFrom(m.from.address)}`;
        if (typeof msg.avatar === 'string' && (msg.avatar ? safeAvatar(msg.avatar) : true) && msg.avatar !== r.avatar) {
          r.avatar = msg.avatar;
          await this.saveRecord(r);
          // Only a picture-only message is someone changing it; with a name it is the group being
          // made, or an admin repeating both for someone who just joined.
          if (msg.name === undefined) await this.put({ ...base, id: `pic-${msg.id}`, kind: 'system', body: msg.avatar ? `${who} changed the group picture` : `${who} removed the group picture` });
        }
        if (msg.name && msg.name !== r.lastName) {
          r.lastName = msg.name;
          await this.saveRecord(r);
          await this.put({ ...base, id: `meta-${msg.id}`, kind: 'system', body: mine ? `You named the group “${msg.name}”` : `@${loginFrom(m.from.address)} named the group “${msg.name}”` });
        }
        break;
      }
      default:
        break;
    }
    this.bump();
  }

  /** Is this message (or a copy of it) already in any room of r's conversation? */
  private async inConvo(r: ChatRecord, id: string) {
    const key = this.convoKey(r);
    for (const room of this.records.values()) {
      if (this.convoKey(room) !== key) continue;
      if (await this.db.get('messages', [room.groupId, id])) return true;
      if ((await this.messages(room.groupId)).some((x) => x.movedFrom === id)) return true;
    }
    return false;
  }

  private async onEvents(g: Group, events: GroupEvent[]) {
    // New members (and new devices) can't read anything sent before they joined, so an admin
    // repeats the group name whenever the number of devices in the group goes up.
    const r = this.record(g.id);
    const devices = g.members().reduce((n, m) => n + m.devices.length, 0);
    const shareName = devices > (r.deviceCount ?? 1);
    if (devices !== r.deviceCount) {
      r.deviceCount = devices;
      await this.saveRecord(r);
    }
    for (const e of events) {
      const who = 'address' in e ? `@${loginFrom(e.address)}` : '';
      if (e.type === 'joined') {
        await this.systemNote(g.id, e.address === this.address ? 'You joined. Messages are end-to-end encrypted.' : `${who} joined`);
        this.peers.delete(e.address);
      } else if (e.type === 'left' && e.pending) {
        await this.systemNote(g.id, `${who} didn’t join`);
      } else if (e.type === 'left') {
        // Removed by an admin (maybe us), or left on their own.
        await this.systemNote(g.id, !e.by ? `${who} left` : e.by.address === this.address ? `You removed ${who}` : `@${loginFrom(e.by.address)} removed ${who}`);
        if (this.isDm(g) && e.address !== this.address && !g.members().some((m) => m.address !== this.address)) {
          r.peerLeft = true;
          await this.saveRecord(r);
        }
      } else if (e.type === 'retracted') {
        // Sent to us after we were already removed (the sender hadn't synced yet): not ours to keep.
        for (const id of e.ids) await this.db.del('messages', [g.id, id]);
        const last = await this.db.lastMessage<MsgRecord>(g.id, (x) => x.kind !== 'system');
        r.lastText = last ? previewText(last) : '';
        await this.saveRecord(r);
      } else if (e.type === 'removed') this.toEnd.set(g.id, { how: 'removed', ...(e.by ? { by: e.by.address } : {}), at: Date.now() });
      else if (e.type === 'access-lost') {
        // Our own repo gone means we closed it (on another device, or on github.com). Someone
        // else's is only unavailable: it may come back, so nothing is deleted and it is retried.
        if (this.isOwner(g) && (await this.ghFetch(`${CONFIG.api}/repos/${g.space}`)).status === 404) {
          this.toEnd.set(g.id, { how: 'closed', by: this.address, at: Date.now() });
        }
      }
      // keyhold opened it, but this browser couldn't keep it (storage full for too long): not a decryption problem.
      else if (e.type === 'undecryptable' && e.reason === 'the app did not take it') await this.systemNote(g.id, 'A message could not be saved in this browser (storage full).');
      else if (e.type === 'undecryptable') await this.systemNote(g.id, 'A message could not be decrypted.');
      // A message the sender's app counted out never arrived (dropped on GitHub, or not posted).
      else if (e.type === 'gap') await this.systemNote(g.id, `A message from @${loginFrom(e.from.address)} may be missing.`);
      // A commit everyone ignores: nothing the people in the chat can act on.
      else if (e.type === 'rejected') console.warn(`chat ${g.id}: ignored group change ${e.index} (${e.reason})`);
    }
    // The picture goes with it (inside the same encrypted message: no extra request).
    const avatar = safeAvatar(g.avatar);
    if (shareName && g.active && !this.isDm(g) && (g.name || avatar) && g.policy.admins.includes(this.identity!.fingerprint)) {
      await g.send({ t: 'meta', name: g.name || undefined, avatar }).catch((e) => this.dropUnsent(g, e));
    }
  }

  async syncGroup(g: Group) {
    try {
      const r = await g.sync();
      await this.onEvents(g, r.events);
      // Saving new messages here failed (IndexedDB full?): keyhold keeps them and hands them over again.
      const stuck = r.events.find((e) => e.type === 'delivery-failed');
      if (stuck) this.setGroupError(g.id, `New messages couldn't be saved in this browser (${stuck.waiting} waiting). Free up some storage space; nothing is lost.`);
      else this.clearGroupError(g.id);
    } catch (e) {
      this.setGroupError(g.id, this.noteError(e));
    }
    // Refused by GitHub (maybe only for a moment): try again later, less and less often. Only a
    // signed close or a removal we can read ends the room; until then it is "can't reach".
    if (this.isUnreachable(g)) {
      if (!this.lost.has(g.id)) this.lost.set(g.id, { next: Date.now() + LOST_RETRY_MS, delay: LOST_RETRY_MS, since: Date.now() });
    } else this.lost.delete(g.id);
    const end = this.toEnd.get(g.id);
    if (end) {
      this.toEnd.delete(g.id);
      await this.endRoom(g.id, end);
    }
    this.bump();
  }

  /**
   * Collect invitations: inbox notices (GitHub invitations not accepted yet) and repos of other
   * people we can already open. Both wait for the user to accept. Our own repos (another of our
   * devices made the chat) are joined right away. Then join the accepted ones.
   */
  async checkInvites(force = false): Promise<void> {
    // Collecting runs one at a time (Accept and the regular check overlapping would see the same
    // invitations twice). The joins run outside that queue, so Accept doesn't wait behind a new
    // browser catching up on other chats: each invitation is joined by one caller only (busy).
    const run = this.invitesQueue.then(() => this.collectInvites(force));
    this.invitesQueue = run.then(() => undefined, () => undefined);
    await this.joinDue(await run);
  }
  private invitesQueue: Promise<void> = Promise.resolve();

  /** Collect and join, for callers that already hold the queue. */
  private async checkInvitesNow(force: boolean) {
    await this.joinDue(await this.collectInvites(force));
  }

  /** Join these invitations, a few at a time, skipping any another caller has taken meanwhile. */
  private async joinDue(due: { inv: PendingInvite; attempts: number }[]) {
    if (!due.length) return;
    // Several chats at once: a new browser catching up on all of the account's chats did them one
    // after another, minutes each on a phone. Each join is for its own repo and group.
    await inParallel(due, async ({ inv, attempts }) => {
      if (inv.busy || inv.attempts !== attempts || this.invites.get(inv.key) !== inv) return;
      inv.busy = true;
      try {
        await this.joinOne(inv);
      } finally {
        inv.busy = false;
      }
    }, JOINS_AT_ONCE);
    this.bump();
  }

  private async collectInvites(force: boolean): Promise<{ inv: PendingInvite; attempts: number }[]> {
    const p = this.provider;
    const chat = this.chat!;
    const now = Date.now();
    const known = () => new Set([...chat.groups.values()].map((g) => g.space));
    let notices: Awaited<ReturnType<typeof p.inviteInbox.list>> = [];
    const live = this.inbox?.live ? this.inbox : undefined;
    if (live) {
      notices = [...live.invites.values()]
        .map((i) => ({ id: String(i.id), from: toAddress(i.from), pointer: String(i.id), expiresAt: Date.parse(i.expires_at), payload: i.note ? fromB64(i.note) : undefined }))
        .filter((n) => n.expiresAt > now);
    } else {
      try {
        notices = await p.inviteInbox.list();
      } catch (e) {
        this.lastPollError = this.noteError(e);
      }
    }
    let have = known();
    // The inbox names who invited us but not the repo (the Worker keeps no repo names), so a
    // notice stands alone until it is accepted and the repo becomes visible.
    for (const n of notices) {
      const key = `notice:${n.id}`;
      if (this.invites.has(key)) continue;
      const created = n.expiresAt ? n.expiresAt - 7 * 24 * 3600_000 : now;
      const inv: PendingInvite = { key, from: n.from, status: 'invited', pointer: n.pointer, noticeId: n.id, since: now, created, attempts: 0, nextTry: 0 };
      this.invites.set(key, inv);
      if (n.payload) void this.openNote(inv, n);
    }
    for (const inv of [...this.invites.values()]) {
      if (inv.status !== 'invited') continue;
      // Another of our browsers joined this chat, and its synced chat list only arrived after the
      // repo scan saw the invitation: nobody needs to accept it here, just catch up.
      if (inv.space && [...this.records.values()].some((r) => r.space === inv.space && !r.ended && !r.purged)) {
        inv.status = 'joining';
        inv.mine = true;
        continue;
      }
      // Blocked people's invitations are turned down without asking.
      if (this.blocked.has(inv.from)) {
        await this.declineInvite(inv.key).catch(() => undefined);
        continue;
      }
      // Both of us started a DM at once (case 25): I asked to chat with them, so take theirs too.
      // Rule 2 then keeps one of the two rooms.
      if (!inv.space && this.ownPendingDm(inv.from)) await this.acceptInvite(inv.key, true).catch(() => undefined);
    }
    // Listing every repo the app can see costs a few requests: do it when asked, while something
    // is pending, or once a minute.
    const scanEvery = this.invites.size ? SPACE_SCAN_PENDING_MS : SPACE_SCAN_MS;
    if (force || now - this.lastSpaceScan >= scanEvery) {
      this.lastSpaceScan = now;
      have = known();
      // Rooms that ended for us (quit, removed, declined, deleted): not offered again by themselves,
      // but an invitation accepted since can be for one of them (invited back).
      const retired: string[] = [];
      // Chats this browser started that stopped part way (the tab closed, GitHub failed): finish them.
      for (const g of await chat.finishCreates().catch(() => [] as Group[])) await this.finishedCreate(g);
      for (const space of await p.channel.listSpaces()) {
        const liveRec = [...this.records.values()].some((r) => r.space === space && !r.ended && !r.purged);
        const g = [...chat.groups.values()].find((x) => x.space === space);
        // Our own repo that no chat here knows: being made here, a chat to catch up on, or left empty.
        if (!g && space.split('/')[0]!.toLowerCase() === this.login && ![...this.records.values()].some((r) => r.space === space) && !(await this.ownRepoInUse(space))) {
          const inv = this.invites.get(space);
          if (inv && inv.status !== 'invited' && !inv.busy) this.invites.delete(space);
          continue;
        }
        if (this.invites.has(space)) continue;
        if (g && !this.isUnreachable(g)) continue;
        if (g || (this.declined.has(space) && !liveRec) || [...this.records.values()].some((r) => r.space === space && r.ended)) {
          retired.push(space);
          continue;
        }
        const owner = space.split('/')[0]!.toLowerCase();
        const from = toAddress(owner);
        if (this.blocked.has(from)) continue;
        // Accepted here: an accepted notice from the same person is this repo. Our own repo means
        // another of our devices made the chat. Anything else was accepted outside this app
        // (on github.com), so it still waits for Accept here.
        // Also a chat another of our browsers already joined (from the synced chat list).
        const mine = owner === this.login.toLowerCase() || [...this.records.values()].some((r) => r.space === space && !r.ended && !r.purged);
        let accepted = mine;
        let details: PendingInvite['details'];
        for (const [k, v] of this.invites) {
          if (k.startsWith('notice:') && v.status !== 'invited' && v.from === from) {
            this.invites.delete(k);
            this.activities.rekey(k, space);
            details = v.details;
            accepted = true;
            break;
          }
        }
        this.invites.set(space, { key: space, space, from, status: accepted ? 'joining' : 'invited', since: now, attempts: 0, nextTry: 0, mine, details });
      }
      // Invited back: an invitation the person accepted that matched no other repo of that person
      // is for the room they had left. Only the accepted invitation brings it back, never the listing.
      for (const space of retired) {
        const from = toAddress(space.split('/')[0]!.toLowerCase());
        if (this.blocked.has(from)) continue;
        const n = [...this.invites].find(([k, v]) => k.startsWith('notice:') && v.status !== 'invited' && v.from === from);
        if (!n) continue;
        this.invites.delete(n[0]);
        this.activities.rekey(n[0], space);
        this.invites.set(space, { key: space, space, from, status: 'joining', since: now, attempts: 0, nextTry: 0, details: n[1].details, rejoin: true });
      }
      // Accepted notices whose repo never showed up go away after a few minutes.
      for (const [k, v] of this.invites) if (k.startsWith('notice:') && v.status !== 'invited' && now - v.since > 5 * 60_000) this.invites.delete(k);
    }
    // A room GitHub refused us doesn't count as joined: being invited back is how access returns.
    have = new Set([...chat.groups.values()].filter((g) => g.active).map((g) => g.space));
    const due: { inv: PendingInvite; attempts: number }[] = [];
    for (const inv of [...this.invites.values()]) {
      if (inv.busy) continue; // being joined by another caller
      if (inv.space && have.has(inv.space)) {
        this.invites.delete(inv.key);
        continue;
      }
      if (!inv.space || inv.dismissed || inv.status === 'invited') continue;
      if (!force && now < inv.nextTry) continue;
      due.push({ inv, attempts: inv.attempts });
    }
    return due;
  }

  /** Join the chat of one accepted invitation (or one the account is already in). */
  private async joinOne(inv: PendingInvite) {
    const chat = this.chat!;
    const space = inv.space;
    if (!space) return;
    inv.status = 'joining';
    this.activities.stepFor(inv.key, JOIN_UNLOCK, space);
    this.bump();
    try {
      const g = await chat.join(space);
      if (g) {
        const r = this.fill(g); // while the invitation (and its note) is still known
        this.invites.delete(inv.key);
        if (r.ended || r.purged || inv.rejoin) {
          // Invited back: this join is newer than the end, on every browser of the account.
          r.ended = undefined;
          r.purged = undefined;
          r.rejoinedAt = Date.now();
          this.lost.delete(g.id);
          await this.saveRecord(r);
        }
        this.activities.stepFor(inv.key, JOIN_LOAD);
        const a = this.activities.forKey(inv.key);
        if (a && !a.ended) a.link = `/c/${encodeURIComponent(this.convoKey(r))}`;
        // Catching up on a chat the account was already in: its history stays in the other browsers.
        // "Already" means it existed before this browser was added, not some fixed age.
        // The chat's age comes from the synced chat list: on a new browser, wait for its first read
        // (a join can finish first, and the record then only knows "now").
        if (inv.mine && !r.joinedAt) await this.syncStarting;
        if (inv.mine && !r.joinedAt && r.createdAt < (this.identity?.cert.issuedAt ?? Date.now())) {
          r.joinedAt = Date.now();
          await this.saveRecord(r);
        }
        await this.syncGroup(g);
        this.bump();
        return;
      }
      // No ticket for our identity yet: we asked the inviter's app for one. It answers the
      // next time it syncs, so try again soon, then back off.
      inv.status = 'waiting';
      inv.error = undefined;
    } catch (e) {
      inv.status = 'error';
      inv.error = describeError(e);
    }
    inv.attempts++;
    inv.nextTry = Date.now() + Math.min(INVITE_RETRY_MS * 2 ** Math.min(inv.attempts - 1, 5), INVITE_RETRY_MAX_MS);
    this.bump();
  }

  /**
   * One of our repos no chat here knows: is it a chat (catch up on it), or is it a creation still
   * running here or left empty? An empty one is deleted after ORPHAN_MS, counted from when this
   * browser first saw it empty, so older leftovers go too.
   */
  private async ownRepoInUse(space: string): Promise<boolean> {
    let state: Awaited<ReturnType<Chat['inspectSpace']>>;
    try {
      state = await this.chat!.inspectSpace(space);
    } catch {
      return true; // can't tell now: treat it as before
    }
    const key = `orphan:${space}`;
    if (state === 'chat') {
      await this.db.del('kv', key);
      return true;
    }
    if (state === 'creating') return false;
    const since = await this.db.get<number>('kv', key);
    if (since === undefined) {
      await this.db.put('kv', Date.now(), key);
      return false;
    }
    if (Date.now() - since < ORPHAN_MS) return false;
    const r = await this.ghFetch(`${CONFIG.api}/repos/${space}`, { method: 'DELETE', headers: { Accept: 'application/vnd.github+json' } });
    if (r.status === 204 || r.status === 404) await this.db.del('kv', key);
    return false;
  }

  /** A creation finished by keyhold after it had stopped part way. */
  private async finishedCreate(g: Group) {
    const r = this.fill(g);
    // A DM whose invitation never went out has nobody to talk to: retire it quietly.
    if (this.isDm(g) && !r.invited.length && !g.members().some((m) => m.address !== this.address)) {
      await this.closeChat(g).catch(() => undefined);
      r.hidden = true;
      await this.saveRecord(r);
      return;
    }
    await this.syncGroup(g);
  }

  /** I invited them to a DM and they haven't joined yet. */
  private ownPendingDm(address: string) {
    return this.conversations().some((c) => c.dm && c.peer === address && c.live && this.isOwner(c.live) && !c.live.members().some((m) => m.address === address && !m.pending));
  }

  /** The user accepted: accept the GitHub invitation, then join the chat. */
  async acceptInvite(key: string, auto = false) {
    const inv = this.invites.get(key);
    if (!inv || inv.status !== 'invited') return;
    const p = this.provider;
    const from = loginFrom(inv.from);
    const plan = [...(inv.pointer ? ['Accepting the GitHub invitation', 'Finding the chat'] : []), JOIN_UNLOCK, JOIN_LOAD];
    const what = inv.details?.kind === 'group' ? (inv.details.name ? `Joining ${inv.details.name}` : 'Joining the group') : `Joining the chat with @${from}`;
    await this.activities.run(what, plan, async (t) => {
      let gone = false;
      if (inv.pointer) {
        const id = inv.pointer.split('#').pop()!;
        const r = await this.ghFetch(`${CONFIG.api}/user/repository_invitations/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Accept: 'application/vnd.github+json' } });
        // 404/410: withdrawn (the chat was closed), expired, or already accepted on another device.
        if (r.status === 404 || r.status === 410) gone = true;
        else if (r.status !== 204) throw new Error(`GitHub didn't accept the invitation (${r.status}).`);
        t.step('Finding the chat');
      }
      if (inv.noticeId) await p.inviteInbox.delete(inv.noticeId).catch(() => {});
      Object.assign(inv, { status: 'joining', pointer: undefined, noticeId: undefined, nextTry: 0, attempts: 0, since: Date.now(), gone });
      this.bump();
      // auto: called from inside the invite check, which already holds its queue.
      await (auto ? this.checkInvitesNow(true) : this.checkInvites(true));
      // Already accepted elsewhere shows up as a repo in that scan; if nothing did, it's gone.
      const still = [...this.invites.values()].find((i) => i === inv || (inv.space && i.key === inv.space)) ?? this.invites.get(key);
      // Taken by the app itself (both started a DM at once) and already retired, or a duplicate
      // room retired while another invitation from them waits (rule 2): nothing to say.
      const another = [...this.invites.values()].some((i) => i !== still && i.from === inv.from && i.status === 'invited') || (inv.details?.kind === 'dm' && !!this.liveDm(inv.from));
      if (still && gone && (auto || another)) this.invites.delete(still.key);
      else if (still && gone) {
        Object.assign(still, { status: 'error', error: `@${from} withdrew this invitation or closed the chat.` });
        throw new Error(still.error);
      } else if (still?.status === 'waiting') t.wait(`Waiting for @${from}'s app to let you in`);
      else if (still?.status === 'error') throw new Error(still.error ?? 'Could not join yet');
      this.bump();
    }, { key, modal: !auto });
  }

  /** The user declined: turn down the GitHub invitation (or leave the repo) and forget the chat. */
  async declineInvite(key: string) {
    const inv = this.invites.get(key);
    if (!inv) return;
    const p = this.provider;
    if (inv.pointer) {
      const id = inv.pointer.split('#').pop()!;
      // The app's user token may not be allowed to decline; then the invitation simply expires
      // on GitHub after 7 days, and nothing joins since it was never accepted.
      const r = await this.ghFetch(`${CONFIG.api}/user/repository_invitations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (![204, 404, 410, 403].includes(r.status)) throw new Error(`Couldn't decline the invitation on GitHub (${r.status}).`);
    } else if (inv.space) {
      // Already a collaborator (accepted on github.com): try to leave the repo. GitHub may not let
      // the app do that, so the chat is hidden here either way.
      await this.ghFetch(`${CONFIG.api}/repos/${inv.space}/collaborators/${encodeURIComponent(this.login)}`, { method: 'DELETE' }).catch(() => {});
    }
    if (inv.noticeId) await p.inviteInbox.delete(inv.noticeId).catch(() => {});
    if (inv.space) {
      this.declined.add(inv.space);
      await this.db.put('kv', Date.now(), `declined:${inv.space}`);
      await this.syncDeclined(inv.space);
    }
    this.invites.delete(key);
    this.bump();
  }

  /** What this browser knows of a chat by its repo, e.g. from another browser's synced chat list. */
  chatBySpace(space: string): ChatRecord | undefined {
    return [...this.records.values()].find((r) => r.space === space && !r.purged);
  }

  /** Invitations that haven't turned into a chat yet, for the sidebar. */
  pendingInvites(): PendingInvite[] {
    return [...this.invites.values()].filter((i) => !i.dismissed).sort((a, b) => b.since - a.since);
  }

  async retryInvite(key: string) {
    const inv = this.invites.get(key);
    if (inv) inv.nextTry = 0;
    await this.checkInvites(true);
  }

  dismissInvite(key: string) {
    const inv = this.invites.get(key);
    if (inv) inv.dismissed = true;
    this.bump();
  }

  // ---- polling ----

  setActive(key: string | undefined) {
    this.activeConvo = key;
    const c = key ? this.convo(key) : undefined;
    if (c) {
      for (const r of c.rooms) {
        r.readTo = Math.max(r.readTo ?? 0, r.lastTs);
        if (r.unread) {
          r.unread = 0;
          void this.saveRecord(r);
        }
        this.lastCheck.delete(r.groupId);
      }
      this.kick?.();
      this.openKick?.();
    }
    this.bump();
  }

  /** Has anything been written to this chat's repo since we last looked? 304s are free. */
  private async headChanged(space: string): Promise<boolean> {
    const etag = this.etags.get(space);
    const r = await this.ghFetch(`${CONFIG.api}/repos/${space}/commits?per_page=1`, {
      headers: { Accept: 'application/vnd.github+json', ...(etag ? { 'If-None-Match': etag } : {}) },
    });
    if (r.status === 304) return false;
    if (r.status === 200) {
      const e = r.headers.get('etag');
      if (e) this.etags.set(space, e);
    }
    return true;
  }

  /**
   * Run every check now instead of when its timer comes due, and resolve once that full sync step
   * has finished. The schedule is untouched otherwise.
   */
  async syncNow(opts: { listInFull?: boolean } = {}): Promise<void> {
    if (this.stopped || !this.chat) return;
    await this.syncStarting;
    if (this.stopped) return;
    this.lastInvites = 0;
    this.lastClosures = 0;
    this.lastPull = 0;
    this.lastFullPull = 0;
    this.lastFlush = 0;
    this.lastCheck.clear();
    // listInFull: false runs only the change checks, as most timed steps do (tests use it to see
    // what the app does between its full listings).
    if (opts.listInFull !== false) this.lastFullSync.clear();
    this.lastSpaceScan = 0;
    for (const inv of this.invites.values()) inv.nextTry = 0;
    for (const l of this.lost.values()) l.next = 0;
    // Asked for now: a rate-limit pause only holds back the timed steps.
    this.rateLimitedUntil = 0;
    return new Promise<void>((resolve) => {
      this.afterTick.push(resolve);
      this.kick?.();
    });
  }

  private loopRun = 0;
  private async loop() {
    // A chat reopened after a stop (install came back) starts a new loop; an older one ends.
    const run = ++this.loopRun;
    void this.openChatLoop(run);
    while (!this.stopped && run === this.loopRun) {
      const waiting = this.afterTick.splice(0);
      try {
        await this.tick();
        this.lastPollError = undefined;
      } catch (e) {
        this.lastPollError = this.noteError(e);
        this.bump();
      }
      for (const done of waiting) done();
      // Someone asked for another step while this one ran: run it now, don't wait for the timer.
      if (this.afterTick.length) continue;
      await new Promise<void>((resolve) => {
        if (this.stopped) return resolve(); // stopped during the step: end now, not after the timer
        const t = setTimeout(resolve, LOOP_MS);
        this.kick = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  /** Chat checks under way, so the two lanes never check one chat twice at once. */
  private checking = new Map<string, Promise<void>>();

  /** Is this chat's change check due? */
  private groupDue(g: Group, now: number, hidden: boolean) {
    if (this.checking.has(g.id)) return true; // under way: waiting for it is waiting for its result
    const rec = this.records.get(g.id);
    // Recently busy chats, and chats waiting for someone to join, are checked more often.
    const warm = rec && (now - rec.lastTs < 2 * 60_000 || this.pending(g).length > 0);
    const every = hidden ? HIDDEN_POLL_MS : this.onScreen(g.id) ? ACTIVE_POLL_MS : warm ? WARM_POLL_MS : IDLE_POLL_MS;
    return now - (this.lastCheck.get(g.id) ?? 0) >= every;
  }

  /** Check one chat for changes, and sync it when there are some (or its fallback is due). */
  private checkGroup(g: Group, now: number, hidden: boolean): Promise<void> {
    const cur = this.checking.get(g.id);
    if (cur) return cur;
    const run = this.checkGroupNow(g, now, hidden).finally(() => this.checking.delete(g.id));
    this.checking.set(g.id, run);
    return run;
  }

  private async checkGroupNow(g: Group, now: number, hidden: boolean) {
    try {
      this.lastCheck.set(g.id, Date.now());
      const rec = this.records.get(g.id);
      const warm = rec && (now - rec.lastTs < 2 * 60_000 || this.pending(g).length > 0);
      // The check asks GitHub which files were added since the last look (one request). Its
      // answer can lag behind a push, and a list of changes is easier to get wrong than a
      // listing, so the chat's folders are also listed in full every little while: often for
      // the open chat and busy chats, now and then for the rest.
      const fallback = hidden ? FULL_SYNC_HIDDEN_MS : this.onScreen(g.id) ? FULL_SYNC_ACTIVE_MS : warm ? FULL_SYNC_WARM_MS : FULL_SYNC_IDLE_MS;
      // A chat whose last sync failed gets a full one again (not more often than an open chat's),
      // so its warning clears once GitHub answers, even if nothing new arrived meanwhile.
      const retry = this.groupErrors.has(g.id) ? (hidden ? HIDDEN_POLL_MS : FULL_SYNC_ACTIVE_MS) : fallback;
      const full = now - (this.lastFullSync.get(g.id) ?? 0) >= retry;
      const changed = await this.provider.changes.check(g.space);
      if (full) {
        this.lastFullSync.set(g.id, Date.now());
        this.provider.changes.relist(g.space);
      }
      if (changed || full) await this.syncGroup(g);
    } catch (e) {
      this.setGroupError(g.id, this.noteError(e));
    }
  }

  /**
   * The chat on screen, on its own: checked every few seconds whatever the main step is busy
   * with (other chats, invitations, the synced store), so new messages show up quickly.
   */
  private async openChatLoop(run: number) {
    while (!this.stopped && run === this.loopRun) {
      await new Promise<void>((resolve) => {
        this.openKick = resolve;
        setTimeout(resolve, LOOP_MS);
      });
      this.openKick = undefined;
      if (!this.chat || this.stopped || run !== this.loopRun) continue;
      const now = Date.now();
      if (now < this.rateLimitedUntil || document.visibilityState === 'hidden') continue;
      const open = [...this.chat.groups.values()].filter((g) => g.active && this.onScreen(g.id) && this.groupDue(g, now, false));
      for (const g of open) await this.checkGroup(g, now, false);
    }
  }
  private openKick?: () => void;

  /** Check the chat on screen now, without waiting for its timer or for the main sync step. */
  checkOpenChatNow() {
    if (!this.chat) return;
    for (const g of this.chat.groups.values()) if (this.onScreen(g.id)) this.lastCheck.delete(g.id);
    this.openKick?.();
  }

  private async tick() {
    if (!this.chat) return;
    const now = Date.now();
    // GitHub asked us to slow down: nothing goes out until the pause is over.
    if (now < this.rateLimitedUntil) return;
    const hidden = document.visibilityState === 'hidden';
    if (now - this.lastInvites > (hidden ? HIDDEN_POLL_MS : this.invites.size ? INVITE_PENDING_POLL_MS : INVITE_POLL_MS)) {
      this.lastInvites = now;
      await this.checkInvites();
    }
    if (now - this.lastClosures > (hidden ? HIDDEN_POLL_MS : INVITE_POLL_MS)) {
      this.lastClosures = now;
      await this.checkClosures().catch(() => undefined);
    }
    await this.resolveDuplicates().catch(() => undefined);
    await this.syncPersonal(now, hidden);
    if (now - this.lastBlobPrune > BLOB_PRUNE_MS) void this.pruneBlobs();
    const due: Group[] = [];
    for (const g of [...this.chat.groups.values()]) {
      if (!g.active) {
        // Refused by GitHub, maybe only for a moment: check again with a growing wait (also after
        // a reload, when it is tried at once). The sync clears it once GitHub answers.
        if (!this.isUnreachable(g)) continue;
        const l = this.lost.get(g.id);
        if (l && now < l.next) continue;
        await this.syncGroup(g);
        const again = this.lost.get(g.id);
        if (again) {
          again.delay = l ? Math.min(l.delay * 2, LOST_RETRY_MAX_MS) : LOST_RETRY_MS;
          again.next = Date.now() + again.delay;
        }
        continue;
      }
      // The chat on screen also has its own lane (openChatLoop), so a busy step doesn't hold it up.
      if (this.groupDue(g, now, hidden)) due.push(g);
    }
    // Several at once: one at a time, a phone spent most of a step waiting on round trips.
    await inParallel(due, (g) => this.checkGroup(g, now, hidden), CHECKS_AT_ONCE);
    // Keep this browser's pre-key published and fresh (accounts from before pre-keys get one
    // here). Only after a first full round, so invitations accepted elsewhere were joined first:
    // a retired key is pruned for good.
    if (this.syncReady && this.rounds++ > 0 && now - this.lastPreKey > PREKEY_CHECK_MS) {
      this.lastPreKey = now;
      await this.chat.refreshPreKey().catch((e) => (this.lastPollError = describeError(e)));
    }
  }

  /** Write queued changes soon after they happen; read other browsers' when the home repo changed. */
  private async syncPersonal(now: number, hidden: boolean) {
    if (!this.syncReady) return;
    const p = this.personal;
    if (!p) {
      // The start-up read failed (offline?): try again now and then.
      if (this.hasSyncKey && now - this.lastPull > PERSONAL_PULL_MS) {
        this.lastPull = now;
        await this.startSync().then(() => (this.syncError = undefined), (e) => (this.syncError = describeError(e)));
      }
      return;
    }
    try {
      if (p.pending && now - this.lastFlush > PERSONAL_FLUSH_MS) {
        this.lastFlush = now;
        await this.flushPersonal();
      }
      if (now - this.lastPull > (hidden ? HIDDEN_POLL_MS : PERSONAL_PULL_MS)) {
        this.lastPull = now;
        // GitHub's change check can lag a minute, so read anyway every half minute.
        if ((await this.headChanged(`${this.login}/${this.homeRepo}`)) || now - this.lastFullPull > PERSONAL_FULL_PULL_MS) {
          this.lastFullPull = now;
          await this.pull();
        }
      }
      this.syncError = undefined;
    } catch (e) {
      this.syncError = this.noteError(e);
    }
  }

  /** Closure notices from the Worker: how an offline member learns a chat was closed. */
  private async checkClosures() {
    let closures: { id: string; from: string; tag: string; at: string }[];
    if (this.inbox?.live) closures = [...this.inbox.closures.values()];
    else {
      const r = await this.ghFetch(`${CONFIG.worker}/closures`);
      if (r.status !== 200) return;
      ({ closures } = (await r.json()) as { closures: typeof closures });
    }
    if (!closures.length) return;
    const tags = new Map<string, ChatRecord>();
    const removals = new Map<string, ChatRecord>();
    for (const rec of this.records.values()) {
      if (rec.ended) continue;
      tags.set(await this.closureTag(rec.groupId), rec);
      removals.set(await this.removalTag(rec.groupId), rec);
    }
    for (const n of closures) {
      const from = toAddress(n.from.toLowerCase());
      const at = Date.parse(n.at) || Date.now();
      const removal = removals.get(n.tag);
      if (removal) {
        // Believe it only from an admin of the group as this browser last knew it, only while the
        // room is closed to us (a room we can still read tells us itself), and not from before a rejoin.
        const g = this.chat!.groups.get(removal.groupId);
        const admin = !!g && g.members().some((m) => m.address === from && m.admin);
        if (admin && (!g!.active || this.isUnreachable(g)) && at > (removal.rejoinedAt ?? 0)) await this.endRoom(removal.groupId, { how: 'removed', by: from, at });
        continue;
      }
      const rec = tags.get(n.tag);
      // Believe it only from the room's owner.
      if (rec && rec.space?.split('/')[0]?.toLowerCase() === n.from.toLowerCase()) await this.endRoom(rec.groupId, { how: 'closed', by: from, at });
      // An invitation from them sent before the close was for the closed room.
      for (const [k, inv] of this.invites) {
        if (inv.from === from && inv.status === 'invited' && !inv.space && (inv.created ?? 0) <= at) {
          this.invites.delete(k);
          if (inv.noticeId) await this.provider.inviteInbox.delete(inv.noticeId).catch(() => undefined);
        }
      }
    }
    this.bump();
  }

  /**
   * Rule 2: two live DM rooms with the same person (both pressed "new chat" at once). Both apps
   * pick the room owned by the lower GitHub user id; the owner of the other one closes it.
   */
  private async resolveDuplicates() {
    for (const c of this.conversations()) {
      if (!c.dm || !c.live) continue;
      let active = c.rooms.map((r) => this.chat!.groups.get(r.groupId)).filter((g): g is Group => !!g && g.active);
      if (active.length < 2) {
        await this.rescueRetired(c);
        continue;
      }
      const owners = await Promise.all(active.map((g) => this.userId(g.space.split('/')[0]!)));
      if (owners.some((o) => o === undefined)) continue;
      // Decide on fresh state: "who joined which room" changes as browsers catch up, and two
      // browsers of the owner deciding on different views would retire both rooms.
      if (active.some((g) => g !== this.winner(active) && this.isOwner(g))) {
        for (const g of active) await this.syncGroup(g);
        active = active.filter((g) => g.active);
        if (active.length < 2) continue;
      }
      const win = this.winner(active);
      // What this browser wrote only in the room that goes must not be lost: copy it over first.
      for (const g of active) if (g !== win) await this.moveOwn(g.id, win);
      for (const g of active) if (g !== win && this.isOwner(g)) await this.closeChat(g, 'moved');
    }
  }

  /**
   * The other side retired a duplicate room before this browser noticed there were two (it only
   * sees it closed, or can't reach it any more): copy over what this browser wrote there. Only for a
   * room that ended while the live room already existed, so an old chat's history never moves.
   */
  private async rescueRetired(c: Convo) {
    const liveRec = this.records.get(c.live!.id);
    if (!liveRec) return;
    for (const r of c.rooms) {
      if (r.groupId === c.live!.id || r.purged) continue;
      const lostSince = this.lost.get(r.groupId)?.since;
      const endAt = r.ended && (r.ended.how === 'moved' || r.ended.how === 'closed') ? r.ended.at : lostSince;
      if (endAt === undefined || liveRec.createdAt > endAt) continue;
      await this.moveOwn(r.groupId, c.live!);
    }
  }

  /**
   * Rule 2: send this device's texts from a retired room again in the room that stays, once each.
   * The copy names the original, so apps that have the original (the sender's other browsers, and
   * the peer if it read the old room) don't show it twice. Files can't move: their data lives in
   * the old repo.
   */
  private async moveOwn(fromId: string, to: Group) {
    const me = this.identity?.deviceId;
    if (!me || !to.active) return;
    for (const m of await this.messages(fromId)) {
      if (m.kind !== 'text' || m.deleted || m.movedTo || m.fromDevice !== me || m.body === undefined) continue;
      try {
        const sent = await to.send({ t: 'text', body: m.body, moved: m.movedFrom ?? m.id } as AppContent);
        await this.put({ ...m, movedTo: sent.id });
      } catch (e) {
        this.dropUnsent(to, e);
        return; // next sync step tries again
      }
    }
  }

  /**
   * Start no new work. Resolves true once the work already running (a send, a commit, a sync step
   * waiting on GitHub) has finished, false if it didn't within the time limit.
   */
  stop(): Promise<boolean> {
    if (!this.stopped || !this.quiescing) {
      this.stopped = true;
      globalThis.removeEventListener?.('online', this.onWake);
      document.removeEventListener('visibilitychange', this.onWake);
      this.inbox?.stop();
      this.kick?.();
      this.quiescing = this.gate.idle(this.looping);
    }
    return this.quiescing;
  }

  /**
   * Another tab takes over: stop, let the running work finish, then never call GitHub or write
   * IndexedDB again. Resolves when the other tab may start (false: work was cut off at the time limit).
   */
  async handOver(): Promise<boolean> {
    const clean = await this.stop();
    this.gate.fence();
    this.db?.close();
    return clean;
  }

  // ---- people ----

  /**
   * Everyone this account talks to, for the Contacts screen: people with a DM, members of its
   * groups, and anyone whose key it remembers (synced), with trust state known without a lookup.
   */
  people(): Person[] {
    const by = new Map<string, Person>();
    const get = (address: string) => {
      let p = by.get(address);
      if (!p) {
        p = { address, login: loginFrom(address), groups: [], blocked: this.blocked.has(address), verified: this.contacts.verified(address), conflict: this.contacts.conflict(address), firstSeen: this.contacts.firstSeen(address) };
        by.set(address, p);
      }
      return p;
    };
    for (const c of this.conversations()) {
      if (c.dm) {
        if (c.peer && (!get(c.peer).dm || c.live)) get(c.peer).dm = c;
      } else {
        const g = c.live ?? c.current;
        for (const m of g?.members() ?? []) if (m.address !== this.address) get(m.address).groups.push(c);
      }
    }
    for (const a of this.contacts.addresses()) if (a !== this.address) get(a);
    by.delete(this.address);
    return [...by.values()].sort((x, y) => x.login.localeCompare(y.login));
  }

  /**
   * The root key this account trusts for an address: its pin (this browser's, else the synced
   * one), or what the directory serves on first contact (which pins it).
   */
  async trustedKey(address: string): Promise<string | undefined> {
    if (address === this.address) return this.identity?.fingerprint;
    const pinned = this.contacts.pinned(address);
    if (pinned) return pinned;
    try {
      const r = await this.registry.lookup(address);
      return r.status === 'none' ? undefined : r.status === 'key-changed' ? r.pinned.fingerprint : r.view.fingerprint;
    } catch {
      return undefined;
    }
  }

  /** A member whose key in the chat differs from the one this account trusts for their address. */
  keyMismatch(m: { address: string; fingerprint: string }): boolean {
    const want = m.address === this.address ? this.identity?.fingerprint : this.contacts.pinned(m.address);
    return !!want && want !== m.fingerprint;
  }

  /**
   * What to show when verifying someone. `inChat`: the root key their leaf in a chat carries
   * (Member.fingerprint), which is what must be compared, not a fresh look at their address.
   */
  peer(address: string, refresh = false, inChat?: string): Promise<PeerInfo> {
    if (inChat) return this.lookupPeer(address, inChat);
    if (refresh) this.peers.delete(address);
    let p = this.peers.get(address);
    if (!p) {
      p = this.lookupPeer(address);
      this.peers.set(address, p);
    }
    return p;
  }

  /**
   * What this account already trusts for them, with no network: the remembered key and its safety
   * number. Shown at once while the directory is checked (seconds on a busy phone).
   */
  async knownPeer(address: string): Promise<PeerInfo | undefined> {
    const fp = this.contacts.pinned(address);
    if (!fp || !this.identity) return undefined;
    const conflict = this.contacts.conflict(address);
    return {
      address,
      status: conflict ? 'key-changed' : 'ok',
      fingerprint: fp,
      safety: await safetyNumber(this.identity.fingerprint, fp),
      verified: !conflict && this.contacts.verified(address),
      firstSeen: this.contacts.firstSeen(address),
      ...(conflict ? { otherBrowser: true } : {}),
      checking: true,
    };
  }

  private async lookupPeer(address: string, inChat?: string): Promise<PeerInfo> {
    try {
      const r = await this.registry.lookup(address);
      // The key in the chat is neither the published one nor (after a change) the one to accept.
      if (inChat && (r.status === 'none' || inChat !== r.view.fingerprint)) {
        return { address, status: 'mismatch', fingerprint: inChat, safety: await safetyNumber(this.identity!.fingerprint, inChat) };
      }
      if (r.status === 'none') return { address, status: 'none' };
      const fp = r.view.fingerprint;
      const pin = await this.registry.pins.get(address);
      // Another browser of this account trusts a different key: same warning as a key change on GitHub.
      const otherBrowser = r.status === 'ok' && this.contacts.conflict(address);
      return {
        address,
        status: otherBrowser ? 'key-changed' : r.status,
        fingerprint: fp,
        safety: await safetyNumber(this.identity!.fingerprint, fp),
        verified: r.status === 'ok' && !otherBrowser && !!pin?.verified,
        firstSeen: this.contacts.firstSeen(address),
        ...(otherBrowser ? { otherBrowser } : {}),
      };
    } catch (e) {
      return { address, status: 'error', error: describeError(e) };
    }
  }

  async markVerified(address: string) {
    await this.registry.markVerified(address);
    await this.flushPersonal().catch(() => undefined);
    this.peers.delete(address);
    this.bump();
  }

  /** The user compared numbers and trusts the key GitHub serves now: in this browser and, through sync, all of them. */
  async acceptKeyChange(address: string) {
    const r = await this.registry.lookup(address);
    if (r.status === 'key-changed' || (r.status === 'ok' && this.contacts.conflict(address))) {
      this.contacts.willAccept(address);
      await this.registry.acceptKeyChange(address, r.view);
    }
    await this.flushPersonal().catch(() => undefined);
    this.peers.delete(address);
    this.bump();
  }

  async myFingerprint() {
    return this.identity?.fingerprint;
  }
}

export { sleep };

/** The response with its body already read, so a call counts as running until its answer is in. */
async function readFully(r: Response): Promise<Response> {
  const empty = [101, 204, 205, 304].includes(r.status);
  const body = empty ? null : await r.arrayBuffer();
  return new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
}

/** Kinds that show as a bubble of their own while sending (not a moved copy, which the app re-sends itself). */
function isBubble(m: AppMessage): boolean {
  return (m.t === 'text' && typeof (m as { moved?: unknown }).moved !== 'string') || m.t === 'attachment';
}

/** Is this saved message the one this bubble sent? */
function sameContent(item: Sending, m: AppMessage): boolean {
  if (!isBubble(m)) return false;
  if (item.file) return m.t === 'attachment' && m.file.name === item.file.name && m.file.size === item.file.size && (m.caption ?? undefined) === (item.caption ?? undefined);
  return m.t === 'text' && m.body === (item.body ?? '');
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
