// The computer slept with the app open: requests failed for a while, then the network came back.
// Warnings must clear by themselves, and a failed token refresh must not sign the person out.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';
import { currentToken, loadAuth, RefreshFailedError, SignedOutError } from '../src/lib/auth';

let w: World | undefined;
afterEach(() => {
  w?.stop();
  w = undefined;
});

describe('after sleep', () => {
  it('a chat whose sync failed while offline clears its warning when the tab comes back', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    const g = alice.chat('bob')!.live!;
    alice.s.activeConvo = alice.s.convoKey(alice.chat('bob')!.rooms[0]);

    // Only the chat's own requests fail (the connection dropped partway through a sync step).
    const harnessFetch = globalThis.fetch;
    globalThis.fetch = ((input: string, init?: RequestInit) =>
      String(input).includes(g.space) ? Promise.reject(new TypeError('Failed to fetch')) : harnessFetch(input, init)) as typeof fetch;
    await alice.sync();
    expect(alice.s.groupErrors.get(g.id)).toBe('Offline. Retrying…');

    globalThis.fetch = harnessFetch;
    // Nothing new in the chat, so GitHub's change check says "unchanged": the retry must not wait for news.
    const s = alice.s as unknown as { kick?: () => void; onWake: () => void; tick: () => Promise<void> };
    s.kick = undefined;
    s.onWake();
    await s.tick();
    expect(alice.s.groupErrors.has(g.id)).toBe(false);
  });
});

describe('token refresh', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    localStorage.removeItem('kh.auth');
  });
  const expired = (refreshToken: string) =>
    localStorage.setItem('kh.auth', JSON.stringify({ token: 'old', refreshToken, expiresAt: Date.now() - 1000, login: 'alice', id: 1 }));

  it('offline: keeps the sign-in and says it will retry', async () => {
    expired('rt-1');
    globalThis.fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
    await expect(currentToken()).rejects.toBeInstanceOf(RefreshFailedError);
    expect(loadAuth()?.refreshToken).toBe('rt-1');
  });

  it('a new token is saved straight away, without another request', async () => {
    expired('rt-1');
    const calls: string[] = [];
    globalThis.fetch = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response(JSON.stringify({ access_token: 'new', refresh_token: 'rt-2', expires_in: 28800 })));
    }) as typeof fetch;
    expect(await currentToken()).toBe('new');
    expect(loadAuth()).toMatchObject({ token: 'new', refreshToken: 'rt-2', login: 'alice', id: 1 });
    expect(calls).toHaveLength(1);
  });

  it('GitHub turning the refresh token down signs out', async () => {
    expired('rt-1');
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ error: 'bad_refresh_token' })))) as typeof fetch;
    await expect(currentToken()).rejects.toBeInstanceOf(SignedOutError);
    expect(loadAuth()).toBeUndefined();
  });

  it('a sign-in service error is not a sign-out', async () => {
    expired('rt-1');
    globalThis.fetch = (() => Promise.resolve(new Response('<html>502</html>', { status: 502 }))) as typeof fetch;
    await expect(currentToken()).rejects.toBeInstanceOf(RefreshFailedError);
    expect(loadAuth()?.refreshToken).toBe('rt-1');
  });

  it('an answer lost while asleep is asked again with the same retry key, and the stored key goes once the new tokens are saved', async () => {
    expired('rt-1');
    // A Worker like the real one: the first refresh spends rt-1 at GitHub; asking again gets the
    // cached answer only with the retry key that first asked.
    const bodies: { refresh_token: string; retry_key?: string }[] = [];
    let cachedFor: string | undefined;
    let n = 0;
    let loseAnswer = true;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)) as { refresh_token: string; retry_key?: string };
      bodies.push(b);
      let answer: object;
      if (b.refresh_token === 'rt-1' && cachedFor === undefined) {
        cachedFor = b.retry_key;
        answer = { access_token: 'new', refresh_token: 'rt-2', expires_in: 28800 };
      } else if (b.refresh_token === 'rt-1') {
        answer = b.retry_key && b.retry_key === cachedFor ? { access_token: 'new', refresh_token: 'rt-2', expires_in: 28800 } : { error: 'bad_refresh_token' };
      } else answer = { access_token: `new-${++n}`, refresh_token: `rt-${2 + n}`, expires_in: 28800 };
      if (loseAnswer) {
        loseAnswer = false;
        return Promise.reject(new TypeError('Failed to fetch')); // GitHub spent rt-1, the answer never came back
      }
      return Promise.resolve(new Response(JSON.stringify(answer)));
    }) as typeof fetch;
    await expect(currentToken()).rejects.toBeInstanceOf(RefreshFailedError);
    const kept = loadAuth()!;
    expect(kept.refreshToken).toBe('rt-1');
    expect(kept.retryKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(bodies[0].retry_key).toBe(kept.retryKey);
    // The tab comes back (even after a reload: the key is stored with the sign-in) and asks again.
    expect(await currentToken()).toBe('new');
    expect(bodies[1]).toEqual({ refresh_token: 'rt-1', retry_key: kept.retryKey });
    expect(loadAuth()).toMatchObject({ token: 'new', refreshToken: 'rt-2' });
    expect(loadAuth()?.retryKey).toBeUndefined();
    // The next refresh uses a fresh key.
    localStorage.setItem('kh.auth', JSON.stringify({ ...loadAuth(), expiresAt: Date.now() - 1000 }));
    expect(await currentToken()).toBe('new-1');
    expect(bodies[2].refresh_token).toBe('rt-2');
    expect(bodies[2].retry_key).toBeTruthy();
    expect(bodies[2].retry_key).not.toBe(kept.retryKey);
    expect(loadAuth()?.retryKey).toBeUndefined();
  });

  it("another tab's newer sign-in is never wiped by a stale refresh", async () => {
    expired('rt-1');
    globalThis.fetch = (() => {
      // Another tab refreshed meanwhile and saved its new tokens.
      localStorage.setItem('kh.auth', JSON.stringify({ token: 'theirs', refreshToken: 'rt-2', expiresAt: Date.now() + 8 * 3600e3, login: 'alice', id: 1 }));
      return Promise.resolve(new Response(JSON.stringify({ error: 'bad_refresh_token' })));
    }) as typeof fetch;
    await expect(currentToken()).rejects.toBeInstanceOf(SignedOutError);
    expect(loadAuth()?.token).toBe('theirs');
  });
});
