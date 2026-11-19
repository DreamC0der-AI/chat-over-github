// Runs the browser end-to-end checks, each against its own fresh mock backend (GitHub + Worker in
// memory), all at the same time on separate ports. Output is printed per check once it finishes.
//   node tools/e2e-run.mjs                 every check
//   node tools/e2e-run.mjs menu layout     only these (names from SCRIPTS below)
//   E2E_SERIAL=1 node tools/e2e-run.mjs    one after another (easier to read while debugging)
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const SCRIPTS = { flow: 'tools/e2e.mjs', pending: 'tools/e2e-pending.mjs', menu: 'tools/e2e-menu.mjs', layout: 'tools/e2e-layout.mjs' };
const picked = process.argv.slice(2);
for (const n of picked) if (!SCRIPTS[n]) { console.error(`unknown check "${n}"; known: ${Object.keys(SCRIPTS).join(', ')}`); process.exit(2); }
const names = picked.length ? picked : Object.keys(SCRIPTS);
const basePort = Number(process.env.PORT ?? 8787);

const listening = (port) => new Promise((ok) => {
  const s = connect(port, '127.0.0.1', () => { s.end(); ok(true); });
  s.on('error', () => ok(false));
});

async function run(name, port) {
  const started = Date.now();
  let out = '';
  const server = spawn(process.execPath, ['tools/mock-server.mjs', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !(await listening(port)); i++) await new Promise((r) => setTimeout(r, 50));
  const e2e = spawn(process.execPath, [SCRIPTS[name]], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BASE: `http://localhost:${port}/`, SHOTS: `${process.env.SHOTS ?? '/tmp/e2e'}/${name}` },
  });
  e2e.stdout.on('data', (d) => (out += d));
  e2e.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => e2e.on('exit', r));
  server.kill();
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n===== ${name} (${SCRIPTS[name]}): ${code === 0 ? 'passed' : 'FAILED'} in ${secs}s =====\n${out}`);
  return { name, code, secs };
}

const t0 = Date.now();
const results = [];
if (process.env.E2E_SERIAL) for (const [i, n] of names.entries()) results.push(await run(n, basePort + i));
else results.push(...(await Promise.all(names.map((n, i) => run(n, basePort + i)))));
console.log(`\nbrowser checks in ${Math.round((Date.now() - t0) / 1000)}s: ${results.map((r) => `${r.name} ${r.code === 0 ? 'ok' : 'FAILED'} ${r.secs}s`).join(', ')}`);
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
