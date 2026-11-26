import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { centreCrop, fitCrop, MAX_ZOOM, openPicture, renderAvatar } from '../lib/group-avatar';
import { GroupAvatar, Icon, Modal, toast } from '../ui';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The group picture with a camera badge: tap to pick a picture, crop it, × to remove it. Before
 * the group exists (no id) an empty tile stands in for the pattern the group will get.
 */
export function PicturePicker({ groupId, picture, onChange, busy, disabled }: { groupId?: string; picture?: string; onChange: (picture: string) => unknown; busy?: boolean; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [cropping, setCropping] = useState<{ bmp: ImageBitmap; url: string }>();
  const pick = async (f?: File) => {
    if (!f) return;
    try {
      const bmp = await openPicture(f);
      setCropping({ bmp, url: URL.createObjectURL(f) });
    } catch (e) {
      toast(errText(e));
    }
  };
  const endCrop = () => {
    if (!cropping) return;
    cropping.bmp.close();
    URL.revokeObjectURL(cropping.url);
    setCropping(undefined);
  };
  return (
    <div className="pic-picker">
      <button type="button" className="pic-button" onClick={() => input.current?.click()} disabled={disabled || busy} aria-label={picture ? 'Change group picture' : 'Add group picture'} title={picture ? 'Change picture' : 'Add picture'}>
        {groupId || picture ? <GroupAvatar id={groupId ?? ''} picture={picture} size="xl" /> : <span className="avatar square xl pic-empty" aria-hidden="true">{Icon.image(22)}</span>}
        <span className="pic-badge" aria-hidden="true">{busy ? <span className="spinner" /> : Icon.camera()}</span>
      </button>
      {picture && !busy && (
        <button type="button" className="pic-remove" aria-label="Remove group picture" title="Remove picture" disabled={disabled} onClick={() => void Promise.resolve(onChange('')).catch((e) => toast(errText(e)))}>{Icon.close()}</button>
      )}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
      {cropping && createPortal(
        <CropDialog bmp={cropping.bmp} url={cropping.url} onCancel={endCrop} onDone={(pic) => { endCrop(); void Promise.resolve(onChange(pic)).catch((e) => toast(errText(e))); }} />,
        document.body,
      )}
    </div>
  );
}

/** Room around the crop square, so the picture outside it shows dimmed. */
const PAD = 24;

/** Move the picture by dragging, zoom with the slider, the wheel or two fingers. */
function CropDialog({ bmp, url, onCancel, onDone }: { bmp: ImageBitmap; url: string; onCancel: () => void; onDone: (picture: string) => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(0); // crop square side, screen px
  const start = centreCrop(bmp.width, bmp.height);
  const [pos, setPos] = useState({ zoom: 1, cx: start.x + start.size / 2, cy: start.y + start.size / 2 });
  const fit = fitCrop(bmp.width, bmp.height, Math.max(view, 1), pos.zoom, pos.cx, pos.cy);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  useEffect(() => {
    const el = stage.current!;
    const measure = () => setView(Math.max(el.clientWidth - 2 * PAD, 1));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Not a React onWheel: that one is passive, and the page would scroll too.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setPos((p) => ({ ...p, zoom: Math.min(Math.max(p.zoom * Math.exp(-e.deltaY * 0.002), 1), MAX_ZOOM) }));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  const move = (e: React.PointerEvent) => {
    const ps = pointers.current;
    const prev = ps.get(e.pointerId);
    if (!prev) return;
    const before = [...ps.values()];
    ps.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const after = [...ps.values()];
    setPos((p) => {
      const f = fitCrop(bmp.width, bmp.height, Math.max(view, 1), p.zoom, p.cx, p.cy);
      if (after.length >= 2) {
        const d = (a: { x: number; y: number }[]) => Math.hypot(a[0]!.x - a[1]!.x, a[0]!.y - a[1]!.y) || 1;
        return { ...p, cx: f.cx, cy: f.cy, zoom: Math.min(Math.max(f.zoom * (d(after) / d(before)), 1), MAX_ZOOM) };
      }
      return { zoom: f.zoom, cx: f.cx - (e.clientX - prev.x) / f.scale, cy: f.cy - (e.clientY - prev.y) / f.scale };
    });
  };
  const up = (e: React.PointerEvent) => pointers.current.delete(e.pointerId);

  const done = () => {
    try {
      onDone(renderAvatar(bmp, fit.crop));
    } catch (e) {
      toast(errText(e));
    }
  };

  return (
    <Modal title="Crop picture" onClose={onCancel} className="crop-modal">
      <div
        ref={stage}
        className="crop-stage"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); }}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {view > 1 && (
          <img
            src={url}
            alt=""
            draggable={false}
            style={{ width: bmp.width * fit.scale, height: bmp.height * fit.scale, left: PAD + view / 2 - fit.cx * fit.scale, top: PAD + view / 2 - fit.cy * fit.scale }}
          />
        )}
        <div className="crop-frame" style={{ inset: PAD }} aria-hidden="true" />
      </div>
      <label className="crop-zoom">
        <span className="sr">Zoom</span>
        <span aria-hidden="true" className="muted">−</span>
        <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={fit.zoom} onChange={(e) => setPos((p) => ({ ...p, zoom: Number(e.target.value) }))} />
        <span aria-hidden="true" className="muted">+</span>
      </label>
      <div className="modal-actions end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" onClick={done}>Use picture</button>
      </div>
    </Modal>
  );
}
