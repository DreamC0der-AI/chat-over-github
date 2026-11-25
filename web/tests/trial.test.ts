// The one-request check on trial: asked next to the usual checks, compared, and never acted on.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('the one-request check, on trial', () => {
  it('agrees with the usual checks, counts an answer that lags as older, and a refusal changes nothing', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await w.rounds(2);
    const t = bob.s.trial;
    /** One more round of bob's, and the trial that rides on it. */
    const round = async () => {
      const n = t.rounds + t.failed;
      await bob.sync();
      await w.until(() => t.rounds + t.failed > n, 'the trial ran');
    };

    await round();
    expect(t.rounds).toBeGreaterThan(0);
    expect(t.same).toBeGreaterThan(0);
    expect([t.older, t.missing, t.failed]).toEqual([0, 0, 0]);
    // GitHub's one-request answer stops moving while the chat goes on: counted, and the message
    // still arrives the usual way.
    w.backend.gh.staleGraphql = true;
    await round();
    await alice.s.send(alice.chat('bob')!.live!, 'while it lags');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('while it lags'), 'bob reads it');
    await w.until(() => t.older > 0, 'the answer that lags was counted');
    w.backend.gh.staleGraphql = false;

    // GitHub refuses the one request, as if its allowance were used up: a failed round, and the
    // app's own requests are not held back.
    const failed = t.failed;
    w.fail((r) => r.login === 'bob' && r.url.endsWith('/graphql'), 403, { headers: { 'x-ratelimit-remaining': '0', 'retry-after': '600' } });
    await w.until(() => t.failed > failed, 'the refusal was counted');
    expect(t.failed).toBe(failed + 1);
    expect(t.last).toContain('403');
    await alice.s.send(alice.chat('bob')!.live!, 'after the refusal');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('after the refusal'), 'bob still syncs');

    // The numbers survive a reload.
    const rounds = t.rounds;
    const again = await w.reopen(bob);
    await w.until(() => again.s.trial.rounds >= rounds, 'the numbers were kept');
    expect(again.s.trial.older).toBeGreaterThan(0);
    await w.checkConverged();
  });
});
