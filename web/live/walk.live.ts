/**
 * Membership walkthroughs against real GitHub: the same model as the stand-in walkthroughs
 * (tests/walk.ts), with three real accounts. Each browser is the app's own logic (Session) in
 * Node, signed in as that account.
 *
 *   WALK_LOGINS=ungigdu,encprotocol,dreamc0der-ai npm run live:walk -w web
 *
 * Sign-ins come from ~/.keyhold-live/<login>.json as for the provider's live check
 * (provider/scripts/live-auth.ts). Repos are named keyhold-walk-id, chat-walk-home and
 * ghchat-walk-*; all of them are deleted before and after. Invitations go through the real
 * Worker inbox, so an open copy of the app signed in as a test account may show one for a moment.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { world, type World } from '../tests/harness';
import { Walk } from '../tests/walk';
import { API, token } from '../../provider/scripts/live-auth';

const LOGINS = (process.env.WALK_LOGINS ?? 'ungigdu,encprotocol,dreamc0der-ai').split(',').map((l) => l.trim().toLowerCase());
const NAMES = ['keyhold-walk-id', 'chat-walk-home'];
const tokens: Record<string, string> = {};
let w: World | undefined;

async function cleanup() {
  const out: string[] = [];
  for (const l of LOGINS) {
    const h = { authorization: `Bearer ${tokens[l]}`, accept: 'application/vnd.github+json' };
    const repos = (await (await fetch(`${API}/user/repos?affiliation=owner&per_page=100`, { headers: h })).json()) as { name: string; full_name: string }[];
    for (const r of Array.isArray(repos) ? repos : []) {
      if (NAMES.includes(r.name) || r.name.startsWith('ghchat-walk-')) out.push(`${r.full_name}: ${(await fetch(`${API}/repos/${r.full_name}`, { method: 'DELETE', headers: h })).status}`);
    }
  }
  console.log('cleanup', out);
}

async function people(w: World) {
  const map = new Map<string, Awaited<ReturnType<World['browser']>>[]>();
  const codes = new Map<string, string>();
  for (const l of LOGINS) {
    const b = await w.browser(l);
    if (b.s.phase !== 'new-identity') throw new Error(`${l}: the app is at "${b.s.phase}" (${b.s.error ?? ''}), expected a new identity`);
    codes.set(l, await b.setup());
    map.set(l, [b]);
  }
  await w.rounds(2);
  return { map, codes };
}

beforeAll(async () => {
  for (const l of LOGINS) tokens[l] = await token(l);
  await cleanup();
});
afterAll(async () => {
  try {
    w?.stop();
  } finally {
    await cleanup();
  }
});

const t0 = Date.now();
const step = (s: string) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${s}`);

describe('membership on real GitHub', () => {
  it('group: alone, invite, decline, re-invite, accept, remove, re-invite, leave, re-invite', async () => {
    w = await world({ tokens, api: API, pauseMs: 2500 });
    const { map, codes } = await people(w);
    // With two accounts the third person's steps are left out.
    const [admin, b, c] = LOGINS as [string, string, string | undefined];
    const walk = new Walk(w, map, admin, 'Walk group');
    const log = (s: string) => step(s);
    const steps: [string, () => Promise<unknown>][] = [
      ['create alone and write', async () => { await walk.create(); await walk.send(admin); }],
      [`invite ${b}, ${b} declines`, async () => { await walk.invite(b); await walk.decline(b); await walk.send(admin); }],
      [`invite ${b} again, ${b} accepts`, async () => { await walk.invite(b); await walk.accept(b); await walk.send(b); }],
      [`invite ${c}, ${c} accepts on a second browser too`, async () => { await walk.invite(c!); await walk.accept(c!); await walk.newBrowser(c!, codes.get(c!)!); await walk.send(c!); }],
      [`remove ${c}, write`, async () => { await walk.remove(c!); await walk.send(b); }],
      [`invite ${c} back, accept`, async () => { await walk.invite(c!); await walk.accept(c!); await walk.send(admin); }],
      [`remove ${b}, write, invite ${b} back`, async () => { await walk.remove(b); await walk.send(admin); await walk.check(); await walk.invite(b); await walk.accept(b); await walk.send(b); }],
      [`${b} leaves, write, invite ${b} back`, async () => { await walk.leave(b); await walk.send(admin); await walk.check(); await walk.invite(b); await walk.accept(b); await walk.send(b); }],
      ['rename', async () => { await walk.rename('Walk group 2'); await walk.send(admin); }],
    ];
    const runnable = c ? steps : steps.filter(([name]) => !name.includes('undefined'));
    for (const [name, run] of runnable) {
      log(name);
      await run();
      await walk.check(40);
      log(`  ok`);
    }
    w.stop();
    w = undefined;
  });

  it('DM: start, decline, the other starts, talk, quit, start again, close', async () => {
    await cleanup();
    w = await world({ tokens, api: API, pauseMs: 2500 });
    const { map } = await people(w);
    const [x, y] = LOGINS.map((l) => map.get(l)![0]!) as [NonNullable<ReturnType<typeof map.get>>[0], NonNullable<ReturnType<typeof map.get>>[0]];
    const until = (c: () => boolean | Promise<boolean>, what: string) => w!.until(c, what, 40);
    const talk = async (p: typeof x, q: typeof x, tag: string) => {
      await until(() => !!p.chat(q.login)?.live && !!q.chat(p.login)?.live, `${tag}: live on both`);
      await p.s.send(p.chat(q.login)!.live!, `${tag} 1`);
      await q.s.send(q.chat(p.login)!.live!, `${tag} 2`);
      await until(async () => (await q.texts(q.chat(p.login))).includes(`${tag} 1`) && (await p.texts(p.chat(q.login))).includes(`${tag} 2`), `${tag}: both read`);
      expect(p.chats().filter((c) => c.title === q.login)).toHaveLength(1);
    };
    step('x starts, y declines');
    await x.s.startDm(y.login);
    await until(() => !!y.inviteFrom(x.login), 'y sees it');
    await y.s.declineInvite(y.inviteFrom(x.login)!.key);
    step('y starts instead');
    await y.s.startDm(x.login);
    await until(() => !!x.inviteFrom(y.login) || !!x.chat(y.login)?.live?.members().some((m) => m.address === `github:${y.login}` && !m.pending), 'x sees it or joins');
    if (x.inviteFrom(y.login)) await x.s.acceptInvite(x.inviteFrom(y.login)!.key);
    await talk(x, y, 'first');
    step('y quits, x starts again');
    await y.s.quitChat(y.chat(x.login)!.live!).catch(() => y.s.closeChat(y.chat(x.login)!.live!));
    await until(() => !y.chat(x.login)?.live, 'y is out');
    await x.s.startDm(y.login);
    await until(() => !!y.inviteFrom(x.login), 'y sees it');
    await y.s.acceptInvite(y.inviteFrom(x.login)!.key);
    await talk(x, y, 'second');
    step('owner closes');
    const owner = x.s.isOwner(x.chat(y.login)!.live!) ? x : y;
    const other = owner === x ? y : x;
    await owner.s.closeChat(owner.chat(other.login)!.live!);
    await until(() => other.chat(owner.login)?.rooms.at(-1)?.ended?.how === 'closed', 'the other sees it closed');
    await w.checkConverged();
    step('ok');
  });
});
