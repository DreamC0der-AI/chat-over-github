import { useEffect, useState } from 'react';
import { CONFIG } from '../config';
import { mockSignIn, startWebFlow, type AuthState } from '../lib/auth';
import { ErrorFlash, Hint, Icon, useAction } from '../ui';

export function SignIn({ onSignedIn, initialError }: { onSignedIn: (a: AuthState) => void; initialError?: string }) {
  const { busy, error, run, setError } = useAction();
  const [mockLogin, setMockLogin] = useState('');

  useEffect(() => {
    if (initialError) setError(initialError);
  }, []);

  return (
    <div className="page">
      <div className="narrow">
        <div className="center stack" style={{ alignItems: 'center', gap: 16, marginTop: 24 }}>
          <span className="logo big">{Icon.logo()}</span>
          <h1>Chat over GitHub</h1>
        </div>
        <div className="box">
          <div className="box-body stack">
            <ErrorFlash error={error} />
            {CONFIG.mock ? (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => onSignedIn(await mockSignIn(mockLogin)));
                }}
              >
                <label className="field">
                  Test account
                  <input className="input" value={mockLogin} onChange={(e) => setMockLogin(e.target.value)} placeholder="alice" autoFocus />
                </label>
                <button className="btn primary block" disabled={busy || !mockLogin}>Sign in (test GitHub)</button>
              </form>
            ) : (
              <button className="btn primary block" disabled={busy} onClick={() => run(startWebFlow)}>
                Sign in with GitHub
              </button>
            )}
          </div>
        </div>
        <p className="tagline">
          {Icon.lock(12)} End-to-end encrypted
          <Hint text="Each chat is a private GitHub repo that only its members can open. Messages are encrypted in this browser (MLS) before they are saved, so GitHub sees only ciphertext and who talks to whom. The app only gets access to the repos it creates for you." />
        </p>
      </div>
    </div>
  );
}
