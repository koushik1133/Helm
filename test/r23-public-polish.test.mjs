// R23 public pages polish (live smoke findings):
//   1. /signup step 1 follows ?plan= & ?mode= (paid / trial / sales / neutral) + a plan chip with "change" -> /pricing
//   2. ONE header on every public page: the home page's logo + Product/Solutions/Resources/Pricing + Sign in + Start free trial
//   3. 404 on phones: 16px gutter (landing.css .bar{padding:15px 0} had wiped the .wrap padding)
//   4. "Custom" + "talk to us" read as two words on /pricing
//   5. the desktop hero film: preload="metadata" + poster, fetched only after load + idle, HQ webm <= 4 MB
import { readFileSync, statSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildHeader, applyTo, PAGES, MARK_START, MARK_END } from '../scripts/gen-site-header.mjs';
import { buildTry } from '../scripts/gen-try.mjs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const require = createRequire(import.meta.url);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const SF = require('../public/signup-flow.js');
const index = read('public/index.html');

// ---- 1. sign-up copy per ?mode= ----
t('step1Copy: paid / trial / sales / neutral', () => {
  const paid = SF.step1Copy('paid', 'Studio', 8);
  assert.equal(paid.title, 'Create your studio');
  assert.match(paid.sub, /^Studio plan, pay after setup\. Step 1 of 4/);
  const trial = SF.step1Copy('trial', 'Studio', 8);
  assert.equal(trial.title, 'Start your 8-day free trial');
  assert.match(trial.sub, /^No payment needed\./);
  assert.equal(SF.step1Copy('trial', '', 10).title, 'Start your 10-day free trial', 'days come from trial-facts');
  const sales = SF.step1Copy('sales', 'Enterprise', 8);
  assert.equal(sales.title, 'Talk to our sales team');
  assert.match(sales.sub, /Create a Helm account so our team can set up your Enterprise studio with you\./);
  assert.equal(SF.step1Copy('', 'Studio', 8).kind, 'neutral');
  assert.equal(SF.step1Copy('bogus', '', 8).kind, 'neutral');
  assert.match(SF.step1Copy('paid', '', 8).sub, /^Your plan, pay after setup\./);
});
t('planName: catalog names, unknown or unsafe codes give nothing', () => {
  assert.equal(SF.planName('studio', []), 'Studio');
  assert.equal(SF.planName('ENTERPRISE', []), 'Enterprise');
  assert.equal(SF.planName('gold', [{ code: 'gold', name: 'Gold' }]), 'Gold');
  assert.equal(SF.planName('nope', []), '');
  assert.equal(SF.planName('<script>', []), '');
});
t('login.html runs applyStep1 after the trial words; chip + sales note built with DOM APIs only', () => {
  const login = read('public/login.html'), js = read('public/signup-flow.js');
  assert.match(login, /BPTrialSignup\.apply\(m, J\(\)\);\n\s*if\(window\.BPSignupFlow && BPSignupFlow\.applyStep1\) BPSignupFlow\.applyStep1\(m, J\(\)\);/);
  assert.match(login, /\.plan-chip\{/);
  assert.match(js, /a\.href = "\/pricing"/, 'chip "change" goes back to the pricing page');
  assert.match(js, /l\.href = "\/contact-sales" \+ \(\["starter", "studio", "enterprise"\]\.indexOf\(intent\.plan\) >= 0 \? "\?plan=" \+ intent\.plan : ""\);/, 'sales: no-account route = the public /contact-sales form (r24 usd)');
  assert.match(js, /intent\.fromUrl \? payGate\(intent\.mode, payOn\(\)\) : ""/, 'a bare /signup stays neutral (r24: paid reads as sales while Pay now is off)');
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(js));
});

// ---- 2. one header ----
const PUBLIC = Object.keys(PAGES);
t('every public page carries the generated home header (node scripts/gen-site-header.mjs)', () => {
  for (const f of PUBLIC) {
    const cur = read('public/' + f);
    assert.equal(applyTo(cur, buildHeader(index, PAGES[f])), cur, f + ' header is stale - run node scripts/gen-site-header.mjs');
    assert.equal(cur.split(MARK_START).length, 2, f + ': one header block');
    assert.ok(cur.includes(MARK_END));
    assert.match(cur, /<link rel="stylesheet" href="\/site-header\.css\?v=\d+">/, f);
    assert.match(cur, /<script src="\/site-header\.js\?v=\d+" defer><\/script>/, f);
  }
});
t('header content = the home page: logo, 4 menus, Sign in, Start free trial; no old Home/About/Services bar, no "Log in"', () => {
  for (const f of [...PUBLIC, 'index.html']) {
    const h = read('public/' + f);
    const hdr = f === 'index.html' ? h.match(/<header class="nav" id="top">[\s\S]*?<\/header>/)[0] : h.slice(h.indexOf(MARK_START), h.indexOf(MARK_END));
    for (const label of ['Product', 'Solutions', 'Resources', 'Pricing']) assert.match(hdr, new RegExp('aria-expanded="false" aria-controls="[a-z-]+">' + label + '<'), f + ' ' + label);
    assert.match(hdr, /viewBox="-14 -10 1530 660"/, f + ' HELM lockup');
    assert.match(hdr, />Sign in<\/a>/, f);
    assert.match(hdr, /href="\/signup\?mode=trial">Start free trial<\/a>/, f);
    assert.ok(!/Log in/.test(h), f + ': "Log in" left');
    assert.ok(!/class="navlinks"|class="nl" href="\/">Home</.test(h), f + ': old Home/About/Services bar left');
  }
});
t('generated header: in-page links point at the home page, ids namespaced, no clash with the page', () => {
  const b = buildHeader(index, 'sticky');
  assert.ok(!/href="#(?!sh-i-)/.test(b), 'no bare #anchor links outside the home page');
  assert.match(b, /href="\/#modules"/);
  assert.match(b, /href="\/pricing" class="sh-item"/);
  assert.ok(!/class="(btn|mlink|menu|nav)\b/.test(b), 'only sh-* classes (no leak from landing.css .btn)');
  assert.match(b, /mask="url\(#sh-hlm-gap\)"/);
  for (const f of PUBLIC) {
    const h = read('public/' + f);
    for (const id of ['top', 'shMenu', 'sh-hlm-gap', 'sh-mg-product']) assert.equal((h.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, f + ' #' + id);
  }
  assert.match(read('public/site-header.css'), /header\.sh\.sh\{position:sticky/);
  assert.match(read('public/site-header.css'), /@media \(max-width:640px\)\{ \.sh-bar\{padding:0 16px/);
  assert.ok(!/innerHTML|\.style\./.test(read('public/site-header.js')));
});
t('/try: the same HELM logo, Sign in and the home trial link (the full menu stays off the full-bleed sandbox)', () => {
  const tr = buildTry(read('public/builder.html'));
  assert.match(tr, /<a class="try-logo" href="\/" aria-label="Helm home"><svg class="try-lockup hl-logo" viewBox="-14 -10 1530 660"/);
  assert.match(tr, /mask="url\(#try-hlm-gap\)"/);
  assert.match(tr, /<a class="try-signin" href="\/login">Sign in<\/a>/);
  assert.match(tr, /<a class="try-cta" href="\/signup\?mode=trial">/);
  assert.equal(read('public/try.html'), tr, 'public/try.html is stale - run node scripts/gen-try.mjs');
});

// ---- 3. 404 gutter ----
t('404: the header keeps a 16px gutter on phones', () => {
  assert.match(read('public/404.html'), /header \.wrap\.bar\{padding-left:16px;padding-right:16px\}/);
});

// ---- 4. Custom + talk to us ----
t('/pricing: "Custom" and "talk to us" are two words', () => {
  const p = read('public/pricing.html');
  assert.match(p, /<b>Custom<\/b> <span>talk to us<\/span>/);
  assert.ok(!/Custom<\/b><span>/.test(p));
});

// ---- 5. hero film ----
t('home hero film: preload=metadata + poster, fetched after load + idle, HQ webm <= 4 MB', () => {
  assert.match(index, /<video class="hero-video" id="heroVideo" muted loop playsinline preload="metadata" poster="\/home-assets\/hero-poster\.webp"/);   // r26: webp poster
  const js = read('public/home.js');
  assert.match(js, /function afterLoadIdle\(fn\) \{[\s\S]{0,260}window\.addEventListener\('load', idle, \{ once: true \}\)/);
  assert.match(js, /afterLoadIdle\(heroGo\);/);
  assert.match(js, /if \(!heroUserPaused && heroReady\) \{ loadV\(heroVideo\); tryPlay\(heroVideo\); \}/);
  assert.match(js, /function heroGo\(\) \{\s*heroReady = true;\s*if \(!smallScreen\) loadV\(heroVideo\);/, 'desktop buffers only from heroGo (after load + idle)');
  const block = js.slice(js.indexOf('heroVideo.muted = true;'), js.indexOf('afterLoadIdle(heroGo);'));
  assert.ok(block.length > 0 && !/loadV\(heroVideo\)/.test(block), 'no eager fetch before load + idle');
  const size = statSync(new URL('public/home-assets/hero-hq.webm', root)).size;
  assert.ok(size <= 4 * 1024 * 1024, 'hero-hq.webm is ' + size + ' bytes');
});

// ---- 6. /try: no "Amounts hidden" privacy chip (the sandbox shows no amounts) ----
t('/try hides the shell privacy chip (.hbp-hint); try.html loads try.css with a bumped version', () => {
  assert.match(read('public/try.css'), /html\.helm-sandbox \.hbp-hint\{display:none!important\}/);
  assert.match(read('public/try.html'), /<link rel="stylesheet" href="\/try\.css\?v=9">/);
});

console.log('\nr23-public-polish: ' + n + ' passed');
