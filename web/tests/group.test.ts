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
    await w.until(async () => (await alice.notes(alice.chat('Weekend hikers'))).some((n) => n.includes('@carol left')), 'alice sees carol left');
    // She can't read the repo any more, so her app can only tell it's unavailable ("no longer available").
    await w.until(() => !!carol.chat('Weekend hikers') && !carol.chat('Weekend hikers')!.live, 'carol can no longer send there');
    expect(await carol.texts(carol.chat('Weekend hikers'))).toContain('carol here'); // she keeps her copy

    await bob.s.send(bob.chat('Weekend hikers')!.live!, 'after carol');
    await w.until(async () => (await alice.texts(alice.chat('Weekend hikers'))).includes('after carol'), 'the group goes on');
    await w.rounds(2);
    expect(await carol.texts(carol.chat('Weekend hikers'))).not.toContain('after carol');
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
    await w.until(() => !carol.chat('Hikers')?.live, 'carol is out');
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
