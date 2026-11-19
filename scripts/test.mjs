#!/usr/bin/env node
// Runs the tests a change needs, picked from the files it touches.
//   npm run test:changed               changes since origin/main (committed, staged and unstaged)
//   npm run test:changed -- --base X   changes since X
//   npm run test:changed -- --all      everything
//   npm run test:changed -- --dry      only print the plan
//   npm run test:changed -- --dry --files a,b   the plan for these files
//
// Rules, first match wins per file (a file that matches nothing runs everything):
//   docs, *.md                                   nothing
//   worker/**                                    Worker tests
//   provider/tests/** (not the GitHub mock)      provider tests
//   web/tests/**                                 app scenarios (no browser)
//   web/tools/e2e*.mjs (one check)               that browser check
//   web/src/screens/**, ui.tsx, styles.css,
//     web/public/**, web/index.html              screen checks: menu, layout, pending
//   everything else (provider/src, web/src/lib,
//     App.tsx, config, mock backend, packages,
//     CI, this script)                           everything
// Type check and build always run unless only docs changed. They take seconds.
// The app scenarios (web/tests) are the chat rules without a browser and take a few seconds; the
// browser checks prove the screens are wired up.
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main';

const SCREEN_CHECKS = ['menu', 'layout', 'pending'];
const ALL_CHECKS = ['flow', 'pending', 'menu', 'layout'];
const E2E_FILES = { 'web/tools/e2e.mjs': 'flow', 'web/tools/e2e-pending.mjs': 'pending', 'web/tools/e2e-menu.mjs': 'menu', 'web/tools/e2e-layout.mjs': 'layout' };

function changedFiles() {
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], { encoding: 'utf8' }).trim();
  return [...new Set([...git('diff', '--name-only', mergeBase), ...git('ls-files', '--others', '--exclude-standard')])];
}

function plan(files) {
  const p = { typecheck: false, build: false, provider: false, scenarios: false, worker: false, e2e: new Set(), why: [] };
  const everything = (f) => {
    Object.assign(p, { typecheck: true, build: true, provider: true, scenarios: true, worker: true });
    ALL_CHECKS.forEach((c) => p.e2e.add(c));
    p.why.push(`${f}: everything`);
  };
  for (const f of files) {
    if (f.startsWith('docs/') || f.endsWith('.md')) continue;
    p.typecheck = p.build = true;
    if (f.startsWith('worker/')) { p.worker = true; p.why.push(`${f}: Worker tests`); }
    else if (f.startsWith('provider/tests/') && f !== 'provider/tests/github-mock.ts') { p.provider = true; p.why.push(`${f}: provider tests`); }
    else if (f.startsWith('web/tests/')) { p.scenarios = true; p.why.push(`${f}: app scenarios`); }
    else if (E2E_FILES[f]) { p.e2e.add(E2E_FILES[f]); p.why.push(`${f}: ${E2E_FILES[f]} check`); }
    else if (/^web\/src\/(screens\/|ui\.tsx$|styles\.css$)|^web\/public\/|^web\/index\.html$/.test(f)) {
      SCREEN_CHECKS.forEach((c) => p.e2e.add(c));
      p.why.push(`${f}: screen checks`);
    } else everything(f);
  }
  return p;
}

const files = flag('--all') ? ['(--all)'] : args.includes('--files') ? args[args.indexOf('--files') + 1].split(',') : changedFiles();
const p = plan(files);
const steps = [];
if (p.typecheck) steps.push(['type check', 'npm', ['run', 'typecheck']]);
if (p.provider) steps.push(['provider tests', 'npm', ['test', '-w', 'provider']]);
if (p.scenarios) steps.push(['app scenarios', 'npm', ['test', '-w', 'web']]);
if (p.worker) steps.push(['Worker tests', 'npm', ['test', '--prefix', 'worker']]);
if (p.build) steps.push(['build', 'npm', ['run', 'build']]);
const checks = ALL_CHECKS.filter((c) => p.e2e.has(c));
if (checks.length) steps.push([`browser checks: ${checks.join(', ')}`, 'npm', ['run', 'e2e', '--', ...checks]]);

console.log(`${files.length} changed file(s) since ${flag('--all') ? '-' : base}`);
for (const w of p.why) console.log(`  ${w}`);
console.log(steps.length ? `plan: ${steps.map((s) => s[0]).join(' -> ')}` : 'plan: nothing to run');
// In GitHub Actions, tell later steps whether the browser is needed, so it is only installed then.
if (process.env.GITHUB_OUTPUT) (await import('node:fs')).appendFileSync(process.env.GITHUB_OUTPUT, `e2e=${checks.length > 0}\n`);
if (flag('--dry') || !steps.length) process.exit(0);

for (const [name, cmd, a] of steps) {
  const t = Date.now();
  console.log(`\n>>> ${name}`);
  const r = spawnSync(cmd, a, { stdio: 'inherit' });
  console.log(`<<< ${name}: ${r.status === 0 ? 'ok' : 'FAILED'} in ${Math.round((Date.now() - t) / 1000)}s`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}
