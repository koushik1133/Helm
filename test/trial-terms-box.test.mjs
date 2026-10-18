// Trial terms box: "What's in your free trial" on the trial sign-up screen + the Terms "Free trial" section.
//  * trial-signup.js lists the trial policy in plain words (docs/trial/POST-TRIAL-POLICY.md + TRIAL-END-TO-END.md)
//  * shown only on the trial sign-up (not sign-in, not the paid "Create studio" path, not invitees)
//  * consent follows the page's existing "By continuing you agree to ..." line
//  * no "demo data or own data" choice is left anywhere (sign-up, dashboard card, checkout, landing)
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const TS = read('public/trial-signup.js'), TD = read('public/trial-demo.js'), LOGIN = read('public/login.html');
const TERMS = read('public/terms.html'), INDEX = read('public/index.html'), CHK = read('public/checkout.html');
const m = require('../public/trial-signup.js');
let n = 0, fail = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name); console.log(e && e.message); } };

t('panel copy: every trial rule in plain words', () => {
  assert.equal(m.TRIAL_KEY.length, 4, 'four always-visible lines');
  const all = m.TRIAL_ALL.join('\n'), key = m.TRIAL_KEY.map((k) => k.t + ' ' + k.s).join('\n');
  for (const re of [/8 days free/, /₹/, /IST/, /sample data/, /Demo/, /up to 2 teammates/, /read-only/, /60 days/]) assert.match(key, re, String(re));
  for (const re of [/8 days free\. No card/, /₹ \(INR\)/, /IST \(Asia\/Kolkata\)/, /16 leads \(clients\), 7 events with quotes, 41 client requirements, 165 inventory items, 16 vendors, 12 staff, 4 venues, 6 menu packages, 145 dishes, 3 layout templates and 3 coupons/,
    /marked “Demo”/, /up to 2 teammates/, /up to 2 new records of each kind/, /deleting a record does not free a slot/, /Menu prices are editable/,
    /no real e-mails, WhatsApp or SMS/, /Downloads.*imports and photo renders unlock on a paid plan/, /After 8 days the studio becomes read-only/,
    /kept for 60 days .*permanently deleted/, /30, 7 and 1 day before/, /One free trial per e-mail/, /Choose a plan anytime to keep everything/]) assert.match(all, re, String(re));
  assert.equal(m.DAYS, 8); assert.equal(m.KEEP_DAYS, 60);
});
t('panel: DOM only (CSP), collapsible "See all trial rules", links to /terms#trial and /privacy', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\.|setAttribute\("style"|eval\(|new Function/.test(TS));
  assert.match(TS, /el\("details", "tt-more"\)/); assert.match(TS, /el\("summary", null, "See all trial rules"\)/);
  assert.match(TS, /aLink\("\/terms#trial", "Terms"\)/); assert.match(TS, /aLink\("\/privacy", "Privacy Policy"\)/);
  assert.match(TS, /What’s in your free trial/);
});
t('panel: only on the trial sign-up; hidden on sign-in, the paid path and for invitees', () => {
  assert.match(TS, /var show = mode === "signup" && !joining && !direct && TRIAL_KEY\.length > 0;/);   // 0207: facts from trial-facts.js
  assert.match(TS, /if \(box\) box\.hidden = !show;/);
  assert.match(TS, /if \(joining\) \{ trialTerms\(mode, joining\); return; \}/);
  assert.ok(TS.indexOf('pathLink(mode);\n    trialTerms(mode, joining);') > 0, 'placed under the path link');
  // Google sign-up (no studio yet): the same panel + consent line above / below "Start free trial"
  assert.match(TS, /obForm\.insertBefore\(termsPanel\("obTrialTerms"\), obBtn\)/);
});
t('consent: follows the existing "By continuing you agree to our Terms & Privacy" line', () => {
  assert.match(LOGIN, /<div class="foot"><span id="agreeLead">By continuing you agree to our<\/span> <a class="s-a805525" href="terms">Terms<\/a> &amp; <a class="s-a805525" href="privacy">Privacy Policy<\/a>\./);
  assert.match(TS, /var AGREE_TRIAL = "By starting the free trial you agree to the trial rules above, our";/);
  assert.match(TS, /a\.textContent = on \? AGREE_TRIAL : a\.getAttribute\("data-default"\);/);
});
t('styles: own stylesheet, theme tokens, pinned on the sign-in page', () => {
  assert.ok(existsSync(new URL('../public/trial-terms.css', import.meta.url)));
  const css = read('public/trial-terms.css');
  assert.match(css, /var\(--accent-soft\)/); assert.match(css, /var\(--acc-text,var\(--accent\)\)/); assert.match(css, /\.tt\[hidden\]\{display:none\}/);
  assert.match(css, /@media\(max-width:420px\)/);
  assert.match(LOGIN, /<link rel="stylesheet" href="\/trial-terms\.css\?v=\d+">/);
  assert.match(LOGIN, /<script src="\/trial-signup\.js\?v=\d+"><\/script>/);
});
t('no "demo data or own data" choice left anywhere', () => {
  assert.ok(!/Start with my own data|How would you like to start\?|async function own\(/.test(TD), 'dashboard card: one "Load the sample data" action');
  assert.match(TD, /"Load the sample data"/);
  assert.ok(!/with your own data/.test(CHK), 'checkout trial note');
  assert.ok(!/Start with my own data|How would you like to start\?|Try with demo data/.test(TS + LOGIN + INDEX + read("public/try.html") + read("public/onboarding.html")));
});
t('terms.html: a plain-words "Free trial" section with the same rules', () => {
  const at = TERMS.indexOf('<section id="trial"'), sec = TERMS.slice(at, TERMS.indexOf('</section>', at));
  assert.ok(at > 0);
  for (const re of [/8-day free trial/, /₹, INR/, /IST/, /marked “Demo”/, /up to 2 teammates/, /up to 2 new records of each kind/, /Menu|menu prices can be edited/,
    /no real e-mails, WhatsApp or SMS/, /downloads \(PDF, CSV and prints\), imports and photo renders unlock on a paid plan/, /becomes read-only/,
    /kept for 60 days after the trial ends/, /30, 7 and 1 day before deletion/, /one free trial per organisation or e-mail address/, /choose a paid plan at any time/]) assert.match(sec, re, String(re));
  assert.match(TERMS, /<a href="#trial">4\. Free trial<\/a>/);
});
t('landing: the trial FAQ states the rules and links to them', () => {
  assert.match(INDEX, /<a class="link-d" href="\/terms#trial">See all free-trial rules<\/a>/);
  assert.ok(!/Every feature, no card|set up a real event and invite your team/.test(INDEX));
  const ld = INDEX.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  const faq = JSON.parse(ld)['@graph'].find((x) => x['@type'] === 'FAQPage');
  const q = faq.mainEntity.find((x) => x.name === 'How long is the free trial?');
  assert.match(q.acceptedAnswer.text, /read-only/); assert.match(q.acceptedAnswer.text, /60 days/); assert.ok(!/</.test(q.acceptedAnswer.text));
});

console.log(`trial-terms-box: ${n} passed, ${fail} failed`);
if (fail) process.exit(1);
