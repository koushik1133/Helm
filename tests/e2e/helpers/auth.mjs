// UI login helper — authenticates through the REAL login page (no service_role impersonation).
import { expect } from '@playwright/test';
import { emailFor, PASSWORD } from './env.mjs';
import { useStaging } from './staging.mjs';

// Login via the real UI. Proven Wave-13 form (was 27/27 green cross-browser): the app redirects to
// /dashboard only after a successful sign-in, so waitForURL is the authoritative success signal.
export async function loginAs(page, role) {
  await useStaging(page);
  await page.goto('/login.html');
  await page.locator('#email, input[type=email]').first().fill(emailFor(role));
  await page.locator('#password, input[type=password]').first().fill(PASSWORD);
  await page.locator('#submit').click();   // the Sign-in button (not the signup #ob_submit)
  // The authoritative "sign-in succeeded" signal is the persisted session token — it appears right
  // after signIn(), BEFORE login.html's slow post-signin redirect (passwordChangeRequired +
  // finishPendingStudio DB calls, W14-O1). Wait for the token, then navigate to the dashboard
  // explicitly rather than depending on the laggy auto-redirect. Fail fast on a visible login error.
  await Promise.race([
    page.waitForFunction(() => { try { return Object.keys(localStorage).some(k => k.includes('auth-token')); } catch { return false; } }, null, { timeout: 30_000 }),
    page.locator('#err:visible').waitFor({ state: 'visible', timeout: 30_000 })
      .then(async () => { throw new Error('login error: ' + ((await page.locator('#err').textContent()) || '').trim()); }),
  ]);
  if (!/\/dashboard/.test(page.url())) await page.goto('/dashboard.html');
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  return page;
}

export async function logout(page) {
  // logout control is a link/button labelled "Log out"
  const lo = page.getByText(/log ?out/i).first();
  if (await lo.count()) {
    await Promise.all([
      page.waitForURL(/\/login|\/$|\/index/, { timeout: 10_000 }).catch(() => {}),
      lo.click().catch(() => {}),
    ]);
  }
  await page.waitForTimeout(500);
}
