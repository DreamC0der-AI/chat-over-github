import { useEffect, useState } from 'react';
import type { Activity, Step } from '../lib/activity';
import type { Session } from '../lib/session';
import { go, Icon, useSession } from '../ui';

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

/** While a screen shows this activity in place, the tray leaves it out. */
export function useInline(session: Session, a: Activity | undefined) {
  useEffect(() => {
    if (!a) return;
    a.inline++;
    session.bump();
    return () => {
      a.inline--;
      session.bump();
    };
  }, [a?.id]);
}

/** Progress shown in place (inside a dialog). While it's on screen the tray leaves it out. */
export function InlineProgress({ session, a }: { session: Session; a?: Activity }) {
  useInline(session, a);
  if (!a) return null;
  return (
    <div className="inline-progress">
      <StepBar a={a} />
      <Steps a={a} />
    </div>
  );
}

/** "Step 2 of 4 · Setting up encryption", for one line. */
export function stepLine(a: Activity) {
  const i = a.steps.findIndex((s) => s.state === 'active');
  if (i < 0) return undefined;
  return a.steps.length > 1 ? `Step ${i + 1} of ${a.steps.length} · ${a.steps[i]!.label}` : a.steps[i]!.label;
}

/** Bottom corner: every slow action that isn't shown in place, so closing a dialog loses nothing. */
export function ActivityTray({ session }: { session: Session }) {
  useSession(session);
  const list = session.activities.all().filter((a) => a.inline === 0);
  useTick(list.some((a) => !a.ended));
  if (!list.length) return null;
  return (
    <div className="jobs" aria-live="polite">
      {list.map((a) => <TrayItem key={a.id} session={session} a={a} />)}
    </div>
  );
}

function TrayItem({ session, a }: { session: Session; a: Activity }) {
  const [open, setOpen] = useState(false);
  const state = a.error ? 'failed' : a.waiting ? 'waiting' : a.ended ? 'done' : 'running';
  const sub =
    state === 'failed' ? a.error
    : state === 'waiting' ? a.waiting
    : state === 'done' ? `Done in ${took(a.ended! - a.started)}`
    : stepLine(a) ?? 'Starting…';
  return (
    <div className={`job-item ${state}`}>
      <div className="job-head">
        <span className="job-icon">
          {state === 'running' ? <span className="spinner" /> : state === 'done' ? Icon.check(14) : state === 'failed' ? Icon.alert(14) : <span className="step-icon waiting" />}
        </span>
        <button type="button" className="job-main" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="job-title">{a.title}</span>
          <span className="job-sub" title={sub}>{sub}{state === 'running' && a.detail && !open ? <span className="muted"> · {a.detail}</span> : null}</span>
        </button>
        {state === 'running' && <span className="job-time">{took(Date.now() - a.started)}</span>}
        {state === 'done' && a.link && <button type="button" className="btn link small" onClick={() => { go(a.link!); session.activities.dismiss(a.id); }}>Open</button>}
        {state !== 'running' && <button type="button" className="btn icon ghost job-x" aria-label="Dismiss" onClick={() => session.activities.dismiss(a.id)}>{Icon.close()}</button>}
      </div>
      <StepBar a={a} />
      {open && <Steps a={a} />}
    </div>
  );
}
