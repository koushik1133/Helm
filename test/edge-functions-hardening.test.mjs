#!/usr/bin/env node
/* ============================================================================
 * edge-functions-hardening.test.mjs — Security audit Phase 8 (risky functionality:
 * file uploads, card payments, outbound messaging) regressions. READ-ONLY, no network.
 *   _shared/cors.ts        preview regex matched attacker-registrable Vercel names → exact list
 *   send-whatsapp          open relay (any staff, any number, any template)        → quote + caller JWT + allowlist
 *   send-otp               any phone; raw DB error.message to the browser           → phone on file / Indian; mapped errors
 *   create-payment-link    unserialized; no expiry; approval token sent to Razorpay → reserve/attach RPCs, expire_by, token-free callback
 *   razorpay-webhook       unchecked DB errors, late payment dropped, global email  → razorpay_settle, 500 on error, per-studio email
 *   sim-pay.html           simulated checkout live on production                    → refuses on prod hosts / prod DB
 *   invite-studio.html     unlimited photo upload loop                              → 60-photo cap
 *   logistics.html         milestone "paid" by direct table write                   → settle_milestone RPC
 * Behavioural proof for the Edge Functions is the Deno harness (tests/edge, mocked
 * providers + DB, no --allow-net); it is run here when `deno` is installed.
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const cors = read('supabase/functions/_shared/cors.ts');
const wa = read('supabase/functions/send-whatsapp/index.ts');
const otp = read('supabase/functions/send-otp/index.ts');
const pay = read('supabase/functions/create-payment-link/index.ts');
const hook = read('supabase/functions/razorpay-webhook/index.ts');
const sim = read('public/sim-pay.html');
const studio = read('public/invite-studio.html');
const logi = read('public/logistics.html');
const api = read('public/store-api.js');
const approve = read('public/approve.html');
const mig = read('supabase/migrations/0027_uploads_payments.sql');
const fns = [cors, wa, otp, pay, hook];

// ---- CORS -------------------------------------------------------------------
t('cors: no origin PATTERN for vercel.app (attacker-registrable) — exact allowlist only', () => {
  assert.doesNotMatch(cors, /vercel\\\.app\$\//, 'a *.vercel.app regex is trusted');
  assert.doesNotMatch(cors, /PREVIEW_ORIGIN/);
  const m = cors.match(/const DEFAULT_ORIGINS = \[([\s\S]*?)\];/);
  assert.ok(m, 'DEFAULT_ORIGINS must exist');
  const list = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  // the old regex accepted these; an exact list must not
  for (const evil of ['https://helm-v01-x-vk-hub.vercel.app', 'https://helm-v01-abc123def-vk-hub.vercel.app'])
    assert.ok(!list.includes(evil), evil);
  assert.match(cors, /EXTRA_ALLOWED_ORIGINS/);
});

// ---- send-whatsapp ------------------------------------------------------------
t('send-whatsapp: every send names an event (quote_id) — no open relay', () => {
  assert.match(wa, /if \(!UUID_RE\.test\(quoteId\)\) return json\(\{ error: "quote_id is required" \}, 400\)/);
  const iSend = wa.indexOf('/messages`');
  assert.ok(iSend > 0 && wa.indexOf('UUID_RE.test(quoteId)') < iSend, 'quote check must precede the send');
});
t('send-whatsapp: authorization runs as the CALLER (anon key + user JWT), not the service role', () => {
  assert.match(wa, /createClient\(url, anonKey, \{\s*global: \{ headers: \{ Authorization: "Bearer " \+ jwt \} \}/);
  assert.match(wa, /asCaller\.from\("quotes"\)/);
  assert.match(wa, /asCaller\.rpc\("whatsapp_authorize"/);
  assert.doesNotMatch(wa, /STAFF_ROLES/, 'hard-coded role list must be gone (has_area in DB instead)');
  const iAdmin = wa.indexOf('SUPABASE_SERVICE_ROLE_KEY")!');
  assert.ok(iAdmin > wa.indexOf('asCaller.rpc("whatsapp_authorize"'), 'service role only after authorization (for the log)');
});
t('send-whatsapp: templates allowlisted; free text off unless WHATSAPP_ALLOW_TEXT=1', () => {
  assert.match(wa, /templateAllowlist\(\)\.includes\(name\)/);
  assert.match(wa, /WHATSAPP_ALLOW_TEXT"\) !== "1"/);
});
t('send-whatsapp: logged with channel "whatsapp" and the insert error is checked', () => {
  assert.match(wa, /channel: "whatsapp"/);
  assert.match(wa, /const \{ error: logErr \} = await admin\.from\("notifications"\)\.insert/);
  assert.match(mig, /channel = any \(array\['sms', 'email', 'in_app', 'whatsapp'\]\)\) not valid/);
});

// ---- send-otp -----------------------------------------------------------------
t('send-otp: destination decided server-side (phone on file / Indian mobile) before any code is stored', () => {
  const iAuth = otp.indexOf('rpc("otp_send_authorize"'), iStore = otp.indexOf('rpc("admin_store_otp"');
  assert.ok(iAuth > 0 && iStore > iAuth, 'otp_send_authorize must run before admin_store_otp');
  assert.match(otp, /mobiles: String\(dest\.mobile\)/);
  assert.match(mig, /elsif v_to !~ '\^91\[6-9\]\[0-9\]\{9\}\$' then/);
});
t('send-otp: raw DB error text never reaches the caller', () => {
  assert.doesNotMatch(otp, /json\(\{\s*error:\s*\w*[eE]rr\w*\.message/);
  assert.doesNotMatch(otp, /error:\s*error\.message/);
});

// ---- create-payment-link ------------------------------------------------------
t('create-payment-link: reserve (DB lock) BEFORE Razorpay; attach after; fail on error', () => {
  const iBegin = pay.indexOf('rpc("payment_link_begin"'), iRzp = pay.indexOf('rzp("payment_links"');
  assert.ok(iBegin > 0 && iRzp > iBegin);
  assert.ok(pay.indexOf('rpc("payment_link_attach"') > iRzp);
  assert.match(pay, /rpc\("payment_link_fail"/);
  assert.match(mig, /payment_link_begin[\s\S]*pg_advisory_xact_lock\(hashtextextended\('helm:pay:quote:'/);
});
t('create-payment-link: expire_by set; superseded links cancelled; only rzp.io links handed out', () => {
  assert.match(pay, /expire_by: Number\(b\.expire_by\)/);
  assert.match(pay, /payment_links\/\$\{ref\}\/cancel/);
  assert.match(pay, /isRazorpayLink\(link\.id, link\.short_url\)/);
});
t('create-payment-link: the approval token is never sent to Razorpay', () => {
  const body = pay.slice(pay.indexOf('rzp("payment_links"'), pay.indexOf('const link = await r.json()'));
  assert.doesNotMatch(body, /\btoken\b/, 'token appears in the Razorpay request');
  assert.match(body, /\/approve\.html\?payment=done/);
  assert.match(approve, /get\("payment"\)==="done"/, 'approve.html handles the token-free return');
});

// ---- razorpay-webhook ---------------------------------------------------------
t('razorpay-webhook: every supabase-js call checks its error (500 → Razorpay retries)', () => {
  const calls = [...hook.matchAll(/await admin\.(?:from|rpc)\(/g)];
  assert.ok(calls.length >= 4);
  for (const c of calls) {
    const before = hook.slice(Math.max(0, c.index - 60), c.index);
    assert.match(before, /const \{[^}]*error: \w+[^}]*\} = $/, 'unchecked call near: ' + hook.slice(c.index, c.index + 60));
  }
  assert.match(hook, /razorpay_settle failed[\s\S]{0,80}status: 500/);
});
t('razorpay-webhook: a payment that cannot settle is RECORDED (reconcile), not dropped', () => {
  assert.match(hook, /out\.result === "reconcile"/);
  assert.match(mig, /insert into public\.payment_reconciliation/);
  assert.match(mig, /if q\.approval_status = 'paid' then v_reason := 'already_paid'/);
});
t('razorpay-webhook: per-studio branding/recipients; MANAGER_EMAIL gets no tenant data', () => {
  assert.doesNotMatch(hook, /Blueprint Stage/);
  assert.match(hook, /from\("organizations"\)\.select\("name, business_email"\)\.eq\("id", q\.org_id\)/);
  const opsLine = hook.slice(hook.indexOf('const ops = Deno.env.get("MANAGER_EMAIL")'));
  const opsSend = opsLine.slice(0, opsLine.indexOf('\n', opsLine.indexOf('if (ops)')));
  assert.doesNotMatch(opsSend, /[,(]\s*(html|studio|studioEmail|total|subjCode|clientEmail)\s*[,)]|\bq\.|\borg\?\.|\$\{/, 'ops copy carries tenant data: ' + opsSend);
  assert.doesNotMatch(hook, /recipient: Deno\.env\.get\("MANAGER_EMAIL"\)/);
});
t('edge functions: no raw provider bodies / PII in logs; pinned supabase-js matches the client', () => {
  for (const src of fns) {
    assert.doesNotMatch(src, /console\.error\([^)]*\.slice\(0,\s*\d+\)/, 'provider body logged');
    assert.doesNotMatch(src, /esm\.sh\/@supabase/);
  }
  const vendor = /supabase-js-(\d+\.\d+\.\d+)\.min\.js/.exec(read('public/index.html') + read('public/login.html'));
  for (const src of [wa, otp, pay, hook]) assert.match(src, /from "npm:@supabase\/supabase-js@2\.117\.2"/);
  if (vendor) assert.equal(vendor[1], '2.117.2');
});

// ---- sim-pay ------------------------------------------------------------------
t('sim-pay: refuses on production hosts and whenever wired to the production DB', () => {
  const host = sim.match(/const PROD_HOST=(\/.*\/i);/), db = sim.match(/const PROD_DB=(\/.*\/i);/);
  assert.ok(host && db, 'sim-pay gate must exist');
  const H = eval(host[1]), D = eval(db[1]);
  const allowed = (h, url) => !H.test(h) && !D.test(url);
  const PROD = 'https://nqltzgiwznphugcfhmbm.supabase.co', STG = 'https://xizehqgeyjcfpzrdymly.supabase.co';
  for (const h of ['www.helm.events', 'helm.events', 'helm-alpha-nine.vercel.app'])
    assert.ok(!allowed(h, STG), 'prod host allowed: ' + h);
  assert.ok(!allowed('helm-v01-git-x-vk-hub.vercel.app', PROD), 'preview wired to prod DB allowed');
  assert.ok(allowed('localhost', ''), 'local dev must keep working');
  assert.ok(allowed('helm-staging.vercel.app', STG), 'staging must keep working');
  assert.ok(allowed('helm-v01.vercel.app', STG), 'helm-v01 is the staging site');
  assert.ok(!allowed('helm-v01.vercel.app', PROD), 'staging site wired to prod DB allowed');
  assert.match(sim, /if\(live \|\| !simAllowed\)\{[\s\S]{0,200}btn\.disabled=true/);
});

// ---- uploads / milestones (client) -----------------------------------------------
t('invite-studio: photo uploads capped at 60 (loop + URL add)', () => {
  assert.match(studio, /const MAX_PHOTOS=60;/);
  const loop = studio.slice(studio.indexOf('for(const f of files){'), studio.indexOf('uploadPhoto(qid, f)'));
  assert.match(loop, /PHOTOS\.length>=MAX_PHOTOS/);
  assert.match(mig, /jsonb_array_length\(data -> 'photos'\) <= 60\) not valid/);
});
t('milestones: "paid" goes through settle_milestone, never a direct table write', () => {
  assert.match(api, /if \(status === "paid" && mode === "supabase"\) return this\.settle\(id\);/);
  assert.match(api, /rpc\("settle_milestone", \{ p_milestone: id/);
  assert.match(logi, /canEdit&&m\.status!=="paid"\?`<select/);
  assert.match(logi, /canDelete&&m\.status!=="paid"\?`<button/);
  assert.match(mig, /create trigger aa_milestone_paid_guard before insert or update or delete on public\.payment_milestones/);
});

// ---- behavioural: Deno harness (mocked providers + DB, no network) -----------------
const deno = spawnSync('deno', ['--version'], { encoding: 'utf8' });
if (deno.status === 0) {
  t('Deno edge harness (tests/edge): all runtime cases pass with no network permission', () => {
    const r = spawnSync('deno', ['test', '--allow-env', '--allow-read', '--no-check', '--import-map=import_map.json'],
      { cwd: join(ROOT, 'tests/edge'), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, out.split('\n').filter((l) => /FAILED|error/i.test(l)).slice(0, 20).join('\n'));
    assert.match(out, /ok \| \d+ passed \| 0 failed/);
  });
} else {
  console.log('  - Deno edge harness skipped (deno not installed); static checks above still apply');
}

console.log(`\nedge-functions-hardening: ${passed} passed.`);
