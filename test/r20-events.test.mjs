// r20 events (live QA on /sita, SMP-1001): client timeline money masked + studio-tz times, task times + picker in the
// studio zone, plan page payment date from the ledger + package from the quote, readiness never passes an empty
// locked menu or an unchecked venue, logistics "Part paid" only when part is left, task status label from the
// assignee, invitation prefill without event-type words / "Demo ·", badInput number boxes flagged, teardown Return
// only for issued stock, quotes list hides Delete on confirmed / paid events.
// Pure helpers run in a vm; store-api.js runs in a vm sandbox with a stubbed supabase client. No network, no DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'America/Chicago';   // the QA browser zone: nothing below may depend on it
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x));
const tests = []; const t = (n, f) => tests.push([n, f]);

/* ---------------------------------------------------------------- store-api sandbox */
const SRC = read('public/store-api.js');
function memStore(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function makeClient(respond) {
  const user = { id: 'u-1', email: 'staff@a.test' }, session = { user, access_token: 'x' };
  return {
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
      const run = () => Promise.resolve(respond(q));
      b.single = () => run().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data }));
      b.maybeSingle = b.single; b.then = (res, rej) => run().then(res, rej);
      return b;
    } };
}
async function makeEnv(respond) {
  const client = makeClient((q) => {
    if (q.table === 'profiles') return { data: [{ role: 'admin' }], error: null };
    if (q.table === 'role_access') return { data: [], error: null };
    return (respond || (() => ({ data: [], error: null })))(q);
  });
  const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=247' },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, supabase: { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: '/dashboard', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace() {}, reload() {} },
    document: doc, navigator: { onLine: true }, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {}, setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, atob: (b) => Buffer.from(b, 'base64').toString('binary'), console: { log() {}, info() {}, warn() {}, error() {} } };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(SRC, win, { filename: 'store-api.js' });
  await win.BPStore.init();
  win.BPStore.rememberStudioTimezone('Asia/Kolkata');
  return win;
}

/* ---------------------------------------------------------------- 1 + 2: client timeline */
t('client timeline: raw amounts become studio money flagged for "Hide amounts"; ISO days dd/mm/yyyy', async () => {
  const win = await makeEnv();
  vm.runInContext(read('public/client.js'), win, { filename: 'client.js' });
  const C = win.HelmClient360;
  const ms = J(C.subtitleParts('SMP-1001 / 572005.00 / due 2026-10-26', 'payments'));
  assert.deepEqual(ms.map((p) => p.money), [false, true, false]);
  assert.match(ms[1].text, /^₹\s?5,72,005$/);
  assert.equal(ms[2].text, 'due 26/10/2026');
  const pay = J(C.subtitleParts('SMP-1001 / INR 245145.00 / upi', 'payments'));
  assert.equal(pay[1].money, true); assert.match(pay[1].text, /^₹\s?2,45,145$/); assert.equal(pay[2].text, 'upi');
  assert.equal(J(C.subtitleParts('new / Wedding / walk_in / 2026-11-28', 'leads'))[3].text, '28/11/2026');
  assert.equal(J(C.subtitleParts('SMP-1001 / unassigned / Suresh Yadav', 'tasks'))[1].text, 'assigned', 'display only: the assignee is set');
  assert.equal(J(C.subtitleParts('SMP-1001 / unassigned', 'tasks'))[1].text, 'unassigned');
  assert.deepEqual(J(C.subtitleParts('paid 500.00 / due 2026-10-26', 'messages')), [{ text: 'paid 500.00 / due 2026-10-26', money: false }], 'message text is never parsed');
  assert.equal(J(C.subtitleParts('SMP-1001', 'events'))[0].text, 'SMP-1001');
});
t('client timeline: times in the studio zone (19 Oct 06:10 IST), not the browser zone (18 Oct, Chicago)', async () => {
  const win = await makeEnv();
  vm.runInContext(read('public/client.js'), win, { filename: 'client.js' });
  const w = win.HelmClient360.when('2026-10-19T00:40:00Z');
  assert.match(w, /19 Oct 2026/); assert.match(w, /06:10/i);
  const src = read('public/client.js');
  assert.match(src, /sp\.setAttribute\("data-money", ""\)/, 'amount spans carry [data-money] (always masked while hidden)');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML/);
});

/* ---------------------------------------------------------------- 2: ops task times + picker */
t('ops: task times and the schedule picker use the studio zone (round trip IST)', async () => {
  const win = await makeEnv();
  const O = read('public/ops.html');
  assert.match(O, /const fmtTime=\(iso\)=>\{ try\{ const o=BPStore\.fmtStudioDate\(iso,/);
  const s = O.indexOf('  const toLocalInput='), e = O.indexOf('  let scTaskId=null;');
  assert.ok(s > 0 && e > s);
  vm.runInContext('var pad2=(n)=>String(n).padStart(2,"0");' + O.slice(s, e).replace(/const (toLocalInput|fromLocalInput)=/g, 'var $1=') , win);
  assert.equal(win.toLocalInput('2026-10-28T13:00:00Z'), '2026-10-28T18:30');
  assert.equal(win.fromLocalInput('2026-10-28T18:30').toISOString(), '2026-10-28T13:00:00.000Z');
  assert.equal(win.fromLocalInput('2026-10-29T00:15').toISOString(), '2026-10-28T18:45:00.000Z');
  assert.ok(isNaN(win.fromLocalInput('garbage').getTime()));
  assert.match(O, /const startISO = when \? fromLocalInput\(when\)\.toISOString\(\) : null;/);
});
t('ops: a task saved "unassigned" with an assignee reads Assigned (display only)', () => {
  const O = read('public/ops.html');
  const s = O.indexOf('  const shownStatus='), e = O.indexOf('\n', s);
  const f = vm.runInNewContext(O.slice(s, e).replace('const shownStatus=', '(').replace(/;\s*$/, '') + ')');
  assert.equal(f({ status: 'unassigned', assignee_name: 'Suresh Yadav' }), 'assigned');
  assert.equal(f({ status: 'unassigned', assignee_name: '' }), 'unassigned');
  assert.equal(f({ status: 'accepted', assignee_name: 'Suresh Yadav' }), 'accepted');
  assert.match(O, /<span class="st \$\{esc\(stS\)\}">\$\{STATUS_LABEL\[stS\]\|\|esc\(stS\)\}<\/span>/);
});

/* ---------------------------------------------------------------- 2 + 4: plan page */
t('plan: payment date = ledger paid_at in the studio zone; package read like the builder', () => {
  const P = read('public/plan.html');
  assert.match(P, /esc\(day\(p\.paid_at\|\|p\.created_at\)\)/);
  assert.doesNotMatch(P, /new Date\(p\.created_at\)\.toLocaleDateString/);
  assert.match(P, /quotePkg=String\(\(p&&p\.menu_template\)\|\|\(ev&&ev\.pricing&&ev\.pricing\._packageName\)\|\|""\)\.trim\(\);/);
  assert.match(P, /if\(!planFailed && quotePkg && !\$\("#p_pkg"\)\.value\.trim\(\)\)/);
  const s = P.indexOf('  const pkgKey='), e = P.indexOf('\n', s);
  const key = vm.runInNewContext(P.slice(s, e).replace('const pkgKey=', '(').replace(/;\s*$/, '') + ')');
  assert.equal(key('Demo · Gold — Non-veg'), key('Gold — Non-veg'));
});

/* ---------------------------------------------------------------- 4 + 5: readiness */
async function readiness(planRow, quoteExtra) {
  const qid = '00000000-0000-4000-8000-000000000101';
  const win = await makeEnv((q) => {
    if (q.table === 'quotes') return { data: [Object.assign({ id: qid, code: 'SMP-1001', title: 'Ananya & Vikram Wedding', status: 'confirmed', lifecycle_stage: 'confirmed',
      event_date: '2026-10-28', client: { guests: 300 }, pricing: {} }, quoteExtra || {})], error: null };
    if (q.table === 'event_plan') return { data: planRow ? [Object.assign({ quote_id: qid }, planRow)] : [], error: null };
    return { data: [], error: null };
  });
  return win.BPStore.readiness.check(qid);
}
t('readiness: a locked but EMPTY menu does not pass; the quote package counts like in the builder', async () => {
  let r = await readiness({ menu_locked: true });
  let m = r.checks.find((c) => c.key === 'menu');
  assert.equal(m.ok, false); assert.match(m.detail, /locked, but no package or dishes yet/);
  r = await readiness({ menu_locked: true }, { pricing: { _packageName: 'Gold — Non-veg', platePrice: 950 } });
  m = r.checks.find((c) => c.key === 'menu');
  assert.equal(m.ok, true); assert.match(m.detail, /Gold — Non-veg/);
  r = await readiness({ menu_locked: false, package: 'Gold' });
  assert.equal(r.checks.find((c) => c.key === 'menu').ok, false, 'not locked is still not passed');
});
t('readiness: no saved venue = "Not checked" (never passed, not a blocker, not counted)', async () => {
  const r = await readiness(null);
  const c = r.checks.find((x) => x.key === 'capacity');
  assert.equal(c.ok, false); assert.equal(c.unchecked, true); assert.equal(c.critical, false);
  assert.match(c.detail, /^not checked - no saved venue linked$/);
  assert.equal(r.passed, r.checks.filter((x) => x.ok).length);
  const R = read('public/ready.html');
  assert.match(R, /c\.unchecked\?"Not checked"/); assert.match(R, /c\.unchecked\?'<span class="opt">not checked<\/span>'/);
});

/* ---------------------------------------------------------------- 3: logistics */
t('logistics: "Part paid" only while something is left on a not-yet-paid milestone', () => {
  const L = read('public/logistics.html');
  assert.match(L, /const part=m\.status!=="paid" && m\.status!=="waived" && _a\.paid>0 && Number\(_a\.rem\)>0\.005;/);
  assert.doesNotMatch(L, /const part=\(alloc\.get\(m\.id\)\|\|\{\}\)\.paid>0;/);
});

/* ---------------------------------------------------------------- 7: invitation prefill */
t('invite studio: event-type words dropped from a TITLE prefill; "Demo · " never in the greeting', () => {
  const I = read('public/invite-studio.html');
  const nd = I.indexOf('    const noDemo=(v)=>'), ndE = I.indexOf('\n', nd);
  const s = I.indexOf('    const noTypeWords=(v)=>'), e = I.indexOf('\n', s);
  const f = vm.runInNewContext('(()=>{' + I.slice(nd, ndE) + I.slice(s, e) + ' return noTypeWords; })()');
  assert.equal(f('Ananya & Vikram Wedding'), 'Ananya & Vikram');
  assert.equal(f('Demo · Ananya & Vikram Wedding'), 'Ananya & Vikram');
  assert.equal(f("Riya & Arjun's Engagement Ceremony"), 'Riya & Arjun');
  assert.equal(f('Kapoor Family Sangeet'), 'Kapoor Family');
  assert.equal(f('Wedding'), 'Wedding', 'never empties the name');
  assert.equal(f('Ayla & Sam'), 'Ayla & Sam');
  assert.match(I, /set\("f_names",c\.names\|\|c\.coupleNames\|\|\(tOk\?\(\(st==="wedding"\|\|st==="engagement"\)\?noTypeWords\(tOk\):tOk\):""\)/);
  const box = { window: {}, document: {} }; box.globalThis = box; vm.createContext(box);
  vm.runInContext(read('public/invite-site-share.js'), box);
  const S = box.window.HelmInviteShare;
  assert.equal(S.clientName({ client: { name: 'Demo · Ananya Reddy' } }), 'Ananya Reddy');
  assert.equal(S.clientName({ client: { name: 'Demo-Night Events' } }), 'Demo-Night Events');
  assert.equal(S.clientName({ client: {} }), 'there');
  assert.match(S.message({ client: { name: 'Demo · Ananya Reddy' } }, 'x'), /^Hi Ananya Reddy, /);
});

/* ---------------------------------------------------------------- 8: number boxes */
t('number boxes: badInput is "Enter a valid number" (shared HelmValidate, leads + inventory save)', () => {
  const fx = { window: {}, document: {} }; fx.globalThis = fx; vm.createContext(fx);
  vm.runInContext(read('public/form-validate.js'), fx);
  const F = read('public/form-validate.js');
  assert.match(F, /if \(bad\(\)\) return \{ ok: false, error: "Enter a valid number\." \};/);
  assert.match(F, /!o\.validateEmptyOnBlur && !bad\(\)\) return;/);
  const Lh = read('public/leads.html');
  assert.match(Lh, /if\(\$\("#f_budget"\)\.validity&&\$\("#f_budget"\)\.validity\.badInput\)\{ fail\("Budget: enter a valid number\."\); return; \}/);
  assert.match(Lh, /formSnap=formSnapshot\(\);/); assert.match(Lh, /if\(formSnap!=null && formSnapshot\(\)===formSnap\) formDirty\.clean\(\);/);
  const Iv = read('public/inventory.html');
  assert.match(Iv, /if\(badNum\("#i_qty"\)\)\{ \$\("#im_err"\)\.textContent="Total quantity: enter a valid number\.";/);
});

/* ---------------------------------------------------------------- 9: teardown */
t('teardown: Return only for issued stock (allocated / checked out), or from the event day on', () => {
  const T = read('public/teardown.html');
  assert.match(T, /const canReturnRow=\(r\)=>r\.status==="allocated" \|\| \(r\.status==="reserved" && \(issuedItems\.has\(r\.item_id\) \|\| eventStarted\)\);/);
  assert.match(T, /Not issued yet/);
});

/* ---------------------------------------------------------------- 10: quotes list Delete */
t('quotes list: no Delete on a confirmed / approved / paid / running event (Archive stays)', () => {
  const Q = read('public/quotes.html');
  const s = Q.indexOf('  function canOfferDelete(x){'), e = Q.indexOf('  async function delQuote(', s);
  const f = vm.runInNewContext('(' + Q.slice(s, e).trim().replace(/^function canOfferDelete/, 'function') + ')');
  assert.equal(f({ status: 'confirmed', approvalStatus: 'paid', lifecycleStage: 'confirmed' }), false);
  assert.equal(f({ status: 'sent', approvalStatus: 'approved' }), false);
  assert.equal(f({ status: 'quote', lifecycleStage: 'planning' }), false);
  assert.equal(f({ status: 'draft', approvalStatus: 'none', lifecycleStage: 'quote' }), true);
  assert.equal((Q.match(/\$\{canDelete&&canOfferDelete\(x\)\?`<button type="button" class="ic del" data-act="del"/g) || []).length, 2);
  assert.doesNotMatch(Q, /\$\{canDelete\?`<button type="button" class="ic del"/);
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('FAIL - ' + name); throw e; } }
console.log('r20-events: ' + n + '/' + tests.length + ' passed');
