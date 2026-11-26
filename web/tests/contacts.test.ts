// Contacts: the key each person is trusted with is shared by all of an account's browsers, and
// sync by itself never swaps a trusted key: a different key shows as a key reset until a person
// lets it in (Invite again, or Accept on their invitation).
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

const BOB = 'github:bob';

describe('synced contacts', () => {
  it('a new browser inherits the remembered key: first contact happens once', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const first = await alice.s.peer(BOB);
    expect(first.status).toBe('ok');
    await w.rounds(2);

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live && alice2.s.contacts.syncedKey(BOB) === first.fingerprint, 'alice2 has the chat and the remembered key');
    const p = await alice2.s.peer(BOB, true);
    expect(p).toMatchObject({ status: 'ok', fingerprint: first.fingerprint });
    expect(p.firstSeen).toBe(alice.s.contacts.firstSeen(BOB));
    const people = alice2.s.people();
    expect(people.map((x) => x.login)).toEqual(['bob']);
    expect(people[0]!.dm?.live).toBeTruthy();
  });

  it('pins from a browser set up before sync go up when sync is turned on', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    // An old browser: no sync key yet.
    await alice.s.device.keystore.delete('chat-web/personal-key');
    const old = await w.reopen(alice);
    expect(old.s.syncOn).toBe(false);
    await w.dm(old, bob);
    const known = await old.s.peer(BOB);

    await old.s.enableSync(code);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => alice2.s.contacts.syncedKey(BOB) === known.fingerprint, 'the old browser’s key for bob reached the new one');
    await w.until(() => alice2.s.contacts.firstSeen(BOB) === old.s.contacts.firstSeen(BOB), 'with the time it was first seen');
  });

  it('a new browser warns when GitHub serves a different key than the account remembers; trusting it in one browser settles it for all', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const before = await alice.s.peer(BOB);
    await w.rounds(2);

    // Bob's key is replaced (a reset, or someone with his GitHub login).
    await bob.s.resetIdentity();
    const bobNew = await w.browser('bob');
    await bobNew.setup();

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => alice2.s.contacts.addresses().includes(BOB), 'alice2 read the synced contacts');
    const p = await alice2.s.peer(BOB, true);
    expect(p.status).toBe('key-changed'); // not a fresh first contact
    expect(p.fingerprint).not.toBe(before.fingerprint);
    // The first browser still trusts the old key: it warns too, and nothing swaps by itself.
    expect((await alice.s.peer(BOB, true)).status).toBe('key-changed');
    await w.rounds(2);
    expect(alice.s.contacts.pinned(BOB)).toBe(before.fingerprint);

    // A person lets the new key in on one browser (what Invite again and Accept do)...
    await alice2.s.acceptKeyChange(BOB);
    expect((await alice2.s.peer(BOB, true)).status).toBe('ok');
    // ...and the account's other browser goes by that: it is the key bob publishes.
    await w.until(async () => (await alice.s.peer(BOB, true)).status === 'ok', 'the first browser trusts the new key too');
    expect(alice.s.contacts.pinned(BOB)).toBe(p.fingerprint);
    expect(alice.s.contacts.conflict(BOB)).toBe(false);
  });

  it('a key the account remembers that the person does not publish never replaces this browser’s', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const real = await alice.s.peer(BOB);
    await w.rounds(2);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live && alice2.s.contacts.syncedKey(BOB) === real.fingerprint, 'alice2 has the synced pin');
    expect((await alice2.s.peer(BOB, true)).status).toBe('ok');

    // Another browser of alice's wrote a different key for bob into the synced store.
    await alice2.s.contacts.applyRemote(BOB, { pin: { fingerprint: 'f'.repeat(64), index: 0, hash: 'x' } });
    const p = await alice2.s.peer(BOB, true);
    expect(p).toMatchObject({ status: 'key-changed', fingerprint: real.fingerprint });
    // Lookups on this browser don't take the other key, and don't overwrite it...
    await alice2.s.peer(BOB, true);
    expect(alice2.s.contacts.conflict(BOB)).toBe(true);
    expect(alice2.s.contacts.pinned(BOB)).toBe(real.fingerprint);
    // ...only a person trusting the key GitHub serves does, for every browser.
    await alice2.s.acceptKeyChange(BOB);
    expect(alice2.s.contacts.conflict(BOB)).toBe(false);
    expect((await alice2.s.peer(BOB, true)).status).toBe('ok');
    await w.rounds(2);
    expect((await alice.s.peer(BOB, true)).status).toBe('ok');
  });

  it('Contacts lists group members and DM peers once each', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    await alice.setup();
    await bob.setup();
    await carol.setup();
    await w.dm(alice, bob);
    const { group } = await alice.s.createGroup('Hikers', ['bob', 'carol']);
    await w.until(() => !!bob.inviteFrom('alice') && !!carol.inviteFrom('alice'), 'invites arrive');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await carol.s.acceptInvite(carol.inviteFrom('alice')!.key);
    await w.until(() => group.members().length === 3, 'both joined');
    const people = alice.s.people();
    expect(people.map((p) => p.login)).toEqual(['bob', 'carol']);
    expect(people[0]!.dm).toBeTruthy();
    expect(people[0]!.groups.map((g) => g.title)).toEqual(['Hikers']);
    expect(people[1]!.dm).toBeUndefined();
  });
});
