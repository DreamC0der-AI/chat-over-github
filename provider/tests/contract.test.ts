// The in-memory GitHub must answer the membership calls as real GitHub does: the same probe
// (scripts/github-contract.ts) ran against real GitHub and its answers are kept in
// github-contract.real.json. Re-record with scripts/live-contract.ts when GitHub changes.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MockGitHub } from './github-mock';
import { probe } from '../scripts/github-contract';

const REAL = new URL('./github-contract.real.json', import.meta.url);

describe('the GitHub stand-in matches real GitHub', () => {
  it('membership calls answer the same', async () => {
    const gh = new MockGitHub();
    const a = gh.addUser('owner-a');
    const b = gh.addUser('invitee-b');
    const steps = await probe({ fetch: gh.fetch as never, api: gh.api, owner: { login: a.login, token: a.token }, invitee: { login: b.login, token: b.token }, repo: 'ghchat-contract' });
    if (process.env.PRINT_CONTRACT) console.log(JSON.stringify(steps, null, 2));
    if (!existsSync(REAL)) return;
    const real = JSON.parse(readFileSync(REAL, 'utf8')) as { steps: typeof steps };
    expect(steps).toEqual(real.steps);
  });
});
