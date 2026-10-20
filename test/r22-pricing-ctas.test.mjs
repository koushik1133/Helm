// r22 pricing CTAs: the public pricing page and the landing page send people into the new /signup flow.
//   * r24 (owner): every plan card has ONE button "Contact sales" -> /signup?plan=<key>&mode=sales (no Pay now, no
//     per-card Try free); one "Start free trial" block under the cards -> /signup?mode=trial (test/r24-pricing-sales)
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
  t(name + ': r24 - each plan card has Contact sales only (no Pay now, no per-card trial)', () => {
    for (const k of [...KEYS, 'enterprise']) assert.ok(h.includes('href="/signup?plan=' + k + '&amp;mode=sales">Contact sales</a>'), k);
    assert.ok(!/mode=paid|>Pay now|Try free for 8 days/.test(h), 'no Pay now / per-card trial left');
    assert.ok(!/href="\/?#contact">(Talk to|Contact) sales/.test(h));
  });
  t(name + ': header Start free trial -> /signup?mode=trial and Sign in -> /login; no old trial links', () => {
    assert.ok(!h.includes('trial=1#signup'), 'old login?trial=1#signup link left');
    assert.ok(h.includes('href="/signup?mode=trial">Start free trial</a>'));
    assert.match(h, /href="\/login">Sign in<\/a>/);
    assert.ok(!/href="login"/.test(h), 'relative login link');
  });
}

t('pricing.html: cards keep their prices; the only primary button under the cards is Start free trial', () => {
  for (const k of [...KEYS, 'enterprise']) assert.ok(PR.includes('<div class="pr-ctas"><a class="btn pr-btn" href="/signup?plan=' + k + '&amp;mode=sales">Contact sales</a></div>'), k);
  assert.ok(PR.includes('<a class="btn primary hs-pop pr-trial-btn" href="/signup?mode=trial">Start free trial</a>'));
  for (const p of ['&#8377;1,999', '&#8377;4,999', '&#8377;19,990', '&#8377;49,990', '<b>Custom</b>']) assert.ok(PR.includes(p), p);
  assert.match(PCSS, /\.pr-ctas \{ display: grid; gap: 8px; \}/);
});

t('index.html: plan button full width (fits 375px); hot card Contact sales readable on dark', () => {
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
  assert.ok(trial >= 14, 'trial CTAs: ' + trial);   // r24: the plan-card Try free links became ONE trial block button
  assert.match(IDX, /<div class="mcta" id="mcta"[^>]*><a class="btn btn-dark" href="\/signup\?mode=trial">Start free trial/);
  assert.match(IDX, /<div class="m-cta"><a class="btn btn-line" href="\/login">Sign in<\/a><a class="btn btn-dark" href="\/signup\?mode=trial">/);
});

console.log(`r22-pricing-ctas: ${n} passed`);
