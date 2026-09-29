// @workflow — role-by-role business-simulation screenshots on localhost→STAGING.
// Uses each role's pre-generated storageState (real staging session). Headless.
// Every role also ASSERTS zero production (nqltz…) requests via page.__prodHits.
// Run: npx playwright test --project=chromium --grep @workflow --trace off
import { test, expect } from '@playwright/test';
import { authedPage } from '../helpers/session.mjs';
import { requireStagingEnv } from '../helpers/env.mjs';
import fs from 'node:fs';
import path from 'node:path';

test.beforeAll(() => requireStagingEnv());

const ROOT = path.join(process.cwd(), 'docs', 'workflow', 'screenshots');

// role → { folder, pages:[[urlPath, shotName], …] }. Pages reflect each role's real workflow surface.
const PLAN = {
  admin:       ['01-admin',        [['dashboard.html','01-dashboard'], ['control.html','02-control-center'], ['quotes.html','03-quotes'], ['reports.html','04-reports']]],
  sales:       ['02-sales',        [['dashboard.html','01-dashboard'], ['leads.html','02-leads'], ['crm.html','03-crm']]],
  planner:     ['03-planner',      [['dashboard.html','01-dashboard'], ['quotes.html','02-quotes'], ['discovery.html','03-discovery'], ['proposal.html','04-proposal'], ['builder.html','05-builder']]],
  client:      ['04-client',       [['dashboard.html','01-dashboard']]],
  manager:     ['05-manager',      [['dashboard.html','01-dashboard'], ['settlement.html','02-settlement'], ['closure.html','03-closure']]],
  coordinator: ['06-coordinator',  [['dashboard.html','01-dashboard'], ['plan.html','02-plan'], ['resources.html','03-resources']]],
  operations:  ['07-operations',   [['dashboard.html','01-dashboard'], ['ops.html','02-ops'], ['runsheet.html','03-runsheet'], ['inventory.html','04-inventory']]],
  worker:      ['08-worker',       [['dashboard.html','01-dashboard']]],
  supervisor:  ['09-supervisor',   [['dashboard.html','01-dashboard']]],
  quality:     ['10-quality',      [['dashboard.html','01-dashboard']]],
  crew:        ['11-crew',         [['dashboard.html','01-dashboard']]],
};

for (const [role, [folder, pages]] of Object.entries(PLAN)) {
  test(`@workflow ${role} — real staging pages`, async ({ browser }) => {
    const { context, page } = await authedPage(browser, role);
    const outDir = path.join(ROOT, folder);
    fs.mkdirSync(outDir, { recursive: true });
    try {
      for (const [p, name] of pages) {
        await page.goto('/' + p).catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(600);
        await page.screenshot({ path: path.join(outDir, name + '.png'), fullPage: true });
      }
      // staging guard: this role must never have hit production
      expect(page.__prodHits, `role ${role} must make ZERO production requests`).toEqual([]);
    } finally { await context.close(); }
  });
}
