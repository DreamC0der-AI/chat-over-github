/**
 * GitHub App sign-in. Two ways in:
 *  - web flow: redirect to GitHub and back, then the Worker swaps the code (it holds the secret)
 *  - device flow: show a code to type at github.com/login/device (works without a callback URL)
 * GitHub App user tokens expire after 8 hours; the refresh token is swapped through the Worker.
 */
import { CONFIG } from '../config';

export interface AuthState {
  token: string;
  refreshToken?: string;
  /** ms epoch; undefined when the token doesn't expire. */
  expiresAt?: number;
  login: string;
  id: number;
}

const KEY = 'kh.auth';
const PENDING = 'kh.oauth';

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export function loadAuth(): AuthState | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as AuthState) : undefined;
  } catch {
    return undefined;
  }
}

function saveAuth(a: AuthState | undefined) {
  if (a) localStorage.setItem(KEY, JSON.stringify(a));
  else localStorage.removeItem(KEY);
}

export function signOut() {
  saveAuth(undefined);
}

async function whoAmI(token: string): Promise<{ login: string; id: number }> {
  const r = await fetch(`${CONFIG.api}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!r.ok) throw new Error(`GitHub did not accept the sign-in (${r.status})`);
  const u = (await r.json()) as { login: string; id: number };
  return { login: u.login, id: u.id };
}

async function fromTokenResponse(t: TokenResponse): Promise<AuthState> {
  if (!t.access_token) throw new Error(t.error_description || t.error || 'GitHub did not return a token');
  const me = await whoAmI(t.access_token);
  const a: AuthState = {
    token: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
    login: me.login,
    id: me.id,
  };
  saveAuth(a);
  return a;
}

async function workerPost(path: string, body?: unknown): Promise<TokenResponse> {
  const r = await fetch(CONFIG.worker + path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`sign-in service error (${r.status})`);
  }
}

// ---- web flow ----

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export const redirectUri = () => `${location.origin}/`;

export async function startWebFlow() {
  const state = randomString(16);
  const verifier = randomString(48);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(PENDING, JSON.stringify({ state, verifier }));
  const q = new URLSearchParams({
    client_id: CONFIG.clientId,
    redirect_uri: redirectUri(),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  location.assign(`https://github.com/login/oauth/authorize?${q}`);
}

/** If this page load is GitHub's redirect back, finish signing in. */
export async function finishWebFlow(): Promise<AuthState | undefined> {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const err = q.get('error');
  if (!code && !err) return undefined;
  history.replaceState(null, '', location.pathname + location.hash);
  if (err) throw new Error(q.get('error_description') || err);
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null') as { state: string; verifier: string } | null;
  sessionStorage.removeItem(PENDING);
  if (!pending || pending.state !== q.get('state')) throw new Error('Sign-in was interrupted. Please try again.');
  return fromTokenResponse(await workerPost('/oauth/token', { code, redirect_uri: redirectUri(), code_verifier: pending.verifier }));
}

// ---- device flow ----

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  const r = (await workerPost('/oauth/device/code')) as unknown as DeviceCode & TokenResponse;
  if (!r.device_code) throw new Error(r.error_description || r.error || 'Device sign-in is not available');
  return r;
}

export async function pollDeviceFlow(code: DeviceCode, signal: AbortSignal): Promise<AuthState> {
  let interval = (code.interval || 5) * 1000;
  const end = Date.now() + code.expires_in * 1000;
  while (!signal.aborted && Date.now() < end) {
    await new Promise((r) => setTimeout(r, interval));
    if (signal.aborted) break;
    const t = await workerPost('/oauth/device/token', { device_code: code.device_code });
    if (t.access_token) return fromTokenResponse(t);
    if (t.error === 'slow_down') interval += 5000;
    else if (t.error !== 'authorization_pending') throw new Error(t.error_description || t.error || 'Sign-in failed');
  }
  throw new Error('The code expired. Start again.');
}

// ---- mock (tests) ----

export async function mockSignIn(login: string): Promise<AuthState> {
  return fromTokenResponse({ access_token: `tok-${login.toLowerCase()}` });
}

// ---- token upkeep ----

/** Answers from GitHub that mean the refresh token itself is no good: the person must sign in again. */
const DEAD_REFRESH = new Set(['bad_refresh_token', 'invalid_grant']);

/** A refresh that failed for a reason that may pass (offline, the Worker or GitHub down). */
export class RefreshFailedError extends Error {
  constructor(cause?: unknown) {
    super(cause instanceof TypeError ? 'Offline. Retrying…' : 'Sign-in service unavailable. Retrying…');
  }
}

let refreshing: Promise<AuthState> | undefined;

/** Runs fn while holding the browser-wide refresh lock, so two tabs never spend the same refresh token. */
function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? (locks.request('kh.auth.refresh', fn) as Promise<T>) : fn();
}

const expiresSoon = (a: AuthState) => a.expiresAt !== undefined && a.expiresAt - Date.now() < 5 * 60_000;

/**
 * A valid access token, refreshed when it is about to expire. `force` means GitHub just turned the
 * current token down (401). A refresh that fails for a passing reason (offline, a lost answer while
 * the computer slept) throws RefreshFailedError and keeps the stored sign-in; only GitHub saying the
 * refresh token is dead signs out.
 */
export async function currentToken(force = false): Promise<string> {
  const seen = loadAuth();
  if (!seen) throw new SignedOutError();
  if (!force && !expiresSoon(seen)) return seen.token;
  if (!seen.refreshToken) {
    if (force) throw new SignedOutError();
    return seen.token;
  }
  refreshing ??= withRefreshLock(async () => {
    // Another tab may have refreshed while this one waited for the lock: use its token.
    const a = loadAuth();
    if (!a) throw new SignedOutError();
    if (a.token !== seen.token && !expiresSoon(a)) return a;
    if (!a.refreshToken) throw new SignedOutError();
    let t: TokenResponse;
    try {
      t = await workerPost('/oauth/token', { refresh_token: a.refreshToken });
    } catch (e) {
      throw new RefreshFailedError(e);
    }
    if (t.access_token) {
      // Save straight away (same account, no lookup): the old refresh token is spent now.
      const next: AuthState = { ...a, token: t.access_token, refreshToken: t.refresh_token ?? a.refreshToken, expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined };
      saveAuth(next);
      return next;
    }
    if (t.error && DEAD_REFRESH.has(t.error)) {
      // Only forget the sign-in this refresh was for, never a newer one saved meanwhile.
      if (loadAuth()?.refreshToken === a.refreshToken) saveAuth(undefined);
      throw new SignedOutError();
    }
    throw new RefreshFailedError(new Error(t.error_description || t.error || 'no token'));
  }).finally(() => {
    refreshing = undefined;
  });
  return (await refreshing).token;
}

export class SignedOutError extends Error {
  constructor() {
    super('Signed out. Please sign in again.');
  }
}
