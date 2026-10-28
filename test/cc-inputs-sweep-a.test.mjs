// Settings input sweep A (Oct 2026): General (business e-mail, phone, GSTIN / tax ID,
// accent colour, logo URL, client link name), Hide amounts (privacy PIN), Client links &
// packages (auto-expire days, package lock days), Users & invites (e-mail, role, self /
// member / duplicate invite), Roles & access (suggested access queued with single toggles).
// Pure rules from public/cc-inputs.js + source pins on how control.html / pkg-review.js /
// privacy-pin-settings.js use them + the link-expiry card run against a stub DOM.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
require('../public/form-validate.js');
const C = require('../public/cc-inputs.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const okv = (res, v) => { assert.equal(res.ok, true, JSON.stringify(res)); if (v !== undefined) assert.equal(res.value, v); };
const no = (res, re) => { assert.equal(res.ok, false, JSON.stringify(res)); if (re) assert.match(res.error, re); };

await t('e-mail: trims, lower-cases, tidies pasted "Name <x>" / mailto: / trailing dot; rejects spaces, emoji, two @, too long', () => {
  okv(C.email(''), ''); okv(C.email('   '), ''); no(C.email('', { required: true }), /Please enter/);
  okv(C.email('  Ravi@Studio.COM '), 'ravi@studio.com');
  okv(C.email('Ravi K <ravi@studio.in>'), 'ravi@studio.in');
  okv(C.email('mailto:hello@studio.com.'), 'hello@studio.com');
  okv(C.email('​hello@studio.com﻿'), 'hello@studio.com');
  no(C.email('ravi @studio.com'), /spaces/); no(C.email('ravi😀@studio.com'), /emoji/);
  no(C.email('a@@b.com'), /exactly one @/); no(C.email('a@b'), /like name@studio\.com/);
  no(C.email('a..b@c.com')); no(C.email('.a@c.com')); no(C.email('a.@c.com'));
  no(C.email('x'.repeat(250) + '@b.com'), /too long/); no(C.email('x'.repeat(65) + '@b.com'));
});

await t('GSTIN: 15 characters, state code 01-38/97/99, PAN shape, Z; spaces + lower case pasted in are fixed', () => {
  okv(C.gstin(''), ''); okv(C.gstin('  '), '');
  okv(C.gstin('36abcde1234f1z5'), '36ABCDE1234F1Z5');
  okv(C.gstin(' 36 ABCDE 1234 F1Z5 '), '36ABCDE1234F1Z5');
  okv(C.gstin('22AAAAA0000A1Z5'), '22AAAAA0000A1Z5');   // the official sample used as the placeholder
  okv(C.gstin('97AAAAA0000A1Z5')); okv(C.gstin('38AAAAA0000A1Z5'));
  no(C.gstin('36ABCDE1234F1Z'), /exactly 15 characters .* has 14/);
  no(C.gstin('36ABCDE1234F1Z55'), /has 16/);
  no(C.gstin('00ABCDE1234F1Z5'), /state code/); no(C.gstin('39ABCDE1234F1Z5'), /state code/);
  no(C.gstin('AAABCDE1234F1Z5'), /state code/);
  no(C.gstin('36ABCDE12A4F1Z5'), /PAN/); no(C.gstin('36ABCDE1234F1Y5'), /always Z/);
  no(C.gstin('36ABCDE1234F0Z5'), /13th/);
  no(C.gstin('36ABCDE1234F1Z5😀'), /letters and numbers/); no(C.gstin('36ABCDE/1234F1Z5'), /letters and numbers/);
  // every GSTIN this accepts is also accepted by the shared country-tax rule (never stricter on the server side)
  const T = r('public/store-api.js').match(/idRe: (\/\^\[0-9\]\{2\}\[A-Z\]\{5\}[^,]*\/), idEg: "36ABCDE1234F1Z5"/);
  assert.ok(T, 'IN idRe not found'); const re = vm.runInNewContext(T[1]);
  for (const g of ['36ABCDE1234F1Z5', '22AAAAA0000A1Z5', '01ZZZZZ9999Z9ZZ']) { okv(C.gstin(g)); assert.ok(re.test(g), g); }
});

await t('tax ID outside India uses the country rule; too long / emoji are refused', () => {
  okv(C.taxId('', 'AE'), ''); no(C.taxId('x'.repeat(31), 'AE'), /too long/); no(C.taxId('1😀', 'GB'), /emoji/);
  okv(C.taxId('36abcde1234f1z5', 'IN'), '36ABCDE1234F1Z5');
});

await t('accent colour: #-prefix added, upper case + spaces fixed, 3-digit expanded; names / alpha / junk refused', () => {
  okv(C.accent(''), ''); okv(C.accent('#6D28D9'), '#6d28d9'); okv(C.accent('6d28d9'), '#6d28d9');
  okv(C.accent(' # 6d 28 d9 '), '#6d28d9'); okv(C.accent('#abc'), '#aabbcc'); okv(C.accent('abc'), '#aabbcc');
  no(C.accent('purple'), /colour names/); no(C.accent('#12345678'), /Transparent/); no(C.accent('#1234'), /Transparent/);
  no(C.accent('#ggg'), /hex code/); no(C.accent('#6d28d'), /hex code/); no(C.accent('rgb(1,2,3)'), /hex code/); no(C.accent('#6d28d9😀'));
});

await t('logo URL: https only (same rule as onboarding), bare domain gets https://, no spaces / scripts / credentials / >500', () => {
  okv(C.logo(''), ''); okv(C.logo(' https://cdn.studio.com/logo.png '), 'https://cdn.studio.com/logo.png');
  okv(C.logo('cdn.studio.com/logo.png'), 'https://cdn.studio.com/logo.png');
  okv(C.logo('//cdn.studio.com/logo.png'), 'https://cdn.studio.com/logo.png');
  no(C.logo('http://studio.com/logo.png'), /https:\/\//);
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'file:///etc/passwd', 'ftp://x.com/a.png']) no(C.logo(bad), /https/);
  no(C.logo('https://studio.com/my logo.png'), /spaces/); no(C.logo('logo'), /full image link/);
  no(C.logo('https://localhost/logo.png'), /website name/); no(C.logo('https://u:p@x.com/a.png'), /password/);
  no(C.logo('https://x.com/a.png?"onload='), /not allowed|quotes/);
  no(C.logo('https://x.com/' + 'a'.repeat(500)), /too long/);
  assert.equal(C.LOGO_MAX, 500);
  assert.match(r('public/booklet.js'), /u\.length <= 500/, 'booklet shows logos up to 500 characters');
});

await t('client link name: 3-40 lowercase / digits / single dashes; live typing is normalised', () => {
  okv(C.slug('aurora-events'), 'aurora-events'); okv(C.slug('Aurora-Events'), 'aurora-events'); okv(C.slug('abc'));
  no(C.slug(''), /Enter a link name/); no(C.slug('  '), /Enter a link name/); no(C.slug('ab'), /at least 3/);
  no(C.slug('a'.repeat(41)), /40 characters/); okv(C.slug('a'.repeat(40)));
  no(C.slug('-abc'), /start or end/); no(C.slug('abc-'), /start or end/); no(C.slug('a--b'), /single dashes/);
  no(C.slug('a b'), /no spaces/); no(C.slug('a.b'), /no spaces, dots/); no(C.slug('studio😀'), /emoji/);
  assert.equal(C.slugLive(' Café Events!!'), 'cafe-events-');
  assert.equal(C.slugLive('aurora__events'), 'aurora-events');
  assert.equal(C.slugLive('😀studio'), 'studio');
  assert.equal(C.slugLive('---a'), 'a');
  assert.equal(C.slugLive('x'.repeat(60)).length, 60, 'live typing never cuts silently — the rule says it is too long');
});

await t('privacy PIN: exactly 4 digits per box, confirm must match, new differs from current', () => {
  okv(C.pin('0000'), '0000'); okv(C.pin(' 12 34 '), '1234');
  no(C.pin(''), /Enter the 4-digit PIN/); no(C.pin('12a4'), /digits only/); no(C.pin('123'), /exactly 4 digits .* has 3/);
  no(C.pin('123456'), /has 6/); no(C.pin('1.23'), /digits only/); no(C.pin('-123'), /digits only/); no(C.pin('١٢٣٤'), /digits only/);
  assert.deepEqual(C.pinForm('0000', '4826', '4826'), { cur: '', next: '', again: '' });
  const e = C.pinForm('', '', '');
  assert.match(e.cur, /current PIN \(0000/); assert.match(e.next, /Choose a new/); assert.match(e.again, /again/);
  assert.match(C.pinForm('0000', '4826', '4827').again, /don't match/);
  assert.match(C.pinForm('0000', '0000', '0000').next, /same as the current/);
  assert.equal(C.pinForm('0000', '12345', '12345').again, '', 'only the box that is wrong gets the message');
  // the server keeps a 4-digit PIN (0157) — the page must not offer a longer one
  assert.match(r('supabase/migrations/0157_privacy_pin.sql'), /p_new !~ '\^\[0-9\]\{4\}\$'/);
});

await t('day counts: whole numbers in range, leading zeros ok, decimals / negatives / e-notation / junk explained', () => {
  const d = (v, o) => C.days(v, o);
  okv(d('1'), 1); okv(d('365'), 365); okv(d('010'), 10); okv(d(' 30 '), 30);
  no(d(''), /from 1 to 365/); no(d('   '), /from 1 to 365/);
  no(d('0'), /shortest is 1 day/); no(d('366'), /longest is 365/); no(d('99999'), /longest/);
  no(d('-3'), /negative/); no(d('2.5'), /no decimals/); no(d('2,5'), /no decimals/); no(d('.5'), /no decimals/);
  no(d('1e2'), /digits only/); no(d('abc'), /digits only/); no(d('5😀'), /digits only/);
  no(d('', { badInput: true }), /digits only/);
  okv(d('0', { min: 0, max: 90 }), 0); no(d('91', { min: 0, max: 90 }), /longest is 90/); no(d('-1', { min: 0, max: 90 }), /negative/);
});

await t('team e-mail: your own address, an existing member and a same-role pending invite are refused; role required', () => {
  const ctx = { self: 'Me@Studio.com', members: ['team@studio.com', null], pending: [{ email: 'p@x.com', role: 'crew' }] };
  no(C.teamEmail('', ctx), /their e-mail/); no(C.teamEmail('  ', ctx), /their e-mail/);
  no(C.teamEmail(' ME@studio.com ', ctx), /your own e-mail/);
  no(C.teamEmail('TEAM@studio.com', ctx), /already a member/);
  no(C.teamEmail('p@x.com', Object.assign({ invite: true, role: 'crew' }, ctx)), /already pending/);
  okv(C.teamEmail('p@x.com', Object.assign({ invite: true, role: 'manager' }, ctx)), 'p@x.com');   // re-invite at a new role (server handles)
  okv(C.teamEmail('p@x.com', ctx), 'p@x.com');   // "Add user" does not look at invites
  okv(C.teamEmail(' New@Studio.com ', ctx), 'new@studio.com');
  no(C.teamEmail('new @studio.com', ctx), /spaces/);
  no(C.role('', ['crew']), /Choose a role/); no(C.role('boss', ['crew']), /from the list/); okv(C.role('crew', ['crew']), 'crew');
});

/* ---- how the pages use the rules ------------------------------------------- */
const ctl = r('public/control.html');
await t('control.html loads the shared validator + rules before the page script, and binds General fields', () => {
  const iFV = ctl.indexOf('<script src="form-validate.js?v='), iCI = ctl.indexOf('<script src="cc-inputs.js?v='), iInline = ctl.indexOf('<script>\n');
  assert.ok(iFV > 0 && iCI > iFV && iInline > iCI, 'form-validate.js, then cc-inputs.js, then the inline script');
  assert.match(ctl, /function ccGen\(\)\{ const CI=window\.HelmCCInputs; return CI&&CI\.bindGeneral\?CI\.bindGeneral\(\{country:\(\)=>BPStore\.tax\.code\(\$\("#o_country"\)\.value\)\}\):null; \}/);
  assert.match(ctl, /if\(G && window\.HelmCCInputs\.first\(\[G\.email,G\.phone,G\.logo,G\.accent,G\.currency,G\.tz,G\.tax\]\)\)\{ saveMsg\("",""\); return; \}/);   // merged with cc-general-billing: the card's message sits next to Save
  assert.match(ctl, /const gstRaw=ccv\(G&&G\.tax,"o_gst"\)/);
  assert.match(ctl, /BPStore\.tax\.validateId\(newCountry, gstRaw\)/, 'the country rule stays as the last check');
  assert.match(ctl, /\{ const G=ccGen\(\); if\(G&&G\.tax\) G\.tax\.check\(\); \}/, 'changing country re-checks the tax ID');
  assert.match(ctl, /Object\.keys\(G\)\.forEach\(k=>\{ if\(G\[k\]\) G\[k\]\.reset\(\); \}\)/, 'reloaded values start without stale errors');
  // the save handler never clears what was typed when a check fails
  const save = ctl.slice(ctl.indexOf('$("#o_save").addEventListener("click"'), ctl.indexOf('/* ---------------- CLIENT LINK AUTO-EXPIRE'));
  assert.doesNotMatch(save.split('try{ await BPStore.org.save(patch)')[0], /\.value\s*=\s*""/);
});

await t('studio link: fixed at creation (r23 / 0257) - shown read-only, no editor, no save', () => {
  assert.doesNotMatch(ctl, /id="o_slug"|o_slug_save|savedSlug/);
  assert.match(ctl, /<b id="slugUrlVal">helm\.events\/your-studio<\/b>/);
  assert.match(ctl, /id="slugLock">Set when the studio was created\. Contact Helm support to change it\.<\/p>/);
});

await t('Users & invites: forms use page messages (novalidate), one submit at a time, role checked, field reset after success', () => {
  assert.match(ctl, /<form id="um_add" class="addrow s-0dff578" novalidate>/);
  assert.match(ctl, /<form id="inv_add" class="addrow s-0dff578" novalidate>/);
  assert.match(ctl, /if\(\$\("#um_submit"\)\.disabled\) return;/); assert.match(ctl, /if\(\$\("#inv_submit"\)\.disabled\) return;/);
  assert.match(ctl, /if\(!ccRoleOk\("#um_role"\)\) return;/); assert.match(ctl, /if\(!ccRoleOk\("#inv_role"\)\) return;/);
  assert.match(ctl, /invPending=pend\.map\(i=>\(\{email:String\(i\.email\|\|""\)\.toLowerCase\(\), role:i\.role\}\)\);/);
  assert.match(ctl, /\$\("#um_email"\)\.value=""; if\(T&&T\.member\) T\.member\.reset\(\);/);
  assert.match(ctl, /\$\("#inv_email"\)\.value=""; if\(T&&T\.invite\) T\.invite\.reset\(\);/);
  for (const id of ['um_email', 'inv_email']) assert.match(ctl, new RegExp('<input id="' + id + '" type="email" maxlength="254"'));
  assert.match(ctl, /<input id="uc_q" type="search" maxlength="100"/);
});

await t('Roles & access: suggested access joins the single-toggle queue, shows labels, ignores a second click', () => {
  const fn = ctl.slice(ctl.indexOf('async function applySuggested'), ctl.indexOf('// saveCell is SERIALIZED'));
  assert.match(fn, /if\(btn\.disabled\) return;/);
  assert.match(fn, /cellQueue = cellQueue\.then\(async\(\)=>\{/);
  assert.match(fn, /lbl\(a\)\+\(e\?" \(view \+ edit\)":" \(view\)"\)/);
  assert.match(fn, /BPStore\.auth\.admin\.roleLabel\(role\)/);
  assert.match(r('test/roles-crew-defaults.test.mjs'), /Apply suggested access/);
});

await t('package lock days + privacy PIN: message under the box, no silent clamp, paste checked before the 4-digit cut', () => {
  const pk = r('public/pkg-review.js');
  assert.match(pk, /li\.setAttribute\("data-hardened", "1"\);/);
  assert.match(pk, /CI\.days\(li\.value, \{ min: 0, max: 90, badInput:/);
  assert.match(pk, /if \(save\.disabled\) return;/);
  const pp = r('public/privacy-pin-settings.js');
  assert.match(pp, /i\.addEventListener\("paste", onPaste\)/);
  assert.match(pp, /var b = \$\("pp_save"\); if \(b\.disabled\) return;/);
  assert.match(pp, /fieldErr\("pp_cur", "The current PIN is wrong\. "/);
  const g = {}; const doc = { readyState: 'complete', getElementById: () => null, addEventListener() {} };
  vm.runInNewContext(r('public/privacy-pin-settings.js'), { window: g, document: doc, setTimeout: () => 0 });
  const P = g.HelmPrivacyPinSettings;
  assert.equal(JSON.stringify(P.perField('0000', '4826', '4826')), JSON.stringify({ cur: '', next: '', again: '' }));
  assert.match(P.perField('00', '4826', '4826').cur, /current 4-digit PIN/, 'fallback without cc-inputs.js still per box');
  g.HelmCCInputs = C; assert.match(P.perField('0000', '4826', '4827').again, /don't match/);
});

/* ---- link expiry card in a stub DOM, with the rules loaded ----------------- */
await t('auto-expire days: the box opts out of the silent hardener; the exact reason replaces the example line', async () => {
  assert.match(ctl, /<input id="lx_days" type="number" min="1" max="365" step="1" inputmode="numeric" value="10" aria-describedby="lx_example" data-hardened="1">/);
  const src = ctl.slice(ctl.indexOf('/* ---------------- CLIENT LINK AUTO-EXPIRE (0039'), ctl.indexOf('  let dishCache=[];'));
  const els = {}, L = {}, calls = [];
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, attrs: {}, cls: new Set(),
    classList: { toggle(c, on) { on ? els[id].cls.add(c) : els[id].cls.delete(c); } },
    setAttribute(k, v) { this.attrs[k] = v; }, focus() {}, addEventListener(ev, fn) { (L[id + ':' + ev] = L[id + ':' + ev] || []).push(fn); } });
  const ctx = { $: (s) => el(s.replace(/^#/, '')), esc: String, numAttr: (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d), errMsg: () => 'ERR',
    setTimeout: () => 0, Date, Number, String, Object, HelmCCInputs: C,
    BPUI: { guard: async (b, fn) => fn(), confirm: async () => true, isMissingFunction: () => false, loadError() {} },
    BPStore: { links: { autoExpire: { get: async () => ({ enabled: true, days: 10, timezone: 'Asia/Kolkata' }), set: async (on, d) => { calls.push([on, d]); return { enabled: on, days: d }; } } } } };
  vm.createContext(ctx); vm.runInContext(src + '\n;this.initLinkExpiry=initLinkExpiry;', ctx);
  await ctx.initLinkExpiry();
  const fire = async (id, ev) => { for (const f of L[id + ':' + ev] || []) await f({}); };
  for (const [v, re] of [['2.5', /no decimals/], ['-3', /negative/], ['0', /shortest is 1 day/], ['400', /longest is 365/], ['', /from 1 to 365/]]) {
    el('lx_days').value = v; await fire('lx_days', 'input');
    assert.match(el('lx_example').textContent, re, v); assert.equal(el('lx_days').attrs['aria-invalid'], 'true');
    assert.ok(el('lx_days').cls.has('fv-error') && el('lx_example').cls.has('lx-bad'), v + ' styled as an error');
    await fire('lx_save', 'click'); assert.equal(calls.length, 0, v + ' reached the server');
    assert.equal(el('lx_days').value, v, 'what was typed is kept');
  }
  el('lx_days').value = '030'; await fire('lx_days', 'blur'); assert.equal(el('lx_days').value, '30');
  assert.ok(!el('lx_days').cls.has('fv-error'));
  await fire('lx_save', 'click'); assert.deepEqual(calls, [[true, 30]]);
});

console.log(`cc-inputs-sweep-a: ${n} test(s) passed.`);
