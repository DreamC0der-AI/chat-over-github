// Starts the mock backend (GitHub + Worker in memory), runs the browser end-to-end check, stops it.
import { spawn } from 'node:child_process';

const port = process.env.PORT ?? '8787';
const server = spawn(process.execPath, ['tools/mock-server.mjs', port], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1500));
const e2e = spawn(process.execPath, ['tools/e2e.mjs'], { stdio: 'inherit', env: { ...process.env, BASE: `http://localhost:${port}/` } });
const code = await new Promise((r) => e2e.on('exit', r));
server.kill();
process.exit(code ?? 1);
