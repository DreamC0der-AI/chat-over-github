// What a chat says when something went wrong underneath: a message that never arrived, or a
// browser that couldn't save what it received.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('chat events', () => {
  it('a message missing from the repo shows a quiet note naming the sender', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    const g = alice.chat('bob')!.live!;
    const repo = w.backend.gh.repos.get(g.space)!;
    const mail = () => [...repo.files.keys()].filter((k) => k.startsWith('mail/'));
    for (const body of ['one', 'two', 'three']) {
      const before = new Set(mail());
      await alice.s.send(g, body);
      if (body === 'two') for (const k of mail()) if (!before.has(k)) repo.files.delete(k); // lost on GitHub
    }
    await w.until(async () => (await bob.notes(bob.chat('alice'))).some((n) => n.includes('may be missing')), 'bob is told', 5);
    expect(await bob.notes(bob.chat('alice'))).toContain('A message from @alice may be missing.');
    expect(await bob.texts(bob.chat('alice'))).toEqual(['one', 'three']);
  });

  it('messages this browser cannot save show a storage warning, not "could not be decrypted", and arrive once it can', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    const db = bob.s.db as unknown as { put(store: string, v: unknown, k?: unknown): Promise<void> };
    const put = db.put.bind(db);
    let full = true;
    db.put = async (store, v, k) => {
      if (full && store === 'messages') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put(store, v, k);
    };
    await alice.s.send(alice.chat('bob')!.live!, 'kept for later');
    const gb = bob.chat('alice')!.live!;
    await bob.sync();
    expect(bob.s.groupErrors.get(gb.id)).toMatch(/couldn't be saved in this browser/);
    full = false;
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('kept for later'), 'bob saves it once there is room');
    expect(bob.s.groupErrors.has(gb.id)).toBe(false);
    expect((await bob.notes(bob.chat('alice'))).filter((n) => n.includes('could not be decrypted'))).toEqual([]);
    await w.checkConverged();
  });
});
