// One account in two browsers: the second catches up from the synced chat list and the repos.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('two browsers of one account', () => {
  it('a catch-up join that finishes before the synced chat list is read still marks earlier messages as elsewhere', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await bob.s.send(bob.chat('alice')!.live!, 'before the new browser');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).length === 1, 'alice got it');
    alice.s.stop();

    const alice2 = await w.browser('alice');
    // Reading the synced chat list hangs (a slow phone) while the repo scan finds the chat.
    const held = w.hold((r) => r.login === 'alice' && /\/chat-home\/contents\/items$/.test(r.url));
    await alice2.restore(code);
    await held.started;
    const step = alice2.sync();
    for (let i = 0; i < 200 && !alice2.chat('bob')?.live; i++) await new Promise((r) => setTimeout(r, 10));
    held.release();
    await step;
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joined the DM');
    expect(alice2.chat('bob')!.rooms[0]!.joinedAt).toBeTruthy();
  });

  it("Accept on a new browser doesn't wait for it to catch up on other chats", async () => {
    w = await world();
    const [alice, bob, dave] = [await w.browser('alice'), await w.browser('bob'), await w.browser('dave')];
    const code = await alice.setup();
    await bob.setup();
    await dave.setup();
    await w.dm(alice, bob);
    const bobRoom = alice.chat('bob')!.live!.space;
    await dave.s.startDm('alice');

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    // Catching up on the chat with bob hangs (a slow phone).
    const held = w.hold((r) => r.login === 'alice' && r.url.includes(`/${bobRoom}/contents/drop`)); // the join's first read
    const step = alice2.sync();
    await held.started;
    for (let i = 0; i < 20 && !alice2.inviteFrom('dave'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(alice2.inviteFrom('dave')).toBeTruthy();
    // Accept goes ahead while that join still hangs.
    await alice2.s.acceptInvite(alice2.inviteFrom('dave')!.key);
    expect(alice2.chat('dave')?.live).toBeTruthy();
    expect(alice2.chat('bob')?.live).toBeUndefined();
    held.release();
    await step;
    await w.until(() => !!alice2.chat('bob')?.live && !!alice.chat('dave')?.live && !!dave.chat('alice')?.live, 'both chats on both browsers', 30);
    await w.checkConverged();
  });

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
  await w.checkConverged();
  });

  it("a new browser catches up on several chats in one sync step and doesn't rewrite the synced chat list", async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    const code = await alice.setup();
    await bob.setup();
    await carol.setup();
    await w.dm(alice, bob);
    await w.dm(alice, carol);
    for (const name of ['G1', 'G2', 'G3']) {
      await alice.s.createGroup(name, ['bob']);
      await w.until(() => !!bob.inviteFrom('alice'), `bob sees ${name}`);
      await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
      await w.until(() => !!bob.chat(name)?.live, `bob joined ${name}`);
    }
    for (const c of alice.chats()) await alice.s.send(c.live!, `hi ${c.title}`);
    await w.rounds(2);

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    const from = w.requests.length;
    await alice2.sync();
    expect(alice2.chats().filter((c) => c.live).length).toBe(5);
    expect(alice2.invites()).toEqual([]);
    // The chat list and read marks it pulled are already what the store says: no commit per chat
    // (before, 11 writes here; what's left is this browser's own contact pins).
    const puts = w.requests.slice(from).filter((r) => r.method === 'PUT' && r.url.includes('/chat-home/contents/items/'));
    expect(puts.length).toBeLessThanOrEqual(1);

    await bob.s.send(bob.chat('G2')!.live!, 'after the new browser');
    await w.until(async () => (await alice2.texts(alice2.chat('G2'))).includes('after the new browser'), 'the new browser reads G2');
    await w.checkConverged();
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
  await w.checkConverged();
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

  it('read on one browser clears the unread count on the other, even if it fetches the messages after the read mark', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joined');
    await w.rounds(2);
    for (const t of ['one', 'two', 'three']) await bob.s.send(bob.chat('alice')!.live!, t);
    // Only the first browser fetches them, and reads them.
    for (let i = 0; i < 5 && (await alice.texts(alice.chat('bob'))).length < 3; i++) await alice.sync();
    expect(alice.chat('bob')!.unread).toBe(3);
    alice.s.setActive(alice.chat('bob')!.key);
    alice.s.setActive(undefined);
    await alice.sync(2);
    // The second browser reads the read mark first, then fetches the messages.
    await alice2.sync(3);
    expect(await alice2.texts(alice2.chat('bob'))).toEqual(['one', 'two', 'three']);
    expect(alice2.chat('bob')!.unread).toBe(0);
    // A newer message is unread again on both.
    await bob.s.send(bob.chat('alice')!.live!, 'four');
    await w.until(() => alice.chat('bob')!.unread === 1 && alice2.chat('bob')!.unread === 1, 'one unread on both');
    await w.checkConverged();
  });
});
