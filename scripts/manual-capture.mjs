// Headed screenshot capture for the user manual (docs/manual/USER-MANUAL.html).
//
// SHOTS below is ALSO the manual's screenshot TODO list: every "Screenshot to add" box in the manual
// (<div class="shot-todo" data-shot="NAME">) has one entry here, with its caption (test/manual-r19.test.mjs
// keeps the two in step). Once NAME is uploaded to the private "helm-manual" bucket under screenshots/,
// /manual swaps the box for the picture by itself (public/manual.js) - no manual edit needed.
//
// The OWNER signs in by hand in the window this opens (the script never types credentials and never
// creates anything). Use a studio with demo data, never real client data. It captures 1440x900 @2x.
//   node scripts/manual-capture.mjs --list                      print the TODO list, no browser
//   HELM_URL=https://staging.example EVENT_ID=<demo quote id> node scripts/manual-capture.mjs
// Optional: PLAYWRIGHT_MODULE (path to playwright's index.mjs), CHROME_PATH (browser executable).
// Shots marked hand:true need a client link or an open dialog - capture those by hand and save them under
// docs/manual/screenshots/ with the same name.
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SHOTS = [
  { name: 'm-signup-trial.png', path: '/login#signup', before: true, caption: 'The sign-up form with the free-trial rules box' },
  { name: 'm-profile-menu.png', path: '/dashboard', click: '#hauAccountBtn', caption: 'The profile menu: Profile, Account settings, User manual, Sign out' },
  { name: 'm-dashboard-resume.png', path: '/dashboard', caption: 'Dashboard with the "Continue where you left off" card and the 7D / 1M / 6M / 1Y switch' },
  { name: 'm-crm.png', path: '/crm', caption: "CRM archive: a client's history on one timeline" },
  { name: 'm-flow.png', path: '/flow?id={E}', caption: 'The 8-step quote flow with the live total in the right-hand rail' },
  { name: 'm-booklet-share.png', path: '/event?id={E}', hand: true, caption: 'The Share booklet dialog: readiness checklist and send box' },
  { name: 'm-invite-studio.png', path: '/invite-studio?quote={E}', caption: 'Invitation Studio: template picker and live preview' },
  { name: 'm-event-stages.png', path: '/event?id={E}', caption: 'Event workspace: stage strip and job cards' },
  { name: 'm-builder-3d.png', path: '/builder?quote={E}', hand: true, caption: 'The same layout in 3D' },
  { name: 'm-shortage.png', path: '/inventory?id={E}', hand: true, caption: 'A reservation with a shortage: "Only 20 free - short by 10" and the ways to cover it' },
  { name: 'm-calendar-events.png', path: '/calendar?cv=events', caption: 'Calendar - Events view (month)' },
  { name: 'm-calendar-team.png', path: '/calendar?cv=team', caption: 'Calendar - Team view (All crew, week)' },
  { name: 'm-chat.png', path: '/chat', caption: 'Team chat with an event group open' },
  { name: 'm-budget.png', path: '/budget?id={E}', caption: 'Budget & margin: requirement lines, suggested lines and totals' },
  { name: 'm-settlement.png', path: '/settlement?id={E}', caption: 'Settlement: client balance, vendors and vendor bills' },
  { name: 'm-cc-users.png', path: '/control#users', caption: 'Control Center - Users & invites' },
  { name: 'm-cc-access.png', path: '/control#access', caption: 'Control Center - Roles & access (the access matrix)' },
  { name: 'm-checkout.png', path: '/checkout', caption: 'Choose your Helm plan' },
];

async function main() {
  if (process.argv.includes('--list')) {
    for (const s of SHOTS) console.log((s.hand ? '[by hand] ' : '') + s.name + '  ' + s.path + '  - ' + s.caption);
    return;
  }
  const OUT = fileURLToPath(new URL('../docs/manual/screenshots/', import.meta.url));
  const B = (process.env.HELM_URL || 'http://127.0.0.1:4401').replace(/\/$/, ''), E = process.env.EVENT_ID || '';
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
  const ctx = await chromium.launchPersistentContext('/private/tmp/helm-manual-capture-profile', {
    headless: false, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const p = ctx.pages()[0] || await ctx.newPage();
  async function shoot(s) {
    try {
      await p.goto(B + s.path.replace('{E}', encodeURIComponent(E)), { waitUntil: 'networkidle', timeout: 30000 });
      await p.waitForTimeout(2500);
      if (s.click) { await p.click(s.click); await p.waitForTimeout(600); }
      await p.screenshot({ path: OUT + s.name });
      console.log('ok', s.name);
    } catch (e) { console.log('FAIL', s.name, String(e && e.message || e).split('\n')[0]); }
  }
  for (const s of SHOTS) if (s.before) await shoot(s);   // signed-out pages first
  await p.goto(B + '/login');
  console.log('Sign in by hand in the opened window (a demo studio); waiting up to 15 min...');
  await p.waitForURL(/\/dashboard/, { timeout: 900000 });
  for (const s of SHOTS) {
    if (s.before) continue;
    if (s.hand) { console.log('BY HAND', s.name, '-', s.caption); continue; }
    if (s.path.includes('{E}') && !E) { console.log('SKIP (set EVENT_ID)', s.name); continue; }
    await shoot(s);
  }
  await ctx.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
