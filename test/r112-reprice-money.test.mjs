// R112 (staging trial): "Save & back to quote" in the builder re-priced a sent / approved quote (200 -> 150 guests,
// Rs 1,82,310 -> Rs 1,41,010) with no new version, and afterwards the money views disagreed. Proves:
//   (a) a layout save never changes a committed quote's price silently: the builder loads the QUOTE's plates (200, not
//       the client head count 150); the background sync writes nothing; the explicit save asks "Update quote (new
//       version) / Keep quote"; Keep writes nothing, Update saves a quotation version (never a bare updateMeta);
//   (b) all money views agree: the schedule card prints the server's outstanding (= closure balance), flags a schedule
//       that no longer adds up to the total and offers the re-split; the flow advance hint reads the schedule.
// SQL behaviour: tests/db/r112-reprice-money-0321.sql.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const BUILDER = read('public/builder.js'), BHTML = read('public/builder.html'), FLOW = read('public/flow.html');
const PSJS = read('public/payment-schedule.js'), API = read('public/store-api.js');
const SQL = read('supabase/migrations/0321_r112_reprice_money.sql'), MAN = read('supabase/migrations/MANIFEST');
const APPLY = read('supabase/APPLY-0321.sql'), RUNALL = read('scripts/db-test/run-all.sh');
require('../public/reprice-guard.js');
const G = globalThis.HelmRepriceGuard;
const inr = (v) => 'Rs ' + Math.round(v).toLocaleString('en-IN');

// ---- (a) the guard helpers -------------------------------------------------------------------------------------------
await t('platesFor: the quote\'s plates (pricing.guests 200) win over the client head count (150)', () => {
  assert.equal(G.platesFor({ guests: 150 }, { guests: 200 }), 200);
  assert.equal(G.platesFor({ guests: 150 }, {}), 150, 'client head count only as the fallback');
  assert.equal(G.platesFor({}, {}), null);
  assert.equal(G.platesFor({ guests: 150 }, { guests: 0 }), 0, 'a stored 0 plates is kept');
});
await t('committed: sent / viewed / approved / paid / confirmed / stale; a draft is not', () => {
  for (const a of ['sent', 'viewed', 'approved', 'paid']) assert.ok(G.committed({ approvalStatus: a }), a);
  assert.ok(G.committed({ status: 'confirmed', approvalStatus: 'none' }));
  assert.ok(G.committed({ approvalStatus: 'none', consentStale: true }));
  assert.ok(!G.committed({ approvalStatus: 'none', status: 'quote' }));
  assert.ok(!G.committed(null));
});
await t('diff + message: "Layout changes the quote: guests 200 -> 150, total X -> Y."', () => {
  const d = G.diff({ guests: 200, total: 182310 }, { guests: 150, total: 141010 });
  assert.ok(d.changed && d.guestsChanged && d.totalChanged);
  assert.equal(G.message(d, inr), 'Layout changes the quote: guests 200 → 150, total Rs 1,82,310 → Rs 1,41,010.');
  assert.ok(!G.diff({ guests: 200, total: 182310 }, { guests: 200, total: 182310.4 }).changed, 'under half a rupee = same');
});

// ---- (a) the builder: load precedence + the sync decision, run for real -------------------------------------------
await t('builder loads the quote plates through HelmRepriceGuard.platesFor (not client-first) + loads the guard', () => {
  assert.match(BUILDER, /HelmRepriceGuard\.platesFor\(q\.client, currentPricing\)/);
  assert.doesNotMatch(BUILDER, /if\(q\.client && q\.client\.guests!=null\) PRICING\.guests = \+q\.client\.guests;/);
  assert.ok(BHTML.indexOf('reprice-guard.js') > 0 && BHTML.indexOf('reprice-guard.js') < BHTML.indexOf('builder.js?v='), 'loaded before builder.js');
  assert.match(FLOW, /reprice-guard\.js\?v=/);
});

function extract(src, head) {
  const i = src.indexOf(head); assert.ok(i >= 0, 'missing ' + head);
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + head);
}
const SYNC = extract(BUILDER, 'async function syncQuotePricingNow(opts)');
function sandbox({ approval = 'approved', status = 'quote', confirm = true, stored = { guests: 200, total: 182310 }, live = { guests: 150, total: 141010 } } = {}) {
  const calls = { updateMeta: [], save: [], confirm: [], toast: [] };
  const ctx = {
    window: { HelmRepriceGuard: G }, currentQuoteId: 'q1', _syncTimer: null, clearTimeout() {},
    currentPricing: null, currentClient: { guests: 150 }, currentQuoteRow: null, currentQuoteGuard: { approved: approval === 'approved', sent: approval === 'sent' },
    _lastAutoOther: null, _repricePending: null, _repriceTold: false, inr, updateQuoteBadge() {},
    toast: (m) => calls.toast.push(m),
    quotePricingNow: () => Object.assign({}, ctx.currentPricing, { guests: live.guests }),
    BPUI: { confirm: async (m, o) => { calls.confirm.push({ m, o }); return confirm; } },
    BPStore: {
      quotes: { get: async () => ({ approvalStatus: approval, status, pricing: Object.assign({}, stored), updatedAt: 'u1' }),
                updateMeta: async (id, patch) => { calls.updateMeta.push(patch); } },
      pricing: { quoteTotal: () => ({ total: live.total }) },
      tax: { preserveSnapshot: (_old, p) => p },
      quotationVersions: { save: async (id, p) => { calls.save.push(p); return { label: 'Q4', total: p.total }; } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SYNC + '\nthis.syncQuotePricingNow = syncQuotePricingNow;', ctx);
  return { ctx, calls };
}

await t('approved quote, background sync (after a layout save / plates edit): NOTHING is written, change kept pending', async () => {
  const { ctx, calls } = sandbox();
  const r = await ctx.syncQuotePricingNow();
  assert.equal(r, false);
  assert.equal(calls.updateMeta.length + calls.save.length, 0, 'never a silent re-price');
  assert.ok(ctx._repricePending && ctx._repricePending.totalTo === 141010);
});
await t('approved quote, Save & back: asks with the numbers; "Keep quote" writes nothing', async () => {
  const { ctx, calls } = sandbox({ confirm: false });
  const r = await ctx.syncQuotePricingNow({ interactive: true });
  assert.equal(r, 'kept');
  assert.equal(calls.confirm.length, 1);
  assert.match(calls.confirm[0].m, /Layout changes the quote: guests 200 → 150, total Rs 1,82,310 → Rs 1,41,010\./);
  assert.equal(calls.confirm[0].o.okLabel, 'Update quote (new version)');
  assert.equal(calls.confirm[0].o.cancelLabel, 'Keep quote');
  assert.equal(calls.confirm[0].o.title, 'Client approval will go stale');
  assert.equal(calls.updateMeta.length + calls.save.length, 0);
});
await t('approved quote, "Update quote (new version)": a quotation version is saved (save_quotation_version), no bare updateMeta', async () => {
  const { ctx, calls } = sandbox({ confirm: true });
  const r = await ctx.syncQuotePricingNow({ interactive: true });
  assert.equal(r, true);
  assert.equal(calls.save.length, 1); assert.equal(calls.updateMeta.length, 0);
  assert.equal(calls.save[0].total, 141010);
  assert.ok(calls.toast.some((m) => /saved as Q4.*approve the new price/.test(m)));
});
await t('sent (not approved) quote asks too; an unchanged price writes through as before; a draft keeps the live sync', async () => {
  let s = sandbox({ approval: 'sent', confirm: false });
  assert.equal(await s.ctx.syncQuotePricingNow({ interactive: true }), 'kept');
  assert.equal(s.calls.confirm[0].o.title, 'Layout changes the quote');
  s = sandbox({ live: { guests: 200, total: 182310 } });
  assert.equal(await s.ctx.syncQuotePricingNow(), true);
  assert.equal(s.calls.updateMeta.length, 1, 'same price: the layout details still sync'); assert.equal(s.calls.confirm.length, 0);
  s = sandbox({ approval: 'none' });
  assert.equal(await s.ctx.syncQuotePricingNow(), true);
  assert.equal(s.calls.updateMeta.length, 1, 'a draft is priced live by the builder, as before'); assert.equal(s.calls.save.length, 0);
});
await t('saveLayout: a silent save never writes on a sent / approved quote; the explicit save asks via the interactive sync', () => {
  assert.match(BUILDER, /if\(\(currentQuoteGuard\.sent \|\| currentQuoteGuard\.approved\) && silent\) return false;/);
  assert.match(BUILDER, /await syncQuotePricingNow\(\{ interactive:true \}\)/);
  assert.doesNotMatch(BUILDER, /okLabel:'Save and re-price'/, 'the old "Save and re-price" blanket confirm is gone');
  const back = extract(BUILDER, 'async function saveAndBackToFlow()');
  assert.match(back, /saveLayout\(false, \{ noReprice:true \}\)/);
  assert.match(back, /syncQuotePricingNow\(\{ interactive:true \}\)/);
});
await t('flow: coming back from the builder never re-prices a committed quote', () => {
  const f = extract(FLOW, 'async function syncFromLayout(fromBuilder)');
  const gate = f.indexOf('HelmRepriceGuard.committed(ev)'), save = f.indexOf('await saveQuotation()');
  assert.ok(gate > 0 && save > gate, 'the committed check runs before any saveQuotation');
  assert.match(API, /consentStale: !!q\.consent_stale/);
});

// ---- (b) every money view reads one figure --------------------------------------------------------------------------
function fakeDom() {
  class Node {
    constructor(tag) { this.tagName = tag; this.childNodes = []; this.className = ''; this.attrs = {}; this.hidden = false; this.listeners = {}; this._text = ''; this.parent = null; this.classList = { add: (c) => { this.className = (this.className + ' ' + c).trim(); } }; }
    get firstChild() { return this.childNodes[0] || null; }
    get isConnected() { return true; }
    appendChild(c) { c.parent = this; this.childNodes.push(c); return c; }
    removeChild(c) { this.childNodes = this.childNodes.filter((x) => x !== c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
    set textContent(v) { this.childNodes = []; this._text = String(v); }
    get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
    all(pred, out = []) { if (pred(this)) out.push(this); this.childNodes.forEach((c) => c.all && c.all(pred, out)); return out; }
  }
  class Text { constructor(s) { this.textContent = String(s); } }
  return { Node, document: { createElement: (t) => new Node(t), createTextNode: (s) => new Text(s) } };
}
await t('schedule card: Total / Outstanding are the server figures (outstanding = closure balance) + mismatch flag + re-split', async () => {
  const { Node, document } = fakeDom();
  globalThis.document = document;
  let resynced = 0;
  const data = { total: 141010, paid: 50000, scheduled: 182310, outstanding: 91010, mismatch: true, can_resync: true, currency: 'INR',
    rows: [{ label: 'Advance (30%)', amount: 54693, paid: 50000, remaining: 4693, state: 'part_paid' },
           { label: 'Second payment (50%)', amount: 91155, paid: 0, remaining: 91155, state: 'due' },
           { label: 'Final balance (20%)', amount: 36462, paid: 0, remaining: 36462, state: 'due' }],
    reminders: { enabled: false } };
  globalThis.BPStore = { paySchedule: { forQuote: async () => data, resync: async () => { resynced++; return { changed: true }; } } };
  globalThis.BPUI = { toast() {} };
  delete require.cache[require.resolve('../public/payment-schedule.js')];
  require('../public/payment-schedule.js');
  const box = new Node('div');
  const h = globalThis.HelmPaySchedule.mount(box, 'q1', {});
  await new Promise((r) => setTimeout(r, 10));
  const tot = box.all((x) => x.className === 'psch-tot')[0];
  assert.ok(tot, 'totals row');
  assert.match(tot.textContent, /Total: ₹1,41,010/); assert.match(tot.textContent, /Outstanding: ₹91,010/);
  assert.doesNotMatch(tot.textContent, /1,32,310/, 'the old greatest(total, scheduled) outstanding is gone');
  const note = box.all((x) => x.className === 'psch-mismatch')[0];
  assert.ok(note && /quote total is now ₹1,41,010, but these payments add up to ₹1,82,310/.test(note.textContent));
  const btn = box.all((x) => x.className === 'btn psch-resync')[0];
  assert.ok(btn); await btn.listeners.click[0](); assert.equal(resynced, 1);
  assert.equal(h.data.outstanding, 91010);
  delete globalThis.document; delete globalThis.BPStore; delete globalThis.BPUI;
});
await t('flow advance hint reads the schedule\'s first payment + outstanding once a schedule exists', () => {
  const f = extract(FLOW, 'function updateAdvance()');
  assert.match(f, /PSCH&&PSCH\.data/); assert.match(f, /Outstanding \$\{inr\(sd\.outstanding\)\}/);
  assert.match(FLOW, /onLoad:\(\)=>\{ try\{ updateAdvance\(\); \}catch\(_\)\{ \} \}/);
  assert.match(API, /resync: \(quoteId\) => \(supa \? rpc\("payment_schedule_resync"/);
  assert.match(PSJS, /textContent|createTextNode/); assert.doesNotMatch(PSJS, /innerHTML/);
});

// ---- the migration ----------------------------------------------------------------------------------------------------
await t('0321: canonical, in MANIFEST + APPLY + run-all; outstanding = closure balance; version trigger; resync audited', () => {
  assert.match(SQL, /^-- 0321_r112_reprice_money\.sql - CANONICAL forward-only\./);
  assert.match(MAN, /\nforward  supabase\/migrations\/0321_r112_reprice_money\.sql\n/);
  assert.ok(APPLY.includes(SQL.trim().split('\n').slice(-3).join('\n')), 'APPLY carries the migration body');
  assert.match(RUNALL, /R112-REPRICE-MONEY-0321: ALL PASS \\\(25\/25\\\)/);
  assert.match(SQL, /'outstanding', round\(v_owed, 2\)/);
  assert.match(SQL, /public\._a49_close_blockers\(q\.id\) ->> 'balance_owed'/);
  assert.match(SQL, /after update of pricing on public\.quotes/);
  assert.match(SQL, /'payment_schedule\.resynced'/);
  assert.doesNotMatch(SQL, /\bdrop table\b|\bdelete from\b|\btruncate\b/i);
  assert.ok(/^[\x00-\x7f]*$/.test(SQL), 'ASCII only');
});

console.log(`r112-reprice-money: ${n} passed`);
