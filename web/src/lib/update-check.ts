import { useSyncExternalStore } from 'react';

/** The app bundle a page of index.html loads, e.g. "index-Cza-58hi.js". */
export function bundleOf(html: string): string | undefined {
  return /\/assets\/(index-[\w-]+\.js)/.exec(html)?.[1];
}

const EVERY_MS = 10 * 60_000;
const AT_MOST_MS = 60_000;

let newer = false;
let started = false;
const listeners = new Set<() => void>();

/** Starts the one check per tab (every 10 minutes, and when the tab comes back into view). */
function start() {
  if (started) return;
  started = true;
  const mine = bundleOf([...document.scripts].map((s) => s.getAttribute('src') ?? '').join(' '));
  if (!mine) return; // dev server: no bundle
  let last = 0;
  const check = async () => {
    if (newer || Date.now() - last < AT_MOST_MS) return;
    last = Date.now();
    try {
      const res = await fetch(`${location.origin}${location.pathname}`, { cache: 'no-store' });
      const live = res.ok ? bundleOf(await res.text()) : undefined;
      if (live && live !== mine) {
        newer = true;
        listeners.forEach((l) => l());
      }
    } catch {
      /* offline: try again later */
    }
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') void check();
  };
  setInterval(() => void check(), EVERY_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
}

/**
 * True once the server has a newer build than this tab runs. A tab can stay open for days, and
 * one running old code can break a chat for everyone in it, so the app asks for a reload.
 */
export function useNewVersion(): boolean {
  start();
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => newer,
  );
}
