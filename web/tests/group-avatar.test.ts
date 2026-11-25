// Group pictures: set at creation or later by an admin, reach every member and new browsers.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';
import { groupPattern, safeAvatar } from '../src/lib/group-avatar';

let w: World;
afterEach(() => w?.stop());

const PIC = 'data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAAfQ//73v/+BiOh/AAA=';
const PIC2 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP8=';

describe('group pictures', () => {
  it('only plain picture data URLs are shown', () => {
    expect(safeAvatar(PIC)).toBe(PIC);
    expect(safeAvatar('data:image/svg+xml;base64,PHN2Zz4=')).toBeUndefined();
    expect(safeAvatar('https://example.com/a.png')).toBeUndefined();
    expect(safeAvatar(`data:image/png;base64,${'A'.repeat(60_000)}`)).toBeUndefined();
  });

  it('the default pattern is the same for the same group, and differs between groups', () => {
    expect(groupPattern('abc')).toEqual(groupPattern('abc'));
    const all = new Set(Array.from({ length: 50 }, (_, i) => groupPattern(`g${i}`).d));
    expect(all.size).toBeGreaterThan(45);
  });

  it('a picture set when creating reaches members; an admin change and removal too, a member can\'t', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    const code = await alice.setup();
    for (const b of [bob, carol]) await b.setup();
    await alice.s.createGroup('Hikers', ['bob', 'carol'], undefined, PIC);
    expect(alice.chat('Hikers')?.avatar).toBe(PIC);
    await w.until(() => !!bob.inviteFrom('alice') && !!carol.inviteFrom('alice'), 'both see the invitation');
    for (const b of [bob, carol]) await b.s.acceptInvite(b.inviteFrom('alice')!.key);
    // They joined after the first meta message: alice's app repeats it for them.
    await w.until(() => bob.chat('Hikers')?.avatar === PIC && carol.chat('Hikers')?.avatar === PIC, 'both see the picture');

    await alice.s.setAvatar(alice.chat('Hikers')!.live!, PIC2);
    expect(alice.chat('Hikers')?.avatar).toBe(PIC2);
    await w.until(() => bob.chat('Hikers')?.avatar === PIC2, 'bob sees the new picture');
    await w.until(async () => (await bob.notes(bob.chat('Hikers'))).includes('@alice changed the group picture'), 'bob is told');
    expect(await alice.notes(alice.chat('Hikers'))).toContain('You changed the group picture');

    // A member who isn't an admin can't change it (their app wouldn't offer it; keyhold ignores it).
    await carol.s.setAvatar(carol.chat('Hikers')!.live!, PIC);
    await bob.s.send(bob.chat('Hikers')!.live!, 'after carol');
    await w.until(async () => (await alice.texts(alice.chat('Hikers'))).includes('after carol'), 'alice caught up');
    await w.rounds(2);
    expect(alice.chat('Hikers')?.avatar).toBe(PIC2);
    expect(bob.chat('Hikers')?.avatar).toBe(PIC2);

    // A new browser of alice's gets it when her first browser sees it join.
    const alice2 = await w.browser('alice');
    await alice2.restore(code);
    await w.until(() => alice2.chat('Hikers')?.avatar === PIC2, 'the new browser has the picture', 30);

    await alice.s.setAvatar(alice.chat('Hikers')!.live!, '');
    expect(alice.chat('Hikers')?.avatar).toBeUndefined();
    await w.until(() => bob.chat('Hikers')?.avatar === undefined, 'bob sees it removed');
    expect(await bob.notes(bob.chat('Hikers'))).toContain('@alice removed the group picture');
    await w.checkConverged();
  });
});
