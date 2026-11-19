// Per-browser look preferences: the colour theme and the chat list's width.
// They live in localStorage (not the synced store), so each browser can look its own way.

export type ThemeChoice = 'system' | 'light' | 'dark' | 'dimmed';
export const THEMES: { id: ThemeChoice; name: string }[] = [
  { id: 'system', name: 'System' },
  { id: 'light', name: 'Light' },
  { id: 'dark', name: 'Dark' },
  { id: 'dimmed', name: 'Dark dimmed' },
];
const THEME_KEY = 'cog.theme';
const dark = matchMedia('(prefers-color-scheme: dark)');

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode: keep it for this visit only */ }
}

export function themeChoice(): ThemeChoice {
  const t = read(THEME_KEY);
  return THEMES.some((x) => x.id === t) ? (t as ThemeChoice) : 'system';
}
function applyTheme() {
  const c = themeChoice();
  document.documentElement.dataset.theme = c === 'system' ? (dark.matches ? 'dark' : 'light') : c;
}
const listeners = new Set<() => void>();
export function setTheme(c: ThemeChoice) {
  write(THEME_KEY, c);
  applyTheme();
  listeners.forEach((f) => f());
}
export function onTheme(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
/** Called once at start-up; index.html already set the theme before first paint. */
export function initTheme() {
  applyTheme();
  dark.addEventListener('change', applyTheme);
  addEventListener('storage', (e) => { if (e.key === THEME_KEY) { applyTheme(); listeners.forEach((f) => f()); } });
}

// Chat list width (desktop only; phones show one pane at a time).
export const SIDE_DEFAULT = 320;
export const SIDE_MIN = 240;
export const SIDE_MAX = 520;
const SIDE_KEY = 'cog.sidebarWidth';
/** Leave at least this much room for the open chat. */
const CHAT_MIN = 380;
export function clampSide(w: number) {
  const max = Math.max(SIDE_MIN, Math.min(SIDE_MAX, innerWidth - CHAT_MIN));
  return Math.round(Math.min(max, Math.max(SIDE_MIN, w)));
}
export function sideWidth() {
  const n = Number(read(SIDE_KEY));
  return Number.isFinite(n) && n > 0 ? n : SIDE_DEFAULT;
}
export function saveSideWidth(w: number) {
  write(SIDE_KEY, String(Math.round(w)));
}
