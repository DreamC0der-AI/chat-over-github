// Contacts: the keys each person is trusted with, and verified marks, are shared by all of an
// account's browsers, and sync never swaps a trusted key without the "key changed" warning.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

const BOB = 'github:bob';

describe('synced contacts', () => {
  it('a new browser inherits the remembered key and the verified mark: first contact happens once', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const first = await alice.s.peer(BOB);
    expect(first.status).toBe('ok');
    await alice.s.markVerified(BOB);
    expect((await alice.s.peer(BOB)).verified).toBe(true);

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live && alice2.s.contacts.verified(BOB), 'alice2 has the chat and the verified mark');
    const p = await alice2.s.peer(BOB, true);
    expect(p).toMatchObject({ status: 'ok', verified: true, fingerprint: first.fingerprint });
    expect(p.firstSeen).toBe(alice.s.contacts.firstSeen(BOB));
    const people = alice2.s.people();
    expect(people.map((x) => x.login)).toEqual(['bob']);
    expect(people[0]).toMatchObject({ verified: true, conflict: false });
    expect(people[0]!.dm?.live).toBeTruthy();
  });

  it('a verified mark made in a second browser reaches the first', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => !!alice2.chat('bob')?.live, 'alice2 joined');
    await alice2.s.peer(BOB);
    await alice2.s.markVerified(BOB);
    await w.until(async () => !!(await alice.s.peer(BOB)).verified, 'alice (first browser) shows it verified');
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
    await old.s.peer(BOB);
    await old.s.markVerified(BOB);

    await old.s.enableSync(code);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => alice2.s.contacts.verified(BOB), 'the old browser’s verified mark reached the new one');
  });

  it('a new browser warns when GitHub serves a different key than the account remembers', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const before = await alice.s.peer(BOB);
    await w.rounds(2);

    // Bob's identity is replaced (a reset, or someone with his GitHub login).
    await bob.s.resetIdentity();
    const bobNew = await w.browser('bob');
    await bobNew.setup();

    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => alice2.s.contacts.addresses().includes(BOB), 'alice2 read the synced contacts');
    const p = await alice2.s.peer(BOB, true);
    expect(p.status).toBe('key-changed'); // not a fresh first contact
    expect(p.fingerprint).not.toBe(before.fingerprint);

    // Accepting it in one browser settles it for the account: the first browser's warning is
    // GitHub's (it still pins the old key), and it clears once it accepts too.
    await alice2.s.acceptKeyChange(BOB);
    expect((await alice2.s.peer(BOB, true)).status).toBe('ok');
    expect((await alice.s.peer(BOB, true)).status).toBe('key-changed');
  });

  it('two browsers trusting different keys show the warning instead of one replacing the other', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    const real = await alice.s.peer(BOB);
    await alice.s.markVerified(BOB);
    await w.rounds(2);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => alice2.s.contacts.verified(BOB), 'alice2 has the synced pin');
    expect((await alice2.s.peer(BOB, true)).status).toBe('ok');

    // Another browser of alice's wrote a different key for bob into the synced store.
    await alice2.s.contacts.applyRemote(BOB, { pin: { fingerprint: 'f'.repeat(64), index: 0, hash: 'x' }, verifiedKey: 'f'.repeat(64) });
    const p = await alice2.s.peer(BOB, true);
    expect(p).toMatchObject({ status: 'key-changed', otherBrowser: true, verified: false, fingerprint: real.fingerprint });
    expect(alice2.s.people()[0]).toMatchObject({ conflict: true, verified: false });
    // Lookups on this browser don't overwrite the other key...
    await alice2.s.peer(BOB, true);
    expect(alice2.s.contacts.conflict(BOB)).toBe(true);
    // ...only accepting the key GitHub serves does, for every browser.
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
  it('the safety number of a known contact shows without asking GitHub, the same as after the check', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await alice.s.peer('github:bob', true);
    const before = w.requests.length;
    const known = await alice.s.knownPeer('github:bob');
    expect(w.requests.length).toBe(before);
    const checked = await alice.s.peer('github:bob', true);
    expect(known).toMatchObject({ status: 'ok', fingerprint: checked.fingerprint, safety: checked.safety });
    expect(await alice.s.knownPeer('github:carol')).toBeUndefined(); // never seen: wait for the check
  });
});
