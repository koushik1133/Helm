// =============================================================================
// r125-trial-preview.harness.mjs - R125: the free-trial preview pop-ups in a REAL browser (Playwright + the real pages
// served by server.js, with its real headers + CSP). Supabase is answered in-process by a stub (no network, every other
// host aborted). Not part of `npm test` (needs Chromium).
//   PORT=5125 OUT=/tmp/shots node test/r125-trial-preview.harness.mjs
// Walks every pop-up (Next / Back) on desktop + phone: no sideways scroll, no CSP or page errors, Esc closes and focus
// returns, a frame address opened in a plain tab shows "This link isn't available", nothing leaves (only the members-only
// RPCs are called), team invitations stay, no wa.me / mailto / sms link in the studio screens, a paid studio is unchanged.
// =============================================================================
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT || 5125), BASE = `http://127.0.0.1:${PORT}`, OUT = process.env.OUT || '/tmp/r125-shots';
mkdirSync(OUT, { recursive: true });
const req = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = req('@playwright/test');
const FX = JSON.parse(readFileSync(path.join(HERE, 'fixtures/r125-bundles.json'), 'utf8'));
const srv = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((ok) => setTimeout(ok, 900));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const UID = 'b0000000-0000-4000-8000-0000000000a1', ORG = 'b0000000-0000-4000-8000-000000000001', Q = 'b0000000-0000-4000-8000-00000000da01';
const jwt = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: UID, role: 'authenticated', aal: 'aal1', exp: 4102444800, aud: 'authenticated', email: 'owner@aurora.test' }) + '.c3R1Yg';
const user = { id: UID, aud: 'authenticated', role: 'authenticated', email: 'owner@aurora.test', email_confirmed_at: '2026-09-01T05:00:00Z', user_metadata: { full_name: 'Test Owner' }, created_at: '2026-01-01T00:00:00Z' };
const sess = { access_token: jwt, refresh_token: 'stub-refresh', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user };
const profile = { id: UID, role: 'admin', org_id: ORG, email: user.email, full_name: 'Test Owner', must_change_password: false, phone: '+919800000000', profile_complete: true };
const client = { name: 'Priya Sharma', email: 'priya@example.com', phone: '+919800000125', venue: 'Grand Hall, Hyderabad' };
const quote = { id: Q, org_id: ORG, code: 'B-0001', title: 'Priya & Arjun Wedding', status: 'confirmed', approval_status: 'sent', event_type: 'wedding', event_date: '2026-12-15',
  client, currency: 'INR', pricing: { total: 1001820, subtotal: 849000, gstPct: 18, chairs: 300, chairPrice: 500, guests: 300, platePrice: 2000 }, updated_at: '2026-11-01T00:00:00Z', created_at: '2026-10-01T00:00:00Z', current_version: 2 };
const BUNDLES = JSON.parse(JSON.stringify(FX));
for (const b of Object.values(BUNDLES)) { b.studio = 'Aurora Events'; if (b.hint) Object.assign(b.hint, { client_name: 'Priya Sharma', title: 'Priya & Arjun Wedding', total: '1001820', venue: client.venue, event_date: '2026-12-15' }); }
Object.assign(BUNDLES.approval.public_get_quote, { pricing: quote.pricing, client_name: 'Priya Sharma', event_type: 'wedding', approval_status: 'sent' });
BUNDLES.approval.public_quote_ready = { priced: true, studio: 'Aurora Events' };
BUNDLES.approval.public_trial_payment_sim = { simulation: true, approved: false, amount: 300546, label: 'Advance 30%', currency: 'INR', can_pay: false };
BUNDLES.proposal.public_get_proposal = Object.assign(BUNDLES.proposal.public_get_proposal, { concept: 'A golden-hour garden evening, warm florals and soft lights.', theme: 'Golden Hour Garden',
  palette: ['#c9973f', '#8c1d2f', '#f7f3ec'], scope: ['Stage and mandap decor', 'Lighting', 'Catering for 300'], client_name: 'Priya Sharma', event_title: 'Priya & Arjun Wedding', total: 1001820, pricing: quote.pricing });
BUNDLES.invitation.public_event_site[0] = Object.assign(BUNDLES.invitation.public_event_site[0], { event_type: 'wedding', template: 'eternal', title: 'Priya & Arjun', data: { names: 'Priya & Arjun', headline: 'are getting married', date: '2026-12-15', rsvpForm: true, venue: 'Grand Hall' } });

function stub({ plan, calls }) {
  const trial = plan !== 'paid';
  const RPC = { password_change_required: false, my_mfa_reset_info: null, is_platform_operator: false, is_platform_admin: false, mfa_lock_status: { locked: false, retry_after: 0 }, current_org_id: ORG, user_role: 'admin',
    profile_status: { complete: true }, my_profile_status: { complete: true }, my_pending_start_trial: null,
    my_trial_status: trial ? { state: 'trial', status: 'trial', days_left: 6, ends_at: '2026-11-11', is_admin: true, can_pay: true } : { state: 'none', status: 'active', is_admin: true },
    my_trial_org: trial ? { is_trial_org: true, name: 'Aurora Events', days_left: 6, ended: false, locked: false, read_only: false, is_admin: true } : { is_trial_org: false, is_admin: true },
    my_trial_terms_status: { required: false, agreed: true }, my_trial_links: { closed: trial, active: trial, ended: false },
    my_trial_messaging: trial ? { trial: true, active: true, email: false, whatsapp: false } : { trial: false, email: true, whatsapp: true },
    trial_sim_payments_for_quote: [], work_links_for_event: trial ? [] : [{ phone: '+919800000126', name: 'Ravi', token: 'b0000000-0000-4000-8000-0000000000dd' }],
    trial_member_test_approve: { approved: true, test_mode: true, confirmed: true }, trial_member_simulate_payment: { simulated: true, test_mode: true, real_payment: false, amount: 300546, currency: 'INR', receipt: 'TEST-ABCD1234', more_due: true } };
  return async (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === '127.0.0.1') return r.continue();
    if (!u.hostname.endsWith('.supabase.co')) return r.abort();
    const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: H, body: '' });
    const json = (o) => r.fulfill({ status: 200, contentType: 'application/json', headers: H, body: JSON.stringify(o) });
    const p = u.pathname;
    if (p === '/auth/v1/user') return json(user);
    if (p === '/auth/v1/token') return json(sess);
    if (p.startsWith('/auth/v1/')) return json({});
    if (p.startsWith('/rest/v1/rpc/')) {
      const fn = p.slice(13); calls.push(fn);
      if (fn === 'trial_preview_bundle') { const a = r.request().postDataJSON() || {}; return json(a.p_kind === 'enquiry' ? { public_enquiry_info: { ok: true, studio: 'Aurora Events' } } : BUNDLES[a.p_kind]); }
      return json(fn in RPC ? RPC[fn] : null);
    }
    if (p.startsWith('/rest/v1/')) { const t = p.slice(9), one = /vnd\.pgrst\.object/.test(r.request().headers()['accept'] || '');
      if (t === 'profiles') return json(one ? profile : [profile]);
      if (t === 'organizations') { const o = { id: ORG, name: 'Aurora Events', slug: 'aurora-events', public_slug: 'aurora-events', currency: 'INR', timezone: 'Asia/Kolkata', plan: 'pro', brand: {} }; return json(one ? o : [o]); }
      if (t === 'quotes') return json(one ? quote : [quote]);
      return json(one ? null : []); }
    return r.abort();
  };
}

const fails = [], ok = (c, m) => { if (c) console.log('  ok ' + m); else { fails.push(m); console.log('  FAIL ' + m); } };
const browser = await chromium.launch();

async function ctx(plan, vp) {
  const calls = [], errors = [];
  const c = await browser.newContext({ viewport: vp, serviceWorkers: 'block' });
  await c.addInitScript(([s]) => { try { for (const ref of ['xizehqgeyjcfpzrdymly', 'nqltzgiwznphugcfhmbm']) localStorage.setItem('sb-' + ref + '-auth-token', JSON.stringify(s));
    for (const k of ['helm_tour_done', 'bp_seen_tour', 'helm.shellb.pin']) localStorage.setItem(k, '1'); } catch (e) {} }, [sess]);
  await c.route('**/*', stub({ plan, calls }));
  const page = await c.newPage();
  page.on('pageerror', (e) => { if (!/null \(reading 'some'\)/.test(e.message) || /trial-preview/.test(e.stack || '')) errors.push('pageerror: ' + e.message + ' ' + String(e.stack || '').split('\n')[1]); });
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  return { c, page, calls, errors };
}
async function walk(page, name, prefix, opener) {
  await opener();
  await page.waitForSelector('.tp-dlg', { timeout: 8000 });
  await page.waitForFunction(() => { const b = document.querySelector('.tp-foot .tp-btn.pri'); return b && !b.disabled; }, null, { timeout: 8000 });
  let i = 0, guard = 0;
  while (guard++ < 16) {
    await page.waitForTimeout(350);
    const fr = page.locator('.tp-frame');
    if (await fr.count()) { await page.waitForTimeout(700); }
    await page.screenshot({ path: path.join(OUT, `${prefix}-${name}-${String(i).padStart(2, '0')}.png`) });
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (sw > 1) ok(false, `${prefix} ${name} step ${i}: sideways scroll ${sw}px`);
    const txt = await page.locator('.tp-foot .tp-btn.pri').textContent();
    if (/Done/.test(txt)) break;
    await page.locator('.tp-foot .tp-btn.pri').click(); i++;
    await page.waitForFunction(() => { const b = document.querySelector('.tp-foot .tp-btn.pri'); return !b || !b.disabled; }, null, { timeout: 8000 });
  }
  return i + 1;
}

// ---- trial studio, desktop + phone
for (const [prefix, vp] of [['desk', { width: 1280, height: 800 }], ['phone', { width: 375, height: 760 }]]) {
  console.log('== ' + prefix);
  const { c, page, calls, errors } = await ctx('trial', vp);
  await page.goto(`${BASE}/flow?id=${Q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tpEntry', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, `${prefix}-flow.png`), fullPage: false });
  ok((await page.locator('#sendApproval').textContent()).includes('(Preview)'), 'the send button says (Preview)');
  const n = await walk(page, 'approval', prefix, () => page.locator('#sendApproval').click());
  ok(n >= 9, 'approval: ' + n + ' steps');
  const bad = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')).filter((h) => /wa\.me|^sms:/i.test(h || '')));
  ok(bad.length === 0, 'no wa.me / sms link in the studio screen');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  ok(!(await page.locator('.tp-dlg').count()), 'Esc closes the pop-up');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'sendApproval'), 'focus returns to the button');
  for (const k of ['booklet', 'invitation', 'proposal', 'crew', 'vendor', 'enquiry']) {
    const steps = await walk(page, k, prefix, () => page.locator(`#tpEntry [data-tp-kind="${k}"]`).click());
    ok(steps >= 2, `${k}: ${steps} steps`);
    await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  }
  const allowed = /^(trial_preview_bundle|trial_member_|my_|password_|is_platform|mfa_|current_org|user_role|profile_|work_links|trial_sim_payments_for|get_|list_|quote_|event_|bell|notif|app_config|helm_|studio_|has_|flow_|comms_|pst_|payment_|capacity|client_|config)/;
  const pub = calls.filter((x) => /^(public_|verify_|request_otp|wa_|trial_test|trial_simulate|vendor_link|delivery_link|worker_|crew_)/.test(x));
  ok(pub.length === 0, 'no public-link RPC reached the server: ' + pub.join(','));
  ok(!calls.includes('generate_approval_token') && !calls.includes('booklet_share'), 'no token was asked for');
  ok(errors.length === 0, 'no CSP / page errors: ' + errors.slice(0, 3).join(' | '));
  await c.close();
}

// ---- every studio screen: nothing that reaches an outsider renders, team invitations stay
{ const { c, page, errors } = await ctx('trial', { width: 1280, height: 800 });
  const SCAN = ['flow?id=' + Q, 'event?id=' + Q, 'quotes', 'client?id=' + Q, 'proposal?quote=' + Q, 'invite-studio?quote=' + Q, 'ops?quote=' + Q, 'resources?quote=' + Q, 'vendors?quote=' + Q,
    'logistics?quote=' + Q, 'command?quote=' + Q, 'nurture', 'refer', 'settlement?id=' + Q, 'dashboard', 'leads', 'staff', 'control'];
  for (const u of SCAN) {
    await page.goto(`${BASE}/${u}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const found = await page.evaluate(() => {
      const out = [], vis = (n) => !!(n.offsetParent || n.getClientRects().length);
      document.querySelectorAll('a[href]').forEach((a) => { const h = a.getAttribute('href') || ''; if (/wa\.me|whatsapp|^sms:/i.test(h) || (/^mailto:/i.test(h) && !/@helm\.events/i.test(h))) out.push(h.slice(0, 40)); });
      document.querySelectorAll('button,a').forEach((b) => { if (!vis(b)) return; const t = (b.textContent || '').trim();
        if (/^(Copy( link)?$|Open site|Open the client page|Send as text message|WhatsApp \(manual\)|Email \(manual\)|Create link|Make new link|Turn off link|Send to client|Share link|Open in WhatsApp|WhatsApp a test to me)\b/.test(t) && !b.closest('[data-invite],#inv_box,#iv_box,#usersCard,#invBox')) out.push('button: ' + t.slice(0, 30)); });
      return out; });
    ok(found.length === 0, `${u.split('?')[0]}: no way out on screen ${found.join(', ')}`);
    await page.screenshot({ path: path.join(OUT, `scan-${u.split('?')[0]}.png`) });
  }
  ok(errors.length === 0, 'scan: no CSP / page errors: ' + errors.slice(0, 3).join(' | '));
  await c.close();
}
// ---- the owner can try the client side: test approval + simulated payment, members-only; a guest reply reaches nothing
{ const { c, page, calls, errors } = await ctx('trial', { width: 1280, height: 800 });
  await page.goto(`${BASE}/flow?id=${Q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tpEntry', { timeout: 15000 }); await page.waitForTimeout(600);
  await page.locator('#sendApproval').click();
  await page.waitForFunction(() => { const b = document.querySelector('.tp-foot .tp-btn.pri'); return b && !b.disabled; });
  for (let i = 0; i < 3; i++) await page.locator('.tp-foot .tp-btn.pri').click();
  const fr = page.frameLocator('.tp-frame');
  await fr.locator('#sendEmailOtp').click();
  await fr.locator('#c_otp').fill('000000'); await fr.locator('#c_agree').check();
  await page.screenshot({ path: path.join(OUT, 'try-code.png') });
  await fr.locator('#confirmBtn').click();
  await fr.locator('#step3').waitFor({ state: 'visible', timeout: 5000 });
  ok(calls.includes('trial_member_test_approve'), 'the test approval goes through the members-only path');
  ok(!calls.some((x) => /^(wa_|verify_and_consent|request_otp|trial_test_approve)/.test(x)), 'no public approval call reached the server');
  await page.locator('.tp-foot .tp-btn.pri').click(); await page.waitForTimeout(500); await page.locator('.tp-foot .tp-btn.pri').click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Simulate payment (TEST)' }).click();
  await page.getByText('TEST-ABCD1234').waitFor({ timeout: 4000 });
  ok(calls.includes('trial_member_simulate_payment'), 'Simulate payment goes through the members-only path');
  await page.screenshot({ path: path.join(OUT, 'try-pay.png') });
  ok(errors.length === 0, 'no errors: ' + errors.join(' | '));
  await c.close();
}
// ---- the guest and vendor pages inside the pop-up save nothing
{ const { c, page, calls } = await ctx('trial', { width: 1280, height: 800 });
  await page.goto(`${BASE}/flow?id=${Q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#tpEntry', { timeout: 15000 }); await page.waitForTimeout(600);
  await page.locator('#tpEntry [data-tp-kind="vendor"]').click();
  await page.waitForFunction(() => { const b = document.querySelector('.tp-foot .tp-btn.pri'); return b && !b.disabled; });
  await page.locator('.tp-foot .tp-btn.pri').click();
  const fr = page.frameLocator('.tp-frame'); await fr.getByRole('button', { name: 'Accept', exact: true }).first().click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  ok(!calls.some((x) => /^vendor_/.test(x)), 'a vendor reply in the pop-up reaches nothing');
  await page.keyboard.press('Escape'); await c.close();
}
// ---- a real client page: the frame script stays out of the way
{ const { c, page } = await ctx('paid', { width: 1000, height: 700 });
  await page.goto(`${BASE}/approve?token=b0000000-0000-4000-8000-0000000000aa`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(500);
  ok(await page.evaluate(() => window.HELM_TRIAL_PREVIEW === undefined && !document.documentElement.classList.contains('tp-framed') && /^\/approve/.test(location.pathname)), 'client page: frame script did nothing');
  await c.close();
}
// ---- the frame address on its own
{ const { c, page } = await ctx('trial', { width: 1000, height: 700 });
  for (const f of ['approve', 'portal', 'booklet', 'proposal', 'invite', 'work', 'vendor', 'enquiry']) {
    await page.goto(`${BASE}/trial-preview-${f}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const t = await page.locator('body').innerText();
    ok(/This link isn.t available/.test(t), `/trial-preview-${f} alone: This link isn't available`);
    if (f === 'approve') await page.screenshot({ path: path.join(OUT, 'outsider.png') });
  }
  await c.close();
}
// ---- a paid studio: the old button, no script
{ const { c, page, calls } = await ctx('paid', { width: 1280, height: 800 });
  await page.goto(`${BASE}/flow?id=${Q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#sendApproval', { timeout: 15000 }); await page.waitForTimeout(1500);
  ok(/^Send for approval/.test(await page.locator('#sendApproval').textContent()) && !(await page.locator('#sendApproval').textContent()).includes('Preview'), 'paid: the send button is unchanged');
  ok(!(await page.locator('#trialPreviewJs').count()), 'paid: trial-preview.js is not loaded');
  ok(!calls.includes('my_trial_links'), 'paid: no extra call');
  await c.close();
}
await browser.close(); srv.kill();
console.log(fails.length ? 'R125 HARNESS: ' + fails.length + ' FAILED\n - ' + fails.join('\n - ') : 'R125 HARNESS: ALL PASS');
process.exit(fails.length ? 1 : 0);
