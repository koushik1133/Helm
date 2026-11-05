// =============================================================================
// r126-hq-browser.harness.mjs - R126 browser check of Helm HQ (Playwright, the REAL hq.html + hq.js + store-api.js).
//
//   [OUT=<screenshot dir>] [PORT=5126] node test/r126-hq-browser.harness.mjs
//
// * Serves this repo's public/ (read-only) on 127.0.0.1. EVERY non-localhost request is answered in-process or aborted:
//   nothing reaches a real database. Supabase (auth + rpc) is a stub, the HQ sign-in is a made-up session.
// * Walks every HQ tab at 1280 + 390 wide, opens one studio, and checks:
//     - the page never asks for a studio-app call (those are refused for HQ staff),
//     - no horizontal page scroll, no CSP or console error,
//     - the R126 display fixes (one trial day, plain log words, owner history lines, Last active column on screen ...).
// Exit code 1 when any check fails. Not part of `npm test` (needs Chromium).
// =============================================================================
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const OUT = process.env.OUT || '/tmp/r126-hq-shots';
const PORT = Number(process.env.PORT || 5126);
mkdirSync(OUT, { recursive: true });
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright');

const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const CSP = String((vercel.headers.flatMap((h) => h.headers).find((x) => /^content-security-policy$/i.test(x.key)) || {}).value || '')
  .replace(/connect-src /, 'connect-src http://127.0.0.1:* https://stub-r126.supabase.co ');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = decodeURIComponent(u.pathname); if (p === '/hq' || p === '/') p = '/hq.html';
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB) || !existsSync(f)) { res.writeHead(404); res.end('nope'); return; }
  // the real page policy from vercel.json, so a change that breaks the strict CSP fails here
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', ...(f.endsWith('.html') ? { 'content-security-policy': CSP } : {}) });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---- made-up data (never a real studio) ------------------------------------------------------------------------------
const ORG = '11111111-1111-4111-8111-111111111111', ORG2 = '22222222-2222-4222-8222-222222222222', ME = '99999999-9999-4999-8999-999999999999';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOW = Math.floor(Date.now() / 1000);
const JWT = [b64({ alg: 'HS256', typ: 'JWT' }), b64({ sub: ME, aal: 'aal2', amr: [{ method: 'totp', timestamp: NOW }], exp: NOW + 7200, role: 'authenticated', session_id: 'aaaa' }), 'c3R1Yi1zaWduYXR1cmU'].join('.');
const USER = { id: ME, aud: 'authenticated', role: 'authenticated', email: 'owner@example.test', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {},
  factors: [{ id: 'f1', factor_type: 'totp', status: 'verified', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], created_at: new Date().toISOString() };
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString();
const PERMS = ['*'];
const OVERVIEW = { studios: { total: 15, by_status: { trial: 6, active: 1, past_due: 1, none: 6 } }, users: { total: 69, active_7d: 3 }, mfa: { users_with_mfa: 1, users_total: 69, pct: 1.4 },
  billing: { mrr: [{ currency: 'INR', amount: 3999 }], paid_this_month: [], past_due_count: 1, suspended_count: 0, reminders_pending: 1 }, signups_30d: [] };
const METRICS = { studios: { total: 14, paying: 1, trial: 6, past_due: 1, suspended: 0, active_30d: 3, new_30d: 5, new_prev_30d: 2 }, conversion: { pct: 50, converted: 1, trials_ended: 2 },
  signups_weekly: [{ week: '2026-10-19', studios: 2 }, { week: '2026-10-26', studios: 1 }], mrr_monthly: [{ month: '2026-10', mrr: 3389, collected: 3999 }, { month: '2026-11', mrr: 3389, collected: 0 }],
  plan_mix: [{ plan: 'Studio', code: 'studio', studios: 1 }], funnel: { signed_up: 14, on_trial: 6, added_team: 3, paid: 1 },
  attention: { trials_ending: [{ org_id: ORG, name: 'Org A', ends_at: '2026-11-07T19:30:00+00:00', timezone: 'Asia/Kolkata' }], trials_ending_count: 1, past_due: [], at_risk: [], new_plan_requests: 1, new_sales_enquiries: 0, new_suggestions: 1 },
  top_usage: [{ org_id: ORG, name: 'Org A', status: 'trial', plan: null, active_30d: 2, people: 3, last_sign_in: iso(-1) }],
  health: { queues: [{ name: 'helm_notice_outbox', label: 'Helm e-mails (sales, trial, digests)', waiting: 7, failed_7d: 0, sent_24h: 0, oldest_waiting: iso(-3) }, { name: 'welcome_email_outbox', label: 'Welcome e-mails', waiting: 31, failed_7d: 0, sent_24h: 0, oldest_waiting: iso(-4) }],
    cron: { readable: false, reason: 'not_installed', jobs: [] } } };
const STUDIO_ROW = { org_id: ORG, name: 'Org A', slug: 'org-a', created_at: iso(-3), owner_email: 'ow•••@example.test', users_count: 1, plan_code: null, plan_name: null, status: 'trial', last_activity: iso(-1), total_paid: 0, country: 'IN', state: 'Telangana', primary_contact_name: 'A rather long contact name', primary_contact_email: 'ow•••@example.test', primary_contact_phone: '+91 ••••••••10', total_count: 2 };
const DETAIL = { org_id: ORG, name: 'Org A', slug: 'org-a', created_at: iso(-3), users_count: 1, status: 'trial', total_paid: 0, paid_by_currency: [], last_active_at: iso(-1),
  subscription: { status: 'trial', plan_name: null, trial_ends_at: '2026-11-07' }, account: { primary_contact_name: 'Owner', primary_contact_email: 'ow•••@example.test', country: 'IN', billing_currency: 'INR' },
  members: [{ user_id: ME.replace(/9/g, '8'), display_name: 'Owner', email: 'ow•••@example.test', role: 'admin', active: true, last_sign_in_at: iso(-1), mfa_enabled: false }], payments: [], referral: {} };
const FIX = {
  is_platform_operator: true, is_platform_admin: true, operator_mfa_required: true, password_change_required: false, staff_google_session_check: { needs_google: false },
  hq_me: { role: 'owner', role_label: 'Owner', perms: PERMS, status: 'active', has_2step: true, needs_2step: false, idle_minutes: 30, max_hours: 12 },
  hq_my_session: { sid: 'abcd', started_at: iso(-0.01), hard_end_at: iso(0.4) }, hq_heartbeat: { ok: true }, hq_overview: OVERVIEW, hq_metrics: METRICS,
  hq_plans: [{ code: 'starter', name: 'Starter', price_monthly: 1499, currency: 'INR', active: true, studios: 0 }, { code: 'studio', name: 'Studio', price_monthly: 3999, currency: 'INR', active: true, studios: 1 }],
  hq_plan_checkout: [{ code: 'studio', name: 'Studio', description: 'For teams', features: ['a'], prices: [{ currency: 'INR', monthly: 3999, yearly: 39990, razorpay_plan_id_monthly: 'plan_ABCDEFGHIJKL', razorpay_plan_id_yearly: null }, { currency: 'USD', monthly: 48, yearly: 480 }] }],
  hq_tax_rules: [], hq_studios: [STUDIO_ROW, Object.assign({}, STUDIO_ROW, { org_id: ORG2, name: 'A much longer studio name with a long link', slug: 'a-much-longer-studio-name-link', status: 'active', plan_name: 'Studio', total_paid: 3999, last_activity: iso(-20) })],
  hq_users: [{ user_id: ME, email: 'ad•••@example.test', studio: 'Helm HQ', org_id: null, role: 'HQ Owner', created_at: iso(-100), last_sign_in_at: iso(0), email_confirmed: true, mfa_enabled: true, total_count: 2 },
    { user_id: ME.replace(/9/g, '7'), email: 'pe•••@example.test', studio: null, org_id: null, role: 'No studio yet', created_at: iso(-2), last_sign_in_at: null, email_confirmed: false, mfa_enabled: false, total_count: 2 }],
  hq_billing: { from: '2026-11-01', to: '2026-11-05', collected: [{ currency: 'INR', amount: 3999 }], payments_count: 1, voided_count: 0, mrr: [{ currency: 'INR', amount: 3999 }], past_due: [], reminders: [],
    payments: [{ id: 'p1', org_id: ORG2, paid_on: '2026-11-01', studio: 'A much longer studio name', invoice_no: 'HELM-1', method: 'upi', period_start: '2026-11-01', period_end: '2026-11-30', amount: 3999, currency: 'INR' }] },
  hq_unrealised_exports: [], hq_studio_detail: DETAIL, hq_studio_credits: { credits: [], months_total: 0 },
  hq_trial_info: { status: 'trial', trial_ends_at: '2026-11-07T19:30:00+00:00', timezone: 'Asia/Kolkata', can_extend: true, extension: null, locked: false, trial_mode: 'demo' },
  hq_studio_usage: { people: 1, people_active_7d: 1, people_active_30d: 1, payments_to_helm: 0, hq_changes: [{ at: iso(-1), actor_email: 'owner@example.test', action: 'hq.trial.extend' }] },
  hq_studio_owner_info: { owner: { user_id: ME.replace(/9/g, '8'), name: 'Owner', email: 'ow•••@example.test' }, owner_missing: false, admins: [],
    history: [{ source: 'backfill_creator', at: iso(-3), owner_email: 'ow•••@example.test', owner_user_id: ME.replace(/9/g, '8'), by_email: 'ow•••@example.test', by_user_id: ME.replace(/9/g, '8'), reason: 'a fairly long reason that used to squeeze the first column down to a single letter per line' }] },
  hq_sales_requests: { counts: { new: 1 }, rows: [] }, hq_sales_enquiries: { counts: {}, rows: [], settings: { notify_email: 'notifications@helm.events', auto_reply: true, form_open: true } }, hq_suggestions: { counts: { new: 1 }, rows: [] },
  hq_audit: { rows: [{ at: iso(-0.1), actor_email: 'owner@example.test', action: 'hq.view', entity: 'hq_studio_detail', entity_id: ORG, studio: 'Org A' }, { at: iso(-0.2), actor_email: 'owner@example.test', action: 'hq.reveal', entity: 'member', entity_id: ME, changed: { field: 'email' } },
    { at: iso(-0.3), actor_email: 'owner@example.test', action: 'hq.payment.record', entity: 'subscription_payments', entity_id: ORG2, studio: 'Org B' }, { at: iso(-0.4), actor_email: 'owner@example.test', action: 'hq.billing.settings', entity: 'hq_billing_settings', entity_id: null }] },
  hq_security_alerts: { total: 1, by_studio: [], latest: [] },
  hq_staff_list: { settings: { idle_minutes: 30, max_hours: 12, reauth_minutes: 15 }, events: [{ at: iso(-1), kind: 'removed', email: 'old-owner@example.test', by: 'owner@example.test' }],
    staff: [{ email: 'owner@example.test', role: 'owner', role_label: 'Owner', status: 'active', has_login: true, has_2step: true, is_me: true, last_sign_in_at: iso(0), last_active_at: iso(0), views_7d: 1, sessions: [], recent: [] },
      { email: 'security@example.test', role: 'security', role_label: 'Security', status: 'active', has_login: false, has_2step: false, last_active_at: null, views_7d: 0, sessions: [], recent: [] }] },
  hq_staff_access: { domains: [{ domain: 'helm.events', include_subdomains: true, builtin: true }], allowlist: [{ email: 'old-owner@example.test', is_platform_admin: true, hq_status: 'removed', has_login: true }], accounts: [{ email: 'someone@helm.events', allowlisted: false, created_at: iso(-3) }] },
  hq_staff_google_only: { on: false, staff: [], my_session_google: false },
  hq_mfa_readiness: { hq_require_mfa: true, operators: [{ email: 'owner@example.test', has_login: true, has_2step: true, is_me: true }], studio_admins: { total: 15, with_2step: 0 } },
  hq_billing_settings: { legal_name: 'Helm', gstin: '', address: '', seller_country: 'IN', gst_rate: 18, invoice_prefix: 'HELM-', allow_trial_bypass: false, online_payments_live: false },
  hq_my_sessions: { rows: [{ sid: 'abcd', device: 'Chrome (Mac OS X)', location: 'Hyderabad, India', signed_in: iso(0), last_active: iso(0), ip: '203.0.113.x', status: 'current', is_current: true, can_sign_out: false }], total: 1, other_active: 0 },
};
const STUDIO_APP = /^(my_|get_|current_org|set_|seed_|list_)/;   // anything from the studio app on the HQ page

async function run(width, height) {
  const fails = [], rpcs = [], refused = [], cons = [];
  const ok = (c, m) => { console.log((c ? '  ok ' : '  FAIL ') + '[' + width + '] ' + m); if (!c) fails.push(m); };
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block' });
  // a made-up project address: config.js on localhost never uses the production project
  await ctx.addInitScript(([k, v]) => { window.SUPABASE_STAGING = window.HELM_STAGING_SUPABASE = { url: 'https://stub-r126.supabase.co', anonKey: 'stub-not-a-real-key' }; try { localStorage.setItem(k, v); } catch (e) {} },
    ['sb-stub-r126-auth-token', JSON.stringify({ access_token: JWT, refresh_token: 'r', token_type: 'bearer', expires_in: 7200, expires_at: NOW + 7200, user: USER })]);
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (!u.hostname.endsWith('.supabase.co')) return route.abort();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (u.pathname === '/auth/v1/user') return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(USER) });
    const m = /\/rest\/v1\/rpc\/([a-z0-9_]+)/.exec(u.pathname);
    if (m) {
      rpcs.push(m[1]);
      if (m[1] in FIX) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(FIX[m[1]]) });
      refused.push(m[1]);
      return route.fulfill({ status: 403, headers: cors, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'not authorized' }) });
    }
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '[]' });
  });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') cons.push(m.text()); });
  page.on('pageerror', (e) => cons.push('pageerror: ' + e.message));
  await page.goto(`http://127.0.0.1:${PORT}/hq.html`);
  await page.waitForSelector('#vApp:not([hidden])', { timeout: 20000 }).catch(async (e) => {
    console.log('did not open', page.url(), rpcs.join(), cons.slice(0, 4)); throw e; });
  await page.waitForTimeout(1200);
  const noScroll = async (where) => {
    const d = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    ok(d.s <= d.c + 1, 'no sideways page scroll on ' + where + ' (' + d.s + ' vs ' + d.c + ')');
  };
  const shot = (n) => page.screenshot({ path: path.join(OUT, width + '-' + n + '.png'), fullPage: true });
  await shot('overview'); await noScroll('overview');
  const ovText = await page.textContent('#pane-overview');
  ok(ovText.includes('active + past-due'), 'MRR tile says active + past-due');
  ok(/8 Nov 2026/.test(await page.textContent('#attList')), 'Needs attention shows the studio day (8 Nov)');
  ok(!/isn.t readable/.test(ovText), 'job history says why');
  for (const t of ['studios', 'billing', 'requests', 'plans', 'people', 'activity', 'staff', 'settings', 'privacy', 'account']) {
    if (width < 1024) { await page.evaluate(() => document.querySelector('#btnMenu').click()); await page.waitForTimeout(300); }
    await page.click('#tab-' + t); await page.waitForTimeout(500);
    await shot(t); await noScroll(t);
    if (t === 'studios' && width === 1280) {
      const r = await page.evaluate(() => { const c = document.querySelector('#tStudios tr td:last-child').getBoundingClientRect(), s = document.querySelector('#pane-studios .card').getBoundingClientRect(); return { c: c.right, s: s.right }; });
      ok(r.c <= r.s, 'Last active stays inside the Studios card at 1280 (' + Math.round(r.c) + ' <= ' + Math.round(r.s) + ')');
    }
    if (t === 'activity') { const a = await page.textContent('#tAudit'); ok(!/hq_|hq\.|subscription_payments/.test(a), 'activity log has no internal names: ' + a.slice(0, 120)); ok(a.includes('Org B'), 'activity log names the studio'); }
    if (t === 'plans') { const p = await page.textContent('#pane-plans'); ok(!/SQL 0280|prices shown in US dollars/.test(p), 'Plans has no stale text'); ok(/₹3,999/.test(await page.textContent('#tPlans')), 'rupee column shows rupees'); }
    if (t === 'staff') { const s = await page.textContent('#pane-staff'); ok(/No login yet/.test(await page.textContent('#tmList')), 'a person with no login does not read Active'); ok(!/R21-|STAFF-GOOGLE|\.md/.test(s), 'no file names on HQ team'); }
    if (t === 'privacy') { const s = await page.textContent('#pane-privacy'); ok(!/\.md/.test(s), 'no file names on Data & privacy'); }
    if (t === 'settings') { ok(/GSTIN/.test(await page.textContent('#sellerWarn')), 'blank seller GSTIN is called out'); }
    if (t === 'billing') { ok(/plan dates/.test(await page.textContent('#pane-billing')), 'Record payment warns about the plan dates'); }
  }
  if (width < 1024) { await page.evaluate(() => document.querySelector('#btnMenu').click()); await page.waitForTimeout(300); }
  await page.click('#tab-studios'); await page.waitForTimeout(300);
  await page.click('#tStudios tr td:first-child strong'); await page.waitForTimeout(700);
  await shot('studio-overview');
  ok(/1 person/.test(await page.textContent('#dMeta')), 'one person, not "1 people"');
  await page.click('#dt-plan'); await page.waitForTimeout(400); await shot('studio-plan');
  ok(/at least 15 characters/.test(await page.textContent('#dp-plan')), 'the credit form asks for 15 characters');
  await page.click('#dt-people'); await page.waitForTimeout(500); await shot('studio-people');
  const h = await page.evaluate(() => { const li = [...document.querySelectorAll('#dp-people .list li')].pop(); const a = li.querySelector('.m').getBoundingClientRect(); return { w: a.width, h: a.height }; });
  ok(h.w > 80 && h.h < 80, 'owner history line is readable, not one letter per line (' + Math.round(h.w) + 'x' + Math.round(h.h) + ')');
  ok(refused.length === 0, 'no refused calls: ' + [...new Set(refused)].join(', '));
  ok(cons.filter((c) => !/net::ERR_FAILED|Failed to load resource/.test(c)).length === 0, 'no console errors: ' + cons.slice(0, 3).join(' | ').slice(0, 300));
  const unexpected = [...new Set(rpcs)].filter((n) => STUDIO_APP.test(n) && !(n in FIX));
  ok(unexpected.length === 0, 'no studio-app call asked: ' + unexpected.join(', '));
  await browser.close();
  return fails;
}
let bad = [];
for (const [w, h] of [[1280, 800], [390, 844]]) bad = bad.concat(await run(w, h));
server.close();
console.log(bad.length ? 'R126-HQ-BROWSER: ' + bad.length + ' FAILED' : 'R126-HQ-BROWSER: ALL PASS');
process.exit(bad.length ? 1 : 0);
