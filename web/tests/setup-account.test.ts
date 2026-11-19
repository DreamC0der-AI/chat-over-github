// First run: the app waits for the GitHub App install, then makes the identity and its backup.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('first run', () => {
  it('waits for the install, then continues by itself and backs up the root key in chat-home', async () => {
    w = await world();
    const newbie = await w.browser('newbie'); // users named new* have no install until the hook below
    expect(newbie.s.phase).toBe('install');
    expect(await newbie.s.pollInstall()).toBe(false);
    await w.backend.fetch('http://mock.test/gh/mock/install', { method: 'POST', headers: { authorization: 'Bearer tok-newbie' } });
    await newbie.s.recheckInstall();
    expect(newbie.s.phase).toBe('new-identity');
    const code = await newbie.setup();
    expect(code).toMatch(/-/);
    expect(newbie.s.phase).toBe('ready');
    const backup = await w.backend.fetch('http://mock.test/gh/repos/newbie/chat-home/contents/vault/root', { headers: { authorization: 'Bearer tok-newbie' } });
    expect(backup.status).toBe(200);
  });

  it('a wrong recovery code does not open the backup; the right one does', async () => {
    w = await world();
    const alice = await w.browser('alice');
    const code = await alice.setup();
    const alice2 = await w.browser('alice');
    expect(alice2.s.phase).toBe('restore');
    const wrong = code.replace(/^\w/, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(alice2.restore(wrong)).rejects.toThrow();
    await alice2.restore(code);
    expect(alice2.s.phase).toBe('ready');
  });
});
