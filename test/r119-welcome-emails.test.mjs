// r119-welcome-emails.test.mjs - R119 (owner: "make welcome e-mails really work, live").
//  1  0327 SQL: one database switch (default OFF), the claim only hands out rows queued in the last 48 h (>= 2 min old),
//     older unsent rows closed as skipped / expired (kept), re-checks + dedupe, trial + safe marker, house wrapper
//     (__pre0327, no privilege), billing_reminder_recheck; additive + idempotent; APPLY-0327 + the ON switch file
//  2  senders: welcome-mailer + comms-dispatch send through the SHARED mailer (SMTP first, else Resend) via
//     welcome-mailer/send.ts; switch checked before any claim; rows without the safe marker never sent;
//     billing-reminder asks billing_reminder_recheck before every send (fail closed)
//  3  trial welcome content: numbers mirror public/trial-facts.js; links /terms#trial + /checkout exist
//  4  bell / inbox wording: a trial PREVIEW reads "... ready (trial preview — not sent)"; paid studios unchanged
// Static + pure-function checks; the database side: tests/db/r119-welcome-0327.sql; the edge side:
// tests/edge/welcome-mailer.test.ts + tests/edge/r119-welcome.test.ts.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SQL = rd('supabase/migrations/0327_r119_welcome_live_safe.sql'), AP = rd('supabase/APPLY-0327.sql'), ON = rd('supabase/APPLY-0327-WELCOME-ON.sql');
const TPL = rd('supabase/functions/welcome-mailer/templates.ts'), SEND = rd('supabase/functions/welcome-mailer/send.ts');
const WM = rd('supabase/functions/welcome-mailer/index.ts'), CD = rd('supabase/functions/comms-dispatch/index.ts');
const BR = rd('supabase/functions/billing-reminder/index.ts'), API = rd('public/store-api.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}

t('1a SQL 0327: one switch, default OFF, closed to the app; welcome_email_switch() reads it', () => {
  assert.match(SQL, /create table if not exists public\.helm_welcome_mail_settings \(\n  id         boolean primary key default true check \(id\),\n  enabled    boolean not null default false/);
  assert.match(SQL, /insert into public\.helm_welcome_mail_settings\(id, enabled\) values \(true, false\) on conflict \(id\) do nothing;/);
  assert.match(SQL, /alter table public\.helm_welcome_mail_settings enable row level security;/);
  assert.match(SQL, /create or replace function public\.welcome_email_switch\(\)\nreturns boolean language sql stable security definer set search_path = ''/);
});
t('1b SQL 0327: the claim - stale rows closed (expired), 48 h window, 2 min settle, switch, re-checks, dedupe, trial, safe marker', () => {
  const c = SQL.slice(SQL.indexOf('create or replace function public.welcome_email_outbox_claim('), SQL.indexOf('-- ---- 5)'));
  assert.match(c, /security definer set search_path = ''/);
  assert.match(c, /set status = 'skipped', skip_reason = 'expired', sent_at = now\(\)\n   where sent_at is null and created_at < now\(\) - interval '48 hours';/);
  assert.ok(c.indexOf("skip_reason = 'expired'") < c.indexOf('if not public.welcome_email_switch() then return'), 'stale rows are closed even while the switch is off');
  assert.match(c, /w\.created_at >= now\(\) - interval '48 hours' and w\.created_at <= now\(\) - interval '2 minutes'/);
  for (const why of ['no_studio', 'sample', 'not_member', 'trial_ended', 'duplicate']) assert.ok(c.includes("v_why := '" + why + "'"), why);
  assert.match(c, /public\._r283_is_off\(r\.user_id, r\.org_id\)/);
  assert.match(c, /public\._trial_locked\(r\.org_id\)/);
  assert.match(c, /'safe', 'r119-0327'/);
  assert.match(c, /'trial', v_trial,/);
  assert.doesNotMatch(c, /\bdelete\b/i);
});
t('1c SQL 0327: house wrapper - the 0057 body kept once as __pre0327 with NO privilege (service role too)', () => {
  assert.match(SQL, /alter function public\.welcome_email_outbox_claim\(integer\) rename to welcome_email_outbox_claim__pre0327;/);
  assert.match(SQL, /position\('r119-0327' in coalesce\(/);
  assert.match(SQL, /then execute 'revoke all on function ' \|\| v_pre::text \|\| ' from service_role'; end if;/);
});
t('1d SQL 0327: billing_reminder_recheck - stale (3 days), paid since, trial over; closes as skipped, never deletes', () => {
  const b = SQL.slice(SQL.indexOf('create or replace function public.billing_reminder_recheck('), SQL.indexOf('-- ---- 6)'));
  assert.match(b, /when b\.created_at < now\(\) - interval '3 days' then 'stale'/);
  assert.match(b, /'paid_since'/); assert.match(b, /'trial_over'/);
  assert.match(b, /update public\.billing_reminders set sent_at = now\(\), channel = 'skipped', skip_reason = v_why where id = b\.id and sent_at is null;/);
  assert.match(b, /if not found then return 'gone'; end if;/);
});
t('1e SQL 0327: additive + idempotent + ASCII; service role only; preflight STOPs', () => {
  assert.doesNotMatch(SQL, /\bdrop\s+(table|column)\b|\bdelete\s+from\b|\btruncate\b/i);
  assert.match(SQL, /add column if not exists skip_reason text;/);
  assert.ok(/^[\x00-\x7F]*$/.test(SQL) && /^[\x00-\x7F]*$/.test(AP) && /^[\x00-\x7F]*$/.test(ON), 'ASCII only');
  assert.match(SQL, /raise exception 'STOP 0327: welcome e-mails \(0057\) missing/);
  assert.match(SQL, /'public\.welcome_email_switch\(\)', 'public\.welcome_email_outbox_claim\(integer\)', 'public\.billing_reminder_recheck\(uuid\)'/);
  assert.match(SQL, /execute format\('grant execute on function %s to service_role', s\)/);
  assert.doesNotMatch(SQL, /to authenticated|to anon/);
});
t('1f APPLY-0327 (begin/commit, the migration, VERIFY item/ok) + APPLY-0327-WELCOME-ON + MANIFEST', () => {
  assert.match(AP, /\nbegin;\n-- 0327_r119_welcome_live_safe\.sql/);
  assert.match(AP, /\ncommit;\n\n-- VERIFY \(every row must say ok = true\)\nselect item, ok from \(values/);
  assert.ok(AP.includes(SQL.replace(/\nnotify pgrst, 'reload schema';\n$/, '\n').trim().split('\n').slice(0, 40).join('\n')), 'APPLY carries the migration');
  assert.equal((AP.match(/^  \('0\d /gm) || []).length, 8, '8 VERIFY rows');
  assert.match(ON, /update public\.helm_welcome_mail_settings set enabled = true, updated_at = now\(\) where id;/);
  assert.match(ON, /set enabled = false, updated_at = now\(\) where id;/, 'the OFF line is documented');
  assert.match(ON, /raise exception 'STOP: run APPLY-0327\.sql first'/);
  assert.match(rd('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0327_r119_welcome_live_safe\.sql\n/);   // R120: 0328 follows
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r119-welcome-0327" "R119-WELCOME-0327: ALL PASS \\\(23\/23\\\)" psql -q -f tests\/db\/r119-welcome-0327\.sql/);
  assert.ok(existsSync(new URL('../tests/db/r119-welcome-0327.sql', import.meta.url)));
});

t('2a welcome-mailer + comms-dispatch share welcome-mailer/send.ts; switch before claim; shared mailer, SMTP first', () => {
  assert.match(WM, /import \{ runWelcomeBatch \} from "\.\/send\.ts";/);
  assert.match(WM, /const w = await runWelcomeBatch\(admin, batch\);/);
  assert.match(WM, /secretMatches\(req\.headers\.get\("x-helm-cron-secret"\)/);
  assert.match(WM, /if \(Deno\.env\.get\("HELM_WELCOME_EMAILS_ENABLED"\) !== "true"\) return json\(\{ status: "dormant" \}\);/);
  assert.doesNotMatch(WM + SEND, /api\.resend\.com/, 'no Resend-only path of its own any more');
  assert.match(CD, /import \{ runWelcomeBatch \} from "\.\.\/welcome-mailer\/send\.ts";/);
  assert.match(CD, /const w = await runWelcomeBatch\(admin, batch, \{ env \}\);/);
  assert.ok(SEND.indexOf('admin.rpc("welcome_email_switch")') < SEND.indexOf('admin.rpc("welcome_email_outbox_claim"'), 'switch before claim');
  assert.match(SEND, /if \(sw\?\.error\) return \{ counts, error: sw\.error \};/);
  assert.match(SEND, /if \(r\?\.safe !== SAFE_MARK\) status = "retry";/);
  assert.match(SEND, /await sendMail\(\{ to, subject: mail\.subject, html: mail\.html, text: mail\.text, studio: null, txReason: WELCOME_TX_REASON\[kind\] \},\n\s+\{ prefer: "smtp"/);
  assert.match(SEND, /export const SAFE_MARK = "r119-0327";/);
});
t('2b billing-reminder: billing_reminder_recheck before every send; error -> fail closed (nothing sent)', () => {
  const i = BR.indexOf('admin.rpc("billing_reminder_recheck", { p_id: id })');
  assert.ok(i > 0 && i < BR.indexOf('await sendEmail(to, msg.subject, msg.html'), 'recheck before the send');
  assert.match(BR, /if \(cErr\) \{ console\.error\("billing-reminder: recheck failed", errTag\(cErr\)\); counts\.failed\+\+; continue; \}/);
  assert.match(BR, /if \(chk !== "send"\) \{ counts\.skipped\+\+; continue; \}/);
});

t('3a trial welcome numbers mirror public/trial-facts.js (one source of the trial terms)', () => {
  const F = require('../public/trial-facts.js');
  const m = /export const TRIAL = \{ DAYS: (\d+), CREATE_CAP: (\d+), TEAM_EXTRA: (\d+), TEST_CODE: "(\d+)", TZ: "([^"]+)", TZ_LABEL: "([^"]+)" \};/.exec(TPL);
  assert.ok(m, 'TRIAL constant');
  assert.equal(Number(m[1]), F.DAYS); assert.equal(Number(m[2]), F.CREATE_CAP); assert.equal(Number(m[3]), F.TEAM_EXTRA);
  assert.equal(m[5], F.REGION.timezone); assert.equal(m[6], F.REGION.tz);
  assert.ok(F.SIGNUP_ALL.join(' ').includes('test code ' + m[4]), 'test code matches the agreed terms');
});
t('3b trial welcome: plain-words points + links; terms#trial and /checkout exist; render picks trial only for trial === true', () => {
  for (const s of ['nothing is sent to your clients', 'TEST receipts', 'read-only', 'photo renders', 'WhatsApp, SMS and online payment links', 'downloads, prints and exports'])
    assert.ok(TPL.includes(s), s);
  assert.match(TPL, /trialTerms: `\$\{SITE\}\/terms#trial`,\n  choosePlan: `\$\{SITE\}\/checkout`,/);
  assert.match(rd('public/terms.html'), /<section id="trial"/);
  assert.ok(existsSync(new URL('../public/checkout.html', import.meta.url)));
  assert.match(TPL, /const trial = opts\.trial === true;/);
  assert.match(TPL, /import \* as L from "\.\.\/_shared\/email-layout\.mjs";/);
});

// ---- 4) bell / inbox: the same label function (BPStore.bell.label) ----------------------------------------------------
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fnSrc(API, 'bellLabel') + '\nthis.bellLabel = bellLabel;', ctx);
const L = (n) => ctx.bellLabel(n).text;
t('4a trial previews read "ready (trial preview — not sent)" (approval / booklet / invitation)', () => {
  assert.equal(L({ kind: 'approval_link', status: 'simulated', detail: { suppressed_by: 'trial_simulation' } }), 'Approval link ready (trial preview — not sent)');
  assert.equal(L({ kind: 'booklet_link', status: 'simulated', detail: { suppressed_by: 'trial_simulation' } }), 'Booklet link ready (trial preview — not sent)');
  assert.equal(L({ kind: 'booklet_link', status: 'suppressed', detail: { via: 'booklet_send', skipped: 'free_trial' } }), 'Booklet link ready (trial preview — not sent)');
  assert.equal(L({ kind: 'booklet_link', status: 'suppressed', detail: { suppressed_by: 'trial' } }), 'Booklet link ready (trial preview — not sent)');
  assert.equal(L({ kind: 'invite_site_link', status: 'suppressed', detail: { via: 'invite_site', skipped: 'free_trial' } }), 'Invitation link ready (trial preview — not sent)');
});
t('4b paid studios unchanged', () => {
  assert.equal(L({ kind: 'approval_link', status: 'sent', detail: {} }), 'Approval link sent');
  assert.equal(L({ kind: 'approval_link', status: 'sent' }), 'Approval link sent');
  assert.equal(L({ kind: 'booklet_link', status: 'sent', detail: {} }), 'Booklet link sent to the client');
  assert.equal(L({ kind: 'booklet_link', status: 'simulated', detail: {} }), 'Booklet link not sent (sending not set up)');
  assert.equal(L({ kind: 'booklet_link', status: 'suppressed', detail: { skipped: 'demo' } }), 'Booklet link not sent (demo event)');
  assert.equal(L({ kind: 'invite_site_link', status: 'sent', detail: {} }), 'Invitation link sent to the client');
  assert.equal(L({ kind: 'invite_site_link', status: 'suppressed', detail: { suppressed_by: 'trial_cap' } }), 'Invitation link not sent (free trial e-mail limit)');
});
t('4c the inbox page uses the same label (BPStore.bell.label)', () => {
  assert.match(rd('public/inbox.js'), /BPStore\.bell\.label\(n\)/);
  assert.match(API, /\n    label: bellLabel,/);
});

if (process.exitCode) { console.log('r119-welcome-emails: FAILED'); process.exit(1); }
console.log(`r119-welcome-emails: ALL PASS (${n})`);
