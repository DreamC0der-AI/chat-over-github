/**
 * Membership walkthroughs: a model of who should be in a group, and checks after every step that
 * the app agrees. A walkthrough is a chain of steps (invite, accept, decline, remove, leave,
 * re-invite, a second browser, a rename, a picture...) with messages sent between them. After
 * each step, `check()` asserts, on every browser of every person:
 *
 *  - members read every message sent while they were in the group, and invitees read what was
 *    sent while their invitation was open once they accept it (if they were added with a
 *    pre-key: without one, nothing from before the join can reach them);
 *  - nobody reads a message sent while they were out (never invited, declined, removed, left),
 *    not even after a later invitation;
 *  - the member list each member's browser shows matches the model, and the chat is live for
 *    members and not for anyone else;
 *  - the group's name and picture reach every member's browsers;
 *  - removals read as removals and leaves as leaves;
 *  - after a key reset, the new key reads nothing from before it was invited back.
 *
 * The same chain runs against the in-memory GitHub (web/tests, every change) and real GitHub
 * (web/tools/live-walk.ts on a computer with the test accounts' sign-ins).
 */
import type { Browser, World } from './harness';

/**
 * leaving: they quit, and the admin's app hasn't committed it yet. A message sent then still goes
 * to a group they are cryptographically in, so whether they read it isn't checked.
 */
export type State = 'out' | 'invited' | 'member' | 'declined' | 'removed' | 'leaving' | 'left' | 'reset';

interface Sent {
  text: string;
  from: string;
  /** People who must read it (on browsers that existed when it went out). */
  must: Set<string>;
  /** Invitees when it went out: they must read it if they accept that invitation. */
  ifAccepts: Map<string, number>;
  /** People who must never read it. */
  never: Set<string>;
  /** Of those, the ones who had declined. */
  declined: Set<string>;
  at: number;
}

export class Walk {
  readonly state = new Map<string, State>();
  /** Each person's current invitation number, so an accept only unlocks what its own window saw. */
  private invitation = new Map<string, number>();
  readonly sent: Sent[] = [];
  /** What happened, step by step, for the failure message. */
  readonly log: string[] = [];
  private n = 0;
  /**
   * Set to true to not report someone who declined and later accepted reading what was sent in
   * between (the bug fixed in #56). Kept for checking an older build.
   */
  static declinedMayRead = false;
  name: string;
  avatar?: string;
  /** The group's id, once made. */
  id?: string;
  /** Messages a browser may lack: it was taken out before it synced them ("login|browser|text"). */
  private excused = new Set<string>();

  constructor(
    readonly w: World,
    /** Each person's browsers; the first is the one that acts. */
    readonly people: Map<string, Browser[]>,
    readonly admin: string,
    name: string,
  ) {
    this.name = name;
    for (const p of people.keys()) this.state.set(p, p === admin ? 'member' : 'out');
  }

  b(login: string) {
    return this.people.get(login)![0]!;
  }
  /** This browser's entry for the group (by its id, so a rename it hasn't seen yet doesn't matter). */
  chatOf(b: Browser) {
    return this.id ? b.chats().find((c) => c.rooms.some((r) => r.groupId === this.id)) : b.chat(this.name);
  }
  private group(login: string) {
    const g = this.chatOf(this.b(login))?.live;
    if (!g) throw new Error(`${login} has no live "${this.name}"`);
    return g;
  }
  members() {
    return [...this.state].filter(([, s]) => s === 'member').map(([p]) => p);
  }
  invitees() {
    return [...this.state].filter(([, s]) => s === 'invited').map(([p]) => p);
  }
  private note(s: string) {
    this.log.push(s);
  }

  // ---- steps ----

  /** The admin makes the group, inviting these people at once (none: a group of one). */
  async create(invite: string[] = []) {
    this.note(`${this.admin} creates "${this.name}"${invite.length ? ` inviting ${invite.join(', ')}` : ' alone'}`);
    const { failed } = await this.b(this.admin).s.createGroup(this.name, invite, undefined, this.avatar);
    if (failed.length) throw new Error(`invitations failed: ${failed.join('; ')}`);
    for (const p of invite) this.invited(p);
    await this.w.until(() => !!this.b(this.admin).chat(this.name)?.live, 'the group is made');
    this.id = this.b(this.admin).chat(this.name)!.live!.id;
  }

  private invited(p: string) {
    if (this.state.get(p) === 'member') throw new Error(`${p} is already a member`);
    this.state.set(p, 'invited');
    this.invitation.set(p, (this.invitation.get(p) ?? 0) + 1);
  }

  async invite(...who: string[]) {
    this.note(`${this.admin} invites ${who.join(', ')}`);
    await this.b(this.admin).s.invite(this.group(this.admin), who);
    for (const p of who) this.invited(p);
  }

  /** Wait until the invitation shows on this browser (default: the person's first). */
  async seesInvitation(p: string, b = this.b(p)) {
    await this.w.until(() => !!b.inviteFrom(this.admin), `${p} sees the invitation from ${this.admin}`, 30);
  }

  async accept(p: string) {
    this.note(`${p} accepts`);
    await this.seesInvitation(p);
    await this.b(p).s.acceptInvite(this.b(p).inviteFrom(this.admin)!.key);
    this.state.set(p, 'member');
    const n = this.invitation.get(p);
    for (const m of this.sent) if (m.ifAccepts.get(p) === n) m.must.add(p);
    await this.w.until(() => !!this.chatOf(this.b(p))?.live, `${p} joined`, 30);
  }

  async decline(p: string) {
    this.note(`${p} declines`);
    await this.seesInvitation(p);
    await this.b(p).s.declineInvite(this.b(p).inviteFrom(this.admin)!.key);
    this.state.set(p, 'declined');
  }

  /** Taken out now: what their browsers hadn't fetched yet they can't any more. */
  private async excuse(p: string) {
    for (const b of this.browsersOf(p)) {
      const have = new Set(await b.texts(this.chatOf(b)));
      for (const m of this.sent) if (m.must.has(p) && !have.has(m.text)) this.excused.add(`${p}|${this.idx(b)}|${m.text}`);
    }
  }

  async remove(p: string) {
    this.note(`${this.admin} removes ${p}`);
    await this.excuse(p);
    const g = this.group(this.admin);
    const m = g.members().find((x) => x.address === `github:${p}`);
    if (!m) throw new Error(`${p} is not in ${this.admin}'s member list`);
    await this.b(this.admin).s.removeMember(g, m.fingerprint);
    const was = this.state.get(p);
    this.state.set(p, 'removed');
    void was;
  }

  async leave(p: string) {
    this.note(`${p} leaves`);
    await this.excuse(p);
    await this.b(p).s.quitChat(this.group(p));
    this.state.set(p, 'leaving');
  }

  /**
   * They lost their recovery code and reset their key on their first browser. Their browsers of
   * the old key are done (the others say so); the new key starts with one fresh browser and is
   * out of the group until someone invites it back. Everyone's directory check is made due.
   */
  async resetKey(p: string) {
    this.note(`${p} resets their key`);
    const old = this.people.get(p)!;
    const fresh = await old[0]!.resetKey(this.w);
    for (const b of old) b.since = Infinity;
    this.people.set(p, [fresh]);
    this.state.set(p, 'reset');
    for (const b of this.w.browsers()) b.recheckKeys();
    await this.w.until(() => !this.listed(p), `${this.admin}'s app took ${p}'s old key out`, 30);
    return { fresh, old };
  }

  /** The admin lets the new key of someone who reset back in (Invite again). */
  async inviteBack(p: string) {
    this.note(`${this.admin} invites ${p} back`);
    await this.b(this.admin).s.inviteBack(this.chatOf(this.b(this.admin))!, `github:${p}`);
    this.invited(p);
  }

  /** Another browser for this person, restored from the recovery code. */
  async newBrowser(p: string, code: string) {
    this.note(`${p} opens another browser`);
    const b = await this.w.browser(p);
    await b.restore(code);
    this.people.get(p)!.push(b);
    return b;
  }

  async send(from: string, text = `m${++this.n} from ${from}`) {
    this.note(`${from} sends "${text}"`);
    const must = new Set<string>();
    const never = new Set<string>();
    const declined = new Set([...this.state].filter(([, x]) => x === 'declined').map(([p]) => p));
    const ifAccepts = new Map<string, number>();
    this.settleLeaves();
    // An invitee is owed what goes out while they are in the sender's group (added with a pre-key).
    // Without a pre-key (none published yet) they join only on accept, and MLS has no history from
    // before a join, so what went out before that is not theirs to read (nor forbidden).
    const g = this.group(from);
    const inTree = new Set(g.members().map((m) => m.address.replace('github:', '')));
    for (const [p, s] of this.state) {
      if (s === 'leaving') continue;
      if (s === 'member') must.add(p);
      else if (s === 'invited') {
        if (inTree.has(p)) ifAccepts.set(p, this.invitation.get(p)!);
      } else never.add(p);
    }
    const at = Date.now();
    await this.b(from).s.send(g, text);
    this.sent.push({ text, from, must, never, declined, ifAccepts, at });
    return text;
  }

  async rename(name: string) {
    this.note(`${this.admin} renames the group to "${name}"`);
    await this.b(this.admin).s.rename(this.group(this.admin), name);
    this.name = name;
  }

  async setAvatar(pic: string) {
    this.note(`${this.admin} sets a group picture`);
    await this.b(this.admin).s.setAvatar(this.group(this.admin), pic);
    this.avatar = pic;
  }

  /** A leave counts once the admin's app no longer lists them. */
  private settleLeaves() {
    const listed = new Set(this.chatOf(this.b(this.admin))?.live?.members().map((m) => m.address.replace('github:', '')) ?? []);
    for (const [p, s] of this.state) if (s === 'leaving' && !listed.has(p)) this.state.set(p, 'left');
  }

  /** Is this person in the admin's member list (joined, or added with a pre-key)? */
  listed(p: string) {
    return !!this.chatOf(this.b(this.admin))?.live?.members().some((m) => m.address === `github:${p}`);
  }

  // ---- checks ----

  private browsersOf(p: string) {
    return this.people.get(p)!.filter((b) => b.since !== Infinity);
  }

  /** Every text this browser shows, in any chat (a leak may land in a chat of another name). */
  private async allTexts(b: Browser) {
    const out = new Set<string>();
    for (const c of b.chats()) for (const t of await b.texts(c)) out.add(t);
    return out;
  }

  private async missing() {
    const gaps: string[] = [];
    for (const [p] of this.people) {
      const state = this.state.get(p)!;
      for (const b of this.browsersOf(p)) {
        const c = this.chatOf(b);
        if (state === 'member') {
          if (!c?.live) {
            gaps.push(`${p} (${this.idx(b)}) has no live "${this.name}"`);
            continue;
          }
          const texts = new Set(await b.texts(c));
          for (const m of this.sent) if (m.must.has(p) && b.since <= m.at && !texts.has(m.text) && !this.excused.has(`${p}|${this.idx(b)}|${m.text}`)) gaps.push(`${p} (${this.idx(b)}) never got "${m.text}"`);
          const shown = new Set(c.live.members().filter((x) => !x.pending).map((x) => x.address.replace('github:', '')));
          const want = new Set(this.members());
          if ([...want].some((x) => !shown.has(x)) || [...shown].some((x) => !want.has(x))) gaps.push(`${p} (${this.idx(b)}) lists members [${[...shown].sort()}], expected [${[...want].sort()}]`);
          if (c.title !== this.name) gaps.push(`${p} (${this.idx(b)}) calls the group "${c.title}", expected "${this.name}"`);
          if (this.avatar !== undefined && (c.avatar ?? '') !== this.avatar) gaps.push(`${p} (${this.idx(b)}) doesn't show the group picture`);
        } else if (c?.live && state !== 'invited') {
          gaps.push(`${p} (${this.idx(b)}) is ${state} but "${this.name}" is still live there`);
        }
      }
    }
    return gaps;
  }

  private idx(b: Browser) {
    return `browser ${this.people.get(b.login)!.indexOf(b) + 1}`;
  }

  private async leaks() {
    const out: string[] = [];
    for (const [p] of this.people) {
      for (const b of this.browsersOf(p)) {
        const texts = await this.allTexts(b);
        for (const m of this.sent) if (m.never.has(p) && texts.has(m.text) && !(Walk.declinedMayRead && m.declined.has(p))) out.push(`${p} (${this.idx(b)}) can read "${m.text}", sent while they were out of the group`);
      }
    }
    return out;
  }

  /**
   * Sync until every browser shows what the model expects, then a few more rounds to see that
   * nothing that must not happen does. Throws with the walk so far and what differs.
   */
  async check(rounds = 30) {
    let gaps: string[] = [];
    for (let i = 0; i < rounds; i++) {
      this.settleLeaves();
      gaps = await this.missing();
      if (!gaps.length) break;
      await this.w.rounds(1);
    }
    if (!gaps.length) {
      await this.w.rounds(2);
      this.settleLeaves();
      gaps = await this.missing();
    }
    gaps.push(...(await this.leaks()));
    for (const b of this.w.browsers()) {
      if (b.since === Infinity) continue;
      for (const c of b.chats()) if ((await b.notes(c)).some((n) => n.includes('could not be decrypted'))) gaps.push(`${b.login} (${this.idx(b)}): "could not be decrypted" in ${c.title}`);
    }
    for (const b of this.w.browsers()) for (const [id, e] of b.s.groupErrors) gaps.push(`${b.login} (${this.idx(b)}): chat ${id.slice(0, 8)} shows an error: ${e}`);
    if (gaps.length) throw new Error(`walkthrough went wrong after:\n  ${this.log.join('\n  ')}\n\nwhat differs:\n  ${gaps.join('\n  ')}`);
  }

  /** The chat's system lines on this person's first browser. */
  notes(p: string) {
    return this.b(p).notes(this.chatOf(this.b(p)));
  }
}

/** People set up, each with one browser; returns their recovery codes too. */
export async function cast(w: World, logins: string[]) {
  const people = new Map<string, Browser[]>();
  const codes = new Map<string, string>();
  for (const l of logins) {
    const b = await w.browser(l);
    codes.set(l, await b.setup());
    people.set(l, [b]);
  }
  return { people, codes };
}
