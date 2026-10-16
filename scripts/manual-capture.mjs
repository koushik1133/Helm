// Headed capture for the user manual. The OWNER signs in by hand in the window
// this opens (script never types credentials), then it captures 1440x900 @2x.
// Usage: EVENT_ID=<QA-E2E quote id> node manual-capture.mjs
import { chromium } from '/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-0052/node_modules/playwright/index.mjs';
const OUT = '/Users/koushikgoudshaganti/Desktop/Agency/Helm/wt-side/docs/product/img/';
const B = 'http://127.0.0.1:4401', S = process.env.STUDIO || 'staging-demo', E = process.env.EVENT_ID || '';
const ctx = await chromium.launchPersistentContext('/private/tmp/helm-manual-capture-profile', {
  headless: false, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
  executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' });
const p = ctx.pages()[0] || await ctx.newPage();
await p.goto(B + '/login');
console.log('Sign in in the opened window; waiting up to 15 min...');
await p.waitForURL(/\/dashboard/, { timeout: 900000 });
const shots = [
  ['20-dashboard', `/${S}/dashboard`], ['21-leads-board', `/${S}/leads`], ['22-quotes', `/${S}/quotes`],
  ['23-chat', `/${S}/chat`], ['24-calendar', '/calendar'], ['25-business', '/business'], ['26-reports', '/reports'],
  ['27-insights', '/insights'], ['28-control-center', '/control'], ['29-audit-log', '/audit'], ['30-inventory', '/inventory'],
  ['31-vendors', '/vendors'], ['32-crm', '/crm'],
];
if (E) for (const [n, pg] of [['plan', 'plan'], ['flow', 'flow'], ['ops', 'ops'], ['logistics', 'logistics'], ['runsheet', 'runsheet'],
  ['command', 'command'], ['issues', 'issues'], ['settlement', 'settlement'], ['closure', 'closure'], ['budget', 'budget'], ['staff', 'staff']])
  shots.push([`${50 + shots.length - 13}-event-${n}`, `/${pg}?id=${E}`]);
if (E) shots.push(['40-event-workspace', `/${S}/events/${E}`], ['41-builder', `/${S}/events/${E}/floor-plan`]);
for (const [name, path] of shots) {
  try { await p.goto(B + path, { waitUntil: 'networkidle', timeout: 30000 }); await p.waitForTimeout(2500);
    await p.screenshot({ path: OUT + name + '.png' }); console.log('ok', name, p.url()); }
  catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); }
}
await ctx.close();
