// Screenshots of every UI screen (light, dark, phone width) plus console and
// CSP errors, with secrets redacted. Needs Playwright, kept outside the repo:
//   mkdir -p /tmp/shots && cd /tmp/shots && npm i playwright@1 && npx playwright install --with-deps chromium
//   cp test/ui-screens.mjs /tmp/shots/ && node /tmp/shots/ui-screens.mjs http://10.30.30.54:30310 /tmp/shots
// (ES modules ignore NODE_PATH; `playwright` resolves from the script's own
// directory, hence the copy.)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const BASE = process.argv[2], OUT = process.argv[3] ?? '.';
const pw = readFileSync(process.env.UI_PASSWORD_FILE ?? process.env.HOME + '/midori-build/tenant-ui-admin', 'utf8').trim();
const problems = [];
const browser = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(`${scheme} console ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${scheme} pageerror: ${e.message}`));
  await page.goto(BASE);
  await page.waitForSelector('#login-form:visible');
  if (scheme === 'light') await page.screenshot({ path: `${OUT}/1-login.png` });
  await page.fill('[name=user]', 'admin'); await page.fill('[name=password]', pw);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#tenant-rows tr');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/2-dashboard-${scheme}.png`, fullPage: true });
  if (scheme === 'dark') { await ctx.close(); continue; }
  // the bars must have width (the CSP would silently drop style attributes)
  const widths = await page.$$eval('.bar > .u', (els) => els.map((e) => e.style.width));
  problems.push(`bar widths: ${widths.filter((w) => w && w !== '0%').length} of ${widths.length} non-zero`);
  await page.click('#tenant-rows tr:has-text("tenant-phoenix-serving")');
  await page.waitForSelector('#detail[open]');
  await page.screenshot({ path: `${OUT}/3-detail.png` });
  await page.click('text=Show credentials');
  await page.waitForSelector('text=Grafana password');
  await page.evaluate(() => { for (const i of document.querySelectorAll('.secret input')) if (/password|secret key/i.test(i.getAttribute('aria-label'))) i.value = '•••••••••••• (redacted for screenshot)'; });
  await page.locator('#detail .drawer-body').evaluate((e) => e.scrollTo(0, e.scrollHeight));
  await page.screenshot({ path: `${OUT}/4-handover.png` });
  await page.click('#detail [data-close]');
  await page.click('#new-tenant');
  await page.waitForSelector('#editor[open]');
  await page.fill('#editor-form [name=name]', 'tenant-demo'); await page.fill('#editor-form [name=gpus]', '2');
  await page.screenshot({ path: `${OUT}/5-new-tenant.png` });
  await page.click('#editor [data-close]');
  await page.click('#tenant-rows tr:has-text("tenant-nv-b")');
  await page.click('text=Delete…');
  await page.fill('#deleter-form [name=confirm]', 'tenant-nv');
  await page.screenshot({ path: `${OUT}/6-delete.png` });
  problems.push(`delete button enabled with partial name: ${await page.isEnabled('#deleter-submit')}`);
  await page.click('#deleter [data-close]');
  await ctx.close();
}
const mobile = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 1 });
const m = await mobile.newPage();
await m.goto(BASE); await m.fill('[name=user]', 'admin'); await m.fill('[name=password]', pw);
await m.click('#login-form button[type=submit]'); await m.waitForSelector('#tenant-rows tr'); await m.waitForTimeout(300);
await m.screenshot({ path: `${OUT}/7-mobile.png`, fullPage: true });
const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
problems.push(`mobile page scrolls horizontally: ${overflow}`);
await browser.close();
console.log(problems.join('\n') || 'no problems');
