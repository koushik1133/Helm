// r20 checkout: the plans page looks complete while online payment is not live.
//  * plans: server plans, else the display-only catalog (Starter, Studio, Enterprise "Price on request") - never an empty box
//  * the plan button is "Contact sales" (upgrade / waiting studio / catalog) -> a prefilled form that opens the
//    visitor's own email app addressed to sales@helm.events (same mechanism as the landing contact form)
//  * the Razorpay path is untouched for when online payment is live
//  * gate: a studio ADMIN on (or just past) the free trial stays on /checkout ("Choose a plan"); members never do
//  * every "Choose a plan" link lands on /checkout
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CO = read('public/checkout.js'), COH = read('public/checkout.html'), CSS = read('public/checkout-v2.css'), API = read('public/store-api.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = {};
vm.runInNewContext(fnSrc(API, 'checkoutPageStays') + '\n' + fnSrc(CO, 'salesCheck') + '\n' + fnSrc(CO, 'salesMail')
  + '\nglobalThis.stays = checkoutPageStays; globalThis.check = salesCheck; globalThis.mail = salesMail;', ctx);

/* ---------------- gate ---------------- */
t('gate: trial / ended-trial admins stay on /checkout; members, subscribed, missing, unknown do not', () => {
  assert.equal(ctx.stays({ required: true, is_admin: true, reason: 'needs_checkout' }), true);
  assert.equal(ctx.stays({ required: false, is_admin: true, reason: 'trial' }), true);
  assert.equal(ctx.stays({ required: false, is_admin: true, reason: 'trial_ended' }), true);
  assert.equal(ctx.stays({ required: false, is_admin: false, reason: 'member' }), false);
  assert.equal(ctx.stays({ required: false, is_admin: false, reason: 'trial' }), false, 'a non-admin never stays');
  assert.equal(ctx.stays({ required: false, is_admin: true, reason: 'subscribed' }), false);
  assert.equal(ctx.stays({ required: false, is_admin: true, reason: 'existing_studio' }), false);
  assert.equal(ctx.stays({ missing: true }), false);
  assert.equal(ctx.stays(null), false);
});
t('gate: /checkout uses checkoutPageStays; network-unknown (null) still shows the page as before', () => {
  assert.match(API, /if \(pk === CHECKOUT_PAGE\) \{[\s\S]{0,400}if \(cst && !checkoutPageStays\(cst\)\) \{[\s\S]{0,500}?try \{ location\.replace\(safeNext\(nextParam\(\)\)\); \} catch \(e\) \{\}/);
  // a teammate is told why (one-time notice) on the page they land on (#208)
  assert.match(API, /if \(!cst\.missing && cst\.reason === "member"\) \{ try \{ sessionStorage\.setItem\("bp_flash", "i\|" \+ ROLE_BLOCK_MSG\); \} catch \(e\) \{\} \}/);
  assert.match(API, /pageStays: \(st\) => checkoutPageStays\(st\),/);
  // the server is the real gate: options are admin-only
  assert.match(read('supabase/migrations/0159_direct_studio_plan_gate.sql'), /my_checkout_options\(\)[\s\S]{0,400}not coalesce\(public\.is_admin\(\), false\) then raise exception 'not authorized' using errcode = '42501'/);
});

/* ---------------- plans ---------------- */
t('plans: display-only catalog has Starter, Studio and Enterprise ("Price on request"); never "No plans are available"', () => {
  assert.match(CO, /code: "starter"/); assert.match(CO, /code: "studio"/);
  assert.match(CO, /\{ code: "enterprise", name: "Enterprise", description: "[^"]+", monthly: null, yearly: null,/);
  assert.match(CO, /function onRequest\(p\) \{ return !!p && p\.monthly == null && p\.yearly == null; \}/);
  assert.match(CO, /pp\.textContent = "Price on request";/);
  assert.match(CO, /box\.appendChild\(row\("Price", "On request", "tot"\)\);/);
  assert.doesNotMatch(CO, /No plans are available/);
  assert.match(CO, /if \(!list\.length\) list = CATALOG;/);
  // an options failure still shows the plans (display only) instead of an empty box
  assert.match(CO, /catch \(e\) \{ showErr\(S\.checkout\.classify\(e\)\.message\); st\.opts = \{\}; acct = \{\}; \}/);
});

/* ---------------- Contact sales ---------------- */
t('button: "Contact sales" whenever nothing is payable online; the pay path is unchanged when live', () => {
  assert.match(CO, /st\.sales = st\.catalog \|\| \(!st\.live && \(st\.upgrade \|\| st\.pending\)\);/);
  // r22: the button is "Pay now" (UPI / bank details + payment pending) or "Contact sales" for an on-request plan
  assert.match(CO, /if \(st\.sales\) \{ b\.disabled = false; b\.textContent = !payOn\(\) \|\| onRequest\(planBy\(st\.plan\)\) \|\| st\.catalog && !planBy\(st\.plan\) \? "Contact sales" : "Pay now"; return; \}/);   // r24: Pay now switch
  const salesLine = 'if (st.sales) { var sp = planBy(st.plan); if (sp && !onRequest(sp) && payOn()) cardPay(sp); else cardSales(sp); return; }';
  assert.ok(CO.includes(salesLine));
  assert.ok(CO.indexOf(salesLine) < CO.indexOf('await S.checkout.saveBilling('), 'Contact sales / UPI never saves billing or pays');
  assert.match(CO, /var v = await S\.checkout\.pay\(st\.plan, st\.interval, \{ name: \$\("#f_legal"\)\.value, email: p\.email \|\| "", contact: p\.contact \|\| "" \}\);/);
  assert.match(CO, /st\.live \? "Pay " \+ money\(st\.preview\.total, st\.preview\.currency\) \+ " securely"/);
  assert.doesNotMatch(CO, /up\.textContent \+= " Online payment isn't switched on yet/, 'no "not switched on" notice on the page');
  assert.doesNotMatch(COH, /Payments are being set up/);
  // billing + Terms are taken when the team activates the plan
  assert.match(CO, /\$\("#coBilling"\)\.hidden = st\.sales;/); assert.match(CO, /\$\("#coTermsCard"\)\.hidden = false;/);   // r22: Terms always agreed + recorded
  assert.match(COH, /<section class="card" id="coBilling"/); assert.match(COH, /<section class="card" id="coTermsCard"/);
});
t('form: prefilled studio / name / email / phone / plan / billing + message; CSP-safe markup', () => {
  for (const id of ['sd_studio', 'sd_name', 'sd_email', 'sd_phone', 'sd_plan', 'sd_iv', 'sd_msg', 'sdSend', 'sdErr', 'sdDone', 'sdClose'])
    assert.match(COH, new RegExp('id="' + id + '"'), id);
  assert.match(COH, /<dialog class="sdlg" id="coSalesDlg" aria-labelledby="sdH">/);
  assert.match(COH, /we'll contact you within one working day\./);   // r21: the request is saved first (test/r21-trial-paid.test.mjs)
  assert.match(CO, /who = \{ studio: acct\.legal_business_name \|\| "", name: acct\.primary_contact_name \|\| "", email: acct\.primary_contact_email \|\| u\.email \|\| "",/);
  assert.doesNotMatch(COH, /\sstyle="/); assert.doesNotMatch(COH, /\son[a-z]+=/i);
  assert.doesNotMatch(CO, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\./);
  assert.doesNotMatch(CSS, /prefers-color-scheme: ?dark|data-theme="dark"/);
  assert.match(CSS, /\.sdlg \{/); assert.match(CSS, /width: min\(560px, calc\(100vw - 32px\)\)/, 'phone width: 16px gutters');
});
t('salesCheck: required studio / name / email; phone optional but sane; control characters flattened', () => {
  let v = ctx.check({});
  assert.equal(v.ok, false); assert.deepEqual(Object.keys(v.errors).sort(), ['email', 'name', 'plan', 'studio']);
  v = ctx.check({ studio: ' Spark\r\nBcc: x@y.z ', name: 'Asha', email: 'asha@spark.in', plan: 'Studio', interval: 'yearly', phone: '+91 98765 43210', message: 'Hi\r\nthere' });
  assert.equal(v.ok, true); assert.equal(v.clean.studio, 'Spark Bcc: x@y.z'); assert.equal(v.clean.interval, 'yearly');
  assert.equal(v.clean.message, 'Hi\nthere');
  assert.equal(ctx.check({ studio: 'S', name: 'A', email: 'bad', plan: 'Studio' }).errors.email, 'Enter a valid email address');
  assert.equal(ctx.check({ studio: 'S', name: 'A', email: 'a@b.co', plan: 'Studio', phone: 'call me' }).errors.phone, 'Enter a valid phone number');
  assert.equal(ctx.check({ studio: 'S', name: 'A', email: 'a@b.co', plan: 'Studio', interval: 'weekly' }).clean.interval, 'monthly');
  assert.equal(ctx.check({ studio: 'x'.repeat(400), name: 'A', email: 'a@b.co', plan: 'P', message: 'm'.repeat(5000) }).clean.studio.length, 160);
});
t('salesMail: mailto sales@helm.events with every detail; subject is one line', () => {
  const c = ctx.check({ studio: 'Spark Events', name: 'Asha Rao', email: 'asha@spark.in', phone: '+919876543210', plan: 'Studio', interval: 'yearly', message: 'Two branches' }).clean;
  const url = ctx.mail(c, 'sales@helm.events');
  assert.ok(url.startsWith('mailto:sales@helm.events?subject='));
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(q.get('subject'), 'Helm plan request: Studio (Yearly) - Spark Events');
  const body = q.get('body');
  for (const s of ['Studio: Spark Events', 'Name: Asha Rao', 'Email: asha@spark.in', 'Phone: +919876543210', 'Plan: Studio', 'Billing: Yearly', 'Two branches']) assert.ok(body.includes(s), s);
  assert.ok(!/[\r\n]/.test(q.get('subject')));
  assert.match(CO, /var SALES_TO = \(S && S\.checkout && S\.checkout\.SALES_EMAIL\) \|\| "sales@helm\.events";/);
  assert.match(API, /SALES_EMAIL: "sales@helm\.events",/);
  // r24 (0271): the landing contact form now saves to Helm (submit_sales_enquiry -> HQ Requests) instead of mailto
  assert.match(read('public/home.js'), /\/rest\/v1\/rpc\/submit_sales_enquiry/, 'landing contact form saves to Helm');
});

/* ---------------- "Choose a plan" links ---------------- */
t('every "Choose a plan" link lands on /checkout', () => {
  assert.match(read('public/trial.js'), /function planHref\(t, pageName\) \{\s*return "checkout\.html\?next=" \+ encodeURIComponent/);   // trial banner
  assert.match(API, /function capHref\(\) \{[\s\S]{0,460}return "\/checkout\?next=" \+ encodeURIComponent\(pg \+ "\.html"\);/);          // cap note + cap toast
  assert.match(API, /href: capHref\(\), linkLabel: "Choose a plan"/);
  assert.match(API, /h\("a", \{ href: capHref\(\), class: "bpui-caplink" \}, "Choose a plan to add more"\)/);
  assert.match(read('public/auth-ui.js'), /primary: \{ label: "Choose a plan", onClick: function \(\) \{ try \{ location\.assign\("checkout\.html\?next="/);   // trial notice card
  assert.match(API, /if \(k === "trial_reminder"\) return "checkout\.html";/);   // bell
  const v = JSON.parse(read('vercel.json'));
  assert.ok(v.cleanUrls === true || (v.rewrites || []).some((r) => /checkout/.test(r.source)), '/checkout resolves');
});

console.log('r20-checkout-sales: ' + n + ' passed');
