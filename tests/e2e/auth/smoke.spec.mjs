import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { loginAs, logout } from '../helpers/auth.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';

test.beforeAll(() => requireStagingEnv());

test('@smoke admin logs in through the real UI and lands on dashboard (staging)', async ({ page }) => {
  await loginAs(page, 'admin');
  await assertStagingOnly(page);
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/admin\.a@synthetic\.helm/i)).toBeVisible();
});

test('@smoke logout clears session and dashboard bounces to login', async ({ page }) => {
  await loginAs(page, 'admin');
  // ensure the dashboard is fully authenticated before logging out (session settled)
  const loControl = page.getByText(/log ?out/i).first();
  await expect(loControl, 'logout control visible when authenticated').toBeVisible({ timeout: 15_000 });
  await loControl.click();
  // token cleared
  await expect.poll(async () => page.evaluate(
    () => Object.keys(localStorage).some(k => k.includes('auth-token'))
  ), { timeout: 10_000 }).toBe(false);
  // revisiting a protected page bounces to login
  await page.goto('/dashboard.html');
  await page.waitForURL(/\/login/, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/login/);
});
