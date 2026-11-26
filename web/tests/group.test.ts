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
    // A removal reads as one, naming who did it, never as a leave.
    await w.until(async () => (await alice.notes(alice.chat('Weekend hikers'))).includes('You removed @carol'), 'alice sees she removed carol');
    await w.until(async () => (await bob.notes(bob.chat('Weekend hikers'))).includes('@alice removed @carol'), 'bob sees alice removed carol');
    expect((await bob.notes(bob.chat('Weekend hikers'))).some((n) => n.includes('left'))).toBe(false);
    // She can't read the repo any more; the notice through the Worker tells her app who removed her.
    await w.until(() => carol.chat('Weekend hikers')?.rooms.at(-1)?.ended?.how === 'removed', 'carol sees she was removed');
    expect(carol.chat('Weekend hikers')!.rooms.at(-1)!.ended!.by).toBe('github:alice');
    expect(carol.chat('Weekend hikers')!.live).toBeUndefined();
    expect(await carol.texts(carol.chat('Weekend hikers'))).toContain('carol here'); // she keeps her copy

    await bob.s.send(bob.chat('Weekend hikers')!.live!, 'after carol');
    await w.until(async () => (await alice.texts(alice.chat('Weekend hikers'))).includes('after carol'), 'the group goes on');
    await w.rounds(2);
    expect(await carol.texts(carol.chat('Weekend hikers'))).not.toContain('after carol');
  await w.checkConverged();
  });

  it('a decline takes the invitee out of the encryption at once, and a re-invite starts after it', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.rounds(3); // pre-keys published: the invite adds bob's device at once
    await alice.s.createGroup('Test Group 6', ['bob']);
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    expect(alice.chat('Test Group 6')!.live!.members().find((m) => m.address === 'github:bob')?.pending).toBe(true);
    await bob.s.declineInvite(bob.inviteFrom('alice')!.key);
    // His app tells alice's, which checks GitHub and takes his devices out (no 10-minute wait).
    await w.until(async () => (await alice.notes(alice.chat('Test Group 6'))).includes('@bob didn’t join'), 'alice takes bob out');
    const g = () => alice.chat('Test Group 6')!.live!;
    expect(g().members().map((m) => m.address)).toEqual(['github:alice']);
    await alice.s.send(g(), 'Ok');
    await alice.s.invite(g(), 'bob');
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the second invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Test Group 6')?.live, 'bob joined');
    await alice.s.send(g(), 'welcome');
    await w.until(async () => (await bob.texts(bob.chat('Test Group 6'))).includes('welcome'), 'bob reads what came after');
    expect(await bob.texts(bob.chat('Test Group 6'))).not.toContain('Ok');
  });

  it('a re-invite right after a decline, before the inviter noticed it, still hides the gap', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.rounds(3); // pre-keys published: the invite adds bob's device at once
    await alice.s.createGroup('Test Group 6', ['bob']);
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    const g = alice.chat('Test Group 6')!.live!;
    await bob.s.declineInvite(bob.inviteFrom('alice')!.key);
    // Alice's app hasn't looked at its notices yet: bob's pre-key devices are still in the group.
    await alice.s.send(g, 'Ok');
    await alice.s.invite(g, 'bob');
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the second invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Test Group 6')?.live, 'bob joined');
    await alice.s.send(alice.chat('Test Group 6')!.live!, 'welcome');
    await w.until(async () => (await bob.texts(bob.chat('Test Group 6'))).includes('welcome'), 'bob reads what came after');
    expect(await bob.texts(bob.chat('Test Group 6'))).not.toContain('Ok');
    await w.checkConverged();
  });

  it('a re-invite right after a decline, before the inviter noticed it, still hides the gap (no pre-key: he joins by himself)', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await alice.s.createGroup('Test Group 6', ['bob']);
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    const g = alice.chat('Test Group 6')!.live!;
    await bob.s.declineInvite(bob.inviteFrom('alice')!.key);
    // Alice's app hasn't looked at its notices yet: bob's pre-key devices are still in the group.
    await alice.s.send(g, 'Ok');
    await alice.s.invite(g, 'bob');
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the second invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Test Group 6')?.live, 'bob joined');
    await alice.s.send(alice.chat('Test Group 6')!.live!, 'welcome');
    await w.until(async () => (await bob.texts(bob.chat('Test Group 6'))).includes('welcome'), 'bob reads what came after');
    expect(await bob.texts(bob.chat('Test Group 6'))).not.toContain('Ok');
    await w.checkConverged();
  });

  it('a group with only its creator can be written in, and someone invited later joins cleanly', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    const { failed } = await alice.s.createGroup('Just me', []);
    expect(failed).toEqual([]);
    await w.until(() => !!alice.chat('Just me')?.live, 'alice has the group');
    await alice.s.send(alice.chat('Just me')!.live!, 'note to self');
    await w.until(async () => (await alice.texts(alice.chat('Just me'))).includes('note to self') && !!alice.s.sending.get(alice.chat('Just me')!.live!.id)?.every((p) => p.sentId), 'her message went out');

    await alice.s.invite(alice.chat('Just me')!.live!, 'bob');
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Just me')?.live, 'bob joined');
    await alice.s.send(alice.chat('Just me')!.live!, 'hi bob');
    await w.until(async () => (await bob.texts(bob.chat('Just me'))).includes('hi bob'), 'bob reads what came after he joined');
    // Nothing of what she wrote alone shows to bob as broken (a message sent just before an
    // invite may reach him: keyhold re-sends quick sends that raced an epoch change).
    await w.checkConverged();
  });

  async function hikers() {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await alice.s.createGroup('Hikers', ['bob', 'carol']);
    await w.until(() => !!bob.inviteFrom('alice') && !!carol.inviteFrom('alice'), 'both see the invitation');
    for (const b of [bob, carol]) await b.s.acceptInvite(b.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Hikers')?.live && !!carol.chat('Hikers')?.live, 'both joined');
    return { alice, bob, carol };
  }

  async function reinvite(alice: Awaited<ReturnType<typeof hikers>>['alice'], who: typeof alice) {
    await alice.s.invite(alice.chat('Hikers')!.live!, who.login);
    await w.until(() => !!who.inviteFrom('alice'), `${who.login} sees the new invitation`);
    await who.s.acceptInvite(who.inviteFrom('alice')!.key);
    await w.until(() => !!who.chat('Hikers')?.live, `${who.login} is back in`, 30);
    await who.s.send(who.chat('Hikers')!.live!, `${who.login} is back`);
    await w.until(async () => (await alice.texts(alice.chat('Hikers'))).includes(`${who.login} is back`), 'alice reads it');
    await alice.s.send(alice.chat('Hikers')!.live!, `welcome back ${who.login}`);
    await w.until(async () => (await who.texts(who.chat('Hikers'))).includes(`welcome back ${who.login}`), `${who.login} reads it`);
    expect(who.chats().filter((c) => c.title === 'Hikers')).toHaveLength(1);
    expect(who.invites()).toEqual([]);
  }

  it('an admin adds several people to an existing group at once', async () => {
    w = await world();
    const [alice, bob, carol, dave] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol'), await w.browser('dave')];
    for (const b of [alice, bob, carol, dave]) await b.setup();
    await alice.s.createGroup('Climbers', []);
    await w.until(() => !!alice.chat('Climbers')?.live, 'group made');
    await alice.s.invite(alice.chat('Climbers')!.live!, ['bob', '@Carol', 'bob', ' dave ']);
    await w.until(() => [bob, carol, dave].every((b) => !!b.inviteFrom('alice')), 'all three see the invitation');
    for (const b of [bob, carol, dave]) await b.s.acceptInvite(b.inviteFrom('alice')!.key);
    await w.until(() => [bob, carol, dave].every((b) => !!b.chat('Climbers')?.live), 'all three joined');
    const notes = await alice.notes(alice.chat('Climbers'));
    for (const l of ['bob', 'carol', 'dave']) expect(notes.filter((n) => n === `Invitation sent to @${l}.`)).toHaveLength(1);
    await expect(alice.s.invite(alice.chat('Climbers')!.live!, ['nobody-here'])).rejects.toThrow('No GitHub user named nobody-here');
    await w.checkConverged();
  });

  it('someone who quit can be invited back and join again', async () => {
    const { alice, bob } = await hikers();
    await bob.s.quitChat(bob.chat('Hikers')!.live!);
    await w.until(async () => (await alice.notes(alice.chat('Hikers'))).some((n) => n.includes('@bob left')), 'alice sees bob left');
    await w.rounds(2);
    await reinvite(alice, bob);
    await w.checkConverged();
  });

  it('someone removed can be invited back and join again', async () => {
    const { alice, carol } = await hikers();
    const g = alice.chat('Hikers')!.live!;
    await alice.s.removeMember(g, g.members().find((m) => m.address === 'github:carol')!.fingerprint);
    await w.until(() => carol.chat('Hikers')?.rooms.at(-1)?.ended?.how === 'removed', 'carol is out');
    await w.rounds(2);
    await reinvite(alice, carol);
    // The removal notice (kept 7 days) doesn't end the room she is back in.
    await w.rounds(3);
    expect(carol.chat('Hikers')!.live).toBeDefined();
    await w.checkConverged();
  });

  it('someone who joined with a pre-key, then was removed, loses the repo and sees the new invitation', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await w.rounds(3); // pre-keys are published after the first rounds: the invite adds them at once
    await alice.s.createGroup('Hikers', ['bob', 'carol']);
    const repo = () => w.backend.gh.repos.get(alice.chat('Hikers')!.live!.space.toLowerCase())!;
    await w.until(() => !!bob.inviteFrom('alice') && !!carol.inviteFrom('alice'), 'both see the invitation');
    for (const b of [bob, carol]) await b.s.acceptInvite(b.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Hikers')?.live && !!carol.chat('Hikers')?.live, 'both joined');
    await w.rounds(2);
    const g = alice.chat('Hikers')!.live!;
    await alice.s.removeMember(g, g.members().find((m) => m.address === 'github:carol')!.fingerprint);
    expect(repo().collaborators.has('carol')).toBe(false);
    await w.until(() => carol.chat('Hikers')?.rooms.at(-1)?.ended?.how === 'removed', 'carol is out');
    await w.rounds(2);
    await reinvite(alice, carol);
    await w.checkConverged();
  });

  it('someone who quit and deleted the chat can be invited back and join again', async () => {
    const { alice, bob } = await hikers();
    await bob.s.quitChat(bob.chat('Hikers')!.live!);
    await bob.s.deleteHistory(bob.chat('Hikers')!.key);
    expect(bob.chat('Hikers')).toBeUndefined();
    await w.until(async () => (await alice.notes(alice.chat('Hikers'))).some((n) => n.includes('@bob left')), 'alice sees bob left');
    await w.rounds(2);
    await reinvite(alice, bob);
    await w.checkConverged();
  });
  it('a browser left on its own branch of the group comes back, and the key changes stop', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await alice.s.createGroup('Split', ['bob']);
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('Split')?.live, 'bob joined');

    // An older app on bob's side rejected alice's key change once and answered with its own.
    const gb = bob.chat('Split')!.live! as unknown as { meta: { needsHeal: boolean }; applyEntry: (e: { kind: string }, out: { events: unknown[] }) => Promise<void> };
    const orig = gb.applyEntry.bind(gb);
    let once = false;
    gb.applyEntry = async (e, out) => {
      if (!once && e.kind === 'commit') {
        once = true;
        gb.meta.needsHeal = true;
        return;
      }
      return orig(e, out);
    };
    await alice.chat('Split')!.live!.rotate();
    await w.rounds(3);
    await alice.chat('Split')!.live!.rotate(); // any later change on alice's side brings bob back
    await w.rounds(3);

    const space = alice.chat('Split')!.live!.space;
    const logLen = async () => (await alice.chat('Split')!.live!.chat.provider.orderedLog.read(space, 0)).length;
    const settled = await logLen();
    await w.rounds(3);
    expect(await logLen()).toBe(settled);

    await bob.s.send(bob.chat('Split')!.live!, 'bob is back');
    await w.until(async () => (await alice.texts(alice.chat('Split'))).includes('bob is back'), 'alice reads bob');
    await alice.s.send(alice.chat('Split')!.live!, 'welcome back');
    await w.until(async () => (await bob.texts(bob.chat('Split'))).includes('welcome back'), 'bob reads alice');
  });
});
