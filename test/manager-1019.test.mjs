// Manager-role QA 2026-10-19: close gate, refund/bill create checks, P&L double count, privacy words,
// lead form, integrations load, visibility polling, ROLE_CAPS, ASCII payment message (0152).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (m, f) => { f(); n++; console.log('ok - ' + m); };

const SQL = 'supabase/migrations/0152_manager_role_fixes.sql', APPLY = 'supabase/APPLY-0152.sql';

t('0152 + APPLY are ASCII, additive (no drop/delete/truncate), end with VERIFY select (item, ok)', () => {
  for (const p of [SQL, APPLY]) {
    const s = r(p);
    assert.ok(/^[\x00-\x7F]*$/.test(s), p + ' ascii');
    assert.doesNotMatch(s, /\b(drop|delete|truncate)\b/i, p);
    assert.doesNotMatch(s, /\bupdate\s+public\./i, p + ' no row updates');
  }
  const a = r(APPLY).trimEnd();
  assert.match(a, /^-- APPLY-0152/); assert.match(a, /\nbegin;\n/); assert.match(a, /\ncommit;\n/);
  assert.match(a, /select item, ok from \(values[\s\S]*\) v\(item, ok\) order by item;$/);
  assert.ok(a.includes(r(SQL).trim()), 'APPLY embeds the migration verbatim');
});

t('close gate blocks a never-confirmed / unpriced quote, cancelled may still close', () => {
  const s = r(SQL);
  assert.match(s, /create or replace function public\._a49_close_blockers\(p_quote uuid\)/);
  assert.match(s, /if coalesce\(v_status, ''\) <> 'cancelled' then/);
  assert.match(s, /v_nb := 'unconfirmed'/); assert.match(s, /v_nb := 'unpriced'/);
  assert.match(s, /'blocked', \(v_owed > 0 or v_n > 0 or v_nb is not null\)/);
  assert.match(s, /public\.helm_invoice_total\(p_quote\)/, 'keeps the 0110 invoice total');
  assert.match(s, /'not_booked', v_nb/);
});

t('closure page lists the not-booked blocker and treats it as a server blocker', () => {
  const h = r('public/closure.html');
  assert.match(h, /nb==="unconfirmed"/); assert.match(h, /nb==="unpriced"/);
  assert.match(h, /server:owed>0\|\|co>0\|\|!!nb/);
});

t('refunds/vendor bills are checked on insert only (closed event, over-paid refund, unconfirmed bill)', () => {
  const s = r(SQL);
  assert.match(s, /create or replace trigger ad_a152_refund_create_guard before insert on public\.event_refunds/);
  assert.match(s, /create or replace trigger ad_a152_bill_create_guard before insert on public\.vendor_bills/);
  assert.match(s, /c\.closed_at is not null/);
  assert.match(s, /coalesce\(new\.amount, 0\) \+ v_open > v_paid \+ 0\.5/);
  assert.match(s, /r\.status in \('pending', 'approved', 'processed'\)/);
  assert.match(s, /coalesce\(v_status, ''\) = 'quote'/);
  assert.match(s, /if coalesce\(auth\.role\(\), ''\) not in \('anon', 'authenticated'\) then return new; end if;/);
});

t('payment trigger message is ASCII, logic and errcode unchanged', () => {
  const s = r(SQL);
  assert.match(s, /no quote total yet - price the quote before recording a payment/);
  assert.match(s, /errcode = '23514'/);
});

t('workspace P&L does not add the vendor-bills delta twice when the server P&L already counts bills', () => {
  const api = r('public/store-api.js'), ev = r('public/event.html');
  assert.match(api, /billsIncluded = true;/);
  assert.match(api, /refunds, profit, billsIncluded,/);
  assert.match(ev, /billsIncluded:!!pl\.billsIncluded/);
  assert.match(ev, /if\(closureSummary && billsDelta && !closureSummary\.billsIncluded\)/);
});

t('amount in words is masked when amounts are hidden', () => {
  assert.match(r('public/flow.html'), /<div class="prow" data-money style="font-style:italic/);
  assert.match(r('public/quotes.html'), /<span data-money>\$\{!valid\|\|/);
  const pj = r('public/shell-b-privacy.js');
  // the words alternative, evaluated as the page builds it (a JS string literal -> RegExp)
  const lit = pj.match(/\n\s*("\|\(\?:\\\\b\(\?:Rupees[^\n]*?")\s*,/)[1];
  const RE = new RegExp(JSON.parse(lit).slice(1));
  assert.ok(RE.test('Rupees One Lakh Fifty One Thousand Forty only'));
  assert.ok(!RE.test('Only you can see this'));
  assert.match(pj, /\(!\/\\d\/\.test\(s\) && !\/\\bonly\\b\/\.test\(s\)\)/);
  assert.match(pj, /\/\\d\|\\bonly\\b\/\.test\(n\.nodeValue\)/);
});

t('lead form: no negative budget/guests, error is shown, modal sits above the header', () => {
  const h = r('public/leads.html');
  assert.doesNotMatch(h, /id="f_budget"[^>]*data-allow-negative/);
  assert.doesNotMatch(h, /id="f_guests"[^>]*data-allow-negative/);
  assert.match(h, /er\.scrollIntoView\(\{block:"nearest"\}\)/);
  assert.match(h, /\.lmodal\{[^}]*z-index:850;/);
});

t('integrations: reads run in parallel, status call capped, no internal APPLY note', () => {
  const j = r('public/integrations.js');
  assert.doesNotMatch(j, /APPLY-0150\)/);
  assert.match(j, /var both = await Promise\.all\(\[/);
  assert.match(r('public/store-api.js'), /new Promise\(\(r\) => setTimeout\(\(\) => r\(null\), 5000\)\)/);
});

t('shell: showing the tab re-polls at most every 30s', () => {
  const s = r('public/shell-b.js');
  assert.match(s, /Date\.now\(\) - lastVis > 30000/);
  assert.match(s, /Date\.now\(\) - lastVisRun > 30000/);
  assert.doesNotMatch(s, /if \(!document\.hidden\) run\(\); \}\);/);
});

t('ROLE_CAPS: manager has no unused "manage" capability, admin keeps it', () => {
  const s = r('public/store-api.js');
  assert.match(s, /admin: {7}\["view", "create", "edit", "delete", "manage"\]/);
  assert.match(s, /manager: {5}\["view", "create", "edit"\],/);
});

t('MANIFEST lists 0152', () => assert.match(r('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0152_manager_role_fixes\.sql/));

// round 2 (UI QA 1019)
t('issues: long unbroken titles wrap inside the card (css v2)', () => {
  assert.match(r('public/issues-polish.css'), /\.issue \.t\{overflow-wrap:anywhere/);
  assert.match(r('public/issues-polish.css'), /\.issue > div\{min-width:0\}/);
  assert.match(r('public/issues.html'), /issues-polish\.css\?v=2"/);
});
t('payments: past due date needs a confirm, dates shown dd/mm/yyyy', () => {
  const h = r('public/logistics.html');
  assert.match(h, /mDue && mDue<BPStore\.todayLocal\(\) && !\(await BPUI\.confirm\(/);
  assert.equal((h.match(/m\.due_date\?BPStore\.fmtDateIN\(m\.due_date\):""/g) || []).length, 2);
});
t('task schedule: earlier today is blocked (time-level check)', () => {
  assert.match(r('public/ops.html'), /new Date\(when\)\.getTime\(\) < Date\.now\(\)-5\*60000/);
});
t('dashboard: no "Good evening" before 5 AM', () => {
  const j = r('public/shell-b-dash.js');
  assert.match(j, /var greet = hr < 5 \? "Hello"/); assert.match(r('public/shell-proto.js'), /SHELL_V = "130"/);
});
t('flow step 9: next-step says confirmed only after an advance', () => {
  const h = r('public/flow.html');
  assert.match(h, /id="pay_next" data-next-step><b>Next step:<\/b> record the advance above/);
  // QA1026 #13: one call site left - paintBookingBadge() confirms only when an advance receipt exists
  assert.equal((h.match(/payNextConfirmed\(\)/g) || []).length, 2);
  assert.match(h, /if\(paidCount>0\)\{ b\.textContent="Confirmed"; b\.hidden=false; payNextConfirmed\(\); return; \}/);
});
t('demo notice: once per session off the dashboard (auth-ui v32)', () => {
  assert.match(r('public/auth-ui.js'), /pageName\(\) !== "dashboard" && sessionStorage\.getItem\("helm_demo_seen"\) === "1"/);
  assert.match(r('public/store-api.js'), /AUTH_UI_VERSION = "40"/);
});

console.log('manager-1019: ' + n + ' checks passed');
