// Control Center → Notifications (0036). Pins: the admin-only tab + pane exist and are
// wired into switchTab; store-api's bell.prefs calls the 0036 RPCs with the argument
// names the migration declares; and the matrix script, run against a stub DOM, renders
// one column per staff role, groups rows, shows REQUIRED client channels as locked
// labels (not buttons), and turns clicks / per-person picks into the right RPC calls.
// The bell hides chat when the person's prefs hide 'chat_message' (fail-open).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const ctl = readFileSync(new URL('../public/control.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const mig = readFileSync(new URL('../supabase/migrations/0036_notification_prefs.sql', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../supabase/migrations/MANIFEST', import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

await t('admin-only Notifications tab + pane, wired into switchTab and the #notifications hash', () => {
  assert.match(ctl, /<button type="button" class="tab" data-pane="notify" id="tab-notify" aria-pressed="false" hidden>/);
  assert.match(ctl, /<div id="pane-notify" hidden>/);
  assert.match(ctl, /\$\("#pane-notify"\)\.hidden\s*=\s*name!=="notify";\s*\n\s*if\(name==="notify"\) initNotify\(\);/);
  const adminBlock = ctl.slice(ctl.indexOf('if(isAdmin){'), ctl.indexOf('/* ---------------- tab switching'));
  assert.match(adminBlock, /\$\("#tab-notify"\)\.hidden=false/, 'tab must only be revealed inside the isAdmin branch');
  assert.match(adminBlock, /location\.hash==="#notifications"\) switchTab\("notify"\)/);
  for (const id of ['nf_q', 'nf_grp', 'nf_reset', 'nf_head', 'nf_rows', 'nf_table', 'np_user', 'np_list', 'nmsg'])
    assert.match(ctl, new RegExp(`id="${id}"`), id + ' missing');
  assert.match(ctl, /<caption class="sr-only">/);
});

await t('store-api bell.prefs → 0036 RPCs with the migration\'s argument names', () => {
  const sig = mig.match(/create or replace function public\.admin_set_notification_pref\(([\s\S]*?)\)\s*returns/)[1];
  const names = [...sig.matchAll(/(p_[a-z]+)\s/g)].map((m) => m[1]);
  assert.deepEqual(names, ['p_type', 'p_channel', 'p_role', 'p_enabled', 'p_user']);
  const set = api.match(/set: \(type, channel, role, enabled, userId\) => rpc\("admin_set_notification_pref",\s*\{([^}]*)\}/);
  assert.ok(set, 'bell.prefs.set missing');
  for (const p of names) assert.match(set[1], new RegExp(p + ':'), p + ' not passed');
  assert.match(api, /get: \(\) => rpc\("admin_get_notification_prefs", \{\}\)/);
  assert.match(api, /reset: \(\) => rpc\("admin_reset_notification_prefs", \{\}\)/);
  assert.match(api, /rpc\("my_notification_prefs", \{\}\)/);
  for (const f of ['admin_get_notification_prefs()', 'admin_reset_notification_prefs()', 'my_notification_prefs()'])
    assert.ok(mig.includes('create or replace function public.' + f), f + ' not in 0036');
  assert.match(manifest, /^forward\s+supabase\/migrations\/0036_notification_prefs\.sql$/m);
});

await t('bell hides chat when my prefs hide chat_message; prefs failure hides nothing', () => {
  // chat switched off for this role/person → chat rows hidden, but @mentions still come through
  assert.match(api, /const chatOff = hiddenTypes\.indexOf\("chat_message"\) !== -1;/);
  assert.match(api, /if \(chatOff\) chatItems = chatItems\.filter\(\(c\) => c && c\.mention\);/);
  assert.match(api, /catch \(e\) \{ return \{ hidden: \[\] \}; \}/);
  assert.match(api, /n\.status === "suppressed" \? " \(not sent — switched off\)"/);
});

// ---- behaviour: run the matrix script against a stub DOM ---------------------------
const src = ctl.slice(ctl.indexOf('/* ---------------- NOTIFICATIONS (0036)'), ctl.indexOf('$("#loginForm").addEventListener'));
assert.ok(src.length > 1000, 'matrix script not found');
const ROLES = ['admin', 'manager', 'planner', 'sales', 'coordinator', 'supervisor', 'quality', 'operations', 'designer', 'crew', 'worker'];
const CAT = [
  { type: 'otp', group: 'Sales', label: 'Approval code (OTP) sent', description: 'code', channels: ['in_app', 'sms'], required: ['sms'], gated: [], money: false },
  { type: 'task_reminder', group: 'Operations', label: 'Task reminder', description: 'nudge', channels: ['in_app', 'sms'], required: [], gated: ['sms'], money: false },
  { type: 'payment_receipt', group: 'Finance', label: 'Payment receipt', description: 'receipt', channels: ['in_app', 'email'], required: ['email'], gated: [], money: true },
];
function state(over = {}) {
  const in_app = {}; CAT.forEach((c) => { in_app[c.type] = {}; ROLES.forEach((r) => { const d = !c.money || r === 'admin' || r === 'sales'; in_app[c.type][r] = { on: d, default: d, set: false }; }); });
  return Object.assign({ catalog: CAT, roles: ROLES, in_app,
    outbound: { otp: { sms: { on: true, default: true, required: true, switchable: false } },
                task_reminder: { sms: { on: true, default: true, required: false, switchable: true } },
                payment_receipt: { email: { on: true, default: true, required: true, switchable: false } } },
    people: [], changed: 0 }, over);
}
function makeDom() {
  const els = {}; const L = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', hidden: false, value: '', disabled: false, options: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(ev, fn) { (L[id + ':' + ev] = L[id + ':' + ev] || []).push(fn); } });
  // the group <select>: options.length follows the innerHTML we write
  const g = el('nf_grp'); Object.defineProperty(g, 'options', { get() { return (this.innerHTML.match(/<option/g) || []); } });
  return { $: (s) => el(s.replace(/^#/, '')), els, fire: async (id, ev, e) => { for (const f of L[id + ':' + ev] || []) await f(e); } };
}
async function run() {
  const dom = makeDom(); const calls = []; let srv = state();
  const BPStore = { auth: { admin: { roleLabel: (r) => r[0].toUpperCase() + r.slice(1), listUsers: async () => [
      { id: 'u-crew', email: 'c@x.test', full_name: 'Cara Crew', role: 'crew' }, { id: 'u-sales', email: 's@x.test', full_name: 'Sam Sales', role: 'sales' }] } },
    bell: { prefs: {
      get: async () => JSON.parse(JSON.stringify(srv)),
      set: async (type, channel, role, enabled, user) => { calls.push({ type, channel, role, enabled, user: user || null });
        if (channel === 'in_app' && !user) { srv.in_app[type][role].on = enabled; srv.changed++; }
        else if (channel !== 'in_app') { srv.outbound[type][channel].on = enabled; srv.changed++; }
        else { srv.people = srv.people.filter((p) => !(p.user_id === user && p.type === type)); if (enabled !== null) srv.people.push({ user_id: user, type, enabled }); }
        return {}; },
      reset: async () => { const k = srv.changed; srv = state(); return k; } } } };
  const ctx = { $: dom.$, esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    errMsg: (e) => String(e && e.message || e), setTimeout: () => 0, Promise, JSON, String, Number, Object,
    BPUI: { loadError() {}, toast() {}, confirm: async () => true, guard: async (_b, fn) => fn() }, BPStore };
  vm.runInNewContext(src + '\nglobalThis.api={initNotify, saveNotify, renderNotify, renderPeople, get queue(){return npQueue;}};', ctx);
  await ctx.api.initNotify();
  return { dom, calls, ctx, getSrv: () => srv };
}

await t('matrix renders one column per staff role, groups, required = locked label, gated = button', async () => {
  const { dom } = await run();
  const head = dom.els.nf_head.innerHTML;
  assert.equal((head.match(/<th scope="col"/g) || []).length, ROLES.length + 2, 'label + 11 roles + channels');
  assert.doesNotMatch(head, /Client/);
  const rows = dom.els.nf_rows.innerHTML;
  assert.deepEqual([...rows.matchAll(/<th colspan="13" scope="colgroup"><span>([^<]+)</g)].map((m) => m[1]), ['Sales', 'Operations', 'Finance']);
  assert.equal((rows.match(/class="ncell/g) || []).length, CAT.length * ROLES.length);
  assert.match(rows, /<span class="nch req"[^>]*>SMS · required<\/span>/);
  assert.match(rows, /<span class="nch req"[^>]*>E-mail · required<\/span>/);
  assert.match(rows, /<button type="button" class="nch on" data-type="task_reminder" data-ch="sms" aria-pressed="true"/);
  assert.doesNotMatch(rows, /<button[^>]*data-type="otp" data-ch=/, 'required channel must not be a button');
  // money default: crew cell for payment_receipt is off, sales/admin on
  assert.match(rows, /class="ncell" data-type="payment_receipt" data-role="crew" aria-pressed="false"/);
  assert.match(rows, /class="ncell on" data-type="payment_receipt" data-role="sales" aria-pressed="true"/);
  assert.match(rows, /<span class="nbadge"/);
  assert.equal(dom.els.nf_changed.textContent, 'Using the defaults');
  assert.equal(dom.els.nf_reset.disabled, true);
  assert.match(dom.els.np_user.innerHTML, /<option value="u-crew">Cara Crew · Crew<\/option>/);
});

await t('clicks → set(type, in_app, role, !on) / set(type, sms, null, false); changed marker + counter', async () => {
  const { dom, calls, ctx } = await run();
  await dom.fire('nf_rows', 'click', { target: { closest: (s) => s === '.ncell' ? { dataset: { type: 'task_reminder', role: 'crew' } } : null } });
  await ctx.api.queue;
  await dom.fire('nf_rows', 'click', { target: { closest: (s) => s === 'button.nch' ? { dataset: { type: 'task_reminder', ch: 'sms' } } : null } });
  await ctx.api.queue;
  await dom.fire('nf_rows', 'click', { target: { closest: (s) => s === 'button.nch' ? { dataset: { type: 'otp', ch: 'sms' } } : null } });
  await ctx.api.queue;
  assert.deepEqual(calls, [
    { type: 'task_reminder', channel: 'in_app', role: 'crew', enabled: false, user: null },
    { type: 'task_reminder', channel: 'sms', role: null, enabled: false, user: null },
  ], 'a required channel never reaches the RPC');
  const rows = dom.els.nf_rows.innerHTML;
  assert.match(rows, /class="ncell chg" data-type="task_reminder" data-role="crew" aria-pressed="false"/);
  assert.match(rows, /class="nch chg" data-type="task_reminder" data-ch="sms" aria-pressed="false"[^>]*>SMS off</);
  assert.equal(dom.els.nf_changed.textContent, '2 settings changed from the defaults');
  assert.equal(dom.els.nf_reset.disabled, false);
  assert.match(dom.els.nmsg.innerHTML, /Task reminder · SMS to staff: off/);
});

await t('search + group filter narrow the rows', async () => {
  const { dom, ctx } = await run();
  dom.els.nf_q.value = 'receipt'; ctx.api.renderNotify();
  assert.equal((dom.els.nf_rows.innerHTML.match(/<th scope="row"/g) || []).length, 1);
  dom.els.nf_q.value = ''; dom.els.nf_grp.value = 'Operations'; ctx.api.renderNotify();
  assert.match(dom.els.nf_rows.innerHTML, /Task reminder/); assert.doesNotMatch(dom.els.nf_rows.innerHTML, /Payment receipt/);
  dom.els.nf_grp.value = ''; dom.els.nf_q.value = 'zzz'; ctx.api.renderNotify();
  assert.match(dom.els.nf_rows.innerHTML, /No notification matches your search/);
});

await t('per-person: follow role / always / never → set(type, in_app, null, null|true|false, user)', async () => {
  const { dom, calls, ctx } = await run();
  dom.els.np_user.value = 'u-crew'; ctx.api.renderPeople();
  assert.match(dom.els.np_list.innerHTML, /<option value="" selected>Follow role \(hidden\)<\/option>/, 'crew follows the money default (hidden)');
  for (const v of ['1', '0', '']) {
    await dom.fire('np_list', 'change', { target: { closest: () => ({ dataset: { type: 'payment_receipt' }, value: v }) } });
    await ctx.api.queue;
  }
  assert.deepEqual(calls.map((c) => [c.type, c.channel, c.role, c.enabled, c.user]), [
    ['payment_receipt', 'in_app', null, true, 'u-crew'], ['payment_receipt', 'in_app', null, false, 'u-crew'], ['payment_receipt', 'in_app', null, null, 'u-crew']]);
});

console.log(`notification-prefs-ui: ${n} checks passed`);
