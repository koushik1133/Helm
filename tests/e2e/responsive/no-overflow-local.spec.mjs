// R123b - responsive guard that needs NO credentials and NO network: every request that is not this local server is
// blocked, and config.js / config.staging.js are served with the Supabase url + key blanked, so the app runs in its
// local (offline) mode. Checks: no horizontal page scroll on the public pages + the app shell at phone / tablet /
// desktop widths, the sign-in two-step set-up card (QR + key stacked, key readable), and the HQ click-through demo
// (Plans, HQ team, the "? Tour" button clear of the phone bottom bar).
import { test, expect } from '@playwright/test';

const WIDTHS = [320, 375, 768, 1280];
const PAGES = ['index.html', 'pricing.html', 'about.html', 'services.html', 'contact-sales.html', 'suggest.html', 'privacy.html',
  'terms.html', 'login.html', 'reset-password.html', 'try.html', 'refer.html', 'invite-studio.html', 'checkout.html',
  'dashboard.html', 'calendar.html', 'quotes.html', 'leads.html', 'event.html', 'control.html', 'onboarding.html'];

async function offline(context, blank = true) {
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (!/^(127\.0\.0\.1|localhost)$/.test(u.hostname)) return route.abort();
    if (blank && /\/config(\.staging)?\.js$/.test(u.pathname)) {
      const r = await route.fetch();
      const body = (await r.text()) + '\n;try{window.SUPABASE_CONFIG.url="";window.SUPABASE_CONFIG.anonKey="";}catch(e){}\n';
      return route.fulfill({ response: r, body });
    }
    return route.continue();
  });
  await context.addInitScript(() => { try { localStorage.setItem('bp_seen_tour', '1'); } catch (e) {} });
}
const overflow = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));

test.describe('@responsive local (no sign-in)', () => {
  // the sign-in page needs accounts "configured" (in offline mode it forwards to the dashboard), so it keeps the
  // config - every Supabase request is still blocked, nothing leaves this computer
  test.beforeEach(async ({ context }, info) => { await offline(context, !/two-step/.test(info.title)); });

  for (const w of WIDTHS) {
    test(`public + app pages: no horizontal scroll @ ${w}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: w, height: w < 768 ? 812 : 900 });
      const bad = [];
      for (const p of PAGES) {
        await page.goto('/' + p, { waitUntil: 'load' });
        await page.waitForTimeout(600);
        const o = await overflow(page);
        if (o.sw > o.w + 1) bad.push(`${p} (${o.sw} > ${o.w})`);
      }
      expect(bad, 'pages wider than the screen').toEqual([]);
    });
  }

  test('two-step set-up card: QR above the key in the narrow sign-in card; key readable; Copy normal size', async ({ page }) => {
    for (const [w, h] of [[375, 812], [1100, 800]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/login.html');
      await page.waitForFunction(() => window.HelmAuthUI && window.BPStore);
      await page.evaluate(() => {
        document.querySelectorAll('.formpane > .card, form.card, div.card').forEach((n) => { n.hidden = true; });
        document.getElementById('mfaSetupForm').hidden = false;
        window.BPStore.auth.mfa.enrollTotp = () => Promise.resolve({ factorId: 'f1', qr: '', secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: 'otpauth://totp/Helm:x?secret=JBSWY3DPEHPK3PXP' });
        window.HelmAuthUI.renderEnroll(document.getElementById('mfaSetupBox'), () => {});
      });
      const code = page.locator('.hau-code');
      await expect(code).toHaveText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
      const cb = await code.boundingBox(), copy = await page.locator('.hau-copy').boundingBox();
      expect(cb.width, `key column wide enough @ ${w}`).toBeGreaterThan(150);
      expect(cb.height, `key not one-char-per-line @ ${w}`).toBeLessThan(120);
      expect(copy.height, `Copy button normal height @ ${w}`).toBeLessThan(60);
      const o = await overflow(page);
      expect(o.sw).toBeLessThanOrEqual(o.w + 1);
    }
  });

  test('HQ demo @ 375: Plans + HQ team fit; "? Tour" clear of the bottom bar', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/hq.html?demo=1');
    await page.waitForSelector('#tab-plans', { state: 'attached' });
    await page.waitForTimeout(1500);
    for (const t of ['overview', 'plans', 'staff', 'studios', 'billing']) {
      await page.evaluate((t) => document.getElementById('tab-' + t).click(), t);
      await page.waitForTimeout(500);
      const o = await overflow(page);
      expect(o.sw, `HQ ${t} wider than the screen`).toBeLessThanOrEqual(o.w + 1);
    }
    const fab = await page.locator('.htour-fab').boundingBox();
    const bar = await page.locator('.bnav').boundingBox();
    if (fab && bar) expect(fab.y + fab.height, 'tour button sits above the bottom bar').toBeLessThanOrEqual(bar.y);
  });
});
