import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const EMOJI = ['👍', '❤️', '😂', '🎉', '👀'];

/** Where a message popup opens: at the pointer (right-click), or beside the bubble. */
export type Anchor = { x: number; y: number } | { rect: DOMRect; mine: boolean; prefer: 'above' | 'below' };

const GAP = 6;
const EDGE = 8;

/** Keeps the popup on screen. Beside a bubble it lines up with the bubble's outer edge
 *  (left for theirs, right for mine) and flips above/below when there is no room. */
function place(a: Anchor, w: number, h: number) {
  const W = innerWidth;
  const H = innerHeight;
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, W - w - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, H - h - EDGE));
  if ('x' in a) {
    const left = a.x + w + EDGE > W ? a.x - w : a.x;
    const top = a.y + h + EDGE > H ? a.y - h : a.y;
    return { left: clampX(left), top: clampY(top) };
  }
  const r = a.rect;
  const left = clampX(a.mine ? r.right - w : r.left);
  const above = r.top - GAP - h;
  const below = r.bottom + GAP;
  const fitsAbove = above >= EDGE;
  const fitsBelow = below + h <= H - EDGE;
  let top: number;
  if (a.prefer === 'above') top = fitsAbove ? above : fitsBelow ? below : clampY(above);
  else top = fitsBelow ? below : fitsAbove ? above : clampY(below);
  return { left, top };
}

/** A floating panel for one message. Closes on outside click, Escape, scroll or resize. */
export function MsgPopup({ anchor, label, onClose, children, className = '' }: { anchor: Anchor; label: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>();
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPos(place(anchor, el.offsetWidth, el.offsetHeight));
  }, [anchor]);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        prev?.focus?.({ preventScroll: true });
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (i < 0 || !items.length) return;
        e.preventDefault();
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
        items[(i + step + items.length) % items.length]!.focus();
      }
    };
    const shut = () => onClose();
    // Wait a tick so the click or touch that opened the popup doesn't close it again.
    const t = setTimeout(() => {
      addEventListener('pointerdown', away, true);
      addEventListener('scroll', shut, true);
    });
    addEventListener('keydown', key);
    addEventListener('resize', shut);
    return () => {
      clearTimeout(t);
      removeEventListener('pointerdown', away, true);
      removeEventListener('scroll', shut, true);
      removeEventListener('keydown', key);
      removeEventListener('resize', shut);
    };
  }, []);
  return createPortal(
    <div ref={ref} className={`msg-pop ${className}`} role="menu" aria-label={label} style={pos ? { ...pos, visibility: 'visible' } : undefined} onContextMenu={(e) => e.preventDefault()}>
      {children}
    </div>,
    document.body,
  );
}

/** The five quick reactions. Ones you've already added show as selected and take it back. */
export function EmojiRow({ mineOf, onPick }: { mineOf: (e: string) => 'yes' | 'no' | 'pending'; onPick: (e: string) => void }) {
  return (
    <div className="emoji-row">
      {EMOJI.map((e) => {
        const s = mineOf(e);
        return (
          <button key={e} type="button" role="menuitemcheckbox" aria-checked={s === 'yes'} className={`emoji${s === 'yes' ? ' on' : ''}`} disabled={s === 'pending'} aria-label={`React ${e}`} onClick={() => onPick(e)}>
            {e}
          </button>
        );
      })}
    </div>
  );
}

/** Opens a menu after a finger rests on the bubble (phones), without breaking scrolling or taps. */
export function useLongPress(onLong: (target: HTMLElement) => void, ms = 450) {
  const t = useRef<ReturnType<typeof setTimeout>>();
  const start = useRef<{ x: number; y: number }>();
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(t.current);
    start.current = undefined;
  };
  useEffect(() => cancel, []);
  return {
    fired,
    handlers: {
      onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
        if (e.touches.length !== 1) return cancel();
        fired.current = false;
        const touch = e.touches[0]!;
        start.current = { x: touch.clientX, y: touch.clientY };
        const el = e.currentTarget;
        clearTimeout(t.current);
        t.current = setTimeout(() => {
          fired.current = true;
          navigator.vibrate?.(8);
          onLong(el);
        }, ms);
      },
      onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
        const s = start.current;
        const touch = e.touches[0];
        if (s && touch && Math.hypot(touch.clientX - s.x, touch.clientY - s.y) > 10) cancel();
      },
      onTouchEnd: (e: React.TouchEvent<HTMLElement>) => {
        cancel();
        // The finger lifting after a long press must not also tap a link or picture.
        if (fired.current) e.preventDefault();
      },
      onTouchCancel: cancel,
      onClickCapture: (e: React.MouseEvent) => {
        if (fired.current) {
          e.preventDefault();
          e.stopPropagation();
          fired.current = false;
        }
      },
    },
  };
}
