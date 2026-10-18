// money-1024 - money display fixes from the staging test (studio SAI, events 10132026-01/02).
//  1. quotes list total = quote total + APPROVED change orders (same as workspace / settlement)
//  2. client page Due = confirmed events only (0160, proven in tests/db/client-due-0160.sql)
//  3. "Status now" reads confirmed for a confirmed event left on stage quote (0160)
//  4. event page "Record advance" opens the quote workspace payment step, not logistics
//  5. a refused (0-row / RLS / 403) save is NOT reported as "changed elsewhere"
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const STORE = read('public/store-api.js'), QH = read('public/quotes.html'), EH = read('public/event.html'), FH = read('public/flow.html');
const SQL = read('supabase/migrations/0160_client_due_confirmed_only.sql'), APPLY = read('supabase/APPLY-0160.sql');
const MAN = read('supabase/migrations/MANIFEST');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };

t('1 store: approvedChangeTotals sums approved price deltas per quote in one read', () => {
  const f = STORE.slice(STORE.indexOf('async approvedChangeTotals('), STORE.indexOf('async addChange('));
  assert.match(f, /from\("change_requests"\)\.select\("quote_id,price_delta"\)\.in\("quote_id", ids\)\.eq\("status", "approved"\)/);
  assert.match(f, /c\.status === "approved"/);
});
t('1 quotes list renders base + approved changes, fail-soft', () => {
  // qts-1018: the rule now lives once in store-api (BPStore.invoiceTotal), shared with the workspace header
  assert.match(QH, /const listTotal=\(x\)=>BPStore\.invoiceTotal\(x, chgTotals\[x\.id\]\);/);
  assert.match(QH, /\$\{listTotal\(x\)\?esc\(BPStore\.quoteMoney\(listTotal\(x\),x\)\)/);
  assert.match(QH, /refreshStale\(\); refreshChanges\(\);/);
  assert.match(QH, /async function refreshChanges\(\)\{[\s\S]{0,400}\}catch\(_\)\{\}/);
  // behaviour: 82,600 + approved 5,000 = 87,600; no change -> base; no base -> nothing
  const body = STORE.slice(STORE.indexOf('BPStore.invoiceTotal = function'), STORE.indexOf('BPStore.studioMoney = function'));
  const invoiceTotal = new Function('return ' + body.slice(body.indexOf('function'), body.lastIndexOf('};') + 1))();
  const chg = { q2: 5000 }, listTotal = (x) => invoiceTotal(x, chg[x.id]);
  assert.equal(listTotal({ id: 'q2', total: 82600 }), 87600);
  assert.equal(listTotal({ id: 'q1', total: 77600 }), 77600);
  assert.equal(listTotal({ id: 'q3', total: 0 }), 0);
});
t('2+3 migration 0160: additive, confirmed-only due incl. approved changes, stage label', () => {
  assert.ok(!/[^\x00-\x7f]/.test(SQL), 'ASCII only');
  assert.ok(!/\b(drop\s+(table|column|function|trigger)|truncate|delete\s+from|alter\s+table|insert\s+into|update\s+public)\b/i.test(SQL.replace(/--[^\n]*/g, '')), 'read-only function only');
  assert.match(SQL, /^-- 0160_client_due_confirmed_only\.sql - CANONICAL forward-only\./);
  assert.match(SQL, /when st = 'confirmed' then greatest\(inv - pd, 0\)/);
  assert.match(SQL, /when st = 'confirmed' then greatest\(base \+ chg - pd, 0\)/);
  assert.match(SQL, /c\.status = 'approved'/);
  assert.equal((SQL.match(/case when q\.status = 'confirmed' and coalesce\(nullif\(q\.lifecycle_stage, ''\), 'quote'\) = 'quote' then 'confirmed'/g) || []).length, 2);
  assert.match(SQL, /security definer set search_path = ''/);
  assert.match(SQL, /grant execute on function public\.client_timeline\(uuid, integer\) to authenticated/);
  assert.match(MAN, /forward  supabase\/migrations\/0160_client_due_confirmed_only\.sql/);
  assert.ok(APPLY.includes(SQL.trim().slice(0, 2000)), 'APPLY carries the migration');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /03 due counts confirmed events only/);
});
t('4 event page: Record advance -> quote workspace payment step', () => {
  assert.match(EH, /t="Record advance"; href="flow\.html\?quote="\+q\+"#sec-pay";/);
  assert.ok(!/Record advance"; href="logistics\.html/.test(EH));
  assert.match(FH, /<section class="card" id="sec-pay">/);
  assert.match(FH, /location\.hash==="#sec-pay" && \$\("#sec-pay"\)/);
});
t('5 store: 0 rows with a lock token is a CONFLICT only when the row really moved on', () => {
  const f = STORE.slice(STORE.indexOf('async updateMeta(quoteId, patch, expectedUpdatedAt)'), STORE.indexOf('// localStorage fallback tier'));
  assert.match(f, /select\("updated_at"\)\.eq\("id", quoteId\)\.maybeSingle\(\)/);
  assert.match(f, /if \(cur && !sameStamp\(cur, expectedUpdatedAt\)\) \{/);
  assert.match(f, /e\.code = "NOT_SAVED"; throw e;\n        \}/);
  const sameStamp = new Function('return ' + STORE.match(/function sameStamp\(a, b\) \{[^\n]*\}/)[0])();
  assert.equal(sameStamp('2026-10-13T10:00:00.123+00:00', '2026-10-13T10:00:00.123Z'), true);
  assert.equal(sameStamp('2026-10-13T10:00:00.123+00:00', '2026-10-13T10:00:01.000+00:00'), false);
});
t('5 flow: own writes (advance recorded / failed quote save) refresh the lock base', () => {
  assert.match(FH, /await relock\(\);   \/\/ money-1024: recording the advance confirms the booking/);
  assert.match(FH, /if\(!rpcMissing\)\{\n        await relock\(\);/);
  assert.match(FH, /\$\("#pay_record"\)\.removeAttribute\("aria-busy"\); relock\(\);/);
});
t('verify-166: Record advance deep link retries the scroll until #sec-pay is at the top, stops on user input', () => {
  assert.match(FH, /location\.hash==="#sec-pay" && \$\("#sec-pay"\)\)\{ let n=0, stop=false;/);
  assert.match(FH, /\["wheel","touchstart","keydown","mousedown"\]\.forEach/);
  assert.match(FH, /\+\+n<20\) setTimeout\(go,150\)/);
  assert.match(FH, /const laidOut=s\.getClientRects\(\)\.length>0 && s\.offsetHeight>0;/);
});
console.log(`money-display-1024: ${n} passed`);
