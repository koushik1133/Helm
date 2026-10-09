/* ui-fixes.test.mjs — static guards for the fix-ui pass (L8 blank-quote reuse, #16 booklet
 * studio contact). DB behaviour is proven in tests/db/ui-fixes.sql (migration 0075). */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, f) => { f(); n++; console.log('  ok - ' + name); };
const dash = read('public/dashboard.html'), api = read('public/store-api.js'), login = read('public/login.html');
const ctrl = read('public/control.html'), booklet = read('public/booklet.js'), sql = read('supabase/migrations/0075_ui_fixes.sql');

t('L8: dashboard "Generate a quote" reuses via startBlank, never a bare create', () => {
  const btn = dash.slice(dash.indexOf('$("#createBtn").addEventListener'), dash.indexOf('$("#loginForm")'));
  assert.match(btn, /BPStore\.quotes\.startBlank\(code\)/);
  assert.doesNotMatch(btn, /BPStore\.quotes\.create\(/);
});
t('L8: store-api startBlank calls start_blank_quote and falls back only when the RPC is missing', () => {
  assert.match(api, /async startBlank\(code\) \{\s*const \{ data: q, error \} = await supa\.rpc\("start_blank_quote", \{ p_code: code, p_title: code \}\);/);
  assert.match(api, /error\.code === "PGRST202" \|\| error\.code === "42883"\) return this\.create\(code, code, null, \{ items: \[\] \}, 0\);\s*throw error;/);
  assert.match(api, /startBlank: \(code\) => \{ const t = qt\(\); return typeof t\.startBlank === "function"/);
});
t('L8: 0075 RPC keeps the gates, locks per user, never deletes', () => {
  const fn = sql.slice(sql.indexOf('create or replace function public.start_blank_quote'), sql.indexOf('revoke all on function public.start_blank_quote'));
  assert.match(fn, /security definer set search_path = ''/);
  assert.match(fn, /has_area\('quotes', 'edit'\)/); assert.match(fn, /can_create\(\)/);
  assert.match(fn, /pg_advisory_xact_lock\(hashtextextended\('helm:blankq:' \|\| v_org::text \|\| ':' \|\| v_uid::text, 0\)\)/);
  for (const c of ["client ->> 'name'", 'event_date is null', 'current_version = 1', 'archived_at is null', 'deleted_at is null',
    "interval '7 days'", 'v.created_by = v_uid', 'quote_payments', 'payment_milestones', 'quote_consents', 'approval_token is null'])
    assert.ok(fn.includes(c), 'untouched rule: ' + c);
  assert.doesNotMatch(sql, /\bdelete\s+from\b|\bdrop\s+table\b|\btruncate\b/i);
});
t('#16: signup never seeds the business email with the login email', () => {
  for (const m of login.matchAll(/createStudio\(([^;]*?)\)/g)) assert.doesNotMatch(m[1], /email/, m[0]);
  assert.equal((login.match(/createStudio\(/g) || []).length, 3);
});
t('#16: Control Center save confirms the business email + keeps brand keys + saves a phone', () => {
  assert.match(ctrl, /<input id="o_phone" type="tel"/);
  assert.match(ctrl, /business_email_confirmed:!!email/);
  assert.match(ctrl, /brand:Object\.assign\(\{\}, orgBrand, \{ logo:logo\|\|null, accent:accent\|\|null, phone:/);
  assert.match(ctrl, /V\.phone\(phone\)/);
  assert.match(api, /"business_email_confirmed" in patch && \(error\.code === "PGRST204"/, 'older DB: save still works');
});
t('#16: booklet top contact = coordinator > studio phone > confirmed email (textContent only)', () => {
  const cover = booklet.slice(booklet.indexOf('function renderCover'), booklet.indexOf('function renderToc'));
  const iCo = cover.indexOf('if (co && (co.name || co.phone))'), iPh = cover.indexOf('else if (s.phone)'), iEm = cover.indexOf('else if (bizEmail');
  assert.ok(iCo > 0 && iPh > iCo && iEm > iPh, 'precedence order');
  assert.doesNotMatch(cover, /business_email/, 'never falls back to a raw business_email field');
  assert.doesNotMatch(cover, /innerHTML/);
  assert.match(sql, /if not coalesce\(v_ok, false\) then r := jsonb_set\(r, '\{studio\}', \(r -> 'studio'\) - 'email'\)/);
});
console.log(`ui-fixes: ${n} passed`);
