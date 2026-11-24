// End-to-end check of the layout settings against the local mock backend:
// dragging the chat list's edge (limits, saved across reloads, double-click reset, keyboard),
// the theme picker (applies at once and before first paint after a reload), and the settings sections
// (side list on desktop, list then one section on a phone).
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE ?? 'http://localhost:8787/';
const SHOTS = process.env.SHOTS ?? '/tmp/e2e';
const browser = await chromium.launch();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (c, m) => { if (!c) { failures++; log('FAIL', m); } else log('ok  ', m); };

async function person(login, opts = {}) {
  const ctx = await browser.newContext(opts.phone ? devices['iPhone 13'] : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: opts.scheme ?? 'light' });
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
  await page.getByRole('heading', { name: 'Chats', exact: true }).waitFor();
  return { ctx, page, login };
}
const sideW = (p) => p.page.locator('.sidebar').evaluate((e) => e.getBoundingClientRect().width);
const theme = (p) => p.page.evaluate(() => document.documentElement.dataset.theme);
const bg = (p, sel) => p.page.locator(sel).first().evaluate((e) => getComputedStyle(e).backgroundColor);

try {
  const alice = await person('alice');
  const bob = await person('bob');
  // one chat with a few messages, so screenshots have something in them
  await alice.page.getByRole('button', { name: 'New chat' }).first().click();
  await alice.page.getByLabel('GitHub username').fill('bob');
  await alice.page.getByRole('button', { name: 'Start chat' }).click();
  const inv = bob.page.locator('div.row', { hasText: 'alice invited you' }).filter({ has: bob.page.getByRole('button', { name: 'Accept' }) }).first();
  await inv.waitFor({ timeout: 45000 });
  await inv.getByRole('button', { name: 'Accept' }).click();
  await bob.page.locator('.chat-item', { hasText: 'alice' }).click();
  for (const t of ['Hi Alice! Trying the new themes.', 'Looks good so far']) {
    await bob.page.waitForTimeout(400);
    await bob.page.locator('#composer').fill(t);
    await bob.page.locator('#composer').press('Enter');
  }
  await alice.page.locator('.chat-item', { hasText: 'bob' }).click();
  await alice.page.locator('.bubble', { hasText: 'Looks good so far' }).waitFor({ timeout: 45000 });
  await alice.page.locator('#composer').fill('Dark dimmed is my favourite');
  await alice.page.locator('#composer').press('Enter');
  await alice.page.waitForTimeout(1500);

  // ---- status notices sit above the message box when a chat is open (none floating)
  await alice.page.route(BASE, (r) => r.request().resourceType() === 'fetch' ? r.fulfill({ contentType: 'text/html', body: '<script type="module" src="/assets/index-Newer123.js"></script>' }) : r.continue());
  await alice.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await alice.page.locator('.composer .notice.info').waitFor({ timeout: 5000 });
  check((await alice.page.locator('.notice-float').count()) === 0, 'in a chat, "New version" sits above the message box, not floating');
  await alice.page.screenshot({ path: `${SHOTS}/notice-new-version-chat.png` });
  await alice.page.unroute(BASE);
  await alice.page.reload();
  await alice.page.locator('#composer').waitFor();

  // ---- chat list width
  const p = alice;
  check(Math.round(await sideW(p)) === 320, 'chat list starts at 320 px');
  const handle = p.page.getByRole('separator', { name: 'Resize chat list' });
  const hb = await handle.boundingBox();
  const y = hb.y + hb.height / 2;
  const dragTo = async (x) => {
    const b = await handle.boundingBox();
    await p.page.mouse.move(b.x + b.width / 2, y);
    await p.page.mouse.down();
    await p.page.mouse.move(x, y, { steps: 6 });
    await p.page.mouse.up();
  };
  await dragTo(420);
  check(Math.abs((await sideW(p)) - 420) <= 2, `drag widens the chat list (${Math.round(await sideW(p))} px)`);
  await p.page.screenshot({ path: `${SHOTS}/layout-wide.png` });
  await dragTo(60);
  check(Math.round(await sideW(p)) === 240, 'it stops at 240 px');
  await dragTo(1200);
  check(Math.round(await sideW(p)) === 520, 'it stops at 520 px');
  await dragTo(380);
  await p.page.reload();
  await p.page.locator('.chat-item').first().waitFor();
  check(Math.abs((await sideW(p)) - 380) <= 2, 'width is kept after a reload');
  await dragTo(480);
  await p.page.setViewportSize({ width: 800, height: 800 });
  await p.page.waitForTimeout(100);
  check(Math.round(await sideW(p)) === 420, 'a narrow window shrinks it to leave room for the chat');
  await p.page.setViewportSize({ width: 1280, height: 800 });
  await p.page.waitForTimeout(100);
  check(Math.abs((await sideW(p)) - 480) <= 2, 'a wider window brings it back');
  await handle.dblclick();
  check(Math.round(await sideW(p)) === 320, 'double-click resets to 320 px');
  await handle.focus();
  await p.page.keyboard.press('ArrowRight');
  await p.page.keyboard.press('ArrowRight');
  check(Math.round(await sideW(p)) === 352, 'arrow keys resize it too');
  await handle.dblclick();

  // ---- themes
  check((await theme(p)) === 'light', 'System follows a light OS');
  await p.page.goto(BASE + '#/settings');
  await p.page.getByRole('heading', { name: 'Appearance' }).waitFor();
  await p.page.screenshot({ path: `${SHOTS}/settings-appearance-light.png` });
  for (const [name, id, canvas] of [['Dark', 'dark', 'rgb(13, 17, 23)'], ['Dark dimmed', 'dimmed', 'rgb(33, 40, 48)'], ['Light', 'light', 'rgb(255, 255, 255)']]) {
    await p.page.getByRole('radio', { name, exact: true }).click();
    check((await theme(p)) === id && (await bg(p, '.theme-card')) === canvas, `picking ${name} applies it at once`);
    check((await p.page.getByRole('radio', { name, exact: true }).getAttribute('aria-checked')) === 'true', `${name} shows as chosen`);
    if (id !== 'light') {
      await p.page.screenshot({ path: `${SHOTS}/settings-appearance-${id}.png` });
      await p.page.goto(BASE + '#/');
      await p.page.locator('.chat-item', { hasText: 'bob' }).click();
      await p.page.locator('.bubble', { hasText: 'favourite' }).waitFor();
      await p.page.waitForTimeout(400);
      await p.page.screenshot({ path: `${SHOTS}/chat-${id}.png` });
      await p.page.goto(BASE + '#/settings/appearance');
      await p.page.getByRole('heading', { name: 'Appearance' }).waitFor();
    }
  }
  await p.page.getByRole('radio', { name: 'Dark', exact: true }).click();
  // a fresh page load paints dark from the first frame (theme-init.js runs before the app)
  await p.page.route('**/assets/index-*.js', async (r) => { await new Promise((ok) => setTimeout(ok, 2500)); await r.continue().catch(() => {}); });
  await p.page.reload({ waitUntil: 'commit' });
  await p.page.waitForFunction(() => document.querySelector('script[src="/theme-init.js"]') && document.body);
  const early = await p.page.evaluate(() => !document.querySelector('#root')?.childElementCount && document.documentElement.dataset.theme);
  await p.page.unroute('**/assets/index-*.js');
  await p.page.getByRole('radio', { name: 'System', exact: true }).waitFor();
  check(early === 'dark', 'the theme is set before the app loads after a reload');
  await p.page.getByRole('radio', { name: 'System', exact: true }).click();
  await p.page.emulateMedia({ colorScheme: 'dark' });
  await p.page.waitForTimeout(100);
  check((await theme(p)) === 'dark', 'System switches to dark when the OS does');
  await p.page.emulateMedia({ colorScheme: 'light' });
  await p.page.waitForTimeout(100);
  check((await theme(p)) === 'light', 'and back to light');

  // ---- settings sections (desktop)
  for (const [name, id, heading] of [['Devices and sync', 'devices', 'Devices'], ['Privacy', 'privacy', 'Identity fingerprint'], ['Storage', 'storage', 'Your repos'], ['Account', 'account', 'Danger zone']]) {
    await p.page.getByRole('link', { name }).click();
    await p.page.getByRole('heading', { name: heading, exact: true }).waitFor();
    check((await p.page.evaluate(() => location.hash)) === `#/settings/${id}` && (await p.page.getByRole('link', { name }).getAttribute('aria-current')) === 'page', `${name} opens in its own section`);
    await p.page.screenshot({ path: `${SHOTS}/settings-${id}.png` });
  }
  check((await p.page.locator('.settings-side').isVisible()) && (await p.page.locator('.settings-main').isVisible()), 'desktop shows the section list and the section side by side');
  await p.page.getByRole('link', { name: 'Chats' }).click();
  await p.page.locator('.chat-item').first().waitFor();
  await p.page.getByRole('link', { name: 'Turn on sync' }).click({ timeout: 1000 }).catch(() => {}); // only shown while sync is off
  if ((await p.page.evaluate(() => location.hash)) === '#/settings/devices') check(true, '"Turn on sync" opens Devices and sync');

  // ---- phone
  const ph = await person('carol', { phone: true });
  await ph.page.goto(BASE + '#/settings');
  await ph.page.getByRole('link', { name: 'Privacy' }).waitFor();
  check(!(await ph.page.locator('.settings-main').isVisible()), 'phone: Settings starts as a list');
  check(!(await ph.page.locator('.side-resizer').isVisible()), 'phone: no resize handle');
  await ph.page.screenshot({ path: `${SHOTS}/phone-settings.png` });
  await ph.page.getByRole('link', { name: 'Appearance' }).click();
  await ph.page.getByRole('heading', { name: 'Appearance' }).waitFor();
  check(!(await ph.page.locator('.settings-side').isVisible()), 'phone: a section takes the whole screen');
  await ph.page.getByRole('radio', { name: 'Dark dimmed', exact: true }).click();
  await ph.page.waitForTimeout(200);
  await ph.page.screenshot({ path: `${SHOTS}/phone-appearance.png` });
  const overflow = await ph.page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check(!overflow, 'phone: nothing scrolls sideways');
  await ph.page.getByRole('link', { name: 'Settings' }).click();
  await ph.page.getByRole('link', { name: 'Privacy' }).waitFor();
  check(true, 'phone: back returns to the list');
  await ph.page.screenshot({ path: `${SHOTS}/phone-settings-dimmed.png` });

  // ---- a newer build on the server: the tab offers a reload
  const nv = ph.page.locator('.notice.info');
  check(!(await nv.isVisible()), 'no "New version" while the build is current');
  await ph.page.route(BASE, (r) => r.request().resourceType() === 'fetch' ? r.fulfill({ contentType: 'text/html', body: '<script type="module" src="/assets/index-Newer123.js"></script>' }) : r.continue());
  await ph.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await nv.waitFor({ timeout: 5000 });
  check(true, '"New version" shows once the server has another build');
  await ph.page.screenshot({ path: `${SHOTS}/phone-new-version.png` });
  await ph.page.unroute(BASE);
  await nv.getByRole('button', { name: 'Reload' }).click();
  await ph.page.getByRole('link', { name: 'Privacy' }).waitFor();
  check(!(await nv.isVisible()), 'Reload loads the current build');
} catch (e) {
  failures++;
  log('ERROR', e.message);
}
await browser.close();
log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
