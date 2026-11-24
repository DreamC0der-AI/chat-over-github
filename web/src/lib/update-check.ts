import { useSyncExternalStore } from 'react';

/** The app bundle a page of index.html loads, e.g. "index-Cza-58hi.js". */
export function bundleOf(html: string): string | undefined {
  return /\/assets\/(index-[\w-]+\.js)/.exec(html)?.[1];
}

const EVERY_MS = 10 * 60_000;
const AT_MOST_MS = 60_000;

let newer = false;
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

/** Check the server every 10 minutes and when the tab comes back into view (at most once a minute). */
function start() {
  const mine = bundleOf([...document.scripts].map((s) => s.getAttribute('src') ?? '').join(' '));
  if (!mine) return () => {}; // dev server: no bundle
  let last = 0;
  let stopped = false;
  const check = async () => {
    if (stopped || newer || Date.now() - last < AT_MOST_MS) return;
    last = Date.now();
    try {
      const res = await fetch(`${location.origin}${location.pathname}`, { cache: 'no-store' });
      const live = res.ok ? bundleOf(await res.text()) : undefined;
      if (live && live !== mine && !stopped) {
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
  const timer = setInterval(() => void check(), EVERY_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
  };
}

function subscribe(l: () => void) {
  listeners.add(l);
  stop ??= start();
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      stop?.();
      stop = undefined;
    }
  };
}

/**
 * True once the server has a newer build than this tab runs. A tab can stay open for days, and
 * one running old code can break a chat for everyone in it, so the app asks for a reload.
 * One checker serves every screen that shows the notice.
 */
export function useNewVersion(): boolean {
  return useSyncExternalStore(subscribe, () => newer);
}
