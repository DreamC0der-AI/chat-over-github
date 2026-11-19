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
  });
});
