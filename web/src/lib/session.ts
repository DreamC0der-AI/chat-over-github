/**
 * One signed-in account in this browser: Keyhold chat over the GitHub provider, the local
 * stores, and a polling loop that keeps chats up to date without burning the rate limit.
 */
import { githubProvider, toAddress, loginOf } from 'chat-over-github-provider';
import type { FetchFn } from 'chat-over-github-provider';
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
  type MergeRule,
  type DeviceIdentity,
  type Group,
  type GroupEvent,
  type ReceivedMessage,
  type RootKey,
  type DeviceCertificate,
  type LookupResult,
} from 'keyhold/chat';
import type { AttachmentRef } from 'keyhold/chat';
import { sha256, toHex } from 'keyhold/util';
import { generateRecoveryCode, parseRecoveryCode } from 'keyhold/keys';
import { hkdfAesKey, hkdfBytes } from 'keyhold/util';
import { CONFIG, installUrl } from '../config';
import { currentToken, type AuthState } from './auth';
import { InboxSocket } from './inbox-socket';
import { Db, IdbPinStore, idbDevice } from './idb';

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
  deviceCount?: number;
  /** The room's repo, kept so the room can still be shown after its group state is gone. */
  space?: string;
  kind?: 'dm' | 'group';
  /** DM only: the other person. A conversation is the pair of people, across rooms. */
  peer?: string;
  /** The room ended for good (closed, quit, removed). Its history stays until Delete chat. */
  ended?: { how: 'closed' | 'moved' | 'quit' | 'removed'; by?: string; at: number };
  /** Delete chat: messages up to here were deleted and are never shown again. */
  clearedAt?: number;
  /** DM owner side: the other person quit. */
  peerLeft?: boolean;
  /** Ended and deleted: nothing of it is shown or kept, only this tombstone. */
  purged?: boolean;
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
  lastTs: number;
  lastText?: string;
  unread: number;
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
  /**
   * The account is already in this chat (another of our browsers made or joined it): this browser
   * is only catching up, nobody invited us.
   */
  mine?: boolean;
}

export interface PeerInfo {
  address: string;
  status: LookupResult['status'] | 'error';
  fingerprint?: string;
  safety?: string;
  verified?: boolean;
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
const CHAT_RULES: Record<string, MergeRule> = { space: 'once', kind: 'once', peer: 'once', name: 'once', createdAt: 'once', ended: 'once', clearedAt: 'max', peerLeft: 'once', purged: 'once' };
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
const FULL_SYNC_WARM_MS = at(30_000);
const SPACE_SCAN_MS = at(60_000);
const SPACE_SCAN_PENDING_MS = at(15_000);
const INVITE_RETRY_MS = at(10_000);
const INVITE_RETRY_MAX_MS = at(3 * 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const loginFrom = (address: string) => {
  try {
    return loginOf(address);
  } catch {
    return address;
  }
};

export function describeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/rate limit/i.test(m)) return 'GitHub rate limit reached. Wait a few minutes and try again.';
  return m;
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
  provider!: StorageProvider & { client: { requests: number } };
  registry!: IdentityRegistry;
  identity?: DeviceIdentity;
  chat?: Chat;
  records = new Map<string, ChatRecord>();
  groupErrors = new Map<string, string>();
  rateRemaining?: number;
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
  /** Decrypted attachments this tab has opened or sent, by blob ref. Memory only, so no new plaintext lands on disk. */
  private files = new Map<string, Promise<Blob>>();

  private version = 0;
  private listeners = new Set<() => void>();
  private stopped = false;
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
  /** Start-up read of the synced store, running after the chat is on screen. */
  private syncStarting?: Promise<unknown>;
  private hasSyncKey = false;
  private syncReady = false;
  /** Opened from the stored install check; it gets checked once the chat shows. */
  private verifyInstall = false;
  /** Live connection to the invite inbox; while it is up the inbox isn't polled. */
  private inbox?: InboxSocket;
  private peers = new Map<string, Promise<PeerInfo>>();

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

  /** fetch with the current (refreshed) token, no HTTP cache, and rate-limit tracking. */
  ghFetch = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const go = async (force: boolean) => {
      const token = await (this.env.token ?? currentToken)(force);
      return fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }, cache: 'no-store' });
    };
    let r = await go(false);
    if (r.status === 401) r = await go(true);
    const left = r.headers.get('x-ratelimit-remaining');
    if (left !== null && url.startsWith(CONFIG.api)) this.rateRemaining = Number(left);
    return r;
  };

  private async ghJson<T>(path: string): Promise<{ status: number; data?: T }> {
    const r = await this.ghFetch(CONFIG.api + path, { headers: { Accept: 'application/vnd.github+json' } });
    const t = await r.text();
    return { status: r.status, data: t ? (JSON.parse(t) as T) : undefined };
  }

  // ---- start-up ----

  async start() {
    try {
      this.db = await Db.open(`keyhold-chat:${this.auth.id}`, this.env.indexedDB);
      this.device = idbDevice(this.db);
      await this.decidePhase();
    } catch (e) {
      this.phase = 'error';
      this.error = describeError(e);
    }
    this.bump();
  }

  /** The provider needs the install: before it, GitHub hides every repo from the app. */
  private async makeProvider() {
    if (this.provider) return;
    this.provider = githubProvider({
      fetch: this.ghFetch as unknown as FetchFn,
      token: 'set-per-request',
      login: this.login,
      workerUrl: CONFIG.worker,
      apiBase: CONFIG.api,
      directoryRepo: CONFIG.directoryRepo,
      homeRepo: this.homeRepo,
      chatPrefix: CONFIG.chatPrefix,
      description: `End-to-end encrypted chat data. Only the members' chat app can read it. Open it at ${location.origin}`,
    });
    this.registry = new IdentityRegistry(this.provider.directory, new IdbPinStore(this.db));
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
  async createIdentity(): Promise<string> {
    const root = createRootKey();
    try {
      const code = await generateRecoveryCode();
      // Back up first, so there is never a published identity without a way back in.
      await backupRootKey(this.provider.vault, await this.recoveryKey(code.bytes), this.address, root);
      const id = await createDeviceIdentity(this.device, root, this.address, newDeviceId());
      await this.saveSyncKey(root);
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
    const root = await this.unlockRoot(codeText);
    try {
      await this.saveSyncKey(root);
    } finally {
      wipeRoot(root);
    }
    await this.startSync();
    this.bump();
  }

  /** On as soon as this browser has the key, even while the first sync is still reading. */
  get syncOn() {
    return this.hasSyncKey || !!this.personal;
  }

  /** Add this browser as a new device of an existing identity. */
  async restoreIdentity(codeText: string) {
    const root = await this.unlockRoot(codeText);
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
    const root = await this.unlockRoot(codeText);
    try {
      await new DirectoryWriter(this.provider.directory, this.address).revokeDevice(root, devicePublic);
    } finally {
      wipeRoot(root);
    }
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
    this.stopped = false;
    this.chat = await Chat.open({
      provider: this.provider,
      device: this.device,
      identity: this.identity!,
      registry: this.registry,
      features: resolveFeatures(this.provider, { historyBackup: false }),
      onMessage: (g, m) => this.onMessage(g, m),
    });
    for (const k of await this.db.keys('kv', 'chat:')) {
      const r = await this.db.get<ChatRecord>('kv', k);
      if (r) this.records.set(r.groupId, r);
    }
    await this.repairPreviews();
    for (const g of this.chat.groups.values()) this.fill(g);
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
        debug: () => ({ invites: this.pendingInvites(), groups: Object.fromEntries(this.groupErrors), pollError: this.lastPollError, syncError: this.syncError }),
      };
    }
    void this.loop();
  }

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

  private async startSync() {
    if (this.personal) return;
    const raw = await this.device.keystore.get(PERSONAL_KEY_SLOT);
    if (!raw) return;
    this.hasSyncKey = true;
    const key = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt', 'decrypt']);
    // What this browser already wrote, so a reload doesn't write it all again.
    const sent = await this.db.get<Record<string, string>>('kv', PUSHED_KEY);
    if (sent) for (const [k, v] of Object.entries(sent)) if (!this.pushed.has(k)) this.pushed.set(k, v);
    this.personal = await PersonalData.open(this.provider.personal, key, this.identity!.deviceId);
    // Everything this browser knows goes up once (only what changed since it last did).
    for (const r of this.records.values()) this.push(r);
    for (const a of this.blocked) await this.syncBlock(a, true);
    for (const sp of this.declined) await this.syncDeclined(sp);
    await this.pull();
    await this.flushPersonal();
  }

  /** Write queued changes; once nothing is left queued, remember what has been written. */
  private async flushPersonal() {
    const p = this.personal;
    if (!p) return;
    await p.flush();
    if (!p.pending) await this.db.put('kv', Object.fromEntries(this.pushed), PUSHED_KEY);
  }

  private async syncBlock(address: string, blocked: boolean) {
    const mark = blocked ? 'on' : 'off';
    if (!this.personal || this.pushed.get(`b/${address}`) === mark) return;
    this.pushed.set(`b/${address}`, mark);
    await this.personal.set('blocks', address, { blocked: blocked || undefined });
  }

  private async syncDeclined(space: string) {
    if (!this.personal || this.pushed.has(`d/${space}`)) return;
    this.pushed.set(`d/${space}`, 'on');
    await this.personal.set('settings', `declined:${space}`, { value: true }, { value: 'once' });
  }

  /** Queue the synced fields of a chat, if they changed since last time. */
  private push(r: ChatRecord) {
    if (!this.personal) return;
    const fields: Record<string, unknown> = {
      space: r.space, kind: r.kind, peer: r.peer, name: r.lastName, createdAt: r.createdAt,
      ended: r.ended, clearedAt: r.clearedAt, peerLeft: r.peerLeft || undefined, purged: r.purged || undefined,
    };
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
    const snap = JSON.stringify(fields);
    if (this.pushed.get(r.groupId) !== snap) {
      this.pushed.set(r.groupId, snap);
      void this.personal.set('chats', r.groupId, fields, CHAT_RULES);
    }
    // Read up to here: other browsers clear their unread count.
    if (!r.unread) {
      const mark = `read:${r.lastTs}`;
      if (this.pushed.get(`r/${r.groupId}`) !== mark) {
        this.pushed.set(`r/${r.groupId}`, mark);
        void this.personal.set('readMarks', r.groupId, { at: r.lastTs }, { at: 'max' });
      }
    }
  }

  /** Apply what other browsers wrote. */
  private async pull() {
    if (!this.personal) return;
    for (const ch of await this.personal.changes()) {
      const v = ch.value;
      if (ch.collection === 'chats') await this.applyChat(ch.key, v);
      else if (ch.collection === 'readMarks') {
        const r = this.records.get(ch.key);
        if (r && typeof v.at === 'number' && v.at >= r.lastTs && r.unread) {
          r.unread = 0;
          await this.saveRecord(r);
        }
      } else if (ch.collection === 'blocks') {
        this.pushed.set(`b/${ch.key}`, v.blocked ? 'on' : 'off');
        if (v.blocked) {
          if (!this.blocked.has(ch.key)) {
            this.blocked.add(ch.key);
            await this.db.put('kv', Date.now(), `block:${ch.key}`);
          }
        } else if (this.blocked.delete(ch.key)) await this.db.del('kv', `block:${ch.key}`);
      } else if (ch.collection === 'settings' && ch.key.startsWith('declined:') && v.value) {
        const sp = ch.key.slice('declined:'.length);
        this.pushed.set(`d/${sp}`, 'on');
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
    if (typeof v.clearedAt === 'number' && v.clearedAt > (r.clearedAt ?? 0)) await this.applyClear(r, v.clearedAt);
    if (v.ended && !r.ended) {
      r.ended = v.ended as ChatRecord['ended'];
      await this.chat!.groups.get(groupId)?.end();
    }
    if (v.purged && !r.purged) await this.purgeRoom(r);
    // Already in step with storage: don't echo it back.
    await this.db.put('kv', r, `chat:${r.groupId}`);
  }

  /** Delete chat up to a time: this browser's messages up to then go, and never come back. */
  private async applyClear(r: ChatRecord, at: number) {
    r.clearedAt = Math.max(r.clearedAt ?? 0, at);
    await this.db.deleteMessages(r.groupId, at);
    if (r.lastTs <= at) {
      r.lastText = undefined;
      r.unread = 0;
    }
  }

  /** An ended room deleted: drop what's left of it here and keep only a tombstone. */
  private async purgeRoom(r: ChatRecord) {
    r.purged = true;
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
    return {
      key, dm, peer, rooms, live, current,
      title: dm ? (peer ? loginFrom(peer) : 'Direct message') : current?.name || name || 'Untitled group',
      lastTs: last.lastTs,
      lastText: last.lastText,
      unread: rooms.reduce((n, r) => n + r.unread, 0),
    };
  }

  /**
   * Rule 2 tie-break, deterministic on both sides. A room both people are in beats one still
   * waiting for the other to join; then the lowest owner user id; then the oldest room.
   */
  private winner(rooms: Group[]): Group {
    const both = rooms.filter((g) => g.members().length > 1);
    if (both.length) rooms = both;
    const id = (g: Group) => this.knownUserId(g.space.split('/')[0]!);
    return [...rooms].sort((a, b) => {
      const ia = id(a), ib = id(b);
      if (ia !== undefined && ib !== undefined && ia !== ib) return ia - ib;
      return (this.records.get(a.id)?.createdAt ?? 0) - (this.records.get(b.id)?.createdAt ?? 0);
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
    return g.name || 'Untitled group';
  }

  /** People invited but not yet in the group. */
  pending(g: Group): string[] {
    const inGroup = new Set(g.members().map((m) => m.address));
    return (this.records.get(g.id)?.invited ?? []).filter((a) => !inGroup.has(a));
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
  async startDm(input: string): Promise<string> {
    const login = this.normLogin(input);
    const address = toAddress(login);
    if (this.blocked.has(address)) throw new Error(`You blocked ${login}. Unblock them in Account and devices first.`);
    let existing = this.liveDm(address);
    if (existing) return existing.key;
    // Another of my devices may have started it already: join my own rooms first.
    await this.checkInvites(true);
    existing = this.liveDm(address);
    if (existing) return existing.key;
    if (!(await this.userExists(login))) throw new Error(`No GitHub user named ${login}`);
    // Rooms that are only unavailable get replaced now: their secrets can go.
    for (const c of this.conversations()) {
      if (c.dm && c.peer === address) for (const r of c.rooms) await this.chat!.groups.get(r.groupId)?.end();
    }
    const g = await this.chat!.createGroup('dm');
    const r = this.record(g.id);
    r.invited = [address];
    r.kind = 'dm';
    r.peer = address;
    r.space = g.space;
    await this.saveRecord(r);
    this.bump();
    await g.invite(address);
    await this.systemNote(g.id, `Invitation sent to @${login}. The chat opens for them when they accept in this app.`);
    this.bump();
    return this.convoKey(r);
  }

  async createGroup(name: string, inputs: string[]): Promise<{ group: Group; failed: string[] }> {
    const logins = [...new Set(inputs.filter((s) => s.trim()).map((s) => this.normLogin(s)))];
    for (const l of logins) if (!(await this.userExists(l))) throw new Error(`No GitHub user named ${l}`);
    const g = await this.chat!.createGroup('group', name.trim() || undefined);
    this.fill(g);
    this.bump();
    const failed: string[] = [];
    for (const l of logins) {
      try {
        await this.invite(g, l);
      } catch (e) {
        failed.push(`${l}: ${describeError(e)}`);
      }
    }
    return { group: g, failed };
  }

  async invite(g: Group, input: string) {
    const login = this.normLogin(input);
    if (!(await this.userExists(login))) throw new Error(`No GitHub user named ${login}`);
    await g.invite(toAddress(login));
    const r = this.record(g.id);
    if (!r.invited.includes(toAddress(login))) r.invited.push(toAddress(login));
    await this.saveRecord(r);
    await this.systemNote(g.id, `Invitation sent to @${login}.`);
    this.bump();
  }

  async removeMember(g: Group, fp: string) {
    const who = g.members().find((m) => m.fingerprint === fp);
    await g.remove(fp);
    const r = this.record(g.id);
    if (who) r.invited = r.invited.filter((a) => a !== who.address);
    await this.saveRecord(r);
    await this.syncGroup(g);
  }

  /** Tag for closure notices: the members' apps can match it, the Worker can't link it to a repo. */
  private async closureTag(groupId: string) {
    return toHex(await sha256(new TextEncoder().encode(`keyhold-chat-web/v1/closure:${groupId}`))).slice(0, 32);
  }

  /**
   * Close chat (repo owner): tell the members, delete the repo, then drop this room's secrets.
   * History stays on every device until someone uses Delete chat.
   */
  async closeChat(g: Group, reason: 'closed' | 'moved' = 'closed') {
    if (!this.isOwner(g)) throw new Error('Only the person who started this chat can close it.');
    const r = this.fill(g);
    const others = new Set([...g.members().map((m) => m.address), ...r.invited].filter((a) => a !== this.address));
    if (g.active && g.members().some((m) => m.address !== this.address)) await g.send({ t: 'sys.close', reason }).catch(() => undefined);
    const tag = await this.closureTag(g.id);
    for (const a of others) {
      await this.ghFetch(`${CONFIG.worker}/closures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: loginFrom(a), tag }),
      }).catch(() => undefined);
    }
    const del = await this.ghFetch(`${CONFIG.api}/repos/${g.space}`, { method: 'DELETE', headers: { Accept: 'application/vnd.github+json' } });
    if (del.status !== 204 && del.status !== 404) throw new Error(`GitHub didn't delete the chat's repo (${del.status}). The chat is still open.`);
    await this.endRoom(g.id, { how: reason, by: this.address, at: Date.now() });
  }

  /** Quit chat (not the owner): leave the group, then the repo. History stays here. */
  async quitChat(g: Group) {
    if (this.isOwner(g)) throw new Error('You started this chat, so you can close it but not quit it.');
    this.fill(g);
    if (g.active) await g.leave();
    // The owner's app removes our access anyway once it sees we left; this is just quicker.
    await this.ghFetch(`${CONFIG.api}/repos/${g.space}/collaborators/${encodeURIComponent(this.login)}`, { method: 'DELETE' }).catch(() => undefined);
    await this.endRoom(g.id, { how: 'quit', by: this.address, at: Date.now() });
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
    const now = Date.now();
    for (const r of c.rooms) {
      await this.applyClear(r, now);
      const g = this.chat!.groups.get(r.groupId);
      if (!g || !g.active) await this.purgeRoom(r);
      await this.saveRecord(r);
    }
    this.bump();
  }

  async block(address: string) {
    this.blocked.add(address);
    await this.db.put('kv', Date.now(), `block:${address}`);
    await this.syncBlock(address, true);
    const c = this.liveDm(address);
    if (c?.live) {
      if (this.isOwner(c.live)) await this.closeChat(c.live);
      else await this.quitChat(c.live);
    }
    for (const inv of this.pendingInvites()) if (inv.from === address && inv.status === 'invited') await this.declineInvite(inv.key).catch(() => undefined);
    this.bump();
  }

  async unblock(address: string) {
    this.blocked.delete(address);
    await this.db.del('kv', `block:${address}`);
    await this.syncBlock(address, false);
    this.bump();
  }

  async rename(g: Group, name: string) {
    await g.send({ t: 'meta', name });
    await this.syncGroup(g);
  }

  // ---- messages ----

  messages(groupId: string) {
    return this.db.messages<MsgRecord>(groupId);
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

  discardSend(groupId: string, id: string) {
    const item = this.sending.get(groupId)?.find((p) => p.id === id);
    if (item?.preview) URL.revokeObjectURL(item.preview);
    this.sending.set(groupId, (this.sending.get(groupId) ?? []).filter((p) => p.id !== id));
    this.bump();
  }

  private async deliver(g: Group, item: Sending) {
    let sent: { id: string };
    try {
      if (item.file) {
        const data = new Uint8Array(await item.file.arrayBuffer());
        sent = await g.sendAttachment(data, { name: item.file.name, mime: item.file.type || undefined, caption: item.caption });
      } else sent = await g.send({ t: 'text', body: item.body ?? '' });
    } catch (e) {
      await this.syncGroup(g).catch(() => undefined);
      item.failed = !g.active ? 'This chat has ended' : describeError(e);
      this.bump();
      return;
    }
    // The real message is stored by now; the screen drops this bubble as soon as it shows that one.
    item.sentId = sent.id;
    this.bump();
    setTimeout(() => this.discardSend(g.id, item.id), SETTLE_MS);
    void this.syncGroup(g);
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
      await g.send({ t: 'react', ref, emoji });
    } catch (e) {
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
      p = g.fetchAttachment(file).then((data) => new Blob([data as Uint8Array<ArrayBuffer>], { type: file.mime || 'application/octet-stream' }));
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
    const base = { groupId: g.id, id: msg.id, ts: msg.ts, from: m.from.address, fromFp: m.from.fingerprint, mine };
    const r = this.fill(g);
    if (msg.t === 'sys.close') {
      // Only the repo owner can end the room.
      const owner = toAddress(g.space.split('/')[0]!.toLowerCase());
      if (!mine && m.from.address === owner) this.toEnd.set(g.id, { how: msg.reason === 'moved' ? 'moved' : 'closed', by: owner, at: msg.ts });
      return;
    }
    // Delete chat: never show what was deleted again, even though old keys may still open it.
    if (r.purged || (r.clearedAt && msg.ts <= r.clearedAt)) return;
    const touch = async (preview: string) => {
      r.lastTs = Math.max(r.lastTs, msg.ts);
      r.lastText = preview;
      if (!mine && !this.onScreen(g.id)) r.unread++;
      await this.saveRecord(r);
    };
    switch (msg.t) {
      case 'text':
        await this.put({ ...base, kind: 'text', body: msg.body, reply: msg.reply });
        await touch(msg.body);
        break;
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
          if (who.has(m.from.address)) who.delete(m.from.address);
          else who.add(m.from.address);
          rx[msg.emoji] = [...who];
          if (!rx[msg.emoji]!.length) delete rx[msg.emoji];
          await this.put({ ...cur, reactions: rx, rxIds: [...(cur.rxIds ?? []), msg.id].slice(-200) });
        }
        break;
      }
      case 'meta':
        if (msg.name && msg.name !== r.lastName) {
          r.lastName = msg.name;
          await this.saveRecord(r);
          await this.put({ ...base, id: `meta-${msg.id}`, kind: 'system', body: mine ? `You named the group “${msg.name}”` : `@${loginFrom(m.from.address)} named the group “${msg.name}”` });
        }
        break;
      default:
        break;
    }
    this.bump();
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
      } else if (e.type === 'left') {
        await this.systemNote(g.id, `${who} left`);
        if (this.isDm(g) && e.address !== this.address && !g.members().some((m) => m.address !== this.address)) {
          r.peerLeft = true;
          await this.saveRecord(r);
        }
      } else if (e.type === 'removed') this.toEnd.set(g.id, { how: 'removed', at: Date.now() });
      else if (e.type === 'access-lost') {
        // Our own repo gone means we closed it (on another device, or on github.com). Someone
        // else's is only unavailable: it may come back, so nothing is deleted.
        if (this.isOwner(g) && (await this.ghFetch(`${CONFIG.api}/repos/${g.space}`)).status === 404) {
          this.toEnd.set(g.id, { how: 'closed', by: this.address, at: Date.now() });
        }
      }
      else if (e.type === 'undecryptable') await this.systemNote(g.id, 'A message could not be decrypted.');
      else if (e.type === 'rejected') await this.systemNote(g.id, `A change to the group was rejected (${e.reason}).`);
    }
    if (shareName && g.active && !this.isDm(g) && g.name && g.policy.admins.includes(this.identity!.fingerprint)) {
      await g.send({ t: 'meta', name: g.name }).catch(() => undefined);
    }
  }

  async syncGroup(g: Group) {
    try {
      const r = await g.sync();
      await this.onEvents(g, r.events);
      this.groupErrors.delete(g.id);
    } catch (e) {
      this.groupErrors.set(g.id, describeError(e));
    }
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
  async checkInvites(force = false) {
    const p = this.provider;
    const chat = this.chat!;
    const now = Date.now();
    const known = () => new Set([...chat.groups.values()].map((g) => g.space));
    let notices: Awaited<ReturnType<typeof p.inviteInbox.list>> = [];
    const live = this.inbox?.live ? this.inbox : undefined;
    if (live) {
      notices = [...live.invites.values()]
        .map((i) => ({ id: String(i.id), from: toAddress(i.from), pointer: String(i.id), expiresAt: Date.parse(i.expires_at) }))
        .filter((n) => n.expiresAt > now);
    } else {
      try {
        notices = await p.inviteInbox.list();
      } catch (e) {
        this.lastPollError = describeError(e);
      }
    }
    let have = known();
    // The inbox names who invited us but not the repo (the Worker keeps no repo names), so a
    // notice stands alone until it is accepted and the repo becomes visible.
    for (const n of notices) {
      const key = `notice:${n.id}`;
      if (this.invites.has(key)) continue;
      const created = n.expiresAt ? n.expiresAt - 7 * 24 * 3600_000 : now;
      this.invites.set(key, { key, from: n.from, status: 'invited', pointer: n.pointer, noticeId: n.id, since: now, created, attempts: 0, nextTry: 0 });
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
      for (const space of await p.channel.listSpaces()) {
        if (have.has(space) || this.invites.has(space) || this.declined.has(space)) continue;
        if ([...this.records.values()].some((r) => r.space === space && r.ended)) continue;
        const owner = space.split('/')[0]!.toLowerCase();
        const from = toAddress(owner);
        if (this.blocked.has(from)) continue;
        // Accepted here: an accepted notice from the same person is this repo. Our own repo means
        // another of our devices made the chat. Anything else was accepted outside this app
        // (on github.com), so it still waits for Accept here.
        // Also a chat another of our browsers already joined (from the synced chat list).
        const mine = owner === this.login.toLowerCase() || [...this.records.values()].some((r) => r.space === space && !r.ended && !r.purged);
        let accepted = mine;
        for (const [k, v] of this.invites) {
          if (k.startsWith('notice:') && v.status !== 'invited' && v.from === from) {
            this.invites.delete(k);
            accepted = true;
            break;
          }
        }
        this.invites.set(space, { key: space, space, from, status: accepted ? 'joining' : 'invited', since: now, attempts: 0, nextTry: 0, mine });
      }
      // Accepted notices whose repo never showed up go away after a few minutes.
      for (const [k, v] of this.invites) if (k.startsWith('notice:') && v.status !== 'invited' && now - v.since > 5 * 60_000) this.invites.delete(k);
    }
    have = known();
    for (const inv of [...this.invites.values()]) {
      if (inv.space && have.has(inv.space)) {
        this.invites.delete(inv.key);
        continue;
      }
      if (!inv.space || inv.dismissed || inv.status === 'invited') continue;
      if (!force && now < inv.nextTry) continue;
      inv.status = 'joining';
      this.bump();
      try {
        const g = await chat.join(inv.space);
        if (g) {
          this.invites.delete(inv.key);
          const r = this.fill(g);
          // Catching up on a chat the account was already in: its history stays in the other browsers.
          // "Already" means it existed before this browser was added, not some fixed age.
          if (inv.mine && !r.joinedAt && r.createdAt < (this.identity?.cert.issuedAt ?? Date.now())) {
            r.joinedAt = Date.now();
            await this.saveRecord(r);
          }
          await this.syncGroup(g);
          continue;
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
    }
    this.bump();
  }

  /** I invited them to a DM and they haven't joined yet. */
  private ownPendingDm(address: string) {
    return this.conversations().some((c) => c.dm && c.peer === address && c.live && this.isOwner(c.live) && !c.live.members().some((m) => m.address === address));
  }

  /** The user accepted: accept the GitHub invitation, then join the chat. */
  async acceptInvite(key: string, auto = false) {
    const inv = this.invites.get(key);
    if (!inv || inv.status !== 'invited') return;
    const p = this.provider;
    let gone = false;
    if (inv.pointer) {
      const id = inv.pointer.split('#').pop()!;
      const r = await this.ghFetch(`${CONFIG.api}/user/repository_invitations/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Accept: 'application/vnd.github+json' } });
      // 404/410: withdrawn (the chat was closed), expired, or already accepted on another device.
      if (r.status === 404 || r.status === 410) gone = true;
      else if (r.status !== 204) throw new Error(`GitHub didn't accept the invitation (${r.status}).`);
    }
    if (inv.noticeId) await p.inviteInbox.delete(inv.noticeId).catch(() => {});
    Object.assign(inv, { status: 'joining', pointer: undefined, noticeId: undefined, nextTry: 0, attempts: 0, since: Date.now(), gone });
    this.bump();
    await this.checkInvites(true);
    // Already accepted elsewhere shows up as a repo in that scan; if nothing did, it's gone.
    const still = this.invites.get(key);
    // Taken by the app itself (both started a DM at once) and already retired: nothing to say.
    if (still && gone && auto) this.invites.delete(key);
    else if (still && gone) Object.assign(still, { status: 'error', error: `@${loginFrom(inv.from)} withdrew this invitation or closed the chat.` });
    this.bump();
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
        if (r.unread) {
          r.unread = 0;
          void this.saveRecord(r);
        }
        this.lastCheck.delete(r.groupId);
      }
      this.kick?.();
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
  async syncNow(): Promise<void> {
    if (this.stopped || !this.chat) return;
    await this.syncStarting;
    if (this.stopped) return;
    this.lastInvites = 0;
    this.lastClosures = 0;
    this.lastPull = 0;
    this.lastFullPull = 0;
    this.lastFlush = 0;
    this.lastCheck.clear();
    this.lastFullSync.clear();
    this.lastSpaceScan = 0;
    for (const inv of this.invites.values()) inv.nextTry = 0;
    return new Promise<void>((resolve) => {
      this.afterTick.push(resolve);
      this.kick?.();
    });
  }

  private loopRun = 0;
  private async loop() {
    // A chat reopened after a stop (install came back) starts a new loop; an older one ends.
    const run = ++this.loopRun;
    while (!this.stopped && run === this.loopRun) {
      const waiting = this.afterTick.splice(0);
      try {
        await this.tick();
        this.lastPollError = undefined;
      } catch (e) {
        this.lastPollError = describeError(e);
        this.bump();
      }
      for (const done of waiting) done();
      // Someone asked for another step while this one ran: run it now, don't wait for the timer.
      if (this.afterTick.length) continue;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, LOOP_MS);
        this.kick = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  private async tick() {
    if (!this.chat) return;
    const now = Date.now();
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
    for (const g of this.chat.groups.values()) {
      if (!g.active) continue;
      const rec = this.records.get(g.id);
      // Recently busy chats, and chats waiting for someone to join, are checked more often.
      const warm = rec && (now - rec.lastTs < 2 * 60_000 || this.pending(g).length > 0);
      const every = hidden ? HIDDEN_POLL_MS : this.onScreen(g.id) ? ACTIVE_POLL_MS : warm ? WARM_POLL_MS : IDLE_POLL_MS;
      if (now - (this.lastCheck.get(g.id) ?? 0) < every) continue;
      this.lastCheck.set(g.id, Date.now());
      // GitHub's change check can lag up to a minute behind a push, so the open chat and busy
      // chats also get a full sync every little while whatever it says.
      const fallback = hidden ? Infinity : this.onScreen(g.id) ? FULL_SYNC_ACTIVE_MS : warm ? FULL_SYNC_WARM_MS : Infinity;
      try {
        const changed = await this.headChanged(g.space);
        if (changed || now - (this.lastFullSync.get(g.id) ?? 0) >= fallback) {
          this.lastFullSync.set(g.id, Date.now());
          await this.syncGroup(g);
        }
      } catch (e) {
        this.groupErrors.set(g.id, describeError(e));
      }
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
      this.syncError = describeError(e);
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
    for (const rec of this.records.values()) if (!rec.ended) tags.set(await this.closureTag(rec.groupId), rec);
    for (const n of closures) {
      const from = toAddress(n.from.toLowerCase());
      const at = Date.parse(n.at) || Date.now();
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
      const active = c.rooms.map((r) => this.chat!.groups.get(r.groupId)).filter((g): g is Group => !!g && g.active);
      if (active.length < 2) continue;
      const owners = await Promise.all(active.map((g) => this.userId(g.space.split('/')[0]!)));
      if (owners.some((o) => o === undefined)) continue;
      const win = this.winner(active);
      for (const g of active) if (g !== win && this.isOwner(g)) await this.closeChat(g, 'moved');
    }
  }

  stop() {
    this.stopped = true;
    this.inbox?.stop();
    this.kick?.();
  }

  // ---- people ----

  peer(address: string, refresh = false): Promise<PeerInfo> {
    if (refresh) this.peers.delete(address);
    let p = this.peers.get(address);
    if (!p) {
      p = this.lookupPeer(address);
      this.peers.set(address, p);
    }
    return p;
  }

  private async lookupPeer(address: string): Promise<PeerInfo> {
    try {
      const r = await this.registry.lookup(address);
      if (r.status === 'none') return { address, status: 'none' };
      const fp = r.view.fingerprint;
      const pin = await this.registry.pins.get(address);
      return {
        address,
        status: r.status,
        fingerprint: fp,
        safety: await safetyNumber(this.identity!.fingerprint, fp),
        verified: r.status === 'ok' && !!pin?.verified,
      };
    } catch (e) {
      return { address, status: 'error', error: describeError(e) };
    }
  }

  async markVerified(address: string) {
    await this.registry.markVerified(address);
    this.peers.delete(address);
    this.bump();
  }

  async acceptKeyChange(address: string) {
    const r = await this.registry.lookup(address);
    if (r.status === 'key-changed') await this.registry.acceptKeyChange(address, r.view);
    this.peers.delete(address);
    this.bump();
  }

  async myFingerprint() {
    return this.identity?.fingerprint;
  }
}

export { sleep };
