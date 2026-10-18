// Control Center > General: billing details persist, one message after save, inline field errors,
// PIN digits-only (6) + Indian state dropdown, obvious empty business-phone field.
// Pure helpers + store-api org/swr slices run in a VM with a stub client; a headless-Chromium
// check of the DOM helpers runs when Playwright is installed (skipped, not failed, otherwise).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const CTL = read('public/control.html'), API = read('public/store-api.js');
const BF = require('../public/studio-billing-form.js');
const OB = require('../public/onboarding-core.js');
const H = require('../public/country-profile.js');
const tests = []; const t = (n, f) => tests.push([n, f]); let n = 0;

t('PIN: India keeps digits only, at most 6 ("--08976rew" -> "08976"); UAE P.O. box digits; others alnum', () => {
  assert.equal(BF.postalSanitize('IN', '--08976rew'), '08976');
  assert.equal(BF.postalSanitize('IN', '5000819999'), '500081');
  assert.equal(BF.postalSanitize('IN', '500 081'), '500081');
  assert.equal(BF.postalSanitize('AE', 'P.O. Box 12345'), '12345');
  assert.equal(BF.postalSanitize('GB', 'sw1a 1aa!'), 'SW1A 1AA');
  assert.equal(BF.postalSanitize('US', '75001-1234x'), '75001-1234');
  assert.deepEqual([BF.postalRule('IN').maxlength, BF.postalRule('IN').inputmode], [6, 'numeric']);
  assert.equal(BF.postalRule('GB').inputmode, 'text');
  // the shared validator still refuses a PIN starting with 0
  assert.equal(OB.validateBilling({ country: 'IN', pin: BF.postalSanitize('IN', '--08976rew') }).errors.pin, 'PIN code must be 6 digits (not starting with 0).');
});
t('state dropdown: 36 Indian states / UTs; saved value always kept (case fixed, unknown kept "as saved")', () => {
  const regions = H.get('IN').regions; assert.equal(regions.length, 36);
  const c = BF.stateChoice(regions, '');
  assert.equal(c.options.length, 37); assert.equal(c.options[0].value, ''); assert.equal(c.value, '');
  assert.equal(BF.stateChoice(regions, 'Telangana').value, 'Telangana');
  assert.equal(BF.stateChoice(regions, ' telangana ').value, 'Telangana');
  const odd = BF.stateChoice(regions, 'Old State Name');
  assert.equal(odd.value, 'Old State Name'); assert.equal(odd.options[1].label, 'Old State Name (as saved)'); assert.equal(odd.options.length, 38);
});
t('after save: ONE message - green when complete, otherwise "saved, still fill in ..." (no stale prompt)', () => {
  assert.deepEqual(BF.afterSaveMessage([]), { kind: 'ok', text: 'Studio settings saved.' });
  const m = BF.afterSaveMessage(['City', 'PIN code']);
  assert.equal(m.kind, 'warn'); assert.match(m.text, /^Studio settings saved\. .*still fill in: City, PIN code\.$/);
  const good = { country: 'IN', legal_name: 'Uma Studio', line1: '1 Road', city: 'Hyderabad', state: 'Telangana', pin: '500081', phone: '+919876543210', location: 'Hyderabad' };
  assert.deepEqual(BF.missingFromValues(OB, good), []);
  assert.deepEqual(BF.missingFromValues(OB, { ...good, phone: '' }), ['Business phone']);
  assert.equal(BF.promptText([]), '');
  // the saved row is what the prompt is computed from: complete billing -> nothing missing
  const org = OB.billingPatch({ name: 'Uma' }, OB.validateBilling(good).data);
  assert.deepEqual(OB.billingMissing(org), []);
});

t('control.html markup: PIN 6 digits + numeric keypad, state select, phone placeholder has no digits, save status by the button', () => {
  assert.match(CTL, /<input id="o_pin" maxlength="6" inputmode="numeric" pattern="\[1-9\]\[0-9\]\{5\}"/);
  assert.match(CTL, /<select id="o_state_sel" autocomplete="address-level1" hidden><\/select><input id="o_state"/);
  const ph = CTL.match(/<input id="o_phone"[^>]*>/)[0];
  assert.match(ph, /placeholder="Enter business phone"/); assert.match(ph, /data-ph-own="1"/); assert.doesNotMatch(ph, /placeholder="[^"]*\d/);
  assert.match(CTL, /<label for="o_phone">Business phone \*<\/label>/);
  assert.match(CTL, /id="o_save">Save studio settings<\/button><\/div>\n\s*<div id="orgSaveMsg" role="status" aria-live="polite"><\/div>/);
  assert.match(CTL, /<script src="onboarding-core\.js\?v=7"><\/script>\n<script src="studio-billing-form\.js\?v=2"><\/script>/);
  assert.match(CTL, /\.fld \.hp\.is-invalid\{border-color:#d92d20!important/);
});
t('control.html save: inline errors (all fields, first focused), fresh-row merge, read-back, one message', () => {
  const h = CTL.slice(CTL.indexOf('$("#o_save").addEventListener("click"'), CTL.indexOf('/* ---------------- CLIENT LINK AUTO-EXPIRE'));
  assert.ok(h.length > 1000);
  assert.doesNotMatch(h, /orgMsg\(/, 'save results go next to the button, not the top of the card');
  assert.doesNotMatch(h, /\.focus\(\); return; \}/, 'no "first error at the top, then return" left');
  assert.match(h, /OB\.BILLING_FIELDS\.forEach\(f=>\{ if\(r\.errors\[f\.key\]\) bad\(billEl\(f\.key\), r\.errors\[f\.key\]\); \}\)/);
  assert.match(h, /if\(BF\) BF\.showErrors\(errs\)/);
  // merge into the saved row, not the copy read at page load
  const fr = h.indexOf('BPStore.org.current({ fresh:true })'), pt = h.indexOf('const patch={');
  assert.ok(fr > 0 && fr < pt, 'fresh read happens before the patch is built');
  assert.match(h, /brand:Object\.assign\(\{\}, orgBrand, \{ logo:logo\|\|null/);
  // read-back after save, then a single message
  const sv = h.indexOf('await BPStore.org.save(patch)');
  assert.ok(h.indexOf('saved=await BPStore.org.current({ fresh:true })') > sv);
  assert.match(h, /if\(miss\.length\) \$\("#billPrompt"\)\.hidden=true;/);
  assert.match(h, /BF\.afterSaveMessage\(miss\)/);
  // the form loads from the server row
  assert.match(CTL, /try\{ o=await BPStore\.org\.current\(\{ fresh:true \}\); \}/);
  assert.match(CTL, /const o=await BPStore\.org\.current\(\{ fresh:true \}\); if\(!o\) return;/, 'syncOrgCountry merges into the saved row');
  // PIN / state wiring
  assert.match(CTL, /BF\.bindPostal\(\$\("#o_pin"\), \(\)=>\$\("#o_country"\)\.value\)/);
  assert.match(CTL, /BF\.paintPostal\(\$\("#o_pin"\), cc\); syncStateSelect\(\);/);
  assert.match(CTL, /i\.value=\$\("#o_state_sel"\)\.value; i\.dispatchEvent\(new Event\("change",\{bubbles:true\}\)\)/);
  assert.match(CTL, /\$\("#o_state"\)\.addEventListener\("change",followTz\)/);
});
t('review: the "saved, still fill in" note gives way to the live prompt when typing; no late prompt after save', () => {
  const live = CTL.slice(CTL.indexOf('function billPromptLive(){'), CTL.indexOf('function saveMsg(k,t){'));
  assert.match(live, /querySelector\("\.msg\.warn"\)/);
  assert.match(live, /if\(warnShown\)\{ saveMsg\("",""\); showBillPrompt\(BF\.missingFromValues\(OB, billVals\(\)\)\); return; \}/);
  assert.match(CTL, /clearTimeout\(bpT\); if\(miss\.length\) \$\("#billPrompt"\)\.hidden=true;/, 'a pending live recompute cannot re-show the yellow prompt next to the after-save message');
});
t('review: every onboarding org write merges into the SAVED row (never a tab-cached copy that drops billing)', () => {
  const ob = read('public/onboarding.js');
  const bases = ob.match(/const fresh = await BPStore\.org\.current\([^)]*\)/g) || [];
  assert.equal(bases.length, 3, 'studio/brand, progress and billing writes');
  bases.forEach((b) => assert.match(b, /\{ fresh: true \}/, b));
  // each fresh base is used for the save right after it
  ['W.studioPatch(fresh', 'W.progressPatch(fresh', 'O.billingPatch(fresh'].forEach((s) => assert.ok(ob.includes(s), s));
});

// ---- store-api: org.save refuses to say "saved" when no row changed; fresh read; swr generation guard ----
function orgSlice() { return API.slice(API.indexOf('  const org = {'), API.indexOf('  /* ---------------- branded client links')); }
function makeOrg(updateRows, opts) {
  const o = opts || {}; const calls = [];
  const ss = new Map(); const sessionStorage = { getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k) };
  const builder = (table) => {
    const q = { table, op: 'select', patch: null, sel: null };
    const api = {
      select(c) { if (q.op === 'update') q.sel = c; else q.op = 'select'; return api; },
      update(p) { q.op = 'update'; q.patch = p; return api; },
      eq() { return api; },
      maybeSingle() { calls.push({ ...q }); return Promise.resolve({ data: o.row || { id: 'o1', brand: {} }, error: null }); },
      then(res, rej) { calls.push({ ...q }); return Promise.resolve(q.op === 'update' ? { data: q.sel ? updateRows : null, error: o.err || null } : { data: [], error: null }).then(res, rej); },
    };
    return api;
  };
  const supa = { from: builder };
  const ctx = vm.createContext({ supa, sessionStorage, SWR_PREFIX: 'bp_swr:', swr: (k, f) => f(), orgIdStrict: async () => (o.noOrg ? null : 'o1'),
    rpc: async () => null, Promise, Object, Array, Error, console });
  vm.runInContext(orgSlice() + '\nthis.org = org;', ctx);
  return { org: ctx.org, calls, ss };
}
t('org.save: asks for the row back; 0 rows (row rules said no) -> clear 42501 error, never a silent "saved"', async () => {
  const ok = makeOrg([{ id: 'o1' }]); assert.equal(await ok.org.save({ name: 'x' }), true);
  assert.equal(ok.calls[0].op, 'update'); assert.equal(ok.calls[0].sel, 'id');
  const no = makeOrg([]); const e = await no.org.save({ name: 'x' }).then(() => null, (x) => x);
  assert.ok(e, 'must throw'); assert.equal(e.code, '42501'); assert.match(e.message, /^Nothing was changed: only a studio admin/);
  const none = makeOrg([{ id: 'o1' }], { noOrg: true }); assert.ok(await none.org.save({}).then(() => null, (x) => x));
  // older DB without business_email_confirmed: retried WITH the row check too
  assert.match(API, /\(\{ data, error \} = await supa\.from\("organizations"\)\.update\(rest\)\.eq\("id", oid\)\.select\("id"\)\);/);
});
t('org.current({fresh:true}) drops the cached row first; plain current() still uses the tab cache', async () => {
  const m = makeOrg([], { row: { id: 'o1', brand: { billing: { city: 'Hyd' } } } });
  m.ss.set('bp_swr:org:o1', 'stale');
  const r = await m.org.current({ fresh: true }); assert.equal(r.brand.billing.city, 'Hyd'); assert.equal(m.ss.has('bp_swr:org:o1'), false);
  m.ss.set('bp_swr:org:o1', 'x'); await m.org.current(); assert.equal(m.ss.get('bp_swr:org:o1'), 'x');
});
t('swr: a read that started before a write never refills the cache after it', async () => {
  const src = API.slice(API.indexOf('  const SWR_PREFIX ='), API.indexOf('  // writes that cannot touch the cached reads'));
  const ss = new Map(); const sessionStorage = { get length() { return ss.size; }, key: (i) => [...ss.keys()][i], getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k) };
  const ctx = vm.createContext({ sessionStorage, supa: {}, currentUser: { id: 'u1' }, mode: 'supabase', sessEntry: () => ({ val: 'o1' }), Date, JSON, Promise, console });
  vm.runInContext(src + '\nthis.swr = swr; this.swrClear = swrClear;', ctx);
  let release; const slow = new Promise((r) => { release = r; });
  const p = ctx.swr('org:o1', () => slow);   // GET in flight (old row)
  ctx.swrClear();                            // a write happens meanwhile
  release({ billing: null }); await p;
  assert.equal(ss.has('bp_swr:org:o1'), false, 'pre-write row must not be cached');
  await ctx.swr('org:o1', async () => ({ billing: { city: 'Hyd' } }));
  assert.match(ss.get('bp_swr:org:o1'), /Hyd/, 'a read after the write is cached as before');
});

// ---- headless Chromium: the real markup + helpers ----
async function browser() {
  let pw = null; try { pw = await import('playwright'); } catch (e) {}
  if (!pw) { console.log('  - headless DOM check skipped (playwright not installed)'); return; }
  const dir = path.resolve(new URL('public/', root).pathname);
  const card = CTL.slice(CTL.indexOf('<h3>Organization / studio</h3>'), CTL.indexOf('<div class="s-e3ae377" id="slugBox"'));
  const style = CTL.match(/<style>\n  :root\{[\s\S]*?<\/style>/)[0];
  const page = `<!doctype html><html><head><meta charset="utf-8">${style}<link rel="stylesheet" href="/theme.css"></head><body><div class="card">${card}</div>
<script src="/phone-input.js"></script><script src="/country-profile.js"></script><script src="/onboarding-core.js"></script><script src="/studio-billing-form.js"></script></body></html>`;
  const srv = http.createServer((q, r) => {
    const u = decodeURIComponent(new URL(q.url, 'http://x').pathname);
    if (u === '/h.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(page); }
    const f = path.join(dir, u); if (!f.startsWith(dir)) { r.writeHead(403); return r.end(); }
    try { const b = readFileSync(f); r.writeHead(200, { 'content-type': /\.css$/.test(f) ? 'text/css' : 'application/javascript' }); r.end(b); } catch (e) { r.writeHead(404); r.end(); }
  }).listen(0);
  let br;
  try { br = await pw.chromium.launch(); } catch (e) { srv.close(); console.log('  - headless DOM check skipped (no browser)'); return; }
  try {
    const pg = await br.newPage({ viewport: { width: 1280, height: 900 } });
    await pg.goto(`http://127.0.0.1:${srv.address().port}/h.html`);
    await pg.evaluate(() => { const BF = window.HelmBillingForm, pin = document.getElementById('o_pin');
      window.HelmPhone.attach(document.getElementById('o_phone'));
      BF.paintPostal(pin, 'IN'); BF.bindPostal(pin, () => 'IN');
      const st = document.getElementById('o_state'); st.value = 'telangana';
      BF.paintState(st, document.getElementById('o_state_sel'), document.getElementById('o_state_lbl'), window.HelmCountry.get('IN').regions, true); });
    await pg.click('#o_pin'); await pg.keyboard.type('--08976rew1234');
    const r = await pg.evaluate(() => {
      const BF = window.HelmBillingForm, ph = document.getElementById('o_phone'), pin = document.getElementById('o_pin'), sel = document.getElementById('o_state_sel');
      const out = { pin: pin.value, maxlength: pin.getAttribute('maxlength'), im: pin.getAttribute('inputmode'), selShown: !sel.hidden, inputHidden: document.getElementById('o_state').hidden,
        selVal: sel.value, opts: sel.options.length, lblFor: document.getElementById('o_state_lbl').htmlFor, phPh: ph.getAttribute('placeholder') };
      document.getElementById('o_pin').blur();
      const n = BF.showErrors([{ el: pin, msg: 'PIN code must be 6 digits (not starting with 0).' }, { el: ph, msg: 'Business phone is required.' }]);
      const wrap = ph.closest('.hp'), pe = document.getElementById('o_phone_ferr');
      out.n = n; out.focused = document.activeElement && document.activeElement.id;
      out.phErrAfterWrap = !!pe && wrap.nextElementSibling === pe; out.phErr = pe && pe.textContent; out.wrapInvalid = wrap.classList.contains('is-invalid');
      out.pinInvalid = pin.getAttribute('aria-invalid'); out.pinDesc = pin.getAttribute('aria-describedby');
      return out; });
    await pg.mouse.move(0, 0); await pg.waitForTimeout(500);   // border transitions settle
    Object.assign(r, await pg.evaluate(() => { const pin = document.getElementById('o_pin'); const border = getComputedStyle(pin).borderTopColor;
      pin.value = '500081'; pin.dispatchEvent(new Event('input', { bubbles: true }));
      return { border, cleared: !pin.hasAttribute('aria-invalid') && document.getElementById('o_pin_ferr').hidden }; }));
    assert.equal(r.pin, '089761', 'letters/dashes dropped, 6 digits max');
    assert.equal(r.maxlength, '6'); assert.equal(r.im, 'numeric');
    assert.ok(r.selShown && r.inputHidden); assert.equal(r.selVal, 'Telangana'); assert.equal(r.opts, 37); assert.equal(r.lblFor, 'o_state_sel');
    assert.equal(r.phPh, 'Enter business phone', 'phone keeps a digit-free hint (no "XXXXX XXXXX" mask)');
    assert.equal(r.n, 2); assert.equal(r.focused, 'o_phone', 'first field in page order is focused (phone is above PIN)');
    assert.ok(r.phErrAfterWrap, 'phone error sits right under the phone widget'); assert.equal(r.phErr, 'Business phone is required.');
    assert.ok(r.wrapInvalid); assert.equal(r.pinInvalid, 'true'); assert.match(r.pinDesc, /o_pin_ferr/);
    assert.equal(r.border, 'rgb(217, 45, 32)', 'red border');
    assert.ok(r.cleared, 'typing a fix clears the error');
    console.log('  ✓ headless Chromium: digits-only PIN, state dropdown, inline errors under the field (focus + red border)');
  } finally { await br.close(); srv.close(); }
}

for (const [name, fn] of tests) { await fn(); n++; console.log('  ✓ ' + name); }
await browser();
console.log(`cc-general-billing: ${n} passed`);
