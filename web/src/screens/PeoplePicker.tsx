import { useMemo, useRef, useState } from 'react';
import { type Session } from '../lib/session';
import { Avatar, Icon } from '../ui';

const clean = (s: string) => s.trim().replace(/^@/, '').toLowerCase();

/**
 * Pick people from your contacts (search, tap to toggle), or type a GitHub username of
 * someone who isn't a contact yet and press Enter. `value` holds the picked logins.
 */
export function PeoplePicker({ session, id, label, value, onChange, query, onQuery }: {
  session: Session;
  id: string;
  label: string;
  value: string[];
  onChange: (logins: string[]) => void;
  query: string;
  onQuery: (q: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const v = session.getVersion();
  const contacts = useMemo(() => session.people().filter((p) => !p.blocked).map((p) => p.login), [v]);
  const q = clean(query);
  const has = (l: string) => value.some((x) => x.toLowerCase() === l.toLowerCase());
  const shown = contacts.filter((l) => !q || l.toLowerCase().includes(q));
  const typed = q && /^[a-z0-9][a-z0-9-]{0,38}$/.test(q) && !contacts.some((l) => l.toLowerCase() === q) && !has(q) ? q : '';
  const toggle = (l: string) => {
    onChange(has(l) ? value.filter((x) => x.toLowerCase() !== l.toLowerCase()) : [...value, l]);
    onQuery('');
    input.current?.focus();
  };
  const commit = () => {
    if (!q) return false;
    const exact = contacts.find((l) => l.toLowerCase() === q);
    const pick = exact ?? (shown.length === 1 && !typed ? shown[0] : q);
    if (!has(pick)) onChange([...value, pick]);
    onQuery('');
    return true;
  };
  return (
    <div className="picker">
      <div className="picker-box" onClick={() => input.current?.focus()}>
        {value.map((l) => (
          <span key={l} className="chip">
            <Avatar name={l} login={l} size="xs" />
            {l}
            <button type="button" className="chip-x" aria-label={`Remove ${l}`} onClick={(e) => { e.stopPropagation(); toggle(l); }}>{Icon.close()}</button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          aria-label={label}
          value={query}
          onChange={(e) => {
            const t = e.target.value;
            if (/[\s,]$/.test(t) && clean(t)) {
              const parts = t.split(/[\s,]+/).map(clean).filter(Boolean);
              const add = parts.filter((p, i) => !has(p) && parts.indexOf(p) === i);
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
      {(shown.length > 0 || typed) && (
        <ul className="picker-list" role="listbox" aria-label="Contacts" aria-multiselectable="true">
          {typed && (
            <li role="option" aria-selected={false}>
              <button type="button" className="picker-item" onClick={() => toggle(typed)}>
                <Avatar name={typed} login={typed} size="sm" />
                <span className="name">Add <strong>{typed}</strong></span>
                <span className="picker-mark">{Icon.plus()}</span>
              </button>
            </li>
          )}
          {shown.map((l) => {
            const on = has(l);
            return (
              <li key={l} role="option" aria-selected={on}>
                <button type="button" className={`picker-item${on ? ' on' : ''}`} onClick={() => toggle(l)}>
                  <Avatar name={l} login={l} size="sm" />
                  <span className="name">{l}</span>
                  <span className="picker-mark">{on && Icon.check(14)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
