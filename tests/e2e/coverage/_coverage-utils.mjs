// Coverage suite shared utilities (NOT a spec — filename has no .spec/.test so Playwright won't collect it).
// Reuses the existing, unmodified helpers to open an authenticated screen the exact same way the
// rest of the suite does (saved storageState via authedPage + staging config injection).
import { expect } from '@playwright/test';
import { STAGING_URL } from '../helpers/env.mjs';
import { authedPage } from '../helpers/session.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';

// Open a screen authenticated as `role` (admin is safe for every screen).
// authedPage() lands on /dashboard with staging creds injected on every navigation; we then
// attach console/pageerror listeners and navigate to the target screen so the errors we capture
// are the ones produced by THAT screen's load.
export async function openScreen(browser, role, path) {
  const { context, page } = await authedPage(browser, role);
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + (e && e.message ? e.message : String(e))));
  await page.goto(path);
  // Give the app's async boot (BPStore.init + auth gate) a moment to settle or redirect.
  await page.waitForLoadState('networkidle').catch(() => {});
  return { context, page, consoleErrors };
}

// Item 1 — authenticated, no bounce to login.
export function assertNotRedirectedToLogin(page) {
  expect(page.url(), 'screen must render authenticated, not redirect to login').not.toMatch(/login\.html/);
}

// Item 1 — the app selected STAGING (never production) and a top-level heading rendered.
export async function assertScreenRendered(page) {
  await assertStagingOnly(page);
  const h1 = page.getByRole('heading', { level: 1 }).first();
  await expect(h1, 'a top-level heading/landmark must render').toBeVisible();
}

// Item 2 — no error-level console output on load. Static-asset 404s (favicon, etc.) are network
// noise, not app errors, and are excluded; anything the app itself logs at error level fails.
export function assertNoConsoleErrors(consoleErrors) {
  const appErrors = consoleErrors.filter((t) => {
    const s = String(t).toLowerCase();
    if (s.includes('favicon')) return false;
    if (/failed to load resource/.test(s) && /(404|not found)/.test(s)) return false;
    return true;
  });
  expect(appErrors, 'no app console errors on load:\n' + appErrors.join('\n')).toEqual([]);
}

// Fetch the first quote id the current session can see (for event-scoped screens). Mirrors the
// page-side fetch pattern used by roles.spec.mjs (uses the page's own persisted session token).
export async function firstQuoteId(page) {
  return page.evaluate(async ([base]) => {
    let tok = null;
    for (const k of Object.keys(localStorage)) if (k.includes('auth-token')) { try { tok = JSON.parse(localStorage[k]).access_token; } catch {} }
    if (!tok) return null;
    const r = await fetch(base + '/rest/v1/quotes?select=id&limit=1', { headers: { apikey: window.SUPABASE_CONFIG.anonKey, Authorization: 'Bearer ' + tok } });
    const b = await r.json().catch(() => null);
    return Array.isArray(b) && b[0] ? b[0].id : null;
  }, [STAGING_URL]);
}

// Event-scoped screens hide their add controls until an event is selected. Re-navigate to the same
// screen with the session's first visible quote as ?quote=<id> so those controls render. Returns the
// quote id used, or null if the session sees no quote.
export async function gotoWithEvent(page, path) {
  const qid = await firstQuoteId(page);
  if (!qid) return null;
  await page.goto(path + (path.includes('?') ? '&' : '?') + 'quote=' + encodeURIComponent(qid));
  await page.waitForLoadState('networkidle').catch(() => {});
  return qid;
}

// Item 4 (modal-form screens) — open the add form, submit empty, expect a visible validation error.
export async function assertEmptyModalRejected(page, { trigger, save, err }) {
  await page.locator(trigger).click();
  await page.locator(save).click();
  const e = page.locator(err);
  await expect(e, 'empty submit must surface a validation error').toBeVisible();
  await expect(e).not.toHaveText('');
}

// Item 4 (native-alert screens) — click add with empty required input, expect a blocking alert().
export async function assertEmptyAlertRejected(page, trigger) {
  let dialogMsg = null;
  page.once('dialog', async (d) => { dialogMsg = d.message(); await d.dismiss(); });
  await page.locator(trigger).click();
  await expect.poll(() => dialogMsg, 'empty submit must raise a validation alert').not.toBeNull();
  return dialogMsg;
}
