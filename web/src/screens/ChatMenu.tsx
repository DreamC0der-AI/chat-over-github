import { useEffect, useState } from 'react';
import { loginFrom, type Convo, type Session } from '../lib/session';
import { PicturePicker } from './GroupPicture';
import { PeoplePicker } from './PeoplePicker';
import { ask, Avatar, ErrorFlash, go, GroupAvatar, Hint, Icon, Menu, MenuItem, Modal, toast, useAction } from '../ui';

export const CLOSE_ASK = { title: 'Close this chat?', body: 'It ends for everyone and its repo is deleted from GitHub. Everyone keeps the messages their app already has.', confirm: 'Close chat', danger: true };
export const deleteAsk = (peer?: string) => ({ title: 'Delete this chat?', body: `Your copy of the messages is deleted from your browsers. ${peer ?? 'The other members'} keep${peer ? 's' : ''} their copy.`, confirm: 'Delete chat', danger: true });
const QUIT_ASK = { title: 'Quit this chat?', body: 'You stop receiving messages. Your copy of the history stays until you delete it.', confirm: 'Quit chat', danger: true };

/** The "…" button of a chat: info, delete, close or quit, block. Used in the chat list and the chat header. */
export function ChatMenu({ session, convo, className }: { session: Session; convo: Convo; className?: string }) {
  const [info, setInfo] = useState(false);
  const dm = convo.dm;
  const live = convo.live;
  const peer = convo.peer;
  const owner = !!live && session.isOwner(live);
  const blocked = !!peer && session.blocked.has(peer);
  const act = (fn: () => Promise<unknown>) => void fn().catch((e) => toast(e instanceof Error ? e.message : String(e)));
  const busy = session.chatBusy.has(convo.key);
  const slow = (label: string, fn: () => Promise<unknown>) => session.chatAction(convo.key, label, fn);
  return (
    <>
      <Menu label="Chat options" className={className}>
        {(close) => {
          const pick = (fn: () => void) => () => { close(); fn(); };
          return (
            <>
              <MenuItem icon={dm ? Icon.info() : Icon.people()} onClick={pick(() => setInfo(true))}>{dm ? 'Chat info' : 'Group info'}</MenuItem>
              <div className="menu-sep" role="separator" />
              <MenuItem icon={Icon.trash()} disabled={busy} onClick={pick(() => act(async () => {
                if (!(await ask(deleteAsk(dm ? convo.title : undefined)))) return;
                await slow('Deleting chat…', () => session.deleteHistory(convo.key));
                if (!live) go('/');
              }))}>Delete chat</MenuItem>
              {live && owner && (
                <MenuItem danger icon={Icon.close()} disabled={busy} onClick={pick(() => act(async () => { if (await ask(CLOSE_ASK)) await slow('Closing chat…', () => session.closeChat(live)); }))}>Close chat</MenuItem>
              )}
              {live && !owner && (
                <MenuItem danger icon={Icon.exit()} disabled={busy} onClick={pick(() => act(async () => { if (await ask(QUIT_ASK)) await slow('Leaving chat…', () => session.quitChat(live)); }))}>Quit chat</MenuItem>
              )}
              {dm && peer && (blocked ? (
                <MenuItem icon={Icon.block()} disabled={busy} onClick={pick(() => act(() => session.unblock(peer)))}>Unblock {convo.title}</MenuItem>
              ) : (
                <MenuItem danger icon={Icon.block()} disabled={busy} onClick={pick(() => act(async () => {
                  const body = `${live ? (owner ? 'This chat is closed, and their' : 'You quit this chat, and their') : 'Their'} invitations are turned down without asking you.`;
                  if (await ask({ title: `Block ${convo.title}?`, body, confirm: `Block ${convo.title}`, danger: true })) await slow(`Blocking ${convo.title}…`, () => session.block(peer));
                }))}>Block {convo.title}</MenuItem>
              ))}
            </>
          );
        }}
      </Menu>
      {info && <ChatInfo session={session} convo={convo} onClose={() => setInfo(false)} />}
    </>
  );
}

/** Who is in the chat and where it is stored. Admins of a group rename, change the picture, invite and remove here. */
function ChatInfo({ session, convo, onClose }: { session: Session; convo: Convo; onClose: () => void }) {
  const dm = convo.dm;
  const live = convo.live;
  const group = live ?? convo.current;
  const members = (group?.members() ?? []).filter((m) => !m.pending);
  const iAmAdmin = !!group && group.policy.admins.includes(session.identity!.fingerprint);
  const pending = live ? session.pending(live) : [];
  const notJoined = live ? session.notJoined(live) : [];
  const [invite, setInvite] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const inGroup = [...members.map((m) => loginFrom(m.address)), ...pending.map(loginFrom)];
  const [name, setName] = useState(group?.name ?? '');
  const { busy, doing, error, run } = useAction();
  return (
    <Modal title={dm ? 'Chat info' : 'Group info'} onClose={onClose}>
      <ErrorFlash error={error} />
      {!dm && (
        <div className="group-head">
          {iAmAdmin && live
            ? <PicturePicker groupId={convo.key} picture={convo.avatar} busy={doing === 'picture'} disabled={busy} onChange={(pic) => run(() => session.setAvatar(live, pic), 'picture')} />
            : <GroupAvatar id={convo.key} picture={convo.avatar} size="xl" />}
          {iAmAdmin && live ? (
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void run(() => session.rename(live, name.trim()), 'rename'); }}>
              <label className="sr" htmlFor="group-name">Group name</label>
              <input id="group-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
              <button className="btn" disabled={busy || !name.trim() || name.trim() === live.name}>{doing === 'rename' ? <><span className="spinner" /> Renaming…</> : 'Rename'}</button>
            </form>
          ) : <span className="group-name">{convo.title}</span>}
        </div>
      )}
      <div className="members">
        {members.map((m) => {
          const login = loginFrom(m.address);
          const me = m.address === session.address;
          return (
            <div className="member" key={m.fingerprint}>
              <Avatar name={login} login={login} />
              <div className="member-text">
                <div className="member-name">
                  <strong>{login}</strong>{me && <span className="muted">you</span>}
                  {m.admin && !dm && <span className="label blue">Admin</span>}
                  {m.admin && !dm && members.filter((x) => x.admin).length === 1 && members.length > 1 && <Hint text="The only admin. If this admin resets their encryption key, the group ends." />}
                  {session.keyMismatch(m) && <span className="label red" title="The key this member uses here is not the one you trust for them. Their messages may not be from them.">Key doesn’t match</span>}
                </div>
                <div className="small muted">{m.devices.length} {m.devices.length === 1 ? 'device' : 'devices'}</div>
              </div>
              {!me && !dm && iAmAdmin && live && (
                <button className="btn danger" disabled={busy} onClick={() => run(async () => {
                  if (await ask({ title: `Remove ${login}?`, body: 'Keys rotate right away, so they can\'t read new messages.', confirm: 'Remove', danger: true })) await session.removeMember(live, m.fingerprint);
                }, `remove:${m.fingerprint}`)}>{doing === `remove:${m.fingerprint}` ? <><span className="spinner" /> Removing…</> : 'Remove'}</button>
              )}
            </div>
          );
        })}
        {pending.map((a) => (
          <div className="member" key={a}>
            <Avatar name={loginFrom(a)} login={loginFrom(a)} />
            <div className="member-text"><strong>{loginFrom(a)}</strong><div className="small muted">Invited</div></div>
            {live && (dm ? session.isOwner(live) : iAmAdmin) && (
              <button className="btn" disabled={busy} onClick={() => run(() => session.invite(live, [loginFrom(a)]), `resend:${a}`)}>
                {doing === `resend:${a}` ? <><span className="spinner" /> Sending…</> : 'Resend'}
              </button>
            )}
          </div>
        ))}
        {notJoined.map((a) => (
          <div className="member" key={a}>
            <Avatar name={loginFrom(a)} login={loginFrom(a)} />
            <div className="member-text"><strong>{loginFrom(a)}</strong><div className="small muted">Didn’t join</div></div>
            {live && (dm ? session.isOwner(live) : iAmAdmin) && !session.blocked.has(a) && (
              <button className="btn" disabled={busy} onClick={() => run(() => session.invite(live, [loginFrom(a)]), `again:${a}`)}>
                {doing === `again:${a}` ? <><span className="spinner" /> Inviting…</> : 'Invite again'}
              </button>
            )}
          </div>
        ))}
      </div>
      {!dm && iAmAdmin && live && (
        <form className="invite-form" onSubmit={(e) => {
          e.preventDefault();
          const who = [...invite, ...query.split(/[\s,]+/)].filter(Boolean);
          void run(async () => { await session.invite(live, who); setInvite([]); setQuery(''); }, 'invite');
        }}>
          <PeoplePicker session={session} id="invite-login" label="Invite people" value={invite} onChange={setInvite} query={query} onQuery={setQuery} exclude={inGroup} disabled={busy} />
          <button className="btn primary" disabled={busy || (!invite.length && !query.trim())}>{doing === 'invite' ? <><span className="spinner" /> Inviting…</> : invite.length > 1 ? `Invite ${invite.length}` : 'Invite'}</button>
        </form>
      )}
      {group && (
        <dl className="facts">
          <div>
            <dt>Stored in</dt>
            <dd><a href={`https://github.com/${group.space}`} target="_blank" rel="noreferrer" className="mono">{group.space}</a> <Hint text="A private GitHub repo. The files in it are ciphertext." /></dd>
          </div>
          <div>
            <dt>Key epoch</dt>
            <dd>{String(group.epoch)} <Hint text="Keys rotate every 7 days or 100 messages, and whenever someone leaves." /></dd>
          </div>
        </dl>
      )}
    </Modal>
  );
}
