/**
 * Local test backend over HTTP for the browser checks: the in-memory backend from
 * mock-backend.ts with CORS, plus the mock build (dist-mock) at /.
 *   node tools/mock-server.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mockBackend } from './mock-backend.ts';

const port = Number(process.argv[2] ?? 8787);
const root = join(process.cwd(), 'dist-mock');
const backend = mockBackend();

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, X-GitHub-Api-Version, Accept',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'ETag, X-RateLimit-Remaining',
};

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${port}`);
  const send = (status: number, body: string | Buffer = '', headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...cors, ...headers });
    res.end(body);
  };
  if (req.method === 'OPTIONS') return send(204);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString() || undefined;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
  const r = await backend.handle({ method: req.method ?? 'GET', url, headers, body });
  if (r) return send(r.status, r.body, r.headers);

  // static files
  let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '') p = '/index.html';
  try {
    const data = await readFile(join(root, p));
    return send(200, data, {
      'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream',
      // Same policy as production (public/_headers), with the mock API as 'self'.
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://github.com https://avatars.githubusercontent.com; connect-src 'self' https://api.github.com; frame-ancestors 'none'; base-uri 'none'",
    });
  } catch {
    return send(404, 'not found');
  }
}).listen(port, () => console.log(`mock backend on http://localhost:${port}`));
