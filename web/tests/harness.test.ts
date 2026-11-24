// The scenario helpers themselves: holding a request, losing a reply, and the end-of-scenario check.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

async function pair() {
  w = await world();
  const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
  await alice.setup();
  await bob.setup();
  await w.dm(alice, bob);
  return { alice, bob };
}

describe('scenario helpers', () => {
  it('hold: a send stays "sending" while its write is in flight, and arrives once let go', async () => {
    const { alice, bob } = await pair();
    const g = alice.chat('bob')!.live!;
    const held = w.hold((r) => r.login === 'alice' && r.method !== 'GET' && r.url.includes(`${g.space}/`));
    const sending = alice.s.send(g, 'in flight');
    await held.started;
    expect(alice.s.sending.get(g.id)?.map((p) => p.body)).toEqual(['in flight']);
    held.release();
    await sending;
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('in flight'), 'bob gets it');
    await w.checkConverged();
  });

  it('loseReply: a reaction whose answer was lost, tapped again, ends up on (not toggled off)', async () => {
    const { alice, bob } = await pair();
    await bob.s.send(bob.chat('alice')!.live!, 'like me');
    await w.until(async () => !!(await alice.msg(alice.chat('bob'), 'like me')), 'alice has it');
    const ref = (await alice.msg(alice.chat('bob'), 'like me'))!.id;
    const g = alice.chat('bob')!.live!;
    const lost = w.loseReply((r) => r.login === 'alice' && r.method !== 'GET' && r.url.includes(`${g.space}/`));
    await expect(alice.s.react(g, ref, '⭐', true)).rejects.toThrow(/not sent/);
    await lost;
    await alice.s.react(g, ref, '⭐', true).catch(() => alice.s.react(g, ref, '⭐', true));
    await w.rounds(3);
    expect((await bob.msg(bob.chat('alice'), 'like me'))!.reactions?.['⭐']).toEqual(['github:alice']);
    // Not checkConverged: alice's own app can't open the message whose reply was lost (it doesn't
    // know it was hers) and notes "could not be decrypted". That is keyhold's to fix.
  });

  it('checkConverged notices a message one browser never got', async () => {
    const { alice, bob } = await pair();
    await alice.s.send(alice.chat('bob')!.live!, 'gone missing');
    await w.until(async () => !!(await bob.msg(bob.chat('alice'), 'gone missing')), 'bob has it');
    await w.checkConverged();
    await bob.s.db.deleteMessages(bob.chat('alice')!.live!.id);
    await expect(w.checkConverged()).rejects.toThrow(/bob never got "gone missing"/);
  });
});
