// approve-country.test.mjs - client approval page (/<studio>/quote/<token>) for UAE / USA quotes:
// the mobile country picker defaults to the quote's tax country, and the versioned terms are
// country-specific (India text pinned by hash; -AE / -US ids follow it). R108: v3-2026-10 consent clause is channel-neutral.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const html = read('public/approve.html');
const tests = []; const t = (n, f) => tests.push([n, f]);

const s = html.indexOf('  const TERMS_VERSION='), e = html.indexOf('\n  function setMsg(', s);
assert.ok(s > 0 && e > s, 'terms block found');
function page() {
  const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, helmPhone: null };
  const ctx = { $: (q) => (q === '#c_phone' ? el : null), el };
  vm.createContext(ctx);
  vm.runInContext(html.slice(s, e) + '\nthis.T={TERMS_VERSION,TERMS_HTML,termsFor,consentText,phoneCountry};', ctx);
  return ctx;
}

t('India terms text is pinned as v3-2026-10 (sha256; R108 channel-neutral consent clause; R110 no payment-link wording)', () => {
  const { T } = page();
  assert.equal(T.TERMS_VERSION, 'v3-2026-10');
  assert.equal(createHash('sha256').update(T.TERMS_HTML).digest('hex'), '0a07f5b0802eaad4006765314b68cf5a23d2461c1ea97402d44a91f1b7061c06');
  assert.equal(T.termsFor({ country: 'IN' }).html, T.TERMS_HTML);
  assert.equal(T.termsFor(null).v, 'v3-2026-10');
  assert.equal(T.termsFor({ country: 'ZZ' }).v, 'v3-2026-10');
  assert.equal(T.consentText(T.TERMS_VERSION), 'I have read and agree to the Terms & Conditions (v3-2026-10), and I authorise this event and its charges.');
});
t('UAE terms: own version id, VAT 5%, TRN, AED, Tax Invoice, no GST/SAC', () => {
  const { T } = page(); const x = T.termsFor({ country: 'AE' });
  assert.equal(x.v, 'v3-2026-10-AE');
  for (const w of ['VAT', '5%', 'TRN', 'AED', 'Tax Invoice']) assert.ok(x.html.includes(w), w);
  assert.ok(!/GST|SAC|998596|₹/.test(x.html));
});
t('USA terms: own version id, state/local sales tax, exemption certificate, no GST/SAC', () => {
  const { T } = page(); const x = T.termsFor({ country: 'US' });
  assert.equal(x.v, 'v3-2026-10-US');
  for (const w of ['sales tax', 'state and local', 'exemption certificate', 'USD']) assert.ok(x.html.includes(w), w);
  assert.ok(!/GST|SAC|998596|₹/.test(x.html));
});
t('version ids fit quote_consents.terms_version (<= 64 chars)', () => {
  const { T } = page(); for (const c of ['IN', 'AE', 'US']) assert.ok(T.termsFor({ country: c }).v.length <= 64);
});
t('consent records the exact terms id shown', () => {
  assert.match(html, /verifyConsent\(token, phone, code, true, shownTerms\.v, consentText\(shownTerms\.v\),/);
  assert.match(html, /shownTerms=termsFor\(apTax\); phoneCountry\(apTax\);\s*\$\("#terms"\)\.innerHTML=TERMS_BY_COUNTRY\[termsKey\(apTax\)\]\.html; \$\("#tver"\)\.textContent="\("\+shownTerms\.v\+"\)";/);
});
t('phone picker defaults to the quote country (AE +971, US +1, IN +91), user choice kept', () => {
  for (const [cc, dial] of [['AE', '+971'], ['US', '+1'], ['IN', '+91']]) {
    const ctx = page(); let set = null;
    ctx.el.helmPhone = { national: () => '', setCountry: (c) => { set = c; } };
    ctx.T.phoneCountry({ country: cc });
    assert.equal(ctx.el.attrs['data-country'], cc); assert.equal(set, cc);
    assert.ok(ctx.el.attrs.placeholder.startsWith(dial + ' '));
  }
  const ctx = page(); let set = null;
  ctx.el.helmPhone = { national: () => '501234567', setCountry: (c) => { set = c; } };
  ctx.T.phoneCountry({ country: 'US' }); assert.equal(set, null, 'typed number not overridden');
  const c2 = page(); c2.T.phoneCountry(null); assert.equal(c2.el.attrs['data-country'], 'IN');
});
t('phone-input honours data-country when it attaches later', () => {
  assert.match(read('public/phone-input.js'), /o\.country \|\| input\.getAttribute\("data-country"\)/);
});
t('send-otp: clear message for non-India numbers until MSG91 international is enabled', () => {
  const f = read('supabase/functions/send-otp/index.ts');
  assert.match(f, /!String\(dest\.mobile\)\.startsWith\("91"\) && Deno\.env\.get\("MSG91_INTL"\) !== "1"/);
  assert.ok(f.indexOf('MSG91_INTL') < f.indexOf('admin_store_otp", {'), 'checked before a code is stored');
});
t('0093 migration listed and APPLY-0092-0093 is ASCII with 15 verify rows', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0093_country_terms\.sql/);
  const a = read('supabase/APPLY-0092-0093.sql');
  assert.ok(/^[\x00-\x7F]*$/.test(a), 'ascii');
  assert.equal((a.match(/^\s+\('009[23] \d\d /gm) || []).length, 15);
  assert.ok(a.indexOf('_comms_country') < a.indexOf('_otp_canon_phone'), '0092 before 0093');
});

let fail = 0;
for (const [n, f] of tests) { try { f(); console.log('  ok  ' + n); } catch (err) { fail++; console.log('  FAIL ' + n + '\n       ' + err.message); } }
console.log(fail ? `approve-country: ${fail} FAILED` : `approve-country: all ${tests.length} passed`);
process.exit(fail ? 1 : 0);
