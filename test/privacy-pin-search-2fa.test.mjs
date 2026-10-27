// Owner requests Oct 2026 (0157):
//  (1) "Hide amounts" PIN: one per studio, kept on the server as a bcrypt hash, default 0000, only admins change it.
//  (2) Universal smart settings search in Settings (synonyms, typos, roles, pages, account items, keyboard).
//  (3) Two-step sign-in: optional for every role from Account settings; only admins are ever reminded.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ---------------------------------------------------------------- (1) privacy PIN */
const SQL = r('supabase/migrations/0157_privacy_pin.sql');
t('0157 SQL: additive, idempotent, ASCII, ends with VERIFY', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(SQL), 'ASCII only');
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.ok(!/\bdrop\s+(table|column|schema|function)\b/i.test(code), 'no DROP');
  assert.ok(!/\bdelete\s+from\b|\btruncate\b/i.test(code), 'no DELETE / TRUNCATE');
  assert.match(SQL, /create table if not exists public\.privacy_pin \(/);
  assert.match(SQL, /create table if not exists public\.privacy_pin_attempts \(/);
  assert.match(SQL, /enable row level security/);
  assert.match(SQL, /select item, ok from \(values[\s\S]*\) v\(item, ok\);\s*$/);
  assert.match(r('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0157_privacy_pin\.sql\n/);
  const apply = r('supabase/APPLY-0157.sql');
  assert.ok(apply.includes(SQL.trim()), 'APPLY-0157 carries the migration verbatim');
  assert.match(apply, /^-- APPLY-0157\.sql[\s\S]*\nbegin;\n[\s\S]*\ncommit;\n$/);
});
t('0157 SQL: bcrypt hash only, default 0000, admin-only change/reset, server lockout', () => {
  assert.match(SQL, /extensions\.crypt\(p_new, extensions\.gen_salt\('bf', 8\)\)/);
  assert.match(SQL, /if v_hash is null then return p_pin = '0000'; end if;/);
  const fn = (name) => SQL.match(new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?end \\$\\$;'))[0];
  assert.match(fn('privacy_pin_set'), /if not coalesce\(public\.is_admin\(\), false\) then/);
  assert.match(fn('privacy_pin_set'), /if not public\._pp_matches\(v_org, p_current\) then/, 'change needs the current PIN');
  assert.match(fn('privacy_pin_reset'), /if not coalesce\(public\.is_admin\(\), false\) then/);
  assert.match(fn('privacy_pin_reset'), /interval '15 minutes'/, 'reset only right after signing in');
  assert.match(fn('privacy_pin_reset'), /update public\.privacy_pin set pin_hash = null/, 'reset = update, no delete');
  assert.match(fn('_pp_fail'), /if r\.fails >= 5 then/);
  assert.match(fn('privacy_pin_status'), /'is_default', v_hash is null/);
  assert.doesNotMatch(fn('privacy_pin_status'), /'pin_hash'/, 'the hash never leaves the server');
  for (const f of ['privacy_pin_status()', 'privacy_pin_check(text)', 'privacy_pin_set(text,text)', 'privacy_pin_reset()'])
    assert.ok(SQL.includes("'public." + f + "'"), f + ' granted / revoked explicitly');
  assert.match(r('scripts/db-test/run-all.sh'), /PRIVACY-PIN-0157: ALL PASS \\\(30\/30\\\)/);
});
t('store-api: BPStore.privacyPin wraps the four RPCs; null before 0157', () => {
  const s = r('public/store-api.js');
  assert.match(s, /privacyPin: \{\n\s+status: \(\) => \(supa \? rpc\("privacy_pin_status"\)\.catch\(\(e\) => \{ if \(rpcMissing\(e\)\) return null; throw e; \}\)/);
  assert.match(s, /check: \(pin\) => \(supa \? rpc\("privacy_pin_check", \{ p_pin:/);
  assert.match(s, /set: \(current, next\) => rpc\("privacy_pin_set", \{ p_current:/);
  assert.match(s, /reset: \(\) => rpc\("privacy_pin_reset", \{\}\)/);
  assert.match(s, /\|telemetry\|privacy_pin_\(\?:check\|status\)(?:\|link_expiry_shelf_tick)?\)\/;/, 'a PIN check does not drop the read cache');
});
const PRIV = r('public/shell-b-privacy.js');
t('shell-b-privacy: unlock is checked on the server; no PIN in the browser; default 0000 fallback', () => {
  assert.match(PRIV, /var a = pinApi\(\), r = a \? await a\.check\(pin\) : null;/);
  assert.match(PRIV, /if \(!r\) return \{ ok: String\(pin\) === DEFAULT_PIN, local: true \};/);
  assert.match(PRIV, /var DEFAULT_PIN = "0000";/);
  assert.doesNotMatch(PRIV, /savePin|PBKDF2|helm\.priv\.pin\.|crypto\.subtle/);
  assert.match(PRIV, /if \(res\.lock > 0\) \{ shake\("Wrong PIN\."\); lockFor\(res\.lock\); return; \}/, 'server lockout shown');
  assert.match(PRIV, /shake\("Couldn't check the PIN\. Check your connection and try again\."\)/, 'network error is not a wrong PIN');
});
t('shell-b-privacy: only admins are sent to change the PIN; others are told to ask their admin', () => {
  assert.match(PRIV, /var PIN_PAGE = "\/control\.html#privacy-pin";/);
  assert.match(PRIV, /Only a studio admin can change or reset it/);
  assert.match(PRIV, /ok\.textContent = canChangePin\(\) \? "Open Settings" : "Back";/);
  assert.match(PRIV, /\{ id: "hbp-pin", label: "Change studio privacy PIN", [^\n]*need: \[\["view", "controls"\]\]/);
  assert.doesNotMatch(PRIV, /step === "set"|step === "confirm"|step === "change-old"|step === "reset"/, 'no local set / reset flow any more');
});
t('Settings card: admin form, everyone else read-only; CSP-safe markup', () => {
  const h = r('public/control.html');
  const card = h.match(/<div class="card" id="privPinCard" hidden>[\s\S]*?\n    <\/div>\n/)[0];
  assert.doesNotMatch(card, /style=|\son[a-z]+=/i, 'no inline styles / handlers');
  for (const id of ['pp_cur', 'pp_new', 'pp_new2']) assert.match(card, new RegExp('<input id="' + id + '" type="password" inputmode="numeric" maxlength="4"'));
  assert.match(card, /<div id="pp_form" hidden>/);
  assert.match(h, /<script src="privacy-pin-settings\.js\?v=\d+"><\/script>/);
  assert.match(r('public/control-split.js'), /if\(id==="privPinCard"\) return "privacy";/);
});
t('privacy-pin-settings: validation + state text', () => {
  const m = { exports: {} }; const cx = { module: m, globalThis: {}, document: undefined };
  // file exits early without a document: load the pure helpers by evaluating with a stub document
  const doc = { readyState: 'complete', getElementById: () => null, addEventListener() {} };
  const g = { document: doc, setTimeout: () => 0 };
  vm.runInNewContext(r('public/privacy-pin-settings.js'), { window: g, document: doc, setTimeout: () => 0 });
  const P = g.HelmPrivacyPinSettings;
  assert.equal(P.validate('0000', '4826', '4826'), '');
  assert.match(P.validate('00', '4826', '4826'), /current 4-digit PIN/);
  assert.match(P.validate('0000', '48a6', '48a6'), /exactly 4 digits/);
  assert.match(P.validate('0000', '4826', '4827'), /don't match/);
  assert.match(P.validate('4826', '4826', '4826'), /same as the current/);
  assert.match(P.stateText({ is_default: true, can_change: true }), /default \(0000\)/);
  assert.match(P.stateText({ is_default: false, can_change: false }), /Ask your studio admin/);
  assert.match(P.stateText(null), /database update \(0157\)/);
  void cx;
});

/* ---------------------------------------------------------------- (2) smart settings search */
const S = require('../public/settings-search-core.js');
const CS = r('public/control-split.js');
const grab = (name) => vm.runInNewContext('(' + CS.match(new RegExp('var ' + name + '=(\\[[\\s\\S]*?\\n  \\]);'))[1] + ')',
  { openAcc() {}, window: {} });
// pages + account items moved to search-catalog.js (shared with the global palette; pages are role-gated there)
const CAT = require('../public/search-catalog.js');
const SECTIONS = grab('SECTIONS'), PAGES = CAT.PAGES.filter((p) => !/^control/.test(p.href)).map((p) => ({ text: p.label, href: p.href, kw: p.kw })), ACCOUNT = CAT.ACCOUNT;
const ENTRIES = [
  ...SECTIONS.map((s) => ({ id: 'sec:' + s.key, text: s.label, context: s.group, keywords: s.desc + ' ' + s.kw, boost: 0.05 })),
  ...ACCOUNT.map((a) => ({ id: 'acc:' + a.text, text: a.text, context: 'Your account', keywords: a.kw })),
  ...PAGES.map((p) => ({ id: 'page:' + p.href, text: p.text, context: 'Page', keywords: p.kw })),
  // a few real card labels from control.html
  { id: 'lbl:gstin', text: 'GSTIN (optional)', context: 'General Organization / studio' },
  { id: 'lbl:pincode', text: 'PIN code *', context: 'General Billing details' },
  { id: 'lbl:invite', text: 'Invite by email link', context: 'Users & invites Invite by email link' },
  { id: 'role:coordinator', text: 'Role: Coordinator', context: 'Roles & access', keywords: 'role access permission coordinator' },
];
const top = (q) => (S.rank(q, ENTRIES, 5)[0] || {}).id;
const inTop = (q, id, n = 3) => S.rank(q, ENTRIES, n).some((e) => e.id === id);
t('search: owner examples land on the right setting', () => {
  assert.equal(top('pin'), 'sec:privacy');
  assert.equal(top('hide money'), 'sec:privacy');
  assert.equal(top('privacy pin'), 'sec:privacy');
  assert.ok(inTop('whatsapp', 'sec:reminders'), 'whatsapp -> reminders & WhatsApp');
  assert.ok(inTop('whatsapp', 'page:integrations.html', 4), 'whatsapp -> integrations page');
  assert.ok(inTop('gst', 'lbl:gstin'), 'gst -> GSTIN');
  assert.ok(inTop('tax', 'lbl:gstin', 5) || inTop('tax', 'sec:general', 5), 'tax -> GST');
  assert.ok(inTop('staff invite', 'lbl:invite') || inTop('staff invite', 'sec:users'), 'staff invite -> invites');
  assert.equal(top('2fa'), 'acc:Two-step sign-in (2FA)');
  assert.equal(top('two step'), 'acc:Two-step sign-in (2FA)');
  assert.equal(top('mfa'), 'acc:Two-step sign-in (2FA)');
});
t('search: typos still find it', () => {
  assert.ok(inTop('whatsap', 'sec:reminders'));
  assert.equal(top('notifcations'), 'sec:notify');
  assert.ok(inTop('pasword', 'acc:Change password'));
  assert.ok(inTop('cupons', 'sec:pricing'));
  assert.ok(inTop('venu', 'sec:venues'));
  assert.ok(inTop('cordinator', 'role:coordinator'));
  assert.ok(inTop('subscripton', 'sec:billing'));
});
t('search: nonsense finds nothing; every word must match; ranges mark whole words', () => {
  assert.equal(S.rank('qqzzxx', ENTRIES).length, 0);
  assert.equal(S.rank('venues qqzzxx', ENTRIES).length, 0);
  assert.deepEqual(S.ranges('Hide amounts (privacy PIN)', 'hide money'), [[0, 4], [5, 12], [14, 21]]);
  assert.equal(S.distance('whatsap', 'whatsapp', 2), 1);
  assert.equal(S.distance('notifcations', 'notifications', 2), 1);
  assert.equal(S.distance('ab', 'ba', 1), 1, 'a swap is one typo');
  assert.equal(S.normalize('Two-step E-mail Whats App'), 'twostep email whatsapp');
});
t('search UI: ARIA combobox, keyboard, roles + pages + account items, CSP-safe', () => {
  assert.match(CS, /qi\.setAttribute\("role","combobox"\); qi\.setAttribute\("aria-autocomplete","list"\); qi\.setAttribute\("aria-expanded","false"\)/);
  assert.match(CS, /b\.setAttribute\("role","option"\); b\.id="csOpt"\+i;/);
  assert.match(CS, /q\.setAttribute\("aria-activedescendant",opts\[active\]\.id\)/);
  assert.match(CS, /if\(e\.key==="ArrowDown"\)/); assert.match(CS, /if\(e\.key==="ArrowUp"\)/);
  assert.match(CS, /if\(e\.key==="Enter"\)\{ if\(open\)\{ e\.preventDefault\(\); jump\(hits\[active>=0\?active:0\]\); \}/);
  assert.match(CS, /if\(e\.key==="Escape"\)/);
  assert.match(CS, /live\.setAttribute\("aria-live","polite"\)/, 'result count announced');
  assert.match(CS, /querySelectorAll\("#roleTabs \.rtab"\)/, 'roles are searchable');
  assert.match(CS, /var ranked=CAT\?CAT\.rank\(v,list,SSC,60\):SSC\?SSC\.rank\(v,list,60\):plainRank\(v,list\);/, 'falls back if the core did not load');
  assert.doesNotMatch(CS, /innerHTML|\.style\./, 'DOM API only, no inline styles');
  const h = r('public/control.html');
  assert.ok(h.indexOf('settings-search-core.js') < h.indexOf('control-split.js'), 'core loads before the page search');
  assert.match(r('public/control-split.css'), /\.cs-results \.cs-opt\[aria-selected="true"\]/);
});

/* ---------------------------------------------------------------- (3) two-step sign-in */
const AUI = r('public/auth-ui.js');
t('two-step: only admins are reminded / forced; everyone can turn it on in Account settings', () => {
  const fn = AUI.match(/function adminTwoStep\(\) \{[\s\S]*?\n  \}\n/)[0];
  assert.match(fn, /if \(role !== "admin"\) return;/, 'non-admins: no nudge, no forced set-up');
  assert.ok(fn.indexOf('role !== "admin"') < fn.indexOf('forceEnroll()'), 'role check comes before forced enrolment');
  assert.match(AUI, /var mf = el\("div", \{ class: "hau-sec", id: "hauMfaSec" \}\);/);
  assert.match(AUI, /var jumpTo = \{ mfa: mf, password: pw, devices: dv \}\[opts && opts\.focus\];/);
  assert.match(CS, /\(CAT\?CAT\.ACCOUNT:\[\]\)\.map\(function\(a\)\{ return \{text:a\.text,kw:a\.kw,run:function\(\)\{ openAcc\(a\.open\); \}\}; \}\)/);
  assert.deepEqual(CAT.ACCOUNT.find((a) => a.id === 'mfa').open, { section: 'settings', focus: 'mfa' });
  const gs = r('public/getting-started.js');
  assert.match(gs, /\.filter\(\(s\) => s\.key !== "mfa" \|\| data\.admin === true\)/, 'no checklist nudge for non-admins');
});

let pass = 0;
for (const [name, fn] of tests) { try { fn(); pass++; console.log('ok - ' + name); } catch (e) { console.error('FAIL - ' + name + '\n  ' + (e && e.message)); process.exitCode = 1; } }
console.log(`privacy-pin-search-2fa: ${pass}/${tests.length} passed`);
