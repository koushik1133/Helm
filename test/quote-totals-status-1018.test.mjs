// qts-1018 - owner test on prod trial studio (quote 10182026-01, wedding, 50,000 guests):
//  1. TOTAL: Event Workspace header and Quotes list showed different totals for the same quote.
//     Both now use ONE rule, BPStore.invoiceTotal = the server-stamped pricing.total (D8 trigger)
//     + APPROVED change orders; the workspace header reads its change orders itself instead of
//     waiting for (or silently falling back when) the 20-call settlement burst fails / is slow;
//     Back/Forward (bfcache) re-reads both pages instead of showing the old numbers.
//  2. STATUS: "Confirmed · awaiting client approval" + "Sent" side by side. BPStore.quoteStatus
//     folds status + client approval + stage into ONE label ("Confirmed" only after the client
//     approved); Quotes list, workspace header + stage strip, dashboard and (0189) the client page.
//  3. The reference code never wraps at its hyphen.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const STORE = read('public/store-api.js'), QH = read('public/quotes.html'), EH = read('public/event.html'), DH = read('public/dashboard.html');
const QCSS = read('public/quotes-polish.css'), MAN = read('supabase/migrations/MANIFEST');
const MIG = read('supabase/migrations/0189_quote_status_label.sql'), APPLY = read('supabase/APPLY-0189.sql'), VERIFY = read('supabase/VERIFY-0189.sql');
const RUNALL = read('scripts/db-test/run-all.sh'), SUITE = read('tests/db/quote-status-0189.sql');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };

// ---- run the real store-api.js in a sandbox (local tier: no Supabase config) ----
function memStore(seed) { const m = new Map(Object.entries(seed || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] || null, get length() { return m.size; } }; }
function load(ls) {
  const el = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} });
  const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=249' },
    createElement: el, head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { localStorage: memStore(ls), sessionStorage: memStore(), document: doc, navigator: { onLine: true },
    location: { pathname: '/quotes', search: '', hash: '', origin: 'https://www.helm.events', href: 'https://www.helm.events/quotes', hostname: 'www.helm.events', replace() {}, reload() {} },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }), addEventListener() {}, removeEventListener() {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, console: { log() {}, info() {}, warn() {}, error() {} } };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(STORE, win, { filename: 'store-api.js' });
  return win.BPStore;
}

await t('status: one label from status + approval + stage ("Confirmed" only after the client approved)', () => {
  const S = load();
  const L = (q, o) => S.quoteStatus(q, o).label, K = (q, o) => S.quoteStatus(q, o).key;
  // the owner's quote: studio locked it (status confirmed), approval link sent, stage still quote
  const owner = { code: '10182026-01', status: 'confirmed', approvalStatus: 'sent', lifecycleStage: 'quote' };
  assert.equal(L(owner), 'Sent · awaiting client approval'); assert.equal(S.quoteStatus(owner).confirmed, false);
  assert.ok(!/Confirmed/.test(L(owner)), 'a sent quote never reads Confirmed');
  assert.equal(K({ status: 'confirmed', approvalStatus: 'none', lifecycleStage: 'quote' }), 'locked');
  assert.equal(L({ status: 'confirmed', approvalStatus: 'none' }), 'Locked · not sent yet');
  assert.equal(L({ status: 'quote', approvalStatus: 'sent' }), 'Sent · awaiting client approval');
  assert.equal(L({ status: 'quote' }), 'Quote'); assert.equal(L({}), 'Quote');
  assert.equal(L({ status: 'confirmed', approvalStatus: 'approved', lifecycleStage: 'confirmed' }), 'Confirmed · client approved');
  assert.equal(L({ status: 'confirmed', approvalStatus: 'approved', lifecycleStage: 'quote' }), 'Confirmed · client approved');   // stage lagging
  assert.equal(L({ status: 'confirmed', approvalStatus: 'paid' }), 'Confirmed · advance paid');
  assert.equal(L({ status: 'confirmed', approvalStatus: 'sent' }, { advance: true }), 'Confirmed · advance paid');   // advance in the ledger
  assert.equal(L({ status: 'confirmed', approvalStatus: 'none', lifecycleStage: 'planning' }), 'Confirmed');   // admin override / older events
  assert.equal(L({ status: 'confirmed', lifecycleStage: 'closed' }), 'Closed'); assert.equal(L({ status: 'confirmed', closedAt: '2026-10-01' }), 'Closed');
  assert.equal(L({ status: 'cancelled', approvalStatus: 'approved' }), 'Cancelled');
  // raw DB rows (snake_case) give the same answer
  assert.equal(L({ status: 'confirmed', approval_status: 'sent', lifecycle_stage: 'quote' }), 'Sent · awaiting client approval');
  // every label is ONE string: never two state words for the same row
  for (const q of [owner, { status: 'confirmed', approvalStatus: 'approved' }, { status: 'quote' }]) assert.equal(typeof S.quoteStatus(q).label, 'string');
});

await t('total: the owner\'s quote shows the SAME number in the Quotes list and the workspace header', async () => {
  const qid = 'q-10182026-01';
  const S = load({ bp_changes: JSON.stringify([
    { id: 'c1', quote_id: qid, status: 'approved', price_delta: 11800 },
    { id: 'c2', quote_id: qid, status: 'requested', price_delta: 99999 },
    { id: 'c3', quote_id: 'other', status: 'approved', price_delta: 500 }]) });
  assert.equal(S.mode(), 'local');
  const row = { id: qid, code: '10182026-01', total: 29935420 };                       // list row: total = pricing->total
  const ev = { id: qid, code: '10182026-01', pricing: { total: 29935420 } };            // workspace: quotes.get (no top-level total)
  const ch = await S.budget.approvedChangeTotals([qid]);
  assert.equal(ch[qid], 11800);
  const list = S.invoiceTotal(row, ch[qid]), header = S.invoiceTotal(ev, ch[qid]);
  assert.equal(list, 29947220); assert.equal(header, list);
  const inv = await S.budget.invoiceTotals([row, { id: 'q2', total: 50000 }, { id: 'q3', total: 0 }]);
  assert.equal(inv[qid], 29947220); assert.equal(inv.q2, 50000); assert.equal(inv.q3, 0);
  // budget.summary (settlement / closure / Payments) uses the same rule
  assert.equal(S.invoiceTotal({ total: 82600 }, 5000), 87600); assert.equal(S.invoiceTotal({ total: 'x' }, 5), 0); assert.equal(S.invoiceTotal(null, 5), 0);
  assert.equal(S.invoiceTotal({ total: 1000 }, NaN), 1000);
});

await t('quotes list: one status pill, invoiceTotal, refresh on reload + Back/Forward', () => {
  assert.ok(!/Confirmed · awaiting client approval/.test(QH), 'old contradictory label gone');
  assert.ok(!/const apprBadge=/.test(QH) && !/apprBadge\(x\.approvalStatus\)/.test(QH), 'no second approval pill');
  assert.match(QH, /const statusPill=\(x\)=>\{ const st=BPStore\.quoteStatus\(x\);/);
  assert.match(QH, /:statusPill\(x\)\}/);
  assert.match(QH, /const listTotal=\(x\)=>BPStore\.invoiceTotal\(x, chgTotals\[x\.id\]\);/);
  assert.match(QH, /anyQuotes=null; chgKey=""; staleKey="";/);
  assert.match(QH, /window\.addEventListener\("pageshow",\(e\)=>\{ if\(e&&e\.persisted&&pager\) reloadQuiet\(\); \}\);/);
  assert.match(QH, /data-f="confirmed"[^>]*>Sent &amp; confirmed<\/button>/);
});

await t('workspace: one header label, stage strip follows client approval, header total by the shared rule', () => {
  assert.ok(!/Client link not approved/.test(EH) && !/const apprBadge=/.test(EH));
  assert.match(EH, /\$\("#statusBadge"\)\.innerHTML=statusBadge\(\);\n    \$\("#apprBadge"\)\.textContent="";/);
  assert.match(EH, /const statusBadge=\(\)=>\{ const st=BPStore\.quoteStatus\(ev,\{advance:advanceIn\(\)\}\);/);
  // a locked + sent quote no longer jumps the strip to "Confirmed"
  assert.match(EH, /stageIndex\(k\)<stageIndex\("confirmed"\) && BPStore\.quoteStatus\(ev,\{advance:advanceIn\(\)\}\)\.confirmed\) \? "confirmed" : k;/);
  assert.ok(!/ev\.status==="confirmed" && stageIndex\(k\)<stageIndex\("confirmed"\)\) \? "confirmed"/.test(EH));
  // header total: invoiceTotal over its own change-order read, not settleSummary.revenue || base
  assert.match(EH, /const inv = BPStore\.invoiceTotal\(ev, chg\);/);
  assert.ok(!/settleSummary\.revenue>0\)\?settleSummary\.revenue:evTotal\(\)/.test(EH));
  assert.match(EH, /BPStore\.budget\.approvedChangeTotals\(\[ev\.id\|\|id\]\)\.then\(m=>\{ hdrChange=Number\(\(m\|\|\{\}\)\[ev\.id\|\|id\]\)\|\|0; render\(\); \}\)\.catch\(\(\)=>\{\}\);/);
  assert.match(EH, /window\.addEventListener\("pageshow",\(e\)=>\{ if\(e&&e\.persisted&&ev\) location\.reload\(\); \}\);/);
});

await t('dashboard: same label + invoice total on the quote cards', () => {
  assert.match(DH, /const statBadge = \(q\) => \{ const st = BPStore\.quoteStatus\(q\);/);
  assert.match(DH, /\$\{statBadge\(s\)\}/);
  assert.match(DH, /invTotals = \(await BPStore\.budget\.invoiceTotals\(summaries\)\) \|\| \{\}/);
  assert.match(DH, /cardTotal\(s\) \? " · " \+ esc\(BPStore\.quoteMoney\(cardTotal\(s\), s\)\)/);
  assert.match(DH, /renderList\(\); refreshInvoiceTotals\(\); \} \}\);/);
});

// review-1018: the LIVE dashboard is shell-b-dash.js / shell-b-money.js (shell-proto loads them on
// dashboard.html) - its event pills + Upcoming rows used to say "Confirmed" for a locked + sent quote
// and showed the bare quote total. Run the real pill code against the real BPStore.quoteStatus.
await t('live dashboard (shell-b-dash): pills + calendar tone use the one label', () => {
  const SD = read('public/shell-b-dash.js');
  const a = SD.indexOf('  function qStatus(q)'), b = SD.indexOf('return pill("mute", st === "quote" ? "Tentative" : "Draft");', a);
  assert.ok(a > 0 && b > a, 'qStatus .. statusPill block present');
  const src = SD.slice(a, SD.indexOf('}', b) + 1);
  const S = load();
  const pill = (kind, text) => ({ kind, text, title: '' });
  const f = new Function('S', 'pill', src + '\nreturn { statusPill: statusPill, qTone: qTone };')(() => S, pill);
  const owner = { status: 'confirmed', approvalStatus: 'sent', lifecycleStage: 'quote' };
  assert.equal(f.statusPill(owner).text, 'Sent · awaiting client approval'); assert.equal(f.statusPill(owner).kind, 'wait');
  assert.equal(f.qTone(owner), 'tent', 'a sent quote is tentative on the calendar, not booked');
  assert.equal(f.statusPill({ status: 'confirmed', approvalStatus: 'none' }).text, 'Locked · not sent yet');
  assert.equal(f.qTone({ status: 'confirmed', approvalStatus: 'none' }), 'quote');
  assert.equal(f.statusPill({ status: 'confirmed', approvalStatus: 'approved' }).text, 'Confirmed · client approved');
  assert.equal(f.qTone({ status: 'confirmed', approvalStatus: 'approved' }), 'conf');
  assert.equal(f.statusPill({ status: 'confirmed', lifecycleStage: 'closed' }).text, 'Completed');
  assert.equal(f.statusPill({ status: 'cancelled' }).text, 'Cancelled');
  // no BPStore.quoteStatus (old cached store-api) -> the previous pill, never a crash
  const g = new Function('S', 'pill', src + '\nreturn { statusPill: statusPill, qTone: qTone };')(() => ({}), pill);
  assert.equal(g.statusPill({ status: 'confirmed' }).text, 'Confirmed'); assert.equal(g.qTone({ status: 'confirmed' }), 'conf');
  assert.match(SD, /var st = e\.q \? qTone\(e\.q\) : "quote";/);
  assert.match(SD, /function stKey\(e\) \{ var t = e\.q \? qTone\(e\.q\) : "quote"; return t === "conf" \? "conf" : "quote"; \}/);
});

await t('live dashboard (shell-b-money): Upcoming row = invoice total + one label', () => {
  const SM = read('public/shell-b-money.js');
  assert.match(SM, /\(pu && pv > 0 \? qMoneyN\(pv, q\) : qMoney\(q\)\)/, 'server value (pricing.total + approved change orders) first');
  assert.match(SM, /q\.client && q\.client\.name && plainName\(q\.client\.name\), qLabel\(q\)\]/);   // r21 business ui: sample prefix dropped from the client line
  assert.ok(!/q\.status === "confirmed" \? "Confirmed" : "Tentative"\]\.filter/.test(SM), 'old status-only label gone');
  const a = SM.indexOf('  function qLabel(q)'); const src = SM.slice(a, SM.indexOf('\n', SM.indexOf('return q.status', a)) + 1);
  const S = load(); const qLabel = new Function('S', src + '\nreturn qLabel;')(() => S);
  assert.equal(qLabel({ status: 'confirmed', approvalStatus: 'sent' }), 'Sent · awaiting client approval');
  const BIZ = read('public/business.html'); assert.match(BIZ, /shell-b-money\.js\?v=9/);
});

await t('list: the reference code never wraps', () => {
  assert.match(QCSS, /#rows td\.code,#rows \.refchip\{white-space:nowrap\}/);
  assert.match(QH, /\.refchip\{[^}]*white-space:nowrap\}/);
});

await t('0189: additive, ASCII, client page uses the same label, packaged + suite registered', () => {
  for (const s of [MIG, APPLY, VERIFY, SUITE]) assert.ok(!/[^\x00-\x7f]/.test(s), 'ASCII only');
  const code = MIG.replace(/--[^\n]*/g, '');
  assert.ok(!/\b(drop\s+(table|column|function|trigger|policy)|truncate|delete\s+from|alter\s+table|insert\s+into|update\s+public)\b/i.test(code), 'functions only, no data change');
  assert.match(MIG, /^-- 0189_quote_status_label\.sql - CANONICAL forward-only\./);
  assert.match(MIG, /create or replace function public\.helm_quote_status_label\(p_status text, p_stage text, p_approval text\)\nreturns text language sql immutable set search_path = ''/);
  assert.equal((MIG.match(/public\.helm_quote_status_label\(q\.status, q\.lifecycle_stage, q\.approval_status\)/g) || []).length, 2);
  assert.ok(!/then 'confirmed' else coalesce\(nullif\(q\.lifecycle_stage/.test(MIG), 'old status-only mapping replaced');
  assert.match(MIG, /when coalesce\(p_approval, 'none'\) = 'sent' then 'sent - awaiting client approval'/);
  assert.match(MIG, /when st = 'confirmed' then greatest\(inv - pd, 0\)/, 'Due rule (0160) kept');
  assert.match(MIG, /grant execute on function public\.client_timeline\(uuid, integer\) to authenticated/);
  // in the manifest, in number order (after 0187, before the later migrations of the release)
  assert.match(MAN, /\nforward  supabase\/migrations\/0187_trial_outbound_gaps\.sql\n#[^\n]*\nforward  supabase\/migrations\/0189_quote_status_label\.sql\n/);
  assert.ok(APPLY.includes(MIG.trim().slice(0, 4000)), 'APPLY carries the migration');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.ok(!/create temp|pg_temp/i.test(APPLY), 'paste-safe');
  assert.match(VERIFY, /02 label: locked \+ sent is not confirmed/);
  assert.match(RUNALL, /run "quote-status-0189" "QUOTE-STATUS-0189: ALL PASS \\\(19\/19\\\)" psql -q -f tests\/db\/quote-status-0189\.sql/);
  // the store-api label and the SQL label agree on the owner's case
  assert.match(STORE, /if \(ap === "sent"\) return mk\("sent", "Sent · awaiting client approval"/);
});

console.log(`quote-totals-status-1018: ${n} passed`);
