/**
 * Records what real GitHub answers to the membership calls (scripts/github-contract.ts) into
 * tests/github-contract.real.json, for the stand-in test (tests/contract.test.ts).
 *   npm run live:contract -w provider -- <ownerLogin> <inviteeLogin>
 * Sign-ins as for live-github (scripts/live-auth.ts). Makes one repo (ghchat-live-contract-*)
 * on the owner's account and deletes it at the end.
 */
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { API, token } from './live-auth.js';
import { probe } from './github-contract.js';

async function main() {
  const [la, lb, outFile] = process.argv.slice(2);
  if (!la || !lb) throw new Error('usage: live-contract.mjs <ownerLogin> <inviteeLogin> [out.json]');
  const owner = { login: la, token: await token(la) };
  const invitee = { login: lb, token: await token(lb) };
  const repo = `ghchat-live-contract-${randomBytes(3).toString('hex')}`;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  try {
    const steps = await probe({ fetch: (u, i) => fetch(u, i), api: API, owner, invitee, repo, settle: () => sleep(2500) });
    for (const s of steps) console.log(`${String(s.status).padEnd(4)} ${s.step}${s.facts ? ` ${JSON.stringify(s.facts)}` : ''}`);
    const file = outFile ?? new URL('../tests/github-contract.real.json', import.meta.url).pathname;
    writeFileSync(file, `${JSON.stringify({ recorded: new Date().toISOString().slice(0, 10), note: 'Answers of real GitHub to scripts/github-contract.ts, signed in through the chatovergithub GitHub App. Re-record with npm run live:contract -w provider.', steps }, null, 2)}\n`);
    console.log(`\nwrote ${file}`);
  } finally {
    // The probe deletes the repo itself; this catches a run that stopped part way.
    await fetch(`${API}/repos/${la}/${repo}`, { method: 'DELETE', headers: { Authorization: `Bearer ${owner.token}` } }).catch(() => undefined);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
