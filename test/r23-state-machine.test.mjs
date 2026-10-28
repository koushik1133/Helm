// r23 (0263): ONE canonical quote / event stage + stage history. JS rule = SQL rule (same case file as the DB suite),
// timeline wording, Settings card model, page wiring, SQL shape (additive, guarded, no quote_id column).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const API = read('public/store-api.js'), SH = read('public/stage-history.js'), SMS = read('public/stage-machine-settings.js');
const EV = read('public/event.html'), FL = read('public/flow.html'), CC = read('public/control.html');
const M = read('supabase/migrations/0263_quote_stage_machine.sql'), A = read('supabase/APPLY-0263.sql'), MAN = read('supabase/migrations/MANIFEST');
const CASES = JSON.parse(read('tests/db/r23-stage-cases.json'));
let n = 0, fail = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name, e.message); } };

// the pure part of store-api.js (quoteStageRule .. quoteStage) run on its own
const start = API.indexOf('  BPStore.quoteStageRule = function'), end = API.indexOf('  // The invoice total = the SERVER-priced');
const PURE = API.slice(start, end);
const ctx = { BPStore: {}, Date }; vm.createContext(ctx); vm.runInContext(PURE, ctx);
const B = ctx.BPStore;

t('JS stage rule = SQL rule on every shared case', () => {
  assert.ok(CASES.length >= 30);
  for (const c of CASES) assert.equal(B.quoteStageRule(...c.slice(0, 8)), c[8], JSON.stringify(c));
});
t('quoteStage reads camelCase / snake_case quotes, shelves and expiry', () => {
  assert.equal(B.quoteStage({ status: 'confirmed', approvalStatus: 'sent', lifecycleStage: 'quote' }), 'sent');
  assert.equal(B.quoteStage({ status: 'confirmed', approval_status: 'sent', lifecycle_stage: 'quote' }, { viewed: true }), 'viewed');
  assert.equal(B.quoteStage({ status: 'quote', approvalStatus: 'none', archivedAt: '2026-10-01', archivedReason: 'manual' }), 'lost');
  assert.equal(B.quoteStage({ status: 'confirmed', approvalStatus: 'sent', deletedAt: '2026-10-01', deletedReason: 'link_expired' }), 'expired');
  assert.equal(B.quoteStage({ status: 'confirmed', approvalStatus: 'sent', approvalTokenExpiresAt: '2000-01-01T00:00:00Z' }), 'expired');
  assert.equal(B.quoteStage({ status: 'confirmed', approvalStatus: 'paid', lifecycleStage: 'settlement', closedAt: '2026-10-01' }), 'closed');
  assert.equal(B.quoteStage(null), 'draft');
});
t('every stage has a label and a status-pill tone', () => {
  for (const s of ['lead', 'draft', 'sent', 'viewed', 'approved', 'advance_paid', 'confirmed', 'in_progress', 'event_day', 'completed', 'closed', 'cancelled', 'expired', 'lost']) {
    assert.notEqual(B.quoteStageLabel(s), s); assert.ok(B.quoteStageTone(s));
    assert.match(M, new RegExp("when '" + s + "' then '" + B.quoteStageLabel(s) + "'"), 'SQL label for ' + s);
  }
});

// timeline wording
const sctx = { window: { BPStore: B }, console }; sctx.globalThis = sctx; vm.createContext(sctx); vm.runInContext(SH, sctx);
const H = sctx.window.HelmStageHistory;
t('timeline: plain words for each source', () => {
  assert.equal(H.describe({ from: 'viewed', to: 'approved', to_label: 'Approved', source: 'client', at: null }).title, 'Moved to Approved by the client');
  assert.equal(H.describe({ from: 'approved', to: 'confirmed', source: 'rpc', actor_name: 'Ada Admin' }).title, 'Moved to Confirmed by Ada Admin');
  assert.equal(H.describe({ from: 'sent', to: 'expired', source: 'cron' }).title, 'Moved to Expired automatically');
  assert.equal(H.describe({ to: 'draft', source: 'system' }).title, 'Started as Draft by Helm');
  assert.match(H.describe({ to: 'sent', source: 'backfill' }).title, /when stage tracking began/);
  const x = H.describe({ from: 'closed', to: 'draft', source: 'system', legal: false, reason: 'fix' });
  assert.equal(x.flag, 'Out of the usual order'); assert.equal(x.reason, 'Reason: fix'); assert.equal(x.from, 'Closed');
});
t('timeline: dd/mm/yyyy in India time when the store formatter is absent', () => {
  const w = H.when('2026-10-20T08:35:00Z');
  assert.match(w, /^20\/10\/2026,? 14:05$/, w);
  assert.equal(H.pillSpec('advance_paid').cls, 'stat r23-pill paid');
});
t('timeline: textContent only, reads only through BPStore.stages.history', () => {
  assert.doesNotMatch(SH, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(SH, /b\.stages\.history\(id\)/); assert.match(SH, /show_history === false/);
});

// Settings model
const cctx = { window: {}, console }; cctx.globalThis = cctx; vm.createContext(cctx); vm.runInContext(SMS, cctx);
const S = cctx.window.HelmStageMachineSettings;
t('Settings card model: warn default, history on, read-only for non-admins, HQ notes', () => {
  const m = S.model({}); assert.equal(m.mode, 'warn'); assert.equal(m.history, true); assert.equal(m.canEdit, false);
  assert.equal(S.model({ guard_mode: 'enforce', can_edit: true }).mode, 'enforce');
  assert.match(S.model({ hq_guard_mode: 'off' }).stats, /paused/);
  assert.match(S.model({ warnings_30d: 2 }).stats, /^2 out-of-order moves/);
  assert.doesNotMatch(SMS, /innerHTML/);
});

// wiring
t('pages mount the card + load the files', () => {
  assert.match(EV, /id="stageHistory"[^>]*data-stage-history[^>]*data-quote-from-url/); assert.match(EV, /stage-history\.js\?v=/); assert.match(EV, /stage-history\.css\?v=/);
  assert.match(FL, /id="sec-stages"[^>]*data-stage-history/); assert.match(FL, /stage-history\.js\?v=/); assert.match(FL, /stage-history\.css\?v=/);
  assert.match(CC, /id="smCard" hidden/); assert.match(CC, /stage-machine-settings\.js\?v=/);
  assert.match(API, /rpc\("quote_stage_history", \{ p_quote: quoteId \}\)/); assert.match(API, /rpc\("set_stage_machine_settings"/);
});

// SQL shape
t('SQL: additive, guarded, no quote_id column / FK, triggers never break the write', () => {
  assert.match(M, /STOP 0263/);
  assert.doesNotMatch(M.replace(/--.*$/gm, ''), /\bdrop (table|column|function|view)\b/i);
  assert.doesNotMatch(M.replace(/--.*$/gm, ''), /\bdelete from public\.(quotes|audit_log|app_config)\b/i);
  assert.doesNotMatch(M.replace(/--.*$/gm, ''), /\bquote_id\s+uuid/);
  assert.match(M, /exception when others then\s+raise warning 'helm 0263: stage not recorded/);
  assert.match(M, /guard_mode\s+text not null default 'warn'/);
  assert.match(M, /deferrable initially deferred for each row\s+when \(\(old\.status/);
  assert.match(M, /and public\._r23_enforcing\(\)\)/);
  assert.match(MAN, /forward\s+supabase\/migrations\/0263_quote_stage_machine\.sql/);
  assert.ok(/^[\x00-\x7F]*$/.test(M), 'ASCII only');
});
t('APPLY-0263: one transaction + VERIFY rows', () => {
  assert.match(A, /^begin;/m); assert.match(A, /^commit;/m); assert.match(A, /VERIFY/);
  assert.ok(A.includes(M.trim().split('\n').slice(-3).join('\n')), 'APPLY carries the migration body');
});

console.log(`r23-state-machine: ${n} passed, ${fail} failed`);
if (fail) process.exit(1);
