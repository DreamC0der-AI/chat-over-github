// End-to-end check of the message menus against the local mock backend:
// the hover smiley + quick emoji row (desktop), right-click menu, long press (phone), and that
// every button and popup stays beside its bubble and on screen for text, pictures and files.
import { createRequire } from 'node:module';
import { deflateSync, crc32 } from 'node:zlib';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://localhost:8787/';
const SHOTS = process.env.SHOTS ?? '/tmp/e2e';
const browser = await chromium.launch();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (c, m) => { if (!c) { failures++; log('FAIL', m); } else log('ok  ', m); };

async function person(login, phone) {
  const ctx = await browser.newContext(phone ? devices['iPhone 13'] : { viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 });
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
  await page.getByRole('heading', { name: /Pick a chat/ }).waitFor().catch(() => {});
  return { ctx, page, login };
}
const msg = (p, text) => p.page.locator('.msg', { hasText: text }).last();
const imgMsg = (p) => p.page.locator('.msg', { has: p.page.locator('img[alt="photo.png"]') }).last();
const fileMsg = (p) => p.page.locator('.msg', { hasText: 'notes.pdf' }).last();
async function send(p, text) {
  await p.page.locator('#composer').fill(text);
  await p.page.locator('#composer').press('Enter');
}
const PNG = (() => {
  const w = 240, h = 160, rows = [];
  for (let y = 0; y < h; y++) { rows.push(0); for (let x = 0; x < w; x++) rows.push((x * 255 / w) | 0, (y * 255 / h) | 0, 200); }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
})();
async function sendFile(p, name, mimeType, buffer) {
  await p.page.locator('input[type=file]').setInputFiles({ name, mimeType, buffer });
  await p.page.locator('#composer').press('Enter');
}

const box = (l) => l.boundingBox();
const onScreen = async (p, l) => {
  const b = await box(l);
  const v = p.page.viewportSize();
  return !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= v.width + 0.5 && b.y + b.height <= v.height + 0.5;
};
const popup = (p) => p.page.locator('.msg-pop');

/** Hover a message: the smiley sits just outside the bubble's top corner, on the side facing the middle. */
async function checkSmiley(p, m, mine, what) {
  await m.locator('.bubble').hover();
  const btn = m.getByRole('button', { name: 'Add reaction' });
  await btn.waitFor();
  await p.page.waitForTimeout(200);
  const b = await box(m.locator('.bubble'));
  const s = await box(btn);
  const outside = mine ? s.x + s.width <= b.x + 0.5 && b.x - (s.x + s.width) < 10 : s.x >= b.x + b.width - 0.5 && s.x - (b.x + b.width) < 10;
  check(outside && Math.abs(s.y - b.y) < 6 && (await onScreen(p, btn)) && (await btn.evaluate((e) => getComputedStyle(e).opacity)) === '1', `${what}: smiley shows at the bubble's top ${mine ? 'left' : 'right'} corner`);
  return btn;
}
/** Click the smiley: the emoji row opens just above the bubble, lined up with its outer edge. */
async function checkQuick(p, m, mine, what, shot) {
  const btn = await checkSmiley(p, m, mine, what);
  await btn.click();
  const pop = popup(p);
  await pop.waitFor();
  await p.page.waitForTimeout(200);
  const b = await box(m.locator('.bubble'));
  const q = await box(pop);
  const above = q.y + q.height <= b.y + 0.5;
  const aligned = mine ? Math.abs(q.x + q.width - (b.x + b.width)) < 2 : Math.abs(q.x - b.x) < 2;
  check((above || q.y >= b.y + b.height - 0.5) && (await onScreen(p, pop)), `${what}: emoji row opens beside the bubble, on screen`);
  check(above ? aligned || q.x <= 9 || q.x + q.width >= p.page.viewportSize().width - 9 : true, `${what}: emoji row lines up with the bubble edge`);
  if (shot) await p.page.screenshot({ path: `${SHOTS}/${shot}.png` });
  await p.page.keyboard.press('Escape');
  await pop.waitFor({ state: 'detached' });
}

try {
  const alice = await person('alice');
  const bob = await person('bob', true);
  await alice.page.getByRole('button', { name: 'New chat' }).first().click();
  await alice.page.getByLabel('GitHub username').fill('bob');
  await alice.page.getByRole('button', { name: 'Start chat' }).click();
  const row = bob.page.locator('div.row', { hasText: 'alice invited you' }).filter({ has: bob.page.getByRole('button', { name: 'Accept' }) }).first();
  await row.waitFor({ timeout: 45000 });
  await row.getByRole('button', { name: 'Accept' }).click();
  await bob.page.locator('.chat-item', { hasText: 'alice' }).waitFor({ timeout: 45000 });
  await bob.page.locator('.chat-item', { hasText: 'alice' }).click();
  await alice.page.locator('.chat-item', { hasText: 'bob' }).click();
  await alice.page.locator('#composer:not([disabled])').waitFor({ timeout: 45000 });
  await bob.page.locator('#composer:not([disabled])').waitFor({ timeout: 45000 });

  await send(bob, "Yes, let's go out and party!");
  await msg(alice, 'party').waitFor({ timeout: 30000 });
  await send(bob, 'Here is a longer message that wraps over a few lines so the bubble reaches its widest, to check the smiley still fits beside it and the emoji row stays on screen.');
  await msg(alice, 'longer message').waitFor({ timeout: 30000 });
  await sendFile(bob, 'photo.png', 'image/png', PNG);
  await imgMsg(alice).locator('img').waitFor({ timeout: 30000 });
  await sendFile(alice, 'notes.pdf', 'application/pdf', Buffer.from('%PDF-1.4 test'));
  await fileMsg(bob).waitFor({ timeout: 30000 });
  await send(alice, 'Sounds good 👍');
  await msg(bob, 'Sounds good').waitFor({ timeout: 30000 });
  await alice.page.locator('.msg-meta', { hasText: 'Sending…' }).waitFor({ state: 'detached', timeout: 20000 });
  await alice.page.waitForTimeout(800);

  // Desktop, their messages (left) and mine (right), text, a long text, a picture, a file.
  await checkQuick(alice, msg(alice, 'party'), false, 'their short text', 'menu-quick-theirs');
  await checkQuick(alice, msg(alice, 'longer message'), false, 'their long text');
  await checkQuick(alice, imgMsg(alice), false, 'their picture', 'menu-quick-picture');
  await checkQuick(alice, fileMsg(alice), true, 'my file');
  await checkQuick(alice, msg(alice, 'Sounds good'), true, 'my text', 'menu-quick-mine');

  // Nothing big appears on a plain hover: one small button only.
  await msg(alice, 'party').locator('.bubble').hover();
  const sb = await box(msg(alice, 'party').getByRole('button', { name: 'Add reaction' }));
  check(sb.width <= 30 && sb.height <= 30 && !(await popup(alice).count()), 'hover shows only the small smiley');
  await alice.page.mouse.move(600, 20);
  await alice.page.screenshot({ path: `${SHOTS}/menu-hover.png` });
  await msg(alice, 'party').locator('.bubble').hover();
  await alice.page.screenshot({ path: `${SHOTS}/menu-hover-on.png` });

  // Picking an emoji reacts (pending first) and closes the row.
  await msg(alice, 'party').locator('.bubble').hover();
  await msg(alice, 'party').getByRole('button', { name: 'Add reaction' }).click();
  await alice.page.getByRole('menuitemcheckbox', { name: 'React 🎉' }).click();
  check(!(await popup(alice).count()), 'picking an emoji closes the row');
  await msg(alice, 'party').locator('.reaction.me', { hasText: '🎉' }).waitFor({ timeout: 2000 });
  check(true, 'reaction shows at once');
  await msg(alice, 'party').locator('.reaction.me:not(.pending)').waitFor({ timeout: 15000 });
  await msg(alice, 'party').locator('.bubble').hover();
  await msg(alice, 'party').getByRole('button', { name: 'Add reaction' }).click();
  check((await alice.page.getByRole('menuitemcheckbox', { name: 'React 🎉' }).getAttribute('aria-checked')) === 'true', 'the row marks emoji you already used');
  await alice.page.keyboard.press('Escape');

  // Right-click: full menu at the pointer, emoji row on top, actions below.
  const pb = await box(msg(alice, 'party').locator('.bubble'));
  await alice.page.mouse.click(pb.x + 20, pb.y + pb.height / 2, { button: 'right' });
  await popup(alice).waitFor();
  const items = await popup(alice).getByRole('menuitem').allInnerTexts();
  check((await popup(alice).getByRole('menuitemcheckbox').count()) === 5 && items.join('|') === 'Copy text', `right-click on their text: emoji row + Copy text (${items.join(', ')})`);
  await alice.page.waitForTimeout(200);
  const mb = await box(popup(alice));
  check(Math.abs(mb.x - (pb.x + 20)) < 2 && Math.abs(mb.y - (pb.y + pb.height / 2)) < 2, 'right-click menu opens at the pointer');
  await alice.page.screenshot({ path: `${SHOTS}/menu-right-click.png` });
  await alice.page.mouse.click(600, 20);
  await popup(alice).waitFor({ state: 'detached' });
  check(true, 'clicking elsewhere closes the menu');

  const mine = await box(msg(alice, 'Sounds good').locator('.bubble'));
  await alice.page.mouse.click(mine.x + mine.width - 4, mine.y + mine.height - 4, { button: 'right' });
  await popup(alice).waitFor();
  check((await popup(alice).getByRole('menuitem').allInnerTexts()).join('|') === 'Copy text|Delete for everyone', 'right-click on my text adds Delete for everyone');
  check(await onScreen(alice, popup(alice)), 'menu near the bottom-right edge flips to stay on screen');
  await alice.page.waitForTimeout(200);
  await alice.page.screenshot({ path: `${SHOTS}/menu-right-click-mine.png` });
  await alice.page.getByRole('menuitem', { name: 'Copy text' }).click();
  await alice.page.locator('.toast', { hasText: /Copied|Couldn't copy/ }).waitFor({ timeout: 3000 });
  check(true, 'Copy text answers');

  await imgMsg(alice).locator('img').click({ button: 'right' });
  check((await popup(alice).getByRole('menuitem').allInnerTexts()).join('|') === 'Save picture', 'right-click on a picture offers Save picture');
  const [dl] = await Promise.all([alice.page.waitForEvent('download', { timeout: 15000 }), alice.page.getByRole('menuitem', { name: 'Save picture' }).click()]);
  check(dl.suggestedFilename() === 'photo.png', 'Save picture downloads it');
  await fileMsg(alice).locator('.bubble').click({ button: 'right', position: { x: 60, y: 20 } });
  check((await popup(alice).getByRole('menuitem').allInnerTexts()).join('|') === 'Download|Delete for everyone', 'right-click on my file: Download + Delete');
  await alice.page.keyboard.press('Escape');

  // "More actions" in the quick row opens the full menu.
  await msg(alice, 'Sounds good').locator('.bubble').hover();
  await msg(alice, 'Sounds good').getByRole('button', { name: 'Add reaction' }).click();
  await alice.page.getByRole('menuitem', { name: 'More actions' }).click();
  check((await popup(alice).getByRole('menuitem').allInnerTexts()).includes('Delete for everyone') && (await onScreen(alice, popup(alice))), 'More actions opens the full menu beside the bubble');
  await alice.page.keyboard.press('Escape');

  // Links keep the browser's own right-click menu; a plain click on a bubble opens nothing; pictures still open.
  await msg(alice, 'party').locator('.bubble').click();
  check(!(await popup(alice).count()), 'clicking a bubble opens nothing');
  await imgMsg(alice).locator('.media').click();
  await alice.page.locator('.lightbox').waitFor({ timeout: 3000 });
  check(true, 'clicking a picture still opens it');
  await alice.page.keyboard.press('Escape');
  await alice.page.locator('.lightbox [aria-label=Close]').click().catch(() => {});

  // Delete still works through the menu, with its pending state.
  await alice.page.mouse.click(mine.x + 10, mine.y + 10, { button: 'right' });
  await alice.page.getByRole('menuitem', { name: 'Delete for everyone' }).click();
  await alice.page.locator('.bubble.deleted').waitFor({ timeout: 15000 });
  check(true, 'Delete for everyone from the menu deletes the message');

  // Narrow desktop window.
  await alice.page.setViewportSize({ width: 560, height: 700 });
  await alice.page.waitForTimeout(300);
  await checkQuick(alice, msg(alice, 'longer message'), false, 'narrow window, their long text', 'menu-quick-narrow');
  await checkQuick(alice, fileMsg(alice), true, 'narrow window, my file');

  // Phone: no hover button; long press opens the full menu beside the bubble.
  const cdp = await bob.ctx.newCDPSession(bob.page);
  const longPress = async (l, dx = 0.5, dy = 0.5) => {
    const b = await box(l);
    const x = b.x + b.width * dx, y = b.y + b.height * dy;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await bob.page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  check(!(await bob.page.getByRole('button', { name: 'Add reaction' }).first().isVisible()), 'phone: no hover smiley');
  for (const [l, what, shot] of [
    [msg(bob, 'party'), 'phone, my text', 'menu-phone-mine'],
    [bob.page.locator('.msg', { has: bob.page.locator('.bubble.deleted') }).last(), 'phone, their deleted text', null],
    [fileMsg(bob), 'phone, their file', 'menu-phone-file'],
    [imgMsg(bob), 'phone, my picture', 'menu-phone-picture'],
    [msg(bob, 'longer message'), 'phone, my long text', null],
  ]) {
    await l.scrollIntoViewIfNeeded();
    await longPress(l.locator('.bubble'));
    await bob.page.waitForTimeout(250);
    if (what.includes('deleted')) {
      check(!(await popup(bob).count()), `${what}: no menu on a deleted message`);
      continue;
    }
    await popup(bob).waitFor({ timeout: 2000 });
    check(await onScreen(bob, popup(bob)), `${what}: long press opens the menu on screen`);
    await bob.page.waitForTimeout(200);
    if (shot) await bob.page.screenshot({ path: `${SHOTS}/${shot}.png` });
    await bob.page.touchscreen.tap(195, 120);
    await popup(bob).waitFor({ state: 'detached', timeout: 2000 });
  }
  check(!(await bob.page.locator('.lightbox').count()), 'phone: long press on a picture does not also open it');
  await longPress(fileMsg(bob).locator('.bubble'));
  await bob.page.getByRole('menuitemcheckbox', { name: 'React 👀' }).tap();
  await fileMsg(bob).locator('.reaction.me', { hasText: '👀' }).waitFor({ timeout: 3000 });
  check(true, 'phone: reacting from the long-press menu');
} catch (e) {
  failures++;
  log('FAIL (exception)', e.message);
}
await browser.close();
log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
