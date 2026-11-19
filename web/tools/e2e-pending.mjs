// Pending states: with GitHub writes slowed down (or failing), every action shows at once.
//   node tools/mock-server.mjs 8787 &   then   node tools/e2e-pending.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://localhost:8787/';
const SHOTS = process.env.SHOTS ?? '/tmp/e2e';
const browser = await chromium.launch();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (c, m) => { if (!c) { failures++; log('FAIL', m); } else log('ok  ', m); };

async function person(login) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { window.__autoConfirm = true; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(login, 'PAGEERROR', e.message));
  await page.goto(BASE);
  await page.getByLabel('Test account').fill(login);
  await page.getByRole('button', { name: /Sign in/ }).click();
  await page.getByRole('button', { name: 'Create identity' }).click();
  const code = await page.locator('.code-box').innerText({ timeout: 30000 });
  await page.getByLabel(/Type the last block/).fill(code.split('-').pop());
  await page.getByRole('button', { name: 'Continue to chats' }).click();
  await page.getByRole('heading', { name: /Pick a chat/ }).waitFor();
  return { ctx, page, login };
}
/** Slow down (or fail) this person's writes to GitHub. */
async function writes(p, mode) {
  await p.page.unroute('**/gh/**').catch(() => {});
  if (mode === 'normal') return;
  await p.page.route('**/gh/**', async (route) => {
    if (route.request().method() === 'GET') return route.continue().catch(() => {});
    if (mode === 'fail') return route.fulfill({ status: 503, body: '{"message":"Service unavailable"}', contentType: 'application/json' });
    await new Promise((r) => setTimeout(r, 1200));
    return route.continue().catch(() => {});
  });
}
// Run the app's sync step now instead of waiting for its timers (see window.__chat in session.ts).
const syncRounds = async (p, n = 2) => { for (let i = 0; i < n; i++) await p.page.evaluate(() => window.__chat?.syncNow()); };
const msg = (p, text) => p.page.locator('.msg', { hasText: text }).first();
async function quickReact(p, text, emoji) {
  await msg(p, text).locator('.bubble').click({ button: 'right' });
  await p.page.getByRole('menuitemcheckbox', { name: `React ${emoji}` }).click();
}
async function send(p, text) {
  await p.page.locator('#composer').fill(text);
  await p.page.locator('#composer').press('Enter');
}

try {
  const alice = await person('alice');
  const bob = await person('bob');
  await alice.page.getByRole('button', { name: 'New chat' }).first().click();
  await alice.page.getByLabel('GitHub username').fill('bob');
  await alice.page.getByRole('button', { name: 'Start chat' }).click();
  const row = bob.page.locator('div.row', { hasText: 'alice invited you' }).filter({ has: bob.page.getByRole('button', { name: 'Accept' }) }).first();
  await row.waitFor({ timeout: 45000 });
  await writes(bob, 'slow');
  await row.getByRole('button', { name: 'Accept' }).click();
  check(await bob.page.getByRole('button', { name: /Accepting/ }).isVisible().catch(() => false), 'Accept shows "Accepting…" while it runs');
  await writes(bob, 'normal');
  await bob.page.locator('.chat-item', { hasText: 'alice' }).waitFor({ timeout: 45000 });
  await bob.page.locator('.chat-item', { hasText: 'alice' }).click();
  await alice.page.locator('.chat-item', { hasText: 'bob' }).click();
  await alice.page.locator('#composer:not([disabled])').waitFor({ timeout: 45000 });
  await send(alice, 'Good morning, this is a fine day');
  await msg(bob, 'Good morning').waitFor({ timeout: 30000 });
  await send(bob, "Yes, let's go out and party!");
  await msg(alice, 'party').waitFor({ timeout: 30000 });

  // A second tab of the same account doesn't run alongside: two tabs would each apply every
  // reaction (a toggle), so a reaction cancelled itself.
  const tab2 = await alice.ctx.newPage();
  await tab2.goto(alice.page.url());
  await tab2.getByRole('heading', { name: 'Open in another tab' }).waitFor({ timeout: 10000 }).then(() => check(true, 'second tab says the chat is open in another tab'), () => check(false, 'second tab says the chat is open in another tab'));
  await quickReact(bob, 'Good morning', '❤️');
  await msg(alice, 'Good morning').locator('.reaction').waitFor({ timeout: 30000 });
  await syncRounds(alice, 3);
  check((await msg(alice, 'Good morning').locator('.reaction').count()) === 1, "the other person's reaction stays with a second tab open");
  await tab2.screenshot({ path: `${SHOTS}/one-tab.png` });
  await tab2.close();

  // Sending a text: the bubble shows at once, faded, with "Sending…".
  await writes(alice, 'slow');
  await send(alice, 'On my way');
  await alice.page.locator('.bubble.pending', { hasText: 'On my way' }).waitFor({ timeout: 1000 });
  check(await alice.page.locator('.msg-meta', { hasText: 'Sending…' }).isVisible(), 'text shows "Sending…" at once');
  await alice.page.screenshot({ path: `${SHOTS}/pending-send.png` });
  await alice.page.locator('.bubble:not(.pending)', { hasText: 'On my way' }).waitFor({ timeout: 15000 });
  check(!(await alice.page.locator('.msg-meta', { hasText: 'Sending…' }).count()), 'sent text settles into a normal bubble');
  check((await alice.page.locator('.bubble', { hasText: 'On my way' }).count()) === 1, 'no duplicate bubble after sending');

  // Reacting: the chip shows at once, pulsing, then settles.
  await quickReact(alice, 'party', '👍');
  await msg(alice, 'party').locator('.reaction.pending').waitFor({ timeout: 500 });
  check(true, 'reaction shows at once as pending');
  await alice.page.screenshot({ path: `${SHOTS}/pending-react.png` });
  await msg(alice, 'party').locator('.reaction.me:not(.pending)').waitFor({ timeout: 15000 });
  check(true, 'reaction settles as mine');
  await msg(bob, 'party').locator('.reaction').waitFor({ timeout: 30000 });
  check(true, 'the other side sees the reaction');
  await syncRounds(alice, 2);
  check((await msg(alice, 'party').locator('.reaction').count()) === 1, 'reaction is still there after it settles');

  // Taking it back is pending too.
  await msg(alice, 'party').locator('.reaction').click();
  check((await msg(alice, 'party').locator('.reaction.pending').count()) === 1, 'removing a reaction shows as pending');
  await msg(alice, 'party').locator('.reaction').waitFor({ state: 'detached', timeout: 15000 });
  check(true, 'removed reaction goes away');

  // Deleting a message.
  await msg(alice, 'On my way').locator('.bubble').click({ button: 'right' });
  await alice.page.getByRole('menuitem', { name: 'Delete for everyone' }).click();
  await alice.page.locator('.msg-meta', { hasText: 'Deleting…' }).waitFor({ timeout: 1000 });
  check(true, 'delete shows "Deleting…" at once');
  await alice.page.screenshot({ path: `${SHOTS}/pending-delete.png` });
  await alice.page.locator('.bubble.deleted').waitFor({ timeout: 15000 });
  check(true, 'deleted message settles');
  // The chat list stops showing the deleted text, on both sides and after a reload.
  const rowPreview = (p, peer) => p.page.locator('.chat-item', { hasText: peer }).locator('.preview');
  await rowPreview(alice, 'bob').filter({ hasText: 'Message deleted' }).waitFor({ timeout: 5000 }).catch(() => {});
  check((await rowPreview(alice, 'bob').innerText()) === 'Message deleted', 'sender: chat list says "Message deleted", not the deleted text');
  await rowPreview(bob, 'alice').filter({ hasText: 'Message deleted' }).waitFor({ timeout: 30000 }).catch(() => {});
  check((await rowPreview(bob, 'alice').innerText()) === 'Message deleted', 'receiver: chat list says "Message deleted", not the deleted text');
  await bob.page.reload();
  await rowPreview(bob, 'alice').waitFor({ timeout: 30000 });
  check((await rowPreview(bob, 'alice').innerText()) === 'Message deleted', 'after a reload the chat list still says "Message deleted"');
  await bob.page.locator('.chat-item', { hasText: 'alice' }).click();

  // Failures: a text stays as "Not sent" with Retry; a reaction goes back with a message.
  await writes(alice, 'fail');
  await send(alice, 'This one fails first');
  await alice.page.locator('.msg-meta.failed').waitFor({ timeout: 20000 });
  check(await alice.page.getByRole('button', { name: 'Retry' }).isVisible(), 'failed text shows "Not sent" with Retry');
  check((await alice.page.locator('#composer').inputValue()) === '', 'composer is cleared, the text lives in the failed bubble');
  await alice.page.screenshot({ path: `${SHOTS}/pending-failed.png` });
  await quickReact(alice, 'Good morning', '🎉');
  await alice.page.locator('.toast', { hasText: 'Reaction not sent' }).waitFor({ timeout: 20000 }).then(() => check(true, 'failed reaction says so'), () => check(false, 'failed reaction says so'));
  check(!(await msg(alice, 'Good morning').locator('.reaction', { hasText: '🎉' }).count()), 'failed reaction goes back');
  await writes(alice, 'normal');
  await alice.page.getByRole('button', { name: 'Retry' }).click();
  await alice.page.locator('.bubble:not(.pending)', { hasText: 'This one fails first' }).waitFor({ timeout: 20000 });
  check(!(await alice.page.locator('.msg-meta.failed').count()), 'Retry sends it');
  await msg(bob, 'This one fails first').waitFor({ timeout: 30000 });
  check(true, 'the other side gets the retried text');

  // Closing the chat: header and chat list show it, the composer waits.
  await writes(alice, 'slow');
  await alice.page.locator('.convo-head').getByRole('button', { name: 'Chat options' }).click();
  await alice.page.getByRole('menuitem', { name: 'Close chat', exact: true }).click();
  await alice.page.locator('.convo-sub.busy', { hasText: 'Closing chat…' }).waitFor({ timeout: 3000 });
  check(true, 'closing shows in the chat header');
  check(await alice.page.locator('.chat-item .spinner').isVisible(), 'closing shows in the chat list');
  check(await alice.page.locator('#composer').isDisabled(), 'composer waits while closing');
  await alice.page.screenshot({ path: `${SHOTS}/pending-close.png` });
  await alice.page.locator('.composer.ended').waitFor({ timeout: 30000 });
  check(true, 'chat closes');
  await writes(alice, 'normal');
} catch (e) {
  failures++;
  log('FAIL (exception)', e.message);
}
await browser.close();
log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
