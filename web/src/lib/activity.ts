/**
 * Progress for slow actions. Everything the app does goes through GitHub, so most actions take
 * seconds. An activity is one action the user started (create a group, accept an invitation,
 * close a chat...) as a list of steps: done, running, still to come. The step that runs shows
 * what is on its way to GitHub right now ("Sending the GitHub invitation"), taken from the
 * storage calls themselves (see `instrument`), so every action gets that detail for free.
 */
import type { StorageProvider } from 'keyhold/storage';

export type StepState = 'todo' | 'active' | 'done' | 'failed' | 'waiting';

export interface Step {
  label: string;
  state: StepState;
  start?: number;
  end?: number;
  /** A storage call (box.method) that starts this step when it runs, for steps inside Keyhold. */
  when?: string;
  error?: string;
}

/** A planned step: its label, or the label and the storage call that starts it. */
export type PlanStep = string | { label: string; when?: string };

export interface Activity {
  id: number;
  title: string;
  /** What it is about (a chat or invitation key), so a row in the list can show its progress. */
  key?: string;
  steps: Step[];
  started: number;
  ended?: number;
  /** What is going to GitHub right now. */
  detail?: string;
  error?: string;
  /** It stopped to wait for someone else (e.g. the inviter's app): what it waits for. */
  waiting?: string;
  /** Repos whose storage calls count as this activity's. */
  spaces: Set<string>;
  /** Also count calls that name no repo (lookups, new repos, invitations). */
  anyCall: boolean;
  /** Also count the background syncing of the account's own data (off unless it is the point). */
  background: boolean;
  /** Where to go when it's done (shown as Open in the tray). */
  link?: string;
  /**
   * Shown in the progress popup, which blocks the app until it ends. Off for work the app starts
   * by itself, and for an activity started inside another one (blocking closing a chat).
   */
  modal: boolean;
}

export interface Tracker {
  readonly activity: Activity;
  /** Finish the running step and start this one (planned or new). */
  step(label: string): void;
  /** The running step failed, but the activity goes on. */
  stepFailed(error: string): void;
  /** Drop planned steps that turned out not to be needed. */
  skip(label: string): void;
  detail(text: string | undefined): void;
  space(space: string | undefined): void;
  link(path: string): void;
  /** End without finishing: the rest waits for someone else. */
  wait(text: string): void;
}

/** A finished popup shows its tick this long; a failed or waiting one stays until closed. */
const KEEP_DONE_MS = 1200;

export class Activities {
  private seq = 0;
  list: Activity[] = [];
  constructor(private readonly changed: () => void) {}

  /** Running and recently finished activities. */
  all(): Activity[] {
    return this.list;
  }

  running(): Activity[] {
    return this.list.filter((a) => !a.ended);
  }

  /** The newest activity about this key. */
  forKey(key: string): Activity | undefined {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.key === key) return this.list[i];
    return undefined;
  }

  /** Move on a running activity about this key, from code that doesn't hold its tracker. */
  stepFor(key: string, label: string, space?: string) {
    const a = this.forKey(key);
    if (!a || a.ended) return;
    if (space) a.spaces.add(space.toLowerCase());
    this.advance(a, label);
  }

  /** The thing an activity is about got a new key (an accepted notice became its repo). */
  rekey(from: string, to: string) {
    for (const a of this.list) if (a.key === from) a.key = to;
  }

  dismiss(id: number) {
    this.list = this.list.filter((a) => a.id !== id);
    this.changed();
  }

  async run<T>(
    title: string,
    plan: PlanStep[],
    fn: (t: Tracker) => Promise<T>,
    opts: { key?: string; anyCall?: boolean; background?: boolean; space?: string; modal?: boolean; onStart?: (a: Activity) => void } = {},
  ): Promise<T> {
    const a: Activity = {
      id: ++this.seq,
      title,
      key: opts.key,
      steps: plan.map((p) => (typeof p === 'string' ? { label: p, state: 'todo' } : { label: p.label, when: p.when, state: 'todo' })),
      started: Date.now(),
      spaces: new Set(opts.space ? [opts.space] : []),
      anyCall: opts.anyCall ?? true,
      background: opts.background ?? false,
      // The popup blocks the app, so a modal activity starting while another runs is part of it.
      modal: (opts.modal ?? true) && !this.list.some((x) => x.modal && !x.ended),
    };
    this.list = [...this.list.filter((x) => !(opts.key && x.key === opts.key && x.ended)), a];
    const t = this.tracker(a);
    // The first planned step starts at once, unless a storage call starts it.
    if (a.steps[0] && !a.steps[0].when) t.step(a.steps[0].label);
    opts.onStart?.(a);
    this.changed();
    try {
      const out = await fn(t);
      this.finish(a);
      return out;
    } catch (e) {
      this.finish(a, e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  private tracker(a: Activity): Tracker {
    const self = this;
    return {
      activity: a,
      step(label) {
        self.advance(a, label);
      },
      stepFailed(error) {
        const s = a.steps.find((x) => x.state === 'active');
        if (s) Object.assign(s, { state: 'failed', end: Date.now(), error });
        a.detail = undefined;
        self.changed();
      },
      skip(label) {
        a.steps = a.steps.filter((s) => !(s.label === label && s.state === 'todo'));
        self.changed();
      },
      detail(text) {
        a.detail = text;
        self.changed();
      },
      space(space) {
        if (space) a.spaces.add(space.toLowerCase());
      },
      link(path) {
        a.link = path;
      },
      wait(text) {
        a.waiting = text;
      },
    };
  }

  private advance(a: Activity, label: string) {
    if (a.ended) return;
    const now = Date.now();
    const cur = a.steps.findIndex((s) => s.state === 'active');
    if (cur >= 0 && a.steps[cur]!.label === label) return;
    if (cur >= 0) Object.assign(a.steps[cur]!, { state: 'done', end: now });
    const planned = a.steps.find((s) => s.label === label && s.state === 'todo');
    if (planned) {
      // Steps planned before this one that never ran weren't needed.
      const i = a.steps.indexOf(planned);
      a.steps = a.steps.filter((s, j) => j >= i || s.state !== 'todo');
      Object.assign(planned, { state: 'active', start: now });
    } else {
      const at = cur >= 0 ? cur + 1 : a.steps.filter((s) => s.state !== 'todo').length;
      a.steps.splice(at, 0, { label, state: 'active', start: now });
    }
    a.detail = undefined;
    this.changed();
  }

  private finish(a: Activity, error?: string) {
    const now = Date.now();
    a.ended = now;
    a.detail = undefined;
    for (const s of a.steps) {
      if (s.state === 'active') Object.assign(s, { state: error ? 'failed' : a.waiting ? 'waiting' : 'done', end: now, error: s.error ?? error });
    }
    if (a.waiting && !error) a.steps = a.steps.filter((s) => s.state !== 'todo');
    a.steps = a.steps.filter((s) => s.state !== 'todo' || !!error);
    a.error = error;
    this.changed();
    // Failed or waiting popups stay until closed; anything else goes once its tick has shown.
    const someFailed = a.steps.some((s) => s.state === 'failed');
    if (!a.modal || (!error && !a.waiting && !someFailed)) {
      setTimeout(() => {
        if (this.list.includes(a)) this.dismiss(a.id);
      }, a.modal ? KEEP_DONE_MS : 0);
    }
  }

  /** A storage call is about to go out: show it on the activities it belongs to. */
  call(op: string, label: string | undefined, space: string | undefined) {
    let any = false;
    for (const a of this.list) {
      if (a.ended) continue;
      const mine = space ? a.spaces.has(space.toLowerCase()) : BACKGROUND.has(op) ? a.background : a.anyCall;
      if (!mine) continue;
      const starts = a.steps.find((s) => s.state === 'todo' && s.when === op);
      if (starts) {
        this.advance(a, starts.label);
        any = true;
      }
      if (label) {
        a.detail = label;
        any = true;
      }
    }
    if (any) this.changed();
  }

  /** A new repo was made: it belongs to the activities that were waiting for one. */
  created(space: string) {
    for (const a of this.list) if (!a.ended && a.anyCall && a.spaces.size === 0) a.spaces.add(space.toLowerCase());
  }
}

const who = (address: unknown) => (typeof address === 'string' ? `@${address.replace(/^[a-z]+:/, '')}` : 'them');

/**
 * What each storage call means to a person. Calls left out (reads during sync, key storage on
 * this device) change nothing on screen. The first argument of the space-scoped boxes is the repo.
 */
const LABELS: Record<string, (args: unknown[]) => string | undefined> = {
  'channel.createSpace': () => 'Creating a private repo on GitHub',
  'channel.grant': (a) => `Sending the GitHub invitation to ${who(a[1])}`,
  'channel.acceptGrant': () => 'Accepting the GitHub invitation',
  'channel.revoke': (a) => `Removing ${who(a[1])}'s access on GitHub`,
  'channel.members': () => 'Checking who has access',
  'inviteInbox.send': (a) => `Letting ${who(a[0])}'s app know`,
  'inviteInbox.delete': () => 'Clearing the invitation',
  'directory.read': (a) => `Looking up ${who(a[0])}'s identity`,
  'directory.append': () => 'Publishing your identity',
  'preKeys.read': (a) => `Fetching ${who(a[0])}'s device keys`,
  'preKeys.publish': () => 'Publishing this device’s keys',
  'orderedLog.read': () => 'Reading the chat’s encryption state',
  'orderedLog.append': () => 'Saving an encryption change',
  'mailbox.post': () => 'Writing an encrypted message',
  'mailbox.postMany': () => 'Writing encrypted messages',
  'mailbox.list': () => 'Reading new messages',
  'dropBox.put': () => 'Leaving encrypted keys for the invitee',
  'dropBox.list': () => 'Looking for keys left for you',
  'dropBox.delete': () => 'Tidying up used keys',
  'blobs.put': () => 'Uploading the encrypted file',
  'blobs.get': () => 'Downloading the encrypted file',
  'vault.put': () => 'Saving your encrypted backup',
  'vault.get': () => 'Reading your encrypted backup',
  'personal.put': () => 'Syncing with your other browsers',
  'personal.delete': () => 'Syncing with your other browsers',
};

/** Calls the sync loop makes by itself all the time; they belong to an activity only when it asks. */
const BACKGROUND = new Set(['personal.put', 'personal.delete', 'preKeys.publish']);

const BOXES = new Set(['channel', 'inviteInbox', 'directory', 'preKeys', 'orderedLog', 'mailbox', 'dropBox', 'blobs', 'vault', 'personal']);

/** Space-scoped boxes: their first argument names the repo. */
const SPACED = new Set(['orderedLog', 'mailbox', 'blobs', 'dropBox']);
const SPACED_CHANNEL = new Set(['grant', 'revoke', 'members']);

/** The provider, reporting each storage call to the activities before it goes out. */
export function instrument(p: StorageProvider, acts: Activities): StorageProvider {
  const wrapped = new Map<string, unknown>();
  return new Proxy(p, {
    get(target, prop, recv) {
      const box = Reflect.get(target, prop, recv) as unknown;
      if (typeof prop !== 'string' || !box || typeof box !== 'object' || !BOXES.has(prop)) return box;
      if (wrapped.has(prop)) return wrapped.get(prop);
      const w = new Proxy(box as Record<string, unknown>, {
        get(b, m, r) {
          const v = Reflect.get(b, m, r);
          if (typeof m !== 'string' || typeof v !== 'function') return v;
          const op = `${prop}.${m}`;
          return (...args: unknown[]) => {
            const space = SPACED.has(prop) || (prop === 'channel' && SPACED_CHANNEL.has(m)) ? (args[0] as string) : undefined;
            acts.call(op, LABELS[op]?.(args), space);
            const out = (v as (...a: unknown[]) => unknown).apply(b, args);
            if (op === 'channel.createSpace' && out instanceof Promise) {
              return out.then((s: unknown) => {
                if (typeof s === 'string') acts.created(s);
                return s;
              });
            }
            return out;
          };
        },
      });
      wrapped.set(prop, w);
      return w;
    },
  });
}
