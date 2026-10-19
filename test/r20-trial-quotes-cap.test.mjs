// r20-trial-quotes-cap.test.mjs - owner r20, live on the trial:
//  A  "make sure you are limiting this quotations to two": 0238 puts the free-trial quote cap back (2 new quotes /
//     events, the 3 cap triggers 0211 dropped, re-created only when missing, same definitions as 0173 / 0181); sample
//     events never count; my_trial_limits lists quotes again; terms version trial-2026-10-20 = trial-facts.js; the
//     trial copy says 2 new quotes everywhere; New quote shows "Free trial: x of 2 new quotes used" and a refused 3rd
//     quote is explained with a "Choose a plan" link (BPUI.capToast)
//  B  "I logged in ... but couldn't accept" the invitation: the accept RPC's short lowercase refusals were shown as
//     "You don't have permission to sign you in." - now every accept refusal (also after a password sign-in / sign-up)
//     goes to showInviteError with plain words; signing in to an invited e-mail with no account yet points to
//     "create it here"; a different signed-in account gets "Sign out & accept invite as <invited e-mail>"
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};

const M = read('supabase/migrations/0238_trial_quotes_cap_two.sql'), A = read('supabase/APPLY-0238.sql');
const DBT = read('tests/db/trial-quotes-cap-0238.sql'), MAN = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh');
const F = require('../public/trial-facts.js');
const code = M.replace(/^\s*--.*$/gm, '');

// ---- A) SQL ------------------------------------------------------------------------------------------------
await t('0238 SQL: ASCII, additive (no row / table / trigger / function dropped or written), REQUIRES guards', () => {
  for (const s of [M, A, DBT]) assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(s), 'ASCII');
  assert.doesNotMatch(code, /\b(delete\s+from|truncate|drop\s+(table|column|function|policy|trigger|index)|insert\s+into|update\s+public\.|alter\s+table)\b/i);
  assert.match(M, /raise exception 'STOP: 0173 \(trial lockdown\) is not applied'/);
  assert.match(M, /raise exception 'STOP: 0181 \(trial guards\) is not applied'/);
  assert.match(M, /raise exception 'STOP: _tl181_used does not count quotes/);
  assert.match(M, /In plain words/); assert.match(M, /ROLLBACK \(manual/);
});
await t('0238 SQL: the 3 quotes cap triggers come back only when missing, with the 0173 / 0181 definitions', () => {
  const defs = [
    ['zzzz_tl173_cap', 'before insert on public.quotes for each row execute function public._tl173_tg_create_cap()'],
    ['zzzz_tl181_cap', 'before insert on public.quotes for each row execute function public._tl181_tg_cap_check()'],
    ['zzzz_tl181_cap_log', 'after insert on public.quotes for each row execute function public._tl181_tg_cap_log()']];
  for (const [n, d] of defs) {
    const guard = `if not exists (select 1 from pg_trigger where tgrelid = 'public.quotes'::regclass and tgname = '${n}') then\n    create trigger ${n} ${d};`;
    assert.ok(M.includes(guard), n);
  }
  // the same trigger bodies 0173 / 0181 attach (not re-defined here: 0236 owns them)
  assert.match(read('supabase/migrations/0173_trial_lockdown.sql'), /create trigger zzzz_tl173_cap before insert on public\.%I for each row execute function public\._tl173_tg_create_cap\(\)/);
  assert.match(read('supabase/migrations/0181_trial_guards.sql'), /create trigger zzzz_tl181_cap before insert on public\.%I for each row execute function public\._tl181_tg_cap_check\(\)/);
  assert.match(read('supabase/migrations/0181_trial_guards.sql'), /create trigger zzzz_tl181_cap_log after insert on public\.%I for each row execute function public\._tl181_tg_cap_log\(\)/);
  assert.doesNotMatch(code, /create or replace function public\._tl1(73|81)_/, 'cap functions not re-defined');
  // samples never count: the shared functions skip is_demo rows (0236 bodies)
  const u236 = read('supabase/migrations/0236_trial_definition_unify.sql');
  assert.match(u236, /if new\.org_id is null or coalesce\(new\.is_demo, false\) then return new; end if;/);
  assert.match(u236, /x\.org_id = \$1 and not x\.is_demo/);
});
await t('0238 SQL: my_trial_limits lists quotes under used (no uncapped); version = trial-facts.js VERSION', () => {
  const fn = M.slice(M.indexOf('create or replace function public.my_trial_limits()'), M.indexOf('-- ---- 3)'));
  assert.match(fn, /foreach t in array array\['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'\] loop/);
  assert.match(fn, /return jsonb_build_object\('trial', true, 'cap', 2, 'used', v_used\);/);
  assert.doesNotMatch(fn, /uncapped/);
  assert.match(fn, /if not public\._tl173_trial_locked\(v_org\) then return jsonb_build_object\('trial', false\); end if;/, 'paid: unchanged');
  assert.match(M, new RegExp("select '" + F.VERSION + "'::text;")); assert.equal(F.VERSION, 'trial-2026-10-20');
  assert.match(M, /grant execute on function public\.my_trial_limits\(\) to authenticated/);
  assert.match(M, /revoke all on function public\._trial_terms_version\(\) from authenticated/);
});
await t('APPLY-0238: migration verbatim in one transaction + a VERIFY grid (item, ok); MANIFEST; DB suite registered', () => {
  assert.ok(A.includes(M.trim()), 'verbatim');
  assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m);
  assert.ok(A.indexOf('begin;') < A.indexOf(M.trim()) && A.indexOf('commit;') > A.indexOf(M.trim()));
  assert.match(A, /-- VERIFY \(every row must say ok = true\)\nselect item, ok from \(values/);
  assert.match(A, /\) v\(item, ok\) order by item;\s*$/);
  assert.ok(!/^\s*\\/m.test(A) && !/create\s+(temp|temporary)\s+table/i.test(A) && !/set\s+(session|local)\b/i.test(A), 'pasteable');
  const nums = [...MAN.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]);
  assert.equal(new Set(nums).size, nums.length);
  assert.ok(nums.slice(nums.indexOf('0238') + 1).every((x) => +x > 238), '0238 is the newest before later r20 work (0239+)'); assert.ok(nums.indexOf('0238') > nums.indexOf('0237'));
  const n = (DBT.match(/pg_temp\.res\('\d\d /g) || []).length;
  assert.equal(n, 28);
  assert.match(RUNALL, new RegExp('run "trial-quotes-cap-0238" "TRIAL-QUOTES-CAP-0238: ALL PASS \\\\\\(' + n + '/' + n + '\\\\\\)" psql -q -f tests/db/trial-quotes-cap-0238\\.sql'));
  assert.match(DBT, /\\ir \.\.\/\.\.\/supabase\/migrations\/0211_trial_quotes_uncapped\.sql[\s\S]*\\ir \.\.\/\.\.\/supabase\/migrations\/0238_trial_quotes_cap_two\.sql\n\\ir \.\.\/\.\.\/supabase\/migrations\/0238_trial_quotes_cap_two\.sql/, 'from the live 0211 state, twice');
});

// ---- A) copy ---------------------------------------------------------------------------------------------
await t('trial copy: 2 new quotes (events) in the terms, the sign-up rules, the teammate notice, terms.html and the doc', () => {
  assert.deepEqual(F.CAP_LISTS, ['leads / clients', 'events & quotes', 'inventory items', 'vendors', 'staff', 'venues']);
  assert.deepEqual(F.UNCAPPED, []);
  const can = F.SECTIONS.find((s) => s.id === 'can').items.map((i) => i.t + ' ' + i.s).join('\n');
  assert.match(can, /Create up to 2 new quotes \(events\) 2 new quotes in total for the studio; each quote is an event\. The 7 sample events do not count/);
  assert.match(can, /Add up to 2 new records in each other list Leads \(clients\), inventory items, vendors, staff and venues/);
  assert.match(F.SIGNUP_ALL.join(' '), /You can create up to 2 new quotes \(events\), and add up to 2 new records of each other kind \(leads \/ clients, inventory items, vendors, staff and venues\)\. Sample records \(the 7 sample events too\) do not count/);
  assert.match(F.NOTICE.join(' '), /The studio can create up to 2 new quotes \(events\), and up to 2 new leads, inventory items, vendors, staff and venues each/);
  const all = JSON.stringify([F.SECTIONS, F.NOTICE, F.SIGNUP_KEY, F.SIGNUP_ALL]);
  assert.doesNotMatch(all, /as many quotes|not limited|unlimited/i);
  const terms = read('public/terms.html');
  assert.match(terms, /<b>Adding records:<\/b> you can create up to 2 new quotes \(events\) in total\. You can add up to 2 new records of each other kind/);
  assert.match(terms, /Sample records, including the 7 sample events, do not count/);
  assert.doesNotMatch(terms, /as many quotes and events/);
  const doc = read('docs/trial/TRIAL-END-TO-END.md');
  assert.match(doc, /\*\*Quotes and events are capped at 2 new again\*\* \(migration 0238/); assert.match(doc, /`trial-2026-10-20`/);
  assert.match(doc, /leads \(clients\), events \/ quotes, inventory items, vendors, staff and venues/);
});

// ---- A) UI: "x of 2 new quotes used" + a friendly refusal ------------------------------------------------
await t('UI: Quotes + dashboard gate New quote with the trial cap; every create path explains a refused 3rd quote', () => {
  const q = read('public/quotes.html'), d = read('public/dashboard.html'), sb = read('public/shell-b.js'), l = read('public/leads.html');
  assert.match(q, /\$\("#newBtn"\)\.hidden = !canCreate;\s*gateQuoteCap\(\);/);
  assert.match(q, /BPUI\.capGate\(\[\$\("#newBtn"\)\],"quotes","new quotes",\{ soft: true,/);
  const fn = q.slice(q.indexOf('async function startNewQuote('), q.indexOf('document.addEventListener("click", (e) => {', q.indexOf('async function startNewQuote(')));
  assert.ok(fn.indexOf('open==="builder"') < fn.indexOf('btn.disabled'), 'reusing an open quote in the builder never needs a slot');
  assert.match(fn, /btn\.getAttribute\("data-cap-off"\)==="1" && window\.BPUI && BPUI\.capToast\) BPUI\.capToast\(\{ hint: "trial_cap" \}, "new quotes"/);
  assert.match(fn, /if\(BPUI\.capToast && BPUI\.capToast\(err, "new quotes", "You can still open and edit your quotes and the sample events\."\)\)\{ gateQuoteCap\(\); return; \}/);
  assert.match(d, /\$\("#createBtn"\)\.hidden = !canCreate;[^\n]*\n[^\n]*\n\s*if \(canCreate && window\.BPUI && BPUI\.capGate\) BPUI\.capGate\(\[\$\("#createBtn"\)\], "quotes", "new quotes", CAP_OPTS\)/);
  assert.match(d, /if \(BPUI\.capToast && BPUI\.capToast\(err, "new quotes"/);
  assert.match(sb, /if \(window\.BPUI && BPUI\.capToast && BPUI\.capToast\(err, "new quotes"/);
  assert.match(l, /if\(BPUI\.capToast&&BPUI\.capToast\(err,"new quotes","The lead is kept;/);
});
await t('BPUI.capToast: only the trial cap refusal; plain words + "Choose a plan" link to /checkout; nothing else', () => {
  const S = read('public/store-api.js');
  const src = fnSrc(S, 'isCapError') + '\n' + fnSrc(S, 'capHref') + '\n' + fnSrc(S, 'capToast');
  const calls = [];
  const ctx = { global: { HelmTrialFacts: { CREATE_CAP: 2 }, location: { pathname: '/quotes.html' } }, toast: (m, o) => calls.push([m, o]) };
  vm.runInContext(src + '\nthis.capToast = capToast;', vm.createContext(ctx));
  assert.equal(ctx.capToast({ hint: 'trial_cap', message: 'Free trial limit reached (2). Upgrade to add more.' }, 'new quotes', 'You can still open and edit your quotes and the sample events.'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'Your free trial includes 2 new quotes and both are used. You can still open and edit your quotes and the sample events. Choose a plan to add more.');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { type: 'warn', title: 'Free trial limit reached', href: '/checkout?next=quotes.html', linkLabel: 'Choose a plan', timeout: 12000 });
  assert.equal(ctx.capToast({ message: 'Free trial limit reached (2). Upgrade to add more.', code: '42501' }, 'new quotes'), true, 'message match');
  assert.equal(ctx.capToast({ hint: 'trial_locked', message: 'Not available in the free trial.' }, 'new quotes'), false);
  assert.equal(ctx.capToast(new Error('network down'), 'new quotes'), false);
  assert.equal(calls.length, 2);
  assert.match(S, /isCapError: isCapError, capToast: capToast, clearErrOnEdit: clearErrOnEdit,/);
});

// ---- B) invitation accept ----------------------------------------------------------------------------------
const LOGIN = read('public/login.html');
function refusal(err, org) {
  const src = fnSrc(LOGIN, 'inviteRefusalText');
  const ctx = { INVITE_ORG: org == null ? 'Sita' : org, BPUI: { friendlyError: (e, o) => 'FRIENDLY(' + (o && o.action) + ')' } };
  vm.runInContext(src + '\nthis.f = inviteRefusalText;', vm.createContext(ctx));
  return ctx.f(err);
}
await t('invite: every accept refusal is said in plain words (was "You don\'t have permission to sign you in.")', () => {
  assert.equal(refusal({ message: 'invitation has expired', code: '42501' }), 'This invitation has expired — ask Sita to send you a new one.');
  assert.equal(refusal({ message: 'invitation is expired', code: '42501' }), 'This invitation has expired — ask Sita to send you a new one.');
  assert.equal(refusal({ message: 'invitation is revoked', code: '42501' }), 'This invitation was cancelled — ask Sita if you should still join.');
  assert.match(refusal({ message: 'invitation is accepted', code: '42501' }), /^This invitation was already used\. If you joined with it, just sign in/);
  assert.equal(refusal({ message: 'invalid invitation', code: '42501' }), "This invitation link isn't valid any more — ask Sita to send you a new one.");
  assert.match(refusal({ hint: 'seat_limit', message: 'Your free trial includes 3 people (you + 2 more). Upgrade to add more.' }), /^Sita's free trial already has all its seats in use/);
  assert.equal(refusal({ inviteMsg: 'This invitation was already accepted. Sign in with your own e-mail and password.' }), 'This invitation was already accepted. Sign in with your own e-mail and password.');
  assert.equal(refusal({ message: 'Confirm your e-mail address first, then open the invitation again.', code: '42501' }), 'FRIENDLY(accept the invitation)', 'readable server text still goes through friendlyError');
  assert.equal(refusal({ message: 'invitation has expired' }, ''), 'This invitation has expired — ask the studio to send you a new one.');
});
await t('invite: a refusal after a password sign-in / sign-up shows the invitation message (not a sign-in error); server checks unchanged', () => {
  const acc = LOGIN.slice(LOGIN.indexOf('async function acceptPendingInvite(){'), LOGIN.indexOf('function inviteWrongAccount('));
  assert.match(acc, /if\(e && typeof e==="object"\)\{ try\{ e\.inviteRefusal=true; \}catch\(_\)\{\} \}\s*if\(fromLink\) await dropLinkSession\(\);\s*throw e;/);
  assert.match(acc, /x\.inviteRefusal=true; x\.inviteMsg=x\.message;/);
  assert.match(LOGIN, /if\(joining && \(inviteWrongAccount\(err\) \|\| \(err && err\.inviteRefusal\)\)\)\{ showInviteError\(err, inviteTok0\); return; \}/);
  const show = fnSrc(LOGIN, 'showInviteError');
  assert.match(show, /if\(!inviteWrongAccount\(err\)\)\{ showErr\(box,inviteRefusalText\(err\)\); return; \}/);
  // another studio's login: the explanation + a way on (own studio / sign out)
  assert.match(show, /already belongs to another studio on Helm, and a login can be in one studio at a time/);
  assert.match(show, /inviteBtn\("inviteMyStudio","Go to my studio"/); assert.match(show, /inviteBtn\("inviteSignOut","Sign out"/);
  // a different account signed in: "Sign out & accept invite as <invited e-mail>"
  assert.match(show, /want\?"Sign out & accept invite as "\+want:"Sign out & accept invite"/);
  assert.match(show, /location\.replace\(tok\?"login\.html\?invite="\+encodeURIComponent\(tok\):"login\.html"\)/);
  // DOM only (textContent / createTextNode), no HTML strings
  assert.doesNotMatch(show + fnSrc(LOGIN, 'inviteBtn'), /innerHTML|insertAdjacentHTML/);
  // the accept RPC is untouched by this change (front-end only)
  assert.doesNotMatch(M, /accept_invitation/);
});
await t('invite: signing in to an invited e-mail that has no account yet -> "create it here"; no password yet -> new link', () => {
  const i = LOGIN.indexOf('// r20: signing in to the invited e-mail failed');
  assert.ok(i > 0);
  const blk = LOGIN.slice(i, LOGIN.indexOf('if(err&&err.code==="gate_verify")', i));
  assert.match(blk, /joining && mode==="signin" && err && err\.code==="invalid_credentials" && INV && INV\.valid && INV\.email/);
  assert.match(blk, /String\(email\)\.trim\(\)\.toLowerCase\(\)===String\(INV\.email\)\.trim\(\)\.toLowerCase\(\)/, 'only for the invited address (known to the token holder via peek)');
  assert.match(blk, /if\(INV\.account==="new"\)\{ setMode\("signup"\); lockInviteEmail\(INV\.email\);/);
  assert.match(blk, /There's no Helm account for "\+INV\.email\+" yet — create it here to join /);
  assert.match(blk, /if\(INV\.account==="needs_link"\|\|INV\.account==="unconfirmed"\)\{ showInviteLink\(INV\.email, INV\.account==="unconfirmed"\);/);
  assert.match(LOGIN, /Signed up with Google\? Use “Continue with Google”\./);
});

console.log(`r20-trial-quotes-cap: ${fail ? fail + ' failed, ' : 'all '}${pass} passed`);
if (fail) process.exit(1);
