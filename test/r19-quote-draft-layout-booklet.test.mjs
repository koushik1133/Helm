// r19-quote-draft-layout-booklet.test.mjs - live production QA r19:
//  L1  "New quote" never reuses a draft with something in it (0220 start_blank_quote) and never one whose floor plan
//      is still unsaved in this browser (store-api startBlank + bps.draft.<user>.<quote>)
//  L2  "Generate default layout" (?gen=1) is unsaved until a version is written; "Save & back to quote" writes a
//      version whenever the canvas differs from the stored one (count + hash), and only leaves after it exists
//  L11 the booklet turns the floor plan + 3D view on once the layout has objects; the Share window shows switches
// DB behaviour: tests/db/start-blank-0220.sql (scripts/db-test/run-all.sh).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const api = read('public/store-api.js'), bjs = read('public/builder.js'), flow = read('public/flow.html');
const bks = read('public/booklet-share.js'), sck = read('public/share-checklist.js');
const sql = read('supabase/migrations/0220_start_blank_untouched.sql'), apply = read('supabase/APPLY-0220.sql');

// ---- L1 -------------------------------------------------------------------------------------------
function memStore(obj) { const m = new Map(Object.entries(obj || {}));
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null) }; }
const fnSrc = api.slice(api.indexOf('function hasLocalLayoutDraft('), api.indexOf('  const sbq = {'));
const ctx = {}; vm.createContext(ctx); vm.runInContext(fnSrc + '\nthis.f = hasLocalLayoutDraft;', ctx);
const has = ctx.f;
t('L1: hasLocalLayoutDraft finds an unsaved plan with objects for THIS quote only', () => {
  const plan = JSON.stringify({ savedAt: 'x', baseVersion: 1, data: { items: [{ id: 'a' }, { id: 'b' }] } });
  const empty = JSON.stringify({ data: { items: [] } });
  assert.equal(has('q-1', memStore({ 'bps.draft.u1.q-1': plan })), true);
  assert.equal(has('q-1', memStore({ 'bps.draft.u1.q-12': plan })), false, 'another quote whose id ends the same');
  assert.equal(has('q-1', memStore({ 'bps.draft.u1.q-1': empty })), false, 'an empty draft is not a plan');
  assert.equal(has('q-1', memStore({ 'bps.draft.u1.q-1': '{oops' })), false, 'unreadable draft');
  assert.equal(has('q-1', memStore({ 'other.q-1': plan })), false);
  assert.equal(has('', memStore({ 'bps.draft.u1.': plan })), false);
  assert.equal(has('q-1', { get length() { throw new Error('blocked'); } }), false, 'blocked storage');
});
t('L1: startBlank never returns a quote with an unsaved local plan (creates a new one instead)', () => {
  const fn = api.slice(api.indexOf('async startBlank(code) {'), api.indexOf('async rebrandCode('));
  assert.match(fn, /if \(row && row\.id && hasLocalLayoutDraft\(row\.id\)\) return this\.create\(code, code, null, \{ items: \[\] \}, 0\);\s*return row;/);
  assert.match(bjs, /const draftKey = id=>'bps\.draft\.'\+userKey\(\)\+'\.'\+id;/, 'same key shape as the builder');
});
t('L1: 0220 start_blank_quote keeps signature + gates + lock and checks the locked row with the strict helper', () => {
  const fn = sql.slice(sql.indexOf('create or replace function public.start_blank_quote'), sql.indexOf('revoke all on function public.start_blank_quote'));
  assert.match(fn, /start_blank_quote\(p_code text, p_title text default null\)/);
  assert.match(fn, /has_area\('quotes', 'edit'\)/); assert.match(fn, /can_create\(\)/);
  assert.match(fn, /pg_advisory_xact_lock\(hashtextextended\('helm:blankq:' \|\| v_org::text \|\| ':' \|\| v_uid::text, 0\)\)/);
  assert.match(fn, /for update of x;[\s\S]*_blank_quote_touched_reason\(q\.id, v_uid\) is null then return q;/);
  assert.doesNotMatch(fn, /\bupdate\s+public\.quotes\b/i, 'never changes an existing quote');
  const h = sql.slice(sql.indexOf('create or replace function public._blank_quote_touched_reason'), sql.indexOf('revoke all on function public._blank_quote_touched_reason'));
  for (const c of ["return 'title'", "return 'event_type'", "return 'client'", "return 'pricing.'", "return 'layout'", "return 'versions'",
    "'has:' || t.tbl", "'unreadable:' || t.tbl", "'quote_flow_progress'", "'audit_log'", "approval_token is not null"])
    assert.ok(h.includes(c), 'touched rule: ' + c);
});
t('L1/L11: 0220 is additive (no row written / deleted by the file), ASCII, APPLY verbatim + VERIFY, suite registered', () => {
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(sql), 'ASCII'); assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(apply), 'ASCII');
  const top = sql.replace(/\$\$[\s\S]*?\$\$/g, '');   // outside function / DO bodies
  assert.ok(!/^\s*(update|delete|truncate|insert)\b/im.test(top), 'no top-level row write');
  assert.doesNotMatch(sql, /\bdrop\s+(table|column|function)\b|\btruncate\b|\bdelete\s+from\b/i);
  assert.ok(apply.includes(sql.trim()), 'APPLY carries the migration'); assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m);
  assert.match(apply, /-- VERIFY \(every row must say ok = true\)\nselect item, ok from \(values/);
  assert.ok(!/^\s*\\/m.test(apply) && !/\bcreate\s+(temp|temporary)\s+table\b/i.test(apply), 'pasteable');
  const man = read('supabase/migrations/MANIFEST');
  const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.equal(nums.filter((n) => n === '0220').length, 1);
  assert.ok(nums.indexOf('0208') < nums.indexOf('0220') && nums.indexOf('0220') < nums.indexOf('0236'), 'numeric order');
  assert.match(read('scripts/db-test/run-all.sh'), /run "start-blank-0220" "START-BLANK-0220: ALL PASS \\\(48\/48\\\)" psql -q -f tests\/db\/start-blank-0220\.sql/);
});

// ---- L2 -------------------------------------------------------------------------------------------
const lctx = { window: {} }; vm.createContext(lctx); vm.runInContext(read('public/flow-layout-sync.js'), lctx);
const L = lctx.window.HelmFlowLayout;
t('L2: layoutKey / hash: same content -> same key; any change -> different key', () => {
  const a = L.layoutKey(51, '[[{"id":"x"}],null]'), b = L.layoutKey(51, '[[{"id":"x"}],null]'), c = L.layoutKey(51, '[[{"id":"y"}],null]');
  assert.deepEqual(a, b); assert.notEqual(a.hash, c.hash); assert.equal(L.layoutKey(-3, '').count, 0); assert.equal(L.layoutKey('7', '').count, 7);
});
t('L2: needsVersion - a generated layout over a stored empty V1 must be written; an unchanged one not', () => {
  const stored = L.layoutKey(0, 'empty'), gen = L.layoutKey(51, 'generated');
  assert.equal(L.needsVersion(stored, gen, false), true, 'the bug: 51 objects marked "Saved" over a 0-object V1');
  assert.equal(L.needsVersion(stored, L.layoutKey(0, 'empty'), false), false, 'unchanged -> no phantom version');
  assert.equal(L.needsVersion(L.layoutKey(5, 'a'), L.layoutKey(5, 'b'), false), true, 'same count, different content');
  assert.equal(L.needsVersion(L.layoutKey(5, 'a'), L.layoutKey(5, 'a'), true), true, 'a pending edit always saves');
  assert.equal(L.needsVersion(null, L.layoutKey(3, 'a'), false), true, 'stored copy unknown + objects -> save');
  assert.equal(L.needsVersion(null, L.layoutKey(0, 'a'), false), false, 'never an untouched empty canvas over an unknown layout');
  assert.equal(L.needsVersion(null, null, true), false);
});
t('L2: Save & back writes a version when the canvas differs from the stored one and leaves only once it exists', () => {
  const fn = bjs.slice(bjs.indexOf('async function saveAndBackToFlow()'), bjs.indexOf('$(\'#loadBtn\')'));
  assert.match(fn, /HelmFlowLayout\.needsVersion\(storedKey, canvasKey\(\), dirty\.isDirty\(\)\)/);
  assert.match(fn, /const ok = !need \? true : await saveLayout\(false\);\s*\n\s*if\(!ok\) return;/);
  assert.match(fn, /HelmFlowLayout\.needsVersion\(storedKey, canvasKey\(\), false\)\)\{\s*\n[^\n]*return; \}/, 'still differs -> stay');
  assert.match(fn, /if\(!RO\) await syncQuotePricingNow\(\);[^\n]*\n\s*location\.href = HelmFlowLayout\.returnUrl\(currentQuoteId\);/);
  assert.match(bjs, /const v = await BPStore\.quotes\.addVersion\(currentQuoteId, label, data, store\.items\.length\);\s*\n\s*currentVersionNo = v\.version_no \|\| v\.versionNo;\s*\n\s*noteStoredVersion\(sentKey\);/);
  assert.match(bjs, /storedKey = ver\.missing \? null : canvasKey\(\);/, 'opened version = stored');
  assert.match(bjs, /function loadVersionIntoEditor\(no, data\)\{\s*\n\s*applyLayout\(data\);[^\n]*\n\s*noteStoredVersion\(\);/);
});
t('L2: ?gen=1 default layout is "Unsaved changes" (never "Saved"), and the Custom event builder window does not open over it', () => {
  // r20: the quiet default on a brand-new quote is unsaved too (it is not the stored V1)
  assert.match(bjs, /_autoDefaultLoaded=true;[\s\S]{0,700}resetHistory\(\); markGenUnsaved\(\); renderAll\(\);/);
  assert.match(bjs, /exactSeats\(store\.items, N\); resetHistory\(\); markGenUnsaved\(\); renderAll\(\);/);
  assert.match(bjs, /function markGenUnsaved\(\)\{[^\n]*dirty\.mark\(\); renderSaveState\('dirty'\); \}/);
  const gen = bjs.slice(bjs.indexOf("if(params.get('gen')==='1' && CAN_CREATE!==false){"), bjs.indexOf('MOBILE DRAWERS'));
  assert.match(gen, /if\(_autoDefaultLoaded\)\{ toast\('Default layout ready[^']*'\); \}\s*\n\s*else \{\s*\n\s*openCustomModal\(\);/);
  assert.doesNotMatch(gen.slice(0, gen.indexOf('if(_autoDefaultLoaded){ toast')), /openCustomModal\(\)/, 'no unconditional open');
});
t('L2: the flow says so when it comes back without a saved layout', () => {
  assert.match(flow, /const noLayout=!layoutItems\.length;/);
  assert.match(flow, /no floor layout is saved for this quote yet/);
  assert.match(flow, /Layout updated — quotation recalculated/);
});

// ---- L11 ------------------------------------------------------------------------------------------
t('L11: store-api booklet.layoutAutoOn / setSections call the 0220 RPCs (missing RPC -> null)', () => {
  assert.match(api, /layoutAutoOn: \(quoteId\) => \(supa \? rpc\("booklet_layout_auto_on", \{ p_quote_id: quoteId \}\)\.catch\(\(e\) => \{ if \(rpcMissing\(e\)\) return null; throw e; \}\)/);
  assert.match(api, /setSections: \(quoteId, sections\) => \{[^\n]*\n[^\n]*for \(const k of BOOKLET_SECTIONS\)[^\n]*\n\s*return supa \? rpc\("booklet_set_sections", \{ p_quote_id: quoteId, p_sections: sec \}\)/);
});
const bctx = { window: {}, document: null }; bctx.globalThis = bctx; vm.createContext(bctx);
vm.runInContext(bks, bctx);
const BS = bctx.window.HelmBookletShare;
t('L11: Share window - live link sections as switches (floor plan + 3D view included); none before 0220', () => {
  assert.equal(BS.liveSections({}), null);
  const s = BS.liveSections({ sections: { layout2d: false, layout3d: true, menu: true } });
  assert.equal(s.layout2d, false); assert.equal(s.layout3d, true); assert.equal(s.terms, true, 'missing = shown');
  assert.equal(JSON.stringify(BS.LIVE_SECTIONS.map((x) => x[0]).slice(4, 6)), '["layout2d","layout3d"]');
  // r21: the Send box is folded into "Send the booklet link on its own" while the same dialog makes the approval link
  assert.match(bks, /mountSections\(box, quoteId, cur\);[\s\S]{0,700}?mountSend\(more, quoteId, cur, url\); \}\s*else mountSend\(box, quoteId, cur, url\);/);
  assert.match(bks, /await st\.booklet\.setSections\(quoteId, \{ \[x\[0\]\]: want \}\)/);
  assert.match(bks, /cb\.checked = !want;/, 'failed save puts the switch back');
});
t('L11: opening the Share window first turns the floor plan + 3D view on (server-checked), then reads the link', () => {
  const ld = bks.slice(bks.indexOf('async function load(quoteId)'), bks.indexOf('async function openFor('));
  assert.ok(ld.indexOf('B.layoutAutoOn(quoteId)') > 0 && ld.indexOf('B.layoutAutoOn(quoteId)') < ld.indexOf('booklet.current(quoteId)'));
  assert.match(bks, /Floor plan and 3D view are now shown/);
  assert.match(sck, /added to this link automatically once a layout is saved/);
  const card = sck.slice(sck.indexOf('async function renderCard(card)'), sck.indexOf('const ck = mount(body, { quoteId: quoteId, cur: cur });'));
  assert.ok(card.indexOf('st.booklet.layoutAutoOn(quoteId)') > 0 && card.indexOf('st.booklet.layoutAutoOn(quoteId)') < card.indexOf('st.booklet.current(quoteId)'), 'flow share card too');
});
t('L11: 0220 auto-on only for a live link made on an empty layout, both off, nobody switched sections; trigger never fails a save', () => {
  const f = sql.slice(sql.indexOf('create or replace function public._bk220_layout_auto_on'), sql.indexOf('revoke all on function public._bk220_layout_auto_on'));
  assert.match(f, /b\.revoked_at is not null or b\.expires_at <= now\(\) then return false;/);
  assert.match(f, /if b\.sections_set_at is not null then return false;/);
  assert.match(f, /= 'true' or coalesce\(b\.sections ->> 'layout3d', 'true'\) = 'true' then\s*\n\s*return false;/);
  assert.match(f, /v\.created_at <= b\.created_at/);
  assert.match(f, /set sections = x\.sections \|\| '\{"layout2d": true, "layout3d": true\}'::jsonb/);
  const tg = sql.slice(sql.indexOf('create or replace function public._bk220_tg_layout_auto_on'), sql.indexOf('revoke all on function public._bk220_tg_layout_auto_on'));
  assert.match(tg, /exception when others then\s*\n\s*null;/);
  assert.match(sql, /create trigger zzzz_bk220_layout_auto_on after insert on public\.quote_versions/);
  const ss = sql.slice(sql.indexOf('create or replace function public.booklet_set_sections'), sql.indexOf("do $$ declare s text; begin\n  foreach s in array array['public.booklet_layout_auto_on(uuid)'"));
  assert.match(ss, /_booklet_staff_quote\(p_quote_id, true\)/); assert.match(ss, /sections_set_at = now\(\)/);
  assert.doesNotMatch(ss, /token\s*=/, 'same link: the token is never changed');
});

let pass = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`r19-quote-draft-layout-booklet: ${pass} passed${pass === tests.length ? '' : ', ' + (tests.length - pass) + ' FAILED'}`);
if (pass !== tests.length) process.exit(1);
