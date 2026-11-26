import { useEffect, useState } from 'react';
import type { DeviceCertificate } from 'keyhold/chat';
import { signOut } from '../lib/auth';
import { onTheme, saveSideWidth, setTheme, SIDE_DEFAULT, sideWidth, themeChoice, THEMES } from '../lib/prefs';
import { loginFrom, type Session } from '../lib/session';
import { ask, Avatar, ErrorFlash, Hint, Icon, Modal, useAction, useSession } from '../ui';
import { forgetAvatars } from '../lib/avatars';

type SectionId = 'appearance' | 'devices' | 'privacy' | 'storage' | 'account';
const SECTIONS: { id: SectionId; name: string; icon: () => JSX.Element }[] = [
  { id: 'appearance', name: 'Appearance', icon: Icon.palette },
  { id: 'devices', name: 'Devices and sync', icon: Icon.devices },
  { id: 'privacy', name: 'Privacy', icon: Icon.privacy },
  { id: 'storage', name: 'Storage', icon: Icon.storage },
  { id: 'account', name: 'Account', icon: Icon.person },
];

/** Settings: a list of sections on the left, the chosen one on the right.
 *  On a phone, #/settings is the list and #/settings/<id> one section. */
export function Settings({ session, route }: { session: Session; route: string }) {
  useSession(session);
  const asked = route.split('/')[2] as SectionId | undefined;
  const picked = SECTIONS.find((x) => x.id === asked);
  const section = picked ?? SECTIONS[0]!;
  const [devices, setDevices] = useState<{ cert: DeviceCertificate; current: boolean }[]>();
  const [revoke, setRevoke] = useState<DeviceCertificate>();
  const [reset, setReset] = useState(false);
  const { error, run } = useAction();
  const load = () => run(async () => setDevices(await session.myDevices()));
  useEffect(() => {
    void load();
  }, []);
  const fp = session.identity?.fingerprint ?? '';

  return (
    <div className="app">
      <div className="page">
        <div className={`settings${picked ? ' has-section' : ''}`}>
          <aside className="settings-side">
            <a href="#/" className="back-link">{Icon.back()} Chats</a>
            <div className="profile">
              <Avatar name={session.login} login={session.login} size="xl" />
              <div className="profile-text">
                <h2>{session.login}</h2>
                <div className="small muted mono">{fp.slice(0, 8)} {fp.slice(8, 16)}</div>
              </div>
            </div>
            <nav className="settings-nav" aria-label="Settings">
              {SECTIONS.map((x) => (
                <a key={x.id} href={`#/settings/${x.id}`} className={`settings-tab${x.id === section.id ? ' active' : ''}`} aria-current={x.id === section.id ? 'page' : undefined}>
                  <span className="settings-tab-icon">{x.icon()}</span>
                  <span className="settings-tab-name">{x.name}</span>
                  {x.id === 'devices' && !session.syncOn && <span className="settings-tab-dot" title="Sync is off" />}
                  <span className="settings-tab-chev">{Icon.chevron()}</span>
                </a>
              ))}
            </nav>
          </aside>

          <section className="settings-main" aria-labelledby="settings-title">
            <a href="#/settings" className="back-link mobile-only">{Icon.back()} Settings</a>
            <h2 id="settings-title" className="settings-title">{section.name}</h2>
            <ErrorFlash error={error} />

            {section.id === 'appearance' && <Appearance />}

            {section.id === 'devices' && (
              <>
                <section className="box">
                  <div className="box-header">
                    <h3>Devices</h3>
                    <Hint text="To use another browser or computer, sign in there and enter your recovery code. It joins your chats on its own, but can't read older messages. Revoking a lost device removes it from every chat the next time a member's app syncs." />
                  </div>
                  {!devices ? (
                    <div className="box-body"><span className="spinner" /></div>
                  ) : (
                    devices.map(({ cert, current }) => (
                      <div className="box-row kv" key={cert.device}>
                        <div>
                          <strong>Browser <span className="mono">{cert.deviceId.slice(0, 6)}</span></strong> {current && <span className="label green">This browser</span>}
                          <div className="small muted">Added {new Date(cert.issuedAt).toLocaleString()}</div>
                        </div>
                        {!current && <button className="btn danger" onClick={() => setRevoke(cert)}>Revoke</button>}
                      </div>
                    ))
                  )}
                </section>
                <SyncBox session={session} />
                <ConnectionBox session={session} />
              </>
            )}

            {section.id === 'privacy' && (
              <>
                <section className="box">
                  <div className="box-header"><h3>Identity fingerprint</h3><Hint text="People you chat with can compare this to check it's really you." /></div>
                  <div className="box-row"><div className="fingerprint mono">{fp.match(/.{1,8}/g)?.join(' ')}</div></div>
                </section>
                <section className="box">
                  <div className="box-header"><h3>Blocked</h3><Hint text="Invitations from blocked people are turned down without asking you. Block someone in Contacts or from a chat's … menu." /></div>
                  {session.blocked.size === 0 ? (
                    <div className="box-row muted">No one</div>
                  ) : (
                    [...session.blocked].map((a) => (
                      <div className="box-row kv" key={a}>
                        <span className="row" style={{ gap: 8 }}><Avatar name={loginFrom(a)} login={loginFrom(a)} size="sm" /> {loginFrom(a)}</span>
                        <button className="btn" onClick={() => run(() => session.unblock(a))}>Unblock</button>
                      </div>
                    ))
                  )}
                </section>
              </>
            )}

            {section.id === 'storage' && (
              <section className="box">
                <div className="box-header"><h3>Your repos</h3><Hint text="Everything lives in your own GitHub repos. Decrypted messages are kept only in this browser." /></div>
                <div className="box-row kv"><span>Public keys</span><a className="mono" href={`https://github.com/${session.login}/keyhold-id`} target="_blank" rel="noreferrer">{session.login}/keyhold-id</a></div>
                <div className="box-row kv"><span>Encrypted backup</span><a className="mono" href={`https://github.com/${session.login}/${session.homeRepo}`} target="_blank" rel="noreferrer">{session.login}/{session.homeRepo}</a></div>
                <div className="box-row kv"><span>Chats</span><span className="mono">ghchat-…</span></div>
              </section>
            )}

            {section.id === 'account' && (
              <>
                <section className="box">
                  <div className="box-row kv">
                    <span>Sign out <Hint text="Signs out of GitHub here. Your keys stay in this browser, so signing back in picks up where you left off." /></span>
                    <button className="btn" onClick={() => { session.stop(); forgetAvatars(); signOut(); location.hash = ''; location.reload(); }}>Sign out</button>
                  </div>
                </section>
                <section className="box danger-box">
                  <div className="box-header"><h3>Danger zone</h3></div>
                  <div className="box-row kv">
                    <span>Forget this browser <Hint text="Removes this browser's keys and messages. You'll need your recovery code to come back." /></span>
                    <button className="btn danger" onClick={() => run(async () => { if (!(await ask({ title: 'Forget this browser?', body: 'Its keys and message history are deleted. You need your recovery code to use this account here again.', confirm: 'Forget this browser', danger: true }))) return; await session.forgetBrowser(); forgetAvatars(); signOut(); location.hash = ''; location.reload(); })}>Forget</button>
                  </div>
                  <div className="box-row kv">
                    <span>Reset identity <Hint text="Start over with a brand-new identity. Contacts see a key change and your current chats stop working." /></span>
                    <button className="btn danger" onClick={() => setReset(true)}>Reset</button>
                  </div>
                </section>
              </>
            )}
          </section>
        </div>
      </div>
      {revoke && <RevokeModal session={session} cert={revoke} onClose={() => setRevoke(undefined)} onDone={() => { setRevoke(undefined); void load(); }} />}
      {reset && <ResetModal session={session} onClose={() => setReset(false)} />}
    </div>
  );
}

/** Theme cards (each a tiny picture of the app in that theme) and the chat list width. */
function Appearance() {
  const [theme, setThemeState] = useState(themeChoice);
  useEffect(() => onTheme(() => setThemeState(themeChoice())), []);
  const [width, setWidth] = useState(sideWidth);
  return (
    <>
      <section className="box">
        <div className="box-header"><h3>Theme</h3></div>
        <div className="box-body">
          <div className="themes" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={theme === t.id}
                className={`theme-card${theme === t.id ? ' on' : ''}`}
                onClick={() => setTheme(t.id)}
              >
                {t.id === 'system' ? (
                  <span className="theme-split"><ThemePreview id="light" /><ThemePreview id="dark" /></span>
                ) : (
                  <ThemePreview id={t.id} />
                )}
                <span className="theme-name">
                  <span className="theme-radio">{theme === t.id && Icon.check(12)}</span>
                  {t.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="box hide-sm">
        <div className="box-row kv">
          <span>Chat list width <Hint text="Drag the right edge of the chat list to change it." /></span>
          <span className="row">
            <span className="muted small">{width === SIDE_DEFAULT ? 'Default' : `${width} px`}</span>
            <button className="btn" disabled={width === SIDE_DEFAULT} onClick={() => { saveSideWidth(SIDE_DEFAULT); setWidth(SIDE_DEFAULT); }}>Reset</button>
          </span>
        </div>
      </section>
    </>
  );
}

function ThemePreview({ id }: { id: 'light' | 'dark' | 'dimmed' }) {
  return (
    <span className="theme-preview" data-theme-preview={id} aria-hidden="true">
      <span className="tp-side"><i /><i /><i /></span>
      <span className="tp-chat">
        <span className="tp-bubble theirs" />
        <span className="tp-bubble mine" />
        <span className="tp-bubble theirs short" />
        <span className="tp-composer" />
      </span>
    </span>
  );
}

function RevokeModal({ session, cert, onClose, onDone }: { session: Session; cert: DeviceCertificate; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title="Revoke device" onClose={onClose}>
      <p>Revoking needs your identity key, so enter your recovery code. The device <span className="mono">{cert.deviceId.slice(0, 6)}</span> will be removed from every chat.</p>
      <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Recovery code" aria-label="Recovery code" />
      <ErrorFlash error={error} />
      <button className="btn danger block" disabled={busy || code.trim().length < 20} onClick={() => run(async () => { await session.revokeDevice(cert.device, code); onDone(); })}>
        {busy ? <span className="spinner" /> : 'Revoke device'}
      </button>
    </Modal>
  );
}

function ResetModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const [confirmText, setConfirm] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title="Reset identity" onClose={onClose}>
      <p>This deletes <code>{session.login}/keyhold-id</code> and <code>{session.login}/{session.homeRepo}</code> and this browser's keys. Chat repos stay on GitHub but you can't read them any more.</p>
      <label className="field">Type <code>{session.login}</code> to confirm<input className="input" value={confirmText} onChange={(e) => setConfirm(e.target.value)} /></label>
      <ErrorFlash error={error} />
      <button className="btn danger block" disabled={busy || confirmText.trim().toLowerCase() !== session.login} onClick={() => run(async () => { await session.resetIdentity(); location.hash = ''; location.reload(); })}>
        {busy ? <span className="spinner" /> : 'Delete and start over'}
      </button>
    </Modal>
  );
}

function SyncBox({ session }: { session: Session }) {
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  return (
    <section className="box">
      <div className="box-header">
        <h3>Sync across browsers</h3>
        <Hint text={<>Your chat list, contacts and their verified keys, deleted and closed chats, read marks, blocks and declined invitations are kept, encrypted, in <span className="mono">{session.login}/{session.homeRepo}</span>. Your other browsers apply them within about a minute.</>} />
        <span className="spacer" />
        {session.syncOn ? <span className="label green">On</span> : <span className="label">Off</span>}
      </div>
      {session.syncOn ? (
        session.syncError ? <div className="box-row"><div className="flash warn">Sync problem: {session.syncError}</div></div> : null
      ) : (
        <div className="box-row stack">
          <ErrorFlash error={error} />
          <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Recovery code" aria-label="Recovery code for sync" />
          <button className="btn primary" disabled={busy || code.trim().length < 20} onClick={() => run(() => session.enableSync(code))}>
            {busy ? <span className="spinner" /> : 'Turn on sync'}
          </button>
        </div>
      )}
    </section>
  );
}

/** How this browser's requests to GitHub are going: for telling a bad network from an app bug. */
function ConnectionBox({ session }: { session: Session }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 2_000);
    return () => clearInterval(t);
  }, []);
  const n = session.net;
  const mins = Math.max(1, Math.round((Date.now() - n.since) / 60_000));
  const avg = n.ok ? Math.round(n.totalMs / n.ok) : 0;
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <section className="box">
      <div className="box-header"><h3>Connection</h3><Hint text="Requests this browser made to GitHub since the page opened. A screenshot of this helps find why messages are slow." /></div>
      <div className="box-row kv"><span>Last {mins} min</span><span className="mono">{n.ok} ok · {n.failed} failed · {n.slow} slow · avg {avg} ms</span></div>
      {n.problems.length === 0 ? (
        <div className="box-row muted">No problems</div>
      ) : (
        n.problems.map((p, i) => (
          <div className="box-row small" key={i}>
            <div className="mono">{time(p.at)} {p.how}{p.ms ? ` (${(p.ms / 1000).toFixed(1)} s)` : ''}</div>
            <div className="mono muted" style={{ wordBreak: 'break-all' }}>{p.what}</div>
          </div>
        ))
      )}
    </section>
  );
}
