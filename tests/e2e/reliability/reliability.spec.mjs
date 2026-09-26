// Reliability: inject network faults on the approval verify RPC (a known flow) and prove the UI
// never shows false success and surfaces an error. Uses page.route AFTER staging init.
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { useStaging, assertStagingOnly } from '../helpers/staging.mjs';
import { createApprovalFixture, reStoreOtp } from '../helpers/fixtures.mjs';

test.beforeAll(() => requireStagingEnv());

async function reachOtp(page, fx) {
  await useStaging(page);
  await page.goto('/approve.html?token=' + fx.token);
  await assertStagingOnly(page);
  await page.locator('#c_name').fill('E2E Client');
  await page.locator('#c_phone').fill(fx.phone);
  await page.locator('#sendOtp').click();
  await expect(page.locator('#c_otp')).toBeVisible({ timeout: 10_000 });
  await reStoreOtp(fx.token, fx.phone, fx.code);
}

test('@reliability REL-10 HTTP 500 on verify → no false success', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtp(page, fx);
  await page.route('**/rest/v1/rpc/verify_and_consent', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }));
  await page.locator('#c_otp').fill(fx.code);
  await page.locator('#c_agree').check();
  await page.locator('#confirmBtn').click();
  await page.waitForTimeout(1200);
  await expect(page.locator('#step3'), 'server error must not show approved').toBeHidden();
  await expect(page.locator('#step2')).toBeVisible();
});

test('@reliability REL-04 timeout/abort on verify → no false success, button recovers', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtp(page, fx);
  await page.route('**/rest/v1/rpc/verify_and_consent', (r) => r.abort());
  await page.locator('#c_otp').fill(fx.code);
  await page.locator('#c_agree').check();
  await page.locator('#confirmBtn').click();
  await page.waitForTimeout(1200);
  await expect(page.locator('#step3')).toBeHidden();
  await expect(page.locator('#confirmBtn')).toBeEnabled(); // recovers, allows retry
});

test('@reliability REL-01 offline during verify → no false success', async ({ page, context }) => {
  const fx = await createApprovalFixture();
  await reachOtp(page, fx);
  await context.setOffline(true);
  await page.locator('#c_otp').fill(fx.code);
  await page.locator('#c_agree').check();
  await page.locator('#confirmBtn').click();
  await page.waitForTimeout(1200);
  await expect(page.locator('#step3')).toBeHidden();
  await context.setOffline(false);
});
