// A message sent fast (without a sync first) can reach someone removed a moment before.
// When their browser learns of the removal, keyhold names those messages and they are deleted.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('retracted messages', () => {
  it('a removed browser deletes what keyhold retracts, and the chat list stops showing it', async () => {
    w = await world();
    const [alice, carol] = [await w.browser('alice'), await w.browser('carol')];
    for (const b of [alice, carol]) await b.setup();
    await w.dm(alice, carol);
    await alice.s.send(alice.chat('carol')!.live!, 'before');
    await w.until(async () => (await carol.texts(carol.chat('alice'))).includes('before'), 'carol has the first');
    await alice.s.send(alice.chat('carol')!.live!, 'too late');
    await w.until(async () => (await carol.texts(carol.chat('alice'))).includes('too late'), 'carol has the second');
    const g = carol.chat('alice')!.live!;
    const id = (await carol.s.messages(g.id)).find((m) => m.body === 'too late')!.id;
    // What keyhold reports when this browser finds it was removed in that epoch.
    await (carol.s as unknown as { onEvents(g: unknown, e: unknown[]): Promise<void> }).onEvents(g, [{ type: 'retracted', ids: [id] }]);
    expect(await carol.texts(carol.chat('alice'))).toEqual(['before']);
    expect(carol.s.record(g.id).lastText).toBe('before');
  });
});
