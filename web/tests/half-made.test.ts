// Chats whose creation stopped part way: the repo exists, but its first log entry never went up
// (GitHub failed, or the tab closed). The browser that started it finishes it; an empty repo
// nobody can finish is deleted instead of showing as "Waiting for another member" forever.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => {
  vi.restoreAllMocks();
  w?.stop();
});

/** Move this process's clock forward (keyhold and the app both read Date.now). */
function later() {
  const real = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
  return (ms: number) => void (offset += ms);
}

describe('half-made chats', () => {
  it('a group whose first log entry failed is finished by the next scan, not shown as an invitation', async () => {
    w = await world();
    const alice = await w.browser('alice');
    await alice.setup();
    const skip = later();
    w.fail((r) => r.login === 'alice' && r.method === 'PUT' && r.url.includes('/contents/log/'), 500, { times: 3 });
    await expect(alice.s.createGroup('Plans', [])).rejects.toBeTruthy();
    await alice.sync();
    expect(alice.invites()).toEqual([]);
    expect(alice.chat('Plans')).toBeUndefined();
    skip(61_000); // keyhold leaves a creation alone for a minute (it may still be running)
    await alice.sync();
    expect(alice.chat('Plans')?.live).toBeTruthy();
    expect(alice.invites()).toEqual([]);
  });

  it('an own repo with nothing in it is hidden, then deleted after ten minutes (older leftovers too)', async () => {
    w = await world();
    const alice = await w.browser('alice');
    await alice.setup();
    // A leftover from an older app that stopped right after making the repo.
    const made = await w.backend.fetch('http://mock.test/gh/user/repos', { method: 'POST', headers: { authorization: 'Bearer tok-alice' }, body: JSON.stringify({ name: 'ghchat-leftover', private: true, auto_init: true }) });
    expect(made.status).toBe(201);
    const skip = later();
    await alice.sync();
    expect(alice.invites()).toEqual([]); // not "Waiting for another member"
    expect(w.backend.gh.repos.has('alice/ghchat-leftover')).toBe(true);
    skip(11 * 60_000);
    await alice.sync();
    expect(w.backend.gh.repos.has('alice/ghchat-leftover')).toBe(false);
    expect(alice.invites()).toEqual([]);
    expect(alice.chats()).toEqual([]);
  });
});
