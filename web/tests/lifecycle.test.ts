// Ending chats: Delete chat (my copy), Close (the owner ends it), Quit (a member leaves).
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

async function talking() {
  w = await world();
  const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
  await alice.setup();
  await bob.setup();
  await w.dm(alice, bob);
  await bob.s.send(bob.chat('alice')!.live!, 'hi alice');
  await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('hi alice'), 'alice got it');
  return { alice, bob };
}

describe('ending chats', () => {
  it('Delete chat clears only my copy; the chat stays live', async () => {
    const { alice, bob } = await talking();
    await bob.s.deleteHistory(bob.chat('alice')!.key);
    expect(await bob.texts(bob.chat('alice'))).toEqual([]);
    expect(bob.chat('alice')?.live).toBeTruthy();
    await alice.s.send(alice.chat('bob')!.live!, 'after the clear');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('after the clear'), 'new messages arrive');
    expect(await bob.texts(bob.chat('alice'))).toEqual(['after the clear']);
    expect(await alice.texts(alice.chat('bob'))).toEqual(['hi alice', 'after the clear']);
  });

  it('Close: the other side learns why and keeps a copy; a new chat is the same entry', async () => {
    const { alice, bob } = await talking();
    await alice.s.closeChat(alice.chat('bob')!.live!);
    expect(alice.chat('bob')!.rooms[0]!.ended?.how).toBe('closed');
    await w.until(() => bob.chat('alice')?.rooms[0]?.ended?.how === 'closed' && !bob.chat('alice')?.live, 'bob sees it closed');
    expect(bob.chat('alice')!.rooms[0]!.ended!.by).toBe('github:alice');
    expect(await bob.texts(bob.chat('alice'))).toEqual(['hi alice']);

    await bob.s.startDm('alice');
    await w.until(() => !!alice.inviteFrom('bob'), 'alice sees the new invitation');
    await alice.s.acceptInvite(alice.inviteFrom('bob')!.key);
    await w.until(() => !!alice.chat('bob')?.live && (bob.chat('alice')?.live?.members().length ?? 0) > 1, 'alice joined the new room');
    await bob.s.send(bob.chat('alice')!.live!, 'new room, same chat');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('new room, same chat'), 'alice got it');
    expect(alice.chats().filter((c) => c.title === 'bob')).toHaveLength(1);
    expect(bob.chats().filter((c) => c.title === 'alice')).toHaveLength(1);
    expect(alice.chat('bob')!.rooms).toHaveLength(2);
    expect(await alice.texts(alice.chat('bob'))).toEqual(['hi alice', 'new room, same chat']); // old history, then the new room
  });

  it('Quit: the owner sees the member left and can only close; deleting an ended chat removes it', async () => {
    const { alice, bob } = await talking();
    await bob.s.quitChat(bob.chat('alice')!.live!);
    expect(bob.chat('alice')!.rooms[0]!.ended?.how).toBe('quit');
    await expect(alice.s.quitChat(alice.chat('bob')!.live!)).rejects.toThrow(/close it but not quit/);
    await w.until(() => !!alice.chat('bob')?.rooms[0]?.peerLeft, 'alice sees bob left');
    await alice.s.closeChat(alice.chat('bob')!.live!);
    expect(alice.chat('bob')!.rooms[0]!.ended?.how).toBe('closed');
    await alice.s.deleteHistory(alice.chat('bob')!.key);
    expect(alice.chat('bob')).toBeUndefined();
  });

  it('blocking someone ends the DM with them', async () => {
    const { alice, bob } = await talking();
    await bob.s.block('github:alice');
    expect(bob.chat('alice')!.live).toBeUndefined();
    await w.until(() => !!alice.chat('bob')?.rooms[0]?.peerLeft || !!alice.chat('bob')?.rooms[0]?.ended, 'alice sees the chat end');
    await bob.s.unblock('github:alice');
    await alice.s.closeChat(alice.chat('bob')!.live ?? alice.chat('bob')!.current!).catch(() => undefined);
    await alice.s.startDm('bob');
    await w.until(() => !!bob.inviteFrom('alice'), 'after unblocking, invitations show again');
  });
});
