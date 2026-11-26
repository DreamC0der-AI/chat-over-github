// Membership walkthroughs: chains of invite, accept, decline, remove, leave and re-invite, with
// messages between every step, checked against a model of who may read what (tests/walk.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';
import { cast, Walk } from './walk';


let w: World;
afterEach(() => w?.stop());

const PIC = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAAfQ//73v/+BiOh/AAA=';

async function start(logins: string[], name = 'Hikers', settle = true) {
  w = await world();
  const { people, codes } = await cast(w, logins);
  // Pre-keys are published in the first rounds: invitations then add people at once.
  if (settle) await w.rounds(3);
  return { walk: new Walk(w, people, logins[0]!, name), codes };
}

describe('group walkthroughs', () => {
  it('alone, then invite, decline, write, invite again, accept', async () => {
    const { walk } = await start(['alice', 'bob']);
    await walk.create();
    await walk.send('alice');
    await walk.check();
    await walk.invite('bob');
    await walk.send('alice'); // bob may read this once he accepts this invitation
    await walk.decline('bob');
    await walk.send('alice'); // bob said no: never his to read
    await walk.check();
    await walk.invite('bob');
    await walk.send('alice');
    await walk.accept('bob');
    await walk.send('bob');
    await walk.check();
  });

  it('remove, write, re-invite, rejoin; the other browser and the picture follow', async () => {
    const { walk, codes } = await start(['alice', 'bob', 'carol']);
    walk.avatar = PIC;
    await walk.create(['bob', 'carol']);
    await walk.accept('bob');
    await walk.accept('carol');
    await walk.newBrowser('carol', codes.get('carol')!);
    await walk.send('carol');
    await walk.check();
    await walk.remove('carol');
    await walk.send('bob');
    await walk.send('alice');
    await walk.check();
    expect(await walk.notes('alice')).toContain('You removed @carol');
    expect(await walk.notes('bob')).toContain('@alice removed @carol');
    expect((await walk.notes('bob')).some((n) => n.includes('@carol left'))).toBe(false);
    await walk.invite('carol');
    await walk.accept('carol');
    await walk.send('carol');
    await walk.setAvatar('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP8=');
    await walk.send('alice');
    await walk.check();
  });

  it('leave, come back, leave again; a rename reaches everyone', async () => {
    const { walk } = await start(['alice', 'bob', 'carol']);
    await walk.create(['bob', 'carol']);
    await walk.accept('bob');
    await walk.accept('carol');
    await walk.send('bob');
    await walk.leave('bob');
    await walk.send('carol');
    await walk.check();
    expect((await walk.notes('alice')).some((n) => n.includes('@bob left'))).toBe(true);
    await walk.invite('bob');
    await walk.accept('bob');
    await walk.rename('Hikers 2');
    await walk.send('bob');
    await walk.check();
    await walk.leave('bob');
    await walk.send('alice');
    await walk.check();
  });

  it('removed before accepting, then invited again and accepted', async () => {
    const { walk } = await start(['alice', 'bob', 'carol']);
    await walk.create(['bob', 'carol']);
    await walk.accept('bob');
    await walk.send('alice');
    await walk.seesInvitation('carol');
    await walk.remove('carol');
    await walk.send('bob');
    await walk.check();
    await walk.invite('carol');
    await walk.send('alice');
    await walk.accept('carol');
    await walk.send('carol');
    await walk.check();
  });

  it('every way out and back for one person, with messages between', async () => {
    const { walk } = await start(['alice', 'bob', 'carol']);
    await walk.create(['bob', 'carol']);
    await walk.accept('carol');
    await walk.accept('bob');
    for (const [out, declineFirst] of [['remove', false], ['leave', false], ['remove', true], ['leave', true], ['remove', false]] as const) {
      await walk.send('carol');
      if (out === 'remove') await walk.remove('bob');
      else await walk.leave('bob');
      await walk.send('alice');
      await walk.check();
      await walk.invite('bob');
      if (declineFirst) {
        await walk.decline('bob');
        await walk.send('carol');
        await walk.check();
        await walk.invite('bob');
      }
      await walk.accept('bob');
      await walk.send('bob');
      await walk.check();
    }
  });

  it('without pre-keys: invitees join only on accept, same rules', async () => {
    const { walk } = await start(['alice', 'bob', 'carol'], 'Hikers', false);
    await walk.create(['bob']);
    await walk.send('alice');
    await walk.accept('bob');
    await walk.invite('carol');
    await walk.decline('carol');
    await walk.send('bob');
    await walk.invite('carol');
    await walk.accept('carol');
    await walk.remove('bob');
    await walk.send('carol');
    await walk.check();
  });

  it('a member resets their key: everyone is told, the old key is taken out, invited back they read only what follows', async () => {
    w = await world();
    const { people, codes } = await cast(w, ['alice', 'bob', 'carol']);
    const walk = new Walk(w, people, 'alice', 'Reset club');
    await walk.create(['bob', 'carol']);
    await walk.accept('bob');
    await walk.accept('carol');
    await walk.send('bob');
    await walk.newBrowser('bob', codes.get('bob')!);
    await walk.check();
    const { old } = await walk.resetKey('bob');
    await walk.send('alice');
    await walk.send('carol');
    await walk.check();
    expect(await walk.notes('carol')).toContain('@bob was removed after resetting their key');
    // bob's other browser had the old key: it stops.
    await w.until(() => old[1]!.s.phase === 'reset-elsewhere', "bob's other browser says the key was reset");
    await walk.inviteBack('bob');
    await walk.send('carol');
    await walk.accept('bob');
    await walk.send('bob');
    await walk.check();
  });
});

describe('DM walkthroughs', () => {
  async function dmStart(logins = ['alice', 'bob']) {
    w = await world();
    const { people, codes } = await cast(w, logins);
    await w.rounds(3);
    const [a, b] = logins.map((l) => people.get(l)![0]!);
    return { a: a!, b: b!, people, codes };
  }
  type B = Awaited<ReturnType<typeof dmStart>>['a'];
  /** Exactly one entry for the other person on each side, live on both, and both can write. */
  async function talk(x: B, y: B, tag: string) {
    await w.until(() => !!x.chat(y.login)?.live && !!y.chat(x.login)?.live && (x.chat(y.login)!.live!.members().filter((m) => !m.pending).length > 1), `${tag}: live on both sides`, 30);
    await x.s.send(x.chat(y.login)!.live!, `${tag}: ${x.login} to ${y.login}`);
    await y.s.send(y.chat(x.login)!.live!, `${tag}: ${y.login} to ${x.login}`);
    await w.until(async () => (await y.texts(y.chat(x.login))).includes(`${tag}: ${x.login} to ${y.login}`) && (await x.texts(x.chat(y.login))).includes(`${tag}: ${y.login} to ${x.login}`), `${tag}: both read each other`, 30);
    for (const [p, q] of [[x, y], [y, x]] as const) expect(p.chats().filter((c) => c.title === q.login), `${p.login} has one entry for ${q.login}`).toHaveLength(1);
  }
  /** Accept their invitation; `auto`: or the app joins by itself (I had asked them first and they never joined). */
  async function accept(b: B, from: string, auto = false) {
    await w.until(() => !!b.inviteFrom(from) || (auto && !!b.chat(from)?.live?.members().some((m) => m.address === `github:${from}` && !m.pending)), `${b.login} sees ${from}'s invitation`, 30);
    if (b.inviteFrom(from)) await b.s.acceptInvite(b.inviteFrom(from)!.key);
  }
  async function decline(b: B, from: string) {
    await w.until(() => !!b.inviteFrom(from), `${b.login} sees ${from}'s invitation`, 30);
    await b.s.declineInvite(b.inviteFrom(from)!.key);
  }

  it('after a decline, the one who asked can ask again', async () => {
    const { a: alice, b: bob } = await dmStart();
    await alice.s.startDm('bob');
    await decline(bob, 'alice');
    await w.rounds(3);
    expect(bob.chat('alice')).toBeUndefined();
    expect(bob.invites()).toEqual([]);
    await alice.s.startDm('bob');
    await accept(bob, 'alice');
    await talk(alice, bob, 'asked again');
  });

  it('decline, the decliner asks instead; quit; the other side starts again; close; start again', async () => {
    const { a: alice, b: bob } = await dmStart();
    await alice.s.startDm('bob');
    await decline(bob, 'alice');
    await w.rounds(3);
    expect(bob.chat('alice')).toBeUndefined();
    expect(bob.invites()).toEqual([]);
    await bob.s.startDm('alice');
    // Alice's own invitation to bob is still open, so her app takes his at once (as when both
    // start a DM together).
    await accept(alice, 'bob', true);
    await talk(alice, bob, 'first');

    await bob.s.quitChat(bob.chat('alice')!.live!).catch(() => bob.s.closeChat(bob.chat('alice')!.live!));
    await w.until(() => !bob.chat('alice')?.live && (!!alice.chat('bob')?.rooms.at(-1)?.peerLeft || !alice.chat('bob')?.live), 'alice sees bob left');
    await bob.s.startDm('alice');
    await accept(alice, 'bob');
    await talk(bob, alice, 'second');
    expect(await alice.texts(alice.chat('bob'))).toContain('first: bob to alice'); // old history stays in the same entry

    const owner = alice.s.isOwner(alice.chat('bob')!.live!) ? alice : bob;
    const other = owner === alice ? bob : alice;
    await owner.s.closeChat(owner.chat(other.login)!.live!);
    await w.until(() => !other.chat(owner.login)?.live && other.chat(owner.login)?.rooms.at(-1)?.ended?.how === 'closed', `${other.login} sees it closed`);
    await other.s.startDm(owner.login);
    await accept(owner, other.login);
    await talk(alice, bob, 'third');
    await w.checkConverged();
  });

  it('the owner closes and the other starts again at once, before their browser has seen the close', async () => {
    const { a: alice, b: bob } = await dmStart();
    await bob.s.startDm('alice');
    await accept(alice, 'bob');
    await talk(alice, bob, 'first');
    await bob.s.closeChat(bob.chat('alice')!.live!);
    await alice.s.startDm('bob');
    await accept(bob, 'alice');
    await talk(alice, bob, 'second');
    await w.checkConverged();
  });

  it('both start a DM at once: one chat, and it keeps working through quit and restart', async () => {
    const { a: alice, b: bob } = await dmStart();
    await Promise.all([alice.s.startDm('bob'), bob.s.startDm('alice')]);
    await w.until(() => !!alice.inviteFrom('bob') || !!bob.inviteFrom('alice') || (!!alice.chat('bob')?.live && !!bob.chat('alice')?.live), 'an invitation shows', 30);
    if (alice.inviteFrom('bob')) await alice.s.acceptInvite(alice.inviteFrom('bob')!.key);
    if (bob.inviteFrom('alice')) await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await talk(alice, bob, 'first');
    await w.rounds(3);
    expect(alice.invites().filter((i) => i.status === 'invited')).toEqual([]);
    expect(bob.invites().filter((i) => i.status === 'invited')).toEqual([]);
    await alice.s.quitChat(alice.chat('bob')!.live!).catch(async () => alice.s.closeChat(alice.chat('bob')!.live!));
    await w.until(() => !alice.chat('bob')?.live, 'alice is out');
    await alice.s.startDm('bob');
    await accept(bob, 'alice');
    await talk(alice, bob, 'second');
    await w.checkConverged();
  });

  it("an accept on one browser carries to the other; Delete chat, then the other side writes", async () => {
    const { a: alice, b: bob, codes } = await dmStart();
    const bob2 = await w.browser('bob');
    await bob2.restore(codes.get('bob')!);
    await w.rounds(2);
    await alice.s.startDm('bob');
    await w.until(() => !!bob.inviteFrom('alice') && !!bob2.inviteFrom('alice'), 'both of bob\'s browsers see it', 30);
    await bob2.s.acceptInvite(bob2.inviteFrom('alice')!.key);
    await talk(alice, bob2, 'first');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('first: alice to bob') && !bob.inviteFrom('alice'), 'bob\'s first browser follows', 30);
    await bob.s.deleteHistory(bob.chat('alice')!.key);
    await talk(alice, bob, 'after delete');
    await w.until(async () => !(await bob2.texts(bob2.chat('alice'))).includes('first: alice to bob'), 'the delete reaches bob2', 30);
    expect(await bob2.texts(bob2.chat('alice'))).toContain('after delete: alice to bob');
    await w.checkConverged();
  });
});
