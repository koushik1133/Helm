// r25 currency (owner 2026-10-20: "public site prices in USD - do what top companies do"):
//   * ONE list currency in public (USD) + a note "Prices in USD. Studios in India are billed in ₹ incl. GST."
//   * each studio has ONE fixed billing currency (India -> INR with GST, elsewhere -> USD), set at sign-up from the
//     browser time zone (my_billing_currency_init), shown read-only to the studio; prices are FIXED per currency (0273).
//   * plan cards (sign-up + /checkout) format per currency: en-IN for INR, en-US for USD; GST named for INR only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const PC = require('../public/plan-cards.js'), SF = require('../public/signup-flow.js');
const SQL = read('supabase/migrations/0273_billing_currency.sql'), APPLY = read('supabase/APPLY-0273.sql');
const CO = read('public/checkout.js'), SFJ = read('public/signup-flow.js'), API = read('public/store-api.js');
const AUI = read('public/auth-ui.js'), PR = read('public/pricing.html'), IDX = read('public/index.html');

t('catalogues: INR unchanged, USD = the public list prices (24 / 240, 59 / 590, Enterprise on request)', () => {
  const inr = PC.plansOr([]), usd = PC.plansOr([], 'USD');
  assert.deepEqual(inr.map((p) => [p.code, p.monthly, p.yearly]), [['starter', 1999, 19990], ['studio', 4999, 49990], ['enterprise', null, null]]);
  assert.deepEqual(usd.map((p) => [p.code, p.monthly, p.yearly]), [['starter', 24, 240], ['studio', 59, 590], ['enterprise', null, null]]);
  assert.deepEqual(usd[1].features, inr[1].features, 'same plans, only the price differs');
  assert.equal(PC.plansOr([], 'eur').length, 3, 'an unknown currency still shows plans');
  assert.equal(PC.plansOr([{ code: 'studio', name: 'Studio', monthly: 59 }], 'USD').length, 1, 'server list wins');
});

t('money: Indian style for rupees, US style for dollars, whole amounts without decimals', () => {
  assert.equal(PC.money(1999, 'INR'), '₹1,999'); assert.equal(PC.money(49990), '₹49,990', 'INR is the default');
  assert.equal(PC.money(24, 'USD'), '$24'); assert.equal(PC.money(590, 'USD'), '$590'); assert.equal(PC.money(49.17, 'USD'), '$49.17');
  assert.equal(PC.money('x', 'USD'), '');
});

t('price lines: GST only for INR; USD says "in US dollars"', () => {
  const s = PC.plansOr([])[1], u = PC.plansOr([], 'USD')[1];
  assert.deepEqual(PC.priceText(s, 'monthly', 'INR'), { main: '₹4,999', unit: '/month', sub: 'plus GST' });
  assert.equal(PC.priceText(s, 'yearly', 'INR').sub, '≈ ₹4,166 a month, plus GST');
  assert.deepEqual(PC.priceText(u, 'monthly', 'USD'), { main: '$59', unit: '/month', sub: 'In US dollars' });
  assert.equal(PC.priceText(u, 'yearly', 'USD').sub, '≈ $49.17 a month, in US dollars');
  assert.doesNotMatch(JSON.stringify(PC.priceText(u, 'yearly', 'USD')), /GST/);
  assert.equal(PC.priceText(PC.plansOr([], 'USD')[2], 'monthly', 'USD').main, 'Price on request');
});

t('visitor currency from the time zone: India -> INR, elsewhere -> USD, unknown -> INR (same as the server rule)', () => {
  assert.equal(PC.currencyFor('Asia/Kolkata'), 'INR'); assert.equal(PC.currencyFor('Asia/Calcutta'), 'INR');
  assert.equal(PC.currencyFor('America/New_York'), 'USD'); assert.equal(PC.currencyFor('Asia/Dubai'), 'USD');
  assert.equal(PC.currencyFor('America/Argentina/Buenos_Aires'), 'USD');
  assert.equal(PC.currencyFor(''), 'INR'); assert.equal(PC.currencyFor(null), 'INR'); assert.equal(PC.currencyFor('UTC'), 'INR');
  assert.equal(PC.cur('usd'), 'USD'); assert.equal(PC.cur('rupees'), 'INR');
  assert.match(SQL, /when btrim\(coalesce\(p_timezone, ''\)\) in \('Asia\/Kolkata', 'Asia\/Calcutta'\) then 'INR'/);
});

t('sign-up step: list in the server currency, note per currency, billing currency set once after the studio is made', () => {
  assert.match(SF.currencyNote('USD', false), /^Prices are in US dollars\./); assert.doesNotMatch(SF.currencyNote('USD', true), /GST|UPI/);
  assert.match(SF.currencyNote('INR', false), /^Prices are before GST\./);
  assert.match(SFJ, /B\.signup\.planOptions\(tz\)/); assert.match(SFJ, /P\.plansOr\(st\.opts\.plans, st\.currency\)/);
  assert.match(SFJ, /currency: st\.currency, interval: st\.interval/);
  assert.equal((SFJ.match(/B\.signup\.initCurrency\(st\.tz\)/g) || []).length, 2, 'after the free trial AND after Pay now / Contact sales');
  assert.match(API, /rpc\("signup_plan_options_for", \{ p_timezone:/); assert.match(API, /return rpc\("signup_plan_options", \{\}\)/, 'older server: INR list');
  assert.match(API, /rpc\("my_billing_currency_init", \{ p_timezone:/);
});

t('/checkout: the studio currency drives the catalogue, the money format and the GST wording', () => {
  assert.match(CO, /"en-IN" : "en-US"/); assert.match(CO, /P\.CATALOGS\[c\]/);
  assert.match(CO, /return c === "INR" \? "plus GST" : c === "USD" \? "in US dollars"/);
  assert.doesNotMatch(CO, /money\([^)]*"INR"\)/, 'no hard-coded rupee amount');
  assert.match(CO, /monthly: 1999, yearly: 19990/, 'INR catalogue kept');
});

t('studio settings: billing currency read-only, never sent', () => {
  assert.match(AUI, /Billing currency \(fixed - contact Helm to change\)/);
  assert.match(AUI, /if \(f\[0\] === "billing_currency"\) \{ i\.readOnly = true;/);
  assert.match(AUI, /if \(f\[0\] === "billing_currency"\) return;/);
});

t('public pricing: USD list + the India note (pricing page + home)', () => {
  assert.match(PR, /<p class="pr-cur" role="note">Prices in USD\. Studios in India are billed in &#8377; incl\. GST\.<\/p>/);
  assert.match(PR, /\$24<\/b>/); assert.match(PR, /\$59<\/b>/);
  assert.match(IDX, /All prices in USD, proposed and not final\. Studios in India are billed in &#8377; incl\. GST\./);
});

t('SQL 0273: additive, idempotent, fixed prices, fixed currency, ASCII', () => {
  assert.match(SQL, /on conflict \(plan_id, currency\) do nothing/, 'an HQ price is never overwritten');
  assert.match(SQL, /\('starter', 24::numeric, 240::numeric\), \('studio', 59::numeric, 590::numeric\)/);
  assert.match(SQL, /billing_currency_set_at/); assert.match(SQL, /a\.billing_currency is null/);
  assert.match(SQL, /create trigger r25_billing_currency_lock before update of billing_currency on public\.studio_account/);
  assert.match(SQL, /s\.status in \('active', 'past_due'\)/);
  assert.doesNotMatch(SQL.replace(/--[^\n]*/g, ''), /\b(delete from|truncate|drop table|drop column)\b/i);
  assert.ok(/^[\x00-\x7f]*$/.test(SQL), 'ASCII only');
  assert.ok(/^[\x00-\x7f]*$/.test(APPLY), 'APPLY ASCII only');
  assert.match(APPLY, /begin;/); assert.match(APPLY, /commit;/); assert.match(APPLY, /-- VERIFY/);
  assert.ok(APPLY.includes(SQL.trim().split('\n').slice(-1)[0]), 'APPLY carries the migration');
  assert.match(read('supabase/migrations/MANIFEST'), /forward {2}supabase\/migrations\/0273_billing_currency\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/r25-currency-0273\.sql/);
});

console.log(`r25-currency: ${n} checks passed`);
