/** Sign-ins for the live checks against real GitHub (see token()). */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const WORKER = process.env.KEYHOLD_WORKER ?? 'https://chat-over-github.akagishigerutokyo.workers.dev';
export const API = 'https://api.github.com';
export const dir = `${homedir()}/.keyhold-live`;

export async function ghUser(token: string) {
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
export async function token(login: string): Promise<string> {
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

