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

  it('downloads again only what changed: no settings, keys or log entries it already has', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    const code = await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    await alice.s.block('github:carol');
    await bob.s.send(bob.chat('alice')!.live!, 'hello');
    await w.until(async () => (await alice.texts(alice.chat('bob'))).includes('hello'), 'alice got it');
    await w.rounds(3);
    /** Single files read since `from`: synced-store items, directory entries, log entries. */
    const fileReads = (from: number) =>
      w.requests.slice(from).filter((r) => r.method === 'GET' && /\/contents\/(items\/[^/]+|dir\/[^/]+|log\/\d{5}\/\d{8})$/.test(r.url.replace(/\?.*$/, ''))).map((r) => r.url.replace(/^.*\/contents\//, '').replace(/\/[^/]+$/, ''));

    let from = w.requests.length;
    let again = await w.reopen(alice);
    await w.rounds(2);
    // (One read stays: the synced store's index, asked for by name before anything is listed.)
    expect(fileReads(from)).toEqual(['items']);
    expect(again.s.blocked.has('github:carol')).toBe(true);

    // Another browser of hers changes a setting and adds a device: only those are read.
    const other = await w.browser('alice');
    await other.restore(code);
    await other.s.block('github:dave');
    await w.rounds(3);
    from = w.requests.length;
    again = await w.reopen(again);
    await w.rounds(2);
    const reads = fileReads(from);
    expect(again.s.blocked.has('github:dave')).toBe(true);
    // The index, the changed setting, and at most the new device's directory entry.
    expect(reads.filter((r) => r === 'items').length).toBeLessThanOrEqual(3);
    expect(reads.filter((r) => r === 'dir').length).toBeLessThanOrEqual(1);
    expect(reads.filter((r) => r === 'log')).toEqual([]);
    await w.checkConverged();
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

describe('the files kept across reloads', () => {
  it('past the cap, a quarter are dropped, not all of them', async () => {
    w = await world();
    const alice = await w.browser('alice');
    await alice.setup();
    for (let i = 0; i < 1600; i++) await alice.s.db.put('kv', new Uint8Array([i & 255]), `blob:${i.toString(16).padStart(40, '0')}`);
    const again = await w.reopen(alice);
    await w.until(async () => (await again.s.db.keys('kv', 'blob:')).length <= 1200, 'pruned');
    const left = (await again.s.db.keys('kv', 'blob:')).length;
    expect(left).toBeGreaterThanOrEqual(1125);
    expect(left).toBeLessThanOrEqual(1200);
  });
});
