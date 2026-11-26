/**
 * Live check of the GitHub provider against real GitHub.
 *   npm run build:live && node scripts/live-github.mjs <loginA> <loginB>
 *
 * Uses each account's sign-in from the web app (see token() below; device flow was turned off on
 * 2026-11-25, phishing risk), kept in ~/.keyhold-live (mode 600). Uses separate repo names (keyhold-live-*, ghchat-live-*)
 * and deletes every repo it made at the end. Prints a JSON report.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { githubProvider, toAddress } from '../src/index.js';
import { memoryDevice, resolveFeatures } from 'keyhold/storage';
import { Chat, createRootKey, createDeviceIdentity, DirectoryWriter, IdentityRegistry, MemoryPinStore, newDeviceId } from 'keyhold/chat';

const WORKER = process.env.KEYHOLD_WORKER ?? 'https://chat-over-github.akagishigerutokyo.workers.dev';
const API = 'https://api.github.com';
const NAMES = { directoryRepo: 'keyhold-live-id', homeRepo: 'keyhold-live-home', chatPrefix: 'ghchat-live-' };
const dir = `${homedir()}/.keyhold-live`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ghUser(token: string) {
  const r = await fetch(`${API}/user`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
  return r.ok ? ((await r.json()) as { login: string; id: number }) : undefined;
}

/**
 * A token for this account. Device flow is off (2026-11-25), so the script signs in with what the
 * web app already has: the env var KEYHOLD_LIVE_TOKEN_<LOGIN>, or ~/.keyhold-live/<login>.json
 * holding the app's saved sign-in (localStorage "kh.auth": {token, refreshToken}) or an OAuth
 * answer ({access_token, refresh_token}). An expired token is renewed through the Worker with its
 * refresh token, and the file is updated (the old refresh token is spent, so a browser whose
 * "kh.auth" was copied must sign in again: copy from a browser profile kept for the test accounts).
 */
async function token(login: string): Promise<string> {
  const fromEnv = process.env[`KEYHOLD_LIVE_TOKEN_${login.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (fromEnv) {
    if ((await ghUser(fromEnv))?.login.toLowerCase() === login.toLowerCase()) return fromEnv;
    throw new Error(`KEYHOLD_LIVE_TOKEN for ${login} is not a working token of that account`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${dir}/${login.toLowerCase()}.json`;
  if (!existsSync(file)) throw new Error(`no sign-in for ${login}: put the web app's "kh.auth" value (signed in as ${login}) in ${file}, or set KEYHOLD_LIVE_TOKEN_${login.toUpperCase()}`);
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { token?: string; refreshToken?: string; access_token?: string; refresh_token?: string };
  const access = saved.token ?? saved.access_token;
  const refresh = saved.refreshToken ?? saved.refresh_token;
  if (access && (await ghUser(access))?.login.toLowerCase() === login.toLowerCase()) return access;
  if (!refresh) throw new Error(`the saved sign-in for ${login} has expired and has no refresh token`);
  const retryKey = randomBytes(24).toString('base64url');
  const t = (await (await fetch(`${WORKER}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh, retry_key: retryKey }),
  })).json()) as { access_token?: string; refresh_token?: string; error?: string };
  if (!t.access_token) throw new Error(`refreshing ${login}'s sign-in failed: ${t.error ?? 'no token'}`);
  writeFileSync(file, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token ?? refresh }), { mode: 0o600 });
  const u = await ghUser(t.access_token);
  if (u?.login.toLowerCase() !== login.toLowerCase()) throw new Error(`the saved sign-in is for ${u?.login}, expected ${login}`);
  return t.access_token;
}

/** Only plain data the step chose to report; never users, groups, tokens or keys. */
function safeDetail(v: unknown): unknown {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  let text: string;
  try { text = JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? '[bytes]' : x)); } catch { return '[withheld]'; }
  if (/ghu_|ghp_|gho_|"tok"|"token"|signKey|"chat"/.test(text)) return '[withheld]';
  return JSON.parse(text);
}

const report: { step: string; ok: boolean; detail?: unknown; ms: number }[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const v = await fn();
    report.push({ step: name, ok: true, detail: safeDetail(v), ms: Date.now() - t0 });
    console.log(`PASS ${name}`, JSON.stringify(safeDetail(v))?.slice(0, 300) ?? '');
    return v;
  } catch (e) {
    report.push({ step: name, ok: false, detail: String((e as Error).stack ?? e), ms: Date.now() - t0 });
    console.log(`FAIL ${name}`, String(e));
    return undefined;
  }
}
const check = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(3000);
  }
}

async function makeUser(login: string, tok: string) {
  const provider = githubProvider({ fetch: (...a) => fetch(...a), token: tok, login, workerUrl: WORKER, ...NAMES });
  const address = toAddress(login);
  const root = createRootKey();
  const device = memoryDevice();
  const identity = await createDeviceIdentity(device, root, address, newDeviceId());
  await new DirectoryWriter(provider.directory, address).publish(root, identity.cert, { name: login });
  const chat = await Chat.open({
    provider, device, identity,
    registry: new IdentityRegistry(provider.directory, new MemoryPinStore()),
    features: resolveFeatures(provider, {}),
  });
  return { login, tok, provider, address, chat };
}
const texts = (r: { messages: { message: { t: string; body?: string } }[] }) => r.messages.filter((m) => m.message.t === 'text').map((m) => m.message.body);

async function cleanup(users: { login: string; tok: string }[]) {
  const out: string[] = [];
  for (const u of users) {
    const h = { authorization: `Bearer ${u.tok}`, accept: 'application/vnd.github+json' };
    const repos = (await (await fetch(`${API}/user/repos?affiliation=owner&per_page=100`, { headers: h })).json()) as { name: string; full_name: string }[];
    for (const r of Array.isArray(repos) ? repos : []) {
      if (r.name === NAMES.directoryRepo || r.name === NAMES.homeRepo || r.name.startsWith(NAMES.chatPrefix)) {
        const d = await fetch(`${API}/repos/${r.full_name}`, { method: 'DELETE', headers: h });
        out.push(`${r.full_name}: ${d.status}`);
      }
    }
  }
  return out;
}

async function main() {
  const [la, lb] = process.argv.slice(2);
  if (!la || !lb) throw new Error('usage: live-github.mjs <loginA> <loginB>');
  const ta = await token(la);
  const tb = await token(lb);
  const creds = [{ login: la, tok: ta }, { login: lb, tok: tb }];
  console.log('pre-clean', await cleanup(creds));
  try {
    const a = await step('publish directory A', () => makeUser(la, ta));
    const b = await step('publish directory B', () => makeUser(lb, tb));
    if (!a || !b) return;

    await step('registry lookup across accounts', async () => {
      const r = await new IdentityRegistry(a.provider.directory, new MemoryPinStore()).lookup(b.address);
      check(r.status === 'ok', `lookup: ${r.status}`);
    });

    const dm = await step('DM: start (repo, ticket, collaborator invite, inbox)', () => a.chat.startDm(b.address));
    const dmB = await step('DM: invitee accepts and joins', () => until('accept', async () => (await b.chat.acceptInvites())[0]));
    if (dm && dmB) {
      await step('DM: A to B', async () => {
        await dm.send({ t: 'text', body: 'hello B' });
        const got = await until('message', async () => texts(await dmB.sync()).includes('hello B'), 30_000);
        return got;
      });
      await step('DM: B to A', async () => {
        await dmB.send({ t: 'text', body: 'hello A' });
        return until('message', async () => texts(await dm.sync()).includes('hello A'), 30_000);
      });
      await step('DM: a burst of four goes out as one write after the first', async () => {
        const c = (a.provider as unknown as { client: { requests: number } }).client;
        const first = dm.send({ t: 'text', body: 'b1' });
        await Promise.resolve();
        const t0 = Date.now();
        const r0 = c.requests;
        await Promise.all([first, dm.send({ t: 'text', body: 'b2' }), dm.send({ t: 'text', body: 'b3' }), dm.send({ t: 'text', body: 'b4' })]);
        const ms = Date.now() - t0;
        const seen: string[] = [];
        await until('burst', async () => {
          seen.push(...(texts(await dmB.sync()) as string[]).filter((t) => /^b\d$/.test(t)));
          return seen.length >= 4;
        }, 30_000);
        check(seen.join(',') === 'b1,b2,b3,b4', `order: ${seen.join(',')}`);
        return { requests: c.requests - r0, ms };
      });
      await step('attachment 1.5 MB (git blob API path)', async () => {
        const data = new Uint8Array(1_500_000).map((_, i) => (i * 31) & 255);
        await dm.sendAttachment(data, { name: 'big.bin' });
        const r = await until('attachment msg', async () => (await dmB.sync()).messages.find((m) => m.message.t === 'attachment'), 30_000);
        const back = await dmB.fetchAttachment((r.message as unknown as { file: never }).file);
        check(back.length === data.length && back.every((v, i) => v === data[i]), 'attachment mismatch');
        return { bytes: back.length };
      });
      await step('request cost of an idle sync', async () => {
        await dm.sync(); await dmB.sync();
        const ca = a.provider.client.requests; await dm.sync();
        const cb = b.provider.client.requests; await dmB.sync();
        return { owner: a.provider.client.requests - ca, member: b.provider.client.requests - cb };
      });
    }

    await step('compare-and-swap: two writers race on one log index', async () => {
      const space = await a.provider.channel.createSpace('cas');
      await a.provider.channel.grant(space, b.address);
      await until('accept grant', async () => (await b.provider.channel.listSpaces()).includes(space) || (await b.chat.acceptInvites(), false), 60_000).catch(() => {});
      const results = [];
      for (let i = 0; i < 5; i++) {
        const r = await Promise.all([
          a.provider.orderedLog.append(space, i, new TextEncoder().encode(`A${i}`)),
          a.provider.orderedLog.append(space, i, new TextEncoder().encode(`a${i}`)),
        ]);
        results.push(r);
        check(r.filter((x) => x === 'ok').length === 1, `index ${i}: ${JSON.stringify(r)}`);
      }
      const log = await a.provider.orderedLog.read(space, 0);
      check(log.length === 5, `log has ${log.length}`);
      return results;
    });

    const g = await step('group: create and invite', async () => {
      const g = await a.chat.createGroup('group', 'live test');
      await g.invite(b.address);
      return g;
    });
    const gB = g && await step('group: invitee joins', () => until('join', async () => (await b.chat.acceptInvites()).find((x) => x.id === g.id)));
    if (g && gB) {
      await step('group: talk', async () => {
        await g.send({ t: 'text', body: 'group hi' });
        return until('message', async () => texts(await gB.sync()).includes('group hi'), 30_000);
      });
      await step('group: member leaves (collaborator self-removal)', async () => {
        await gB.leave();
        await until('leave committed', async () => (await g.sync(), g.members().length === 1), 60_000);
        const h = { authorization: `Bearer ${a.tok}`, accept: 'application/vnd.github+json' };
        const c = await (await fetch(`${API}/repos/${g.space}/collaborators`, { headers: h })).json();
        return { members: g.members().length, collaborators: (c as { login: string }[]).map((x) => x.login) };
      });
    }

    const g2 = await step('group 2: create, invite, join, remove', async () => {
      const g2 = await a.chat.createGroup('group', 'removal');
      await g2.invite(b.address);
      const g2b = await until('join', async () => (await b.chat.acceptInvites()).find((x) => x.id === g2.id));
      const fb = await until('A sees the join', async () => (await g2.sync(), g2.members().find((m) => m.address === b.address)), 60_000);
      await g2.remove(fb.fingerprint);
      const r = await g2b.sync();
      check(!g2b.active, 'B still active');
      const canRead = await b.provider.orderedLog.read(g2.space, 0).then(() => true, () => false);
      return { events: r.events.map((e) => e.type), stillReadable: canRead };
    });
    void g2;
  } finally {
    const removed = await cleanup(creds).catch((e) => [String(e)]);
    report.push({ step: 'cleanup', ok: true, detail: removed, ms: 0 });
    console.log('cleanup', removed);
    const file = `${dir}/report-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`\nREPORT ${file}\n${report.filter((r) => r.ok).length}/${report.length} passed`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
