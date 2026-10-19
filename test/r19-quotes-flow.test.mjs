// r19-quotes-flow.test.mjs - owner r19 "quotes in the trial and the flow":
//  1  free trial: quotes / events are NOT capped (0211 drops the 3 cap triggers on public.quotes only; the 2-new cap
//     stays for leads, inventory items, vendors, staff, venues); my_trial_limits leaves quotes out; version
//     trial-2026-10-19. r20 (owner): 0238 puts the quote cap back (2 new) - the 0211 file is unchanged (forward-only),
//     the CURRENT wording / version (trial-2026-10-20) is checked in test/r20-trial-quotes-cap.test.mjs
//  2  "New quote" opens the flow directly (no pre-create dialog, no in-progress prompt) - see quote-create-guards
//  3  menu package can be UNSELECTED in the flow ("No package" card / click the chosen card again) and the builder
//     ("No package…"): clear_menu_template (0211) clears the plan's package + plate price, dishes kept
//  4  step 1: client e-mail required (inline) - see flow-validation
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };

const M = read('supabase/migrations/0211_trial_quotes_uncapped.sql'), A = read('supabase/APPLY-0211.sql');
const MAN = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh');
const DBT = read('tests/db/trial-quotes-0211.sql');

await t('0211 SQL: ASCII, additive (no row deleted / no table dropped), only the quotes cap triggers removed', () => {
  for (const s of [M, A, DBT]) assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(s), 'ASCII');
  const code = M.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(code, /\b(delete\s+from|truncate|drop\s+table|drop\s+column|drop\s+function|drop\s+policy|insert\s+into)\b/i);
  const drops = [...code.matchAll(/drop trigger if exists (\w+) on public\.(\w+);/g)].map((m) => m[1] + '@' + m[2]);
  assert.deepEqual(drops, ['zzzz_tl173_cap@quotes', 'zzzz_tl181_cap@quotes', 'zzzz_tl181_cap_log@quotes']);
  assert.equal((code.match(/drop trigger/gi) || []).length, 3, 'no other trigger dropped');
  // the only UPDATE is the plan row inside clear_menu_template, scoped to the caller's studio
  const ups = [...code.matchAll(/\bupdate\s+public\.(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(ups, ['event_plan']);
  assert.match(code, /where p\.quote_id = p_quote and p\.org_id = public\.current_org_id\(\)/);
});

await t('0211 SQL: my_trial_limits keeps the 5 capped lists + says quotes are uncapped; version = trial-facts.js', () => {
  assert.match(M, /foreach t in array array\['leads', 'inventory_items', 'vendors', 'crew_members', 'venues'\] loop/);
  assert.match(M, /'uncapped', jsonb_build_array\('quotes'\)/);
  assert.match(M, /if not public\._tl173_trial_locked\(v_org\) then return jsonb_build_object\('trial', false\); end if;/, 'paid studio: unchanged');
  const F = { }; vm.runInContext(read('public/trial-facts.js'), vm.createContext(F));
  const TF = F.HelmTrialFacts || (F.window && F.window.HelmTrialFacts) || (F.globalThis && F.globalThis.HelmTrialFacts);
  const ver = M.match(/select '(trial-\d{4}-\d{2}-\d{2})'::text;/)[1];
  assert.equal(ver, 'trial-2026-10-19');
  // r20: 0238 superseded this version (quotes capped again): trial-facts.js now carries the 0238 version
  const v238 = read('supabase/migrations/0238_trial_quotes_cap_two.sql').match(/select '(trial-\d{4}-\d{2}-\d{2})'::text;/)[1];
  assert.ok(!TF || TF.VERSION === v238, 'trial-facts VERSION = the latest server version (0238)');
  assert.match(read('public/trial-facts.js'), new RegExp('var VERSION = "' + v238 + '";'));
});

await t('0211 SQL: clear_menu_template = apply_menu_template checks, plan row only, dishes never touched', () => {
  const fn = M.slice(M.indexOf('create or replace function public.clear_menu_template'), M.indexOf('-- ---- privileges'));
  assert.match(fn, /security definer set search_path = ''/);
  assert.match(fn, /if auth\.uid\(\) is null or not public\.has_area\('plan', 'edit'\) then raise exception 'not authorized' using errcode = '42501'; end if;/);
  assert.match(fn, /perform public\.assert_quote_org\(p_quote\);/);
  assert.match(fn, /if coalesce\(v_locked, false\) then\s*raise exception 'menu is locked/);
  assert.match(fn, /set package = null, menu_template = null, menu_plate_price = null/);
  assert.doesNotMatch(fn.replace(/^\s*--.*$/gm, ''), /event_menu_items|delete/i);
  assert.match(M, /grant execute on function public\.clear_menu_template\(uuid\) to authenticated/);
  assert.match(M, /revoke all on function %s from anon/);
});

await t('APPLY-0211: migration verbatim in one transaction + a VERIFY grid; MANIFEST order; DB suite registered', () => {
  assert.ok(A.includes(M.trim()), 'APPLY carries the migration verbatim');
  assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m);
  assert.ok(A.indexOf('begin;') < A.indexOf(M.trim()) && A.indexOf('commit;') > A.indexOf(M.trim()));
  assert.match(A, /-- VERIFY \(every row must say ok = true\)\nselect item, ok from \(values/);
  assert.ok(!/^\s*\\/m.test(A) && !/create\s+(temp|temporary)\s+table/i.test(A), 'pasteable');
  const nums = [...MAN.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.equal(new Set(nums).size, nums.length);
  assert.ok(nums.indexOf('0211') > nums.indexOf('0208'), '0211 after 0208');   // release/1019: 0210 sits between
  assert.ok(nums.indexOf('0211') < nums.indexOf('0236'), 'before 0236');
  assert.deepEqual(nums.filter((n) => +n > 205), [...nums.filter((n) => +n > 205)].sort(), 'numeric order');
  const n = (DBT.match(/pg_temp\.res\('\d\d /g) || []).length;
  assert.match(RUNALL, new RegExp('run "trial-quotes-0211" "TRIAL-QUOTES-0211: ALL PASS \\\\\\(' + n + '/' + n + '\\\\\\)" psql -q -f tests/db/trial-quotes-0211\\.sql'));
  assert.match(DBT, /\\ir \.\.\/\.\.\/supabase\/migrations\/0211_trial_quotes_uncapped\.sql/, 'the suite re-applies 0211 (earlier suites re-apply 0173 / 0181)');
});

// r20 (owner): the 0211 "unlimited quotes" wording is gone again - 0238 caps quotes at 2 new; the current wording is
// asserted in test/r20-trial-quotes-cap.test.mjs. Here: nothing still says quotes are unlimited.
await t('trial wording: no screen says quotes / events are unlimited any more (0238 superseded 0211)', () => {
  const ctx = {}; ctx.window = ctx; ctx.globalThis = ctx; vm.runInContext(read('public/trial-facts.js'), vm.createContext(ctx));
  const all = JSON.stringify(ctx.HelmTrialFacts) + read('public/terms.html');
  assert.doesNotMatch(all, /as many quotes and events as you like|as many quotes and events as it likes|not limited in the trial/);
});

// ---- flow step 5: unselect a package (behaviour, extracted from flow.html) ---------------------------------
const FLOW = read('public/flow.html');
function flowPkg(state) {
  const a = FLOW.indexOf('  function renderPackages(){'), b = FLOW.indexOf('  // Dishes now live in the per-course dish editor');
  const c = FLOW.indexOf('  async function clearPackage(btn){'), d = FLOW.indexOf('  async function applyPackage(tid,btn){');
  assert.ok(a > 0 && b > a && c > b && d > c, 'sections found');
  const src = FLOW.slice(a, b) + FLOW.slice(c, d);
  const els = {};
  const mk = (id) => (els[id] = els[id] || { id, value: '', dataset: {}, _html: '', listeners: [],
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    querySelectorAll: () => [] });
  const $ = (sel) => mk(sel.replace(/^#/, ''));
  const calls = [];
  const env = Object.assign({ $, esc: (s) => String(s == null ? '' : s), inr: (n) => 'Rs' + n, rates: { platePrice: 450 }, loading: false, dirty: false,
    plan: null, planRow: null, packages: [], appliedPkg: null, id: 'Q1', calls,
    BPStore: { menuTemplates: { clear: async (q) => { calls.push('clear:' + q); return { cleared: true }; } } },
    BPUI: { guard: async (_b, fn) => fn(), toast: (m, o) => calls.push('toast:' + (o && o.type) + ':' + m), friendlyError: (e) => String(e && e.message) },
    renderPrice: () => calls.push('price'), updateAdvance: () => {}, saved: (k) => calls.push('saved:' + k), updateProgress: () => {}, applyPackage: (tid) => calls.push('apply:' + tid) }, state);
  const f = new Function('env', 'let {$, esc, inr, rates, loading, dirty, plan, planRow, packages, appliedPkg, id, BPStore, BPUI, renderPrice, updateAdvance, saved, updateProgress, applyPackage} = env;\n' + src +
    '\nreturn { renderPackages, clearPackage, st: () => ({ appliedPkg, plan, planRow, dirty }) };');
  return { api: f(env), els, calls };
}
await t('flow step 5: a "No package" card (selected when none), the chosen card is marked "click again to remove"', () => {
  const pk = [{ id: 'p1', name: 'Gold', diet: 'Veg', dishes: [1, 2], price_per_plate: 900 }, { id: 'p2', name: 'Silver', dishes: [], price_per_plate: 600 }];
  let h = flowPkg({ packages: pk, appliedPkg: null }); h.api.renderPackages();
  let html = h.els.pkgCards.innerHTML;
  assert.match(html, /class="pkgcard pkgnone on" data-none="1" aria-pressed="true"[\s\S]*<b>No package<\/b><div class="m">Decide later<\/div>/);
  assert.equal((html.match(/class="pkgcard /g) || []).length, 3, 'No package + 2 packages');
  h = flowPkg({ packages: pk, appliedPkg: pk[0] }); h.api.renderPackages(); html = h.els.pkgCards.innerHTML;
  assert.match(html, /class="pkgcard pkgnone " data-none="1" aria-pressed="false"/);
  assert.match(html, /class="pkgcard on" data-id="p1" aria-pressed="true" title="Selected - click again to remove the package"/);
  h = flowPkg({ packages: [], appliedPkg: null }); h.api.renderPackages();
  assert.match(h.els.pkgCards.innerHTML, /No menu packages set up yet/, 'no packages: no "No package" card either');
  // wiring: the none card or the chosen card -> clearPackage, any other -> applyPackage
  assert.match(FLOW, /if\(b\.dataset\.none==="1" \|\| \(appliedPkg && String\(appliedPkg\.id\)===String\(b\.dataset\.id\)\)\) clearPackage\(b\);\s*else applyPackage\(b\.dataset\.id,b\);/);
});
await t('flow step 5: clearing calls clear_menu_template, prices at the default plate price, keeps the notes, marks unsaved', async () => {
  const pk = [{ id: 'p1', name: 'Gold', dishes: [1], price_per_plate: 900 }];
  const h = flowPkg({ packages: pk, appliedPkg: pk[0], plan: { menu_template: 'Gold', package: 'Gold', menu_plate_price: 900, menu: 'notes' }, planRow: { package: 'Gold', menu: 'notes' } });
  h.els.p_menu = { dataset: { pkg: 'Gold' }, value: 'notes' }; h.els.q_platePrice = { value: '900', dataset: {} };
  await h.api.clearPackage(null);
  const st = h.api.st();
  assert.equal(st.appliedPkg, null); assert.equal(h.els.p_menu.dataset.pkg, undefined); assert.equal(h.els.p_menu.value, 'notes', 'menu notes untouched');
  assert.deepEqual([st.plan.menu_template, st.plan.package, st.plan.menu_plate_price, st.plan.menu], [null, null, null, 'notes']);
  assert.equal(st.planRow.package, null); assert.equal(st.planRow.menu, 'notes');
  assert.equal(h.els.q_platePrice.value, 450, 'default plate price (Control Center)');
  assert.equal(st.dirty, true, 'the saved quotation still has the package price -> unsaved');
  assert.deepEqual(h.calls.filter((c) => !/^toast/.test(c)), ['clear:Q1', 'price', 'saved:menu']);
  assert.match(h.calls.find((c) => /^toast:ok:/.test(c)), /No package for now\. Catering uses your default plate price; the dishes below stay/);
  // nothing chosen -> nothing called; a locked menu -> refused before the server
  const h2 = flowPkg({ packages: pk, appliedPkg: null }); h2.els.p_menu = { dataset: {} }; await h2.api.clearPackage(null); assert.deepEqual(h2.calls, []);
  const h3 = flowPkg({ packages: pk, appliedPkg: pk[0], plan: { menu_locked: true } }); h3.els.p_menu = { dataset: { pkg: 'Gold' } };
  await h3.api.clearPackage(null); assert.deepEqual(h3.calls, ['toast:err:The menu is locked. Unlock it to change the package.']);
  // a server refusal is shown, the package stays
  const h4 = flowPkg({ packages: pk, appliedPkg: pk[0], BPStore: { menuTemplates: { clear: async () => { throw new Error('menu is locked'); } } } });
  h4.els.p_menu = { dataset: { pkg: 'Gold' } }; await h4.api.clearPackage(null);
  assert.equal(h4.api.st().appliedPkg, pk[0]); assert.ok(h4.calls.some((c) => c === 'toast:err:menu is locked'));
});

await t('store: menuTemplates.clear -> clear_menu_template RPC (missing RPC = a clear message); local mode clears the plan row', () => {
  const S = read('public/store-api.js');
  const m = S.slice(S.indexOf('    async clear(quoteId) {'), S.indexOf('  /* ---------------- organization / studio (Phase 58)'));
  assert.match(m, /try \{ return await rpc\("clear_menu_template", \{ p_quote: quoteId \}\); \}/);
  assert.match(m, /e\.code === "PGRST202" \|\| e\.code === "42883"/);
  assert.match(m, /row\.package = null; row\.menu_template = null; row\.menu_plate_price = null;/);
  assert.doesNotMatch(m, /bp_event_menu/, 'local mode keeps the dishes too');
});

await t('builder: "No package…" un-applies (no more "can be changed but not removed"), default plate price, pricing forgets the name', () => {
  const B = read('public/builder.js');
  assert.doesNotMatch(B, /A package can be changed but not removed here/);
  const fn = B.slice(B.indexOf('async function onPickPackage(){'), B.indexOf('// Render the live price breakdown panel'));
  assert.match(fn, /if\(!tid\)\{[\s\S]*await BPStore\.menuTemplates\.clear\(currentQuoteId\);[\s\S]*PRICING\.appliedPkgId=''; PRICING\.menuPackageName=null;[\s\S]*PRICING\.menuPlatePrice = PRICING\.platePrice!=null \? \+PRICING\.platePrice : null;[\s\S]*pkgCleared=true;[\s\S]*renderAll\(\); syncQuotePricing\(\); return;/);
  assert.match(fn, /catch\(e\)\{ const sel=\$\('#bPkg'\); if\(sel\) sel\.value=prev\.id\|\|'';/, 'refused -> the select goes back');
  assert.match(fn, /pkgCleared=false;\s*PRICING\.appliedPkgId=tid;/, 'picking a package again');
  assert.match(B, /\.\.\.\(pkgCleared \? \{ _packageName: undefined \} : \{\}\),/);
  assert.match(B, /'<option value="">No package…<\/option>'/);
  // behaviour: the pricing object no longer names the old package once cleared (JSON drops undefined)
  const o = Object.assign({}, { _packageName: 'Gold', platePrice: 900 }, { platePrice: 450 }, true ? { _packageName: undefined } : {});
  assert.deepEqual(JSON.parse(JSON.stringify(o)), { platePrice: 450 });
});

await t('step 1: the client e-mail field is marked required next to name and phone', () => {
  assert.match(FLOW, /<input id="c_email" type="email" autocomplete="email" required>/);
  assert.match(FLOW, /<input id="c_name" required>/); assert.match(FLOW, /<input id="c_phone" type="tel" inputmode="tel" required>/);
  assert.match(read('public/flow-validate.js'), /put\(r, "c_email", email\(v\.c_email, \{ required: true \}\)\);/);
});

console.log(`r19-quotes-flow: ${fail ? fail + ' failed, ' : 'all '}${pass} passed`);
if (fail) process.exit(1);
