// One account in two browsers: the second catches up from the synced chat list and the repos.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('two browsers of one account', () => {
  it('a new browser joins existing chats by itself, never as an invitation from yourself', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await bob.s.send(bob.chat('alice')!.live!, 'before the new browser');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).length === 1, 'alice got it');

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => {
      expect(alice2.invites().filter((i) => i.status === 'invited')).toEqual([]); // never asks her to accept her own chat
      return !!alice2.chat('bob')?.live;
    }, 'alice2 joined the DM');
    expect(alice2.chat('bob')!.rooms[0]!.joinedAt).toBeTruthy(); // "Earlier messages aren't on this browser"
    expect(await alice2.texts(alice2.chat('bob'))).toEqual([]);

    await bob.s.send(bob.chat('alice')!.live!, 'for both browsers');
    await w.until(async () => (await alice2.texts(alice2.chat('bob'))).includes('for both browsers') && (await alice.texts(alice.chat('bob'))).includes('for both browsers'), 'both browsers get it');
  });

  it('Delete chat, close, and deleting an ended chat reach the other browser', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joined');
    await bob.s.send(bob.chat('alice')!.live!, 'clear me');
    await w.until(async () => (await alice2.texts(alice2.chat('bob'))).includes('clear me'), 'alice2 got it');

    await alice.s.deleteHistory(alice.chat('bob')!.key);
    await w.until(async () => (await alice2.texts(alice2.chat('bob'))).length === 0, "alice's delete reached alice2");
    expect(alice2.chat('bob')?.live).toBeTruthy();

    await alice.s.closeChat(alice.chat('bob')!.live!);
    await w.until(() => alice2.chat('bob')?.rooms[0]?.ended?.how === 'closed', 'alice2 shows the close');
    await alice.s.deleteHistory(alice.chat('bob')!.key);
    await w.until(() => !alice2.chat('bob'), 'and the deleted ended chat leaves alice2 too');
  });

  it("a new room started by the other person reaches the second browser through the synced chat list", async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joined');
    await alice.s.closeChat(alice.chat('bob')!.live!);
    await w.until(() => !bob.chat('alice')?.live && !alice2.chat('bob')?.live, 'closed everywhere');

    await bob.s.startDm('alice');
    await w.until(() => !!alice.inviteFrom('bob'), 'alice sees it');
    await alice.s.acceptInvite(alice.inviteFrom('bob')!.key);
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joins the new room without an Accept');
    expect(alice2.chat('bob')!.rooms.at(-1)!.joinedAt).toBeUndefined(); // new room: nothing earlier to miss
    await bob.s.send(bob.chat('alice')!.live!, 'new room');
    await w.until(async () => (await alice2.texts(alice2.chat('bob'))).includes('new room'), 'alice2 gets new messages');
  });
});
