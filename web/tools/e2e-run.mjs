// Runs each browser end-to-end check against a fresh mock backend (GitHub + Worker in memory).
import { spawn } from 'node:child_process';

const port = process.env.PORT ?? '8787';
let failed = 0;
for (const script of ['tools/e2e.mjs', 'tools/e2e-pending.mjs', 'tools/e2e-menu.mjs', 'tools/e2e-layout.mjs']) {
  const server = spawn(process.execPath, ['tools/mock-server.mjs', port], { stdio: 'inherit' });
  await new Promise((r) => setTimeout(r, 1500));
  const e2e = spawn(process.execPath, [script], { stdio: 'inherit', env: { ...process.env, BASE: `http://localhost:${port}/` } });
  const code = await new Promise((r) => e2e.on('exit', r));
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
  if (code !== 0) failed++;
}
process.exit(failed ? 1 : 0);
