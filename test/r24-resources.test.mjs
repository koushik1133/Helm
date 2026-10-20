// r24 (owner): the event resources flow in plain words and in the order the work is done -
// 1 Inventory (reserve our stock) -> 2 Tasks & staff (assign our people) -> 3 Resource plan (what's still missing ->
// vendors) -> 4 Budget & margin. A faster resource plan (one parallel round of this event's rows, discovery pull in
// ONE insert), needs whose type can be set on the row (Staff / Our stock / Other) with real in-house cover (people
// assigned, stock reserved), and "Assign vendor" that can send the 0256 accept / decline request from the same place.
// store-api.js runs in a vm sandbox with a stubbed supabase client; the pages are checked as text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x));
const tests = []; const t = (n, f) => tests.push([n, f]);
const RES = read('public/resources.html'), EV = read('public/event.html'), OPS = read('public/ops.html'),
  INV = read('public/inventory.html'), BUD = read('public/budget.html'), SRC = read('public/store-api.js');

/* ---------------------------------------------------------------- store-api sandbox */
function memStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function makeClient(respond) {
  const queries = [];
  const user = { id: 'u-1', email: 'staff@a.test' }, session = { user, access_token: 'x' };
  const client = { queries,
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
      ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'is', 'not', 'or', 'in', 'lt', 'lte', 'gt', 'gte', 'filter', 'order', 'range', 'limit'].forEach((m) => { b[m] = rec(m); });
      const run = () => { queries.push(q); return Promise.resolve(respond(q)); };
      b.single = () => { q.calls.push(['single']); return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })); };
      b.maybeSingle = b.single; b.then = (res, rej) => run().then(res, rej);
      return b;
    } };
  return client;
}
async function makeEnv(respond) {
  const client = makeClient((q) => {
    if (q.table === 'profiles') return { data: [{ role: 'admin' }], error: null };
    if (q.table === 'role_access') return { data: [], error: null };
    return (respond || (() => ({ data: [], error: null })))(q);
  });
  const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=272' },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, supabase: { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: '/resources', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace() {}, reload() {} },
    document: doc, navigator: { onLine: true }, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {}, setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, atob: (b) => Buffer.from(b, 'base64').toString('binary'), console: { log() {}, info() {}, warn() {}, error() {} } };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(SRC, win, { filename: 'store-api.js' });
  await win.BPStore.init(); client.queries.length = 0;
  return { S: win.BPStore, q: client.queries };
}
const calls = (q, m) => q.calls.filter((c) => c[0] === m);

/* ---------------------------------------------------------------- coverage: what is ACTUALLY set aside */
t('coverage: staff = people assigned (task section or title), stock = reserved for this event, other = vendor / client only', async () => {
  const { S } = await makeEnv();
  const needs = [
    { id: 'n1', kind: 'staff', label: 'Security', skill: 'security', qty: 3, status: 'open' },
    { id: 'n2', kind: 'inventory', label: 'Stage & lighting', item_id: 'i1', qty: 10, status: 'open' },
    { id: 'n3', kind: 'other', label: 'Photography', qty: 1, status: 'open' },
    { id: 'n4', kind: 'other', label: 'Fireworks', qty: 1, status: 'outsourced' },
    { id: 'n5', kind: 'other', label: 'DJ', qty: 1, status: 'outsourced' },
    { id: 'n6', kind: 'inventory', label: 'Chairs', item_id: null, qty: 100, status: 'open' },
  ];
  const r = J(S.resources.coverage(needs, {
    tasks: [{ crew_id: 'c1', assignee_name: 'Ravi', category: 'Security', title: 'Security', status: 'assigned' },
      { crew_id: 'c2', assignee_name: 'Asha', category: 'Setup', title: 'security', status: 'accepted' },
      { crew_id: 'c3', assignee_name: 'Old', category: 'Security', title: 'Security', status: 'rejected' },
      { crew_id: 'c1', assignee_name: 'Ravi', category: 'Security', title: 'Gate 2', status: 'assigned' }],
    reservations: [{ item_id: 'i1', qty: 6, status: 'reserved' }, { item_id: 'i1', qty: 2, status: 'allocated' }, { item_id: 'i1', qty: 5, status: 'returned' }],
    bookings: [{ id: 'b1', need_id: 'n5', status: 'cancelled' }],
    items: [{ id: 'i1', name: 'Par lights', unit: 'pcs' }],
  }));
  const by = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.equal(by.n1.have, 2); assert.deepEqual(by.n1.people.sort(), ['Asha', 'Ravi']); assert.equal(by.n1.gap, 1); assert.equal(by.n1.covered, false);
  assert.equal(by.n2.have, 8, 'reserved + allocated count, returned does not'); assert.equal(by.n2.gap, 2); assert.equal(by.n2.unit, 'pcs'); assert.equal(by.n2.detail, 'Par lights');
  assert.equal(by.n3.have, 0); assert.equal(by.n3.gap, 1); assert.equal(by.n3.covered, false);
  assert.equal(by.n4.covered, true); assert.equal(by.n4.outsourced, true); assert.equal(by.n4.gap, 0, 'client / venue arranges it');
  assert.equal(by.n5.outsourced, false, 'its only vendor was cancelled -> missing again'); assert.equal(by.n5.gap, 1);
  assert.equal(by.n6.have, 0, 'no item picked yet'); assert.equal(by.n6.gap, 100);
});
t('check(): ONE parallel round of this event only - no studio-wide stock math (all reservations / checkouts / staff list)', async () => {
  const { S, q } = await makeEnv((qq) => {
    if (qq.table === 'event_resource_needs') return { data: [{ id: 'n1', kind: 'inventory', label: 'Chairs', item_id: 'i1', qty: 50, status: 'open' }], error: null };
    if (qq.table === 'inventory_reservations') return { data: [{ item_id: 'i1', quote_id: 'Q1', qty: 50, status: 'reserved' }], error: null };
    return { data: [], error: null };
  });
  const r = J(await S.resources.check('Q1'));
  assert.equal(r[0].covered, true); assert.equal(r[0].have, 50);
  const tables = q.map((x) => x.table);
  assert.ok(!tables.includes('inventory_checkouts'), 'no checkouts read'); assert.ok(!tables.includes('crew_members'), 'no staff list read');
  const res = q.filter((x) => x.table === 'inventory_reservations');
  assert.ok(res.length >= 1 && res.every((x) => calls(x, 'eq').some((c) => c[1] === 'quote_id' && c[2] === 'Q1')), 'only this event\'s reservations');
  const tk = q.find((x) => x.table === 'event_tasks'); assert.ok(tk && calls(tk, 'eq').some((c) => c[1] === 'quote_id' && c[2] === 'Q1'));
});
t('free stock for the resource plan reads only the items its needs use', async () => {
  const { S, q } = await makeEnv((qq) => {
    if (qq.table === 'inventory_items') return { data: [{ id: 'i1', name: 'Chairs', total_qty: 100, active: true }, { id: 'i2', name: 'Tables', total_qty: 10, active: true }], error: null };
    if (qq.table === 'inventory_reservations') return { data: [{ item_id: 'i1', quote_id: 'Q2', qty: 30, status: 'reserved' }], error: null };
    if (qq.table === 'quotes') return { data: [{ id: 'Q1', event_date: '2026-12-01', status: 'confirmed' }, { id: 'Q2', event_date: '2026-12-01', status: 'confirmed' }], error: null };
    return { data: [], error: null };
  });
  const av = J(await S.inventory.availability('Q1', ['i1']));
  assert.deepEqual(Object.keys(av), ['i1']); assert.equal(av.i1.availableOnEvent, 70);
  const r = q.find((x) => x.table === 'inventory_reservations'); assert.ok(calls(r, 'in').some((c) => c[1] === 'item_id' && J(c[2]).join() === 'i1'));
  const co = q.find((x) => x.table === 'inventory_checkouts'); assert.ok(co && calls(co, 'in').some((c) => c[1] === 'item_id'));
  assert.deepEqual(J(await S.inventory.reservations(null, [])), [], 'no items -> no read');
});
t('pull from discovery: every new need in ONE insert (addNeeds)', async () => {
  const { S, q } = await makeEnv((qq) => (qq.table === 'event_resource_needs' ? { data: J(calls(qq, 'insert')[0][1]).map((r, i) => ({ id: 'n' + i, ...r })), error: null } : { data: [], error: null }));
  const made = J(await S.resources.addNeeds('Q1', [{ kind: 'staff', label: 'Security', skill: 'Security', qty: 4 }, { kind: 'other', label: 'Photography', qty: 1 }, { kind: 'other', label: '  ', qty: 1 }]));
  assert.equal(made.length, 2);
  const ins = q.filter((x) => x.table === 'event_resource_needs' && calls(x, 'insert').length);
  assert.equal(ins.length, 1, 'one round trip'); assert.equal(J(calls(ins[0], 'insert')[0][1]).length, 2);
  assert.ok(J(calls(ins[0], 'insert')[0][1]).every((r) => r.quote_id === 'Q1'));
  assert.deepEqual(J(await S.resources.addNeeds('Q1', [])), []);
  assert.match(RES, /if\(rows\.length\) await BPStore\.resources\.addNeeds\(id,rows\);/);
  assert.doesNotMatch(RES, /for\(const r of reqs\)[^}]*await BPStore\.resources\.addNeed\(/, 'no one-by-one inserts');
});
t('discovery requirements map to the obvious type (staff / our stock when we own a matching item / other)', async () => {
  const { S } = await makeEnv();
  const items = [{ id: 'i1', name: 'LED wall panel', active: true }, { id: 'i2', name: 'JBL speaker', category: 'Sound', active: true }, { id: 'i3', name: 'Par light', active: true }];
  const m = (s) => J(S.resources.mapRequirement(s, items));
  assert.equal(m('Catering').kind, 'staff'); assert.equal(m('Security').kind, 'staff'); assert.equal(m('Valet parking').kind, 'staff');
  assert.equal(m('Security').skill, 'Security');
  assert.deepEqual(m('LED wall / screens'), { kind: 'inventory', item_id: 'i1' });
  assert.deepEqual(m('Sound / PA'), { kind: 'inventory', item_id: 'i2' });
  assert.deepEqual(m('Stage & lighting'), { kind: 'inventory', item_id: 'i3' });
  assert.equal(m('Seating & tables').kind, 'other', 'no matching stock -> a vendor brings it');
  for (const s of ['Photography', 'Videography', 'Entertainment / DJ', 'Transport', 'Fireworks', 'Makeup & styling']) assert.equal(m(s).kind, 'other', s);
});

/* ---------------------------------------------------------------- resource plan page */
t('resource plan: clear columns Need · Qty · We have · Missing · Action; plain words; no old jargon', () => {
  assert.match(RES, /<th scope="col">Need<\/th><th scope="col" class="num">Qty<\/th><th scope="col" class="num">We have<\/th><th scope="col">Missing<\/th><th scope="col">Action<\/th>/);
  assert.match(RES, /<h2 id="bkTitle">Vendors for this event<\/h2>/);
  assert.match(RES, /＋ Assign vendor/); assert.match(RES, />Assign vendor<\/button>/); assert.match(RES, />Client\/venue arranges it<\/button>/);
  assert.match(RES, /const OUTSIDE_TIP="Covered outside us - the client or the venue arranges it, so there is nothing to book\.";/);
  assert.match(RES, /title="\$\{esc\(OUTSIDE_TIP\)\}">Client\/venue arranges it/);
  assert.match(RES, /`<span class="cov gap">Missing \$\{num\(c\.gap\)\}/);
  for (const old of ['Book partner', 'Book a partner', 'Mark outsourced', 'External bookings', 'Gap: short', 'Gaps to outsource', 'Manage partners', '>Partner<'])
    assert.ok(!RES.includes(old), 'old wording gone: ' + old);
  assert.match(RES, /const KIND=\{staff:"Staff",inventory:"Our stock",other:"Other"\};/);
  assert.match(RES, /<option value="staff">Staff<\/option><option value="inventory">Our stock<\/option><option value="other">Other<\/option>/);
});
t('resource plan: the type is set on each row; stock rows pick the item; staff rows assign people; stock rows reserve what is free', () => {
  assert.match(RES, /<select class="rp-type" data-type="\$\{esc\(c\.id\)\}"/);
  assert.match(RES, /async function setType\(sel,c,kind\)\{[\s\S]{0,200}BPStore\.resources\.mapRequirement\(c\.label,items\)/);
  assert.match(RES, /<select class="rp-item" data-item=/);
  assert.match(RES, /data-person="\$\{esc\(c\.id\)\}"[^>]*>Assign person<\/button>/);
  assert.match(RES, /await BPStore\.ops\.assignTasks\(id,title,\[title\],p\.id,p\.name,p\.phone\)/);
  assert.match(RES, /BPStore\.staff\.suggest\(\{category:c\.skill\|\|c\.label, date:ev&&ev\.eventDate, excludeQuote:id, limit:200\}\)/);
  assert.match(RES, /data-reserve="\$\{esc\(c\.id\)\}" data-n="\$\{n\}"[^>]*>Reserve \$\{num\(n\)\}<\/button>/);
  assert.match(RES, /await BPStore\.inventory\.reserve\(c\.item_id,id,n,/);
  // each in-house action only for the role that may do it
  assert.match(RES, /canInv=canEdit && !!ci; canStaff=canEdit && !!cs; canVend=canEdit && !!cv;/);
  assert.match(RES, /if\(c\.kind==="staff" && canStaff\)/); assert.match(RES, /if\(c\.kind==="inventory" && c\.item_id && canInv\)/);
});
t('resource plan: Assign vendor can send the 0256 request (one place: the request makes the booking, then it is linked to the need)', () => {
  assert.match(RES, /<b>Send request to vendor<\/b>/); assert.match(RES, /<b>Already agreed<\/b>/);
  assert.match(RES, /const canRequest=\(\)=> !!\(canVend && BPStore\.vendorRequests && BPStore\.mode\(\)==="supabase"\);/);
  assert.match(RES, /BPStore\.vendorRequests\.save\(\{ quote_id:id, vendor_id, booking_id: sendBk\?sendBk\.id:undefined, what:what\.slice\(0,200\), qty, when_at:iso,/);
  assert.match(RES, /await BPStore\.bookings\.update\(row\.booking_id,\{need_id:bookNeed\.id\}\); await BPStore\.resources\.updateNeed\(bookNeed\.id,\{status:"outsourced"\}\);/);
  assert.match(RES, /data-bksend="\$\{esc\(b\.id\)\}"[^>]*>Send request<\/button>/);
  assert.match(RES, /BPStore\.vendorRequests\.statusLabel\(rq\.status\)/);
  assert.match(RES, /const url=BPStore\.vendorRequests\.linkUrl\(row\.link\.token\);/);
  assert.match(RES, /HelmDelivery\.zonedToIso\(d,t,tz\)/); assert.match(RES, /<script src="delivery-tracker\.js\?v=\d+"><\/script>/);
});
t('resource plan speed: data starts with the role checks, one parallel round, page shown before the table fills', () => {
  const boot = RES.slice(RES.indexOf('BPUI.boot(async ()=>{'));
  assert.ok(boot.indexOf('const pre=fetchAll();') > 0 && boot.indexOf('const pre=fetchAll();') < boot.indexOf('BPStore.quotes.get(id)'), 'fetch starts before the event read');
  assert.match(boot, /await Promise\.all\(\[\s*BPStore\.quotes\.get\(id\)/);
  assert.match(boot, /\$\("#app"\)\.hidden=false;[\s\S]{0,420}await gatePull\(\);\s*load\(pre\);/);
  assert.doesNotMatch(boot, /await load\(/, 'boot does not wait for the table');
  const fa = RES.slice(RES.indexOf('function fetchAll(){'), RES.indexOf('let loadSeq=0;'));
  assert.match(fa, /return Promise\.all\(\[/);
  for (const s of ['resources.listNeeds(id)', 'inventory.reservations(id)', 'resources._eventCrewTasks(id)', 'bookings.list(id)', 'vendorRequests.list(id,null)']) assert.ok(fa.includes(s), s);
  assert.ok(!fa.includes('availability('), 'free stock is not in the first round');
  assert.match(RES, /const av=await BPStore\.inventory\.availability\(id,ids\);/);
  assert.match(RES, /<tr class="rp-skel" aria-hidden="true">/);
});

/* ---------------------------------------------------------------- event workspace + wording across pages */
t('event workspace: Resources stage = 1 Inventory, 2 Tasks & staff, 3 Resource plan, 4 Budget & margin (numbered, in that order)', () => {
  assert.match(EV, /\{k:"resources",label:"Resources",hint:"1 Reserve our stock → 2 assign our people → 3 get what's missing from vendors → 4 check budget & margin\.",mods:\["inventory","tasks","resourceplan","budget"\],steps:true\}/);
  assert.match(EV, /const focused=visible\.filter\(c=>recommended\.includes\(c\.key\)\)\.sort\(\(a,b\)=>recommended\.indexOf\(a\.key\)-recommended\.indexOf\(b\.key\)\);/);
  assert.match(EV, /<span class="mod-step" aria-label="Step \$\{i\+1\}">\$\{i\+1\}<\/span>/);
  assert.match(EV, /resources:\[\["1 Reserve our stock","inventory\.html\?quote="\+q\],\["2 Assign our people","ops\.html\?quote="\+q\],\["3 What's missing","resources\.html\?quote="\+q\]\]/);
  assert.match(EV, /\{t:"Plan",keys:\["discovery","plandetails","proposal","layout","quote","inventory","tasks","staff","resourceplan","vendors","runsheet","readycheck","logistics"\]\}/);
  assert.match(EV, /key:"tasks", ic:"🛠️", title:"Tasks & staff"/); assert.match(EV, /key:"vendors", ic:"🤝", title:"Vendors",/);
  assert.match(EV, /<b class="t-bad">\$\{resSummary\.gaps\} missing<\/b>/);
  for (const old of ['Vendors & partners', 'book partners for the gaps', 'Map needs and flag what to outsource', 'Open operations', 'Map needs, cover in-house, flag the gaps']) assert.ok(!EV.includes(old), old);
  assert.match(read('public/event-ui.css'), /#app \.mod \.h \.mod-step\{/);
});
t('Tasks & staff / Inventory / Budget say where they sit in the flow, in the same words', () => {
  assert.match(OPS, /<h1>Tasks &amp; staff<\/h1>/); assert.match(OPS, /Step 2 of 4 — assign our people\. Done\? <a class="s-a805525" href="resources\.html\?quote=\$\{encodeURIComponent\(quote\.id\|\|quoteId\)\}">3 See what's still missing →<\/a>/);
  assert.match(OPS, /<option value="in_house">🏠 Our staff<\/option>/); assert.match(OPS, /<option value="outsourced">🤝 A vendor<\/option>/);
  assert.match(INV, /Step 1 of 4 — reserve our own stock for this event\./); assert.match(INV, /\$\("#rvNextStep"\)\.href="ops\.html\?quote="\+encodeURIComponent\(quoteId\);/);
  assert.match(BUD, /Step 4 of 4 \(after stock, people and vendors\)/); assert.match(BUD, /\$\("#flowBack"\)\.href = id\?\("resources\.html\?quote="\+encodeURIComponent\(id\)\):"resources\.html";/);
  assert.match(SRC, /label: "Resources covered \(nothing missing\)"/);
});
t('no new SQL: the flow reuses event_resource_needs (open / outsourced), event_tasks via assign_tasks, reserve_inventory, 0256 vendor_request_save', () => {
  const man = read('supabase/migrations/MANIFEST');
  assert.ok(!/0267/.test(man));
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('FAIL - ' + name); throw e; } }
console.log('r24-resources: ' + n + '/' + tests.length + ' passed');
