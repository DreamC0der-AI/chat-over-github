/**
 * A live connection to this user's invite inbox on the Worker (a Durable Object). The Worker
 * sends everything pending when the socket opens, then pushes each new or removed invitation
 * and closure notice. An idle socket costs nothing on the Worker's side, so the app doesn't
 * poll the inbox while it is connected.
 *
 * Browsers can't put headers on a WebSocket, so the token travels as the subprotocol
 * "bearer.<token>" next to the real one, "inbox.v1".
 */

export type InboxInvite = { id: number; from: string; from_id: number; created_at: string; expires_at: string; /** Sealed for our devices by the inviter's app (base64). */ note?: string };
export type InboxClosure = { id: string; from: string; from_id: number; tag: string; at: string };

type Msg =
  | { type: 'snapshot'; invites: InboxInvite[]; closures: InboxClosure[] }
  | { type: 'invite'; invite: InboxInvite }
  | { type: 'invite-removed'; id: number }
  | { type: 'closure'; closure: InboxClosure }
  | { type: 'closure-removed'; id: string };

const PING_MS = 45_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export class InboxSocket {
  invites = new Map<number, InboxInvite>();
  closures = new Map<string, InboxClosure>();
  /** True once a snapshot arrived on the open socket: the maps above are then up to date. */
  live = false;
  private ws?: WebSocket;
  private stopped = false;
  private failures = 0;
  private ping?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly workerUrl: string,
    private readonly token: (force: boolean) => Promise<string>,
    /** Called after every change (and when the socket goes up or down). */
    private readonly onChange: () => void,
  ) {}

  start() {
    void this.connect();
    // Coming back online or to the tab: reconnect now instead of waiting out the backoff.
    addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
  }

  stop() {
    this.stopped = true;
    removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.ws?.close(1000);
    this.setLive(false);
  }

  private wake = () => {
    if (this.stopped || document.visibilityState === 'hidden' || this.ws) return;
    clearTimeout(this.retry);
    void this.connect();
  };

  private async connect() {
    if (this.stopped || this.ws) return;
    let token: string;
    try {
      // A socket that fails is usually the network (asleep, offline), not the token: a forced
      // refresh here would spend the refresh token on every retry. An expired token is renewed
      // anyway, and a revoked one is renewed by the next GitHub request that gets a 401.
      token = await this.token(false);
    } catch {
      return this.again();
    }
    if (this.stopped || this.ws) return;
    const url = this.workerUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/inbox';
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ['inbox.v1', `bearer.${token}`]);
    } catch {
      return this.again();
    }
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (ev.data === 'pong' || typeof ev.data !== 'string') return;
      let msg: Msg;
      try {
        msg = JSON.parse(ev.data) as Msg;
      } catch {
        return;
      }
      this.apply(msg);
    };
    ws.onopen = () => {
      clearInterval(this.ping);
      // Keeps proxies from dropping an idle socket. The Worker answers without waking up.
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_MS);
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      if (this.ws === ws) this.ws = undefined;
      const wasLive = this.live;
      this.setLive(false);
      if (!wasLive) this.failures++;
      this.again();
    };
  }

  private again() {
    if (this.stopped) return;
    // Quick retries after a drop, slower ones while the Worker can't be reached.
    const delay = Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** Math.min(this.failures, 8)) * (0.75 + Math.random() / 2);
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), delay);
  }

  private apply(msg: Msg) {
    switch (msg.type) {
      case 'snapshot':
        this.invites = new Map(msg.invites.map((i) => [i.id, i]));
        this.closures = new Map(msg.closures.map((c) => [c.id, c]));
        this.failures = 0;
        this.live = true;
        break;
      case 'invite':
        this.invites.set(msg.invite.id, msg.invite);
        break;
      case 'invite-removed':
        this.invites.delete(msg.id);
        break;
      case 'closure':
        this.closures.set(msg.closure.id, msg.closure);
        break;
      case 'closure-removed':
        this.closures.delete(msg.id);
        break;
      default:
        return;
    }
    this.onChange();
  }

  private setLive(v: boolean) {
    if (this.live === v) return;
    this.live = v;
    this.onChange();
  }
}
