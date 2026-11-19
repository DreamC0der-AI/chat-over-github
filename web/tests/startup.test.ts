// Opening the app again (a reload): the chat shows from this browser's storage at once, and what
// needs GitHub (the install check, other browsers' changes) happens after, in the background.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

describe('reloading the app', () => {
  it('shows the chats and messages without waiting for GitHub', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await bob.s.send(bob.chat('alice')!.live!, 'hello');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('hello'), 'alice got it');

    w.offline = true; // GitHub unreachable: anything the first screen waited on would fail it
    const again = await w.reopen(alice);
    expect(again.s.phase).toBe('ready');
    expect(again.s.syncOn).toBe(true);
    expect(await again.texts(again.chat('bob'))).toEqual(['hello']);

    // Back online: syncing picks up again by itself.
    w.offline = false;
    await bob.s.send(bob.chat('alice')!.live!, 'still here');
    await w.until(async () => (await again.texts(again.chat('bob'))).includes('still here'), 'new message arrives after the network is back');
    await w.until(() => again.s.syncError === undefined && w.requests.some((r) => r.url.includes('/contents/items')), 'synced store read again');
  });

  it('writes nothing to the synced store when nothing changed', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await alice.s.block('github:carol');
    await w.rounds(3);

    w.requests.length = 0;
    const again = await w.reopen(alice);
    await w.rounds(3);
    const writes = w.requests.filter((r) => r.method !== 'GET' && r.url.includes('/alice/chat-home/'));
    expect(writes).toEqual([]);
    expect(again.s.blocked.has('github:carol')).toBe(true);
  });

  it('goes to the install screen when the app was uninstalled since the last visit', async () => {
    w = await world();
    const newbie = await w.browser('newbie');
    await w.backend.fetch('http://mock.test/gh/mock/install', { method: 'POST', headers: { authorization: 'Bearer tok-newbie' } });
    await newbie.s.pollInstall();
    await newbie.setup();
    expect(newbie.s.phase).toBe('ready');

    w.backend.installed.delete('newbie');
    const again = await w.reopen(newbie);
    await w.until(() => again.s.phase === 'install', 'install screen after the background check');

    await w.backend.fetch('http://mock.test/gh/mock/install', { method: 'POST', headers: { authorization: 'Bearer tok-newbie' } });
    expect(await again.s.pollInstall()).toBe(true);
    expect(again.s.phase).toBe('ready');
    await again.s.syncNow(); // the reopened chat runs its sync step again
  });
});
