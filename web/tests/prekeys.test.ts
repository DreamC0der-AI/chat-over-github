// Pre-keys: people are added while offline, so a new chat can be written to before they accept.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

const preKeys = (login: string) =>
  w.requests.filter((r) => r.method === 'PUT' && r.url.includes(`/repos/${login}/keyhold-id/contents/prekeys/`)).length;

describe('pre-keys', () => {
  it('every account publishes a pre-key by itself, also one set up before pre-keys existed', async () => {
    w = await world();
    const bob = await w.browser('bob');
    await bob.setup();
    await w.until(() => preKeys('bob') === 1, 'bob published a pre-key');
    // A reload doesn't publish again while the key is fresh.
    await w.reopen(bob);
    await w.rounds(3);
    expect(preKeys('bob')).toBe(1);
  });

  it('a new group can be written to at once; invitees read it all when they accept', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await w.until(() => preKeys('bob') === 1 && preKeys('carol') === 1, 'pre-keys published');

    await alice.s.createGroup('Hikers', ['bob', 'carol']);
    const g = alice.chat('Hikers')!.live!;
    expect(g.members()).toHaveLength(3); // added right away...
    expect(alice.s.pending(g).sort()).toEqual(['github:bob', 'github:carol']); // ...but not joined
    expect(alice.s.joinedMembers(g)).toHaveLength(1);
    await alice.s.send(g, 'before anyone accepted');

    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(async () => (await bob.texts(bob.chat('Hikers'))).includes('before anyone accepted'), 'bob reads the early message');
    await w.until(async () => (await alice.notes(alice.chat('Hikers'))).some((n) => n.includes('@bob joined')), 'alice sees bob join');
    expect(alice.s.pending(g)).toEqual(['github:carol']);
    expect(await bob.notes(bob.chat('Hikers'))).not.toContain('A message could not be decrypted.');
    expect(bob.chat('Hikers')).toBeDefined(); // the group name reached him
  });

  it('accepting while the regular check runs joins once: no rejected changes, everyone reads everyone', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await w.until(() => preKeys('bob') === 1 && preKeys('carol') === 1, 'pre-keys published');
    await alice.s.createGroup('Hikers', ['bob', 'carol']);
    await alice.s.send(alice.chat('Hikers')!.live!, 'hi');
    await w.until(() => !!bob.inviteFrom('alice') && !!carol.inviteFrom('alice'), 'both see the invitation');
    // Accept lands while the app's own sync step (which also looks for invitations) is running.
    await Promise.all([bob.s.acceptInvite(bob.inviteFrom('alice')!.key), bob.sync(), carol.s.acceptInvite(carol.inviteFrom('alice')!.key), carol.sync()]);
    await w.until(async () => (await alice.notes(alice.chat('Hikers'))).filter((n) => n.endsWith('joined')).length === 2, 'alice sees both join');
    await bob.s.send(bob.chat('Hikers')!.live!, 'from bob');
    await carol.s.send(carol.chat('Hikers')!.live!, 'from carol');
    for (const b of [alice, bob, carol]) {
      await w.until(async () => (await b.texts(b.chat('Hikers'))).length === 3, `${b.login} has all three messages`);
      expect((await b.texts(b.chat('Hikers'))).sort()).toEqual(['from bob', 'from carol', 'hi']);
      const notes = await b.notes(b.chat('Hikers'));
      expect(notes.filter((n) => /rejected|could not be decrypted/.test(n))).toEqual([]);
      const joins = notes.filter((n) => n.endsWith('joined'));
      expect(new Set(joins).size).toBe(joins.length); // no join shown twice
    }
  });

  it('a DM: the message box is open before they accept, and they get what was sent', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.until(() => preKeys('bob') === 1, 'bob published a pre-key');
    await alice.s.startDm('bob');
    const g = alice.chat('bob')!.live!;
    expect(g.members()).toHaveLength(2);
    await alice.s.send(g, 'hi, are you there?');
    await w.until(() => !!bob.inviteFrom('alice'), 'bob sees the invitation');
    await bob.s.acceptInvite(bob.inviteFrom('alice')!.key);
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('hi, are you there?'), 'bob reads it');
    await bob.s.send(bob.chat('alice')!.live!, 'yes');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('yes'), 'alice gets the reply');
  });

  it('a new chat is made without reading it back, and joined with one look at each thing', async () => {
    w = await world();
    const [alice, carol] = [await w.browser('alice'), await w.browser('carol')];
    await alice.setup();
    await carol.setup();
    await w.until(() => preKeys('carol') === 1, 'pre-key published');
    await w.rounds(2);
    /** What went to the chat's repo since `from`, as "METHOD what", sorted. */
    const toChat = (from: number) =>
      w.requests
        .slice(from)
        .filter((r) => r.url.includes('/ghchat-'))
        .map((r) => `${r.method} ${/\/(compare|commits|collaborators|topics|rulesets|actions|invitations|contents\/(?:mail|drop|log\/\d{5}\/\d{8}|log))\b/.exec(r.url)?.[1] ?? 'repo'}`)
        .sort();

    // Writes only: nothing is asked of a repo that was made a moment ago. (Its settings, the
    // chat's first two log entries, carol's ticket and welcome, and her invitation.)
    let from = w.requests.length;
    await alice.s.startDm('carol');
    expect(toChat(from)).toEqual([
      'POST rulesets',
      'PUT actions',
      'PUT collaborators',
      'PUT contents/drop',
      'PUT contents/drop',
      'PUT contents/log/00000/00000000',
      'PUT contents/log/00000/00000001',
      'PUT topics',
    ]);

    // Joining: her drops (listed, both read, the Welcome and the unused ticket deleted without a
    // second read; a ticket left behind would keep her repo access after a removal), the log
    // (listed, its two entries read, hers written without asking for the one before), the mail
    // (nothing yet, and no second look at the repo).
    await w.until(() => !!carol.inviteFrom('alice'), 'carol sees the invitation');
    from = w.requests.length;
    await carol.s.acceptInvite(carol.inviteFrom('alice')!.key);
    expect(toChat(from)).toEqual([
      'DELETE contents/drop',
      'DELETE contents/drop',
      'GET commits',
      'GET compare',
      'GET contents/drop',
      'GET contents/drop',
      'GET contents/drop',
      'GET contents/log',
      'GET contents/log/00000/00000000',
      'GET contents/log/00000/00000001',
      'GET contents/mail',
      'PUT contents/log/00000/00000002',
    ]);

    // And the chat works both ways.
    await alice.s.send(alice.chat('carol')!.live!, 'hello');
    await carol.s.send(carol.chat('alice')!.live!, 'hi');
    await w.until(async () => (await carol.texts(carol.chat('alice'))).includes('hello'), 'carol reads alice');
    await w.until(async () => (await alice.texts(alice.chat('carol'))).includes('hi'), 'alice reads carol');
    await w.checkConverged();
  });
});
