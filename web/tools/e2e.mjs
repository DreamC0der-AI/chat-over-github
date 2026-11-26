// End-to-end check against the local mock backend: two people, a DM, a group, a second device.
// This proves the screens are wired to the app: buttons, dialogs, menus, what shows where. The
// chat rules themselves (who joins when, what syncs, what ends a chat) are tested much faster
// without a browser in web/tests/*.test.ts.
//   node tools/mock-server.mjs 8787 &   then   node tools/e2e.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://localhost:8787/';
const SHOTS = process.env.SHOTS ?? '/tmp/e2e';
const browser = await chromium.launch();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const people = [];
const check = (c, m) => { if (!c) { failures++; log('FAIL', m); } else log('ok  ', m); };

async function person(login) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(() => { window.__autoConfirm = true; }); // in-app confirmations answer yes (mock build only)
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(login, 'PAGEERROR', e.message));
  page.on('console', (m) => m.type() === 'error' && log(login, 'console', m.text()));
  await page.goto(BASE);
  await page.getByLabel('Test account').fill(login);
  await page.getByRole('button', { name: /Sign in/ }).click();
  page.on('dialog', (d) => d.accept());
  const p = { ctx, page, login };
  people.push(p);
  return p;
}

async function setup(p) {
  await p.page.getByRole('button', { name: 'Create identity' }).click();
  const code = await p.page.locator('.code-box').innerText({ timeout: 30000 });
  await p.page.getByLabel(/Type the last block/).fill(code.split('-').pop());
  await p.page.getByRole('button', { name: 'Continue to chats' }).click();
  await p.page.getByRole('heading', { name: /Pick a chat/ }).waitFor();
  return code;
}

// Run the app's sync step now, n times over, instead of waiting for its timers. A check that
// something does NOT happen waits a few full sync rounds, which is exactly what a timer would give.
const syncRounds = async (p, n = 2) => { for (let i = 0; i < n; i++) await p.page.evaluate(() => window.__chat?.syncNow()); };
const until = async (p, cond, timeout = 30000) => {
  for (const end = Date.now() + timeout; Date.now() < end;) { if (await cond()) return true; await p.page.waitForTimeout(100); }
  return false;
};

// Type and send, then wait until our own bubble shows (it does at once, as pending). Right after
// switching chats the composer can still be the previous chat's and gets cleared, so type again.
async function sendMsg(p, text) {
  for (let i = 0; i < 3; i++) {
    await p.page.locator('#composer:enabled').waitFor();
    await p.page.locator('#composer').fill(text);
    await p.page.locator('#composer').press('Enter');
    if (await p.page.locator('.msg.mine .bubble', { hasText: text }).first().waitFor({ timeout: 3000 }).then(() => true, () => false)) return;
  }
  throw new Error(`${p.login}: "${text}" never showed as sent`);
}
async function accept(p, from, timeout = 45000) {
  const row = p.page.locator('div.row', { hasText: `${from} invited you` }).filter({ has: p.page.getByRole('button', { name: 'Accept' }) }).first();
  await row.waitFor({ timeout });
  await row.getByRole('button', { name: 'Accept' }).click();
}
/** Pick an item from the open chat's "…" menu. */
async function menu(p, item) {
  await p.page.locator('.convo-head').getByRole('button', { name: 'Chat options' }).click();
  await p.page.getByRole('menuitem', { name: item, exact: true }).click();
}
const closeDialog = (p) => p.page.getByRole('button', { name: 'Close', exact: true }).click();
// Open a chat and wait until it is the one shown, so the composer belongs to it (typing right
// after the click could otherwise land in the chat that was open before).
async function openChat(p, title) {
  await p.page.evaluate(() => { if (location.hash.startsWith('#/settings')) location.hash = '#/'; });
  await p.page.locator('.chat-item', { hasText: title }).first().click();
  await p.page.locator('.convo-title', { hasText: new RegExp(`^${title}$`) }).waitFor();
}

const bubble = (p, text) => p.page.locator('.bubble', { hasText: text }).first();

try {
  const alice = await person('alice');
  const bob = await person('bob');
  const aliceCode = await setup(alice);
  await setup(bob);
  check(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/.test(aliceCode), 'recovery code shown');

  // DM
  await alice.page.getByRole('button', { name: 'New chat' }).first().click();
  await alice.page.getByLabel('GitHub username').fill('bob');
  await alice.page.getByRole('button', { name: 'Start chat' }).click();
  await alice.page.locator('.sys', { hasText: 'Invitation sent to @bob' }).waitFor({ timeout: 30000 });
  check(true, 'alice started DM');

  await bob.page.getByText('alice invited you').waitFor({ timeout: 45000 });
  await syncRounds(bob, 3);
  check(!(await bob.page.locator('.chat-item', { hasText: 'alice' }).count()), 'bob sees an invitation and nothing joins before he accepts');
  await bob.page.screenshot({ path: `${SHOTS}/invite-accept.png` });
  await accept(bob, 'alice');
  await bob.page.locator('.chat-item', { hasText: 'alice' }).waitFor({ timeout: 45000 });
  check(true, 'bob accepted and joined the DM');
  await openChat(bob, 'alice');
  await sendMsg(bob, 'hi alice, it works');
  await bubble(alice, 'hi alice, it works').waitFor({ timeout: 5000 }).catch(() => {});
  await openChat(alice, 'bob');
  await bubble(alice, 'hi alice, it works').waitFor({ timeout: 30000 });
  check(true, 'alice received bob\'s message');
  await sendMsg(alice, 'hello bob 👋\nsecond line');
  await bubble(bob, 'hello bob').waitFor({ timeout: 30000 });
  check(true, 'bob received alice\'s reply');
  await alice.page.screenshot({ path: `${SHOTS}/dm-alice.png` });

  // A message joining a run must not remount the avatar beside it (it used to flash).
  const marked = await bob.page.evaluate(() => {
    const els = document.querySelectorAll('.msg-avatar .avatar');
    const el = els[els.length - 1];
    if (el) el.dataset.e2eMark = '1';
    return els.length;
  });
  await sendMsg(alice, 'one more in the same run');
  await bubble(bob, 'one more in the same run').waitFor({ timeout: 30000 });
  const kept = await bob.page.evaluate(() => {
    const els = document.querySelectorAll('.msg-avatar .avatar');
    return { n: els.length, sameEl: els[els.length - 1]?.dataset.e2eMark === '1' };
  });
  check(marked === 1 && kept.n === 1 && kept.sameEl, `avatar stays mounted when a message joins the run (${JSON.stringify({ marked, ...kept })})`);

  // Verify safety number match on both sides
  await menu(alice, 'Safety number');
  const sa = await alice.page.locator('.safety').innerText();
  // Verifying lives in Contacts: the chat header shows no shield until a chat is verified.
  check(!(await bob.page.locator('.convo-head .trust').count()), 'unverified chat shows no shield in the header');
  await bob.page.getByRole('link', { name: 'Contacts' }).click();
  await bob.page.locator('.contact-item', { hasText: 'alice' }).click();
  const sb = await bob.page.locator('.safety').innerText();
  check(sa === sb && sa.length > 50, 'safety numbers match');
  await alice.page.getByRole('button', { name: /mark as verified/ }).click();
  await closeDialog(alice);
  await closeDialog(bob);
  await alice.page.locator('.convo-head').getByRole('button', { name: 'Verified', exact: true }).waitFor();
  check(true, 'marked verified');
  await openChat(bob, 'alice');
  await alice.page.getByRole('link', { name: 'Contacts' }).click();
  await alice.page.locator('.contact-item', { hasText: 'bob' }).locator('.trust.ok').waitFor();
  check(true, 'Contacts shows bob as verified');
  await alice.page.screenshot({ path: `${SHOTS}/contacts.png` });
  await alice.page.locator('.contact-item', { hasText: 'bob' }).click();
  await alice.page.locator('.verified-note').waitFor();
  await alice.page.screenshot({ path: `${SHOTS}/contact.png` });
  await closeDialog(alice);
  await openChat(alice, 'bob');

  // attachments: a file card, then a picture shown inline with an upload state
  await alice.page.locator('input[type=file]').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('secret file contents') });
  await alice.page.locator('.tray-item', { hasText: 'note.txt' }).waitFor();
  await alice.page.getByRole('button', { name: 'Send', exact: true }).click();
  await bob.page.locator('.file-card', { hasText: 'note.txt' }).waitFor({ timeout: 30000 });
  const [dl] = await Promise.all([bob.page.waitForEvent('download', { timeout: 15000 }), bob.page.locator('.file-card', { hasText: 'note.txt' }).getByRole('button', { name: 'Download' }).click()]);
  const dlPath = await dl.path();
  check((await import('node:fs')).readFileSync(dlPath, 'utf8') === 'secret file contents', 'file attachment sent, decrypted and downloaded');

  const PNG = await (async () => {
    // A small gradient picture, built here so the test needs no fixture file.
    const { deflateSync, crc32 } = await import('node:zlib');
    const w = 240, h = 160, rows = [];
    for (let y = 0; y < h; y++) { rows.push(0); for (let x = 0; x < w; x++) rows.push((x * 255 / w) | 0, (y * 255 / h) | 0, 200); }
    const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
  })();
  await alice.page.locator('input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG });
  await alice.page.locator('.tray-item.pic img').waitFor();
  await alice.page.locator('#composer').fill('look at this');
  // Hold the upload until the pending state was seen: against the local mock the whole send can
  // finish before a poll sees it, and a missed transient state made this step flaky.
  let releaseUpload;
  const uploadHeld = new Promise((r) => (releaseUpload = r));
  const inFlight = [];
  const holdUpload = (route) => {
    const done = (async () => {
      if (route.request().method() === 'PUT') await uploadHeld;
      await route.continue();
    })();
    inFlight.push(done);
    return done;
  };
  await alice.page.route(/\/contents\/blob\//, holdUpload);
  await alice.page.locator('#composer').press('Enter');
  const pendingShown = await alice.page.locator('.media.pending img').waitFor({ timeout: 5000 }).then(() => true, () => false);
  releaseUpload();
  // Let held requests go on before removing the handler, or Playwright reports them handled twice.
  await Promise.all(inFlight);
  await alice.page.unroute(/\/contents\/blob\//, holdUpload);
  check(pendingShown, 'sent picture shows at once with an upload state');
  await alice.page.locator('.msg.mine .media img[alt="photo.png"]').waitFor({ timeout: 30000 });
  await bob.page.locator('.media img[alt="photo.png"]').waitFor({ timeout: 30000 });
  const cap = await bob.page.locator('.attach', { has: bob.page.locator('img[alt="photo.png"]') }).locator('.attach-caption').innerText();
  check(cap === 'look at this', 'received picture renders inline with its caption');
  await bob.page.locator('.media', { has: bob.page.locator('img[alt="photo.png"]') }).click();
  await bob.page.locator('.lightbox img').waitFor();
  await bob.page.screenshot({ path: `${SHOTS}/lightbox-bob.png` });
  await bob.page.keyboard.press('Escape');
  await bob.page.locator('.lightbox').waitFor({ state: 'detached' });
  await bob.page.screenshot({ path: `${SHOTS}/images-bob.png` });
  await alice.page.screenshot({ path: `${SHOTS}/images-alice.png` });
  check(true, 'picture opens full size and closes with Esc');

  // Group
  const carol = await person('carol');
  await setup(carol);
  await alice.page.getByRole('link', { name: 'Contacts' }).click();
  await alice.page.getByRole('button', { name: 'New group' }).click();
  await alice.page.getByLabel('Group name').fill('Weekend hikers');
  // bob is a contact: pick him from the list; carol isn't yet: type her username and press Enter
  await alice.page.getByRole('option', { name: 'bob' }).click();
  await alice.page.getByLabel('Invite people').fill('carol');
  await alice.page.getByLabel('Invite people').press('Enter');
  await alice.page.locator('.chip', { hasText: 'carol' }).waitFor();
  // a group picture, picked in the dialog (its file input sits in the picture picker)
  await alice.page.locator('.modal .pic-picker input[type=file]').setInputFiles({ name: 'group.png', mimeType: 'image/png', buffer: PNG });
  // crop: zoom in with the slider, drag the picture, then use it
  const crop = alice.page.getByRole('dialog', { name: 'Crop picture' });
  await crop.locator('.crop-stage img').waitFor();
  await crop.getByLabel('Zoom').fill('2');
  const box = (await crop.locator('.crop-stage').boundingBox());
  await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await alice.page.mouse.down();
  await alice.page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 4 });
  await alice.page.mouse.up();
  await alice.page.screenshot({ path: `${SHOTS}/group-picture-crop.png` });
  await crop.getByRole('button', { name: 'Use picture' }).click();
  await crop.waitFor({ state: 'detached' });
  await alice.page.locator('.modal .pic-picker img').waitFor();
  check(await alice.page.getByRole('dialog', { name: 'New group' }).isVisible(), 'the crop dialog closes back into New group');
  await alice.page.screenshot({ path: `${SHOTS}/new-group-picker.png` });
  await alice.page.getByRole('button', { name: 'Create group' }).click();
  await alice.page.locator('.sys', { hasText: 'Invitation sent to @carol' }).waitFor({ timeout: 30000 });
  for (const p of [bob, carol]) await accept(p, 'alice', 70000);
  for (const p of [bob, carol]) await p.page.locator('.chat-item', { hasText: 'Weekend hikers' }).waitFor({ timeout: 70000 });
  check(true, 'bob and carol got the group');
  await bob.page.locator('.chat-item', { hasText: 'Weekend hikers' }).locator('.group-avatar img').waitFor({ timeout: 30000 });
  check(true, 'the group picture reached bob');
  await carol.page.locator('.chat-item', { hasText: 'Weekend hikers' }).click();
  await sendMsg(carol, 'carol here');
  await bob.page.locator('.chat-item', { hasText: 'Weekend hikers' }).click();
  await bubble(bob, 'carol here').waitFor({ timeout: 30000 });
  await bubble(alice, 'carol here').waitFor({ timeout: 30000 });
  check(true, 'group message reached both');
  await bob.page.screenshot({ path: `${SHOTS}/group-bob.png` });

  // remove carol
  await menu(alice, 'Group info');
  await alice.page.locator('.member', { hasText: 'carol' }).getByRole('button', { name: 'Remove' }).click();
  await alice.page.locator('.sys', { hasText: 'You removed @carol' }).waitFor({ timeout: 30000 });
  await carol.page.locator('.sys, .flash', { hasText: /@alice removed you/ }).first().waitFor({ timeout: 45000 });
  await carol.page.screenshot({ path: `${SHOTS}/carol-removed.png` });
  check(true, 'carol removed and told who did it');
  await alice.page.screenshot({ path: `${SHOTS}/group-alice-panel.png` });
  await closeDialog(alice);

  // Second device for alice
  const alice2 = await person('alice');
  await alice2.page.getByLabel('Recovery code').fill(aliceCode);
  await alice2.page.getByRole('button', { name: 'Add this browser' }).click();
  // Catching up on her own chats: never shown as an invitation from herself.
  let selfInvite = false;
  const watchSelf = setInterval(() => {
    alice2.page.locator('.invite-title', { hasText: 'alice invited you' }).count().then((n) => { if (n) selfInvite = true; }, () => {});
  }, 100);
  await alice2.page.locator('.chat-item', { hasText: 'bob' }).waitFor({ timeout: 60000 });
  clearInterval(watchSelf);
  check(!selfInvite, 'second device never shows itself as the inviter');
  check(true, 'second device joined the DM');
  await openChat(alice2, 'bob');
  await alice2.page.locator('.sys.divider', { hasText: 'Earlier messages aren’t on this browser' }).waitFor({ timeout: 10000 });
  check(true, 'second device says earlier messages are elsewhere');
  // The verified mark from alice's first browser came with sync: no new first contact here.
  await alice2.page.locator('.convo-head').getByRole('button', { name: 'Verified', exact: true }).waitFor({ timeout: 30000 });
  check(true, 'second device shows the verified mark from the first');
  await openChat(bob, 'alice');
  await sendMsg(bob, 'message for both alice devices');
  await bubble(alice2, 'message for both alice devices').waitFor({ timeout: 45000 });
  await openChat(alice, 'bob');
  await bubble(alice, 'message for both alice devices').waitFor({ timeout: 45000 });
  check(true, 'both alice devices read the new message');
  await alice2.page.goto(BASE + '#/settings/devices');
  await alice2.page.locator('.label', { hasText: 'This browser' }).waitFor();
  check((await alice2.page.locator('.box-row', { hasText: 'Added' }).count()) === 2, 'two devices listed');
  await alice2.page.screenshot({ path: `${SHOTS}/settings.png` });

  const count = (p, name) => p.page.locator('.chat-item .name').getByText(name, { exact: true }).count();

  // Delete chat: bob clears his copy of the DM with alice; the chat stays live
  await openChat(bob, 'alice');
  await menu(bob, 'Delete chat');
  await bubble(bob, 'hi alice, it works').waitFor({ state: 'detached', timeout: 10000 });
  await openChat(alice, 'bob');
  await sendMsg(alice, 'after the clear');
  await bubble(bob, 'after the clear').waitFor({ timeout: 30000 });
  check(!(await bubble(bob, 'hello bob').count()), 'bob deleted his history, the chat stayed live and new messages arrive');
  check(await bubble(alice, 'hi alice, it works').count() > 0, 'alice kept her copy');

  // Close: alice (owner) closes the DM; bob learns why, keeps his copy, and starts a new one
  await menu(alice, 'Close chat');
  await alice.page.locator('.sys.divider', { hasText: 'You closed this chat' }).waitFor({ timeout: 30000 });
  await bob.page.locator('.sys.divider', { hasText: '@alice closed this chat' }).waitFor({ timeout: 45000 });
  await openChat(alice2, 'bob');
  await alice2.page.locator('.sys.divider', { hasText: 'You closed this chat' }).waitFor({ timeout: 45000 });
  check(true, "alice's second browser shows the close too");
  check(await bubble(bob, 'after the clear').count() > 0 && (await bob.page.locator('#composer').count()) === 0, 'bob sees "@alice closed this chat", keeps his copy, and can\'t send');
  await bob.page.screenshot({ path: `${SHOTS}/closed-bob.png` });
  await bob.page.getByRole('button', { name: 'Start a new chat with alice' }).click();
  await accept(alice, 'bob', 60000);
  await bob.page.locator('.sys', { hasText: '@alice joined' }).waitFor({ timeout: 60000 });
  await sendMsg(bob, 'new room, same chat');
  await openChat(alice, 'bob');
  await bubble(alice, 'new room, same chat').waitFor({ timeout: 30000 });
  check((await count(alice, 'bob')) === 1 && (await count(bob, 'alice')) === 1, 'one chat-list entry per person after re-creation');
  check(await alice.page.locator('.sys.divider', { hasText: 'new chat started' }).count() > 0 && (await bubble(alice, 'after the clear').count()) > 0, 'old history above a divider, then the new room');
  await alice.page.screenshot({ path: `${SHOTS}/recreated-alice.png` });

  // Block from the chat menu: the menu then offers Unblock.
  await openChat(bob, 'alice');
  await menu(bob, 'Block alice');
  await bob.page.locator('.convo-head').getByRole('button', { name: 'Chat options' }).click();
  await bob.page.getByRole('menuitem', { name: 'Unblock alice' }).waitFor();
  await bob.page.keyboard.press('Escape');
  check(true, 'Block from the chat menu, then Unblock is offered');

  // first run: no install yet -> guided steps -> continues by itself
  const newbie = await person('newbie');
  await newbie.page.getByText('Two quick steps on GitHub').waitFor();
  check(await newbie.page.getByRole('link', { name: /Create chat-home on GitHub/ }).getAttribute('href').then((h) => h.includes('name=chat-home') && h.includes('visibility=private')), 'prefilled new-repo link');
  await newbie.page.screenshot({ path: `${SHOTS}/install.png` });
  await newbie.page.evaluate(() => fetch('/gh/mock/install', { method: 'POST', headers: { Authorization: 'Bearer tok-newbie' } }));
  await newbie.page.getByRole('button', { name: 'Check now' }).click();
  await newbie.page.getByRole('button', { name: 'Create identity' }).waitFor({ timeout: 20000 });
  check(true, 'install detected, onboarding continues');
  await newbie.page.getByRole('button', { name: 'Create identity' }).click();
  await newbie.page.locator('.code-box').waitFor({ timeout: 30000 });
  const homeOk = await newbie.page.evaluate(() => fetch('/gh/repos/newbie/chat-home/contents/vault/root', { headers: { Authorization: 'Bearer tok-newbie' } }).then((r) => r.status));
  check(homeOk === 200, 'root key backup stored in chat-home');

  // mobile layout
  await bob.page.setViewportSize({ width: 390, height: 800 });
  await bob.page.screenshot({ path: `${SHOTS}/mobile-chat.png` });
} catch (e) {
  failures++;
  log('ERROR', e.message);
  for (const [i, p] of people.entries()) {
    const sys = await p.page.locator('.sys, .bubble, .flash, .status-bar').allInnerTexts().catch(() => []);
    log(`--- ${p.login}#${i}`, JSON.stringify(sys));
    log(`    state ${p.login}#${i}`, JSON.stringify(await p.page.evaluate(() => window.__chat?.debug()).catch(() => null)));
    await p.page.screenshot({ path: `${SHOTS}/fail-${p.login}-${i}.png` }).catch(() => {});
  }
} finally {
  await browser.close();
  log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
