// A member's device whose key isn't the one this account trusts for its address: whatever it
// claims, it is not that person. keyhold reports each sender's and member's root key; the app
// compares it with the pinned contact key.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('keys that do not match the trusted one', () => {
  it('a close not signed by the owner’s trusted key is ignored; the member is flagged; Verify compares the key in the chat', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    const ga = alice.chat('bob')!.live!;
    const gb = bob.chat('alice')!.live!;
    const real = (await bob.s.contacts.get('github:alice'))!;
    const member = gb.members().find((m) => m.address === 'github:alice')!;
    expect(bob.s.keyMismatch(member)).toBe(false);

    // Bob's account trusts another key for @alice than the one in this chat.
    await bob.s.contacts.set('github:alice', { ...real, fingerprint: 'ab'.repeat(32) });
    expect(bob.s.keyMismatch(member)).toBe(true);
    await ga.send({ t: 'sys.close', reason: 'closed' });
    await bob.sync(2);
    expect(bob.chat('alice')!.live).toBeTruthy();
    expect(bob.chat('alice')!.rooms[0]!.ended).toBeUndefined();

    // Verify looks at the key the leaf carries, not a fresh lookup of the address.
    expect((await bob.s.peer('github:alice', true, 'cd'.repeat(32))).status).toBe('mismatch');
    expect((await bob.s.peer('github:alice', true, member.fingerprint)).status).not.toBe('mismatch');

    // Under the trusted key, the same close ends the chat.
    await bob.s.contacts.set('github:alice', real);
    await ga.send({ t: 'sys.close', reason: 'closed' });
    await w.until(() => !!bob.chat('alice')!.rooms[0]!.ended, 'bob sees the close');
  });
});
