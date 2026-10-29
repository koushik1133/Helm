// r59-audit.test.mjs - R59 audit fixes (28 Oct 2026, groups F-settings / E-money / B-shell). Browser / repo side:
//  * F-6 integrations.html: no "For the Helm owner" ops text (SQL files, secret names, deploy commands) for studio users
//        (it lives in docs/ops); integrations-settings.js stays unreferenced (not deleted)
//  * F-7 integrations.js "Send test": only "not deployed" (404) is a simulation; 5xx / network = a real failure
//  * F-1 the WhatsApp hint says admins only + a teammate's own mobile
//  * E-07 settlement.html: expense-claim buttons need Finance edit as well as Settlement edit
//  * BS-04 chat.html: quote cards are drawn only from the viewer's own (server) quote list, never from message text;
//        a new card never carries the total or the client
//  * BS-05 studio-search.js: no client name in result URLs (sessionStorage key instead)
//  * BS-07 store-api.js: sign-out clears every per-user recent-search list
//  * F-2 pricing-form-core.js: service charge 0-25 % (same limit as the server)
//  * SQL 0300: MANIFEST + run-all + release lists, APPLY = migration verbatim + VERIFY, ASCII, STOP guard, no drops
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

const ITG_HTML = rd('public/integrations.html'), ITG = rd('public/integrations.js'), CHAT = rd('public/chat.html');
const SETTLE = rd('public/settlement.html'), SS = rd('public/studio-search.js'), STORE = rd('public/store-api.js');
const SQL = rd('supabase/migrations/0300_r59_settings_money_hardening.sql'), APPLY = rd('supabase/APPLY-0300.sql');

await t('F-6 integrations page: no Helm-owner ops text; the dead settings file is not loaded anywhere', () => {
  for (const bad of ['For the Helm owner', 'supabase functions deploy', 'RESEND_API_KEY', 'HELM_INVITE_EMAIL', 'WHATSAPP_TOKEN', 'APPLY-0131', 'APPLY-0150', '--no-verify-jwt'])
    assert.ok(!ITG_HTML.includes(bad), bad);
  assert.ok(existsSync(new URL('../public/integrations-settings.js', import.meta.url)), 'kept, not deleted');
  assert.ok(!/integrations-settings\.js/.test(ITG_HTML));
  assert.match(rd('docs/ops/EMAIL-SETUP.md'), /APPLY-0131/, 'the owner steps still live in the ops docs');
});

await t('F-7 Send test: 404 = simulation, 5xx / network / refusal = "Not sent"', () => {
  const ctx = { module: { exports: {} }, console };
  vm.runInNewContext(ITG, ctx);
  const H = ctx.module.exports;
  assert.equal(H.testFailureKind('HTTP 404'), 'simulate');
  assert.equal(H.testFailureKind('HTTP 500'), 'server');
  assert.equal(H.testFailureKind('HTTP 503'), 'server');
  assert.equal(H.testFailureKind('Failed to fetch'), 'network');
  assert.equal(H.testFailureKind(''), 'network');
  assert.equal(H.testFailureKind('only a studio admin can send a test WhatsApp'), 'refused');
  for (const k of ['server', 'network', 'refused']) assert.match(H.testFailureText(k, 'x'), /^Not sent/);
  assert.ok(!/HTTP 5\\d\\d\|Load failed/.test(ITG), 'the old "5xx = simulated" rule is gone');
});

await t('F-1 WhatsApp hint: studio admins only, a teammate\'s own mobile', () => {
  assert.match(ITG_HTML, /Only a studio admin can send one, and the number must be the mobile saved in your \(or a teammate's\) Helm profile\./);
});

await t('E-07 settlement: claim buttons + add form need Finance edit too', () => {
  assert.match(SETTLE, /canClaims=canEdit && await BPStore\.auth\.canEditArea\("finance"\)/);
  assert.match(SETTLE, /\$\{canClaims\?`\$\{e\.status==='pending'/);
  assert.ok(!SETTLE.includes('$("#expAdd").hidden=!canEdit'));
  assert.equal((SETTLE.match(/\$\("#expAdd"\)\.hidden=!canClaims/g) || []).length, 2);
});

await t('BS-04 chat: quote cards from the viewer\'s own quotes only; new cards carry no total / client', () => {
  assert.match(CHAT, /function quoteCardHtml\(meta\)/);
  const card = CHAT.slice(CHAT.indexOf('function quoteCardHtml(meta)'), CHAT.indexOf('function cardHtml(meta)'));
  assert.ok(!/meta\.total|meta\.client|meta\.code|meta\.title/.test(card), 'never the text carried in the message');
  assert.match(card, /Not available to you/);
  assert.match(CHAT, /BPStore\.quotes\.list\(\)/);
  const pick = CHAT.slice(CHAT.indexOf('async function quotePicker()'), CHAT.indexOf('async function layoutPicker()'));
  assert.ok(!/total:q\.total|client:\(q\.client/.test(pick));
  assert.ok(CHAT.indexOf('const qCards=') < CHAT.indexOf('function cardLabel('), 'declared before first use');
});

await t('BS-05 search hand-off: sessionStorage key, never the name in the URL; landing reads it once', () => {
  assert.match(SS, /hs_k=/);
  assert.ok(!/encodeURIComponent\(String\(title/.test(SS));
  assert.match(SS, /const hs = hk != null \? hsTake\(hk\) : p\.get\("hs"\)/);
});

await t('BS-07 sign-out clears every helm_ss_recent_* list and the search hand-off', () => {
  const body = STORE.slice(STORE.indexOf('function userLocalClear()'), STORE.indexOf('let authRequired'));
  assert.match(body, /USER_LOCAL_PREFIXES/); assert.match(STORE, /USER_LOCAL_PREFIXES = \["helm_ss_recent_"\]/);
  assert.match(body, /sessionStorage\.removeItem\("helm_ss_hs"\)/);
  // run it against a fake storage
  const ls = { m: { 'helm_ss_recent_u1': '["x"]', 'helm_ss_recent_u2': '[]', 'theme': 'g', 'wa_pin': '1' },
    get length() { return Object.keys(this.m).length; }, key(i) { return Object.keys(this.m)[i]; }, removeItem(k) { delete this.m[k]; } };
  const ss = { m: { helm_ss_hs: '{}' }, removeItem(k) { delete this.m[k]; } };
  const line = (k) => STORE.slice(STORE.indexOf(k), STORE.indexOf('\n', STORE.indexOf(k)));
  const keys = line('const USER_LOCAL_KEYS') + '\n' + line('const USER_LOCAL_PREFIXES');
  vm.runInNewContext(keys + '\n' + body + '\nuserLocalClear();', { localStorage: ls, sessionStorage: ss });
  assert.deepEqual(Object.keys(ls.m), ['theme']); assert.deepEqual(Object.keys(ss.m), []);
});

await t('F-2 pricing form: service charge 0-25 % (server limit)', () => {
  assert.match(rd('public/pricing-form-core.js'), /SVC_MAX = 25/);
  assert.match(SQL, /when 'serviceChargePct' then 25/); assert.match(SQL, /when 'gstPct' then 28/);
});

await t('SQL 0300: registered, APPLY verbatim + VERIFY, ASCII, STOP guard, nothing dropped', () => {
  const man = rd('supabase/migrations/MANIFEST');
  assert.match(man, /^forward  supabase\/migrations\/0300_r59_settings_money_hardening\.sql$/m);
  assert.match(rd('scripts/db-test/run-all.sh'), /R59-AUDIT-0300: ALL PASS \\\(56\/56\\\)/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0300'/);
  assert.ok(APPLY.includes(SQL), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.equal((APPLY.match(/^  \('\d\d /gm) || []).length, 18);
  assert.ok(/^[\x00-\x7F]*$/.test(SQL) && /^[\x00-\x7F]*$/.test(APPLY), 'ASCII only');
  assert.match(SQL, /raise exception 'STOP 0300/);
  assert.ok(!/\bdrop (table|column|policy|index)\b|\bdelete from\b|\btruncate\b/i.test(SQL.replace(/--[^\n]*/g, '')), 'no drop / delete');
  assert.ok(!/0117|org_payment_accounts|whatsapp_opt_outs/.test(SQL.replace(/--[^\n]*/g, '')), 'does not need 0117');
  assert.match(rd('package.json'), /node test\/r59-audit\.test\.mjs/);
  const owner = new URL('file:///Users/koushikgoudshaganti/Desktop/Agency/Helm/APPLY-0300.sql');
  if (existsSync(owner)) assert.equal(readFileSync(owner, 'utf8'), APPLY, 'owner paste file = repo APPLY');
});

await t('edge functions: WhatsApp test admin-only + STOP list + trial + daily cap; ping gated; record-only 200; billing e-mail rule', () => {
  const it = rd('supabase/functions/integrations-test/index.ts');
  for (const s of ['integrations_wa_test_target', 'trialSendBlocked', 'whatsapp_opt_outs', 'optOutTableMissing', 'itest:wa:day:']) assert.ok(it.includes(s), s);
  assert.ok(it.indexOf('trialSendBlocked(admin') < it.indexOf('graph.facebook.com/${ver}'), 'checks before the Meta call');
  assert.match(rd('supabase/functions/send-whatsapp/index.ts'), /rpc\("has_area", \{ p_area: "controls", p_need: "view" \}\)/);
  const wh = rd('supabase/functions/razorpay-webhook/index.ts');
  assert.match(wh, /isMissingRpc\(recErr\)/); assert.match(wh, /ignored: true/); assert.match(wh, /studioBillingEmail\(admin/);
  assert.ok(!/business_email"\)/.test(wh) && !/select\("name, business_email"\)/.test(wh));
  assert.match(rd('supabase/functions/billing-reminder/index.ts'), /studioBillingEmail\(admin/);
  assert.match(rd('supabase/functions/verify-upload/sniff.ts'), /"vendor-invoices": \{ mimes: \["application\/pdf"/);
});

console.log(`r59-audit: ${n} test(s) passed.`);
