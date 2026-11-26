/**
 * The change check: "which files were added since the commit I last saw", one request, in place
 * of folder listings. What it must never do is lose a file, whatever GitHub answers.
 */
import { describe, expect, it } from 'vitest';
import { githubWorld } from './chat-helpers.js';
import { githubProvider } from '../src/index.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);
const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

/** Alice's chat repo, seen from two of her browsers: `a` reads, `b` writes like anyone else would. */
async function space() {
  const w = githubWorld();
  const a = w.session('alice');
  const b = w.session('alice');
  const s = await a.channel.createSpace('chat');
  const repo = w.gh.repos.get(s)!;
  /** The requests `fn` made, as "METHOD /path" with ids shortened. */
  const during = async (fn: () => Promise<unknown>) => {
    const from = w.gh.log.length;
    await fn();
    return w.gh.log.slice(from).map((l) =>
      l
        .replace(/\/repos\/[^/]+\/[^/]+\//, '/')
        .replace(/compare\/.*/, 'compare')
        .replace(/git\/blobs\/.*/, 'blob')
        .replace(/(mail\/\d{8}|log\/\d{5})\/.+/, '$1/file'),
    );
  };
  return { w, a, b, s, gh: w.gh, repo, during };
}

describe('the change check', () => {
  it('finds new mail with one request, and the list after it only fetches the files', async () => {
    const { a, b, s, during } = await space();
    let cur = (await a.mailbox.list(s)).cursor;
    await b.mailbox.post(s, bytes('one'));
    await b.mailbox.post(s, bytes('two'));
    let changed = false;
    expect(await during(async () => (changed = await a.changes.check(s)))).toEqual(['GET /compare']);
    expect(changed).toBe(true);
    let items: string[] = [];
    expect(
      await during(async () => {
        const r = await a.mailbox.list(s, cur);
        cur = r.cursor;
        items = r.items.map((i) => str(i.data));
      }),
    ).toEqual(['GET /blob', 'GET /blob']);
    expect(items).toEqual(['one', 'two']);
    // Nothing since: one request, and a list right after it builds on that answer.
    expect(await a.changes.check(s)).toBe(false);
    expect(await during(() => a.changes.check(s))).toEqual(['GET /compare']);
    expect(await during(async () => expect((await a.mailbox.list(s, cur)).items).toEqual([]))).toEqual([]);
    // A list without a check before it asks by itself.
    expect(await during(async () => expect((await a.mailbox.list(s, cur)).items).toEqual([]))).toEqual(['GET /compare']);
  });

  it('knows its own writes: the next check has nothing to say, and nothing is fetched', async () => {
    const { a, s, during } = await space();
    const cur = (await a.mailbox.list(s)).cursor;
    await a.mailbox.post(s, bytes('mine'));
    await a.mailbox.postMany!(s, [bytes('m2'), bytes('m3')]);
    expect(await a.changes.check(s)).toBe(false);
    let items: string[] = [];
    expect(await during(async () => (items = (await a.mailbox.list(s, cur)).items.map((i) => str(i.data))))).toEqual([]);
    expect(items.sort()).toEqual(['m2', 'm3', 'mine']);
  });

  it('a write of ours on top of someone else is not taken for the whole change', async () => {
    const { a, b, s } = await space();
    const cur = (await a.mailbox.list(s)).cursor;
    await b.mailbox.post(s, bytes('theirs'));
    await a.mailbox.post(s, bytes('mine'));
    expect(await a.changes.check(s)).toBe(true);
    expect((await a.mailbox.list(s, cur)).items.map((i) => str(i.data)).sort()).toEqual(['mine', 'theirs']);
  });

  it('reads the log from what it knows: a new entry costs its own read only', async () => {
    const { a, b, s, during } = await space();
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    expect((await a.orderedLog.read(s, 0)).map(str)).toEqual(['e0']);
    expect(await b.orderedLog.append(s, 1, bytes('e1'))).toBe('ok');
    expect(await a.changes.check(s)).toBe(true);
    let got: string[] = [];
    // From the last entry we have (keyhold reads it again to see the log was not rewritten).
    expect(await during(async () => (got = (await a.orderedLog.read(s, 0)).map(str)))).toEqual(['GET /contents/log/00000/file']);
    expect(got).toEqual(['e0', 'e1']);
    await a.mailbox.list(s);
    expect(await during(async () => (got = (await a.orderedLog.read(s, 1)).map(str)))).toEqual(['GET /compare']);
    expect(got).toEqual(['e1']);
  });
});

describe('the change check, when GitHub answers something else', () => {
  it('more changes than one answer carries: the folders are listed again, nothing is lost', async () => {
    const { a, b, s, gh } = await space();
    const cur = (await a.mailbox.list(s)).cursor;
    await b.mailbox.post(s, bytes('one'));
    gh.compareOverflow = true;
    expect(await a.changes.check(s)).toBe(true);
    gh.compareOverflow = false;
    const r = await a.mailbox.list(s, cur);
    expect(r.items.map((i) => str(i.data))).toEqual(['one']);
    // And the check works again from there.
    await b.mailbox.post(s, bytes('two'));
    expect(await a.changes.check(s)).toBe(true);
    expect((await a.mailbox.list(s, r.cursor)).items.map((i) => str(i.data))).toEqual(['two']);
  });

  it('a log listing a commit behind the head never leaves a gap in what is read', async () => {
    const { a, b, s, gh } = await space();
    expect(await b.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    expect(await b.orderedLog.append(s, 1, bytes('e1'))).toBe('ok');
    // a's first listing of the shard comes from a GitHub copy that doesn't have e1 yet, though the
    // head a read just before already does.
    gh.faults = { laggingListing: { match: 'GET .*contents/log/' } };
    await a.changes.check(s);
    expect((await a.orderedLog.read(s, 0)).map(str)).toEqual(['e0']);
    gh.faults = undefined;
    expect(await b.orderedLog.append(s, 2, bytes('e2'))).toBe('ok');
    await a.changes.check(s);
    // The changes since name only e2: what a knows has a hole, so it lists again.
    expect((await a.orderedLog.read(s, 0)).map(str)).toEqual(['e0', 'e1', 'e2']);
  });

  it('an append refused because the view was behind lists the log on the next read', async () => {
    const { a, b, s, gh } = await space();
    expect(await b.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    expect(await b.orderedLog.append(s, 1, bytes('e1'))).toBe('ok');
    gh.faults = { laggingListing: { match: 'GET .*contents/log/' } };
    await a.changes.check(s);
    expect((await a.orderedLog.read(s, 0)).map(str)).toEqual(['e0']);
    gh.faults = undefined;
    // a thinks index 1 is free: GitHub says no, and the next read is a fresh listing.
    expect(await a.orderedLog.append(s, 1, bytes('mine'))).toBe('conflict');
    expect((await a.orderedLog.read(s, 0)).map(str)).toEqual(['e0', 'e1']);
  });

  it('history rewritten under the starting point: listed again', async () => {
    const { a, b, s, gh } = await space();
    const cur = (await a.mailbox.list(s)).cursor;
    await b.mailbox.post(s, bytes('one'));
    gh.rewrite(s, 'README.md', bytes('rewritten'));
    expect(await a.changes.check(s)).toBe(true);
    expect((await a.mailbox.list(s, cur)).items.map((i) => str(i.data))).toEqual(['one']);
  });

  it('an answer that lags behind says "nothing": the listing the app asks for now and then finds it', async () => {
    const { a, b, s, gh } = await space();
    const cur = (await a.mailbox.list(s)).cursor;
    gh.staleCompare = true;
    expect(await a.changes.check(s)).toBe(false);
    await b.mailbox.post(s, bytes('late'));
    expect(await a.changes.check(s)).toBe(false);
    expect((await a.mailbox.list(s, cur)).items).toEqual([]);
    a.changes.relist(s);
    const r = await a.mailbox.list(s, cur);
    expect(r.items.map((i) => str(i.data))).toEqual(['late']);
    // The answer catches up later and names the file again: it is not delivered twice.
    gh.staleCompare = false;
    await a.changes.check(s);
    expect((await a.mailbox.list(s, r.cursor)).items).toEqual([]);
  });

  it('a check that fails is not taken for an answer', async () => {
    const { a, b, s, gh } = await space();
    const cur = (await a.mailbox.list(s)).cursor;
    await b.mailbox.post(s, bytes('one'));
    gh.faults = { serverError: { match: '^GET .*/compare/', times: 9, status: 503 } };
    // 5xx after retries is an answer we don't understand: say "changed" and list.
    expect(await a.changes.check(s)).toBe(true);
    gh.faults = { secondaryLimit: { match: '^GET .*/(commits|compare/.*|contents/mail.*)$' } };
    await expect(a.mailbox.list(s, cur)).rejects.toMatchObject({ code: 'too_many_attempts' });
    gh.faults = undefined;
    expect((await a.mailbox.list(s, cur)).items.map((i) => str(i.data))).toEqual(['one']);
  });

  it('a new file that cannot be read yet keeps the check saying "changed" until it is delivered', async () => {
    const { a, b, s, gh } = await space();
    const cur = (await a.mailbox.list(s)).cursor;
    await b.mailbox.post(s, bytes('slow'));
    expect(await a.changes.check(s)).toBe(true);
    gh.faults = { serverError: [{ match: '^GET .*/git/blobs/', times: 1, status: 404 }, { match: '^GET .*/contents/mail/\\d{8}/', times: 1, status: 404 }] };
    const r1 = await a.mailbox.list(s, cur);
    expect(r1.items).toEqual([]);
    gh.faults = undefined;
    expect(await a.changes.check(s)).toBe(true);
    expect((await a.mailbox.list(s, r1.cursor)).items.map((i) => str(i.data))).toEqual(['slow']);
    expect(await a.changes.check(s)).toBe(false);
  });

  it('a folder dated far ahead does not move the cursor away from today', async () => {
    const { w, a, b, s, gh } = await space();
    let cur = (await a.mailbox.list(s)).cursor;
    const put = (path: string, text: string) =>
      gh.fetch(`${gh.api}/repos/${s}/contents/${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${gh.users.get('alice')!.token}` }, body: JSON.stringify({ message: 'x', content: Buffer.from(text).toString('base64') }) });
    await put('mail/20990101/zzzz-00aabbccdd', 'from the future');
    await a.changes.check(s);
    let r = await a.mailbox.list(s, cur);
    expect(r.items.map((i) => str(i.data))).toEqual(['from the future']);
    expect(JSON.parse(r.cursor).d < '2099').toBe(true);
    cur = r.cursor;
    await b.mailbox.post(s, bytes('today'));
    await a.changes.check(s);
    r = await a.mailbox.list(s, cur);
    expect(r.items.map((i) => str(i.data))).toEqual(['today']);
    // The same from listings alone (a browser that has just opened), with and without a cursor.
    const fresh = w.session('alice');
    expect((await fresh.mailbox.list(s)).items.map((i) => str(i.data)).sort()).toEqual(['from the future', 'today']);
    await b.mailbox.post(s, bytes('more'));
    expect((await w.session('alice').mailbox.list(s, r.cursor)).items.map((i) => str(i.data))).toEqual(['more']);
  });

  it('junk paths in the list of changes are ignored', async () => {
    const { a, b, s, gh } = await space();
    const cur = (await a.mailbox.list(s)).cursor;
    const put = (path: string) =>
      gh.fetch(`${gh.api}/repos/${s}/contents/${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${gh.users.get('alice')!.token}` }, body: JSON.stringify({ message: 'x', content: Buffer.from('junk').toString('base64') }) });
    await put(`mail/${today()}/folder/inside`);
    await put('mail/notaday/x');
    await put('log/00000/notanindex');
    await put('other/file');
    await b.mailbox.post(s, bytes('real'));
    expect(await a.changes.check(s)).toBe(true);
    expect((await a.mailbox.list(s, cur)).items.map((i) => str(i.data))).toEqual(['real']);
    expect(await a.orderedLog.read(s, 0)).toEqual([]);
  });
});

describe('files kept across reloads', () => {
  const store = () => {
    const m = new Map<string, Uint8Array>();
    return { m, get: async (sha: string) => m.get(sha), put: async (sha: string, d: Uint8Array) => void m.set(sha, d) };
  };
  const reads = (log: string[], from: number) => log.slice(from).filter((l) => /^GET .*\/contents\/(items|dir|log\/\d{5})\/[^/]+$/.test(l)).length;

  it('items, directory entries and log entries are downloaded once; a changed one again', async () => {
    const w = githubWorld();
    const kept = store();
    const open = () => {
      const u = w.gh.users.get('alice') ?? w.gh.addUser('alice');
      return githubProvider({ fetch: w.gh.fetch, token: u.token, login: 'alice', workerUrl: w.gh.worker, apiBase: w.gh.api, sleep: async () => {}, blobStore: kept });
    };
    const other = w.session('alice');
    const s = await other.channel.createSpace('chat');
    await other.directory.append(0, bytes('d0'));
    await other.personal.put('one', bytes('v1'), null);
    await other.orderedLog.append(s, 0, bytes('e0'));

    const pull = async (p: ReturnType<typeof open>) => {
      const items = await p.personal.list();
      const got = await Promise.all(items.map((i) => p.personal.get(i.id)));
      return { items: got.map((g) => str(g!.data)), dir: (await p.directory.read(w.address('alice'))).map(str), log: (await p.orderedLog.read(s, 0)).map(str) };
    };
    let from = w.gh.log.length;
    expect(await pull(open())).toEqual({ items: ['v1'], dir: ['d0'], log: ['e0'] });
    expect(reads(w.gh.log, from)).toBe(3);
    // After a reload (a new provider on the same store): nothing is downloaded.
    from = w.gh.log.length;
    expect(await pull(open())).toEqual({ items: ['v1'], dir: ['d0'], log: ['e0'] });
    expect(reads(w.gh.log, from)).toBe(0);
    // The item changes elsewhere: that one is read, and its new version is what comes back.
    const cur = (await other.personal.list())[0]!;
    await other.personal.put('one', bytes('v2'), cur.version);
    from = w.gh.log.length;
    expect(await pull(open())).toEqual({ items: ['v2'], dir: ['d0'], log: ['e0'] });
    expect(reads(w.gh.log, from)).toBe(1);
    // A damaged copy in the store is not believed: it is fetched again.
    for (const k of kept.m.keys()) kept.m.set(k, bytes('garbage'));
    from = w.gh.log.length;
    expect(await pull(open())).toEqual({ items: ['v2'], dir: ['d0'], log: ['e0'] });
    expect(reads(w.gh.log, from)).toBe(3);
  });

  it('several lookups of one person at the same time share one read', async () => {
    const { w, a, gh } = await space();
    await a.directory.append(0, bytes('d0'));
    const from = gh.log.length;
    const all = await Promise.all([1, 2, 3, 4].map(() => a.directory.read(w.address('alice'))));
    expect(all.map((d) => d.map(str))).toEqual([['d0'], ['d0'], ['d0'], ['d0']]);
    expect(gh.log.slice(from).filter((l) => l.endsWith('/contents/dir')).length).toBe(1);
  });
});

describe('steps that need no question', () => {
  const tidy = (log: string[], from: number) => log.slice(from).map((l) => l.replace(/\/repos\/[^/]+\/[^/]+\//, '/').replace(/compare\/.*/, 'compare'));

  it('a log entry right after the one we know is written without asking for the one before', async () => {
    const { a, b, s, gh } = await space();
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    await a.orderedLog.read(s, 0);
    let from = gh.log.length;
    expect(await a.orderedLog.append(s, 1, bytes('e1'))).toBe('ok');
    expect(tidy(gh.log, from)).toEqual(['PUT /contents/log/00000/00000001']);
    // Our own write is known too.
    from = gh.log.length;
    expect(await a.orderedLog.append(s, 2, bytes('e2'))).toBe('ok');
    expect(tidy(gh.log, from)).toEqual(['PUT /contents/log/00000/00000002']);
    // A gap is still refused: the entry before is not known, so it is asked for.
    expect(await a.orderedLog.append(s, 5, bytes('e5'))).toBe('conflict');
    // Someone else took the place first: the create fails, as before.
    expect(await b.orderedLog.append(s, 3, bytes('theirs'))).toBe('ok');
    expect(await a.orderedLog.append(s, 3, bytes('mine'))).toBe('conflict');
    expect((await a.orderedLog.read(s, 0)).map(str)).toEqual(['e0', 'e1', 'e2', 'theirs']);
  });

  it('a log entry on top of one we wrote ourselves needs no look either, even in a chat never read', async () => {
    const { a, s, gh } = await space();
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    const from = gh.log.length;
    expect(await a.orderedLog.append(s, 1, bytes('e1'))).toBe('ok');
    expect(tidy(gh.log, from)).toEqual(['PUT /contents/log/00000/00000001']);
  });

  it('two files at once go as two plain writes; more as one commit', async () => {
    const { a, b, s, gh } = await space();
    const cur = (await b.mailbox.list(s)).cursor;
    let from = gh.log.length;
    await a.mailbox.postMany!(s, [bytes('m1'), bytes('m2')]);
    expect(tidy(gh.log, from).map((l) => l.replace(/mail\/.*/, 'mail'))).toEqual(['PUT /contents/mail', 'PUT /contents/mail']);
    from = gh.log.length;
    await a.mailbox.postMany!(s, [bytes('m3'), bytes('m4'), bytes('m5')]);
    const made = tidy(gh.log, from);
    expect(made.filter((l) => l.startsWith('PUT'))).toEqual([]);
    expect(made.filter((l) => l === 'POST /git/commits')).toHaveLength(1);
    expect((await b.mailbox.list(s, cur)).items.map((i) => str(i.data))).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('a browser that knows nothing of the log still checks the entry before', async () => {
    const { a, b, s } = await space();
    expect(await a.orderedLog.append(s, 0, bytes('e0'))).toBe('ok');
    expect(await b.orderedLog.append(s, 2, bytes('gap'))).toBe('conflict');
    expect(await b.orderedLog.append(s, 1, bytes('e1'))).toBe('ok');
  });

  it('a drop that was read is deleted without a second read; one never read is looked up', async () => {
    const { a, b, s, gh } = await space();
    const id = await b.dropBox.put(s, 'tag1', bytes('welcome'));
    const other = await b.dropBox.put(s, 'tag1', bytes('second'));
    expect((await a.dropBox.list(s, 'tag1')).map((d) => str(d.data)).sort()).toEqual(['second', 'welcome']);
    let from = gh.log.length;
    await a.dropBox.delete(s, 'tag1', id);
    expect(tidy(gh.log, from)).toEqual([`DELETE /contents/drop/tag1/${id}`]);
    // Deleted twice (a retry after a lost reply): nothing breaks.
    await a.dropBox.delete(s, 'tag1', id);
    // A browser that never read it finds the version first.
    from = gh.log.length;
    await b.dropBox.delete(s, 'tag1', other);
    expect(tidy(gh.log, from)).toEqual([`GET /contents/drop/tag1/${other}`, `DELETE /contents/drop/tag1/${other}`]);
    expect(await a.dropBox.list(s, 'tag1')).toEqual([]);
  });

  it('an item the listing did not show is not asked for; a write to it still sees what is there', async () => {
    const { w, a, gh } = await space();
    const b = w.session('alice');
    await a.personal.put('one', bytes('v1'), null);
    await a.personal.list();
    let from = gh.log.length;
    expect(await a.personal.get('nope')).toBeUndefined();
    expect(tidy(gh.log, from)).toEqual([]);
    // The other browser makes it a moment later: the second look asks GitHub and finds it.
    await b.personal.put('nope', bytes('theirs'), null);
    from = gh.log.length;
    expect(str((await a.personal.get('nope'))!.data)).toBe('theirs');
    expect(tidy(gh.log, from)).toEqual(['GET /contents/items/nope']);
    // And a create on top of one made elsewhere since the listing is refused, not overwritten.
    await a.personal.list();
    await b.personal.put('late', bytes('theirs'), null);
    expect(await a.personal.get('late')).toBeUndefined();
    expect(await a.personal.put('late', bytes('mine'), null)).toBe('conflict');
    expect(str((await a.personal.get('late'))!.data)).toBe('theirs');
  });

  it('the directory is appended to without listing it twice; another browser in between is a conflict', async () => {
    const { w, a, gh } = await space();
    const b = w.session('alice');
    await a.directory.append(0, bytes('d0'));
    expect((await a.directory.read(w.address('alice'))).map(str)).toEqual(['d0']);
    let from = gh.log.length;
    expect(await a.directory.append(1, bytes('d1'))).toBe('ok');
    expect(tidy(gh.log, from).filter((l) => l === 'GET /contents/dir')).toEqual([]);
    // The count is used once: the next append lists for itself.
    from = gh.log.length;
    expect(await a.directory.append(2, bytes('d2'))).toBe('ok');
    expect(tidy(gh.log, from).filter((l) => l === 'GET /contents/dir')).toEqual(['GET /contents/dir']);
    // Both browsers read three entries, both append the fourth: one wins.
    await a.directory.read(w.address('alice'));
    await b.directory.read(w.address('alice'));
    expect(await b.directory.append(3, bytes('b3'))).toBe('ok');
    expect(await a.directory.append(3, bytes('a3'))).toBe('conflict');
    expect((await a.directory.read(w.address('alice'))).map(str)).toEqual(['d0', 'd1', 'd2', 'b3']);
  });

  it('a chat without mail costs no second look at the repo; a chat we lost still says so', async () => {
    const { w, a, s, gh } = await space();
    const from = gh.log.length;
    expect((await a.mailbox.list(s)).items).toEqual([]);
    expect(tidy(gh.log, from)).toEqual(['GET /commits', 'GET /contents/mail']);
    // Bob was never let in: the listing must fail, not come back empty.
    const bob = w.session('bob');
    await expect(bob.mailbox.list(s)).rejects.toThrow();
  });
});
