// Reuse a pre-generated storageState (see global-setup.mjs) for a role, plus staging config injection.
// Returns an authenticated page already on the dashboard — no UI login, so no login-latency flake.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { STAGING_URL, STAGING_ANON } from './env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const statePath = (role) => join(HERE, '..', '.auth', `${role}.json`);

// Create an authenticated context+page for a role via saved storageState (fast, reliable).
export async function authedPage(browser, role) {
  const sp = statePath(role);
  if (!existsSync(sp)) throw new Error(`no storageState for ${role}; global-setup did not run`);
  const context = await browser.newContext({ storageState: sp });
  const page = await context.newPage();
  page.__prodHits = [];
  page.on('request', (req) => { if (req.url().includes('nqltzgiwznphugcfhmbm')) page.__prodHits.push(req.url()); });
  await page.addInitScript(([u, a]) => { window.HELM_STAGING_SUPABASE = { url: u, anonKey: a }; }, [STAGING_URL, STAGING_ANON]);
  await page.goto('/dashboard.html');
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
  return { context, page };
}
