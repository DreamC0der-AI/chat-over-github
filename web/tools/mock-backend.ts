/**
 * The in-memory GitHub + Worker backend the tests run against: keyhold's GitHub mock plus the
 * few endpoints the web app adds (/user, /users/:login, commits ETag, repo delete, own
 * installation, closure notices). Used over HTTP by tools/mock-server.ts (browser checks) and
 * directly as a fetch function by the no-browser scenarios (tests/).
 *   const b = mockBackend(); await b.fetch('http://x/gh/user', { headers: { Authorization: 'Bearer tok-alice' } })
 * Paths start with /gh/ (GitHub API) or /worker/ (the Worker); anything else is null.
 */
import { createHash } from 'node:crypto';
import { MockGitHub } from '../../provider/tests/github-mock.ts';

export interface MockReply { status: number; body: string; headers: Record<string, string> }

export function mockBackend() {
  const gh = new MockGitHub();
  const installed = new Set<string>();
  /** Worker closure notices: member login -> notices. */
  const closures = new Map<string, { id: string; from: string; from_id: number; tag: string; at: string }[]>();

  function userOf(auth: string | undefined) {
    const tok = auth?.replace(/^Bearer /, '');
    if (!tok?.startsWith('tok-')) return undefined;
    const login = tok.slice(4);
    if (!gh.users.has(login)) gh.addUser(login);
    return login;
  }

  /** Answer one request; null when the path isn't the API or the Worker. */
  async function handle(req: { method: string; url: URL; headers: Record<string, string | undefined>; body?: string }): Promise<MockReply | null> {
    const { url, body } = req;
    const send = (status: number, b = '', headers: Record<string, string> = {}): MockReply => ({ status, body: b, headers: { ...(Object.keys(headers).some((k) => k.toLowerCase() === 'x-ratelimit-remaining') ? {} : { 'X-RateLimit-Remaining': '4999' }), ...headers } });
    const json = (status: number, data: unknown, h: Record<string, string> = {}) => send(status, JSON.stringify(data), { 'Content-Type': 'application/json', ...h });
    const auth = req.headers.authorization;
    const user = userOf(auth);
    const method = req.method;
    if (url.pathname.startsWith('/gh/') || url.pathname.startsWith('/worker/')) {
      const isGh = url.pathname.startsWith('/gh/');
      const rest = url.pathname.slice(isGh ? 3 : 7) + url.search;
      const path = decodeURIComponent(url.pathname.slice(isGh ? 3 : 7));
      if (isGh) {
        if (path === '/user') return user ? json(200, { login: user, id: gh.users.get(user)!.id }) : json(401, {});
        let m = path.match(/^\/users\/([^/]+)$/);
        if (m) {
          const l = m[1]!.toLowerCase();
          return gh.users.has(l) ? json(200, { login: m[1], id: gh.users.get(l)!.id, type: 'User' }) : json(404, { message: 'Not Found' });
        }
        m = path.match(/^\/repos\/([^/]+)\/([^/]+)\/commits$/);
        if (m && method === 'GET') {
          const r = gh.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
          if (!r || !gh.canRead(r, user)) return json(404, { message: 'Not Found' });
          const h = createHash('sha1');
          for (const [p, f] of [...r.files].sort()) h.update(`${p}:${f.sha};`);
          const etag = `"${h.digest('hex')}"`;
          if (req.headers['if-none-match'] === etag) return send(304, '', { ETag: etag });
          return json(200, [{ sha: etag }], { ETag: etag });
        }
        m = path.match(/^\/repos\/([^/]+)\/([^/]+)$/);
        if (m && method === 'DELETE') {
          const k = `${m[1]}/${m[2]}`.toLowerCase();
          const r = gh.repos.get(k);
          if (!r) return send(404);
          if (r.owner !== user) return json(403, {});
          gh.repos.delete(k);
          return send(204);
        }
        // Test hook: users named new* have no install until POST /gh/mock/install.
        if (path === '/mock/install' && user && method === 'POST') {
          installed.add(user);
          return send(204);
        }
        if (path === '/user/installations' && user) {
          const r = await gh.fetch(gh.api + rest, { method: 'GET', headers: { Authorization: auth! } });
          const data = (await r.json()) as { installations: { id: number; account: { login: string } }[] };
          if (user.startsWith('new') && !installed.has(user)) data.installations = data.installations.filter((i) => i.account.login !== user);
          else if (!data.installations.some((i) => i.account.login === user)) data.installations.push({ id: gh.users.get(user)!.id, account: { login: user } });
          return json(200, data);
        }
      }
      if (!isGh && path === '/closures' && user) {
        if (method === 'GET') return json(200, { closures: closures.get(user) ?? [] });
        if (method === 'POST') {
          const b = JSON.parse(body ?? '{}') as { to: string; tag: string };
          const to = String(b.to).toLowerCase();
          if (!gh.users.has(to)) return json(404, { error: 'no such user' });
          const me = gh.users.get(user)!;
          const entry = { id: `${me.id}:${b.tag}`, from: user, from_id: me.id, tag: b.tag, at: new Date().toISOString() };
          closures.set(to, [...(closures.get(to) ?? []).filter((c) => c.id !== entry.id), entry]);
          return json(201, { ok: true });
        }
      }
      const cm = path.match(/^\/closures\/(.+)$/);
      if (!isGh && cm && method === 'DELETE' && user) {
        closures.set(user, (closures.get(user) ?? []).filter((c) => c.id !== cm[1]));
        return json(200, { ok: true });
      }
      const r = await gh.fetch((isGh ? gh.api : gh.worker) + rest, { method, headers: auth ? { Authorization: auth } : {}, body });
      const text = await r.text();
      return send(r.status, text, { ...r.rawHeaders, ...(text ? { 'Content-Type': 'application/json' } : {}) });
    }
    return null;
  }

  /** The backend as a fetch function, for running the app's logic without a browser. */
  async function fetch(input: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    const r = await handle({ method: init.method ?? 'GET', url: new URL(input), headers, body: init.body });
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.status === 204 || r.status === 304 ? null : r.body, { status: r.status, headers: r.headers });
  }

  return { gh, handle, fetch, installed, closures };
}
