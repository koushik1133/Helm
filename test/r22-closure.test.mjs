// r22 closure (migration 0254): Closure summary dashboard, the live "Before you close" checklist (per-item
// inventory), "Request to close anyway" -> approve / decline (bell + team chat + queued e-mail), normal close unchanged.
// Behaviour of the SQL: tests/db/r22-closure-0254.sql (local PG).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const SQL = read('supabase/migrations/0254_closure_checklist_override.sql');
const APPLY = read('supabase/APPLY-0254.sql');
const HTML = read('public/closure.html'), API = read('public/store-api.js'), CSS = read('public/closure-polish.css');
const JS = read('public/closure-checklist.js');
require('../public/closure-checklist.js');
const H = globalThis.HelmClosure;

await t('helpers: buttonState follows the checklist (closed > early > pending > request > close)', () => {
  assert.equal(H.buttonState({ checks: [{ status: 'ok' }] }).mode, 'close');
  assert.equal(H.buttonState({ checks: [{ status: 'warn' }] }).mode, 'close', 'warnings never block');
  assert.equal(H.buttonState({ checks: [{ status: 'fail', override: 'any' }] }).mode, 'request');
  assert.equal(H.buttonState({ checks: [{ status: 'fail' }], pending: { status: 'pending' } }).mode, 'pending');
  assert.equal(H.buttonState({ checks: [{ status: 'fail', override: 'none' }], too_early: true }).mode, 'early');
  assert.equal(H.buttonState({ checks: [], closed_at: '2026-10-19T00:00:00Z' }).mode, 'closed');
  const s = H.summary({ checks: [{ status: 'fail', override: 'admin' }, { status: 'warn' }, { status: 'ok' }] });
  assert.deepEqual([s.fail, s.warn, s.ok, s.adminOnly], [1, 1, 1, true]);
});

await t('helpers: inventory totals, fix links, cost split, percentages', () => {
  const it = H.invTotals([{ reserved: 50, checked_out: 50, checked_in: 47, missing: 3, written_off: 3, still_out: 0, reserved_open: 50, status: 'fail' },
                          { reserved: 10, checked_out: 10, checked_in: 10, status: 'ok' }]);
  assert.deepEqual([it.items, it.out, it.back, it.missing, it.writtenOff, it.reservedOpen, it.notBack], [2, 60, 57, 3, 3, 50, 1]);
  assert.equal(H.fixHref('settlement', 'a b'), 'settlement.html?quote=a%20b');
  assert.equal(H.fixHref('inventory', 'q1'), 'inventory.html?quote=q1');
  assert.equal(H.fixHref('event', 'q1'), 'event.html?id=q1');
  assert.equal(H.fixHref('javascript:alert(1)', 'q1'), '', 'unknown fix targets never become links');
  const cs = H.costSplit({ lines: [{ source: 'crew', c_fc: 1500 }, { source: 'booking', c_fc: 20000, paid: 5000 }, { source: 'bill', c_fc: 800, paid: 800 }, { source: 'claim', c_fc: 300 }] });
  assert.deepEqual(cs, { staff: 1500, vendors: 20800, vendorsPaid: 5800, other: 300 });
  assert.equal(H.pct(25, 100), 25); assert.equal(H.pct(1, 0), null);
  const top = H.topCategories({ by_category: [{ key: 'venue', expected: 5 }, { key: 'contingency', expected: 99 }, { key: 'food', expected: 9 }, { key: 'x', expected: 0 }] }, 4);
  assert.deepEqual(top.map((c) => c.key), ['food', 'venue'], 'contingency + empty categories left out');
});

await t('closure-checklist.js: no HTML-string sinks, amounts tagged for "Hide amounts"', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\./.test(JS), 'DOM via textContent only');
  assert.ok(/data-money/.test(JS));
  assert.ok(/aria-modal/.test(JS) && /Escape/.test(JS), 'dialog is accessible + closes on Escape');
  assert.ok(/Request to close anyway/.test(JS) && /at least 10 characters/.test(JS), 'mandatory reason (10+)');
});

await t('closure.html: dashboard + checklist + request panel wired; normal close kept', () => {
  for (const id of ['id="closeDash"', 'id="closeChecklist"', 'id="close-request"', 'id="closeBtn"']) assert.ok(HTML.includes(id), id);
  assert.match(HTML, /<script src="closure-checklist\.js\?v=\d+"><\/script>/);
  assert.ok(HTML.includes('BPStore.closure.requestClose(') && HTML.includes('BPStore.closure.decideClose(') && HTML.includes('BPStore.closure.withdrawClose('));
  assert.ok(HTML.includes('if(st.mode==="close") return finishClose(null,false);'), 'no blockers -> the unchanged normal close');
  assert.ok(/required:true/.test(HTML), 'decline note is required');
  assert.ok(CSS.includes('.cl-inv') && CSS.includes('.cl-modal'));
});

await t('store-api: closure RPC wrappers + bell kinds route to the request', () => {
  for (const r of ['"event_closure_review"', '"request_event_close"', '"decide_event_close"', '"withdraw_event_close_request"']) assert.ok(API.includes(r), r);
  assert.ok(API.includes('k === "event_close_request" || k === "event_close_decision"') && API.includes('#close-request'));
  assert.ok(API.includes('event_close_request: [') && API.includes('event_close_decision: ['));
});

await t('SQL 0254: additive, org-scoped, role-checked, e-mail through the existing outbox', () => {
  assert.ok(!/\bdrop\s+table\b|\btruncate\b|\bdelete\s+from\b/i.test(SQL), 'nothing dropped / deleted');
  assert.ok(!/[^\x00-\x7f]/.test(SQL) && !/[^\x00-\x7f]/.test(APPLY), 'ASCII only');
  assert.ok(/create table if not exists public\.event_close_requests/.test(SQL));
  assert.ok(/enable row level security/.test(SQL) && /org_id = \(select public\.current_org_id\(\)\) and public\.has_area\('closure', 'view'\)/.test(SQL));
  assert.ok(/revoke all on public\.event_close_requests from public, anon, authenticated;\ngrant select on public\.event_close_requests to authenticated;/.test(SQL), 'no API writes');
  for (const f of ['event_closure_review', 'request_event_close', 'decide_event_close', 'withdraw_event_close_request', '_r22_close_mail', '_r22_mail_enqueue'])
    assert.match(SQL, new RegExp('function public\\.' + f + '\\([^)]*\\)\\s*\\nreturns [a-z]+ language [a-z]+ (stable|volatile) security definer set search_path = \'\''), f);
  assert.ok(SQL.includes("You can''t decide your own close request") && SQL.includes('Only an admin can approve closing past'));
  assert.ok(SQL.includes('perform public.close_event(q.quote_id, true'), 'approve closes through the unchanged close_event');
  assert.ok(!/create or replace function public\.close_event\(/.test(SQL), 'close_event itself untouched');
  assert.equal((SQL.match(/perform public\._r22_mail_enqueue\(/g) || []).length, 3, 'request + decline + approve queue an e-mail');
  assert.ok(SQL.includes("check (kind in ('sales_request', 'upgrade_ask', 'close_request', 'close_decision'))"), 'kind check widened to a superset');
  assert.ok(APPLY.includes(SQL.trim().slice(0, 4000)) && /^begin;$/m.test(APPLY) && /^commit;$/m.test(APPLY) && /'08 e-mail lane/.test(APPLY));
});

await t('helm-notices: close request / decision e-mails (plain text, header-safe, fixed link)', async () => {
  const m = await import('../supabase/functions/comms-dispatch/helm-notices.mjs');
  const q = 'a0000000-0000-4000-8000-0000000254c1';
  assert.ok(m.NOTICE_KINDS.includes('close_request') && m.NOTICE_KINDS.includes('close_decision'));
  assert.ok(m.NOTICE_TX_REASON.close_request && m.NOTICE_TX_REASON.close_decision);
  const r = m.helmNoticeEmail('close_request', { quote_id: q, event: 'Wedding\r\nBcc: x@y.z', code: 'A-1', event_date: '18/10/2026',
    requested_name: 'Sam', reason: 'Receipt tomorrow', failed: ['No expense claims waiting'], studio: 'Spark' }, 'https://app.example.com/');
  assert.ok(!/[\r\n]/.test(r.subject), 'no header injection');
  assert.ok(r.text.includes('https://app.example.com/closure.html?quote=' + q + '#close-request') && r.text.includes('- No expense claims waiting'));
  assert.equal(m.helmNoticeEmail('close_request', { quote_id: 'nope', reason: 'x' }, ''), null, 'bad id -> skipped');
  assert.equal(m.helmNoticeEmail('close_request', { quote_id: q }, ''), null, 'no reason -> skipped');
  const a = m.helmNoticeEmail('close_decision', { quote_id: q, status: 'approved', decided_name: 'Cora', event: 'Wedding' }, '');
  assert.ok(a.subject.startsWith('Close request approved') && a.text.includes('Cora approved'));
  const d = m.helmNoticeEmail('close_decision', { quote_id: q, status: 'declined', decided_name: 'Manu', note: 'Approve the claim first' }, '');
  assert.ok(d.subject.startsWith('Close request declined') && d.text.includes('Approve the claim first'));
  assert.equal(m.helmNoticeEmail('close_decision', { quote_id: q, status: 'pending' }, ''), null);
});

await t('db-test runner + MANIFEST know 0254', () => {
  assert.ok(read('scripts/db-test/run-all.sh').includes('tests/db/r22-closure-0254.sql'));
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0254_closure_checklist_override.sql'));
});

console.log(`\nr22-closure: ${n} passed`);
