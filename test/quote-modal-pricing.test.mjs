// qmodal-1018: quotes.html Confirm / Re-price dialog - layering above the app chrome, client prefill from every place
// the quote keeps it, and the EFFECTIVE chair / plate rates (package price wins; studio default; locked price labelled).
// Owner case (prod trial studio, quote 10182026-01): dialog said "Rs150/chair - Rs400/plate (package: Standard - Vegetarian)"
// while Control Center showed 200 / 500 and the package costs 450; client name + email were empty.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const ctx = { console }; vm.createContext(ctx);
vm.runInContext(read('public/quote-rates.js'), ctx);
const R = ctx.HelmQuoteRates;
const inr = (x) => '₹' + Number(x || 0).toLocaleString('en-IN');
const PKGS = [{ id: 'p1', name: 'Standard — Vegetarian', price_per_plate: 450, active: true },
              { id: 'p2', name: 'Gold — Vegetarian', price_per_plate: 700, active: true }];
// a free-trial studio's pricing config: only tax + terms keys (0168/0169 copy from the sample master)
const TRIAL_CFG = { gstPct: 18, placeOfSupply: 'intra', taxState: 'Telangana', termsText: 'SAMPLE TERMS', advancePct: 30 };
const PLAN = { menu_template: 'Standard — Vegetarian', menu_plate_price: 400, venue_name: 'DEMO 2' };
const SAVED = { chairs: 35000, chairPrice: 150, guests: 50000, platePrice: 400, gstPct: 18, total: 123, taxCountry: 'IN' };

t('trial config without rate keys: studio defaults are 200 / 500 (what Control Center shows), never 0', () => {
  const s = R.studioRates(TRIAL_CFG);
  assert.equal(s.chairPrice, 200); assert.equal(s.platePrice, 500); assert.equal(s.chairDefaulted, true);
  assert.equal(R.studioRates(null).chairPrice, 200);
  assert.equal(R.studioRates({ chairPrice: 0, platePrice: '' }).chairPrice, 0, 'a real 0 rate is kept');
  assert.equal(R.studioRates({ chairPrice: 0, platePrice: '' }).platePrice, 500);
  assert.equal(R.studioRates({ chairPrice: 'abc', platePrice: -5 }).chairPrice, 200);
});

t('owner case: package price (450) wins over the stale plan snapshot (400); chair = studio rate 200', () => {
  const r = R.effective({ cfg: TRIAL_CFG, pricing: SAVED, plan: PLAN, packages: PKGS, keep: false });
  assert.equal(r.chairPrice, 200); assert.equal(r.chairSrc, 'studio');
  assert.equal(r.platePrice, 450); assert.equal(r.plateSrc, 'package'); assert.equal(r.pkgName, 'Standard — Vegetarian');
  assert.equal(r.pkgStale, true);
  assert.deepEqual({ ...r.saved }, { chairPrice: 150, platePrice: 400 });
  const line = R.note(r, inr, { name: 'GST', rate: 18 });
  assert.match(line, /₹200\/chair \(studio rate\)/);
  assert.match(line, /₹450\/plate \(package: Standard — Vegetarian\)/);
  assert.match(line, /GST 18%/);
  assert.doesNotMatch(line, /₹150|₹400/);
  assert.equal(R.savedNote(r, inr), 'Saved on this quote: ₹150/chair · ₹400/plate. Saving prices it at the rates above.');
});

t('paid studio with its own rates: its chair rate; the package still sets the plate', () => {
  const r = R.effective({ cfg: { chairPrice: 250, platePrice: 600, gstPct: 18 }, pricing: {}, plan: PLAN, packages: PKGS });
  assert.equal(r.chairPrice, 250); assert.equal(r.platePrice, 450); assert.equal(r.saved, null);
  const np = R.effective({ cfg: { chairPrice: 250, platePrice: 600 }, pricing: {}, plan: null, packages: PKGS });
  assert.equal(np.platePrice, 600); assert.equal(np.plateSrc, 'studio'); assert.equal(R.plateLabel(np), 'studio rate');
});

t('quote kept in its own currency: its chair (and plate without a package) are "locked at quote time"', () => {
  const r = R.effective({ cfg: { chairPrice: 200, platePrice: 500 }, pricing: SAVED, plan: null, packages: [], keep: true });
  assert.equal(r.chairPrice, 150); assert.equal(r.chairSrc, 'locked'); assert.equal(r.platePrice, 400); assert.equal(r.plateSrc, 'locked');
  assert.match(R.note(r, inr), /₹150\/chair \(locked at quote time\) · ₹400\/plate \(locked at quote time\)/);
  assert.equal(r.saved, null, 'nothing changes on save, so no "saved on this quote" line');
});

t('package renamed / removed: the price it was applied at; inactive package still resolves; names match loosely', () => {
  const gone = R.effective({ cfg: {}, pricing: {}, plan: PLAN, packages: [] });
  assert.equal(gone.platePrice, 400); assert.equal(gone.plateSrc, 'package'); assert.equal(gone.pkgStale, false);
  const off = R.effective({ cfg: {}, pricing: {}, plan: PLAN, packages: [{ name: 'Standard — Vegetarian', price_per_plate: 470, active: false }] });
  assert.equal(off.platePrice, 470);
  assert.ok(R.findPackage({ menu_template: '  standard —  vegetarian ' }, PKGS));
  assert.equal(R.findPackage({ menu_template: '' }, PKGS), null);
});

t('client prefill: quote client, else the copy inside pricing, else the list row; venue/date from the plan/quote', () => {
  const full = { client: {}, eventDate: '2026-11-04', pricing: { client: { name: 'Sai Prasanna', email: 'sai@example.com', phone: '+919000000000' } } };
  const c = R.clientFor(full, null, PLAN);
  assert.equal(c.name, 'Sai Prasanna'); assert.equal(c.email, 'sai@example.com'); assert.equal(c.eventDate, '2026-11-04'); assert.equal(c.venue, 'DEMO 2');
  const c2 = R.clientFor({ client: { name: '  ' } }, { client: { name: 'Sai Prasanna' } }, null);
  assert.equal(c2.name, 'Sai Prasanna'); assert.equal(c2.email, '');
  const c3 = R.clientFor({ client: { name: 'Own', email: 'own@x.in' }, pricing: { client: { name: 'Old' } } }, null, null);
  assert.equal(c3.name, 'Own', 'the quote’s own client record wins');
  for (const k of R.CLIENT_KEYS) assert.equal(typeof c3[k], 'string');
});

const q = read('public/quotes.html');
t('quotes.html: dialog layer above the top bar / rail / notices; sheet fits the viewport and scrolls inside', () => {
  const m = /\.lmodal\{[^}]*z-index:(\d+)/.exec(q); assert.ok(m, '.lmodal z-index');
  const shell = read('public/shell-b.css');
  const head = +/header\.hb-header \{[^}]*z-index: (\d+)/.exec(shell)[1], rail = +/\.hb-rail \{ position: fixed; z-index: (\d+)/.exec(shell)[1];
  const notes = +/\.hau-notes\{[^}]*z-index:(\d+)/.exec(read('public/auth-ui.js'))[1];
  assert.ok(+m[1] > Math.max(head, rail, notes), `modal ${m[1]} must sit above header ${head} / rail ${rail} / notes ${notes}`);
  assert.ok(+m[1] < 2147483000, 'BPUI confirm prompts + toasts stay above the dialog');
  assert.match(q, /\.lmodal\{[^}]*align-items:flex-start/);
  assert.match(q, /\.sheet\{[^}]*margin:auto;max-height:calc\(100vh - 48px\);max-height:calc\(100dvh - 48px\);overflow:auto/);
  assert.match(q, /html\[data-shell\] \.lmodal\{background:rgba\(20,27,46,\.5\)!important/);
});
t('quotes.html: fresh read on open, merged client prefill, effective rates, bfcache refresh', () => {
  assert.match(q, /<script src="quote-rates\.js\?v=\d+"><\/script>/);
  const s = q.indexOf('async function openConfirm'), e = q.indexOf('const cmDirty=');
  const body = q.slice(s, e);
  assert.match(body, /full=await BPStore\.quotes\.get\(id\); if\(full\) detailCache\[id\]=full;/);
  assert.doesNotMatch(body, /full=detailCache\[id\]\|\|/);
  assert.match(body, /HelmQuoteRates\.clientFor\(full,row,planRow\)/);
  assert.match(body, /\$\("#c_name"\)\.value=mc\.name;/);
  assert.match(body, /BPStore\.menuTemplates\.list\(true\)/);
  assert.match(body, /HelmQuoteRates\.effective\(/);
  assert.match(body, /\$\("#p_platePrice"\)\.value = cmRates\.platePrice;/);
  assert.doesNotMatch(body, /menuPlate!=null \? menuPlate : cfg\.platePrice/);
  assert.match(q, /rn\.textContent = HelmQuoteRates\.note\(r, inr, curTax\);/);
  assert.match(q, /HelmQuoteRates\.savedNote\(/);
  assert.match(q, /addEventListener\("pageshow",e=>\{ if\(!e\.persisted\) return;/);
});
t('package flow: a price agreed with the client (accepted selection = plan stamp) is never replaced by the list price', () => {
  const plan = { menu_template: 'Standard — Vegetarian', menu_plate_price: 400 };
  const sel = [{ status: 'superseded', package: 'Standard — Vegetarian', package_id: 'p1', per_person: 450, created_at: '2026-10-18T09:00:00Z' },
               { status: 'accepted', package: 'Standard — Vegetarian', package_id: 'p1', per_person: 400, price_override: 400, created_at: '2026-10-18T08:00:00Z', reviewed_at: '2026-10-18T08:30:00Z' }];
  const r = R.effective({ cfg: { chairPrice: 250, platePrice: 600 }, pricing: { platePrice: 400, total: 1, gstPct: 18 }, plan, packages: PKGS, selections: sel });
  assert.equal(r.platePrice, 400); assert.equal(r.plateSrc, 'agreed'); assert.equal(r.saved, null);
  assert.match(R.note(r, inr), /₹400\/plate \(package: Standard — Vegetarian, price agreed with the client\)/);
  // matched by package id even after a rename
  assert.equal(R.agreedPrice(plan, PKGS[0], [{ status: 'accepted', package: 'Renamed', package_id: 'p1', per_person: 400 }]), 400);
  // a package re-applied after the deal (plan stamp no longer the agreed price) -> list price again
  assert.equal(R.effective({ cfg: {}, pricing: {}, plan: { ...plan, menu_plate_price: 450 }, packages: PKGS, selections: sel }).plateSrc, 'package');
  // no accepted selection / unreadable list -> the owner-case rule (current package price)
  assert.equal(R.effective({ cfg: {}, pricing: {}, plan, packages: PKGS, selections: [sel[0]] }).platePrice, 450);
  assert.equal(R.effective({ cfg: {}, pricing: {}, plan, packages: PKGS, selections: null }).platePrice, 450);
  assert.equal(R.agreedPrice(plan, PKGS[0], [{ status: 'accepted', package: 'Gold — Vegetarian', package_id: 'p2', per_person: 400 }]), null);
  assert.match(q, /BPStore\.pkgflow\.list\(id\)/);
  assert.match(q, /selections:Array\.isArray\(selR\)\?selR:\[\]/);
});
t('builder: never silently moves the plate rate to the list price; keeps a quote already re-priced at the current package price', () => {
  const b = read('public/builder.js');
  assert.doesNotMatch(b, /if\(match && match\.price_per_plate!=null && match\.price_per_plate!=="" && isFinite\(\+match\.price_per_plate\)\) PRICING\.menuPlatePrice/);
  assert.match(b, /if\(plan\.menu_plate_price!=null\) PRICING\.menuPlatePrice = \+plan\.menu_plate_price;/);
  assert.match(b, /\+currentPricing\.platePrice === \+match\.price_per_plate\) PRICING\.menuPlatePrice = \+match\.price_per_plate;/);
});
console.log(n + ' passed');
