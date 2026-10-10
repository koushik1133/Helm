// country-templates.test.mjs - 0092: every client / staff message template is right for
// India, UAE and USA studios (money in the quote's own currency, tax wording, phone E.164,
// date order, no rupee / GST / UPI leakage outside India). India output stays byte-identical.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const H = require('../public/country-profile.js');
const store = read('public/store-api.js');

// ---- client side: BPStore money / tax / wa.me number helpers, run for real ----------------
function storeFor(studioCountry) {
  const ti = store.indexOf('BPStore.tax = (function () {'), te = store.indexOf('})();', ti) + 5;
  const pick = (name) => { const s = store.indexOf('BPStore.' + name + ' = function'); assert.ok(s > 0, name); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); };
  const ctx = { BPStore: { countries: () => [] }, window: { HelmCountry: H }, HelmCountry: H };
  ctx.globalThis = ctx; vm.createContext(ctx);
  vm.runInContext(store.slice(ti, te) + ['quoteTaxCfg', 'quoteTax', 'quoteMoney', 'studioMoney', 'waNumber'].map(pick).join('\n'), ctx);
  ctx.BPStore.studioTax = () => ctx.BPStore.tax.resolve({ taxCountry: studioCountry });
  return ctx.BPStore;
}
// memberPhoneE164 (staff / crew numbers) for a studio country
function memberPhone(studioCountry) {
  const B = storeFor(studioCountry);
  const s = store.indexOf('  function memberPhoneE164('), e = store.indexOf('\n  }\n', s) + 4;
  const ctx = { BPStore: B }; vm.createContext(ctx);
  vm.runInContext(store.slice(s, e) + '\nthis.f = memberPhoneE164;', ctx);
  return ctx.f;
}
// activityText (event activity trail) money
function activityMoney() {
  const s = store.indexOf('  function activityText('), body = store.slice(s, store.indexOf('if (a.kind === "payment")', s));
  return /const money = \(n\) => B && ctx\.quote && B\.quoteMoney \? B\.quoteMoney\(Number\(n\), ctx\.quote\) : B && B\.studioMoney \? B\.studioMoney\(Number\(n\)\)/.test(body);
}

// ---- edge functions: strip the few TS annotations and run the real code -------------------
function stripTs(src) {
  return src.replace(/^import .*$/gm, '').replace(/^(export )?type .*$/gm, '').replace(/^export /gm, '')
    .replace(/:\s*(unknown|string|number|boolean|P|Msg \| null|QLike \| null \| undefined|Record<string, string>)(?=\s*[,)=;{])/g, '')
    .replace(/\]!\)/g, '])');
}
const moneyTs = read('supabase/functions/_shared/money.ts');
const tplTs = read('supabase/functions/pkg-client-notify/templates.ts');
const corsTs = read('supabase/functions/_shared/cors.ts');
const edge = (() => {
  const ctx = {}; vm.createContext(ctx);
  const np = corsTs.slice(corsTs.indexOf('export function normPhone('), corsTs.indexOf('export const UUID_RE'));
  vm.runInContext(stripTs(moneyTs) + '\n' + stripTs(tplTs) + '\n' + stripTs(np) +
    '\nthis.E = { codeMoney, symMoney, quoteCur, razorpaySupports, dialFor, render, normPhone };', ctx);
  return ctx.E;
})();

const COUNTRIES = {
  IN: { cur: 'INR', tax: 'GST', dial: '91', local: '9876543210', localZero: '09876543210', e164: '919876543210' },
  AE: { cur: 'AED', tax: 'VAT', dial: '971', local: '501234567', localZero: '0501234567', e164: '971501234567' },
  US: { cur: 'USD', tax: 'Sales tax', dial: '1', local: '4155551234', localZero: null, e164: '14155551234' },
};
const quoteOf = (cc, extra) => ({ pricing: Object.assign({ taxCountry: cc, currency: COUNTRIES[cc].cur, total: 125000 }, extra || {}) });
const noIndia = (s, tag) => { for (const bad of ['₹', 'Rs.', 'INR', 'GST', 'UPI', 'Rupees', 'Lakh', '+91']) assert.ok(!String(s).includes(bad), `${tag}: leaked "${bad}" in ${s}`); };

t('quoteMoney: IN unchanged (₹1,25,000), AE AED, US $', () => {
  const B = storeFor('IN');
  assert.equal(B.quoteMoney(125000, quoteOf('IN')), '₹1,25,000');
  assert.equal(B.quoteMoney(125000, {}), '₹1,25,000', 'pre-0089 quote = India');
  const ae = B.quoteMoney(125000, quoteOf('AE')); assert.match(ae, /AED/); assert.match(ae, /125,000/); noIndia(ae, 'AE money');
  const us = B.quoteMoney(125000, quoteOf('US')); assert.match(us, /^\$125,000/); noIndia(us, 'US money');
});
t('quote tax wording: GST / VAT / Sales tax (+ state) / exempt', () => {
  const B = storeFor('IN');
  assert.equal(B.quoteTax(quoteOf('IN')).name, 'GST');
  assert.equal(B.quoteTax(quoteOf('AE')).name, 'VAT');
  const us = B.quoteTax(quoteOf('US', { taxRegion: 'CA' })); assert.equal(us.name, 'Sales tax'); assert.equal(us.country, 'US');
  const ex = B.quoteTax(quoteOf('AE', { taxExempt: true, gstPct: 5 })); assert.equal(ex.currency, 'AED'); assert.equal(ex.rate, 0, 'exempt prices at 0%');
});
t('studioMoney follows the studio country', () => {
  assert.equal(storeFor('IN').studioMoney(1200), '₹1,200');
  noIndia(storeFor('AE').studioMoney(1200), 'AE studio'); assert.match(storeFor('AE').studioMoney(1200), /AED/);
  assert.match(storeFor('US').studioMoney(1200), /^\$1,200/);
});
t('wa.me numbers: full E.164 digits for +91 / +971 / +1, codes kept, never prepends 91 abroad', () => {
  for (const cc of Object.keys(COUNTRIES)) {
    const c = COUNTRIES[cc], B = storeFor(cc);
    assert.equal(B.waNumber(c.local), c.e164, cc + ' local');
    if (c.localZero) assert.equal(B.waNumber(c.localZero), c.e164, cc + ' 0-prefixed');
    assert.equal(B.waNumber('+' + c.e164), c.e164, cc + ' +code');
    assert.equal(B.waNumber('00' + c.e164), c.e164, cc + ' 00code');
    assert.equal(B.waNumber('+91 98765 43210'), '919876543210', cc + ' foreign number kept');
    assert.equal(B.waNumber(''), ''); assert.equal(B.waNumber('abc'), '');
  }
  assert.ok(!storeFor('AE').waNumber('0501234567').startsWith('91'));
  assert.ok(!storeFor('US').waNumber('4155551234').startsWith('91'));
});
t('staff / crew phone (memberPhoneE164): +91 India unchanged, +971 / +1 abroad', () => {
  assert.equal(memberPhone('IN')('9876543210').value, '+919876543210');
  assert.equal(memberPhone('AE')('0501234567').value, '+971501234567');
  assert.equal(memberPhone('US')('(415) 555-1234').value, '+14155551234');
  assert.equal(memberPhone('US')('+971501234567').value, '+971501234567');
});
t('activity trail money uses the quote / studio currency', () => {
  assert.ok(activityMoney());
  assert.ok(!/"₹" \+ c\.per_person/.test(store), 'pkg.adjust no hardcoded ₹');
});

t('flow "send for approval": WhatsApp link uses waNumber, wording neutral', () => {
  const f = read('public/flow.html');
  assert.match(f, /const phone=BPStore\.waNumber\(ev\.client&&ev\.client\.phone\);/);
  assert.ok(!/ev\.client&&ev\.client\.phone\|\|""\)\.replace\(\/\[\^0-9\]\/g,""\)/.test(f), 'no raw digit strip');
  assert.match(f, /here's your event proposal & quote/);
  assert.match(f, /activityText\(a,\{clientName:ev&&ev\.client&&ev\.client\.name,quote:ev\}\)/);
});
t('nurture greeting: WhatsApp link uses waNumber, greeting neutral', () => {
  const n = read('public/nurture.html');
  assert.match(n, /const wa=BPStore\.waNumber\(d&&d\.phone\)/); assert.match(n, /wa\.me\/\$\{esc\(wa\)\}/);
  assert.ok(!/Diwali|Eid|Thanksgiving/.test(n.slice(n.indexOf('function waLink'), n.indexOf('function waLink') + 600)));
});
t('approve page: no Razorpay pay button for AED / USD quotes; ₹ only for India', () => {
  const a = read('public/approve.html');
  assert.match(a, /if\(apTax && apTax\.country!=="IN"\)\{ \$\("#payBtn"\)\.hidden=true;/);
  assert.match(a, /bank transfer or card payment details/);
  assert.match(a, /\(apTax && apTax\.country!=="IN"\) \? BPStore\.tax\.money/);
});
t('booklet: "Rupees ... only" only for INR; share dates follow the studio order', () => {
  assert.match(read('public/booklet.js'), /FMT\.currency === "INR" && global\.BPStore && global\.BPStore\.amountInWords/);
  for (const f of ['public/booklet-share.js', 'public/share-checklist.js']) {
    const s = read(f); assert.match(s, /toLocaleDateString\(dateLocale\(\)/, f); assert.match(s, /country === "US" \? "en-US" : "en-IN"/, f);
  }
  assert.equal(new Date('2026-10-12T00:00:00Z').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }), 'Oct 12, 2026');
});

t('edge: pkg-client-notify e-mails per country (INR byte-identical)', () => {
  const link = '/approve?token=11111111-2222-3333-4444-555555555555';
  for (const cc of Object.keys(COUNTRIES)) {
    const m = edge.render('pkg_accepted', { studio: 'S', client_name: 'Ana Lee', title: 'Gala', approve_url: link, total: 125000, paid: 25000, balance: 100000, currency: COUNTRIES[cc].cur });
    assert.ok(m && m.text.includes('New total: ' + COUNTRIES[cc].cur + ' '), cc);
    if (cc === 'IN') assert.ok(m.text.includes('New total: INR 1,25,000') && m.text.includes('Balance: INR 1,00,000'));
    else { assert.ok(m.text.includes('125,000')); noIndia(m.text, cc + ' pkg_accepted'); noIndia(m.html, cc + ' pkg_accepted html'); }
    const pay = edge.render('pkg_payment', { amount: 5000, currency: COUNTRIES[cc].cur, code: 'E-1' });
    if (cc !== 'IN') noIndia(pay.text, cc + ' pkg_payment');
    for (const k of ['pkg_declined', 'pkg_otp', 'pkg_selected']) {
      const x = edge.render(k, { studio: 'S', client_name: 'Ana', title: 'Gala', otp: '123456', reason: 'full', package: 'Gold', guests: 100, code: 'E-1' });
      assert.ok(x); noIndia(x.text, cc + ' ' + k); noIndia(x.html, cc + ' ' + k);
    }
  }
  assert.equal(edge.codeMoney('x', 'INR'), ''); assert.equal(edge.codeMoney(5, 'bogus'), 'INR 5');
});
t('edge: payment receipt e-mail uses the quote currency (₹ only for INR)', () => {
  assert.equal(edge.symMoney(125000, 'INR'), '₹1,25,000');
  assert.equal(edge.symMoney(125000, 'AED'), 'AED 125,000');
  assert.equal(edge.symMoney(1234.5, 'USD'), '$1,234.50');
  assert.equal(edge.quoteCur({ currency: 'AED' }), 'AED'); assert.equal(edge.quoteCur({ tax_snapshot: { currency: 'USD' } }), 'USD'); assert.equal(edge.quoteCur({}), 'INR');
  const w = read('supabase/functions/razorpay-webhook/index.ts');
  assert.ok(!w.includes('"₹" + Number(q.pricing'), 'no hardcoded ₹ in the receipt');
  assert.match(w, /symMoney\(q\.pricing\?\.total \|\| 0, quoteCur\(q\)\)/); assert.match(w, /org_id, currency, tax_snapshot"\)/);
});
t('edge: Razorpay payment links INR only; AED / USD refused before reserving', () => {
  assert.equal(edge.razorpaySupports('INR'), true); assert.equal(edge.razorpaySupports('AED'), false); assert.equal(edge.razorpaySupports('USD'), false);
  const c = read('supabase/functions/create-payment-link/index.ts');
  assert.ok(c.indexOf('razorpaySupports(quoteCur(qc))') > 0 && c.indexOf('razorpaySupports(quoteCur(qc))') < c.indexOf('rpc("payment_link_begin"'), 'gate before payment_link_begin');
  assert.match(c, /code: "currency_unsupported"/); assert.match(c, /normPhone\(cl\.phone, dial\)/);
});
t('edge: normPhone - India unchanged, studio dial code abroad', () => {
  assert.equal(edge.normPhone('9876543210'), '919876543210'); assert.equal(edge.normPhone('09876543210'), '919876543210');
  assert.equal(edge.normPhone('0091 98765 43210'), '919876543210');
  for (const cc of ['AE', 'US']) {
    const c = COUNTRIES[cc], d = edge.dialFor(cc);
    assert.equal(d, c.dial); assert.equal(edge.normPhone(c.local, d), c.e164); assert.equal(edge.normPhone('+' + c.e164, d), c.e164);
    assert.equal(edge.normPhone('+919876543210', d), '919876543210');
  }
  assert.equal(edge.normPhone('0501234567', '971'), '971501234567');
});

t('DB 0092: reminders / follow-ups use quote currency, studio dial code, US date order', () => {
  const m = read('supabase/migrations/0092_country_templates.sql');
  assert.match(m, /public\._comms_money\(m\.amount, public\._comms_quote_cur\(q\.id\)\)/);
  assert.match(m, /public\._comms_date\(m\.due_date, q\.org_id\)/);
  assert.match(m, /to_char\(p, 'Mon FMDD, YYYY'\)/); assert.match(m, /to_char\(p, 'DD Mon YYYY'\)/);
  for (const s of ['_comms_client_to(q.client, ch, q.org_id)', '_comms_client_to(f.client, v_ch, o.id)', '_comms_client_to(q.client, c, v_org)', '_comms_client_to(v_client, r.channel, r.org_id)'])
    assert.ok(m.includes(s), s);
  assert.match(m, /when coalesce\(p_dial, '91'\) = '91' then public\.helm_norm_phone\(d\)/, 'India phone path unchanged');
  assert.match(m, /coalesce\(upper\(p_cur\), 'INR'\) = 'INR' .* then public\._comms_money\(p\)/, 'INR money unchanged');
  assert.ok(!/update public\.|insert into public\.(?!comms_outbox)|delete from/i.test(m.replace(/insert into public\.(comms_outbox|audit_log)/g, '').replace(/update public\.comms_outbox/g, '')), 'functions only, no data rewrite');
  const a = read('supabase/APPLY-0092.sql');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(a), 'APPLY is ASCII'); assert.match(a, /select item, ok from \(values/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0092_country_templates\.sql/);
  // the default reminder / follow-up wording is country neutral
  const d = read('supabase/migrations/0078_comms_automation.sql');
  const pay = /'Hi \{client\}, a gentle reminder[^']*'/.exec(d)[0], fu = /'Hi \{client\}, this is \{studio\}[^']*'/.exec(d)[0];
  noIndia(pay, 'pay template'); noIndia(fu, 'fu template');
});

let failed = 0;
for (const [n, f] of tests) { try { await f(); console.log('  ok  ' + n); } catch (e) { failed++; console.log('  FAIL ' + n + '\n       ' + (e && e.message)); } }
console.log(failed ? `COUNTRY-TEMPLATES: ${failed} FAILED of ${tests.length}` : `COUNTRY-TEMPLATES: ALL PASS (${tests.length}/${tests.length})`);
if (failed) process.exit(1);
