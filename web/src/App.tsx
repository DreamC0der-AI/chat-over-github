import { useEffect, useState } from 'react';
import { finishWebFlow, loadAuth, signOut, type AuthState } from './lib/auth';
import { Session } from './lib/session';
import { acquireTabLock, takeOverTab } from './lib/tab-lock';
import { SignIn } from './screens/SignIn';
import { Install, NewIdentity, Restore } from './screens/Onboarding';
import { Home } from './screens/Home';
import { Settings } from './screens/Settings';
import { ErrorFlash, FloatingNotices, useHash, useSession } from './ui';
import { ProgressPopup } from './screens/Progress';

export function App() {
  const [auth, setAuth] = useState<AuthState | undefined>();
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    finishWebFlow()
      .then((a) => setAuth(a ?? loadAuth()))
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setAuth(loadAuth());
      })
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <Loading />;
  if (!auth) return <SignIn onSignedIn={setAuth} initialError={error} />;
  return (
    <Signed
      key={auth.id}
      auth={auth}
      onSignOut={() => { signOut(); setAuth(undefined); }}
      onSignedOut={() => { setError('Signed out. Please sign in again.'); setAuth(undefined); }}
    />
  );
}

function Signed({ auth, onSignOut, onSignedOut }: { auth: AuthState; onSignOut: () => void; onSignedOut: () => void }) {
  const [session] = useState(() => new Session(auth));
  // 'here': this tab runs the account. 'elsewhere': another tab of this browser does.
  const [tab, setTab] = useState<'checking' | 'here' | 'elsewhere'>('checking');
  useEffect(() => {
    let alive = true;
    let release: (() => void) | undefined;
    void acquireTabLock(String(auth.id), () => {
      session.stop();
      if (alive) setTab('elsewhere');
    }).then((lock) => {
      if (!alive) {
        if (lock.held) lock.release();
        return;
      }
      if (!lock.held) return setTab('elsewhere');
      release = lock.release;
      setTab('here');
      void session.start();
    });
    return () => {
      alive = false;
      session.stop();
      release?.();
    };
  }, [session]);
  useSession(session);
  const route = useHash();
  // GitHub turned the sign-in down for good: go to the sign-in screen instead of a stuck warning.
  useEffect(() => {
    if (!session.signedOut) return;
    session.stop();
    onSignedOut();
  }, [session.signedOut]);

  if (tab === 'checking') return <Loading />;
  if (tab === 'elsewhere') return <OpenElsewhere />;

  const screen = (() => {
    switch (session.phase) {
      case 'loading':
        return <Loading />;
      case 'error':
        return (
          <div className="page"><div className="narrow">
            <ErrorFlash error={session.error} />
            <button className="btn" onClick={() => location.reload()}>Try again</button>
            <button className="btn" onClick={onSignOut}>Sign out</button>
          </div></div>
        );
      case 'install':
        return <Install session={session} />;
      case 'new-identity':
        return <NewIdentity session={session} />;
      case 'restore':
        return <Restore session={session} />;
      case 'ready':
        return route === '/settings' || route.startsWith('/settings/') ? <Settings session={session} route={route} /> : <Home session={session} route={route} />;
    }
  })();
  return (
    <>
      {screen}
      <ProgressPopup session={session} />
      <FloatingNotices />
    </>
  );
}

function OpenElsewhere() {
  return (
    <div className="page"><div className="narrow elsewhere">
      <h1>Open in another tab</h1>
      <p className="muted">Chat over GitHub runs in one tab at a time.</p>
      <button className="btn primary" onClick={takeOverTab}>Use here</button>
    </div></div>
  );
}

function Loading() {
  return <div className="empty" style={{ height: '100%' }}><span className="spinner" /></div>;
}
