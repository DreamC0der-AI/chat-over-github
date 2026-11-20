// Pre-keys: people are added while offline, so a new chat can be written to before they accept.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

const preKeys = (login: string) =>
  w.requests.filter((r) => r.method === 'PUT' && r.url.includes(`/repos/${login}/keyhold-id/contents/prekeys/`)).length;

describe('pre-keys', () => {
  it('every account publishes a pre-key by itself, also one set up before pre-keys existed', async () => {
    w = await world();
    const bob = await w.browser('bob');
    await bob.setup();
    await w.until(() => preKeys('bob') === 1, 'bob published a pre-key');
    // A reload doesn't publish again while the key is fresh.
    await w.reopen(bob);
    await w.rounds(3);
    expect(preKeys('bob')).toBe(1);
  });

  it('a new group can be written to at once; invitees read it all when they accept', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await w.until(() => preKeys('bob') === 1 && preKeys('carol') === 1, 'pre-keys published');

    await alice.s.createGroup('Hikers', ['bob', 'carol']);
    const g = alice.chat('Hikers')!.live!;
    expect(g.members()).toHaveLength(3); // added right away...
    expect(alice.s.pending(g).sort()).toEqual(['github:bob', 'github:carol']); // ...but not joined
    expect(alice.s.joinedMembers(g)).toHaveLength(1);
    await alice.s.send(g, 'before anyone accepted');

    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(async () => (await bob.texts(bob.chat('Hikers'))).includes('before anyone accepted'), 'bob reads the early message');
    await w.until(async () => (await alice.notes(alice.chat('Hikers'))).some((n) => n.includes('@bob joined')), 'alice sees bob join');
    expect(alice.s.pending(g)).toEqual(['github:carol']);
    expect(await bob.notes(bob.chat('Hikers'))).not.toContain('A message could not be decrypted.');
    expect(bob.chat('Hikers')).toBeDefined(); // the group name reached him
  });

  it('a DM: the message box is open before they accept, and they get what was sent', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.until(() => preKeys('bob') === 1, 'bob published a pre-key');
    await alice.s.startDm('bob');
    const g = alice.chat('bob')!.live!;
    expect(g.members()).toHaveLength(2);
    await alice.s.send(g, 'hi, are you there?');
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('hi, are you there?'), 'bob reads it');
    await bob.s.send(bob.chat('alice')!.live!, 'yes');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('yes'), 'alice gets the reply');
  });
});
