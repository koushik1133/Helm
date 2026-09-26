// Extended W10-D1 OTP matrix in the real browser vs the D1-fixed staging DB.
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { useStaging, assertStagingOnly } from '../helpers/staging.mjs';
import { createApprovalFixture, reStoreOtp, svcGet } from '../helpers/fixtures.mjs';

test.beforeAll(() => requireStagingEnv());

async function reachOtp(page, fx) {
  await useStaging(page);
  await page.goto('/approve.html?token=' + fx.token);
  await assertStagingOnly(page);
  await page.locator('#c_name').fill('E2E Client');
  await page.locator('#c_phone').fill(fx.phone);
  await page.locator('#sendOtp').click();
  await expect(page.locator('#c_otp')).toBeVisible({ timeout: 10_000 });
  await reStoreOtp(fx.token, fx.phone, fx.code); // known code becomes newest
}
async function submitOtp(page, code) {
  await page.locator('#c_otp').fill(code);
  if (!(await page.locator('#c_agree').isChecked())) await page.locator('#c_agree').check();
  await page.locator('#confirmBtn').click();
  await page.waitForTimeout(900);
}

test('@approval OTPUI-01..04 five wrong attempts persist and lock; step3 never shows', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtp(page, fx);
  for (let i = 0; i < 5; i++) { await submitOtp(page, '000000'); await expect(page.locator('#step3')).toBeHidden(); }
  const att = (await svcGet('quote_otps?quote_id=eq.' + fx.quoteId + '&order=created_at.desc&limit=1&select=attempts'))[0].attempts;
  expect(att, 'attempts persist to 5 (D1 fix)').toBe(5);
  await submitOtp(page, '000000');
  await expect(page.getByText(/too many attempts/i)).toBeVisible();
  await expect(page.locator('#step3')).toBeHidden();
});

test('@approval OTPUI-05 correct OTP after lockout is denied', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtp(page, fx);
  for (let i = 0; i < 6; i++) await submitOtp(page, '000000');           // lock it
  await submitOtp(page, fx.code);                                        // correct, but locked
  await expect(page.locator('#step3')).toBeHidden();
  await expect(page.getByText(/too many attempts/i)).toBeVisible();
});

test('@approval OTPUI-08 expired OTP denied', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtp(page, fx);
  // expire the current unverified OTPs for this quote
  const { STAGING_URL, SERVICE_ROLE } = await import('../helpers/env.mjs');
  await fetch(STAGING_URL + '/rest/v1/quote_otps?quote_id=eq.' + fx.quoteId, {
    method: 'PATCH', headers: { apikey: SERVICE_ROLE, Authorization: 'Bearer ' + SERVICE_ROLE, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_at: new Date(Date.now() - 60000).toISOString() }),
  });
  await submitOtp(page, fx.code);
  await expect(page.locator('#step3')).toBeHidden();
  await expect(page.getByText(/no active code/i)).toBeVisible();
});

test('@approval OTPUI-09 a consumed OTP cannot be replayed (server-enforced)', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtp(page, fx);
  await submitOtp(page, fx.code);
  await expect(page.locator('#step3')).toBeVisible({ timeout: 10_000 });   // approved once via UI
  const q1 = await svcGet('quotes?id=eq.' + fx.quoteId + '&select=approval_status');
  expect(q1[0].approval_status).toBe('approved');
  // replay the SAME code straight at the RPC (as a client would) — must NOT re-approve
  const { STAGING_URL, STAGING_ANON } = await import('../helpers/env.mjs');
  const r = await fetch(STAGING_URL + '/rest/v1/rpc/verify_and_consent', {
    method: 'POST', headers: { apikey: STAGING_ANON, Authorization: 'Bearer ' + STAGING_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: fx.token, p_phone: fx.phone, p_code: fx.code, p_agreed: true, p_terms_version: 'v', p_consent_text: 'x', p_client_name: 'c', p_user_agent: 't' }),
  });
  const body = await r.json().catch(() => ({}));
  expect(body.approved, 'replayed consumed OTP must not approve').not.toBe(true);
});

test('@approval OTPUI-11 double-click confirm approves at most once', async ({ page }) => {
  const fx = await createApprovalFixture();
  await reachOtp(page, fx);
  await page.locator('#c_otp').fill(fx.code);
  await page.locator('#c_agree').check();
  // fire two clicks; the handler disables the button on first click, so the 2nd is a no-op
  await page.locator('#confirmBtn').click();
  await page.locator('#confirmBtn').click({ force: true, timeout: 1000 }).catch(() => {});
  await expect(page.locator('#step3')).toBeVisible({ timeout: 10_000 });
  const consents = await svcGet('quote_consents?quote_id=eq.' + fx.quoteId + '&select=id');
  expect(consents.length, 'exactly one consent recorded (no double-approve)').toBe(1);
});
