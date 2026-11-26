/**
 * What GitHub answers to the membership calls the app makes: create a private repo, invite,
 * invite again, decline, accept, remove, leave, withdraw, delete. Each step records the HTTP
 * status (and a few yes/no facts), never ids or tokens, so the result can be committed.
 *
 * The same probe runs against the in-memory GitHub (provider/tests/contract.test.ts, every
 * change) and real GitHub (scripts/live-contract.ts, on a computer with the test accounts'
 * sign-ins). The real answers are kept in tests/github-contract.real.json; the test fails when
 * the stand-in answers differently, so it can't drift from GitHub without anyone noticing.
 */
export interface ContractEnv {
  fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; text(): Promise<string> }>;
  api: string;
  owner: { login: string; token: string };
  invitee: { login: string; token: string };
  /** A name not in use on the owner's account. */
  repo: string;
  /** Wait before a read that real GitHub may answer from a copy a moment behind. */
  settle?: () => Promise<void>;
}

export interface ContractStep {
  step: string;
  status: number;
  /** Plain facts the step found, e.g. { listed: true }. */
  facts?: Record<string, boolean | number>;
}

export async function probe(env: ContractEnv): Promise<ContractStep[]> {
  const out: ContractStep[] = [];
  const A = env.owner;
  const B = env.invitee;
  const full = `${A.login}/${env.repo}`;
  const settle = env.settle ?? (async () => undefined);
  const call = async (who: { token: string }, method: string, path: string, body?: unknown) => {
    const r = await env.fetch(`${env.api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${who.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: r.status, json };
  };
  const rec = (step: string, status: number, facts?: ContractStep['facts']) => {
    out.push(facts ? { step, status, facts } : { step, status });
  };
  const invitations = async () => {
    const r = await call(A, 'GET', `/repos/${full}/invitations`);
    return Array.isArray(r.json) ? (r.json as { id: number; invitee?: { login: string } }[]).filter((i) => i.invitee?.login?.toLowerCase() === B.login.toLowerCase()) : [];
  };
  const invite = async (step: string) => {
    const r = await call(A, 'PUT', `/repos/${full}/collaborators/${B.login}`, { permission: 'push' });
    rec(step, r.status, { gaveInvitation: !!r.json?.id });
    return r.json?.id as number | undefined;
  };
  const bReads = async (step: string) => {
    await settle();
    rec(step, (await call(B, 'GET', `/repos/${full}`)).status);
  };

  rec('owner creates a private repo', (await call(A, 'POST', '/user/repos', { name: env.repo, private: true, auto_init: true })).status);
  await settle();
  await bReads('invitee reads it before any invitation');

  const id1 = await invite('owner invites');
  const again = await call(A, 'PUT', `/repos/${full}/collaborators/${B.login}`, { permission: 'push' });
  rec('owner invites again while the first is open', again.status, { sameInvitation: again.json?.id === id1 });
  rec('owner lists invitations', 200, { open: (await invitations()).length });
  const mine = await call(B, 'GET', '/user/repository_invitations');
  rec('invitee lists their invitations', mine.status, { listed: Array.isArray(mine.json) && mine.json.some((i: { id: number }) => i.id === id1) });
  await bReads('invitee reads the repo while invited');

  rec('invitee declines', (await call(B, 'DELETE', `/user/repository_invitations/${id1}`)).status);
  rec('owner lists invitations after the decline', 200, { open: (await invitations()).length });
  const id2 = await invite('owner invites after the decline');
  rec('the new invitation is a new one', 200, { newId: id2 !== undefined && id2 !== id1 });

  rec('owner removes the invitee as collaborator while only invited', (await call(A, 'DELETE', `/repos/${full}/collaborators/${B.login}`)).status);
  const left = await invitations();
  rec('owner lists invitations after that removal', 200, { open: left.length });
  for (const i of left) await call(A, 'DELETE', `/repos/${full}/invitations/${i.id}`);

  const id3 = await invite('owner invites again');
  rec('invitee accepts', (await call(B, 'PATCH', `/user/repository_invitations/${id3}`)).status);
  await bReads('invitee reads the repo after accepting');
  rec('invitee accepts the same invitation again', (await call(B, 'PATCH', `/user/repository_invitations/${id3}`)).status);
  const w = await call(B, 'PUT', `/repos/${full}/contents/probe.txt`, { message: 'probe', content: Buffer.from('hi').toString('base64') });
  rec('invitee writes a file', w.status);
  await invite('owner invites someone who is already a collaborator');
  const collabs = await call(A, 'GET', `/repos/${full}/collaborators`);
  rec('owner lists collaborators', collabs.status, { listed: Array.isArray(collabs.json) && collabs.json.some((c: { login: string }) => c.login.toLowerCase() === B.login.toLowerCase()) });

  rec('owner removes the collaborator', (await call(A, 'DELETE', `/repos/${full}/collaborators/${B.login}`)).status);
  await bReads('removed collaborator reads the repo');
  await settle();
  rec('removed collaborator writes a file', (await call(B, 'PUT', `/repos/${full}/contents/probe2.txt`, { message: 'probe', content: Buffer.from('hi').toString('base64') })).status);
  const id4 = await invite('owner invites the removed person again');
  rec('removed person accepts the new invitation', (await call(B, 'PATCH', `/user/repository_invitations/${id4}`)).status);
  await bReads('they read the repo again');

  rec('collaborator leaves (removes themselves)', (await call(B, 'DELETE', `/repos/${full}/collaborators/${B.login}`)).status);
  await bReads('they read the repo after leaving');
  rec('collaborator who left tries to remove the owner', (await call(B, 'DELETE', `/repos/${full}/collaborators/${A.login}`)).status);

  const id5 = await invite('owner invites the one who left');
  rec('owner withdraws the invitation', (await call(A, 'DELETE', `/repos/${full}/invitations/${id5}`)).status);
  rec('invitee accepts the withdrawn invitation', (await call(B, 'PATCH', `/user/repository_invitations/${id5}`)).status);

  const id6 = await invite('owner invites once more');
  rec('invitee tries to invite someone (not the owner)', (await call(B, 'PUT', `/repos/${full}/collaborators/${A.login}`, { permission: 'push' })).status);
  rec('owner deletes the repo', (await call(A, 'DELETE', `/repos/${full}`)).status);
  rec('invitee accepts an invitation to the deleted repo', (await call(B, 'PATCH', `/user/repository_invitations/${id6}`)).status);
  return out;
}
