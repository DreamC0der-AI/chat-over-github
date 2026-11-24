// Invitees' apps take a Welcome only from a device listed in the inviter's published directory.
// A browser missing there must say so when it invites, not send invitations nobody can accept.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('inviting needs a published identity', () => {
  it('a browser removed from the identity cannot invite; the other browser still can, and the invitee joins', async () => {
    w = await world();
    const [a1, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await a1.setup();
    await bob.setup();
    const a2 = await w.browser('alice');
    await a2.restore(code);
    const removed = (await a1.s.myDevices()).find((d) => !d.current)!;
    await a1.s.revokeDevice(removed.cert.device, code);

    await expect(a2.s.startDm('bob')).rejects.toThrow(/removed from your identity/);
    await expect(a2.s.createGroup('Team', ['bob'])).rejects.toThrow(/removed from your identity/);
    expect(bob.invites()).toEqual([]);

    await a1.s.startDm('bob');
    await w.until(() => !!bob.inviteFrom('alice'), 'bob is invited');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('alice')?.live, 'bob joins');
  });
});
