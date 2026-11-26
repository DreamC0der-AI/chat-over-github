#!/usr/bin/env node
// Keeps the files of earlier builds in the deploy, so a page that loaded before a deploy still finds
// its stylesheet and script chunks afterwards. Without this, a deploy replaces every hashed file in
// public/assets/, and a tab that a browser restores or reloads from its cache (Safari does this)
// asks for files that are gone: the page renders without styles, or a lazy chunk fails to load.
//
// Wrangler runs this before every deploy ([build] in wrangler.toml). It reads the live site:
//   - the build it serves now (from index.html, following the chunks each script imports), and
//   - the builds it already keeps (kept-assets.json),
// downloads those files into public/assets/ next to the new build, and writes the new
// kept-assets.json. A build is kept for KEEP_DAYS after it stops being the live one. Files are
// named by their content hash, so an old file never clashes with a new one.
//
// When the live site can't be reached the deploy still goes ahead, with only the new build.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_DAYS = 7;
export const MAX_BUILDS = 60;
const MANIFEST = 'kept-assets.json';

/** The /assets/ file names a page or script refers to: "assets/x-HASH.js" or a chunk's "./x-HASH.js". */
export function assetRefs(text) {
  const names = new Set();
  for (const m of text.matchAll(/(?:assets\/|["'`]\.\/)([\w.-]+\.(?:js|css|wasm|svg|png|woff2?))(?=["'`?#)\s])/g)) names.add(m[1]);
  return [...names];
}

/** Every file a build needs, starting from its index.html and following each script's imports. */
export async function crawlBuild(html, get) {
  const seen = new Set();
  const queue = assetRefs(html);
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
    const res = await get(`/assets/${name}`);
    if (!res.ok) continue;
    for (const ref of assetRefs(await res.text())) if (!seen.has(ref)) queue.push(ref);
  }
  return [...seen].sort();
}

/**
 * The builds to keep after this deploy: the live one (retired now) and earlier ones still within
 * KEEP_DAYS, without any whose files are all in the new build anyway (a redeploy of the same code).
 */
export function nextManifest(previous, live, newFiles, now = Date.now()) {
  const inNew = new Set(newFiles);
  const cutoff = now - KEEP_DAYS * 86_400_000;
  const builds = [];
  if (live && live.files.length) builds.push({ retired: new Date(now).toISOString(), files: live.files });
  for (const b of previous?.builds ?? []) {
    if (!Array.isArray(b?.files) || !(Date.parse(b.retired) >= cutoff)) continue;
    if (builds.some((k) => k.files.join() === b.files.join())) continue;
    builds.push({ retired: b.retired, files: b.files });
  }
  return { builds: builds.filter((b) => b.files.some((f) => !inNew.has(f))).slice(0, MAX_BUILDS) };
}

async function main() {
  const dir = new URL('./public/', import.meta.url).pathname;
  const assets = join(dir, 'assets');
  if (!existsSync(assets)) {
    console.warn('keep-old-assets: no public/assets (run npm run build first); nothing kept');
    return;
  }
  const origin = process.env.LIVE_ORIGIN ?? 'https://chat-over-github.sunzy.app';
  const get = (path) => fetch(origin + path, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  const newFiles = readdirSync(assets);

  let live, previous;
  try {
    const page = await get('/');
    if (!page.ok) throw new Error(`index.html: HTTP ${page.status}`);
    live = { files: await crawlBuild(await page.text(), get) };
    const kept = await get(`/${MANIFEST}`);
    previous = kept.ok ? await kept.json() : { builds: [] };
  } catch (e) {
    console.warn(`keep-old-assets: can't read ${origin} (${e.message}); deploying without earlier builds`);
    return;
  }

  const manifest = nextManifest(previous, live, newFiles);
  const have = new Set(newFiles);
  let copied = 0;
  for (const name of new Set(manifest.builds.flatMap((b) => b.files))) {
    if (have.has(name) || !/^[\w.-]+$/.test(name)) continue;
    const res = await get(`/assets/${name}`).catch(() => undefined);
    if (!res?.ok) {
      console.warn(`keep-old-assets: ${name} is gone from the live site, skipped`);
      continue;
    }
    writeFileSync(join(assets, name), Buffer.from(await res.arrayBuffer()));
    have.add(name);
    copied++;
  }
  writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest, null, 1) + '\n');
  console.log(`keep-old-assets: kept ${manifest.builds.length} earlier build(s), downloaded ${copied} file(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
