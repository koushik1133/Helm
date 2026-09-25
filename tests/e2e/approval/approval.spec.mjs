// The critical W10-D1 regression, end to end in a real browser against the D1-fixed staging DB:
// a wrong/soft-returned OTP must NEVER show the approved step; a correct OTP approves exactly once.
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { useStaging, assertStagingOnly } from '../helpers/staging.mjs';
import { createApprovalFixture, reStoreOtp, svcGet } from '../helpers/fixtures.mjs';

test.beforeAll(() => requireStagingEnv());

async function reachOtpStep(page, fx) {
  await useStaging(page);
  await page.goto('/approve.html?token=' + fx.token);
  await assertStagingOnly(page);
  await page.locator('#c_name').fill('E2E Client');
  await page.locator('#c_phone').fill(fx.phone);
  await page.locator('#sendOtp').click();
  await expect(page.locator('#c_otp')).toBeVisible({ timeout: 10_000 });
  // send-otp created a random newest OTP; re-store our known code as newest so we control the value
  await reStoreOtp(fx.token, fx.phone, fx.code);
}

test('@security wrong OTP soft-return does NOT advance to approved step', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtpStep(page, fx);
  await page.locator('#c_otp').fill('000000');
  await page.locator('#c_agree').check();
  await page.locator('#confirmBtn').click();
  await page.waitForTimeout(1500);
  await expect(page.locator('#step3'), 'approved step must stay hidden on wrong OTP').toBeHidden();
  await expect(page.locator('#step2'), 'must remain on OTP step').toBeVisible();
});

test('@security correct OTP approves exactly once and records server-side', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtpStep(page, fx);
  await page.locator('#c_otp').fill(fx.code);
  await page.locator('#c_agree').check();
  await page.locator('#confirmBtn').click();
  await expect(page.locator('#step3'), 'approved step shows on correct OTP').toBeVisible({ timeout: 10_000 });
  const q = await svcGet('quotes?id=eq.' + fx.quoteId + '&select=approval_status');
  expect(q[0].approval_status, 'server records approval').toBe('approved');
});
