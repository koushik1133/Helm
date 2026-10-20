// r24-plain-words.test.mjs - R24 "plain words & cleaner pages" (UI copy + layout only, no SQL)
//  1 Logistics tabs have plain names + one-line explainers; Guest count feeds Event-day "Guests arriving"
//  2 Event-day: "Before doors open (checklist)"; team, vendors and guest groups are listed automatically on open
//  3 Issues: "Charge the client for this (extra)" + explainer (hidden with the link without finance)
//  4 Budget / Settlement / Closure purpose lines; one profit picture per page (planned / cash position / final)
//  5 Nurture: plain status legend, "Done for this year", "Added from a past client"
//  6 Event documents header + helper text
//  7 Business vs Insights purpose lines; per-event profit list only on Insights when the role can open it
//  8 Dashboard: "My events & tasks" vs "Quotes pipeline"
//  9 Staff: "Day rate (per event day)" + explainer
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0, fail = 0;
const T = []; const t = (name, fn) => T.push([name, fn]);

const LOG = read('public/logistics.html'), CMD = read('public/command.html'), ISS = read('public/issues.html');
const BUD = read('public/budget.html'), SET = read('public/settlement.html'), CLO = read('public/closure.html');
const ML = read('public/money-ledger-ui.js'), NUR = read('public/nurture.html'), EV = read('public/event.html');
const BIZ = read('public/shell-b-money.js'), VB = read('public/vendor-bills-ui.js'), INS = read('public/insights.html');
const DASH = read('public/dashboard.html'), SBD = read('public/shell-b-dash.js'), STAFF = read('public/staff.html');
const POL = ['budget', 'settlement', 'closure'].map((x) => read('public/' + x + '-polish.css')), EVP = read('public/event-polish.css');

t('1 logistics: plain tab names (ids/data-t unchanged) + explainer per tab', () => {
  for (const [k, label] of [['compliance', 'Permits &amp; licences'], ['comms', 'Who tells whom (checklist)'], ['logistics', 'Transport &amp; deliveries'], ['payments', 'Client payments'], ['guests', 'Guest count']])
    assert.match(LOG, new RegExp('data-t="' + k + '"[^>]*>[^<]*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</button>'));
  assert.match(LOG, /const TAB_NAME=\{ compliance:"Permits & licences", comms:"Who tells whom \(checklist\)", logistics:"Transport & deliveries", payments:"Client payments", guests:"Guest count" \};/);
  assert.match(LOG, /<h2>\$\{esc\(TAB_NAME\[tab\]\|\|tab\)\}<\/h2><p class="sub">\$\{CHK_HELP\[tab\]\}<\/p>/);
  for (const k of ['logistics', 'compliance', 'comms']) assert.match(LOG, new RegExp(k + ':"[^"]{20,}"'));
  assert.match(LOG, /<h2>Guest count<\/h2><p class="sub">[^<]*Guests arriving/);
  assert.match(LOG, /<h2>Client payments<\/h2><p class="sub">/);
  assert.doesNotMatch(LOG, />📣 Comms<|>👥 Guests<|>📋 Permits</);
});

t('2 event-day: Before doors open + Guests arriving; auto-list team, vendors & guest groups; refresh kept', () => {
  assert.match(CMD, /<h2>🔧 Before doors open \(checklist\) <span class="prog" id="chkProg"><\/span><\/h2>\s*<p class="sub">[^<]{30,}<\/p>/);
  assert.match(CMD, /<h2>👥 Guests arriving \(from Guest count\)/);
  assert.match(CMD, /id="pullBtn"[^>]*>↻ Refresh team &amp; vendors<\/button>/);
  assert.match(CMD, /id="gstPull"[^>]*>↻ Refresh from Guest count<\/button>/);
  // on open, only for a role that can edit (both pulls skip anyone already listed - no duplicates)
  const boot = CMD.slice(CMD.indexOf('BPUI.boot('));
  assert.match(boot, /if\(canEdit\)\{ await Promise\.all\(\[BPStore\.dayops\.pullRoster\(id\)\.catch\(\(\)=>0\), BPStore\.guests\.pullFromLogistics\(id\)\.catch\(\(\)=>0\)\]\); \}\s*await section\(renderArrivals/);
  const STORE = read('public/store-api.js');
  assert.match(STORE, /async pullRoster\(quoteId\) \{\s*const existing = await this\.list\(quoteId, "arrival"\);\s*const have = new Set/);
  assert.match(STORE, /async pullFromLogistics\(quoteId\) \{\s*const existing = await this\.list\(quoteId\);\s*const have = new Set/);
  assert.doesNotMatch(CMD, /Setup &amp; technical checks|Guest reception|Pull team &amp; vendors/);
});

t('3 issues: "Charge the client for this (extra)" + explainer, both hidden without finance', () => {
  assert.match(ISS, /id="changeLink" href="#" aria-describedby="changeHint">＋ Charge the client for this \(extra\) →<\/a><small class="qhint" id="changeHint">Adds a change request in Budget/);
  assert.match(ISS, /if\(cl && !fin\) cl\.hidden=true; if\(!fin\)\{ const ch=\$\("#changeHint"\); if\(ch\) ch\.hidden=true; \}/);
  assert.doesNotMatch(ISS, /Raise a billable change/);
});

t('4 budget / settlement / closure: purpose line + one profit picture each', () => {
  assert.match(BUD, /<p class="page-purpose" id="pagePurpose"><b>Plan:<\/b> what this event should cost and earn\.<\/p>/);
  assert.match(SET, /<p class="page-purpose" id="pagePurpose"><b>Money in and out:<\/b> collect from the client, pay vendors &amp; staff\.<\/p>/);
  assert.match(CLO, /<p class="page-purpose" id="pagePurpose"><b>Final result<\/b> and close the event\.<\/p>/);
  POL.forEach((c) => assert.match(c, /\.page-purpose\{/));
  // Budget: "Planned profit" tile; the margin card drops its own 3 profit tiles
  assert.match(BUD, />Planned profit<\/div><div class="n" id="t_mar">/);
  assert.match(BUD, /data-ml-mount="margin" data-ml-replaces="netProfit" data-ml-tiles="off"/);
  assert.match(CLO, /data-ml-mount="margin" data-ml-replaces="plCard netProfit" data-ml-tiles="off"/);
  assert.match(ML, /if \(box\.getAttribute\("data-ml-tiles"\) !== "off"\) box\.appendChild\(tiles\);/);
  assert.match(BUD, /data-vb-mount="pnl" data-vb-title="📊 How the planned profit adds up" id="netProfit"/);
  assert.match(VB, /box\.getAttribute\("data-vb-title"\) \|\| "📊 Net profit"/);
  assert.match(SET, /<th scope="col">Vendor<\/th>/); assert.doesNotMatch(SET, /Partner|partners/);
  // Settlement: cash position instead of a profit tile
  assert.doesNotMatch(SET, /Net profit|id="t_mar"|pnlTile/);
  assert.match(SET, />Still to pay out<\/div><div class="n" id="t_out" data-money>/);
  assert.match(SET, /const claimsDue=\(s\.expenses\|\|\[\]\)\.filter\(e=>e\.status==="approved"\)/);
  assert.match(SET, /\["#t_rev","#t_recv","#t_bal","#t_out"\]/);
});

t('4b money ledger: tiles still drawn where the attribute is absent', async () => {
  // tiny DOM stub: mountMargin with and without data-ml-tiles="off"
  const mk = () => { const n = { children: [], attrs: {}, classList: { add() {}, toggle() {}, remove() {} }, hidden: false, style: {},
    appendChild(c) { this.children.push(c); return c; }, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    get firstChild() { return this.children[0] || null; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }, replaceChildren() { this.children = []; },
    addEventListener() {}, set textContent(v) { this._t = v; }, get textContent() { return this._t || ''; }, set className(v) { this._c = v; }, get className() { return this._c || ''; } }; return n; };
  const find = (n, cls) => (n._c || '').split(' ').includes(cls) ? n : n.children.map((c) => find(c, cls)).find(Boolean);
  const m = { rules: 'r21', revenue: 100, net_revenue: 100, cost_expected: 60, gross_margin: 40, margin_estimated: 30, margin_expected: 40, margin_actual: 20, accuracy_pct: 50, categories: [], lines: [], warnings: [] };
  const win = { location: { search: '?quote=q1' }, BPStore: { moneyLedger: { breakdown: async () => m, varianceFlag: () => null }, auth: { canView: async () => true, canEditArea: async () => false }, quotes: { get: async () => ({}) }, studioMoney: (x) => '₹' + x, quoteMoney: (x) => '₹' + x } };
  const doc = { readyState: 'loading', addEventListener() {}, createElement: () => mk(), createTextNode: (x) => ({ _t: x, children: [] }), getElementById: () => null, querySelectorAll: () => [] };
  new Function('window', 'document', 'self', 'location', 'MutationObserver', ML)(win, doc, win, win.location, class { observe() {} disconnect() {} });
  for (const [attr, want] of [[null, true], ['off', false]]) {
    const box = mk(); if (attr) box.setAttribute('data-ml-tiles', attr);
    await win.HelmMoneyLedger.mountMargin(box);
    assert.equal(!!find(box, 'ml-tiles'), want, 'data-ml-tiles=' + attr);
  }
});

t('5 nurture: plain status legend + "Done for this year" + "Added from a past client"', () => {
  assert.match(NUR, /const NST_HELP=\{active:"Active = we keep in touch[^"]*",won:"Won = became a lead again",dormant:"Dormant = paused[^"]*"\};/);
  assert.match(NUR, /<p class="sub nst-legend" id="nstLegend"><span class="st active">Active<\/span> we keep in touch · <span class="st won">Won<\/span> became a lead again · <span class="st dormant">Dormant<\/span> paused\./);
  assert.match(NUR, /aria-label="Mark \$\{esc\(n\.name\)\} done for this year">Done for this year<\/button>/);
  assert.match(NUR, />Added from a past client<\/span>/);
  assert.match(NUR, /next follow-up on "\+BPStore\.fmtDateIN\(next\)/);
  assert.doesNotMatch(NUR, />Followed up<|>From lead</);
});

t('6 event documents header + helper text', () => {
  assert.match(EV, /<h3 class="s-62c1a69">📎 Event documents \(contracts, permits, layouts\)<\/h3>/);
  assert.match(EV, /<p class="muted files-help" id="filesHelp">[^<]*contract[^<]*permits[^<]*<\/p>/);
  assert.match(EVP, /#filesHead\{flex-wrap:wrap\}/);
});

t('7 business vs insights: purpose lines; per-event profit list only on Insights when allowed', () => {
  assert.match(BIZ, /sum\.appendChild\(el\("b", null, "Money today:"\)\);\s*sum\.appendChild\(document\.createTextNode\(" what's owed, collected and coming\./);
  assert.match(INS, /<b>How we’re doing over time:<\/b> trends per event &amp; team/);
  assert.match(VB, /IA\.canView\("insights"\)[\s\S]{0,120}if \(v !== true\) return; cT\.hidden = true;/);
  assert.match(VB, /a = el\("a", null, "Profit for each event → Insights"\); a\.href = "insights\.html";/);
  assert.match(read('public/business.css'), /\.bz-grid-one \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(INS, /<h3>Profit per event<\/h3>/);
});

t('8 dashboard: My events & tasks vs Quotes pipeline', () => {
  assert.match(DASH, /aria-label="My events and tasks">/);
  assert.match(DASH, />My events &amp; tasks <span id="unreadBadge"/);
  assert.match(DASH, />Quotes pipeline<\/h3>/);
  assert.match(SBD, /mywork: "My events & tasks", mytasks: "My tasks", quotes: "Quotes pipeline"/);
  assert.match(SBD, /if \(qh\) qh\.textContent = "Quotes pipeline";/);
  assert.doesNotMatch(DASH, /Upcoming &amp; my tasks <|<h3>Your quotes<\/h3>/);
});

t('9 staff: Day rate (per event day) + explainer kept as the field hint', () => {
  assert.match(STAFF, /<label for="s_rate" title="[^"]+">Day rate \(per event day\)<\/label>/);
  assert.match(STAFF, /id="s_rate_msg" aria-live="polite">Pay for one full event day[^<]*<\/span>/);
  assert.match(STAFF, /"Day rate per event day in "/);
});

for (const [name, fn] of T) { try { await fn(); n++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } }
console.log(`\nr24-plain-words: ${n} passed, ${fail} failed`);
if (fail) process.exit(1);
