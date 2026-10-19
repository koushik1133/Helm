// r22 pricing CTAs: the public pricing page and the landing page send people into the new /signup flow.
//   * every paid plan card: primary "Pay now" -> /signup?plan=<key>&mode=paid, secondary "Try free for 8 days"
//     -> /signup?plan=<key>&mode=trial; Enterprise "Talk to sales" -> /signup?plan=enterprise&mode=sales
//   * header "Start free trial" -> /signup?mode=trial, "Sign in" -> /login
//   * plan keys are the ones checkout.js already knows (starter / studio / enterprise) - no new plans, no new prices
//   * no old trial link (/login?trial=1#signup) and no mailto/#contact sales button left on these two pages
//   * the home contact form stays; a "Talk to sales" link to the same sales URL sits beside it
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const PR = read('public/pricing.html'), IDX = read('public/index.html'), CHK = read('public/checkout.js');
const HCSS = read('public/home.css'), PCSS = read('public/marketing-pricing.css');
const KEYS = ['starter', 'studio'];
const hrefs = (h) => [...h.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const SALES = '/signup?plan=enterprise&mode=sales';

t('plan keys used on the pages are the checkout catalog keys', () => {
  for (const k of [...KEYS, 'enterprise']) assert.match(CHK, new RegExp('code: "' + k + '"'), k);
  for (const h of [PR, IDX]) for (const u of hrefs(h).filter((x) => x.startsWith('/signup?plan='))) {
    const k = new URLSearchParams(u.split('?')[1]).get('plan');
    assert.ok(['starter', 'studio', 'enterprise'].includes(k), u);
  }
});

for (const [name, h] of [['pricing.html', PR], ['index.html', IDX]]) {
  t(name + ': each paid plan has Pay now (primary, first) then Try free for 8 days', () => {
    for (const k of KEYS) {
      const pay = h.indexOf('href="/signup?plan=' + k + '&amp;mode=paid">Pay now');
      const trial = h.indexOf('href="/signup?plan=' + k + '&amp;mode=trial">Try free for 8 days</a>');
      assert.ok(pay > 0, k + ' pay now'); assert.ok(trial > pay, k + ' trial after pay now');
    }
  });
  t(name + ': Enterprise Talk to sales goes to the sales signup URL (no mailto / #contact)', () => {
    assert.ok(h.includes('href="/signup?plan=enterprise&amp;mode=sales">Talk to sales'));
    assert.ok(!/href="\/?#contact">Talk to sales/.test(h));
  });
  t(name + ': header Start free trial -> /signup?mode=trial and Sign in -> /login; no old trial links', () => {
    assert.ok(!h.includes('trial=1#signup'), 'old login?trial=1#signup link left');
    assert.ok(h.includes('href="/signup?mode=trial">Start free trial</a>'));
    assert.match(h, /href="\/login">Sign in<\/a>/);
    assert.ok(!/href="login"/.test(h), 'relative login link');
  });
}

t('pricing.html: primary class only on Pay now; three cards keep their prices', () => {
  assert.match(PR, /<a class="btn primary hs-pop pr-btn" href="\/signup\?plan=starter&amp;mode=paid">Pay now<\/a><a class="btn pr-btn pr-btn2" href="\/signup\?plan=starter&amp;mode=trial">/);
  assert.match(PR, /<a class="btn primary hs-pop pr-btn" href="\/signup\?plan=studio&amp;mode=paid">Pay now<\/a><a class="btn pr-btn pr-btn2" href="\/signup\?plan=studio&amp;mode=trial">/);
  for (const p of ['&#8377;1,999', '&#8377;4,999', '&#8377;19,990', '&#8377;49,990', '<b>Custom</b>']) assert.ok(PR.includes(p), p);
  assert.match(PCSS, /\.pr-ctas \{ display: grid; gap: 8px; \}/);
});

t('index.html: plan buttons stack full width (fits 375px); hot card secondary readable on dark', () => {
  assert.equal((IDX.match(/<div class="plan-ctas">/g) || []).length, 3);
  assert.match(HCSS, /\.plan-ctas\{margin-top:auto;display:grid;gap:10px\}\.plan \.plan-ctas \.btn\{margin-top:0;align-self:stretch;width:100%\}/);
  assert.match(HCSS, /\.plan\.hot \.btn-line\{border-color:rgba\(255,255,255,\.4\);background:transparent;color:#fff\}/);
  for (const p of ['<span>$24</span>', '<span>$59</span>']) assert.ok(IDX.includes(p), p);
});

t('index.html: contact form kept as is, plus a Talk to sales link to the same sales URL', () => {
  assert.match(IDX, /<form class="ct-form rv" id="ctForm" novalidate>/);
  assert.match(IDX, /Write to sales <span class="bi">/);
  const i = IDX.indexOf('<section class="sec contact"'), j = IDX.indexOf('</section>', i);
  const ct = IDX.slice(i, j);
  assert.ok(ct.includes('<p class="ct-sales rv"><a class="btn btn-dark" href="' + SALES.replace(/&/g, '&amp;') + '">Talk to sales'));
  assert.ok(ct.includes('href="mailto:sales@helm.events"'), 'sales e-mail still listed');
});

t('index.html: every trial CTA (hero, menu, sticky phone bar, final) uses /signup?mode=trial', () => {
  const trial = hrefs(IDX).filter((u) => u === '/signup?mode=trial').length;
  assert.ok(trial >= 13, 'trial CTAs: ' + trial);   // 15 old trial links, 2 became plan-card Try free links
  assert.match(IDX, /<div class="mcta" id="mcta"[^>]*><a class="btn btn-dark" href="\/signup\?mode=trial">Start free trial/);
  assert.match(IDX, /<div class="m-cta"><a class="btn btn-line" href="\/login">Sign in<\/a><a class="btn btn-dark" href="\/signup\?mode=trial">/);
});

console.log(`r22-pricing-ctas: ${n} passed`);
