import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetRefs, crawlBuild, nextManifest, KEEP_DAYS } from '../keep-old-assets.mjs';

test('finds the files a page and its chunks refer to', async () => {
  const files = {
    '/assets/index-A.js': 'const m=["assets/chacha-B.js","assets/index-C.css"];import("./nist-D.js")',
    '/assets/nist-D.js': 'import{x}from"./index-A.js";',
    '/assets/chacha-B.js': '',
    '/assets/index-C.css': 'body{}',
  };
  const get = async (p) => (p in files ? { ok: true, text: async () => files[p] } : { ok: false });
  const html = '<script type="module" src="/assets/index-A.js"></script><link rel="stylesheet" href="/assets/index-C.css">';
  assert.deepEqual(await crawlBuild(html, get), ['chacha-B.js', 'index-A.js', 'index-C.css', 'nist-D.js']);
  assert.deepEqual(assetRefs('<link href="/favicon.svg">'), []);
});

test('keeps the live build and recent ones, drops old ones and ones the new build has', () => {
  const now = Date.parse('2026-11-26T00:00:00Z');
  const day = 86_400_000;
  const previous = {
    builds: [
      { retired: new Date(now - day).toISOString(), files: ['index-1.js', 'shared.js'] },
      { retired: new Date(now - (KEEP_DAYS + 1) * day).toISOString(), files: ['index-0.js'] },
      { retired: 'nonsense', files: ['x.js'] },
    ],
  };
  const m = nextManifest(previous, { files: ['index-2.js', 'shared.js'] }, ['index-3.js', 'shared.js'], now);
  assert.deepEqual(m.builds.map((b) => b.files), [['index-2.js', 'shared.js'], ['index-1.js', 'shared.js']]);
  // A redeploy of the same build keeps nothing extra.
  assert.deepEqual(nextManifest({ builds: [] }, { files: ['a.js'] }, ['a.js'], now).builds, []);
});
