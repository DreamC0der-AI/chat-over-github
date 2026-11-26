import { useEffect, useMemo, useRef, useState } from 'react';
import { type Session } from '../lib/session';
import { Avatar, Icon } from '../ui';

const clean = (s: string) => s.trim().replace(/^@/, '').toLowerCase();

/**
 * Pick people: typing searches your contacts first, then GitHub accounts (tap to toggle), or
 * type a full GitHub username and press Enter. `value` holds the picked logins.
 * `exclude`: logins not offered (already in the group or invited).
 */
export function PeoplePicker({ session, id, label, value, onChange, query, onQuery, exclude = [], disabled }: {
  session: Session;
  id: string;
  label: string;
  value: string[];
  onChange: (logins: string[]) => void;
  query: string;
  onQuery: (q: string) => void;
  exclude?: string[];
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const v = session.getVersion();
  const skip = exclude.map((l) => l.toLowerCase()).sort().join(' ');
  const contacts = useMemo(() => {
    const out = new Set(skip.split(' '));
    return session.people().filter((p) => !p.blocked && !out.has(p.login.toLowerCase())).map((p) => p.login);
  }, [v, skip]);
  const excluded = (l: string) => skip.split(' ').includes(l);
  const q = clean(query);
  const has = (l: string) => value.some((x) => x.toLowerCase() === l.toLowerCase());
  const valid = /^[a-z0-9][a-z0-9-]{0,38}$/.test(q);
  // Contacts whose login starts with the text come before ones that only contain it.
  const shown = contacts
    .filter((l) => !q || l.toLowerCase().includes(q))
    .sort((a, b) => (q ? Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)) : 0));
  // GitHub accounts matching the text, after a short pause in typing.
  const [found, setFound] = useState<{ q: string; logins: string[] }>({ q: '', logins: [] });
  useEffect(() => {
    if (!q || !valid) return;
    let gone = false;
    const t = setTimeout(() => void session.searchUsers(q).then((logins) => { if (!gone) setFound({ q, logins }); }), 250);
    return () => { gone = true; clearTimeout(t); };
  }, [q, valid, session]);
  const searching = !!q && valid && found.q !== q;
  const isContact = (l: string) => contacts.some((c) => c.toLowerCase() === l.toLowerCase());
  const github = found.q === q ? found.logins.filter((l) => !isContact(l) && !excluded(l.toLowerCase())) : [];
  const typed = q && valid && !isContact(q) && !github.some((l) => l.toLowerCase() === q) && !has(q) && !excluded(q) ? q : '';
  const toggle = (l: string) => {
    onChange(has(l) ? value.filter((x) => x.toLowerCase() !== l.toLowerCase()) : [...value, l]);
    onQuery('');
    input.current?.focus();
  };
  const commit = () => {
    if (!q) return false;
    const exact = contacts.find((l) => l.toLowerCase() === q);
    const pick = exact ?? (shown.length === 1 && !typed ? shown[0]! : q);
    if (!has(pick) && !excluded(pick.toLowerCase())) onChange([...value, pick]);
    onQuery('');
    return true;
  };
  const item = (l: string) => {
    const on = has(l);
    return (
      <li key={l} role="option" aria-selected={on}>
        <button type="button" className={`picker-item${on ? ' on' : ''}`} disabled={disabled} onClick={() => toggle(l)}>
          <Avatar name={l} login={l} size="sm" />
          <span className="name">{l}</span>
          <span className="picker-mark">{on && Icon.check(14)}</span>
        </button>
      </li>
    );
  };
  return (
    <div className="picker">
      <div className="picker-box" onClick={() => input.current?.focus()}>
        {value.map((l) => (
          <span key={l} className="chip">
            <Avatar name={l} login={l} size="xs" />
            {l}
            <button type="button" className="chip-x" disabled={disabled} aria-label={`Remove ${l}`} onClick={(e) => { e.stopPropagation(); toggle(l); }}>{Icon.close()}</button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          aria-label={label}
          disabled={disabled}
          value={query}
          onChange={(e) => {
            const t = e.target.value;
            if (/[\s,]$/.test(t) && clean(t)) {
              const parts = t.split(/[\s,]+/).map(clean).filter(Boolean);
              const add = parts.filter((p, i) => !has(p) && !excluded(p) && parts.indexOf(p) === i);
              if (add.length) onChange([...value, ...add]);
              onQuery('');
            } else onQuery(t.replace(/^[\s,]+/, ''));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && commit()) e.preventDefault();
            else if (e.key === 'Backspace' && !query && value.length) onChange(value.slice(0, -1));
          }}
          placeholder={value.length ? '' : contacts.length ? 'Search contacts or type a username' : 'GitHub username'}
          autoComplete="off"
        />
      </div>
      {(shown.length > 0 || github.length > 0 || typed || searching) && (
        <ul className="picker-list" role="listbox" aria-label="People" aria-multiselectable="true">
          {q && shown.length > 0 && <li className="picker-head" role="presentation">Contacts</li>}
          {shown.map(item)}
          {q && (github.length > 0 || typed || searching) && <li className="picker-head" role="presentation">GitHub</li>}
          {github.map(item)}
          {typed && (
            <li role="option" aria-selected={false}>
              <button type="button" className="picker-item" disabled={disabled} onClick={() => toggle(typed)}>
                <Avatar name={typed} login={typed} size="sm" />
                <span className="name">Add <strong>{typed}</strong></span>
                <span className="picker-mark">{Icon.plus()}</span>
              </button>
            </li>
          )}
          {searching && <li className="picker-note" role="presentation">Searching GitHub…</li>}
        </ul>
      )}
    </div>
  );
}
