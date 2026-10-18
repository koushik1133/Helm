// Studio setup wizard (public/onboarding-wizard.js + onboarding.js wiring).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const W = createRequire(import.meta.url)('../public/onboarding-wizard.js');
const tests = []; const t = (n, f) => tests.push([n, f]);

t('flow order: billing → studio → brand → team → venues → imports → payment → templates → finish', () => {
  assert.deepEqual(W.FLOW, ['billing', 'studio', 'brand', 'team', 'venues', 'menu', 'pricing', 'inventory', 'vendors', 'staff', 'payment', 'templates', 'finish']);
  assert.ok(!W.FLOW.includes('connect'), 'WhatsApp & email step hidden while HELM_FEATURES.integrationsPage is off');
  assert.deepEqual(Object.keys(W.REQUIRED), ['billing', 'studio']);
  for (const k of W.FLOW) assert.ok(W.LABELS[k], k);
});
t('studio validation + patch keeps other brand keys', () => {
  const bad = W.validateStudio({ name: ' ', email: 'x@', website: 'ftp://a', currency: 'rupee', timezone: 'Mars/Base' });
  assert.equal(bad.ok, false); assert.deepEqual(Object.keys(bad.errors).sort(), ['currency', 'email', 'name', 'timezone', 'website']);
  const ok = W.validateStudio({ name: 'Aurora <b>Events</b>', email: 'Hi@Aurora.IN', website: 'aurora.in', currency: 'inr', timezone: 'Asia/Kolkata' });
  assert.equal(ok.ok, true); assert.equal(ok.data.website, 'https://aurora.in'); assert.equal(ok.data.currency, 'INR'); assert.equal(ok.data.email, 'hi@aurora.in');
  assert.doesNotMatch(ok.data.name, /[<>]/);
  const p = W.studioPatch({ brand: { billing: { city: 'Hyd' }, logo: 'https://x.io/l.png', onboarding: { step: 'studio' } } }, ok.data);
  assert.equal(p.brand.billing.city, 'Hyd'); assert.equal(p.brand.logo, 'https://x.io/l.png'); assert.equal(p.brand.onboarding.step, 'studio');
  assert.equal(p.brand.website, 'https://aurora.in'); assert.equal(p.business_email_confirmed, true);
});
t('brand: https logo + hex accent only, merge-safe', () => {
  assert.equal(W.validateBrand({ logo: 'javascript:alert(1)' }).ok, false);
  assert.equal(W.validateBrand({ logo: 'http://x.io/a.png' }).ok, false);
  assert.equal(W.validateBrand({ accent: 'red' }).ok, false);
  const r = W.validateBrand({ logo: 'https://cdn.x.io/a.png', accent: '#6D28D9' }); assert.equal(r.ok, true);
  assert.deepEqual(W.brandPatch({ brand: { phone: '1' } }, r.data).brand, { phone: '1', logo: 'https://cdn.x.io/a.png', accent: '#6D28D9' });
});
t('payment terms: bounds + merged into pricing config without dropping keys', () => {
  assert.equal(W.validatePayment({ advancePct: '101', balanceDueDays: '3' }).ok, false);
  assert.equal(W.validatePayment({ advancePct: '50', balanceDueDays: '2.5' }).ok, false);
  assert.equal(W.validatePayment({ advancePct: '', balanceDueDays: '0' }).ok, false);
  const r = W.validatePayment({ advancePct: '30', balanceDueDays: '7', paymentTermsNote: 'No refunds <script>' });
  assert.equal(r.ok, true); assert.doesNotMatch(r.data.paymentTermsNote, /</);
  const n = W.paymentPatch({ chairPrice: 200, assetPrices: { a: 1 } }, r.data);
  assert.equal(n.chairPrice, 200); assert.deepEqual(n.assetPrices, { a: 1 }); assert.equal(n.advancePct, 30); assert.equal(n.balanceDueDays, 7);
  assert.deepEqual(W.paymentFromCfg({}), { advancePct: '10', balanceDueDays: '0', paymentTermsNote: '' });
});
t('progress record: resumable, sanitised, merge-safe', () => {
  const o = { brand: { logo: 'L', onboarding: { step: 'venues', done: ['billing', 'studio', 'evil'], skipped: ['brand'] } } };
  const p = W.progressFromOrg(o); assert.equal(p.step, 'venues'); assert.deepEqual(p.done, ['billing', 'studio']); assert.deepEqual(p.skipped, ['brand']);
  assert.equal(W.progressFromOrg({ brand: { onboarding: { step: 'x' } } }).step, null);
  const patch = W.progressPatch(o, { step: 'payment', done: ['billing', 'studio', 'menu'], skipped: [] });
  assert.equal(patch.brand.logo, 'L'); assert.equal(patch.brand.onboarding.step, 'payment'); assert.ok(patch.brand.onboarding.updated_at);
  assert.equal(W.percent(['billing', 'studio'], ['brand']), Math.round(3 / 12 * 100));
  assert.deepEqual(W.requiredMissing(['billing']), ['studio']);
});
t('hash routing: legacy #s<n> import links still land on the same import step', () => {
  assert.equal(W.stepFromHash('#s0'), 'menu'); assert.equal(W.stepFromHash('#s1'), 'pricing'); assert.equal(W.stepFromHash('#s2'), 'inventory');
  assert.equal(W.stepFromHash('#step-venues'), 'venues'); assert.equal(W.stepFromHash('#step-nope'), null); assert.equal(W.stepFromHash('#s9'), null);
});
t('dashboard nudge: admins only, until completed, never for untouched legacy studios', () => {
  const o = { brand: { onboarding: { step: 'team', done: ['billing', 'studio'] } } };
  const n = W.nudgeFor(o, 'admin'); assert.equal(n.step, 'team'); assert.equal(n.href, 'onboarding.html#step-team'); assert.ok(n.pct > 0);
  assert.equal(W.nudgeFor(o, 'crew'), null);
  assert.equal(W.nudgeFor({ brand: { onboarding: { step: 'finish', done: ['billing'], completed_at: '2026-10-10T00:00:00Z' } } }, 'admin'), null);
  assert.equal(W.nudgeFor({ brand: {} }, 'admin'), null);
});
t('country defaults: HelmCountry first, BPStore.tax fallback, built-in tz map', () => {
  const store = { tax: { profile: (cc) => (cc === 'AE' ? { known: true, currency: 'AED', tax: 'VAT', rate: 5, idLabel: 'TRN' } : { known: false }) } };
  const ae = W.countryDefaults('AE', store); assert.equal(ae.currency, 'AED'); assert.equal(ae.timezone, 'Asia/Dubai'); assert.equal(ae.taxName, 'VAT');
  globalThis.HelmCountry = { get: (cc) => (cc === 'US' ? { currency: 'USD', timezone: 'America/Chicago', taxName: 'Sales tax' } : null) };
  const us = W.countryDefaults('US', store); assert.equal(us.currency, 'USD'); assert.equal(us.timezone, 'America/Chicago'); assert.equal(us.taxName, 'Sales tax');
  globalThis.HelmCountry = { get: () => { throw new Error('boom'); } };
  assert.equal(W.countryDefaults('IN', null).currency, 'INR');
  delete globalThis.HelmCountry;
});
t('UI wiring: steps, Save & continue / Back / Skip for now, smart import feature-detect, venues reuse, no hard deletes', () => {
  const js = read('public/onboarding.js'), h = read('public/onboarding.html'), d = read('public/dashboard.html'), w = read('public/onboarding-wizard.js');
  assert.match(js, /Save &amp; continue/); assert.match(js, /Save & continue/); assert.match(js, /Skip for now/); assert.match(js, /data-act="prev">Back/);
  assert.match(js, /window\.HelmImport && typeof window\.HelmImport\.open === "function"/);
  assert.match(js, /window\.HelmImport\.open\(\{ entity: W\.IMPORT_ENTITY\[kind\], onDone:/);
  assert.match(js, /BPStore\.invitations\.create\(email, vals\.role\)/);
  assert.match(js, /window\.HelmVenuesAdmin/); assert.match(h, /id="pane-venues"[^>]*><div id="vn_root">/);
  assert.match(js, /<progress max="100"/); assert.match(js, /"#step-" \+ keyOf\(S\.step\)/);
  assert.match(js, /persistProgress\(/); assert.match(js, /ob-req">required/);
  assert.doesNotMatch(js + w, /\.delete\(|hardDelete/);
  assert.doesNotMatch(w, /style=|innerHTML/);
  assert.match(d, /<section id="obNudge" class="ob-nudge" hidden aria-label="Studio setup"><\/section>/);
  assert.match(d, /<script src="onboarding-wizard\.js\?v=9"><\/script>/);
  assert.match(w, /global\.HelmCountry/);
});
let n = 0;
for (const [name, fn] of tests) { await fn(); n++; console.log('  ✓ ' + name); }
console.log(`onboarding-wizard: ${n} passed`);
