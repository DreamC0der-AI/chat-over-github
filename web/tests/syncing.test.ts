// The account bar's dot breathes while the app catches up: at start, after the tab is shown
// again (switching to the phone), and while a chat fetches new messages. Not while it only watches.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World | undefined;
afterEach(() => {
  w?.stop();
  w = undefined;
});

describe('syncing state', () => {
  it('on at start, after a wake and while new messages come in; off once a step finds nothing new', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    await alice.sync();
    expect(alice.s.syncing()).toBe(false);

    // The tab is shown again: catching up until a whole step has run.
    (alice.s as unknown as { onWake: () => void }).onWake();
    expect(alice.s.syncing()).toBe(true);
    await alice.sync();
    expect(alice.s.syncing()).toBe(false);

    // A new message: on while the chat fetches it, off afterwards.
    await bob.s.send(bob.chat('alice')!.live!, 'hi');
    const seen: boolean[] = [];
    const harnessFetch = globalThis.fetch;
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      if (String(input).includes('/mail')) seen.push(alice.s.syncing());
      return harnessFetch(input, init);
    }) as typeof fetch;
    try {
      await alice.sync();
    } finally {
      globalThis.fetch = harnessFetch;
    }
    expect(await alice.texts(alice.chat('bob'))).toContain('hi');
    expect(seen).toContain(true);
    expect(alice.s.syncing()).toBe(false);

    // Only watching (nothing new): stays off throughout.
    seen.length = 0;
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      seen.push(alice.s.syncing());
      return harnessFetch(input, init);
    }) as typeof fetch;
    try {
      await alice.check();
    } finally {
      globalThis.fetch = harnessFetch;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(true);
  });
});
