// Slow actions show their steps as they happen, and invitation cards say what the invitation is.
import { afterEach, describe, expect, it } from 'vitest';
import { world, type World } from './harness';
import type { Activity } from '../src/lib/activity';

let w: World;
afterEach(() => w?.stop());

const preKeys = (login: string) =>
  w.requests.filter((r) => r.method === 'PUT' && r.url.includes(`/repos/${login}/keyhold-id/contents/prekeys/`)).length;

/** Every step label an activity ever showed as running, and every detail line, in order. */
function watch(a: () => Activity | undefined, subscribe: (fn: () => void) => void) {
  const steps: string[] = [];
  const details: string[] = [];
  subscribe(() => {
    const x = a();
    if (!x) return;
    const s = x.steps.find((s) => s.state === 'active')?.label;
    if (s && steps[steps.length - 1] !== s) steps.push(s);
    if (x.detail && details[details.length - 1] !== x.detail) details.push(x.detail);
  });
  return { steps, details };
}

describe('progress and invitation details', () => {
  it('creating a group runs its steps in order, with what goes to GitHub; invitees see a group with its name', async () => {
    w = await world();
    const [alice, bob, carol] = [await w.browser('alice'), await w.browser('bob'), await w.browser('carol')];
    for (const b of [alice, bob, carol]) await b.setup();
    await w.until(() => preKeys('bob') === 1 && preKeys('carol') === 1, 'pre-keys published');

    let act: Activity | undefined;
    const seen = watch(() => act, (fn) => alice.s.subscribe(fn));
    const done = alice.s.createGroup('Weekend hikers', ['bob', 'carol'], (a) => (act = a));
    expect(act?.title).toBe('Creating Weekend hikers');
    expect(act?.steps.map((s) => s.label)).toEqual(['Checking usernames', 'Creating a private repo', 'Setting up encryption', 'Inviting @bob and @carol']);
    await done;
    expect(seen.steps).toEqual(['Checking usernames', 'Creating a private repo', 'Setting up encryption', 'Inviting @bob and @carol']);
    expect(seen.details).toEqual(expect.arrayContaining(['Creating a private repo on GitHub', 'Saving an encryption change', 'Sending the GitHub invitation to @bob', "Letting @carol's app know"]));
    expect(act!.ended).toBeDefined();
    expect(act!.steps.every((s) => s.state === 'done')).toBe(true);
    expect(act!.link).toMatch(/^\/c\//);

    await w.until(() => !!bob.inviteFrom('alice')?.details, 'bob reads the invitation note');
    expect(bob.inviteFrom('alice')!.details).toEqual({ kind: 'group', name: 'Weekend hikers', people: 1 });
    // The Worker holds only ciphertext.
    const stored = [...w.backend.gh.inbox.values()].flat();
    expect(stored.length).toBe(2);
    for (const e of stored) {
      expect(e.note).toBeTruthy();
      expect(atob(e.note!)).not.toContain('Weekend');
    }

    // Accepting is tracked too, step by step, and ends with the chat open.
    const inv = bob.inviteFrom('alice')!;
    // From the moment the chat appears it has its name, before any admin repeats it in a message.
    const titles = new Set<string>();
    bob.s.subscribe(() => { for (const c of bob.chats()) titles.add(c.title); });
    let joining: Activity | undefined;
    const joinSeen = watch(() => (joining ??= bob.s.activities.all().find((a) => a.title === 'Joining Weekend hikers')), (fn) => bob.s.subscribe(fn));
    await bob.s.acceptInvite(inv.key);
    expect(joinSeen.steps).toEqual(['Accepting the GitHub invitation', 'Finding the chat', 'Unlocking the encryption', 'Loading messages']);
    expect(joining!.error).toBeUndefined();
    expect(bob.chat('Weekend hikers')?.live).toBeTruthy();
    expect([...titles]).toEqual(['Weekend hikers']);
  });

  it('a DM invitation says it is a direct chat; a failed step shows where it stopped', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.until(() => preKeys('bob') === 1, 'pre-key published');
    await alice.s.startDm('bob');
    await w.until(() => !!bob.inviteFrom('alice')?.details, 'bob reads the note');
    expect(bob.inviteFrom('alice')!.details).toEqual({ kind: 'dm' });

    // The popup shows one action at a time: closing the chat inside Block is part of Block.
    const modal = new Set<string>();
    const all = new Set<string>();
    const before = new Set(alice.s.activities.all().map((a) => a.id));
    alice.s.subscribe(() => {
      for (const a of alice.s.activities.all().filter((a) => !before.has(a.id))) {
        all.add(a.title);
        if (a.modal) modal.add(a.title);
      }
    });
    await alice.s.block('github:bob');
    expect([...all]).toEqual(expect.arrayContaining(['Blocking @bob', 'Closing the chat']));
    expect([...modal]).toEqual(['Blocking @bob']);

    let act: Activity | undefined;
    await expect(alice.s.createGroup('Nope', ['no-such-user-x'], (a) => (act = a))).rejects.toThrow('No GitHub user named no-such-user-x');
    expect(act!.error).toContain('No GitHub user');
    expect(act!.steps.find((s) => s.state === 'failed')?.label).toBe('Checking usernames');
  });
});
