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

  it('messages sent back to back reach both browsers of the receiver, none undecryptable', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joined');
    await bob.s.send(bob.chat('alice')!.live!, 'one');
    await w.until(async () => (await alice2.texts(alice2.chat('bob'))).includes('one'), 'alice2 got the first');

    // Enter pressed twice quickly: the second send starts before the first is posted.
    const g = bob.chat('alice')!.live!;
    await Promise.all([bob.s.send(g, 'two'), bob.s.send(g, 'three')]);
    const all = async (b: typeof alice) => (await b.texts(b.chat('bob'))).filter((t) => ['one', 'two', 'three'].includes(t)).length === 3;
    await w.until(async () => (await all(alice)) && (await all(alice2)), 'both browsers have all three');
    for (const b of [alice, alice2]) expect((await b.notes(b.chat('bob'))).filter((n) => n.includes('could not be decrypted'))).toEqual([]);
  });

  it('a burst typed quickly goes out in two writes and arrives as four messages, in order, everywhere', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const [codeA, codeB] = [await alice.setup(), await bob.setup()];
    await w.dm(alice, bob);
    const [alice2, bob2] = [await w.browser('alice'), await w.browser('bob')];
    await alice2.restore(codeA);
    await bob2.restore(codeB);
    await w.until(() => !!alice2.chat('bob')?.live && !!bob2.chat('alice')?.live, 'second browsers joined');
    await w.rounds(2);

    // 1, 2, 3, 4 typed fast: 1 goes out at once, the rest arrive while it is in flight.
    const g = bob.chat('alice')!.live!;
    const from = w.requests.length;
    const first = bob.s.send(g, '1');
    await Promise.resolve();
    await Promise.all([first, bob.s.send(g, '2'), bob.s.send(g, '3'), bob.s.send(g, '4')]);
    const writes = w.requests.slice(from).filter((r) => (r.method === 'PUT' && r.url.includes('/contents/mail/')) || (r.method === 'PATCH' && r.url.includes('/git/refs/')));
    expect(writes.map((r) => r.method)).toEqual(['PUT', 'PATCH']);

    const burst = async (b: typeof alice, peer: string) => (await b.texts(b.chat(peer))).filter((t) => ['1', '2', '3', '4'].includes(t));
    await w.until(async () => (await burst(alice, 'bob')).length === 4 && (await burst(alice2, 'bob')).length === 4 && (await burst(bob2, 'alice')).length === 4, 'all four everywhere');
    for (const [b, peer] of [[alice, 'bob'], [alice2, 'bob'], [bob, 'alice'], [bob2, 'alice']] as const) {
      expect(await burst(b, peer)).toEqual(['1', '2', '3', '4']);
      expect((await b.notes(b.chat(peer))).filter((n) => n.includes('could not be decrypted'))).toEqual([]);
    }
    expect(bob.s.sending.get(g.id)?.filter((p) => p.failed) ?? []).toEqual([]);
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
