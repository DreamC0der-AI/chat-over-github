// How long catching up takes when every GitHub answer is slow (a phone, a far-away network):
// after a reload, and after the tab is shown again. What matters is how many round trips wait
// on each other, so the parts of a sync step and the chats run side by side.
import { afterEach, describe, expect, it, vi } from 'vitest';
// This file runs the app's own sync loop on its real schedule (other scenarios step it by hand).
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__syncScale = 1;
});
import { world, type World } from './harness';

let w: World | undefined;
const realFetch = globalThis.fetch;
afterEach(() => {
  w?.stop();
  w = undefined;
  globalThis.fetch = realFetch;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every answer takes this long. */
const LATENCY_MS = 150;
const CHATS = 6;

describe('catching up on a slow connection', () => {
  it('a reload and a wake take a few round trips, however many chats there are', async () => {
    w = await world();
    const alice = await w.browser('alice');
    await alice.setup();
    for (let i = 0; i < CHATS; i++) {
      const p = await w.browser(`p${i}`);
      await p.setup();
      await w.dm(alice, p);
      await p.s.send(p.chat('alice')!.live!, 'hello');
      p.s.stop();
    }
    await alice.sync(2);

    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      await sleep(LATENCY_MS);
      return inner(input, init);
    }) as typeof fetch;
    /** Round trips' worth of time until the dot is still. */
    const trips = async (from: number) => {
      while (again.s.syncing() && Date.now() - from < 60 * LATENCY_MS) await sleep(10);
      return (Date.now() - from) / LATENCY_MS;
    };

    let t = Date.now();
    const again = await w.reopen(alice);
    expect(again.s.syncing()).toBe(true);
    // One after another this was 14 round trips with 6 chats (6 more for every 4 chats); side by side it is 4 to 5.
    const reload = await trips(t);
    expect(reload).toBeLessThan(9);
    expect(again.chats()).toHaveLength(CHATS);

    // The tab is shown again: every chat is asked "anything new?" at once (2 round trips; it was 5).
    await sleep(200);
    t = Date.now();
    (again.s as unknown as { onWake: () => void }).onWake();
    expect(again.s.syncing()).toBe(true);
    const wake = await trips(t);
    expect(wake).toBeLessThan(4);
  }, 60_000);
});
