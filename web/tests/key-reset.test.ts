// Someone loses their recovery code and resets their encryption key: same GitHub account, new key.
// Their contacts notice from the public directory, admins' apps take the old key out, and people
// invite the new key back the normal way. A group whose only admin reset ends for everyone.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type Browser, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

const recheck = (...bs: Browser[]) => bs.forEach((b) => b.recheckKeys());

async function group(w: World, admin: Browser, name: string, others: Browser[]) {
  await admin.s.createGroup(name, others.map((b) => b.login));
  await w.until(() => others.every((b) => !!b.inviteFrom(admin.login)), 'everyone sees the invitation');
  for (const b of others) await b.s.acceptInvite(b.inviteFrom(admin.login)!.key);
  await w.until(() => others.every((b) => !!b.chat(name)?.live) && admin.chat(name)!.live!.members().filter((m) => !m.pending).length === others.length + 1, 'everyone joined');
}

describe('key reset', () => {
  it('in a group: everyone is told, the admin’s app takes the old key out, Invite again brings the new key in', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await group(w, alice, 'Hikers', [bob, carol]);
    await carol.s.send(carol.chat('Hikers')!.live!, 'before my reset');
    await w.until(async () => (await bob.texts(bob.chat('Hikers'))).includes('before my reset'), 'bob got it');

    const carol2 = await carol.resetKey(w);
    recheck(alice, bob);
    await w.until(async () => (await alice.notes(alice.chat('Hikers'))).includes('@carol was removed after resetting their key'), 'alice’s app took the old key out');
    expect(await alice.notes(alice.chat('Hikers'))).toContain('@carol reset their encryption key');
    await w.until(async () => (await bob.notes(bob.chat('Hikers'))).includes('@carol was removed after resetting their key'), 'bob sees why carol is gone');
    expect(alice.chat('Hikers')!.live!.members().map((m) => m.address)).not.toContain('github:carol');
    expect(alice.s.resetPeople(alice.chat('Hikers')!)).toEqual(['github:carol']);
    // The new key starts with an empty list: the old group isn't offered to it.
    await w.rounds(2);
    expect(carol2.chats()).toEqual([]);
    expect(carol2.invites()).toEqual([]);

    // A person lets the new key in.
    await alice.s.inviteBack(alice.chat('Hikers')!, 'github:carol');
    expect(alice.s.resetPeople(alice.chat('Hikers')!)).toEqual([]);
    await w.until(() => !!carol2.inviteFrom('alice')?.details, 'carol’s new key gets the invitation');
    expect(carol2.inviteFrom('alice')!.details).toMatchObject({ kind: 'group', afterReset: true });
    await carol2.s.acceptInvite(carol2.inviteFrom('alice')!.key);
    await w.until(() => !!carol2.chat('Hikers')?.live, 'carol is back');
    await bob.s.send(bob.chat('Hikers')!.live!, 'welcome back');
    await w.until(async () => (await carol2.texts(carol2.chat('Hikers'))).includes('welcome back'), 'carol reads new messages');
    expect(await carol2.texts(carol2.chat('Hikers'))).not.toContain('before my reset'); // no old history
  });

  it('when the only admin resets, the group ends for every member, keeps its history, and the new key deletes its repo', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await group(w, alice, 'Hikers', [bob, carol]);
    await bob.s.send(bob.chat('Hikers')!.live!, 'old news');
    await w.until(async () => (await carol.texts(carol.chat('Hikers'))).includes('old news'), 'carol got it');
    const space = alice.chat('Hikers')!.live!.space;

    // bob and carol notice the reset before the repo goes...
    recheck(bob);
    const alice2 = await alice.resetKey(w);
    await w.until(() => bob.chat('Hikers')?.rooms.at(-1)?.ended?.how === 'reset', 'bob’s app ended the group');
    // ...or after it (carol's app checks the admin's key when GitHub stops serving the repo).
    await w.until(async () => (await w.backend.fetch(`http://mock.test/gh/repos/${space}`, { headers: { authorization: 'Bearer tok-alice' } })).status === 404, 'alice’s new app deleted the repo');
    await w.until(() => carol.chat('Hikers')?.rooms.at(-1)?.ended?.how === 'reset', 'carol’s app ended the group');
    for (const b of [bob, carol]) {
      const c = b.chat('Hikers')!;
      expect(c.live).toBeUndefined();
      expect(c.rooms.at(-1)!.ended!.by).toBe('github:alice');
      expect(await b.texts(c)).toContain('old news');
    }
    expect(alice2.chats()).toEqual([]);
    // Delete chat works as usual.
    await bob.s.deleteHistory(bob.chat('Hikers')!.key);
    expect(bob.chat('Hikers')).toBeUndefined();
  });

  it('a DM whose other person reset pauses; Invite again continues it in the same chat', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    await bob.s.send(bob.chat('alice')!.live!, 'hi from the old key');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('hi from the old key'), 'alice got it');

    const bob2 = await bob.resetKey(w);
    recheck(alice);
    await w.until(async () => (await alice.notes(alice.chat('bob'))).includes('@bob reset their encryption key'), 'alice is told');
    await w.rounds(2); // bob's new key publishes its pre-key, so the invitation can carry its note
    expect(alice.s.resetPeople(alice.chat('bob')!)).toEqual(['github:bob']);
    expect(alice.chat('bob')!.live!.members().map((m) => m.address)).toEqual(['github:alice']);

    await alice.s.inviteBack(alice.chat('bob')!, 'github:bob');
    await w.until(() => !!bob2.inviteFrom('alice')?.details, 'bob’s new key gets the invitation');
    expect(bob2.inviteFrom('alice')!.details).toMatchObject({ kind: 'dm', afterReset: true });
    await bob2.s.acceptInvite(bob2.inviteFrom('alice')!.key);
    await w.until(() => !!bob2.chat('alice')?.live && alice.chat('bob')!.live!.members().filter((m) => !m.pending).length === 2, 'bob is back');
    expect(alice.chat('bob')!.rooms).toHaveLength(1); // the same chat
    await bob2.s.send(bob2.chat('alice')!.live!, 'new key here');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('new key here'), 'alice reads the new key');
    expect(await alice.texts(alice.chat('bob'))).toEqual(['hi from the old key', 'new key here']);
  });

  it('a DM whose owner reset ends for the other person; their Invite again starts a new room of the same chat', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob); // alice owns it
    await alice.s.send(alice.chat('bob')!.live!, 'before');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('before'), 'bob got it');

    recheck(bob);
    const alice2 = await alice.resetKey(w);
    await w.until(() => bob.chat('alice')?.rooms.at(-1)?.ended?.how === 'reset', 'the DM ended for bob');
    await w.rounds(2); // alice's new key publishes its pre-key
    await bob.s.inviteBack(bob.chat('alice')!, 'github:alice');
    await w.until(() => !!alice2.inviteFrom('bob')?.details, 'alice’s new key gets the invitation');
    expect(alice2.inviteFrom('bob')!.details).toMatchObject({ kind: 'dm', afterReset: true });
    await alice2.s.acceptInvite(alice2.inviteFrom('bob')!.key);
    await w.until(() => !!bob.chat('alice')?.live && bob.chat('alice')!.live!.members().filter((m) => !m.pending).length === 2, 'alice joined');
    const c = bob.chat('alice')!;
    expect(c.rooms).toHaveLength(2); // one chat in the list, old messages above
    expect(bob.chats()).toHaveLength(1);
    await alice2.s.send(alice2.chat('bob')!.live!, 'after');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('after'), 'bob reads the new key');
    expect(await bob.texts(bob.chat('alice'))).toEqual(['before', 'after']);
  });

  it('an invitation from someone who reset says so, and Accept trusts their new key', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob); // alice owns it
    const bob2 = await bob.resetKey(w);
    // bob's new key starts a chat with alice before her app noticed anything.
    await bob2.s.startDm('alice');
    await w.until(() => !!alice.inviteFrom('bob')?.keyReset, 'the card says bob reset his key');
    await alice.s.acceptInvite(alice.inviteFrom('bob')!.key);
    await w.until(() => !!alice.chat('bob')?.live && (bob2.chat('alice')?.live?.members().filter((m) => !m.pending).length ?? 0) === 2, 'alice joined the new room');
    expect((await alice.s.peer('github:bob', true)).status).toBe('ok');
    expect(alice.chats()).toHaveLength(1);
    await bob2.s.send(bob2.chat('alice')!.live!, 'it’s me');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('it’s me'), 'alice reads it');
  });

  it('a browser of the old key stops and says the key was reset elsewhere', async () => {
    w = await world();
    const alice1 = await w.browser('alice');
    const code = await alice1.setup();
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await alice2.resetKey(w);
    recheck(alice1);
    await alice1.sync();
    expect(alice1.s.phase).toBe('reset-elsewhere');
  });
});
