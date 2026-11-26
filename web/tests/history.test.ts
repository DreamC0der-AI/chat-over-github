// Message history backup: a new browser of the account (or the app on a new address) gets the
// chat's earlier messages from the encrypted backup in the home repo; deletes reach it too.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('history backup', () => {
  it('a new browser gets the earlier messages, deleted ones stay deleted, and no "earlier messages elsewhere"', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const room = bob.chat('alice')!.live!;
    await bob.s.send(room, 'one');
    await alice.s.send(alice.chat('bob')!.live!, 'two');
    await bob.s.send(room, 'three');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).length === 3, 'alice got all');
    const three = await bob.msg(bob.chat('alice'), 'three');
    await bob.s.deleteMessage(room, three!.id);
    await w.until(async () => (await alice.texts(alice.chat('bob'))).length === 2, 'alice saw the delete');
    await w.rounds(2);

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(async () => !!alice2.chat('bob')?.live && (await alice2.texts(alice2.chat('bob'))).length === 2, 'alice2 has the history');
    expect(await alice2.texts(alice2.chat('bob'))).toEqual(['one', 'two']);
    expect((await alice2.msg(alice2.chat('bob'), 'two'))!.mine).toBe(true);
    expect(alice2.chat('bob')!.rooms[0]!.joinedAt).toBeUndefined();
    // New messages keep arriving the usual way.
    await bob.s.send(room, 'four');
    await w.until(async () => (await alice2.texts(alice2.chat('bob'))).includes('four'), 'alice2 gets new ones');
    // (No checkConverged: it would expect the deleted "three" everywhere.)
  });

  it('Delete chat clears the backup: a browser added later gets nothing from before', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await bob.s.send(bob.chat('alice')!.live!, 'secret');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('secret'), 'alice got it');
    await w.rounds(2);
    await alice.s.deleteHistory(alice.chat('bob')!.key);
    alice.cleared.set(alice.chat('bob')!.key, Date.now());
    await w.rounds(2);

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joined');
    await w.rounds(2);
    expect(await alice2.texts(alice2.chat('bob'))).toEqual([]);
    // The first browser doesn't get it back either (a repeat delivered after the new browser joined).
    expect(await alice.texts(alice.chat('bob'))).toEqual([]);
    // And the backup no longer holds it (not just hidden by the delete mark).
    const alice3 = await w.browser('alice');
    await alice3.restore(code);
    await w.rounds(2);
    expect(JSON.stringify([...(alice3.s as unknown as { histHave: Map<string, Map<string, unknown>> }).histHave.values()].flatMap((m) => [...m.keys()]))).toBe("[]");
  });

  it("reloading doesn't write the backup again", async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await bob.s.send(bob.chat('alice')!.live!, 'hello');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('hello'), 'alice got it');
    await w.rounds(3);
    const from = w.requests.length;
    await w.reopen(alice);
    await w.rounds(2);
    const puts = w.requests.slice(from).filter((r) => r.method === 'PUT' && r.url.includes('alice/chat-home/contents/items/'));
    expect(puts).toEqual([]);
  });
});
