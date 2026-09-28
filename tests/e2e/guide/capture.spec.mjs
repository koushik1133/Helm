// @guide — captures full-page screenshots of every tester-facing screen into
// docs/tester-guide/screens/. Not a functional test; it documents the app.
// Run: npx playwright test --project=chromium --grep @guide --trace off
import { test } from '@playwright/test';
import { authedPage } from '../helpers/session.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'docs', 'tester-guide', 'screens');
fs.mkdirSync(OUT, { recursive: true });

// a real staging quote (wedding, has data) for event-scoped screens
const QUOTE = 'a5178208-ee9f-41bd-8b6c-ebcfb87df7fa';

async function shoot(page, name) {
  await page.waitForTimeout(700);                 // let async render settle
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
}

test('@guide public pages (landing + sign in / sign up)', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto('/index.html'); await shoot(page, '01-landing');
    await page.goto('/login.html'); await shoot(page, '02-signin-signup');
  } finally { await ctx.close(); }
});

test('@guide authenticated screens (admin walkthrough)', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    const screens = [
      ['dashboard.html', '03-dashboard'],
      ['leads.html', '04-leads-pipeline'],
      ['crm.html', '05-crm-archive'],
      [`flow.html?quote=${QUOTE}`, '06-event-flow'],
      [`discovery.html?quote=${QUOTE}`, '07-discovery'],
      [`quotes.html`, '08-quotes-list'],
      [`proposal.html?quote=${QUOTE}`, '09-proposal'],
      [`plan.html?quote=${QUOTE}`, '10-planning'],
      [`logistics.html?quote=${QUOTE}`, '11-logistics-payments'],
      [`settlement.html?quote=${QUOTE}`, '12-settlement'],
      [`closure.html?quote=${QUOTE}`, '13-closure-pl'],
      ['staff.html', '14-staff'],
      ['inventory.html', '15-inventory'],
      ['vendors.html', '16-vendors'],
      ['control.html', '17-control-center'],
    ];
    for (const [p, name] of screens) {
      await page.goto('/' + p);
      await page.waitForLoadState('networkidle').catch(() => {});
      await shoot(page, name);
    }
  } finally { await context.close(); }
});
