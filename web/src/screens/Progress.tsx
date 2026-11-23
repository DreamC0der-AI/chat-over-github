import { useEffect, useRef, useState } from 'react';
import type { Activity, Step } from '../lib/activity';
import type { Session } from '../lib/session';
import { Icon, useSession } from '../ui';

/** Re-render every second while something is running, for the elapsed times. */
export function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

export function took(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Steps done so far, out of all of them (a step that is running counts half). */
export function fraction(a: Activity) {
  const n = a.steps.length || 1;
  const done = a.steps.filter((s) => s.state === 'done' || s.state === 'failed').length;
  const active = a.steps.some((s) => s.state === 'active') ? 0.5 : 0;
  return a.ended && !a.error && !a.waiting ? 1 : Math.min(1, (done + active) / n);
}

function StepIcon({ s }: { s: Step }) {
  switch (s.state) {
    case 'done': return <span className="step-icon done">{Icon.check(12)}</span>;
    case 'active': return <span className="step-icon active"><span className="spinner" /></span>;
    case 'failed': return <span className="step-icon failed">{Icon.close()}</span>;
    case 'waiting': return <span className="step-icon waiting" />;
    default: return <span className="step-icon todo" />;
  }
}

/** The steps of one activity: what's done (and how long it took), what runs now and what's left. */
export function Steps({ a }: { a: Activity }) {
  useTick(!a.ended);
  const now = Date.now();
  return (
    <ol className="steps" aria-label={`${a.title}: progress`}>
      {a.steps.map((s, i) => (
        <li key={`${i}:${s.label}`} className={`step ${s.state}`} aria-current={s.state === 'active' ? 'step' : undefined}>
          <StepIcon s={s} />
          <span className="step-text">
            <span className="step-label">{s.label}</span>
            {s.state === 'active' && a.detail && <span className="step-detail">{a.detail}</span>}
            {s.state === 'failed' && s.error && <span className="step-detail error">{s.error}</span>}
            {s.state === 'waiting' && a.waiting && <span className="step-detail">{a.waiting}</span>}
          </span>
          {s.start !== undefined && (s.state === 'active' || s.state === 'done') && (
            <span className="step-time">{took((s.end ?? now) - s.start)}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A thin bar for how many steps are done. It moves only when a real step finishes. */
export function StepBar({ a }: { a: Activity }) {
  return (
    <div className={`step-bar${a.error ? ' failed' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction(a) * 100)}>
      <span style={{ width: `${Math.round(fraction(a) * 100)}%` }} />
    </div>
  );
}

/** "Step 2 of 4 · Setting up encryption", for one line. */
export function stepLine(a: Activity) {
  const i = a.steps.findIndex((s) => s.state === 'active');
  if (i < 0) return undefined;
  return a.steps.length > 1 ? `Step ${i + 1} of ${a.steps.length} · ${a.steps[i]!.label}` : a.steps[i]!.label;
}

/**
 * One popup for every action the user starts. Everything goes through GitHub, so actions take
 * seconds; the popup shows the steps as they happen and blocks the app until the action ends,
 * so nothing else can start halfway. A finished one ticks and goes; a failed one says where it
 * stopped and waits for Close.
 */
export function ProgressPopup({ session }: { session: Session }) {
  useSession(session);
  const a = session.activities.all().find((x) => x.modal);
  useTick(!!a && !a.ended);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const someFailed = !!a?.steps.some((s) => s.state === 'failed');
  const settled = !!a?.ended && (!!a.error || !!a.waiting || someFailed);
  useEffect(() => {
    if (settled) closeBtn.current?.focus();
  }, [settled, a?.id]);
  if (!a) return null;
  const state = a.error || (a.ended && someFailed) ? 'failed' : a.waiting ? 'waiting' : a.ended ? 'done' : 'running';
  const close = () => session.activities.dismiss(a.id);
  return (
    <div className="modal-back progress-back" onKeyDown={(e) => { if (e.key === 'Escape' && settled) close(); }}>
      <div className={`modal progress-modal ${state}`} role="alertdialog" aria-modal="true" aria-busy={state === 'running'} aria-label={a.title}>
        <div className="modal-body">
          <div className="progress-head">
            <span className="progress-icon">
              {state === 'running' ? <span className="spinner" /> : state === 'done' ? Icon.check(16) : state === 'failed' ? Icon.alert(16) : <span className="step-icon waiting" />}
            </span>
            <h3>{a.title}</h3>
            <span className="progress-time">{took((a.ended ?? Date.now()) - a.started)}</span>
          </div>
          <StepBar a={a} />
          <Steps a={a} />
          {state === 'failed' && a.error && <div className="flash error" role="alert">{a.error}</div>}
          {settled && (
            <div className="modal-actions end">
              <button ref={closeBtn} type="button" className="btn" onClick={close}>Close</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
