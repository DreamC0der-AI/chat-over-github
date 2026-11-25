// Sends that fail half way: keyhold saves each message encrypted before it goes out, so a retry
// posts the very same message. Nothing may arrive twice, and nothing the person typed is lost.
import { afterEach, describe, expect, it } from 'vitest';
import type { Group, ReceivedMessage } from 'keyhold/chat';
import { world, type Browser, type World } from './harness';

let w: World;
afterEach(() => w?.stop());

const mailPut = (login: string) => (r: { login?: string; method: string; url: string }) => r.login === login && r.method === 'PUT' && r.url.includes('/contents/mail/');
const count = async (b: Browser, who: string, text: string) => (await b.texts(b.chat(who))).filter((t) => t === text).length;

describe('sending', () => {
  it('a send whose reply was lost shows Not sent; it is never sent twice, by Retry or by the next sync', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    const g = alice.chat('bob')!.live!;

    // The post lands on GitHub, but the answer never comes back and the network drops.
    for (const body of ['first', 'second']) {
      void w.loseReply(mailPut('alice')).then(() => (w.offline = true));
      await alice.s.send(g, body);
      w.offline = false;
      const item = alice.s.sending.get(g.id)!.find((p) => p.body === body)!;
      expect(item.failed).toBeTruthy();
      expect(item.msgId).toBeTruthy();
    }
    // Retry the first: keyhold finds the copy that landed, posts nothing new.
    await alice.s.retrySend(g, alice.s.sending.get(g.id)!.find((p) => p.body === 'first')!.id);
    // The second is found by the next sync, and its bubble goes by itself.
    await alice.sync();
    expect(alice.s.sending.get(g.id)!.every((p) => p.sentId)).toBe(true);
    expect(g.unsent()).toEqual([]);
    await w.until(async () => (await count(bob, 'alice', 'second')) > 0, 'bob gets both');
    await w.rounds(2);
    for (const body of ['first', 'second']) {
      expect(await count(bob, 'alice', body)).toBe(1);
      expect(await count(alice, 'bob', body)).toBe(1);
    }
    await w.checkConverged();
  });

  it('a message that could not be posted is "Not sent" after a reload; Retry sends it once, Remove drops it', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    // GitHub refuses the post (it doesn't land): both messages stay saved, encrypted, in the chat state.
    w.fail(mailPut('alice'), 500, { times: 6 });
    await alice.s.send(alice.chat('bob')!.live!, 'keep me');
    await alice.s.send(alice.chat('bob')!.live!, 'drop me');

    const again = await w.reopen(alice);
    const g = again.chat('bob')!.live!;
    const shown = again.s.sending.get(g.id) ?? [];
    expect(shown.map((p) => [p.body, !!p.failed])).toEqual([['keep me', true], ['drop me', true]]);
    await again.s.retrySend(g, shown[0]!.id);
    again.s.discardSend(g.id, shown[1]!.id);
    await w.until(async () => (await count(bob, 'alice', 'keep me')) > 0, 'bob gets the retried message');
    await w.rounds(2);
    expect(await count(bob, 'alice', 'keep me')).toBe(1);
    expect(await count(bob, 'alice', 'drop me')).toBe(0);
    expect(g.unsent()).toEqual([]);
    // Reloading again brings back nothing.
    const third = await w.reopen(again);
    expect(third.s.sending.get(third.chat('bob')!.live!.id) ?? []).toEqual([]);
  });

  it('a message delivered twice is stored once: its reactions stay and it counts as unread once', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    for (const b of [alice, bob]) await b.setup();
    await w.dm(alice, bob);
    await alice.s.send(alice.chat('bob')!.live!, 'hi');
    await w.until(async () => !!(await bob.msg(bob.chat('alice'), 'hi')), 'bob gets it');
    const gb = bob.chat('alice')!.live!;
    const m = (await bob.msg(bob.chat('alice'), 'hi'))!;
    await bob.s.react(gb, m.id, '👍', true);
    await w.until(async () => !!(await bob.msg(bob.chat('alice'), 'hi'))?.reactions?.['👍'], 'the reaction is on');
    const unread = bob.chat('alice')!.unread;
    const again: ReceivedMessage = { message: { v: 1, id: m.id, ts: m.ts, t: 'text', body: 'hi' } as ReceivedMessage['message'], from: { fingerprint: m.fromFp, address: m.from, deviceId: m.fromDevice! }, epoch: 1n };
    await (bob.s as unknown as { onMessage(g: Group, m: ReceivedMessage): Promise<void> }).onMessage(gb, again);
    const after = (await bob.msg(bob.chat('alice'), 'hi'))!;
    expect(after.reactions?.['👍']).toEqual([bob.s.address]);
    expect(bob.chat('alice')!.unread).toBe(unread);
  });
});

describe('the chat on screen', () => {
  it('gets new messages while the rest of the sync step is stuck', async () => {
    w = await world();
    const [alice, bob] = [await w.browser('alice'), await w.browser('bob')];
    await alice.setup();
    await bob.setup();
    await w.dm(alice, bob);
    alice.s.setActive(alice.chat('bob')!.key);

    // A slow phone: a read of alice's synced store hangs, and with it the rest of her sync step.
    const held = w.hold((r) => r.login === 'alice' && r.url.includes('/chat-home/'));
    const step = alice.s.syncNow();
    await held.started;
    await bob.s.send(bob.chat('alice')!.live!, 'are you there?');
    // Not a sync step run by the test: the open chat's own lane, asked to check now.
    alice.s.checkOpenChatNow();
    const deadline = Date.now() + 5_000;
    while (!(await alice.texts(alice.chat('bob'))).includes('are you there?')) {
      if (Date.now() > deadline) throw new Error('the open chat waited for the stuck step');
      await new Promise((r) => setTimeout(r, 20));
    }
    held.release();
    await step;
    await w.checkConverged();
  });
});
