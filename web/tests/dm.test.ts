// Direct messages between two people: invitations, talking, files, reactions, safety numbers.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('direct messages', () => {
  it('invitation, accept, and talk both ways', async () => {
    w = await world();
    const alice = await w.browser('alice');
    const bob = await w.browser('bob');
    await alice.setup();
    await bob.setup();

    await alice.s.startDm('bob');
    expect(await alice.notes(alice.chat('bob'))).toContainEqual(expect.stringContaining('Invitation sent to @bob'));
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    await w.rounds(3);
    expect(bob.chat('alice')).toBeUndefined(); // nothing joins before he accepts

    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(() => !!bob.chat('alice')?.live, 'bob joined');
    expect(bob.invites()).toEqual([]);
    await bob.s.send(bob.chat('alice')!.live!, 'hi alice');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('hi alice'), 'alice got it');
    await alice.s.send(alice.chat('bob')!.live!, 'hello bob\nsecond line');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('hello bob\nsecond line'), 'bob got it');
    expect(await bob.texts(bob.chat('alice'))).toEqual(['hi alice', 'hello bob\nsecond line']);
    expect(bob.chats()).toHaveLength(1);
    await w.checkConverged();
  });

  it('safety numbers match on both sides and can be marked verified', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const a = await alice.s.peer('github:bob', true);
    const b = await bob.s.peer('github:alice', true);
    expect(a.safety).toBeTruthy();
    expect(a.safety).toBe(b.safety);
    await alice.s.markVerified('github:bob');
    expect((await alice.s.peer('github:bob', true)).verified).toBe(true);
  });

  it('files and pictures arrive decrypted, with their caption', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const g = alice.chat('bob')!.live!;
    await alice.s.sendFiles(g, [new File(['secret file contents'], 'note.txt', { type: 'text/plain' })]);
    await alice.s.sendFiles(g, [new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' })], 'look at this');
    await w.until(async () => (await bob.messages(bob.chat('alice'))).filter((m) => m.kind === 'attachment').length === 2, 'bob got both files');
    const [note, photo] = (await bob.messages(bob.chat('alice'))).filter((m) => m.kind === 'attachment');
    expect(note!.file!.name).toBe('note.txt');
    expect(await (await bob.s.fetchFile(bob.chat('alice')!.live!, note!.file!)).text()).toBe('secret file contents');
    expect(photo!.caption).toBe('look at this');
    expect(new Uint8Array(await (await bob.s.fetchFile(bob.chat('alice')!.live!, photo!.file!)).arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('reactions reach the other side and can be taken back; delete for everyone', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await bob.s.send(bob.chat('alice')!.live!, 'party');
    await w.until(async () => !!(await alice.msg(alice.chat('bob'), 'party')), 'alice got it');
    const ref = (await alice.msg(alice.chat('bob'), 'party'))!.id;
    await alice.s.react(alice.chat('bob')!.live!, ref, '🎉', true);
    await w.until(async () => ((await bob.msg(bob.chat('alice'), 'party'))?.reactions?.['🎉'] ?? []).length === 1, 'bob sees the reaction');
    await w.rounds(2);
    expect((await alice.msg(alice.chat('bob'), 'party'))!.reactions!['🎉']).toHaveLength(1); // a sync never toggles it again
    await alice.s.react(alice.chat('bob')!.live!, ref, '🎉', false);
    await w.until(async () => ((await bob.msg(bob.chat('alice'), 'party'))?.reactions?.['🎉'] ?? []).length === 0, 'bob sees it taken back');

    const mine = (await bob.msg(bob.chat('alice'), 'party'))!.id;
    await bob.s.deleteMessage(bob.chat('alice')!.live!, mine);
    await w.until(async () => !!(await alice.messages(alice.chat('bob'))).find((m) => m.id === ref)?.deleted, 'alice sees it deleted');
    expect(alice.chat('bob')!.lastText).not.toBe('party'); // the chat list never shows deleted text
  });

  it('someone invited before they had an identity joins once they make one', async () => {
    w = await world();
    const [alice, dave] = [await w.browser('alice'), await w.browser('dave')];
    await alice.setup();
    await alice.s.startDm('dave');
    await dave.setup();
    await w.until(() => !!dave.inviteFrom('alice'), 'dave sees the invitation');
    await dave.s.acceptInvite(dave.inviteFrom('alice')!.key);
    await w.until(() => !!dave.chat('alice')?.live, 'dave joined');
    await dave.s.send(dave.chat('alice')!.live!, 'dave here');
    await w.until(async () => (await alice.texts(alice.chat('dave'))).includes('dave here'), 'they can talk');
  });

  it('a declined invitation stays gone, also after a restart', async () => {
    w = await world();
    const [carol, dave] = [await w.browser('carol'), await w.browser('dave')];
    await carol.setup();
    await dave.setup();
    await carol.s.startDm('dave');
    await w.until(() => !!dave.inviteFrom('carol'), 'dave sees the invitation');
    await dave.s.declineInvite(dave.inviteFrom('carol')!.key);
    await w.rounds(3);
    expect(dave.invites()).toEqual([]);
    expect(dave.chat('carol')).toBeUndefined();
    const again = await w.reopen(dave);
    await w.rounds(3);
    expect(again.invites()).toEqual([]);
    expect(again.chat('carol')).toBeUndefined();
  });

  it("a blocked person's invitation is turned down without showing", async () => {
    w = await world();
    const [alice, dave] = [await w.browser('alice'), await w.browser('dave')];
    await alice.setup();
    await dave.setup();
    await dave.s.block('github:alice');
    await alice.s.startDm('dave');
    for (let i = 0; i < 4; i++) {
      await w.rounds(1);
      expect(dave.inviteFrom('alice')).toBeUndefined();
    }
    expect(dave.chat('alice')).toBeUndefined();
  });

  it('both start a DM with each other at once: they settle on one room (rule 2)', async () => {
    w = await world();
    const [bob, carol] = [await w.browser('bob'), await w.browser('carol')];
    await bob.setup();
    await carol.setup();
    await Promise.all([bob.s.startDm('carol'), carol.s.startDm('bob')]);
    await w.until(
      () => bob.chats().length === 1 && carol.chats().length === 1 && !!bob.chat('carol')?.live && !!carol.chat('bob')?.live
        && bob.chat('carol')!.live!.id === carol.chat('bob')!.live!.id && !bob.inviteFrom('carol') && !carol.inviteFrom('bob'),
      'one live room on both sides',
      30,
    );
    await carol.s.send(carol.chat('bob')!.live!, 'one room for us');
    await w.until(async () => (await bob.texts(bob.chat('carol'))).includes('one room for us'), 'messages flow in it');
    await w.checkConverged();
  });

  it("both of alice's browsers start a DM with bob at once: one live room stays, everywhere (rule 2)", async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.rounds(2);
    await Promise.all([alice.s.startDm('bob'), alice2.s.startDm('bob')]);
    // Bob takes whichever invitation shows first; the other one comes in later.
    for (let i = 0; i < 30; i++) {
      const inv = bob.inviteFrom('alice');
      if (inv) await bob.s.acceptInvite(inv.key);
      await w.rounds(1);
    }
    await w.until(
      () => [alice, alice2].every((a) => a.chats().length === 1 && !!a.chat('bob')?.live && a.chat('bob')!.live!.id === bob.chat('alice')?.live?.id) && !bob.inviteFrom('alice'),
      'one live room for all three browsers',
      30,
    );
    await bob.s.send(bob.chat('alice')!.live!, 'which room?');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('which room?') && (await alice2.texts(alice2.chat('bob'))).includes('which room?'), 'both of alice\'s browsers get it');
    await w.checkConverged();
  });

  it('both start a DM at once and write at once: nothing written in the room that is retired is lost', async () => {
    w = await world();
    const [bob, carol] = [await w.browser('bob'), await w.browser('carol')];
    await bob.setup();
    await carol.setup();
    await w.rounds(2); // pre-keys published: each is added to the other's room at once and can read it all
    await Promise.all([bob.s.startDm('carol'), carol.s.startDm('bob')]);
    // Each writes in their own room before seeing the other's invitation.
    await bob.s.send(bob.chat('carol')!.live!, 'from bob, early');
    await carol.s.send(carol.chat('bob')!.live!, 'from carol, early');
    await w.until(
      () => !!bob.chat('carol')?.live && bob.chat('carol')!.live!.id === carol.chat('bob')?.live?.id && bob.chat('carol')!.rooms.filter((r) => !r.ended).length === 1 && carol.chat('bob')!.rooms.filter((r) => !r.ended).length === 1,
      'one live room on both sides',
      30,
    );
    const both = async () => {
      const [b, c] = [await bob.texts(bob.chat('carol')), await carol.texts(carol.chat('bob'))];
      return ['from bob, early', 'from carol, early'].every((t) => b.includes(t) && c.includes(t));
    };
    await w.until(both, 'each sees both early messages', 30);
    await w.rounds(3);
    // Each shows once: the copy in the room that stays is not shown twice to anyone.
    for (const [b, peer] of [[bob, 'carol'], [carol, 'bob']] as const) {
      const t = await b.texts(b.chat(peer));
      expect(t.filter((x) => x === 'from bob, early')).toHaveLength(1);
      expect(t.filter((x) => x === 'from carol, early')).toHaveLength(1);
    }
    await w.checkConverged();
  });

  it("the same reaction added from two of a person's browsers stays on (it doesn't cancel out)", async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joined');
    await bob.s.send(bob.chat('alice')!.live!, 'vote');
    await w.until(async () => !!(await alice.msg(alice.chat('bob'), 'vote')) && !!(await alice2.msg(alice2.chat('bob'), 'vote')), 'both browsers have it');
    const ref = (await alice.msg(alice.chat('bob'), 'vote'))!.id;
    await Promise.all([alice.s.react(alice.chat('bob')!.live!, ref, '👍', true), alice2.s.react(alice2.chat('bob')!.live!, ref, '👍', true)]);
    await w.rounds(4);
    for (const b of [alice, alice2, bob]) {
      const c = b === bob ? bob.chat('alice') : b.chat('bob');
      expect((await b.msg(c, 'vote'))!.reactions?.['👍']).toEqual(['github:alice']);
    }
    // Taking it back from one browser takes it back everywhere.
    await alice2.s.react(alice2.chat('bob')!.live!, ref, '👍', false);
    await w.until(async () => !(await bob.msg(bob.chat('alice'), 'vote'))!.reactions?.['👍'], 'bob sees it taken back');
    await w.until(async () => !(await alice.msg(alice.chat('bob'), 'vote'))!.reactions?.['👍'], 'alice sees it taken back');
  });

  it('a reaction from an older app (a toggle) still counts', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await bob.s.send(bob.chat('alice')!.live!, 'old');
    await w.until(async () => !!(await alice.msg(alice.chat('bob'), 'old')), 'alice got it');
    const ref = (await alice.msg(alice.chat('bob'), 'old'))!.id;
    await alice.chat('bob')!.live!.send({ t: 'react', ref, emoji: '❤️' });
    await w.until(async () => ((await bob.msg(bob.chat('alice'), 'old'))?.reactions?.['❤️'] ?? []).length === 1, 'bob sees it');
    await alice.chat('bob')!.live!.send({ t: 'react', ref, emoji: '❤️' });
    await w.until(async () => !(await bob.msg(bob.chat('alice'), 'old'))?.reactions?.['❤️'], 'the second toggle takes it back');
  });
});
