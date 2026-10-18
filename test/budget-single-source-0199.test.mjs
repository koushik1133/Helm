// 0199: one budget (and guest count) per event - the quote is the source; Discovery shows it,
// the CRM lead follows it (DB trigger), and the one-time fill only fills blanks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok ' + n); } catch (e) { fail++; console.log('  FAIL ' + n); console.log(e.message); } };
const FLOW = read('public/flow.html'), DISC = read('public/discovery.html'), EV = read('public/event.html');
const M = read('supabase/migrations/0199_budget_single_source.sql'), A = read('supabase/APPLY-0199.sql');

t('flow: step 1 budget prefers the quote budget over the Discovery copy', () => {
  assert.match(FLOW, /if\(cl\.budget!=null && cl\.budget!==""\)\{ \$\("#d_bmax"\)\.value=cl\.budget; \} \}/);
  assert.ok(!/legacy quotes kept only client\.budget/.test(FLOW));
  // still exactly one budget input on the flow page, in step 1 (not in Discovery)
  assert.equal((FLOW.match(/id="d_bmax"/g) || []).length, 1);
  const disc = FLOW.slice(FLOW.indexOf('<!-- 2 DISCOVERY -->'), FLOW.indexOf('<!-- 3 REQUIREMENTS -->'));
  assert.ok(!/budget/i.test(disc), 'no budget field in the Discovery section');
});
t('discovery page: budget is read-only, shows the quote budget, links to step 1', () => {
  assert.match(DISC, /id="d_bmax" placeholder="Not set yet" readonly aria-describedby="d_bmaxHint"/);
  assert.match(DISC, /<a id="d_bmaxEdit" href="flow\.html">Edit in step 1<\/a>/);
  assert.match(DISC, /\$\("#d_bmaxEdit"\)\.href="flow\.html\?quote="\+encodeURIComponent\(id\)\+"#sec-client"/);
  assert.match(DISC, /\{ const b=ev&&ev\.client&&ev\.client\.budget; if\(b!=null&&b!==""\) \$\("#d_bmax"\)\.value=b; \}/);
  assert.ok(!/if\(!\$\("#d_bmax"\)\.value\)\{ const b=ev/.test(DISC), 'quote budget always wins, not only when empty');
});
t('event workspace: discovery summary budget reads the quote budget first', () => {
  assert.match(EV, /const budgetRange=\(\)=>\{ const cb=ev&&ev\.client&&ev\.client\.budget; if\(cb!=null&&cb!==""&&isFinite\(\+cb\)\) return inr\(\+cb\);/);
});
t('CRM: Leads card / lead detail / CRM table read leads.budget + guest_count (filled by the trigger)', () => {
  const L = read('public/leads.html'), C = read('public/crm.html');
  assert.match(L, /\$\{l\.budget\?`<span class="amt">\$\{fmt\(l\.budget\)\}<\/span>`:""\}/);
  assert.match(L, /\["Budget", l\.budget\?fmt\(l\.budget\):""\], \["Guests", l\.guest_count\]/);
  assert.match(C, /<td class="amt">\$\{r\.budget\?fmt\(r\.budget\):""\}<\/td>/);
});
t('0199 trigger: budget + guests copied to the linked lead, only when set / changed', () => {
  assert.match(M, /create or replace function public\.sync_quote_to_lead\(\)/);
  assert.match(M, /v_bchg := \(OLD\.client->>'budget'\) is distinct from \(NEW\.client->>'budget'\);/);
  assert.match(M, /budget      = case when v_bchg and v_budget is not null then v_budget else budget end,/);
  assert.match(M, /guest_count = case when v_gchg and v_guests is not null then v_guests else guest_count end,/);
  assert.match(M, /insert into public\.leads \(org_id, name, phone, email, source, event_type, event_date, budget, guest_count, status, quote_id\)/);
  assert.match(M, /SECURITY DEFINER/);
});
t('0199 fill: blanks only, sync paused only inside the statement, sample master skipped', () => {
  const code = M.replace(/--.*$/gm, '');
  assert.ok(!/\b(drop table|delete from|truncate)\b/i.test(code));
  assert.match(code, /alter table public\.quotes disable trigger quotes_sync_lead_upd/);
  assert.match(code, /if v_paused then execute 'alter table public\.quotes enable trigger quotes_sync_lead_upd'; end if;/);
  assert.match(code, /d\.budget_min is null and d\.budget_max is null/);
  assert.match(code, /set budget      = coalesce\(l\.budget, /);
  assert.match(code, /guest_count = coalesce\(l\.guest_count, /);
  assert.equal((code.match(/coalesce\(o\.is_sample_master, false\)/g) || []).length, 4);
});
t('0199 SQL: ASCII, in MANIFEST, APPLY carries the migration verbatim + PREVIEW + VERIFY, DB suite registered', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(M) && /^[\x00-\x7F]*$/.test(A));
  assert.ok(A.includes(M)); assert.match(A, /-- PREVIEW/); assert.match(A, /-- VERIFY/);
  assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0199_budget_single_source\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /BUDGET-SINGLE-SOURCE-0199: ALL PASS \\\(32\/32\\\)/);
});
if (fail) { console.log('budget-single-source-0199: ' + fail + ' FAILED'); process.exit(1); }
console.log('budget-single-source-0199: ok');
