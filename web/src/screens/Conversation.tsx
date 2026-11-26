import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Group } from 'keyhold/chat';
import { describeError, loginFrom, type Convo, type MsgRecord, type PeerInfo, type Session } from '../lib/session';
import { EARLIER_ELSEWHERE, endedText } from './Home';
import { ask, Avatar, ErrorFlash, GroupAvatar, go, Hint, Icon, MenuItem, Notices, SyncDot, timeLabel, toast, useAction } from '../ui';
import { ChatMenu, CLOSE_ASK, deleteAsk } from './ChatMenu';
import { AttachmentView, DraftTray, isImage, Lightbox, PendingAttachment, saveBlob, toDrafts, type Draft, type Viewing } from './Attachments';
import { EmojiRow, MsgPopup, useLongPress, type Anchor } from './MessageMenu';
import { stepLine } from './Progress';

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const msgTime = (ts: number) => (timeLabel(ts) === clock(ts) ? clock(ts) : `${timeLabel(ts)} ${clock(ts)}`);
const RUN_GAP = 5 * 60_000;
const dayKey = (ts: number) => new Date(ts).toDateString();
function dayLabel(ts: number) {
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  const k = dayKey(ts);
  if (k === now.toDateString()) return 'Today';
  if (k === y.toDateString()) return 'Yesterday';
  const d = new Date(ts);
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}
/** Two messages read as one run: same sender, a few minutes apart, same day. */
function sameRun(a: Item | undefined, b: Item | undefined) {
  if (a?.kind !== 'msg' || b?.kind !== 'msg') return false;
  if (a.m.kind === 'system' || b.m.kind === 'system') return false;
  return a.m.from === b.m.from && a.m.mine === b.m.mine && Math.abs(b.m.ts - a.m.ts) < RUN_GAP && dayKey(a.m.ts) === dayKey(b.m.ts);
}

type Item = { kind: 'msg'; m: MsgRecord; group?: Group } | { kind: 'divider'; id: string; text: string };
type MsgItem = Extract<Item, { kind: 'msg' }>;
type Run = { kind: 'run'; msgs: MsgItem[]; newDay: boolean } | Extract<Item, { kind: 'divider' }>;

/** Groups consecutive messages into runs; a new day always starts a new run. */
function runs(items: Item[]): Run[] {
  const out: Run[] = [];
  let prevMsg: MsgItem | undefined;
  items.forEach((it, i) => {
    if (it.kind === 'divider') {
      out.push(it);
      return;
    }
    const cur = out[out.length - 1];
    if (cur?.kind === 'run' && sameRun(items[i - 1], it)) cur.msgs.push(it);
    else out.push({ kind: 'run', msgs: [it], newDay: !prevMsg || dayKey(prevMsg.m.ts) !== dayKey(it.m.ts) });
    prevMsg = it;
  });
  return out;
}

export function Conversation({ session, convo }: { session: Session; convo: Convo }) {
  const [items, setItems] = useState<Item[]>([]);
  const [peer, setPeer] = useState<PeerInfo>();
  const [viewing, setViewing] = useState<Viewing>();
  const innerRef = useRef<HTMLDivElement>(null);
  const v = session.getVersion();
  const dm = convo.dm;
  const live = convo.live;
  const group = live ?? convo.current;
  const peerAddr = convo.peer;
  // The key the other person's leaf carries here, compared with the one this account trusts for them.
  const peerKey = dm ? group?.members().find((m) => m.address === peerAddr && !m.pending) : undefined;
  const forged = !!peerKey && session.keyMismatch(peerKey);
  const title = convo.title;
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const roomIds = convo.rooms.map((r) => r.groupId).join(',');
  const { busy, doing, error, run } = useAction();

  useEffect(() => {
    let alive = true;
    void Promise.all(convo.rooms.map((r) => session.messages(r.groupId))).then((lists) => {
      if (!alive) return;
      const out: Item[] = [];
      convo.rooms.forEach((r, i) => {
        const g = session.group(r.groupId);
        if (r.joinedAt && !((r.clearedAt ?? 0) >= r.joinedAt)) out.push({ kind: 'divider', id: `joined-${r.groupId}`, text: EARLIER_ELSEWHERE });
        for (const m of lists[i]!) out.push({ kind: 'msg', m, group: g });
        const later = i < convo.rooms.length - 1;
        if (r.ended) {
          const when = new Date(r.ended.at).toLocaleDateString([], { day: 'numeric', month: 'short' });
          out.push({ kind: 'divider', id: `end-${r.groupId}`, text: `${endedText(session, r.ended, dm)} on ${when}${later ? ' · new chat started' : ''}` });
        } else if (later) out.push({ kind: 'divider', id: `end-${r.groupId}`, text: 'New chat started' });
      });
      setItems(out);
    });
    return () => {
      alive = false;
    };
  }, [v, roomIds]);

  // Someone shown as invited may have declined without the chat saying so: ask GitHub once.
  useEffect(() => {
    if (live) void session.checkInvited(live).catch(() => undefined);
  }, [live?.id]);

  useEffect(() => {
    if (!peerAddr) return;
    let alive = true;
    void session.peer(peerAddr).then((p) => alive && setPeer(p));
    return () => {
      alive = false;
    };
  }, [peerAddr, v]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items.length, live && session.sending.get(live.id)?.length]);

  // Pictures load after the text: keep the newest message in view while they do.
  useEffect(() => {
    const el = listRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const liveRec = live ? session.records.get(live.id) : undefined;
  const pending = live ? session.pending(live) : [];
  // A sent message keeps its bubble until the chat shows the stored copy, so nothing blinks.
  const shownIds = new Set(items.map((it) => (it.kind === 'msg' ? it.m.id : '')));
  const sending = (live ? session.sending.get(live.id) ?? [] : []).filter((p) => !p.sentId || !shownIds.has(p.sentId));
  const busyLabel = session.chatBusy.get(convo.key);
  const act = session.activities.forKey(convo.key);
  const step = act && !act.ended ? stepLine(act) : undefined;
  const err = group ? session.chatWarning(group.id) : undefined;
  const joined = !!live && live.members().length > 1;
  // A group can be written in alone: people invited later join from then on. A DM waits for the other person.
  const canWrite = !!live && (!dm || joined);
  // People who reset their key and haven't been invited back. In a DM the chat waits for that.
  const resets = session.resetPeople(convo);
  // (Once they are in the live room again, with their new key, it's over.) Their directory showing
  // another key than the one this account trusts is the same thing, seen before the chat's own check.
  const peerReset = dm && !!peerAddr && !forged && (peer?.status === 'key-changed' || (!joined && (resets.includes(peerAddr) || last0(convo)?.ended?.how === 'reset')));
  const amAdmin = !!live && live.policy.admins.includes(session.identity?.fingerprint ?? '');
  const groupResets = !dm && live && amAdmin ? resets.filter((a) => !live.members().some((m) => m.address === a && !session.keyMismatch(m))) : [];
  const peerLeft = !!live && dm && !!liveRec?.peerLeft && !joined && !peerReset;
  // They turned the invitation down (or it ran out): nothing is waiting, the one who asked can ask again.
  const notJoined = !!live && dm && !!peerAddr && !joined && !peerReset && !peerLeft && session.notJoined(live).includes(peerAddr);
  // Each button says what it is doing itself: the others only wait (disabled).
  const inviteBack = (a: string) => run(async () => go(`/c/${encodeURIComponent(await session.inviteBack(convo, a))}`), `back:${a}`);
  const last = convo.rooms[convo.rooms.length - 1]!;
  const space = group?.space ?? last.space;
  const startNew = () => run(async () => go(`/c/${encodeURIComponent(await session.startDm(loginFrom(peerAddr!)))}`), 'new');

  return (
    <>
      <div className="convo-head">
        <a href="#/" className="btn icon ghost mobile-only" aria-label="Back to chats">{Icon.back()}</a>
        {dm ? <Avatar name={title} login={peerAddr ? loginFrom(peerAddr) : undefined} size="lg" /> : <GroupAvatar id={convo.key} picture={convo.avatar} size="lg" />}
        <div className="who-text">
          <span className="convo-title-row">
            <strong className="convo-title">{title}</strong>
            <Hint className="hint lock" label="End-to-end encrypted" text={<>End-to-end encrypted. Messages are encrypted in this browser before they're saved to GitHub{space ? <>, in <span className="mono">{space.split('/')[1]}</span></> : ''}.</>}>{Icon.lock(12)}</Hint>
          </span>
          {busyLabel || step ? (
            <span className="convo-sub busy" role="status"><span className="spinner" />{step ?? busyLabel}</span>
          ) : !dm && group && <span className="convo-sub">{session.joinedMembers(group).length} {session.joinedMembers(group).length === 1 ? 'member' : 'members'}</span>}
        </div>
        <div className="convo-actions">
          <span className="mobile-only"><SyncDot session={session} /></span>
          <ChatMenu session={session} convo={convo} />
        </div>
      </div>
      {forged && (
        <div className="flash warn banner">
          <span><strong>The key {title} uses in this chat is not the one you trust for them.</strong> <Hint text="Their messages here may not be from them." /></span>
        </div>
      )}
      {peerReset && (
        <div className="flash warn banner">
          <span><strong>{title} reset their encryption key.</strong> <Hint text={`Their old key can't be used any more. Invite ${title} again to keep chatting: their app asks them to accept, and your earlier messages stay here. Not sure it was them? Check with them another way first.`} /></span>
          {!session.blocked.has(peerAddr!) && <button className="btn primary" disabled={busy} onClick={() => inviteBack(peerAddr!)}>{doing === `back:${peerAddr}` ? <><span className="spinner" /> Inviting…</> : 'Invite again'}</button>}
        </div>
      )}
      {groupResets.map((a) => (
        <div key={a} className="flash warn banner">
          <span><strong>@{loginFrom(a)} reset their encryption key.</strong> <Hint text="Their old key was taken out of the group. Invite them again to let the new key in; they won't see earlier messages. Not sure it was them? Check with them another way first." /></span>
          <button className="btn" disabled={busy} onClick={() => inviteBack(a)}>{doing === `back:${a}` ? <><span className="spinner" /> Inviting…</> : 'Invite again'}</button>
        </div>
      ))}
      {notJoined && (
        <div className="flash warn banner">
          <span><strong>{title} didn’t join.</strong> <Hint text="They declined your invitation, or it ran out. Your messages stay here." /></span>
          {session.isOwner(live!) && !session.blocked.has(peerAddr!) && <button className="btn primary" disabled={busy} onClick={() => run(() => session.invite(live!, [loginFrom(peerAddr!)]), 'again')}>{doing === 'again' ? <><span className="spinner" /> Inviting…</> : 'Invite again'}</button>}
        </div>
      )}
      {peerLeft && (
        <div className="flash warn banner">
          <span><strong>{title} left this chat.</strong></span>
          {session.isOwner(live!) && <button className="btn danger" disabled={busy || !!busyLabel} onClick={() => run(async () => { if (await ask(CLOSE_ASK)) await session.chatAction(convo.key, 'Closing chat…', () => session.closeChat(live!)); })}>{busyLabel ? <><span className="spinner" /> Closing…</> : 'Close chat'}</button>}
        </div>
      )}
      {!live && !peerReset && (
        <div className="flash banner">
          <span>
            <strong>{convo.unreachable ? 'Can\u2019t reach this chat. Retrying…' : group ? 'This chat is no longer available.' : `${last.ended ? endedText(session, last.ended, dm) : 'This chat has ended'}.`}</strong>{' '}
            <Hint text={group ? "GitHub doesn't let you open it right now. If access comes back, it carries on." : 'Your copy of the messages stays here until you delete it.'} />
          </span>
          <span className="row">
            {dm && peerAddr && !session.blocked.has(peerAddr) && <button className="btn primary" disabled={busy} onClick={startNew}>{doing === 'new' ? <><span className="spinner" /> Starting…</> : `Start a new chat with ${title}`}</button>}
            <button className="btn" disabled={busy} onClick={() => run(async () => { if (await ask(deleteAsk(dm ? title : undefined))) { await session.deleteHistory(convo.key); go('/'); } })}>Delete chat</button>
          </span>
        </div>
      )}
      <ErrorFlash error={error} />
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="messages-inner" ref={innerRef}>
          {runs(items).map((run) => {
            if (run.kind === 'divider') return <div key={run.id} className="sys divider">{run.text}</div>;
            const head = run.msgs[0]!;
            const who = loginFrom(head.m.from);
            if (head.m.kind === 'system') return <Message key={`${head.m.groupId}/${head.m.id}`} m={head.m} session={session} group={head.group} showAuthor={false} onOpen={setViewing} />;
            // A run is keyed by its first message, so when a new message joins it the
            // run (and its one avatar) stays mounted instead of moving to a new element.
            return (
              <Fragment key={`${head.m.groupId}/${head.m.id}`}>
                {run.newDay && <div className="day-divider" role="separator"><span>{dayLabel(head.m.ts)}</span></div>}
                <div className={`run${head.m.mine ? ' mine' : ''}${dm ? '' : ' named'}`}>
                  {!head.m.mine && <span className="msg-avatar"><Avatar name={who} login={who} size="sm" /></span>}
                  <div className="run-msgs">
                    {run.msgs.map((it, j) => (
                      <Message key={it.m.id} m={it.m} session={session} group={it.group} showAuthor={!dm} first={j === 0} last={j === run.msgs.length - 1} onOpen={setViewing} />
                    ))}
                  </div>
                </div>
              </Fragment>
            );
          })}
          {sending.map((p) => (
            <div key={p.id} className="msg mine">
              <div className="bubble-line">
                {p.file ? <div className={`bubble attachment${p.preview ? ' has-media' : ''}${p.caption ? ' has-caption' : ''}`}><PendingAttachment p={p} /></div> : <div className="bubble pending">{p.body}</div>}
              </div>
              {p.failed ? (
                <span className="msg-meta failed" role="alert">
                  {Icon.alert(12)} Not sent
                  <button className="meta-btn" onClick={() => void session.retrySend(live!, p.id)}>Retry</button>
                  <button className="meta-btn" onClick={() => session.discardSend(live!.id, p.id)}>Remove</button>
                </span>
              ) : (
                <span className="msg-meta" role="status">{p.sentId ? null : <><span className="spinner" /> {p.file ? 'Uploading…' : 'Sending…'}</>}</span>
              )}
            </div>
          ))}
          {/* Only in a DM: in a group, who hasn't accepted yet is shown in the chat's info, not in the conversation. */}
          {live && dm && !peerLeft && pending.length > 0 && (
            <div className="sys">Waiting for {pending.map((a) => '@' + loginFrom(a)).join(', ')} to accept</div>
          )}
        </div>
      </div>
      {live ? (
        <Composer session={session} group={live} disabledReason={busyLabel ?? (peerReset ? `Paused until ${title} is invited again` : peerLeft ? `${title} left this chat` : notJoined ? `${title} didn’t join` : !canWrite ? 'Waiting for the other person to join…' : undefined)} error={err} />
      ) : (
        <div className="composer ended">This chat has ended</div>
      )}
      {viewing && <Lightbox v={viewing} onClose={() => setViewing(undefined)} />}
    </>
  );
}

/** The newest room of a conversation. */
function last0(c: Convo) {
  return c.rooms[c.rooms.length - 1];
}

function Message({ m, session, group, showAuthor, first = true, last = true, onOpen }: { m: MsgRecord; session: Session; group?: Group; showAuthor: boolean; first?: boolean; last?: boolean; onOpen: (v: Viewing) => void }) {
  const [popup, setPopup] = useState<Anchor>();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const long = useLongPress((el) => openMenu({ rect: el.getBoundingClientRect(), mine: !!m.mine, prefer: 'below' }));
  if (m.kind === 'system') return <div className="sys" title={m.body}>{(m.body ?? '').replace(/\. .*$/, '').replace(/\.$/, '')}</div>;
  const who = loginFrom(m.from);
  const reactions = session.shownReactions(m);
  const act = (fn: () => Promise<unknown>) => fn().catch((e) => toast(describeError(e)));
  const deleting = !m.deleted && session.deleting.has(`${m.groupId}/${m.id}`);
  const canAct = !m.deleted && !deleting && !!group?.active;
  const react = (emoji: string) => {
    if (!group) return;
    const mineNow = !!reactions.find((r) => r.emoji === emoji)?.who.includes(session.address);
    act(() => session.react(group, m.id, emoji, !mineNow));
  };
  const mineOf = (emoji: string) => {
    const r = reactions.find((x) => x.emoji === emoji);
    if (!r?.who.includes(session.address)) return 'no' as const;
    return r.pending ? ('pending' as const) : ('yes' as const);
  };
  const attach = !m.deleted && m.kind === 'attachment' && !!m.file;
  const text = m.deleted ? undefined : attach ? m.caption : m.body;
  const canDownload = attach && !!group;
  const hasMenu = canAct || !!text || canDownload;
  const close = () => setPopup(undefined);
  function openMenu(anchor: Anchor) {
    if (hasMenu) setPopup(anchor);
  }
  const besideBubble = (prefer: 'above' | 'below'): Anchor | undefined => {
    const r = bubbleRef.current?.getBoundingClientRect();
    return r && { rect: r, mine: !!m.mine, prefer };
  };
  const pick = (e: string) => {
    close();
    react(e);
  };
  const del = () => {
    close();
    act(async () => { if (await ask({ title: 'Delete this message for everyone?', confirm: 'Delete', danger: true })) await session.deleteMessage(group!, m.id); });
  };
  const copy = () => {
    close();
    navigator.clipboard.writeText(text ?? '').then(() => toast('Copied'), () => toast("Couldn't copy"));
  };
  const download = () => {
    close();
    const f = m.file!;
    act(async () => {
      const url = URL.createObjectURL(await session.fetchFile(group!, f));
      saveBlob(url, f.name ?? 'file');
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
  };
  return (
    <div className={`msg${m.mine ? ' mine' : ''}${first ? '' : ' cont'}${popup ? ' popup-open' : ''}`}>
      {showAuthor && !m.mine && first && <span className="msg-author">{who}</span>}
      <div className="bubble-line">
        <div
          ref={bubbleRef}
          className={`bubble${m.deleted ? ' deleted' : ''}${deleting ? ' pending' : ''}${attach ? ` attachment${group && isImage(m.file!.mime) ? ' has-media' : ''}${m.caption ? ' has-caption' : ''}` : ''}`}
          title={new Date(m.ts).toLocaleString()}
          {...(hasMenu ? long.handlers : {})}
          onContextMenu={(e) => {
            if (!hasMenu || e.shiftKey) return;
            // Keep the browser's own menu for links and for text you've selected.
            const sel = getSelection();
            const selected = !!sel && !sel.isCollapsed && bubbleRef.current?.contains(sel.anchorNode);
            if (!long.fired.current && (selected || (e.target as HTMLElement).closest('a'))) return;
            e.preventDefault();
            if (popup) return;
            // A long press, or the keyboard's menu key (no pointer position), opens beside the bubble.
            const keyboard = e.clientX === 0 && e.clientY === 0;
            openMenu(long.fired.current || keyboard ? besideBubble('below')! : { x: e.clientX, y: e.clientY });
          }}
        >
          {m.deleted ? 'Message deleted' : attach ? (group ? <AttachmentView session={session} group={group} file={m.file!} caption={m.caption} onOpen={onOpen} /> : <span className="muted">📎 {m.file!.name ?? 'file'} (no longer available)</span>) : m.body}
        </div>
      </div>
      {popup && (
        <MsgPopup anchor={popup} label="Message actions" onClose={close} className="full">
          {canAct && <EmojiRow mineOf={mineOf} onPick={pick} />}
          {canAct && (text || canDownload || m.mine) && <div className="menu-sep" />}
          {text && <MenuItem icon={Icon.copy()} onClick={copy}>{attach ? 'Copy caption' : 'Copy text'}</MenuItem>}
          {canDownload && <MenuItem icon={Icon.download()} onClick={download}>{isImage(m.file!.mime) ? 'Save picture' : 'Download'}</MenuItem>}
          {canAct && m.mine && <MenuItem icon={Icon.trash()} danger onClick={del}>Delete for everyone</MenuItem>}
        </MsgPopup>
      )}
      {reactions.length > 0 && (
        <div className="reactions">
          {reactions.map(({ emoji, who, pending }) => (
            <button key={emoji} className={`reaction${who.includes(session.address) ? ' me' : ''}${pending ? ' pending' : ''}`} title={pending ? 'Sending…' : who.map(loginFrom).join(', ')} aria-busy={pending || undefined} disabled={!group?.active || deleting} onClick={() => !pending && react(emoji)}>
              {emoji} <span>{who.length}</span>
            </button>
          ))}
        </div>
      )}
      {deleting ? (
        <span className="msg-meta" role="status"><span className="spinner" /> Deleting…</span>
      ) : (last || m.edited) && (
        <span className="msg-meta">
          {last && msgTime(m.ts)}
          {m.edited && (last ? ' · edited' : 'Edited')}
        </span>
      )}
    </div>
  );
}

function Composer({ session, group, disabledReason, error }: { session: Session; group: Group; disabledReason?: string; error?: string }) {
  const draftKey = `kh.draft.${group.id}`;
  const [text, setText] = useState(() => sessionStorage.getItem(draftKey) ?? '');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [dragging, setDragging] = useState(false);
  const { error: sendError, run } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  useEffect(() => {
    sessionStorage.setItem(draftKey, text);
    const ta = taRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, [text]);
  useEffect(() => () => draftsRef.current.forEach((d) => d.url && URL.revokeObjectURL(d.url)), []);
  const add = (files: File[]) => {
    if (disabledReason || !files.length) return;
    const next = toDrafts(files, (f) => toast(`${f.name} is too big to send.`));
    if (next.length) setDrafts((d) => [...d, ...next].slice(0, 10));
    taRef.current?.focus();
  };
  const remove = (id: string) => setDrafts((ds) => {
    const d = ds.find((x) => x.id === id);
    if (d?.url) URL.revokeObjectURL(d.url);
    return ds.filter((x) => x.id !== id);
  });

  // Drop files anywhere on the page to attach them.
  useEffect(() => {
    if (disabledReason) return;
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDragging(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDragging(false); } };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      add(Array.from(e.dataTransfer!.files));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [disabledReason]);

  const send = () => {
    const body = text.trim();
    if (disabledReason || (!body && !drafts.length)) return;
    setText('');
    if (drafts.length) {
      const files = drafts.map((d) => d.file);
      drafts.forEach((d) => d.url && URL.revokeObjectURL(d.url));
      setDrafts([]);
      void run(() => session.sendFiles(group, files, body || undefined));
      return;
    }
    void run(() => session.send(group, body));
  };
  const canSend = !disabledReason && (!!text.trim() || drafts.length > 0);
  return (
    <div className="composer">
      {sendError ? <ErrorFlash error={sendError} /> : <Notices sync={error} />}
      <div className={`composer-box${drafts.length ? ' with-tray' : ''}`}>
        {drafts.length > 0 && <DraftTray drafts={drafts} onRemove={remove} />}
        <div className="composer-row">
          <button className="btn icon ghost" aria-label="Attach files" title="Attach files" disabled={!!disabledReason} onClick={() => fileRef.current?.click()}>{Icon.clip()}</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => {
            const fs = Array.from(e.target.files ?? []);
            e.target.value = '';
            add(fs);
          }} />
          <label htmlFor="composer" className="sr">Message</label>
          <textarea
            id="composer"
            ref={taRef}
            rows={1}
            value={text}
            placeholder={disabledReason ?? (drafts.length ? 'Add a caption' : `Message ${session.title(group)}`)}
            disabled={!!disabledReason}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const fs = Array.from(e.clipboardData.files);
              if (fs.length) {
                e.preventDefault();
                add(fs);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="send" onClick={send} disabled={!canSend} aria-label="Send" title="Send (Enter). Shift+Enter for a new line.">{Icon.send()}</button>
        </div>
      </div>
      {dragging && <div className="drop-zone" aria-hidden="true"><span>{Icon.image(28)} Drop to attach</span></div>}
    </div>
  );
}
