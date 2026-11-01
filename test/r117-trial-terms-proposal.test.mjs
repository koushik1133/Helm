// r117-trial-terms-proposal.test.mjs - R117 (owner approved):
//   1  the AGREED free-trial terms say "nothing is sent to clients" (trial-facts.js + terms.html), new VERSION
//      trial-2026-11-01 = _trial_terms_version() in 0325 -> trial owners re-accept through the existing window
//   2  the approval page's trial preview of clause "4. Consent" says "By entering the test code (trial simulation)"
//   3  proposal page trial banner: trial-sim.js refFrom("proposal") + public_trial_simulation_for_proposal (0325)
//   4  booklet: a TEST-paid milestone shows REMAINING "— (test)"; flow step 10 banner has no duplicated "SIMULATION"
// Static + pure-function checks; the database side: tests/db/r117-trial-terms-proposal-0325.sql. Paid studios unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const F = require('../public/trial-facts.js');
const TS = require('../public/trial-sim.js');
const TN = require('../public/trial-test-note.js');
const AT = require('../public/approve-test-mode.js');
const MIG = read('supabase/migrations/0325_r117_trial_terms_proposal.sql');

// ---- 1 terms -----------------------------------------------------------------------------------------------------
t('1 VERSION trial-2026-10-20 -> trial-2026-11-01, the same constant in 0325 _trial_terms_version()', () => {
  assert.equal(F.VERSION, 'trial-2026-11-01');
  assert.match(MIG, new RegExp("select '" + F.VERSION + "'::text;"));
  assert.match(read('public/trial-facts.js'), /0325 \(trial-2026-11-01, owner R117\)/);
});
t('1 "What you can do": the e-mail item is now a simulation (no "really reach")', () => {
  const can = F.SECTIONS.find((s) => s.id === 'can').items;
  assert.ok(!can.some((i) => i.t === 'E-mail your clients'));
  const sim = can.find((i) => i.t === 'Try sending to clients (simulation)');
  assert.ok(sim, 'new item');
  assert.match(sim.s, /nothing is sent to clients in the trial/);
  assert.match(sim.s, /test code 000000/);
  assert.match(sim.s, /TEST receipts, no real money/);
  assert.match(sim.s, /Your own account e-mails \(welcome, security, login codes, billing, teammate invites\) still arrive/);
});
t('1 "Locked in the trial": WhatsApp, SMS and online payment links - no code is sent, payments simulated', () => {
  const lk = F.SECTIONS.find((s) => s.id === 'locked').items.find((i) => i.t === 'WhatsApp, SMS and online payment links');
  assert.equal(lk.s, 'They unlock on a paid plan. In the trial no approval code is sent - the client confirms with the test code 000000 - and payments are simulated.');
});
t('1 SIGNUP_KEY line 3 + SIGNUP_ALL item 7', () => {
  assert.equal(F.SIGNUP_KEY[2].s, 'Sending to clients is a simulation (previews, test code 000000); real e-mail, WhatsApp and SMS unlock on a plan.');
  assert.match(F.SIGNUP_ALL[6], /^During the trial nothing is sent to your clients: approval, booklet and invitation links show a preview, the client approves with the test code 000000 and payments are simulated \(TEST receipts, no real money\)\./);
  assert.match(F.SIGNUP_ALL[6], /Your own account e-mails \(welcome, security, login codes, billing, teammate invites\) still work\./);
});
t('1 no agreed-terms text still says client e-mail really goes out', () => {
  const all = JSON.stringify([F.SECTIONS, F.SIGNUP_KEY, F.SIGNUP_ALL, F.NOTICE]);
  assert.doesNotMatch(all, /really (reach|sent)|E-mail to your clients works|recorded by hand/i);
});
t('1 terms.html free-trial section: "Client messages: the trial is a simulation"', () => {
  const h = read('public/terms.html');
  const sec = h.slice(h.indexOf('<section id="trial"'), h.indexOf('</section>', h.indexOf('<section id="trial"')));
  assert.match(sec, /<li><b>Client messages:<\/b> the trial is a simulation\. Nothing is sent to your clients by e-mail, WhatsApp or SMS; you see previews instead, the client approves with the test code 000000, and payments are simulated \(TEST receipts, no real money\)\./);
  assert.match(sec, /Your own account e-mails \(welcome, security, login codes, billing and teammate invitations\) still work\./);
  assert.doesNotMatch(sec, /E-mail to clients:|really reach|recorded by hand/);
  assert.match(h, /Last updated: <time datetime="2026-11-01">November 1, 2026<\/time>/);
});
t('1 re-acceptance uses the EXISTING flow: must_agree per version -> the one-time "Agree and continue" window (no lock-out)', () => {
  const s207 = read('supabase/migrations/0207_trial_terms_acceptance.sql');
  assert.match(s207, /t\.version = v_ver;/);
  assert.match(s207, /'must_agree', v_owner and a\.org_id is null/);
  assert.match(s207, /on conflict \(org_id, user_id, version\) do nothing/, 'old agreements kept');
  const td = read('public/trial-demo.js');
  assert.match(td, /if \(terms\.must_agree === true\) return "terms";/);
  assert.match(td, /const go = agreeButton\("Agree and continue"/);
  assert.match(td, /return st\.trialOrg\.acceptTerms\(F \? F\.VERSION : ""\);/);
  // 0325 only re-issues the constant + adds one read-only function: no table / row / policy touched
  assert.doesNotMatch(MIG.replace(/^--.*$/gm, ''), /\b(delete|truncate|drop|alter table|update public\.)\b/i);
});

// ---- 2 approval page consent clause (trial preview only) ----------------------------------------------------------
t('2 consentText(): clause 4 in a trial preview says "By entering the test code (trial simulation)"', () => {
  const p = 'By verifying the one-time code we sent you and accepting these terms, you confirm you are authorised.';
  assert.equal(AT.consentText(p), 'By entering the test code (trial simulation) and accepting these terms, you confirm you are authorised.');
  assert.equal(AT.consentText('Other text'), 'Other text');
  const src = read('public/approve-test-mode.js');
  assert.match(src, /tc\.querySelectorAll\("p"\)[\s\S]*?p\.textContent = consentText\(p\.textContent\);/, 'only inside apply() (trial)');
  const ap = read('public/approve.html');
  assert.equal((ap.match(/By verifying the one-time code we sent you and accepting these terms/g) || []).length, 3, 'paid terms text unchanged (IN / AE / US)');
  assert.match(ap, /const TERMS_VERSION="v3-2026-10";/, 'client terms version unchanged');
});

// ---- 3 proposal page banner ---------------------------------------------------------------------------------------
t('3 refFrom("proposal"): clean /<studio>/proposal/<token> and ?token=; the approval kind no longer reads proposal paths', () => {
  const tok = 'b0000000-0000-4000-8000-0000000325aa';
  assert.equal(TS.refFrom('proposal', { pathname: '/sparkle/proposal/' + tok, search: '' }), tok);
  assert.equal(TS.refFrom('proposal', { pathname: '/sparkle/proposal/' + tok.toUpperCase() + '/', search: '' }), tok);
  assert.equal(TS.refFrom('proposal', { pathname: '/proposal-view', search: '?token=' + tok }), tok);
  assert.equal(TS.refFrom('proposal', { pathname: '/proposal-view.html', search: '?token=' + tok }), tok);
  assert.equal(TS.refFrom('proposal', { pathname: '/proposal-view', search: '?token=nope' }), '');
  assert.equal(TS.refFrom('proposal', { pathname: '/a/b/proposal/' + tok, search: '' }), '');
  assert.equal(TS.refFrom('quote', { pathname: '/sparkle/proposal/' + tok, search: '' }), '', 'a proposal token is not an approval token');
  assert.equal(TS.refFrom('quote', { pathname: '/sparkle/quote/' + tok, search: '' }), tok, 'approval unchanged');
});
t('3 vercel.json rewrites /<slug>/proposal/<token> to /proposal-view (the slug pattern refFrom uses)', () => {
  const v = JSON.parse(read('vercel.json'));
  assert.ok(v.rewrites.some((r) => r.source === '/([a-z0-9-]+)/proposal/([^/]+)' && r.destination === '/proposal-view'));
});
t('3 proposal-view.html loads trial-sim (css + js, data-trial-sim="proposal") after store-api; has <main id="main">', () => {
  const h = read('public/proposal-view.html');
  assert.match(h, /<link rel="stylesheet" href="\/trial-sim\.css\?v=\d+">/);
  assert.match(h, /<script src="\/store-api\.js\?v=\d+"><\/script><script src="\/trial-sim\.js\?v=\d+" data-trial-sim="proposal"><\/script>/);
  assert.match(h, /<main id="main">/);
});
t('3 store-api trialSimPage("proposal") -> public_trial_simulation_for_proposal({p_token}); others unchanged', () => {
  const s = read('public/store-api.js');
  assert.match(s, /trialSimPage: \(kind, ref\) => mode === "supabase" && ref \? \(kind === "proposal"\n\s+\? rpc\("public_trial_simulation_for_proposal", \{ p_token: String\(ref\)\.slice\(0, 200\) \}\)\n\s+: rpc\("public_trial_simulation", \{ p_kind: String\(kind \|\| ""\), p_ref: String\(ref\)\.slice\(0, 200\) \}\)\)\.catch\(\(\) => null\)/);
});
t('3 0325 RPC: {simulation} only, null for unknown / unpublished / expired / shelved / cancelled; anon; definer; empty search_path', () => {
  assert.match(MIG, /create or replace function public\.public_trial_simulation_for_proposal\(p_token text\)\nreturns jsonb language plpgsql stable security definer set search_path = '' as \$\$/);
  assert.match(MIG, /where pr\.share_token = v_tok and pr\.published = true and q\.deleted_at is null/);
  assert.match(MIG, /public\.client_link_deadline\(v_date, v_org, public\.client_link_window_days\('proposal'\)\)/);
  assert.match(MIG, /public\.link_age_expired\(public\.proposal_link_age_until\(v_tok\)\)/);
  assert.match(MIG, /public\._a42_quote_shelved\(v_q\)[\s\S]*public\._a260_quote_cancelled\(v_q\)/);
  assert.match(MIG, /return jsonb_build_object\('simulation', coalesce\(public\._tb179_no_send\(v_org\), false\)\);/);
  assert.match(MIG, /foreach r in array array\['anon', 'authenticated', 'service_role'\] loop[\s\S]*public_trial_simulation_for_proposal\(text\) to %I/);
  assert.match(MIG, /raise exception 'STOP 0325: 0323/);
});
t('3 APPLY-0325.sql = begin + the migration + commit + 5 VERIFY rows; MANIFEST, DB suite, release lists', () => {
  const a = read('supabase/APPLY-0325.sql');
  assert.ok(a.includes('begin;\n' + MIG + 'commit;\n'), 'migration verbatim between begin / commit');
  assert.equal((a.match(/^\s+\('0\d /gm) || []).length, 5);
  assert.doesNotMatch(a, /[^\x00-\x7f]/, 'ASCII');
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0325_r117_trial_terms_proposal\.sql\n$/);
  assert.match(read('scripts/db-test/run-all.sh'), /run "r117-trial-terms-proposal-0325" "R117-TRIAL-TERMS-PROPOSAL-0325: ALL PASS \\\(21\/21\\\)"/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(f), /'0324', '0325'\]/, f);
});

// ---- 4 cosmetic --------------------------------------------------------------------------------------------------
t('4 booklet: a TEST-paid milestone shows REMAINING "— (test)" (display only)', () => {
  const b = read('public/booklet.js');
  assert.match(b, /tr\.appendChild\(el\("td", "amt", marks\[i\] && TS \? "\\u2014 \(test\)" : a\.remaining != null \? money\(a\.remaining\) : "—"\)\);/);
});
t('4 flow step 10: banner reads "Trial simulation — no real payment. ..." (no duplicated SIMULATION)', () => {
  const s = TN.paySimSpec({ is_trial_org: true });
  assert.match(s.text, /^no real payment\. Your client is never sent a payment link/);
  assert.doesNotMatch(s.text, /SIMULATION/i);
  assert.equal(TS.TITLE, 'Trial simulation');
  assert.match(read('public/trial-test-note.js'), /box\.textContent = "Trial simulation \\u2014 " \+ spec\.text;/, 'fallback without trial-sim keeps one prefix');
  assert.equal(TN.paySimSpec({ is_trial_org: false }), null, 'paid: nothing');
});

console.log(`\nr117-trial-terms-proposal: ${n} passed`);
