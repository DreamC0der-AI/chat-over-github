// Group chats: invite several people, talk, remove someone.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('groups', () => {
  it('everyone invited joins on accept, messages reach all, a removed member is told', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    const { failed } = await alice.s.createGroup('Weekend hikers', ['bob', 'carol']);
    expect(failed).toEqual([]);
    await w.until(() => !!bob.inviteFrom('alice') && !!carol.inviteFrom('alice'), 'both see the invitation');
    for (const b of [bob, carol]) await b.s.acceptInvite(b.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Weekend hikers')?.live && !!carol.chat('Weekend hikers')?.live, 'both joined');

    await carol.s.send(carol.chat('Weekend hikers')!.live!, 'carol here');
    await w.until(async () => (await bob.texts(bob.chat('Weekend hikers'))).includes('carol here') && (await alice.texts(alice.chat('Weekend hikers'))).includes('carol here'), 'reached both');

    const g = alice.chat('Weekend hikers')!.live!;
    await alice.s.removeMember(g, g.members().find((m) => m.address === 'github:carol')!.fingerprint);
    await w.until(async () => (await alice.notes(alice.chat('Weekend hikers'))).some((n) => n.includes('@carol left')), 'alice sees carol left');
    // She can't read the repo any more, so her app can only tell it's unavailable ("no longer available").
    await w.until(() => !!carol.chat('Weekend hikers') && !carol.chat('Weekend hikers')!.live, 'carol can no longer send there');
    expect(await carol.texts(carol.chat('Weekend hikers'))).toContain('carol here'); // she keeps her copy

    await bob.s.send(bob.chat('Weekend hikers')!.live!, 'after carol');
    await w.until(async () => (await alice.texts(alice.chat('Weekend hikers'))).includes('after carol'), 'the group goes on');
    await w.rounds(2);
    expect(await carol.texts(carol.chat('Weekend hikers'))).not.toContain('after carol');
  });
});
