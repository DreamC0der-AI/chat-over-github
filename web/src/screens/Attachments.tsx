import { useEffect, useRef, useState } from 'react';
import type { AttachmentRef, Group } from 'keyhold/chat';
import { describeError, MAX_FILE_BYTES, type Sending, type Session } from '../lib/session';
import { Icon } from '../ui';
import { isImage } from '../lib/mime';

export { isImage };
export const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);

export function saveBlob(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Loads and decrypts an attachment when it scrolls near the screen. */
function useAttachment(session: Session, group: Group, file: AttachmentRef, auto: boolean) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const urlRef = useRef<string>();
  const load = async () => {
    if (urlRef.current) return urlRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const blob = await session.fetchFile(group, file);
      const u = URL.createObjectURL(blob);
      urlRef.current = u;
      setUrl(u);
      return u;
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!auto || !ref.current) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        void load();
      }
    }, { rootMargin: '600px 0px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [auto, file.ref]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  return { ref, url, error, loading, load };
}

/** A sent or received attachment: pictures inline, other files as a card. */
export function AttachmentView({ session, group, file, caption, onOpen }: { session: Session; group: Group; file: AttachmentRef; caption?: string; onOpen: (v: Viewing) => void }) {
  const image = isImage(file.mime);
  const a = useAttachment(session, group, file, image);
  const name = file.name ?? (image ? 'Photo' : 'file');
  if (!image) {
    return (
      <div className="attach" ref={a.ref}>
        <FileCard name={name} size={file.size} error={a.error}>
          <button className="file-act" aria-label="Download" title="Download" disabled={a.loading} onClick={async () => { const u = await a.load(); if (u) saveBlob(u, name); }}>
            {a.loading ? <span className="spinner" /> : Icon.download()}
          </button>
        </FileCard>
        {caption && <div className="attach-caption">{caption}</div>}
      </div>
    );
  }
  return (
    <div className="attach" ref={a.ref}>
      {a.url ? (
        <button className="media" aria-label={`Open ${name}`} onClick={() => onOpen({ url: a.url!, name })}>
          <img src={a.url} alt={name} />
        </button>
      ) : a.error ? (
        <div className="media media-empty">
          {Icon.alert(20)}
          <span>Couldn't load</span>
          <button className="btn small" onClick={() => void a.load()}>Retry</button>
        </div>
      ) : (
        <div className="media media-empty loading" aria-label="Loading image">{Icon.image(26)}</div>
      )}
      {caption && <div className="attach-caption">{caption}</div>}
    </div>
  );
}

function FileCard({ name, size, error, children }: { name: string; size: number; error?: string; children?: React.ReactNode }) {
  return (
    <div className="file-card">
      <span className="file-icon">{Icon.file()}</span>
      <span className="file-text">
        <span className="file-name" title={name}>{name}</span>
        <span className="file-size">{error ?? fileSize(size)}</span>
      </span>
      {children}
    </div>
  );
}

/** An outgoing attachment: the local preview with an upload spinner, or a failed state with Retry. */
export function PendingAttachment({ p }: { p: Sending }) {
  const f = p.file!;
  return (
    <div className={`attach${p.failed ? ' failed' : ''}`}>
      {p.preview ? (
        <div className="media pending">
          <img src={p.preview} alt={f.name} />
          <span className="media-veil">{p.failed ? <span className="veil-icon">{Icon.alert(22)}</span> : <span className="ring" />}</span>
        </div>
      ) : (
        <FileCard name={f.name} size={p.size ?? f.size}>{!p.failed && <span className="file-act"><span className="spinner" /></span>}</FileCard>
      )}
      {p.caption && <div className="attach-caption">{p.caption}</div>}
    </div>
  );
}

export type Viewing = { url: string; name: string };

export function Lightbox({ v, onClose }: { v: Viewing; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="lightbox" role="dialog" aria-label={v.name} onClick={onClose}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{v.name}</span>
        <button className="lb-btn" aria-label="Download" title="Download" onClick={() => saveBlob(v.url, v.name)}>{Icon.download(18)}</button>
        <button className="lb-btn" aria-label="Close" title="Close" onClick={onClose}>{Icon.close()}</button>
      </div>
      <img src={v.url} alt={v.name} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

export type Draft = { id: string; file: File; url?: string };

export function toDrafts(files: File[], onTooBig: (f: File) => void): Draft[] {
  const out: Draft[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      onTooBig(file);
      continue;
    }
    out.push({ id: Math.random().toString(36).slice(2), file, url: isImage(file.type) ? URL.createObjectURL(file) : undefined });
  }
  return out;
}

/** Files picked, pasted or dropped, waiting above the message box until Send. */
export function DraftTray({ drafts, onRemove }: { drafts: Draft[]; onRemove: (id: string) => void }) {
  return (
    <div className="tray" aria-label="Attachments to send">
      {drafts.map((d) => (
        <div key={d.id} className={`tray-item${d.url ? ' pic' : ''}`} title={`${d.file.name} · ${fileSize(d.file.size)}`}>
          {d.url ? <img src={d.url} alt={d.file.name} /> : <><span className="file-icon">{Icon.file(18)}</span><span className="tray-name">{d.file.name}</span></>}
          <button className="tray-x" aria-label={`Remove ${d.file.name}`} onClick={() => onRemove(d.id)}>{Icon.close()}</button>
        </div>
      ))}
    </div>
  );
}
