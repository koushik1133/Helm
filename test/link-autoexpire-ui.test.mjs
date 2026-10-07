// Control Center → "Client links — auto-expire" card (0039). Pins: the card is hidden
// and only revealed inside the isAdmin branch; store-api calls the 0039 RPCs with the
// migration's argument names; 0039 wraps (never rewrites) every public entry point and
// is in the MANIFEST after 0037; and the card script, run against a stub DOM, shows the
// worked example date, refuses 0 / 366 / junk without calling the server, asks before
// switching on, and switches off without a prompt.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const ctl = r('public/control.html');
const api = r('public/store-api.js');
const mig = r('supabase/migrations/0039_link_autoexpire.sql');
const manifest = r('supabase/migrations/MANIFEST');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

await t('card exists, starts hidden, and is only revealed for admins', () => {
  assert.match(ctl, /<div class="card" id="lxCard" hidden>/);
  for (const id of ['lxMsg', 'lxErr', 'lx_on', 'lx_days', 'lx_example', 'lx_save'])
    assert.match(ctl, new RegExp(`id="${id}"`), id + ' missing');
  assert.match(ctl, /<input id="lx_days" type="number" min="1" max="365" step="1"/);
  assert.match(ctl, /<label class="lxtoggle" for="lx_on"><input type="checkbox" id="lx_on">/);
  const adminBlock = ctl.slice(ctl.indexOf('if(isAdmin){'), ctl.indexOf('/* ---------------- tab switching'));
  assert.match(adminBlock, /\$\("#lxCard"\)\.hidden=false; await initLinkExpiry\(\);/, 'must be revealed inside the isAdmin branch only');
  assert.equal(ctl.split('$("#lxCard").hidden=false').length - 1, 1, 'revealed in exactly one place');
});

await t('copy explains what it does, the limits and which links it covers', () => {
  const card = ctl.slice(ctl.indexOf('id="lxCard"'), ctl.indexOf('id="lx_save"'));
  assert.match(card, /weekends count/);
  assert.match(card, /never makes a link last longer/);
  for (const k of ['Quote approval link', 'Payment links', 'Proposal link', 'Crew task links', 'Invitation websites'])
    assert.ok(card.includes(k), k + ' not listed');
  assert.match(card, /already sent count from when they were sent/);
  assert.match(card, /Switching this off, or raising the number, makes them work again/);
});

await t('store-api links.autoExpire → 0039 RPCs with the migration\'s argument names', () => {
  const sig = mig.match(/create or replace function public\.admin_set_link_autoexpire\(([\s\S]*?)\)\s*returns/)[1];
  assert.deepEqual([...sig.matchAll(/(p_[a-z]+)\s/g)].map((m) => m[1]), ['p_enabled', 'p_days']);
  assert.match(api, /get: \(\) => rpc\("admin_get_link_autoexpire", \{\}\)/);
  assert.match(api, /set: \(enabled, days\) => rpc\("admin_set_link_autoexpire", \{ p_enabled: !!enabled, p_days: days \}\)/);
  assert.ok(mig.includes('create or replace function public.admin_get_link_autoexpire()'));
});

await t('0039: admin-only, 1–365, audited, default off/10, wraps every entry point', () => {
  assert.match(mig, /not public\.is_admin\(\) then\s*raise exception 'not authorized' using errcode = '42501'/);
  assert.match(mig, /if v_days < 1 or v_days > 365 then/);
  assert.match(mig, /'link_autoexpire\.set'/);
  assert.match(mig, /enabled\s+boolean not null default false/);
  assert.match(mig, /days\s+int not null default 10/);
  for (const f of ['public_get_quote', 'public_get_portal', 'create_payment', 'request_otp', 'verify_and_consent',
                   'payment_link_begin', 'otp_send_authorize', 'generate_approval_token', 'public_get_proposal',
                   'publish_proposal', '_work_token_live', 'event_site_live_until']) {
    assert.match(mig, new RegExp(`\\['${f}',`), f + ' not in the rename list');
    assert.match(mig, new RegExp(`create or replace function public\\.${f}\\(`), f + ' wrapper missing');
    assert.match(mig, new RegExp(`public\\.${f}__pre0039\\(`), f + ' wrapper must call the original');
  }
  assert.match(mig, /rename to %I', f\[1\], f\[2\], f\[1\] \|\| '__pre0039'/);
  assert.match(mig, /revoke all on function public\.%I\(%s\) from public, anon, authenticated', f\[1\] \|\| '__pre0039'/);
  assert.doesNotMatch(mig, /\b(drop table|truncate|delete from)\b/i, 'additive only');
  assert.doesNotMatch(mig, /create (temp|temporary) table/i, 'no temp tables');
  const lines = manifest.split('\n').filter((l) => /^forward\s/.test(l));
  const i37 = lines.findIndex((l) => l.includes('0037_platform_operator_check.sql'));
  const i39 = lines.findIndex((l) => l.includes('0039_link_autoexpire.sql'));
  assert.ok(i37 >= 0 && i39 > i37, '0039 must come after 0037 in MANIFEST');
});

// ---- behaviour: run the card script against a stub DOM ---------------------------
const src = ctl.slice(ctl.indexOf('/* ---------------- CLIENT LINK AUTO-EXPIRE (0039'), ctl.indexOf('  let dishCache=[];'));
assert.ok(src.length > 1000, 'card script not found');
const FIXED = Date.UTC(2026, 9, 7, 6, 0, 0);   // 7 Oct 2026, 11:30 in Kolkata
function setup({ get = async () => ({ enabled: false, days: 10, timezone: 'Asia/Kolkata' }), confirm = true } = {}) {
  const els = {}; const L = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', hidden: id === 'lxCard', value: '', checked: false, disabled: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused = true; },
    addEventListener(ev, fn) { (L[id + ':' + ev] = L[id + ':' + ev] || []).push(fn); } });
  const calls = []; const prompts = [];
  class FixedDate extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } }
  const ctx = {
    $: (s) => el(s.replace(/^#/, '')), esc: (s) => String(s), numAttr: (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d),
    errMsg: (e) => 'ERR ' + (e && e.message), setTimeout: () => 0, Date: FixedDate, Number, String, Object,
    BPUI: { guard: async (b, fn) => fn(), confirm: async (m, o) => { prompts.push(m); return confirm; },
            isMissingFunction: (e) => !!(e && e.code === 'PGRST202'), loadError: (c, e) => { c.innerHTML = 'LOADERR'; } },
    BPStore: { links: { autoExpire: { get, set: async (on, days) => { calls.push([on, days]); return { enabled: on, days: days == null ? 10 : days }; } } } },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\n;this.initLinkExpiry=initLinkExpiry;', ctx);
  return { ctx, els, el, calls, prompts, fire: async (id, ev) => { for (const f of L[id + ':' + ev] || []) await f({}); } };
}

await t('loads OFF/10: days field disabled, example says off, save enabled', async () => {
  const s = setup(); await s.ctx.initLinkExpiry();
  assert.equal(s.el('lx_on').checked, false); assert.equal(String(s.el('lx_days').value), '10');
  assert.equal(s.el('lx_days').disabled, true); assert.equal(s.el('lx_save').disabled, false);
  assert.match(s.el('lx_example').textContent, /^Off/);
});

await t('switching on shows the worked example date in the studio timezone', async () => {
  const s = setup(); await s.ctx.initLinkExpiry();
  s.el('lx_on').checked = true; await s.fire('lx_on', 'change');
  assert.equal(s.el('lx_days').disabled, false);
  assert.equal(s.el('lx_example').textContent, 'A link sent today would stop working on 17 Oct 2026.');
  s.el('lx_days').value = '1'; await s.fire('lx_days', 'input');
  assert.equal(s.el('lx_example').textContent, 'A link sent today would stop working on 8 Oct 2026.');
});

await t('0 / 366 / junk are refused in the page without calling the server', async () => {
  for (const bad of ['0', '366', '-3', '2.5', 'abc', '']) {
    const s = setup(); await s.ctx.initLinkExpiry();
    s.el('lx_on').checked = true; s.el('lx_days').value = bad; await s.fire('lx_days', 'input');
    assert.equal(s.el('lx_days').attrs['aria-invalid'], 'true', bad);
    await s.fire('lx_save', 'click');
    assert.equal(s.calls.length, 0, bad + ' reached the server');
    assert.match(s.el('lxMsg').innerHTML, /from 1 to 365/);
  }
});

await t('switching on asks first; cancel sends nothing; OK saves (true, N)', async () => {
  let s = setup({ confirm: false }); await s.ctx.initLinkExpiry();
  s.el('lx_on').checked = true; s.el('lx_days').value = '10'; await s.fire('lx_save', 'click');
  assert.equal(s.prompts.length, 1); assert.match(s.prompts[0], /10 days after it was sent/); assert.equal(s.calls.length, 0);
  s = setup(); await s.ctx.initLinkExpiry();
  s.el('lx_on').checked = true; s.el('lx_days').value = '10'; await s.fire('lx_save', 'click');
  assert.deepEqual(s.calls, [[true, 10]]);
  assert.match(s.el('lxMsg').innerHTML, /Saved — links now stop working 10 days/);
});

await t('switching off saves without a prompt (days ignored when off)', async () => {
  const s = setup({ get: async () => ({ enabled: true, days: 30, timezone: 'Asia/Kolkata' }) }); await s.ctx.initLinkExpiry();
  assert.equal(s.el('lx_on').checked, true); assert.equal(s.el('lx_days').disabled, false);
  s.el('lx_on').checked = false; await s.fire('lx_on', 'change'); await s.fire('lx_save', 'click');
  assert.equal(s.prompts.length, 0); assert.deepEqual(s.calls, [[false, 30]]);
  assert.match(s.el('lxMsg').innerHTML, /auto-expire is off/);
});

await t('not installed yet (0039 missing) hides the card; other load errors offer retry and block save', async () => {
  let s = setup({ get: async () => { const e = new Error('missing'); e.code = 'PGRST202'; throw e; } });
  s.el('lxCard').hidden = false; await s.ctx.initLinkExpiry();
  assert.equal(s.el('lxCard').hidden, true);
  s = setup({ get: async () => { throw new Error('network'); } }); await s.ctx.initLinkExpiry();
  assert.equal(s.el('lxErr').innerHTML, 'LOADERR'); assert.equal(s.el('lx_save').disabled, true);
  await s.fire('lx_save', 'click'); assert.equal(s.calls.length, 0);
});

console.log(`\nlink-autoexpire-ui: ${n} passed`);
