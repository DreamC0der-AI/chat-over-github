// GitHub hiccups: a refused request, a rate limit, a tab closed mid-write. None of them may end a
// chat or lose a change; the app retries and carries on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonalData } from 'keyhold/chat';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

type Inner = { kick?: () => void; tick: () => Promise<void>; flushPersonal: () => Promise<void>; push: (r: unknown) => void; startSync: () => Promise<void> };

describe('access lost for a moment', () => {
  it('one refused request does not end a chat: it shows as unreachable, is retried, and carries on', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    const space = bob.chat('alice')!.live!.space;
    // The provider double-checks a refused listing with a repo GET; fail both once, like a GitHub hiccup.
    w.fail((r) => r.login === 'bob' && r.method === 'GET' && r.url.endsWith(`${space}/contents/mail`), 403, { times: 1 });
    w.fail((r) => r.login === 'bob' && r.method === 'GET' && r.url.endsWith(`/repos/${space}`), 404, { times: 1 });
    await bob.sync();
    expect(bob.chat('alice')!.live).toBeUndefined();
    expect(bob.chat('alice')!.unreachable).toBe(true); // "Can't reach this chat. Retrying…", not "Ended"
    expect(bob.chat('alice')!.rooms[0]!.ended).toBeUndefined();

    // The retry backs off: the timer-driven step doesn't ask again right away.
    const s = bob.s as unknown as Inner;
    s.kick = undefined;
    const before = w.requests.length;
    await s.tick();
    expect(w.requests.slice(before).filter((r) => r.url.includes(space))).toEqual([]);

    // Also after a reload.
    const bob2 = await w.reopen(bob);
    await alice.s.send(alice.chat('bob')!.live!, 'still here');
    await w.until(async () => (await bob2.texts(bob2.chat('alice'))).includes('still here'), 'bob reads the chat again');
    expect(bob2.chat('alice')!.live).toBeTruthy();
    expect(bob2.chat('alice')!.unreachable).toBeFalsy();
    await bob2.s.send(bob2.chat('alice')!.live!, 'and I can write');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('and I can write'), 'alice gets it');
    await w.checkConverged();
  });
});

describe('rate limits', () => {
  it('a 429 shows the rate-limit wording and pauses syncing for a while', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    const g = bob.chat('alice')!.live!;
    w.fail((r) => r.login === 'bob' && r.method === 'GET' && r.url.endsWith(`${g.space}/contents/mail`), 429, { headers: { 'Retry-After': '120' } });
    await bob.sync();
    expect(bob.s.groupErrors.get(g.id)).toMatch(/rate limit/i);
    expect(bob.s.rateLimitedUntil).toBeGreaterThan(Date.now() + 30_000);

    // The timer-driven step makes no requests while paused.
    const s = bob.s as unknown as Inner;
    const kick = s.kick;
    s.kick = undefined;
    const before = w.requests.length;
    await s.tick();
    expect(w.requests.slice(before).filter((r) => r.url.startsWith('/gh/'))).toEqual([]);
    s.kick = kick;

    // Asking for a sync now still works, and the warning clears.
    await alice.s.send(alice.chat('bob')!.live!, 'after the pause');
    await w.until(async () => (await bob.texts(bob.chat('alice'))).includes('after the pause'), 'bob syncs again');
    expect(bob.s.groupErrors.has(g.id)).toBe(false);
    await w.checkConverged();
  });
});

describe('synced store writes', () => {
  it('a change queued just as a write finishes is not marked written, so a reload still sends it', async () => {
    w = await world();
    const alice = await w.browser('alice');
    const code = await alice.setup();
    const { group } = await alice.s.createGroup('Notes', []);
    await alice.sync(2);
    const r = alice.s.records.get(group.id)!;
    r.clearedAt = 12345;
    await alice.s.db.put('kv', r, `chat:${r.groupId}`);
    const s = alice.s as unknown as Inner;
    s.push(r);
    await s.flushPersonal();
    // The tab closes here.
    const again = await w.reopen(alice);
    await again.sync(2);
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => (alice2.s.records.get(group.id)?.clearedAt ?? 0) >= 12345, 'the other browser gets the change');
  });

  it('starting sync twice at once opens the synced store once', async () => {
    w = await world();
    const alice = await w.browser('alice');
    await alice.setup();
    await alice.sync();
    const s = alice.s as unknown as Inner & { personal?: unknown };
    s.personal = undefined;
    const open = vi.spyOn(PersonalData, 'open');
    await Promise.all([s.startSync(), s.startSync()]);
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });
});

describe('rate-limit errors from the provider', () => {
  it("the pause length comes from the provider's RateLimitError (seconds)", async () => {
    const { RateLimitError } = await import('chat-over-github-provider');
    const { retryAfterMs, isRateLimit } = await import('../src/lib/session');
    const e = new RateLimitError('GitHub rate limit reached; try again in 120s', 120);
    expect(isRateLimit(e)).toBe(true);
    expect(retryAfterMs(e)).toBe(120_000);
  });
});
