// Avatars kept across reloads: shown at once from this browser, re-checked with the CDN at most
// once an hour with If-None-Match, and replaced only when the picture really changed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _avatarsForTest, CHECK_MS, forgetAvatars } from '../src/lib/avatars';

const g = globalThis as Record<string, unknown>;
let store: Map<string, string>;
let calls: { url: string; inm?: string }[];
let served: { etag: string; body: string };

beforeEach(() => {
  store = new Map();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  // No canvas under Node: the kept copy is the original bytes as a data URL.
  g.FileReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(b: Blob) {
      void b.arrayBuffer().then((buf) => {
        this.result = `data:${b.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      });
    }
  };
  calls = [];
  served = { etag: '"v1"', body: 'one' };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const inm = (init.headers as Record<string, string>)['If-None-Match'];
    calls.push({ url, inm });
    if (inm === served.etag) return new Response(null, { status: 304, headers: { ETag: served.etag } });
    return new Response(new Blob([served.body], { type: 'image/jpeg' }), { status: 200, headers: { ETag: served.etag } });
  });
  _avatarsForTest.reset();
});
afterEach(() => vi.unstubAllGlobals());

const kept = (login: string) => JSON.parse(store.get('cog.avatar.' + login)!) as { d: string; e: string; t: number };
const reload = () => _avatarsForTest.reset();

describe('avatars', () => {
  it('downloads once, then a reload within the hour makes no request', async () => {
    await _avatarsForTest.check('alice', 1000);
    expect(calls).toHaveLength(1);
    expect(kept('alice').d).toBe(`data:image/jpeg;base64,${Buffer.from('one').toString('base64')}`);
    reload();
    await _avatarsForTest.check('alice', 1000 + CHECK_MS - 1);
    expect(calls).toHaveLength(1);
  });

  it('after the hour asks with the ETag; an unchanged picture is a 304 and keeps the copy', async () => {
    await _avatarsForTest.check('alice', 1000);
    const before = kept('alice');
    reload();
    await _avatarsForTest.check('alice', 1000 + CHECK_MS);
    expect(calls[1]).toMatchObject({ inm: '"v1"' });
    expect(kept('alice')).toEqual({ ...before, t: 1000 + CHECK_MS });
  });

  it('a changed picture replaces the kept copy', async () => {
    await _avatarsForTest.check('alice', 1000);
    served = { etag: '"v2"', body: 'two' };
    reload();
    await _avatarsForTest.check('alice', 1000 + CHECK_MS);
    expect(kept('alice')).toMatchObject({ e: '"v2"', d: `data:image/jpeg;base64,${Buffer.from('two').toString('base64')}` });
  });

  it('offline keeps the kept copy; Forget this browser removes them all', async () => {
    await _avatarsForTest.check('alice', 1000);
    vi.stubGlobal('fetch', async () => { throw new TypeError('offline'); });
    reload();
    await _avatarsForTest.check('alice', 1000 + CHECK_MS);
    expect(kept('alice').e).toBe('"v1"');
    forgetAvatars();
    expect(store.size).toBe(0);
  });
});
