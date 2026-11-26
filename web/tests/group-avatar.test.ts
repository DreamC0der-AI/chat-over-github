// Group pictures: set at creation or later by an admin, reach every member and new browsers.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';
import { fitCrop, groupPattern, MAX_ZOOM, safeAvatar } from '../src/lib/group-avatar';

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

  it('the crop stays inside the picture and zoom stays in range', () => {
    // 400 x 200 picture, 100 px crop square
    const start = fitCrop(400, 200, 100, 1, 200, 100);
    expect(start.crop).toEqual({ x: 100, y: 0, size: 200 });
    expect(start.scale).toBe(0.5);
    // dragged far past the left edge: stops at it
    expect(fitCrop(400, 200, 100, 1, -500, 100).crop).toEqual({ x: 0, y: 0, size: 200 });
    // zoomed 2x near the bottom-right corner
    expect(fitCrop(400, 200, 100, 2, 999, 999).crop).toEqual({ x: 300, y: 100, size: 100 });
    expect(fitCrop(400, 200, 100, 0.2, 200, 100).zoom).toBe(1);
    expect(fitCrop(400, 200, 100, 99, 200, 100).zoom).toBe(MAX_ZOOM);
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
    // A change on one of alice's browsers reaches her other one.
    await alice.s.setAvatar(alice.chat('Hikers')!.live!, PIC);
    await w.until(() => alice2.chat('Hikers')?.avatar === PIC, 'her other browser follows', 30);
    await alice2.s.setAvatar(alice2.chat('Hikers')!.live!, PIC2);
    await w.until(() => alice.chat('Hikers')?.avatar === PIC2 && bob.chat('Hikers')?.avatar === PIC2, 'and back', 30);

    // A browser of hers that missed the message (an older app took it) still gets it, from her synced chat list.
    type Rec = { avatar?: string };
    const recs = (b: typeof alice) => (b.s as unknown as { records: Map<string, Rec> }).records;
    const id = alice.chat('Hikers')!.key;
    const s2 = alice2.s as unknown as { onMessage: (g: unknown, m: { message: { t: string } }) => Promise<void> };
    const real = s2.onMessage.bind(alice2.s);
    s2.onMessage = async (g, m) => { if (m.message.t !== 'meta') await real(g, m); };
    await alice.s.setAvatar(alice.chat('Hikers')!.live!, PIC);
    await w.until(() => recs(alice2).get(id)?.avatar === PIC, 'the missed picture arrives through sync', 30);
    s2.onMessage = real;

    await alice.s.setAvatar(alice.chat('Hikers')!.live!, '');
    expect(alice.chat('Hikers')?.avatar).toBeUndefined();
    await w.until(() => bob.chat('Hikers')?.avatar === undefined, 'bob sees it removed');
    expect(await bob.notes(bob.chat('Hikers'))).toContain('@alice removed the group picture');
    await w.checkConverged();
  });
});
