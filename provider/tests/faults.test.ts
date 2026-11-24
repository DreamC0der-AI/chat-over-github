/**
 * The provider against a GitHub that misbehaves like the real one: concurrent-commit 409s,
 * secondary rate limits, 429, truncated listings, lost replies, 5xx, junk written by members.
 */
import { describe, expect, it } from 'vitest';
import type { Group } from 'keyhold/chat';
import { githubWorld, makeUser, texts } from './chat-helpers.js';
import { MockGitHub } from './github-mock.js';
import { retryAfterOf } from '../src/client.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const meta = (g: Group) => (g as unknown as { meta: { accessLost?: boolean } }).meta;
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function space() {
  const w = githubWorld();
  const a = w.session('alice');
  const s = await a.channel.createSpace('chat');
  return { w, a, s, gh: w.gh, repo: w.gh.repos.get(s)! };
}

describe('fault injection in the mock', () => {
  it('is off by default, deterministic with a seed, and counts down `times`', async () => {
    const run = async () => {
      const { a, s, gh } = await space();
      gh.faults = { seed: 42, serverError: { match: '^GET .*/contents/mail', probability: 0.5, status: 503 } };
      let outcome = '';
      for (let i = 0; i < 20; i++) outcome += await a.mailbox.list(s).then(() => 'ok ', () => 'fail ');
      return `${outcome}/ ${gh.faultLog.length}`;
    };
    const first = await run();
    expect(first).toContain('ok');
    expect(first).toContain('fail');
    expect(await run()).toBe(first);
    const { a, s, gh } = await space();
    await a.mailbox.post(s, bytes('x'));
    expect(gh.faultLog).toEqual([]);
    gh.faults = { conflict: { times: 2 } };
    await a.mailbox.post(s, bytes('y'));
    expect(gh.faultLog.filter((l) => l.startsWith('conflict PUT'))).toHaveLength(2);
  });
});

describe('C3: rate limits are not lost access', () => {
  it('a secondary-limit 403 and a 429 become too_many_attempts with retry-after', async () => {
    const { a, s, gh } = await space();
    gh.faults = { secondaryLimit: { match: '/contents/mail$', retryAfter: 30 } };
    const e = await a.mailbox.list(s).catch((x) => x);
    expect(e).toMatchObject({ code: 'too_many_attempts' });
    expect(retryAfterOf(e)).toBe(30);
    expect(a.client.rateLimitedUntil).toBeGreaterThan(Date.now() + 25_000);
    gh.faults = { tooMany: { match: '/contents/mail$', retryAfter: 5 } };
    const e2 = await a.mailbox.list(s).catch((x) => x);
    expect(e2).toMatchObject({ code: 'too_many_attempts' });
    expect(retryAfterOf(e2)).toBe(5);
    gh.faults = undefined;
    await expect(a.mailbox.list(s)).resolves.toBeDefined();
  });

  it('a chat hit by a secondary limit is not marked access lost, and syncs once it lifts', async () => {
    const w = githubWorld();
    const bob = await makeUser(w.session('bob'), w.address('bob'));
    const alice = await makeUser(w.session('alice'), w.address('alice'));
    const g = await bob.chat.startDm(alice.address);
    const [ga] = await alice.chat.acceptInvites();
    await g.send({ t: 'text', body: 'hi' });
    w.gh.faults = { secondaryLimit: { match: '^GET .*/contents/mail$' } };
    await expect(ga!.sync()).rejects.toMatchObject({ code: 'too_many_attempts' });
    expect(meta(ga!).accessLost).toBeFalsy();
    w.gh.faults = undefined;
    expect(texts(await ga!.sync())).toEqual(['hi']);
  });

  it('a 403 on a listing is reported as forbidden only when the repo is really out of reach', async () => {
    const { w, a, s, gh } = await space();
    // A plain 403 while the repo stays readable: a passing failure, not lost access.
    const real = gh.fetch;
    let once = true;
    const flaky = async (url: string, init?: Parameters<MockGitHub['fetch']>[1]) => {
      if (once && url.endsWith('/contents/mail')) {
        once = false;
        return { status: 403, headers: { get: () => null }, json: async () => ({}), text: async () => '{"message":"Forbidden"}' };
      }
      return real(url, init);
    };
    const { githubProvider } = await import('../src/index.js');
    const p = githubProvider({ fetch: flaky, token: gh.users.get('alice')!.token, login: 'alice', workerUrl: gh.worker, apiBase: gh.api, sleep: async () => {} });
    await expect(p.mailbox.list(s)).rejects.toMatchObject({ code: 'config' });
    // Removed from the repo: GitHub hides it (404), and that is final.
    const bob = w.session('bob');
    await expect(bob.mailbox.list(s)).rejects.toMatchObject({ code: 'forbidden' });
    void a;
  });
});

describe('H2: junk folders written by a member', () => {
  it('a folder inside a mail day, a log shard, a drop tag or mail/ itself blocks nothing', async () => {
    const { a, s, gh } = await space();
    const first = await a.mailbox.post(s, bytes('one'));
    gh.rewrite(s, `mail/${today()}/zz/junk`, bytes('junk'));
    gh.rewrite(s, 'mail/zzzz/junk', bytes('junk'));
    const l = await a.mailbox.list(s);
    expect(l.items.map((i) => [i.id, str(i.data)])).toEqual([[first, 'one']]);
    const second = await a.mailbox.post(s, bytes('two'));
    expect((await a.mailbox.list(s, l.cursor)).items.map((i) => i.id)).toEqual([second]);

    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    gh.rewrite(s, 'log/00000/zz/junk', bytes('junk'));
    gh.rewrite(s, 'log/junk/x', bytes('junk'));
    expect((await a.orderedLog.read(s, 0)).map(str)).toEqual(['e0']);

    const tag = 'ab'.repeat(16);
    await a.dropBox.put(s, tag, bytes('ticket'));
    gh.rewrite(s, `drop/${tag}/zz/junk`, bytes('junk'));
    expect((await a.dropBox.list(s, tag)).map((i) => str(i.data))).toEqual(['ticket']);
  });

  it('a member planting a folder in the mail day does not stop the chat syncing or sending', async () => {
    const w = githubWorld();
    const bob = await makeUser(w.session('bob'), w.address('bob'));
    const alice = await makeUser(w.session('alice'), w.address('alice'));
    const g = await bob.chat.startDm(alice.address);
    const [ga] = await alice.chat.acceptInvites();
    await g.sync();
    w.gh.rewrite(g.space, `mail/${today()}/zz/junk`, bytes('junk'));
    await g.send({ t: 'text', body: 'still here' });
    expect(texts(await ga!.sync())).toEqual(['still here']);
    await ga!.send({ t: 'text', body: 'me too' });
    expect(texts(await g.sync())).toEqual(['me too']);
  });
});

describe('H3: a mail day past 1,000 entries', () => {
  it('lists every message although GitHub truncates the folder listing', async () => {
    const { a, s, gh } = await space();
    gh.faults = { listingLimit: 1000 };
    const d = today();
    // 1,200 older messages, then a new one: its id sorts last, so a truncated listing drops it.
    for (let i = 0; i < 1200; i++) gh.rewrite(s, `mail/${d}/0-${String(i).padStart(5, '0')}`, bytes(`old${i}`));
    const id = await a.mailbox.post(s, bytes('newest'));
    const l = await a.mailbox.list(s);
    expect(l.items).toHaveLength(1201);
    expect(l.items.at(-1)).toMatchObject({ id });
    expect(str(l.items.at(-1)!.data)).toBe('newest');
    // Other folders that pass the cap (junk planted in a log shard) are read in full too.
    for (let i = 0; i < 1100; i++) gh.rewrite(s, `log/00000/${String(i).padStart(4, '0')}`, bytes('junk'));
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    expect((await a.orderedLog.read(s, 0)).map(str)).toEqual(['e0']);
    expect(gh.faultLog.some((l) => l.startsWith('listingLimit'))).toBe(true);
  });
});

describe('M2: concurrent-commit 409s on Contents writes', () => {
  it('drops, blobs, mail, log, vault and items are retried, not reported done or clashing', async () => {
    const { a, s, gh, repo } = await space();
    const tag = 'cd'.repeat(16);
    gh.faults = { conflict: { times: 2 } };
    const drop = await a.dropBox.put(s, tag, bytes('ticket'));
    expect(str(repo.files.get(`drop/${tag}/${drop}`)!.content)).toBe('ticket');
    gh.faults = { conflict: { times: 2 } };
    const blob = await a.blobs.put(s, bytes('file'));
    expect(str((await a.blobs.get(s, blob))!)).toBe('file');
    gh.faults = { conflict: { times: 2 } };
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    gh.faults = { conflict: { times: 2 } };
    expect(await a.personal.put('i1', bytes('v1'), null)).toBe('ok');
    const v1 = (await a.personal.get('i1'))!.version;
    gh.faults = { conflict: { times: 2 } };
    expect(await a.personal.put('i1', bytes('v2'), v1)).toBe('ok');
    // A real compare-and-swap conflict is still one.
    gh.faults = undefined;
    expect(await a.personal.put('i1', bytes('v3'), v1)).toBe('conflict');
    expect(await a.orderedLog.append(s, 0, bytes('other'))).toBe('conflict');
    gh.faults = { conflict: { times: 1 } };
    const cur = (await a.personal.get('i1'))!.version;
    expect(await a.personal.delete('i1', cur)).toBe('ok');
  });

  it('the one-file-per-item fallbacks retry 409s and fail loudly when a write does not land', async () => {
    const { a, s, gh, repo } = await space();
    gh.gitDataDown = true;
    gh.faults = { conflict: { times: 3 } };
    const l0 = await a.mailbox.list(s);
    const ids = await a.mailbox.postMany!(s, [bytes('1'), bytes('2')]);
    expect((await a.mailbox.list(s, l0.cursor)).items.map((i) => [i.id, str(i.data)])).toEqual([[ids[0], '1'], [ids[1], '2']]);
    gh.faults = { conflict: { times: 3 } };
    const tag = 'ef'.repeat(16);
    const d = await a.dropBox.putMany!(s, [{ tag, data: bytes('w') }]);
    expect(str(repo.files.get(`drop/${tag}/${d[0]}`)!.content)).toBe('w');
    // Every write refused: an error, not a silent success.
    gh.faults = { conflict: { probability: 1 } };
    await expect(a.dropBox.putMany!(s, [{ tag, data: bytes('x') }])).rejects.toMatchObject({ code: 'conflict' });
    await expect(a.dropBox.put(s, tag, bytes('y'))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a rate limit during a batch does not fan out into one write per item', async () => {
    const { a, s, gh } = await space();
    gh.faults = { secondaryLimit: { match: '^PATCH .*/git/refs/' } };
    const before = gh.log.length;
    await expect(a.mailbox.postMany!(s, [bytes('1'), bytes('2'), bytes('3')])).rejects.toMatchObject({ code: 'too_many_attempts' });
    expect(gh.log.slice(before).filter((l) => l.startsWith('PUT '))).toEqual([]);
  });
});

describe('M3: lost replies', () => {
  it('a write that landed before its reply was lost is not posted twice', async () => {
    const { a, s, gh, repo } = await space();
    const mail = () => [...repo.files.keys()].filter((p) => p.startsWith('mail/'));
    gh.faults = { lostReply: { match: '^PUT .*/contents/mail/' } };
    const id = await a.mailbox.post(s, bytes('once'));
    expect(mail()).toEqual([`mail/${today()}/${id}`]);
    gh.faults = { lostReply: { match: '^PATCH .*/git/refs/' } };
    const ids = await a.mailbox.postMany!(s, [bytes('a'), bytes('b')]);
    expect(mail()).toHaveLength(3);
    expect((await a.mailbox.list(s)).items.map((i) => i.id).sort()).toEqual([id, ...ids].sort());
    gh.faults = { lostReply: { match: '^PUT .*/contents/log/' } };
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    gh.faults = { lostReply: { match: '^PUT .*/contents/blob/' } };
    const blob = await a.blobs.put(s, bytes('b'));
    expect([...repo.files.keys()].filter((p) => p.startsWith('blob/'))).toEqual([`blob/${blob}`]);
    gh.faults = { lostReply: { match: '^PUT .*/contents/items/' } };
    expect(await a.personal.put('i1', bytes('v1'), null)).toBe('ok');
  });

  it('a create at a path that already holds the same bytes succeeds; different bytes conflict', async () => {
    const { a, s, gh } = await space();
    gh.rewrite(s, 'log/00000/00000000', bytes('e0'));
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    expect(await a.orderedLog.append(s, 0, bytes('e1'))).toBe('conflict');
  });
});

describe('5xx', () => {
  it('a passing server error is retried', async () => {
    const { a, s, gh } = await space();
    gh.faults = { serverError: { times: 2 } };
    await a.mailbox.post(s, bytes('x'));
    expect((await a.mailbox.list(s)).items).toHaveLength(1);
    gh.faults = { serverError: { probability: 1 } };
    await expect(a.mailbox.list(s)).rejects.toMatchObject({ code: 'config' });
  });
});

describe('paths from untrusted values', () => {
  it('attachment refs, tags, ids and spaces cannot reach other API paths', async () => {
    const { a, s, gh } = await space();
    const before = gh.log.length;
    for (const bad of ['../../../../user/x', '..', 'a/b', '.', 'x?y', '']) {
      await expect(a.blobs.get(s, bad)).rejects.toMatchObject({ code: 'bad_format' });
      await expect(a.blobs.delete(s, bad)).rejects.toMatchObject({ code: 'bad_format' });
      await expect(a.dropBox.list(s, bad)).rejects.toMatchObject({ code: 'bad_format' });
      await expect(a.dropBox.delete(s, 'ab', bad)).rejects.toMatchObject({ code: 'bad_format' });
      await expect(a.personal.get(bad)).rejects.toMatchObject({ code: 'bad_format' });
    }
    for (const bad of ['alice/../../user', 'alice/x/y', '../x', 'alice/..']) await expect(a.mailbox.list(bad)).rejects.toMatchObject({ code: 'config' });
    await expect(a.channel.acceptGrant('alice/x#../../user')).rejects.toMatchObject({ code: 'bad_format' });
    expect(gh.log.slice(before)).toEqual([]);
    // Real ids still work: hex refs, base64url item ids, dotted relay ids.
    const ref = await a.blobs.put(s, bytes('ok'));
    expect(str((await a.blobs.get(s, ref))!)).toBe('ok');
    expect(await a.personal.put('r.Ab-_9.req', bytes('x'), null)).toBe('ok');
  });
});

describe('chat repos are hardened', () => {
  it('a new chat repo blocks force-push and branch deletion and has Actions off; the app still writes', async () => {
    const { w, a, s, gh, repo } = await space();
    expect([...repo.rules].sort()).toEqual(['deletion', 'non_fast_forward']);
    expect(repo.actionsEnabled).toBe(false);
    // The app's own writes are fast-forwards: all still work.
    const id = await a.mailbox.post(s, bytes('1'));
    const ids = await a.mailbox.postMany!(s, [bytes('2'), bytes('3')]);
    await a.dropBox.putMany!(s, [{ tag: 'ab'.repeat(16), data: bytes('t') }]);
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    expect((await a.mailbox.list(s)).items.map((i) => i.id).sort()).toEqual([id, ...ids].sort());
    // A member's forced update or branch delete is refused.
    const bob = gh.addUser('bob');
    repo.collaborators.add('bob');
    const auth = { Authorization: `Bearer ${bob.token}` };
    const call = (method: string, path: string, body?: unknown) => gh.fetch(`${gh.api}/repos/${s}/${path}`, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
    const blob = (await (await call('POST', 'git/blobs', { content: btoa('evil'), encoding: 'base64' })).json()) as { sha: string };
    const tree = (await (await call('POST', 'git/trees', { base_tree: 'none', tree: [{ path: 'x', sha: blob.sha }] })).json()) as { sha: string };
    const commit = (await (await call('POST', 'git/commits', { tree: tree.sha, parents: [] })).json()) as { sha: string };
    expect((await call('PATCH', 'git/refs/heads/main', { sha: commit.sha, force: true })).status).toBe(422);
    expect((await call('DELETE', 'git/refs/heads/main')).status).toBe(422);
    void w;
  });

  it('creating a chat still works when the plan refuses rulesets', async () => {
    const w = githubWorld();
    const a = w.session('alice');
    w.gh.faults = { serverError: { match: '/rulesets$|/actions/permissions$', probability: 1, status: 503 } };
    const s = await a.channel.createSpace('chat');
    expect(w.gh.repos.get(s)).toBeDefined();
  });
});

describe('posts with ids chosen before the first try (keyhold retries)', () => {
  const mailFiles = (repo: { files: Map<string, unknown> }) => [...repo.files.keys()].filter((p) => p.startsWith('mail/'));

  it('newId makes ids that sort in the order made, without a request', async () => {
    const { a, gh } = await space();
    const before = gh.log.length;
    const ids = Array.from({ length: 300 }, () => a.mailbox.newId!());
    expect(gh.log.length).toBe(before);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(300);
  });

  it('the same id with the same bytes lands once; with other bytes it is a conflict', async () => {
    const { w, a, s, repo } = await space();
    const id = a.mailbox.newId!();
    expect(await a.mailbox.post(s, bytes('once'), { id })).toBe(id);
    expect(await a.mailbox.post(s, bytes('once'), { id })).toBe(id);
    expect(mailFiles(repo)).toEqual([`mail/${today()}/${id}`]);
    await expect(a.mailbox.post(s, bytes('other'), { id })).rejects.toMatchObject({ code: 'conflict' });
    expect(str(repo.files.get(`mail/${today()}/${id}`)!.content)).toBe('once');
    // A new app (after a reload) retrying an id it didn't make itself: same answers.
    const reloaded = w.session('alice');
    expect(await reloaded.mailbox.post(s, bytes('once'), { id })).toBe(id);
    await expect(reloaded.mailbox.post(s, bytes('other'), { id })).rejects.toMatchObject({ code: 'conflict' });
    expect(mailFiles(repo)).toHaveLength(1);
  });

  it('a retried batch whose reply was lost writes nothing twice, and keeps its ids', async () => {
    const { a, s, gh, repo } = await space();
    const ids = [a.mailbox.newId!(), a.mailbox.newId!()];
    gh.faults = { lostReply: { match: '^PATCH .*/git/refs/' } };
    gh.gitDataDown = false;
    // The batch lands but the app never hears; the provider falls back, finds them, and says ok.
    expect(await a.mailbox.postMany!(s, [bytes('a'), bytes('b')], { ids })).toEqual(ids);
    gh.faults = undefined;
    // keyhold's resend posts the same bytes at the same ids again.
    expect(await a.mailbox.postMany!(s, [bytes('a'), bytes('b')], { ids })).toEqual(ids);
    expect(mailFiles(repo).sort()).toEqual(ids.map((i) => `mail/${today()}/${i}`).sort());
    expect((await a.mailbox.list(s)).items.map((i) => [i.id, str(i.data)])).toEqual([[ids[0], 'a'], [ids[1], 'b']]);
    await expect(a.mailbox.postMany!(s, [bytes('a'), bytes('x')], { ids })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('the day folder comes from the id; an id older than yesterday not there yet gets a fresh one', async () => {
    let t = Date.UTC(2026, 0, 10, 23, 59);
    const w = githubWorld();
    const a = w.session('alice', { now: () => t });
    const s = await a.channel.createSpace('chat');
    const repo = w.gh.repos.get(s)!;
    const id = a.mailbox.newId!();
    t = Date.UTC(2026, 0, 11, 0, 5); // after midnight: still yesterday's folder, where readers look
    expect(await a.mailbox.post(s, bytes('late'), { id })).toBe(id);
    expect(mailFiles(repo)).toEqual([`mail/20260110/${id}`]);
    // Saved for days (offline), then retried: its day is behind every reader's cursor.
    const old = a.mailbox.newId!();
    t = Date.UTC(2026, 0, 14, 12);
    const used = await a.mailbox.post(s, bytes('days later'), { id: old });
    expect(used).not.toBe(old);
    expect(mailFiles(repo)).toContain(`mail/20260114/${used}`);
    // A batch the same way: each old id replaced, in order.
    const olds = [a.mailbox.newId!(), a.mailbox.newId!()];
    t = Date.UTC(2026, 0, 20, 12);
    const got = await a.mailbox.postMany!(s, [bytes('1'), bytes('2')], { ids: olds });
    expect(got.every((g, i) => g !== olds[i])).toBe(true);
    expect([...got].sort()).toEqual(got);
    const l = await a.mailbox.list(s);
    expect(l.items.slice(-2).map((i) => [i.id, str(i.data)])).toEqual([[got[0], '1'], [got[1], '2']]);
    // But an old id that did land (its reply was lost) is found, not posted again.
    expect(await a.mailbox.post(s, bytes('late'), { id })).toBe(id);
  });
});
