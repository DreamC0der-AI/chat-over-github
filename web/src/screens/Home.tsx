import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { clampSide, saveSideWidth, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, sideWidth } from '../lib/prefs';
import { loginFrom, type Convo, type PendingInvite, type Session } from '../lib/session';
import { Avatar, ErrorFlash, go, Hint, Icon, Modal, timeLabel, useAction, useSession } from '../ui';
import { ChatMenu } from './ChatMenu';
import { Contacts } from './Contacts';
import { Conversation } from './Conversation';
import { PeoplePicker } from './PeoplePicker';
import { stepLine } from './Progress';

export function Home({ session, route }: { session: Session; route: string }) {
  useSession(session);
  const chatId = route.startsWith('/c/') ? decodeURIComponent(route.slice(3)) : undefined;
  const convo = chatId ? session.convo(chatId) : undefined;
  const contacts = route === '/contacts';
  const [modal, setModal] = useState<'dm' | 'group'>();
  const [q, setQ] = useState('');
  const [sideW, setSideW] = useState(() => clampSide(sideWidth()));
  useEffect(() => {
    const fit = () => setSideW(clampSide(sideWidth()));
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    session.setActive(convo?.key);
    return () => session.setActive(undefined);
  }, [convo?.key]);

  const convos = session.conversations();
  const unread = convos.reduce((n, c) => n + c.unread, 0);
  useEffect(() => {
    document.title = unread ? `(${unread}) Chat over GitHub` : 'Chat over GitHub';
  }, [unread]);

  const shown = useMemo(
    () => convos.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase())),
    [convos, q, session.getVersion()],
  );

  return (
    <div className="app">
      <div className={`main${convo || contacts ? ' has-chat' : ''}`} style={{ '--side-w': `${sideW}px` } as CSSProperties}>
        <nav className="sidebar" aria-label="Chats">
          <div className="sidebar-head">
            <h1 className="side-title">Chats</h1>
            <a href="#/contacts" className={`btn icon ghost${contacts ? ' selected' : ''}`} aria-label="Contacts" title="Contacts" aria-current={contacts ? 'page' : undefined}>{Icon.people()}</a>
            <button className="btn icon primary" aria-label="New chat" title="New chat" onClick={() => setModal('dm')}>{Icon.compose()}</button>
          </div>
          <div className="search">
            {Icon.search()}
            <label className="sr" htmlFor="q">Search chats</label>
            <input id="q" type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ul className="chat-list">
            <Invites session={session} />
            {shown.map((c) => <ChatRow key={c.key} session={session} c={c} active={c.key === convo?.key} />)}
            {!convos.length && !session.pendingInvites().length && (
              <li className="empty">
                <p>No chats yet</p>
                <button className="btn primary" onClick={() => setModal('dm')}>Start a chat</button>
              </li>
            )}
          </ul>
          <Me session={session} />
          <SideResizer width={sideW} onChange={setSideW} />
        </nav>
        <main className="content">
          {contacts ? (
            <Contacts session={session} onNewGroup={() => setModal('group')} />
          ) : convo ? (
            <Conversation key={convo.key} session={session} convo={convo} />
          ) : chatId ? (
            <div className="empty"><p>This chat isn't on this browser.</p><a href="#/">Back to chats</a></div>
          ) : (
            <div className="empty">
              <span className="empty-icon">{Icon.lock(24)}</span>
              <h3>Pick a chat or start a new one</h3>
            </div>
          )}
        </main>
      </div>
      {modal === 'dm' && <NewDm session={session} onClose={() => setModal(undefined)} onGroup={() => setModal('group')} />}
      {modal === 'group' && <NewGroup session={session} onClose={() => setModal(undefined)} />}
    </div>
  );
}

/** The chat list's right edge: drag to resize, double-click to reset, arrow keys when focused. */
function SideResizer({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const drag = useRef<{ x: number; w: number }>();
  const [dragging, setDragging] = useState(false);
  const set = (w: number) => {
    const c = clampSide(w);
    onChange(c);
    saveSideWidth(c);
  };
  return (
    <div
      className={`side-resizer${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat list"
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        setDragging(true);
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (drag.current) onChange(clampSide(drag.current.w + e.clientX - drag.current.x));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        set(drag.current.w + e.clientX - drag.current.x);
        drag.current = undefined;
        setDragging(false);
        document.body.classList.remove('resizing');
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
        setDragging(false);
        document.body.classList.remove('resizing');
      }}
      onDoubleClick={() => set(SIDE_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === 'ArrowLeft') set(width - step);
        else if (e.key === 'ArrowRight') set(width + step);
        else if (e.key === 'Home') set(SIDE_MIN);
        else if (e.key === 'End') set(SIDE_MAX);
        else return;
        e.preventDefault();
      }}
    />
  );
}

function ChatRow({ session, c, active }: { session: Session; c: Convo; active: boolean }) {
  const g = c.live ?? c.current;
  const act = session.activities.forKey(c.key);
  const busyLabel = (act && !act.ended ? stepLine(act) : undefined) ?? session.chatBusy.get(c.key);
  const last = c.rooms[c.rooms.length - 1]!;
  const pending = c.live ? session.pending(c.live) : [];
  const waiting = c.dm && pending.length > 0;
  const preview = c.lastText
    ?? (!c.live ? (c.unreachable ? 'Can\u2019t reach this chat. Retrying…' : last.ended ? endedText(session, last.ended, c.dm) : 'No longer available')
      : waiting ? 'Invitation sent' : c.rooms.some((r) => r.joinedAt && !((r.clearedAt ?? 0) >= r.joinedAt)) ? EARLIER_ELSEWHERE : 'No messages yet');
  return (
    <li className={`chat-row${active ? ' active' : ''}`}>
      <button className={`chat-item${active ? ' active' : ''}${c.unread ? ' unread' : ''}`} onClick={() => go(`/c/${encodeURIComponent(c.key)}`)}>
        <Avatar name={c.title} login={c.peer ? loginFrom(c.peer) : undefined} square={!c.dm} size="lg" />
        <span className="meta">
          <span className="name">
            <span>{c.title}</span>
            {!c.dm && g && <span className="count">{session.joinedMembers(g).length}</span>}
            {!c.live && <span className="label">{c.unreachable ? 'Can\u2019t reach' : 'Ended'}</span>}
          </span>
          <span className="preview">{busyLabel ?? preview}</span>
        </span>
        <span className="right">
          {busyLabel ? <span className="time"><span className="spinner" /></span> : <span className="time">{timeLabel(c.lastTs)}</span>}
          {!!c.unread && <span className="counter">{c.unread}</span>}
        </span>
      </button>
      <ChatMenu session={session} convo={c} className="chat-more" />
    </li>
  );
}

/** A chat this browser joined after the account was already in it: history stays in each browser. */
export const EARLIER_ELSEWHERE = 'Earlier messages aren\u2019t on this browser';

/** One line on how a room ended, for the chat list and the divider in the timeline. */
export function endedText(session: Session, e: NonNullable<import('../lib/session').ChatRecord['ended']>, dm: boolean) {
  const me = e.by === session.address;
  const who = e.by ? `@${loginFrom(e.by)}` : 'Someone';
  const what = dm ? 'this chat' : 'this group';
  switch (e.how) {
    case 'closed': return me ? `You closed ${what}` : `${who} closed ${what}`;
    case 'moved': return 'Continued in a newer chat';
    case 'quit': return `You left ${what}`;
    case 'removed': return `You were removed from ${what}`;
  }
}

function Invites({ session }: { session: Session }) {
  const list = session.pendingInvites();
  if (!list.length) return null;
  return (
    <li className="invites">
      {list.map((inv) => (inv.mine && inv.status !== 'invited'
        ? <CatchUpRow key={inv.key} session={session} inv={inv} />
        : <InviteRow key={inv.key} session={session} inv={inv} />))}
    </li>
  );
}

/** A chat the account is already in, being added to this browser. Nobody invited anyone. */
function CatchUpRow({ session, inv }: { session: Session; inv: PendingInvite }) {
  const r = inv.space ? session.chatBySpace(inv.space) : undefined;
  const dm = r?.kind !== 'group';
  const peer = dm && r?.peer ? loginFrom(r.peer) : undefined;
  const title = peer ?? r?.lastName ?? (r?.kind === 'group' ? 'Untitled group' : 'Chat from another browser');
  const text =
    inv.status === 'joining' ? 'Adding to this browser…'
    : inv.status === 'waiting' ? 'Waiting for another member'
    : 'Could not add it yet';
  return (
    <div className="row invite-row catch-up" aria-busy={inv.status === 'joining' || inv.status === 'waiting'}>
      <Avatar name={title} login={peer} square={!dm} size="lg" />
      <div className="invite-text">
        <div className="invite-title">
          <span><strong>{title}</strong></span>
          {inv.status === 'waiting' && <Hint text="Another member's app has to let this browser in. That happens as soon as one of them has Chat over GitHub open." />}
        </div>
        <div className="small muted" title={inv.error}>
          {inv.status !== 'error' && <span className="spinner" style={{ width: 10, height: 10, marginRight: 4 }} />}
          {text}{inv.error ? `. ${inv.error}` : ''}
        </div>
        {(inv.status === 'waiting' || inv.status === 'error') && (
          <div className="row invite-actions">
            <button className="btn" onClick={() => session.retryInvite(inv.key)}>Try again</button>
            <button className="btn link small" onClick={() => session.dismissInvite(inv.key)}>Dismiss</button>
          </div>
        )}
      </div>
    </div>
  );
}

function InviteRow({ session, inv }: { session: Session; inv: PendingInvite }) {
  const { busy, error, run } = useAction();
  const [doing, setDoing] = useState<'accept' | 'decline'>();
  const answer = (what: 'accept' | 'decline') => {
    setDoing(what);
    void run(() => (what === 'accept' ? session.acceptInvite(inv.key) : session.declineInvite(inv.key))).finally(() => setDoing(undefined));
  };
  const from = loginFrom(inv.from);
  const d = inv.details;
  const act = session.activities.forKey(inv.key);
  const joining = act && !act.ended ? act : undefined;
  const text =
    joining ? undefined
    : inv.status === 'invited' ? undefined
    : inv.status === 'joining' ? 'Joining…'
    : inv.status === 'waiting' ? `Waiting for ${from}`
    : 'Could not join yet';
  const why =
    inv.status === 'invited' ? 'Accept opens the chat. Decline also turns the invitation down on GitHub.'
    : inv.status === 'waiting' ? `${from}'s app has to confirm your identity. That happens as soon as they have Chat over GitHub open.`
    : undefined;
  return (
    <div className="row invite-row">
      <Avatar name={from} login={from} size="lg" />
      <div className="invite-text">
        <div className="invite-title">
          <span>
            {d?.kind === 'group' ? <><strong>{from}</strong> invited you to <strong>{d.name ?? 'a group'}</strong></>
              : d?.kind === 'dm' ? <><strong>{from}</strong> invited you to chat</>
              : <><strong>{from}</strong> invited you</>}
          </span>
          {why && <Hint text={why} />}
        </div>
        <div className="invite-kind small muted">
          {d?.kind === 'group' ? <><span className="kind-badge">{Icon.people()} Group</span>{d.people && d.people > 1 ? <span>{d.people} people</span> : null}</>
            : d?.kind === 'dm' ? <span className="kind-badge">{Icon.person()} Direct chat</span>
            : <span className="kind-badge">Chat invitation</span>}
        </div>
        {text && (
          <div className="small muted" title={inv.error}>
            {inv.status === 'joining' || inv.status === 'waiting' ? <span className="spinner" style={{ width: 10, height: 10, marginRight: 4 }} /> : null}
            {text}{inv.error ? `. ${inv.error}` : ''}
          </div>
        )}
        <ErrorFlash error={error} />
        {inv.status === 'invited' && (
          <div className="row invite-actions">
            <button className="btn primary" disabled={busy} onClick={() => answer('accept')}>{doing === 'accept' ? <><span className="spinner" /> Accepting…</> : 'Accept'}</button>
            <button className="btn" disabled={busy} onClick={() => answer('decline')}>{doing === 'decline' ? <><span className="spinner" /> Declining…</> : 'Decline'}</button>
          </div>
        )}
        {(inv.status === 'waiting' || inv.status === 'error') && (
          <div className="row invite-actions">
            <button className="btn" onClick={() => session.retryInvite(inv.key)}>Try again</button>
            <button className="btn link small" onClick={() => session.dismissInvite(inv.key)}>Dismiss</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Bottom of the sidebar: who is signed in, a sync dot, and the way to settings. */
function Me({ session }: { session: Session }) {
  const err = session.lastPollError;
  const status = `${err ? `Sync problem: ${err}` : 'Up to date'}${session.rateRemaining !== undefined ? `. ${session.rateRemaining.toLocaleString()} GitHub requests left this hour.` : ''}`;
  return (
    <div className="me status-bar">
      <a href="#/settings" className="me-link" aria-label="Account and devices" title="Account and devices">
        <Avatar name={session.login} login={session.login} />
        <span className="me-name">{session.login}</span>
      </a>
      {!session.syncOn && <a href="#/settings/devices" className="small">Turn on sync</a>}
      <Hint className={`sync-dot${err ? ' warn' : ''}`} label={err ? 'Sync problem' : 'Up to date'} text={status}><span /></Hint>
      <a href="#/settings" className="btn icon ghost" aria-label="Settings" title="Settings">{Icon.gear()}</a>
    </div>
  );
}

function NewDm({ session, onClose, onGroup }: { session: Session; onClose: () => void; onGroup: () => void }) {
  const [login, setLogin] = useState('');
  const { busy, error, run } = useAction();
  const theirs = login.trim() ? session.inviteFrom(login) : undefined;
  return (
    <Modal title="New chat" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const key = await session.startDm(login);
            onClose();
            go(`/c/${encodeURIComponent(key)}`);
          });
        }}
      >
        <div className="field">
          <span className="field-label"><label htmlFor="dm-login">GitHub username</label><Hint text="They get a GitHub repo invitation, and the chat opens when they accept it here. Not on Chat over GitHub yet? Send them this page's address. Starting a chat creates a private repo with a random name on your account." /></span>
          <input id="dm-login" className="input" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="octocat" autoFocus autoComplete="off" />
        </div>
        {theirs && (
          <div className="flash split">
            <span><strong>{loginFrom(theirs.from)}</strong> already invited you.</span>
            <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => { await session.acceptInvite(theirs.key); onClose(); })}>Accept their invitation</button>
          </div>
        )}
        <ErrorFlash error={error} />
        <div className="modal-actions">
          <button type="button" className="btn link" onClick={onGroup}>New group instead</button>
          <button className="btn primary" disabled={busy || !login.trim()}>{busy ? <><span className="spinner" /> Creating…</> : 'Start chat'}</button>
        </div>
      </form>
    </Modal>
  );
}

function NewGroup({ session, onClose }: { session: Session; onClose: () => void }) {
  const [name, setName] = useState('');
  const [people, setPeople] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const { busy, error, run, setError } = useAction();
  return (
    <Modal title="New group" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const { group, failed } = await session.createGroup(name, [...people, ...query.split(/[\s,]+/)]);
            if (failed.length) setError(`Group created, but some invites failed: ${failed.join('; ')}`);
            else onClose();
            go(`/c/${encodeURIComponent(group.id)}`);
          });
        }}
      >
        <div className="field">
          <span className="field-label"><label htmlFor="g-name">Group name</label><Hint text="Encrypted. Only members see it, not GitHub." /></span>
          <input id="g-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekend hikers" autoFocus />
        </div>
        <div className="field">
          <span className="field-label"><label htmlFor="g-people">Invite people</label><Hint text="Pick from your contacts, or type anyone's GitHub username and press Enter. You can add more later." /></span>
          <PeoplePicker session={session} id="g-people" label="Invite people" value={people} onChange={setPeople} query={query} onQuery={setQuery} />
        </div>
        <ErrorFlash error={error} />
        <div className="modal-actions end">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !name.trim()}>{busy ? <><span className="spinner" /> Creating…</> : 'Create group'}</button>
        </div>
      </form>
    </Modal>
  );
}

