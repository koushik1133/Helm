// r20 coord (b) - live-QA fixes for the Event coordinator role:
//  12 / 26  /ready "Advance received" reads the same truth as the status line ("Confirmed · advance paid"):
//           approval_status "paid" / a paid milestone / a paid ledger receipt. A role without finance never
//           reads milestones or the ledger (RLS-blocked) - it gets the quote's own status and no "Fix" link.
//           "Guests fit the venue" also matches a saved venue by NAME when the quote has no venue id.
//  17       the dashboard tour, the shell tour and the "Welcome to Helm Events" sheet skip / reword steps about
//           areas the role can't open (new quote, lead convert, payments, revenue, Nurture, Control Center);
//           admins keep the exact admin wording.
// store-api.js runs in a vm sandbox with a stubbed supabase client; tour.js in a small stubbed DOM.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x));
const tests = []; const t = (n, f) => tests.push([n, f]);

/* ---------------------------------------------------------------- store-api sandbox */
const SRC = read('public/store-api.js');
function memStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function makeClient(respond) {
  const queries = [];
  const user = { id: 'u-1', email: 'coord@a.test' }, session = { user, access_token: 'x' };
  return { queries,
    auth: { async getSession() { return { data: { session } }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; }, async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } } },
    rpc(name) {
      if (name === 'current_org_id') return Promise.resolve({ data: 'org-1', error: null });
      if (name === 'password_change_required') return Promise.resolve({ data: false, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const q = { table, calls: [] }; const b = {};
      const rec = (m) => (...a) => { q.calls.push([m, ...a]); return b; };
      ['select', 'insert', 'update', 'eq', 'neq', 'is', 'not', 'or', 'in', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'filter', 'contains', 'order', 'range', 'limit'].forEach((m) => { b[m] = rec(m); });
      const run = () => { queries.push(q); return Promise.resolve(respond(q)); };
      b.single = () => { q.calls.push(['single']); return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })); };
      b.maybeSingle = b.single; b.then = (res, rej) => run().then(res, rej);
      return b;
    } };
}
// the Event coordinator matrix: ops view+edit, leads/crm/quotes/layouts view-only, no finance / nurture / controls
const COORD = [
  ...['staff', 'inventory', 'vendors', 'calendar', 'templates', 'resources', 'runsheet', 'plan', 'logistics', 'ready', 'command', 'issues', 'media']
    .map((area) => ({ area, can_view: true, can_edit: true })),
  ...['leads', 'crm', 'quotes', 'layouts'].map((area) => ({ area, can_view: true, can_edit: false })),
  ...['finance', 'settlement', 'closure', 'nurture', 'discovery', 'proposal', 'controls', 'codes', 'users', 'item_pricing', 'design', 'quote_create']
    .map((area) => ({ area, can_view: false, can_edit: false })),
];
async function makeEnv(role, respond) {
  const client = makeClient((q) => {
    if (q.table === 'profiles') return { data: [{ role }], error: null };
    if (q.table === 'role_access') return { data: role === 'admin' ? [] : COORD, error: null };
    return respond(q);
  });
  const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=254' },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, supabase: { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: '/sita/ready', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace() {}, reload() {} },
    document: doc, navigator: { onLine: true }, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {}, setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, atob: (b) => Buffer.from(b, 'base64').toString('binary'), console: { log() {}, info() {}, warn() {}, error() {} } };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(SRC, win, { filename: 'store-api.js' });
  await win.BPStore.init(); client.queries.length = 0;
  return { S: win.BPStore, q: client.queries };
}

const QID = '00000000-0000-4000-8000-000000001001';
const lawn = { id: 'v-lawn', name: 'Demo · Green Meadows Lawn', seated_capacity: 0, floating_capacity: 2000, active: true };
// demo event SMP-1001: client approved + paid, venue typed by name only (no venue id), a paid milestone + a UPI receipt
function smp(o = {}) {
  return (q) => {
    if (q.table === 'quotes') return { data: [{ id: QID, code: 'SMP-1001', title: 'Demo wedding', status: 'confirmed', lifecycle_stage: 'confirmed',
      approval_status: o.approval || 'paid', event_date: '2026-11-28', client: { guests: 450, venue: o.venue || 'Demo · Green Meadows Lawn' }, pricing: {} }], error: null };
    if (q.table === 'venues') return { data: o.venues || [lawn], error: null };
    if (q.table === 'payment_milestones') return o.msDenied ? { data: null, error: { code: '42501', message: 'permission denied for table payment_milestones' } }
      : { data: [{ id: 'm1', quote_id: QID, status: 'paid', amount: 100000 }], error: null };
    if (q.table === 'quote_payments') return { data: [{ id: 'p1', quote_id: QID, status: 'paid', amount: 100000, method: 'upi' }], error: null };
    return { data: [], error: null };
  };
}

t('advanceIn: approval "paid", a paid milestone, a paid ledger receipt or settlement received - else not yet', async () => {
  const { S } = await makeEnv('admin', () => ({ data: [], error: null }));
  assert.equal(S.advanceIn({ approvalStatus: 'paid' }), true);
  assert.equal(S.advanceIn({ approval_status: 'paid' }), true);
  assert.equal(S.advanceIn({ approvalStatus: 'approved' }, { milestones: [{ status: 'due' }, { status: 'paid' }] }), true);
  assert.equal(S.advanceIn({ approvalStatus: 'approved' }, { payments: [{ status: 'paid', amount: 5000 }] }), true);
  assert.equal(S.advanceIn({ approvalStatus: 'approved' }, { payments: [{ status: 'paid', amount: 0 }, { status: 'failed', amount: 9 }] }), false);
  assert.equal(S.advanceIn({ approvalStatus: 'approved' }, { settlement: { received: 1 } }), true);
  assert.equal(S.advanceIn({ approvalStatus: 'approved' }), false);
  assert.equal(S.advanceIn(null, null), false, 'no input never throws');
});

t('venueForQuote: linked id first, else an unambiguous name match (case / spaces / "Demo · " or "SAMPLE - " prefix)', async () => {
  const { S } = await makeEnv('admin', () => ({ data: [], error: null }));
  const sample = { id: 'v-s', name: 'SAMPLE - Green Meadows Lawn', active: true }, hall = { id: 'v-h', name: 'Royal Banquet Hall', active: true };
  assert.equal(S.venueForQuote({ client: { venueId: 'v-h', venue: 'Demo · Green Meadows Lawn' } }, [lawn, hall]).id, 'v-h');
  assert.equal(S.venueForQuote({ client: { venue: 'Demo · Green Meadows Lawn' } }, [hall, lawn]).id, 'v-lawn');
  assert.equal(S.venueForQuote({ client: { venue: '  green   MEADOWS lawn ' } }, [hall, lawn]).id, 'v-lawn');
  assert.equal(S.venueForQuote({ client: { venue: 'Green Meadows Lawn' } }, [sample, hall]).id, 'v-s');
  assert.equal(S.venueForQuote({ client: { venue: 'Demo · Green Meadows Lawn' } }, [lawn, sample]).id, 'v-lawn', 'the exact name wins over a prefix-only match');
  assert.equal(S.venueForQuote({ client: { venue: 'Green Meadows Lawn' } }, [lawn, sample]), null, 'two equally good matches: ambiguous, not guessed');
  assert.equal(S.venueForQuote({ client: { venue: 'Somewhere else' } }, [lawn]), null);
  assert.equal(S.venueForQuote({ client: {} }, [lawn]), null);
});

t('readiness (admin / finance role): SMP-1001 advance = yes from milestones; venue by name gives the capacity check', async () => {
  const e = await makeEnv('admin', smp({ approval: 'approved' }));
  const r = await e.S.readiness.check(QID);
  const pay = r.checks.find((c) => c.key === 'payments'), cap = r.checks.find((c) => c.key === 'capacity');
  assert.equal(pay.ok, true); assert.equal(pay.detail, 'yes'); assert.equal(pay.noFix, false);
  assert.ok(e.q.some((q) => q.table === 'payment_milestones'), 'finance role reads the milestones');
  assert.equal(cap.ok, true); assert.equal(cap.critical, true); assert.ok(!cap.unchecked);
  assert.equal(cap.detail, '450 of 2,000');
});

t('readiness (admin): no paid milestone -> the payments ledger is the truth', async () => {
  const base = smp({ approval: 'approved' });
  const e = await makeEnv('admin', (q) => q.table === 'payment_milestones' ? { data: [{ id: 'm1', status: 'due', amount: 100000 }], error: null } : base(q));
  const pay = (await e.S.readiness.check(QID)).checks.find((c) => c.key === 'payments');
  assert.equal(pay.ok, true); assert.ok(e.q.some((q) => q.table === 'quote_payments'));
});

t('readiness (Event coordinator, no finance): advance from the quote status, no money reads, no Fix link, never throws', async () => {
  const e = await makeEnv('coordinator', smp({ approval: 'paid', msDenied: true }));
  const r = await e.S.readiness.check(QID);
  const pay = r.checks.find((c) => c.key === 'payments');
  assert.equal(pay.ok, true, 'status "Confirmed · advance paid" => Advance received: yes'); assert.equal(pay.detail, 'yes');
  assert.equal(pay.noFix, true, 'no Fix link to a Payments tab the role cannot open');
  assert.ok(!e.q.some((q) => q.table === 'payment_milestones' || q.table === 'quote_payments'), 'no RLS-blocked money reads');
  assert.equal(e.S.quoteStatus({ status: 'confirmed', approvalStatus: 'paid' }).label, 'Confirmed · advance paid');
  const e2 = await makeEnv('coordinator', smp({ approval: 'approved', msDenied: true }));
  const p2 = (await e2.S.readiness.check(QID)).checks.find((c) => c.key === 'payments');
  assert.equal(p2.ok, false); assert.equal(p2.detail, 'not yet');
});

t('readiness: a typed venue with no saved match reads "Not checked" (not passed, not a blocker)', async () => {
  const e = await makeEnv('admin', smp({ venue: 'Some Farmhouse, Shamshabad' }));
  const cap = (await e.S.readiness.check(QID)).checks.find((c) => c.key === 'capacity');
  assert.equal(cap.unchecked, true); assert.equal(cap.ok, false); assert.equal(cap.critical, false);
  assert.match(cap.detail, /^not checked - no saved venue linked$/);
});

t('ready.html: no Fix link for a check marked noFix', () => {
  const R = read('public/ready.html');
  assert.match(R, /else if\(href && !c\.ok && !c\.noFix\)\{ act = `<a class="link"/);
});

/* ---------------------------------------------------------------- tour engine */
const TSRC = read('public/tour.js');
function fake() {
  const kids = {}, cls = new Set();
  return { style: {}, textContent: '', offsetWidth: 320, offsetHeight: 170, innerHTML: '',
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {}, focus() {}, contains: () => false,
    querySelector(sel) { return kids[sel] || (kids[sel] = fake()); }, querySelectorAll: () => [] };
}
function loadTour(auth) {
  const noop = () => {};
  const document = { readyState: 'complete', hidden: false, head: { appendChild: noop }, body: { appendChild: noop },
    documentElement: { clientWidth: 1280, clientHeight: 800, classList: { contains: () => false } }, activeElement: null,
    createElement: fake, getElementById: () => null, addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
  const window = { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: true }) };
  window.window = window; if (auth) window.BPStore = { auth };
  const ctx = { window, document, location: { pathname: '/dashboard.html' }, localStorage: { getItem: () => null, setItem: noop },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflow: 'visible', overflowX: 'visible', overflowY: 'visible', position: 'static' }),
    requestAnimationFrame: noop, setTimeout: noop, matchMedia: () => ({ matches: true }), console };
  vm.runInNewContext(TSRC, ctx);
  return { T: window.HelmTour, document };
}
const coordAuth = { canView: async (a) => !['finance', 'nurture', 'controls', 'insights'].includes(a),
  canEditArea: async (a) => !['quotes', 'leads', 'finance', 'controls'].includes(a), can: async (c) => c !== 'create' };
const tick = () => new Promise((r) => setImmediate(r));

t('tour.js: need skips a step, alt rewords it, once BPStore.auth has answered; admin wording otherwise', async () => {
  const steps = [{ title: 'Hi', desc: 'admin hi', uses: 'finance', alt: (can) => (can('finance') ? null : { desc: 'coord hi' }) },
    { title: 'New quote', desc: 'make one', need: ['create', 'edit:quotes'] }, { title: 'Bye', desc: 'bye' }];
  const { T, document } = loadTour(coordAuth);
  let root; const ce = document.createElement; document.createElement = () => (root = ce());
  T.start(steps, 'k'); await tick(); await tick();
  assert.equal(T.can('finance'), false); assert.equal(T.can('create'), false); assert.equal(T.can('edit:quotes'), false);
  assert.equal(root.querySelector('h4').textContent, 'Hi'); assert.equal(root.querySelector('p').textContent, 'coord hi');
  assert.equal(root.querySelector('.tstep').textContent, 'Step 1 of 2', 'the New quote step is skipped');
  root.querySelector('.next').onclick(); assert.equal(root.querySelector('h4').textContent, 'Bye');
  // no BPStore (or auth off): every token reads as allowed -> admin wording, nothing skipped
  const A = loadTour(null); let r2; const ce2 = A.document.createElement; A.document.createElement = () => (r2 = ce2());
  A.T.start(steps, 'k'); await tick(); await tick();
  assert.equal(r2.querySelector('p').textContent, 'admin hi'); assert.equal(r2.querySelector('.tstep').textContent, 'Step 1 of 3');
  // a check that throws fails closed for that token
  const B = loadTour({ canView: async () => { throw new Error('x'); }, canEditArea: async () => true, can: async () => true });
  await B.T.prepare([{ uses: 'finance' }]); assert.equal(B.T.can('finance'), false);
});

t('tour.js per-page steps: New quote / New lead need edit access; Payment needs finance; view-only rewording', () => {
  const { T } = loadTour(null);
  const q = T._steps['quotes.html'], l = T._steps['leads.html'], f = T._steps['flow.html'];
  assert.deepEqual(Array.from(q.find((s) => s.sel === '#newBtn').need), ['create', 'edit:quotes']);
  assert.equal(l.find((s) => s.sel === '#newBtn').need, 'edit:leads');
  assert.equal(f.find((s) => s.sel === '#sec-pay').need, 'finance');
  const no = () => false, yes = () => true;
  assert.match(T.wording(l.find((s) => s.sel === '#board')).desc, /Drag a card/);
  assert.equal(l.find((s) => s.sel === '#board').alt(yes), null);
  assert.match(l.find((s) => s.sel === '#board').alt(no).desc, /Open a lead to see its details/);
  assert.match(q.find((s) => s.sel === '#rows').alt(no).desc, /^Click a row to open the event and see its details\.$/);
});

/* ---------------------------------------------------------------- dashboard tour + intro sheet */
const D = read('public/dashboard.html');
const a0 = D.indexOf("const RAIL='"), b0 = D.indexOf('];', D.indexOf('const TOUR=[', a0)) + 2;
const TOUR = vm.runInNewContext(D.slice(a0, b0).replace(/^\s*const /gm, 'var ') + '\nTOUR',
  { window: {}, document: { documentElement: { classList: { contains: () => false } } } });
const coordCan = (tok) => !['finance', 'nurture', 'controls', 'insights', 'create', 'edit:quotes', 'edit:leads'].includes(tok);
const shownFor = (can) => Array.from(TOUR).filter((st) => [].concat(st.need || []).every(can)).map((st) => {
  const o = typeof st.alt === 'function' ? st.alt(can) : null; return { title: (o && o.title) || st.title, desc: (o && o.desc) || st.desc };
});

t('dashboard tour: admins get exactly the admin wording; the coordinator gets no admin-only wording', () => {
  const admin = shownFor(() => true), plain = Array.from(TOUR, (st) => ({ title: st.title, desc: st.desc }));
  assert.deepEqual(J(admin), J(plain), 'admin / owner wording unchanged');
  assert.equal(admin.length, 22);
  const co = shownFor(coordCan), text = co.map((s) => s.title + ' ' + s.desc).join('\n');
  { const cs = co.find((s) => s.title === 'Create something new'); assert.ok(!cs || !/New quote/.test(cs.desc), 'no New quote wording without quote create'); }   // r20 planner: the plain "New" menu step
  for (const bad of [/payments/i, /revenue/i, /P&L/, /Nurture/, /Control Center/, /into a quote in one click/, /Business shows/]) assert.doesNotMatch(text, bad, String(bad));
  assert.match(text, /Open a lead to see its details/);
  assert.match(co[0].desc, /quotes, leads, the calendar, staff and stock\./);
  assert.equal(co.find((s) => /^Admin/.test(s.title)).title, 'Admin');
  // admin step with finance + insights but no Control Center
  const mgr = TOUR.find((s) => s.title === 'Admin & Control Center').alt((tok) => tok !== 'controls');
  assert.deepEqual(J(mgr), { title: 'Admin', desc: 'Business shows your money and Insights your numbers.' });
});

t('shell tour: Create needs quote create; Notifications drops "payments" without finance', () => {
  const SH = read('public/shell-b.js');
  assert.match(SH, /\{ sel: "\[data-tour='new'\]", need: \["create", "edit:quotes"\], title: "Create"/);
  assert.match(SH, /\{ sel: "\[data-tour='bell'\]", uses: "finance", alt: function \(can\) \{ return can\("finance"\) \? null : \{ desc: "Approvals, reminders and mentions arrive here\." \}; \}/);
});

t('"Welcome to Helm Events" sheet: every area part is gated; nothing admin-only shows un-gated', () => {
  const sheet = D.slice(D.indexOf('<div class="lmodal" id="helpModal"'), D.indexOf('</div>\n</div>', D.indexOf('id="helpModal"')));
  for (const need of ['leads', 'quotes', 'resources', 'inventory', 'plan', 'ready']) assert.match(sheet, new RegExp('<div class="hstep" data-need="' + need + '">'));
  // drop every part gated on finance / nurture / controls / lead convert: no admin-only wording may remain
  let rest = sheet;
  for (let k = 0; k < 4; k++) rest = rest.replace(/<span data-need="[^"]*(finance|nurture|controls|create)[^"]*">(?:[^<]|<b>[^<]*<\/b>)*<\/span>/g, '');
  for (const bad of [/Nurture/, /P&amp;L/, /Control Center/, /Settle payments/, /budget vs actuals/, /Convert/]) assert.doesNotMatch(rest, bad, String(bad));
  // each view-only alternative starts hidden and is shown only when the access is missing
  assert.match(sheet, /<span data-unless="edit:leads create" hidden>Every enquiry sits on the pipeline by stage; open a lead to see its details\.<\/span>/);
  assert.match(sheet, /<span data-unless="controls" hidden>/);
  assert.match(D, /async function gateHelpSheet\(\)\{/);
  assert.match(D, /el\.hidden = need!=null \? !\(await all\(need\)\) : \(await all\(unless\)\);/);
  assert.match(D, /\(async\(\)=>\{ try\{ await BPStore\.init\(\); await gateHelpSheet\(\); \}catch\(_\)\{\} \}\)\(\);/);
});

let pass = 0;
for (const [n, f] of tests) {
  try { await f(); pass++; console.log('  ✓ ' + n); }
  catch (e) { console.error('  ✗ ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; }
}
console.log('r20-coord-b: ' + pass + '/' + tests.length + ' passed');
