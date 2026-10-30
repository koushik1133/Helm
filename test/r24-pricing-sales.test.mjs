// r24 pricing (owner 2026-10-19): no "Pay now" anywhere for now.
//   * public pricing (home #pricing + /pricing): every plan card has ONE button "Contact sales" -> /contact-sales?plan=<key>
//     (r24 usd: the contact form; was /signup?plan=<key>&mode=sales),
//     no per-card "Try free for 8 days"; ONE centred trial block under the cards -> /signup?mode=trial
//     (home keeps the "All prices ... Compare all plans" line under it). r24 usd: every public price is USD.
//   * in-app plan cards (sign-up step 4 + /checkout): Pay now follows ONE switch, config.js HELM_FEATURES.payNow (false):
//     off = Contact sales is the primary, Try free stays; ?mode=paid reads as sales; no online payment / UPI details.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const IDX = read('public/index.html'), PR = read('public/pricing.html'), CFG = read('public/config.js');
const CO = read('public/checkout.js'), SFJ = read('public/signup-flow.js'), TS = read('public/trial-signup.js');
const PC = require('../public/plan-cards.js'), SF = require('../public/signup-flow.js');
const KEYS = ['starter', 'studio', 'enterprise'];
const section = (h, start, end) => { const i = h.indexOf(start); assert.ok(i > 0, start); return h.slice(i, h.indexOf(end, i)); };

t('config.js: ONE switch HELM_FEATURES.payNow, false for now', () => {
  assert.match(CFG, /window\.HELM_FEATURES = Object\.assign\(\{ payNow: false \}, window\.HELM_FEATURES\);/);
});

for (const [name, h, start, end] of [['index.html', IDX, '<section class="sec pricing" id="pricing"', '</section>'], ['pricing.html', PR, '<section class="pr-grid"', '<section class="mf-block pr-faq"']]) {
  t(name + ': three cards, each exactly ONE button "Contact sales" -> /contact-sales?plan=<key>', () => {
    const s = section(h, start, end);
    const btns = [...s.matchAll(/<div class="(?:plan|pr)-ctas">(.*?)<\/div>/g)].map((m) => m[1]);
    assert.equal(btns.length, 3);
    btns.forEach((b, i) => {
      assert.equal((b.match(/<a /g) || []).length, 1, KEYS[i] + ': one button');
      assert.ok(b.includes('href="/contact-sales?plan=' + KEYS[i] + '">Contact sales</a>'), KEYS[i]);
    });
    assert.ok(!/Pay now|mode=paid|Try free for|Talk to sales/.test(s), 'no Pay now / per-card trial / old wording');
  });
  t(name + ': one centred trial block under the cards -> /signup?mode=trial', () => {
    const s = section(h, start, end);
    const i = s.indexOf('class="' + (name === 'index.html' ? 'wrap c pr-trial rv' : 'pr-trial') + '"');
    assert.ok(i > s.lastIndexOf('-ctas"'), 'after the cards');
    const blk = s.slice(i);
    assert.match(blk, /Start your 8-day free trial — no card needed/);
    assert.equal((s.match(/href="\/signup\?mode=trial"/g) || []).length, 1, 'one trial button');
    assert.match(blk, /href="\/signup\?mode=trial">Start free trial/);
  });
}

t('index.html: the "All prices ... Compare all plans" line stays, under the trial block; prices untouched', () => {
  const s = section(IDX, '<section class="sec pricing" id="pricing"', '</section>');
  const tr = s.indexOf('pr-trial'), note = s.indexOf('<p class="wrap c note-s rv">All prices in USD, proposed and not final. Studios in India are billed in &#8377; incl. GST. <a class="link-d" href="/pricing">Compare all plans');   // r25: + the India line
  assert.ok(tr > 0 && note > tr);
  for (const p of ['<span>$24</span>', '<span>$59</span>', '<p class="price">Custom</p>', 'Plans from <em>$24 a month.</em>']) assert.ok(s.includes(p), p);
  assert.match(s, /<a class="btn btn-dark" href="\/signup\?mode=trial">Start free trial <span class="bi">/, 'primary button');
});

t('pricing.html: r24 usd - prices in USD (no rupee left); trial button is the primary style', () => {
  for (const p of ['<b>$24</b>', '<b>$59</b>', 'or $240/year proposed (2 months free)', 'or $590/year proposed (2 months free)', '<b>Custom</b> <span>talk to us</span>']) assert.ok(PR.includes(p), p);
  assert.ok(!/(&#8377;|₹)\s*\d|INR/.test(PR), 'no rupee prices on /pricing');   // r25: only the line "Studios in India are billed in ₹ incl. GST."
  assert.ok(PR.includes('<p class="pr-note" role="note"><b>Proposal:</b> these prices are suggestions for review and are not final.'), 'proposal banner kept');
  for (const [h, f] of [[IDX, 'index.html'], [PR, 'pricing.html']]) {
    assert.ok(h.includes('"name": "Starter", "price": "24", "priceCurrency": "USD"'), f + ' JSON-LD Starter');
    assert.ok(h.includes('"name": "Studio", "price": "59", "priceCurrency": "USD"'), f + ' JSON-LD Studio');
    assert.ok(!/priceCurrency": "INR/.test(h), f + ' no INR offer');
  }
  assert.match(PR, /<h2 class="pr-trial-h" id="prTrialH">Start your 8-day free trial — no card needed<\/h2>/);
  assert.match(PR, /<a class="btn primary hs-pop pr-trial-btn" href="\/signup\?mode=trial">Start free trial<\/a>/);
});

t('CSS: trial block centred, full-width button on phones', () => {
  const H = read('public/home.css'), M = read('public/marketing-pricing.css');
  assert.match(H, /\.pr-trial\{margin-top:44px;display:flex;flex-direction:column;align-items:center;gap:16px;text-align:center\}/);
  assert.match(H, /@media \(max-width:600px\)\{\.pr-trial \.btn\{width:100%;max-width:420px;/);
  assert.match(M, /\.pr-trial \{ [^}]*align-items: center;[^}]*text-align: center; \}/);
  assert.match(M, /@media \(max-width: 600px\) \{ \.pr-trial-btn \{ width: 100%; max-width: 420px; \} \}/);
});

t('plan cards: switch off (default) = Contact sales primary + Try free; on = Pay now as before', () => {
  const studio = PC.plansOr([])[1], ent = PC.plansOr([])[2];
  assert.equal(PC.payNowOn(), false, 'no config = off');
  assert.equal(PC.payNowOn({ payNow: false }), false); assert.equal(PC.payNowOn({ payNow: true }), true); assert.equal(PC.payNowOn({ payNow: 'yes' }), false);
  assert.deepEqual(PC.actionsFor(studio, { interval: 'monthly', trial: true }), { pay: false, trial: true, sales: true, primary: 'sales' });
  assert.deepEqual(PC.actionsFor(studio, { interval: 'monthly', trial: true, sales: false }), { pay: false, trial: true, sales: true, primary: 'sales' }, 'never a card with no button');
  assert.deepEqual(PC.actionsFor(studio, { interval: 'monthly', trial: true, payNow: true }), { pay: true, trial: true, sales: true, primary: 'pay' });
  assert.deepEqual(PC.actionsFor(ent, { interval: 'monthly', payNow: true }), { pay: false, trial: false, sales: true, primary: 'sales' });
  globalThis.HELM_FEATURES = { payNow: true };
  try { assert.equal(PC.actionsFor(studio, { interval: 'monthly' }).pay, true, 'reads the config switch'); } finally { delete globalThis.HELM_FEATURES; }
});

t('sign-up: ?mode=paid reads as sales while Pay now is off; trial / sales unchanged', () => {
  assert.equal(SF.payGate('paid', false), 'sales'); assert.equal(SF.payGate('paid', true), 'paid');
  assert.equal(SF.payGate('trial', false), 'trial'); assert.equal(SF.payGate('sales', false), 'sales'); assert.equal(SF.payGate('x', false), '');
  assert.equal(SF.payOn(), false);
  assert.match(SFJ, /function wantMode\(\) \{ return payGate\(intent\.mode \|\| mode\(metaOf\(\)\.helm_signup_mode\), payOn\(\)\); \}/);
  assert.match(SFJ, /if \(kind === "pay" && !payOn\(\)\) kind = "sales";/, 'never the payment path');
  assert.match(SFJ, /: "Contact sales and our team sets up your plan with you - no studio is opened and nothing is charged until you agree a plan\. Or start your one free " \+ days \+ "-day trial below\.";/);
  assert.match(SFJ, /if \(note\) note\.textContent = currencyNote\(st\.currency, pay\);/);   // r25: per currency; with Pay now off no UPI wording
  assert.doesNotMatch(SF.currencyNote('INR', false), /UPI|Pay now/); assert.doesNotMatch(SF.currencyNote('USD', false), /UPI|Pay now|GST/);
  assert.match(read('public/login.html'), /<p class="helper st-note" id="stNote">/);
  assert.match(SF.startError({ hint: 'trial_used' }).text, /Choose Contact sales on a plan/);
  assert.match(TS, /\(payNow \? "pay now" : "contact sales"\)/);
});

t('checkout: Pay now off = Contact sales button, no online payment, no UPI / bank details', () => {
  assert.match(CO, /function payOn\(\) \{ return !!\(window\.HelmPlanCards \? window\.HelmPlanCards\.payNowOn\(\)/);
  assert.match(CO, /st\.live = S\.checkout\.payLive\(st\.opts\) && payOn\(\);/);
  assert.match(CO, /if \(!payOn\(\)\) \{ cardSales\(p\); return; \}/);
  assert.match(CO, /b\.textContent = !payOn\(\) \|\| onRequest/);
  assert.match(CO, /if \(st\.sales && payOn\(\)\) renderPayDetails\(\);/);
  assert.match(CO, /if \(st\.pending && !payOn\(\)\) \$\("#coPendingNote"\)\.textContent = "Your studio is waiting for its plan\. Choose Contact sales/);
  for (const f of ['public/checkout.html', 'public/login.html']) {
    const h = read(f);
    assert.ok(h.indexOf('config.js?v=') > 0 && h.indexOf('config.js?v=') < h.indexOf('plan-cards.js?v='), f + ': config before plan cards');
  }
});

console.log(`r24-pricing-sales: ${n} passed`);
