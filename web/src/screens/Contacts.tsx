import { useMemo, useState } from 'react';
import { type Convo, type Person, type Session } from '../lib/session';
import { ask, Avatar, ErrorFlash, go, Icon, Modal, toast, useAction, useSession } from '../ui';
import { VerifyPanel } from './ChatMenu';

/**
 * Contacts: everyone you have a DM with or share a group with, and your groups. Verifying a
 * person (safety numbers) lives here; marks and remembered keys sync across your browsers.
 */
export function Contacts({ session, onNewGroup }: { session: Session; onNewGroup: () => void }) {
  useSession(session);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string>();
  const v = session.getVersion();
  const people = useMemo(() => session.people(), [v]);
  const groups = useMemo(() => session.conversations().filter((c) => !c.dm).sort((a, b) => a.title.localeCompare(b.title)), [v]);
  const match = (s: string) => !q || s.toLowerCase().includes(q.trim().toLowerCase());
  const shownPeople = people.filter((p) => match(p.login));
  const shownGroups = groups.filter((g) => match(g.title));
  const person = open ? people.find((p) => p.address === open) : undefined;
  return (
    <>
      <div className="convo-head">
        <a href="#/" className="btn icon ghost mobile-only" aria-label="Back to chats">{Icon.back()}</a>
        <div className="who-text"><strong className="convo-title">Contacts</strong></div>
        <div className="convo-actions">
          <button className="btn" onClick={onNewGroup}>{Icon.people()} New group</button>
        </div>
      </div>
      <div className="contacts">
        <div className="search">
          {Icon.search()}
          <label className="sr" htmlFor="cq">Search contacts</label>
          <input id="cq" type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <section aria-labelledby="c-people">
          <h2 id="c-people" className="contacts-h">People <span className="count">{people.length}</span></h2>
          {!shownPeople.length ? <p className="muted small contacts-none">{people.length ? 'No match' : 'People you chat with show up here'}</p> : (
            <ul className="contact-list">
              {shownPeople.map((p) => (
                <li key={p.address}>
                  <button className="contact-item" onClick={() => setOpen(p.address)}>
                    <Avatar name={p.login} login={p.login} size="lg" />
                    <span className="meta">
                      <span className="name">{p.login}{p.blocked && <span className="label">Blocked</span>}</span>
                      <span className="preview">{sharedText(p)}</span>
                    </span>
                    <TrustMark p={p} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="c-groups">
          <h2 id="c-groups" className="contacts-h">Groups <span className="count">{groups.length}</span></h2>
          {!shownGroups.length ? <p className="muted small contacts-none">{groups.length ? 'No match' : 'No groups yet'}</p> : (
            <ul className="contact-list">
              {shownGroups.map((c) => {
                const g = c.live ?? c.current;
                const n = g?.members().length;
                return (
                  <li key={c.key}>
                    <button className="contact-item" onClick={() => go(`/c/${encodeURIComponent(c.key)}`)}>
                      <Avatar name={c.title} square size="lg" />
                      <span className="meta">
                        <span className="name">{c.title}{!c.live && <span className="label">{c.unreachable ? 'Can\u2019t reach' : 'Ended'}</span>}</span>
                        <span className="preview">{n ? `${n} ${n === 1 ? 'member' : 'members'}` : 'Not available'}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      {person && <ContactModal session={session} p={person} onClose={() => setOpen(undefined)} />}
    </>
  );
}

function sharedText(p: Person) {
  const parts: string[] = [];
  if (p.dm) parts.push(p.dm.live ? 'Direct chat' : 'Direct chat ended');
  if (p.groups.length === 1) parts.push(p.groups[0]!.title);
  else if (p.groups.length > 1) parts.push(`${p.groups.length} groups`);
  return parts.join(' · ') || 'No chats now';
}

/** Green shield once verified, a warning when the key changed, nothing otherwise. */
export function TrustMark({ p }: { p: Pick<Person, 'verified' | 'conflict'> & { keyChanged?: boolean } }) {
  if (p.conflict || p.keyChanged) return <span className="trust warn" title="Key changed" aria-label="Key changed">{Icon.shield(false, 16)}</span>;
  if (p.verified) return <span className="trust ok" title="Verified" aria-label="Verified">{Icon.shield(true, 16)}</span>;
  return null;
}

function ContactModal({ session, p, onClose }: { session: Session; p: Person; onClose: () => void }) {
  const { busy, error, run } = useAction();
  const open = (c: Convo) => { onClose(); go(`/c/${encodeURIComponent(c.key)}`); };
  const message = () => run(async () => {
    const key = p.dm?.live ? p.dm.key : await session.startDm(p.login);
    onClose();
    go(`/c/${encodeURIComponent(key)}`);
  });
  return (
    <Modal title={p.login} onClose={onClose}>
      <div className="contact-head">
        <Avatar name={p.login} login={p.login} size="xl" />
        <div className="member-text">
          <div className="member-name"><strong>{p.login}</strong>{p.blocked && <span className="label">Blocked</span>}</div>
          {p.firstSeen && <div className="small muted">Known since {new Date(p.firstSeen).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}</div>}
        </div>
      </div>
      <ErrorFlash error={error} />
      <div className="row">
        {!p.blocked && <button className="btn primary" disabled={busy} onClick={message}>{busy ? <><span className="spinner" /> Opening…</> : p.dm?.live ? 'Open chat' : 'Message'}</button>}
        {p.blocked ? (
          <button className="btn" onClick={() => void session.unblock(p.address).catch((e) => toast(String(e)))}>Unblock</button>
        ) : (
          <button className="btn danger" onClick={() => void (async () => {
            if (await ask({ title: `Block ${p.login}?`, body: 'Their invitations are turned down without asking you, and your chat with them closes.', confirm: `Block ${p.login}`, danger: true })) await session.block(p.address);
          })().catch((e) => toast(String(e)))}>Block</button>
        )}
      </div>
      {p.groups.length > 0 && (
        <div className="contact-groups">
          <div className="small muted">Groups you share</div>
          {p.groups.map((g) => (
            <button key={g.key} className="btn link" onClick={() => open(g)}>{g.title}</button>
          ))}
        </div>
      )}
      <div className="contact-verify">
        <h4>Safety number</h4>
        <VerifyPanel session={session} address={p.address} />
      </div>
    </Modal>
  );
}
