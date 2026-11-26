// GitHub answers some reads from a copy a moment behind the latest commit. A chat must come
// through that whole: nothing skipped, nothing filed at the wrong place, no lasting warning.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('GitHub answering from a copy a moment behind', () => {
  it('a log listing that misses the newest change does not break the chat for that browser', async () => {
    w = await world();
    const [alice, bob0, carol, dave] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol'), await w.browser('dave')];
    for (const b of [alice, bob0, carol, dave]) await b.setup();
    await alice.s.createGroup('Hikers', ['bob', 'carol', 'dave']);
    await w.until(() => [bob0, carol, dave].every((b) => !!b.inviteFrom('alice')), 'all see the invitation');
    for (const b of [bob0, carol, dave]) await b.s.acceptInvite(b.inviteFrom('alice')!.key);
    await w.until(() => [bob0, carol, dave].every((b) => !!b.chat('Hikers')?.live), 'all joined');
    await w.rounds(2);
    bob0.s.stop();

    const fp = (login: string) => alice.chat('Hikers')!.live!.members().find((m) => m.address === `github:${login}`)!.fingerprint;
    // While bob's app is closed, alice removes carol: a log entry bob hasn't seen.
    await alice.s.removeMember(alice.chat('Hikers')!.live!, fp('carol'));
    await alice.sync();
    // Bob opens the app; his listings of the log come from a copy without that entry.
    w.backend.gh.faults = { laggingListing: { times: 2, match: (r) => r.user === 'bob' && /contents\/log\/\d{5}$/.test(r.path) } };
    const bob = await w.reopen(bob0);
    await bob.sync();
    expect(w.backend.gh.faultLog.some((l) => l.startsWith('laggingListing'))).toBe(true);
    w.backend.gh.faults = undefined;
    // Then she removes dave: what bob's app knows is the old listing plus this entry, with a hole.
    await alice.s.removeMember(alice.chat('Hikers')!.live!, fp('dave'));
    await alice.sync();
    // Bob's next steps only ask what changed (his last full listing was a moment ago).
    await bob.check();
    await bob.check();
    expect([...bob.s.groupErrors.values()]).toEqual([]);
    expect(bob.chat('Hikers')!.live!.members().map((m) => m.address).sort()).toEqual(['github:alice', 'github:bob']);
    await bob.s.send(bob.chat('Hikers')!.live!, 'still here');
    await w.until(async () => (await alice.texts(alice.chat('Hikers'))).includes('still here'), 'alice reads bob');
    await w.checkConverged();
  });
});
