import { useEffect, useState } from 'react';
import { CONFIG, installUrl, newHomeRepoUrl } from '../config';
import type { Session } from '../lib/session';
import { ErrorFlash, Hint, Icon, useAction } from '../ui';

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page">
      <div className="narrow">
        <div className="center stack" style={{ alignItems: 'center', marginTop: 16 }}>
          <span className="logo big">{Icon.logo()}</span>
          <h2>{title}</h2>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Install({ session }: { session: Session }) {
  const home = CONFIG.homeRepo;
  const [created, setCreated] = useState(() => localStorage.getItem('kh.homeCreated') === session.login);
  const [opened, setOpened] = useState(false);

  // Watch for the install: poll while this screen is up, and right away when the tab regains focus.
  useEffect(() => {
    let stop = false;
    const check = () => { if (!stop) void session.pollInstall(); };
    const t = setInterval(check, opened ? 4000 : 10000);
    addEventListener('focus', check);
    return () => {
      stop = true;
      clearInterval(t);
      removeEventListener('focus', check);
    };
  }, [opened]);

  const markCreated = () => {
    localStorage.setItem('kh.homeCreated', session.login);
    setCreated(true);
  };

  return (
    <Frame title="Two quick steps on GitHub">
      <div className="box">
        <div className="box-body stack">
          {session.homeNotSelected && (
            <div className="flash warn">
              The app is installed, but <code>{home}</code> isn't one of its repos. Open the{' '}
              <a href={session.installSettingsUrl()} target="_blank" rel="noreferrer">install settings</a>, add <code>{home}</code> under
              Repository access, and save.
            </div>
          )}
        </div>
        <div className="box-row stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span><strong>1. Create a private repo named <code>{home}</code></strong> <Hint text={'Chat over GitHub only gets access to repos you pick, and GitHub makes you pick at least one. The name and "Private" are filled in for you, so just press Create repository. The app keeps your encrypted settings and key backup there.'} /></span>
            {created && <span className="label green">Done</span>}
          </div>
          <div className="row">
            <a className={`btn${created ? '' : ' primary'}`} href={newHomeRepoUrl()} target="_blank" rel="noreferrer" onClick={markCreated}>
              Create {home} on GitHub
            </a>
            {!created && <button className="btn link" onClick={markCreated}>I already have it</button>}
          </div>
        </div>
        <div className="box-row stack">
          <span><strong>2. Install the app on that repo only</strong> <Hint text="Chats you start later are added to the install by themselves." /></span>
          <p className="small muted">Choose <strong>Only select repositories</strong>, pick <code>{home}</code>, then <strong>Install</strong>.</p>
          <div className="row">
            <a
              className={`btn${created ? ' primary' : ''}`}
              href={session.homeNotSelected ? session.installSettingsUrl() : installUrl()}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpened(true)}
            >
              {session.homeNotSelected ? 'Open install settings' : 'Install on GitHub'}
            </a>
          </div>
        </div>
        <div className="box-row row small muted">
          {opened ? <><span className="spinner" /> Waiting for GitHub…</> : 'Continues by itself once installed'}
          <span className="spacer" />
          <button className="btn" onClick={() => session.recheckInstall()}>Check now</button>
        </div>
      </div>
      <p className="muted small center">Signed in as <strong>{session.login}</strong></p>
    </Frame>
  );
}

export function NewIdentity({ session }: { session: Session }) {
  const { busy, error, run } = useAction();
  const [code, setCode] = useState<string>();
  const [typed, setTyped] = useState('');
  const last = code?.split('-').pop() ?? '';

  if (!code) {
    return (
      <Frame title="Create your identity">
        <div className="box">
          <div className="box-body stack">
            <ErrorFlash error={error} />
            <p>
              A key made in this browser that proves who you are. You get a recovery code for it next.{' '}
              <Hint text={<>The public key goes to the public repo <span className="mono">{session.login}/keyhold-id</span> so others can check it. An encrypted backup goes to your private repo <span className="mono">{session.login}/{session.homeRepo}</span>. The private half never reaches GitHub unencrypted.</>} />
            </p>
            <button className="btn primary block" disabled={busy} onClick={() => run(async () => setCode(await session.createIdentity()))}>
              {busy ? <><span className="spinner" /> Creating keys…</> : 'Create identity'}
            </button>
          </div>
        </div>
      </Frame>
    );
  }
  return (
    <Frame title="Save your recovery code">
      <div className="box">
        <div className="box-body stack">
          <p>Keep this somewhere safe. It's the only way back into your account, and nobody can reset it. <Hint text="You need it to use your account on another browser, or after clearing this one. A password manager is a good place." /></p>
          <div className="code-box">{code}</div>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(code)}>Copy</button>
          <label className="field">
            Type the last block to confirm
            <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} placeholder={'XXXX'} maxLength={4} />
          </label>
          <ErrorFlash error={error} />
          <button className="btn primary block" disabled={typed.trim() !== last || busy} onClick={() => run(() => session.finishSetup())}>
            Continue to chats
          </button>
        </div>
      </div>
    </Frame>
  );
}

export function Restore({ session }: { session: Session }) {
  const { busy, error, run } = useAction();
  const [code, setCode] = useState('');
  const [reset, setReset] = useState(false);
  return (
    <Frame title="Add this browser to your account">
      <div className="box">
        <div className="box-body stack">
          <p>Enter <strong>{session.login}</strong>'s recovery code. <Hint text="This browser then joins your chats by itself. It can't read messages sent before it joined." /></p>
          <ErrorFlash error={error} />
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => session.restoreIdentity(code));
            }}
          >
            <label className="field">
              Recovery code
              <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autoFocus />
            </label>
            <button className="btn primary block" disabled={busy || code.trim().length < 20}>
              {busy ? <><span className="spinner" /> Opening backup…</> : 'Add this browser'}
            </button>
          </form>
        </div>
      </div>
      {!reset ? (
        <p className="center"><button className="btn link" onClick={() => setReset(true)}>Lost your recovery code?</button></p>
      ) : (
        <div className="box">
          <div className="box-header"><h3>Reset your encryption key</h3></div>
          <div className="box-body">
            <ResetKeyForm session={session} onDone={() => location.reload()} />
          </div>
        </div>
      )}
    </Frame>
  );
}

/**
 * Reset the encryption key when the recovery code is lost. The GitHub account (the identity
 * people know) stays; only the key is new, so people invite it back the normal way.
 */
export function ResetKeyForm({ session, onDone }: { session: Session; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [confirm, setConfirm] = useState('');
  return (
    <div className="stack">
      <div className="flash">
        <strong>Still signed in on another browser?</strong> Keep using that one. It has your key, so nothing is lost.
      </div>
      <p>
        <strong>{session.login}</strong> gets a new encryption key. Your GitHub account stays the same.{' '}
        <Hint text={<>Your public key in <span className="mono">keyhold-id</span> and your encrypted backup in <span className="mono">{session.homeRepo}</span> are made again. You leave other people's chat repos, and chats only you ran are deleted.</>} />
      </p>
      <ul className="reset-costs">
        <li>Your chats and contacts start empty.</li>
        <li>People see that you reset your key and invite you again.</li>
        <li>Groups where you are the only admin end.</li>
      </ul>
      <label className="field">
        <span>Type <code>{session.login}</code> to confirm</span>
        <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <ErrorFlash error={error} />
      <button
        className="btn danger block"
        disabled={confirm.trim().toLowerCase() !== session.login || busy}
        onClick={() => run(async () => { await session.resetIdentity(); onDone(); })}
      >
        {busy ? <><span className="spinner" /> Resetting…</> : 'Reset my encryption key'}
      </button>
    </div>
  );
}

/** This account's key was reset on another browser: this browser's key is dead. */
export function ResetElsewhere({ session }: { session: Session }) {
  const { busy, error, run } = useAction();
  return (
    <Frame title="Your key was reset">
      <div className="box">
        <div className="box-body stack">
          <p><strong>{session.login}</strong>'s encryption key was reset on another browser, so this browser's chats can't be used any more. <Hint text="If you didn't do this, someone may have signed in to your GitHub account. Secure it on GitHub first." /></p>
          <ErrorFlash error={error} />
          <button className="btn primary block" disabled={busy} onClick={() => run(async () => { await session.forgetBrowser(); location.hash = ''; location.reload(); })}>
            {busy ? <span className="spinner" /> : 'Set up this browser again'}
          </button>
        </div>
      </div>
    </Frame>
  );
}
