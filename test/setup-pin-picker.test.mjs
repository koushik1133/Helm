// Owner report (Oct 2026): (1) the phone country picker and the Country select opened their list
// off-screen / above the viewport; (2) studio setup PIN code "not saving, saying zero"; new studios
// showed the old violet accent. Pure checks + source guards (the DOM part was driven in a browser).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const P = require('../public/phone-input.js');
const O = require('../public/onboarding-core.js');
const W = require('../public/onboarding-wizard.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };
const rect = (top, h = 38, left = 20, w = 300) => ({ top, bottom: top + h, left, right: left + w, width: w, height: h });
const inside = (p, vw, vh) => p.top >= 0 && p.left >= 0 && p.top + p.maxHeight <= vh && p.left + p.width <= vw;

/* ---------------- 1) picker placement (#picker-clamp) ---------------- */
t('opens DOWN by default when there is room below', () => {
  const p = P.placePopup(rect(100), 1280, 720, { width: 340, height: 330 });
  assert.equal(p.up, false); assert.equal(p.top, 100 + 38 + 6); assert.equal(p.maxHeight, 330); assert.ok(inside(p, 1280, 720));
});
t('flips UP only when below is too small AND above has more room', () => {
  const p = P.placePopup(rect(640), 1280, 720, { width: 340, height: 330 });
  assert.equal(p.up, true); assert.ok(p.top + p.maxHeight <= 640 - 6 + 0.5, 'ends above the field'); assert.ok(inside(p, 1280, 720));
  // little room below but even less above (field near the top of a short window) -> stays down
  const q = P.placePopup(rect(60), 1280, 260, { width: 340, height: 330 });
  assert.equal(q.up, false); assert.ok(inside(q, 1280, 260));
});
t('never starts above the top edge or ends below the bottom (the old bug)', () => {
  for (const vh of [300, 480, 720, 812]) for (let top = -50; top < vh + 50; top += 37) {
    const p = P.placePopup(rect(top), 375, vh, { width: 340, height: 330 });
    assert.ok(inside(p, 375, vh), `vh ${vh} field ${top} -> ${JSON.stringify(p)}`);
  }
});
t('list height shrinks to the room available (scrolls inside), width/left clamp to the viewport', () => {
  const p = P.placePopup(rect(400), 1280, 720, { width: 340, height: 330 });
  assert.equal(p.up, false); assert.equal(p.maxHeight, 720 - 438 - 6 - 8, JSON.stringify(p));
  const m = P.placePopup(rect(100, 38, 300, 60), 360, 812, { width: 400, height: 330 });
  assert.equal(m.width, 360 - 16); assert.equal(m.left, 8);
  const r = P.placePopup(rect(100, 38, 1200, 60), 1280, 720, { width: 340 });
  assert.equal(r.left, 1280 - 8 - 340);
});
t('phone picker + Country selects use the fixed, clamped popup (no off-screen flip class)', () => {
  const js = read('public/phone-input.js'), css = read('public/theme.css');
  assert.match(js, /function positionPop\(pop, anchor, measure\)/); assert.match(js, /positionPop\(pop, wrap, true\)/); assert.match(read('public/theme.css'), /\.hp-pop\.hp-measuring\{animation:none!important;transform:none!important\}/);
  assert.doesNotMatch(js, /hp-up/, 'old 330px flip heuristic removed');
  assert.doesNotMatch(css, /\.hp\.hp-up \.hp-pop/);
  assert.match(css, /\.hp-pop\{position:fixed;/); assert.match(css, /\.hp-pop:not\(\[hidden\]\)\{display:flex;flex-direction:column/);
  assert.match(js, /addEventListener\("keydown", function \(e\) \{ if \(openInst && e\.key === "Escape"\)/, 'Escape closes from anywhere');
  assert.match(js, /addEventListener\("scroll", follow, \{ capture: true, passive: true \}\)/, 'follows scrolled containers');
  assert.match(js, /API\.enhanceSelect = enhanceSelect/); assert.match(js, /select\[data-picker="search"\]/);
  assert.match(js, /SEL_VALUE\.set\.call\(sel, v\); paint\(\)/, 'programmatic sel.value updates the button');
  // Pricing shows the country read-only (cc-unsaved-and-layout): its select is a hidden mirror, so it gets no
  // searchable picker (an enhanced hidden select would draw a visible button); General's o_country is the picker
  assert.match(read('public/control.html'), /<select id="p_country" hidden aria-hidden="true"/);
  assert.doesNotMatch(read('public/control.html'), /<select id="p_country"[^>]*data-picker/);
  assert.match(read('public/control.html'), /<select id="o_country" data-picker="search">/);
  assert.match(read('public/onboarding.js'), /data-billcountry="1" data-picker="search"/);
});

/* ---------------- 2) studio setup: PIN + blanks (#setup-pin) ---------------- */
const good = { legal_name: 'Aurora Events', line1: '12 Road 3', city: 'Hyderabad', state: 'Telangana', pin: '500034', phone: '+91 98765 43210', location: 'Hyderabad' };
t('PIN is stored as a 6-digit STRING, never a number', () => {
  const r = O.validateBilling(good); assert.equal(r.ok, true); assert.equal(r.data.pin, '500034'); assert.equal(typeof r.data.pin, 'string');
  const p = O.billingPatch({ name: 'x' }, r.data); assert.equal(p.brand.billing.pin, '500034'); assert.equal(typeof p.brand.billing.pin, 'string');
  assert.equal(O.validateBilling({ ...good, pin: 500034 }).data.pin, '500034');
});
t('a PIN saved as a number reads back as its digits (it used to read back blank)', () => {
  const v = O.billingFromOrg({ brand: { billing: { pin: 500034 } } }); assert.equal(v.pin, '500034');
});
t('empty PIN stays empty - never "0"; 0 / "000000" is no PIN (required error, not saved)', () => {
  assert.equal(O.validateBilling({ ...good, pin: '' }).data.pin, ''); assert.ok(O.validateBilling({ ...good, pin: '' }).errors.pin);
  for (const z of [0, '0', '000000', ' 0 ']) { const r = O.validateBilling({ ...good, pin: z }); assert.equal(r.data.pin, '', String(z)); assert.ok(r.errors.pin, String(z)); }
  assert.equal(O.billingFromOrg({ brand: { billing: { pin: 0 } } }).pin, '');
  assert.equal(O.billingFromOrg({ brand: { billing: {} } }).pin, '');
  assert.ok(O.validateBilling({ ...good, pin: '012345' }).errors.pin, 'Indian PIN cannot start with 0');
  assert.equal(O.validateBilling({ ...good, country: 'AE', pin: '0', phone: '+971 50 123 4567' }).errors.pin, undefined, 'UAE P.O. box 0 = blank (optional)');
  assert.ok(O.validateBilling({ ...good, country: 'GB', pin: '00000', phone: '+44 20 7946 0958' }).errors.pin);
});
t('setup and Control Center read/write the SAME billing fields', () => {
  const r = O.validateBilling({ ...good, gstin: '36ABCDE1234F1Z5' }); const org = Object.assign({ name: 'x' }, O.billingPatch({ name: 'x' }, r.data));
  const back = O.billingFromOrg(org);
  for (const k of ['legal_name', 'line1', 'city', 'state', 'pin', 'location', 'gstin']) assert.equal(back[k], r.data[k], k);
  const cc = read('public/control.html');
  assert.match(cc, /const BILL_IDS=\{country:"o_country",legal_name:"o_legal",line1:"o_line1",line2:"o_line2",city:"o_city",state:"o_state",pin:"o_pin",phone:"o_phone",location:"o_location",gstin:"o_gst"\}/);
  assert.match(cc, /const v=OB\.billingFromOrg\(o\);/, 'Control Center paints billing through the same reader');
});
t('pricing: a cleared catering GST is blocked like the main rate (no silent 0 %)', () => {
  // merged with fix/cc-pricing-validation: the rule now lives in pricing-form-core.js (one message per field)
  const cc = read('public/control.html');
  assert.match(cc, /const r=PF\.validatePricing\(raws,ctx,flags\);/);
  const PF = require('../public/pricing-form-core.js');
  const ok = { chairPrice: '10', platePrice: '20', gstPct: '18', cateringGstPct: '5', serviceChargePct: '', layoutBase: '', conflictBufferHours: '' };
  const india = { symbol: '\u20b9', taxName: 'GST', split: true };
  assert.equal(PF.validatePricing(ok, india, {}).ok, true);
  const r = PF.validatePricing(Object.assign({}, ok, { cateringGstPct: '' }), india, {});
  assert.equal(r.ok, false); assert.match(r.errors.cateringGstPct, /Enter the catering GST rate/);
  assert.equal(PF.validatePricing(Object.assign({}, ok, { chairPrice: '' }), india, {}).ok, false, 'an empty chair price is refused');
});
t('step chips count from 1 (Business details no longer shows "0")', () => {
  const s = read('public/onboarding.js');
  assert.match(s, /billingOk\(\) \? "✓" : "1"\}<\/span>Business details/); assert.match(s, /st\.done \? "✓" : Number\(i\) \+ 2\}/);
});

/* ---------------- accent default (#setup-accent) ---------------- */
t('new studios default to the green accent; a saved colour is kept', () => {
  assert.equal(W.DEFAULT_ACCENT, '#047857');
  const s = read('public/onboarding.js');
  assert.match(s, /if \(v\.accent === undefined && !d\.accent\) d\.accent = W\.DEFAULT_ACCENT;/);
  assert.doesNotMatch(s.slice(s.indexOf('if (kind === "brand")'), s.indexOf('if (kind === "payment")')), /6d28d9/);
  assert.match(W.validateBrand({ accent: 'red' }).errors.accent, /#047857/);
  assert.equal(W.brandPatch({ brand: { accent: '#123456' } }, { logo: '', accent: '#123456' }).brand.accent, '#123456');
  assert.match(read('public/control.html'), /<input id="o_accent"[^>]* placeholder="#047857">/);
});

console.log(`setup-pin-picker: ${n} passed`);
