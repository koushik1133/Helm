// UI login helper — authenticates through the REAL login page (no service_role impersonation).
import { expect } from '@playwright/test';
import { emailFor, PASSWORD } from './env.mjs';
import { useStaging } from './staging.mjs';

export async function loginAs(page, role) {
  await useStaging(page);
  await page.goto('/login.html');
  await page.locator('#email, input[type=email]').first().fill(emailFor(role));
  await page.locator('#password, input[type=password]').first().fill(PASSWORD);
  await page.locator('#submit').click();   // the Sign-in button (not the signup #ob_submit)
  // land on dashboard (cleanUrls => /dashboard)
  await page.waitForURL(/\/dashboard/, { timeout: 25_000 });
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
