// Random membership walkthroughs: a seeded random chain of invite, accept, decline, remove, leave,
// re-invite, another browser, rename and picture, with messages between, checked after every step
// against the model in tests/walk.ts. A failure prints the seed and the steps so far; rerun one
// seed with WALK_SEED=<n>. Not part of the default run while the walks still find open bugs (see
// the bugs list in the PR that added them): run with `npm run test:walk -w web`, or more and
// longer walks with WALK_SEEDS=50 WALK_STEPS=60 npx vitest run tests/walk-random.test.ts
import { afterEach, describe, it } from 'vitest';
import { world, type World } from './harness';
import { cast, Walk } from './walk';

let w: World;
afterEach(() => w?.stop());

const env = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const STEPS = env('WALK_STEPS', 24);
const SEEDS = process.env.WALK_SEED ? [Number(process.env.WALK_SEED)] : Array.from({ length: env('WALK_SEEDS', 4) }, (_, i) => i + 1);
const PICS = ['data:image/webp;base64,UklGRhYAAABXRUJQVlA4TAoAAAAvAAAAAAfQ//73v/+BiOh/AAA=', 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP8='];

/** mulberry32: small, seedable, the same on every machine. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.runIf(process.env.WALK_SEEDS || process.env.WALK_SEED)('random group walkthroughs', () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${STEPS} steps`, async () => {
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      w = await world();
      const { people, codes } = await cast(w, ['alice', 'bob', 'carol', 'dave']);
      if (r() < 0.75) await w.rounds(3); // mostly with pre-keys published, sometimes without
      const walk = new Walk(w, people, 'alice', 'Walkers');
      walk.log.push(`seed ${seed}`);
      await walk.create(['bob', 'carol', 'dave'].filter(() => r() < 0.5));
      let renames = 0;
      const extra = new Set<string>();
      try {
        for (let i = 0; i < STEPS; i++) {
          const others = ['bob', 'carol', 'dave'];
          const moves: [number, () => Promise<unknown>][] = [];
          for (const p of others) {
            const s = walk.state.get(p)!;
            if (s === 'invited') {
              moves.push([3, () => walk.accept(p)], [1, () => walk.decline(p)]);
              // Someone added with a pre-key is in the group before accepting, so they can be removed.
              if (walk.listed(p)) moves.push([0.5, () => walk.remove(p)]);
            } else if (s === 'member') {
              moves.push([1, () => walk.remove(p)], [1, () => walk.leave(p)], [2, () => walk.send(p)]);
            } else if (s !== 'leaving') moves.push([1.5, () => walk.invite(p)]);
            if (s !== 'invited' && !extra.has(p)) moves.push([0.3, async () => {
              extra.add(p);
              await walk.newBrowser(p, codes.get(p)!);
            }]);
          }
          moves.push([3, () => walk.send('alice')], [0.3, () => walk.rename(`Walkers ${++renames}`)], [0.3, () => walk.setAvatar(pick(PICS))]);
          let x = r() * moves.reduce((n, [wt]) => n + wt, 0);
          const move = moves.find(([wt]) => (x -= wt) < 0)?.[1] ?? moves.at(-1)![1];
          await move();
          await walk.check();
        }
      } catch (e) {
        // Steps that throw (not a check) also get the walk so far.
        if (!(e as Error).message.startsWith('walkthrough went wrong')) (e as Error).message = `${(e as Error).message}\n\nafter:\n  ${walk.log.join('\n  ')}`;
        throw e;
      }
    });
  }
});
