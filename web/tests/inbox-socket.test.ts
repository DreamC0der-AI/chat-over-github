// The invite inbox's live connection: a socket that stops answering is replaced, not trusted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxSocket } from '../src/lib/inbox-socket';

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string, readonly protocols: string[]) {
    FakeSocket.all.push(this);
  }
  send(t: string) {
    this.sent.push(t);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: 'snapshot', invites: [], closures: [] }) });
  }
}

const g = globalThis as Record<string, unknown>;
afterEach(() => {
  vi.useRealTimers();
  FakeSocket.all = [];
});

describe('the inbox socket', () => {
  it('drops a socket whose ping goes unanswered and connects again', async () => {
    vi.useFakeTimers();
    g.WebSocket = FakeSocket;
    g.addEventListener = () => {};
    g.removeEventListener = () => {};
    const inbox = new InboxSocket('http://w.test', async () => 'tok', () => {});
    inbox.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSocket.all[0]!;
    first.open();
    expect(inbox.live).toBe(true);
    // A ping that gets its pong keeps the socket.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(first.sent).toEqual(['ping']);
    first.onmessage?.({ data: 'pong' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.all.length).toBe(1);
    // The next one goes unanswered (the connection died while the browser still calls it open).
    await vi.advanceTimersByTimeAsync(35_000);
    expect(first.sent).toEqual(['ping', 'ping']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.closed).toBe(true);
    expect(inbox.live).toBe(false);
    expect(FakeSocket.all.length).toBe(2);
    FakeSocket.all[1]!.open();
    expect(inbox.live).toBe(true);
    inbox.stop();
  });
});
