// Avatars kept on this browser, so a reload or a tab coming back shows them at once.
//
// Each login's picture is kept in localStorage as a small data URL (read synchronously, so the
// first render already has it), with the CDN's ETag and when it was last checked. At most once
// an hour per login, a background request asks the CDN "still this ETag?" (If-None-Match). The
// usual answer is a bodiless 304; only a real change downloads and swaps the picture.
// These requests go to avatars.githubusercontent.com, not the GitHub API, so they don't count
// against API limits, and nothing waits for them.

import { useEffect, useSyncExternalStore } from 'react';

const PREFIX = 'cog.avatar.';
/** How long a kept avatar is trusted before the next background check. */
export const CHECK_MS = 60 * 60 * 1000;
/** Pixels of the kept copy (lists draw avatars at up to 48 CSS px, so this is sharp at 2x). */
const PX = 96;
/** Keep at most this many logins; the least recently checked go first. */
const MAX_KEPT = 300;

interface Kept {
  /** data: URL of the picture. */
  d: string;
  /** The CDN's ETag for it ('' if it sent none). */
  e: string;
  /** When it was last fetched or confirmed (ms). */
  t: number;
}

export type AvatarState = { src: string } | { failed: true } | null;

const url = (login: string) => `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=${PX}`;
/** What the old code showed; used when the CDN can't be fetched from script (e.g. blocked). */
const plainUrl = (login: string) => `https://github.com/${encodeURIComponent(login)}.png?size=${PX}`;

function readKept(login: string): Kept | null {
  try {
    const raw = localStorage.getItem(PREFIX + login);
    if (!raw) return null;
    const k = JSON.parse(raw) as Kept;
    return typeof k?.d === 'string' && k.d.startsWith('data:image/') ? k : null;
  } catch {
    return null;
  }
}

function writeKept(login: string, k: Kept) {
  const value = JSON.stringify(k);
  for (let tries = 0; tries < 3; tries++) {
    try {
      localStorage.setItem(PREFIX + login, value);
      return;
    } catch {
      // Full: make room by dropping the oldest few, then try again.
      if (!evict(10, login)) return;
    }
  }
}

/** Logins kept on this browser, oldest check first. */
function keptLogins(): { login: string; t: number }[] {
  const out: { login: string; t: number }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const login = key.slice(PREFIX.length);
      out.push({ login, t: readKept(login)?.t ?? 0 });
    }
  } catch { /* storage off */ }
  return out.sort((a, b) => a.t - b.t);
}

function evict(n: number, keep?: string): number {
  let gone = 0;
  for (const { login } of keptLogins()) {
    if (gone >= n) break;
    if (login === keep) continue;
    try { localStorage.removeItem(PREFIX + login); } catch { /* ignore */ }
    gone++;
  }
  return gone;
}

/** Remove every kept avatar ("Forget this browser"). */
export function forgetAvatars() {
  for (const { login } of keptLogins()) {
    try { localStorage.removeItem(PREFIX + login); } catch { /* ignore */ }
  }
  state.clear();
  emit();
}

// ---- in-page state ----

const state = new Map<string, AvatarState>();
/** Logins checked (or being checked) during this page's life. */
const started = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

function current(login: string): AvatarState {
  if (!state.has(login)) {
    const k = readKept(login);
    state.set(login, k ? { src: k.d } : null);
  }
  return state.get(login)!;
}

function set(login: string, s: AvatarState) {
  state.set(login, s);
  emit();
}

/** Shrink to PX×PX so the kept copy stays a few KB. Falls back to the original bytes. */
async function toDataUrl(blob: Blob): Promise<string> {
  try {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = c.height = PX;
    const g = c.getContext('2d')!;
    g.drawImage(bmp, 0, 0, PX, PX);
    bmp.close?.();
    let d = c.toDataURL('image/webp', 0.85);
    // Browsers without a WebP encoder hand back PNG, which is large for photos.
    if (!d.startsWith('data:image/webp')) {
      g.globalCompositeOperation = 'destination-over';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, PX, PX);
      d = c.toDataURL('image/jpeg', 0.85);
    }
    return d;
  } catch {
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }
}

/** Check one login against the CDN in the background (once per page, and only if due). */
async function check(login: string, now = Date.now()) {
  if (started.has(login)) return;
  started.add(login);
  const k = readKept(login);
  if (k && now - k.t < CHECK_MS) return;
  let r: Response;
  try {
    r = await fetch(url(login), { headers: k?.e ? { 'If-None-Match': k.e } : {}, cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    // Offline or blocked: keep showing the kept copy; with none, let the browser load it as before.
    if (!k) set(login, { src: plainUrl(login) });
    started.delete(login); // try again on the next mount
    return;
  }
  if (r.status === 304 && k) {
    writeKept(login, { ...k, t: now });
    return;
  }
  if (r.status === 404) {
    try { localStorage.removeItem(PREFIX + login); } catch { /* ignore */ }
    set(login, { failed: true });
    return;
  }
  if (!r.ok) {
    if (!k) set(login, { src: plainUrl(login) });
    return;
  }
  const etag = r.headers.get('ETag') ?? '';
  if (k && etag && etag === k.e) {
    writeKept(login, { ...k, t: now });
    return;
  }
  try {
    const d = await toDataUrl(await r.blob());
    if (!k && keptLogins().length >= MAX_KEPT) evict(1, login);
    writeKept(login, { d, e: etag, t: now });
    set(login, { src: d });
  } catch {
    if (!k) set(login, { src: plainUrl(login) });
  }
}

/** The avatar to draw for a login: a kept copy at once, refreshed in the background when due. */
export function useAvatar(login: string | undefined): AvatarState {
  const s = useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => void listeners.delete(f);
    },
    () => (login ? current(login) : null),
  );
  useEffect(() => {
    if (login) void check(login);
  }, [login]);
  return s;
}

/** The <img> failed to draw: forget the kept copy and show initials. */
export function avatarFailed(login: string) {
  try { localStorage.removeItem(PREFIX + login); } catch { /* ignore */ }
  set(login, { failed: true });
}

/** Testing aid. */
export const _avatarsForTest = { check, reset: () => { state.clear(); started.clear(); } };
