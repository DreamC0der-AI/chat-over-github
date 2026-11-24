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
