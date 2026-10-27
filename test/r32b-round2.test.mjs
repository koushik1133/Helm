// r32b-round2.test.mjs - review round 2 (owner-authorised), the browser / CI side. Behavioural: the real functions are
// lifted out of the page / script and run against stubs (no static grep for the behaviour itself).
//  * login.html (R2-AUTH-REG-1): a Join that the server answers { fallback: true } e-mails a fresh keyed invitation
//    ("We've e-mailed you a link to finish joining") instead of a dead end; "Sign out & accept invite" keeps &k=
//  * closure.html (R2-ACL-01): money owed as the ONLY blocker + "Close events with money owed" -> the override prompt
//  * store-api.js: the paid-plan seat message for the admin (BIZ-03); "Add user" refusals answered { refused } (R2-AUTH-02)
//  * check-html-sinks (R2-CLI-01): join separator, comma operator, safe helpers scoped to the files they were reviewed in
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

// the source of `function name(...) { ... }` (or `async function`) inside a page, braces matched outside strings
function fnSource(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src);
  assert.ok(m, name + ' not found');
  let i = src.indexOf('{', src.indexOf(')', m.index)), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
function el() { return { textContent: '', hidden: true }; }

// ---------------------------------------------------------------------------------------------- login.html
const LOGIN = rd('public/login.html');
function joinHarness({ direct, mail }) {
  const dom = { '#okmsg': el(), '#err': el(), '#submit': el() };
  const calls = { mail: [], signIn: 0, accept: 0, route: 0, link: 0, signInFor: 0 };
  const ctx = {
    URLSearchParams, $: (s) => dom[s] || (dom[s] = el()),
    showErr: (box, msg) => { box.textContent = String(msg); box.hidden = false; },
    showInviteLink: () => { calls.link++; }, showSignInForInvite: () => { calls.signInFor++; },
    capToken: () => 'cap', finishGate: async () => true,
    acceptPendingInvite: async () => { calls.accept++; }, routeSignedIn: async () => { calls.route++; },
    BPStore: {
      invitations: {
        signupDirect: async () => { if (direct instanceof Error) throw direct; return direct; },
        emailInviteLink: async (email) => { calls.mail.push(email); if (mail instanceof Error) throw mail; return mail; },
      },
      auth: { signIn: async () => { calls.signIn++; } },
    },
  };
  vm.createContext(ctx);
  vm.runInContext('var INVITE_ORG = "Sita Events", cap = null, justPw = null;\n'
    + ['inviteFinishByEmail', 'inviteDirectJoin', 'inviteReloadUrl'].map((f) => fnSource(LOGIN, f)).join('\n')
    + '\nthis.api = { inviteDirectJoin, inviteFinishByEmail, inviteReloadUrl };', ctx);
  return { api: ctx.api, dom, calls };
}
const err = (code, msg) => Object.assign(new Error(msg || code), { code });

await t('R2-AUTH-REG-1 Join answered { fallback: true } -> a fresh keyed invitation is e-mailed, "We\'ve e-mailed you a link to finish joining"', async () => {
  const h = joinHarness({ direct: { fallback: true }, mail: { sent: true } });
  const r = await h.api.inviteDirectJoin('tok123', 'priya@example.test', 'Str0ng!Passw0rd', 'Priya');
  assert.equal(r, 'done', 'handled - no dead end');
  assert.deepEqual(h.calls.mail, ['priya@example.test'], 'the invited address gets a NEW invitation e-mail (it carries a fresh &k= key)');
  assert.equal(h.dom['#okmsg'].hidden, false);
  assert.match(h.dom['#okmsg'].textContent, /We've e-mailed you a link to finish joining Sita Events/);
  assert.equal(h.dom['#err'].hidden, true, 'no "couldn\'t create your account" error');
  assert.equal(h.calls.signIn, 0, 'no sign-in attempt for an account that was not made');
});

await t('R2-AUTH-REG-1 the keyed path still signs straight in (no extra e-mail)', async () => {
  const h = joinHarness({ direct: { ok: true }, mail: { sent: true } });
  assert.equal(await h.api.inviteDirectJoin('tok123', 'priya@example.test', 'Str0ng!Passw0rd', 'Priya'), 'done');
  assert.equal(h.calls.signIn, 1); assert.equal(h.calls.accept, 1); assert.equal(h.calls.route, 1);
  assert.deepEqual(h.calls.mail, []);
});

await t('R2-AUTH-REG-1 fallback + "sent a moment ago" -> that message is shown (handled); nothing sendable -> the caller\'s own error', async () => {
  const h1 = joinHarness({ direct: { fallback: true }, mail: err('rate_limited', 'We sent it a moment ago - check your inbox (and spam), or try again later.') });
  assert.equal(await h1.api.inviteDirectJoin('t', 'a@example.test', 'x', ''), 'done');
  assert.match(h1.dom['#err'].textContent, /sent it a moment ago/);
  const h2 = joinHarness({ direct: { fallback: true }, mail: err('unavailable') });
  assert.equal(await h2.api.inviteDirectJoin('t', 'a@example.test', 'x', ''), 'none');
  const h3 = joinHarness({ direct: { fallback: true }, mail: { sent: false } });
  assert.equal(await h3.api.inviteDirectJoin('t', 'a@example.test', 'x', ''), 'none');
});

await t('R2-AUTH-REG-1 refusals keep their own screens (needs_link / account_exists / email_mismatch)', async () => {
  const a = joinHarness({ direct: err('needs_link'), mail: { sent: true } });
  assert.equal(await a.api.inviteDirectJoin('t', 'a@example.test', 'x', ''), 'done'); assert.equal(a.calls.link, 1); assert.deepEqual(a.calls.mail, []);
  const b = joinHarness({ direct: err('account_exists'), mail: { sent: true } });
  assert.equal(await b.api.inviteDirectJoin('t', 'a@example.test', 'x', ''), 'done'); assert.equal(b.calls.signInFor, 1);
  const c = joinHarness({ direct: err('email_mismatch', 'Use the e-mail address this invitation was sent to.'), mail: { sent: true } });
  assert.equal(await c.api.inviteDirectJoin('t', 'a@example.test', 'x', ''), 'done'); assert.match(c.dom['#err'].textContent, /Use the e-mail/);
});

await t('R2-AUTH-REG-1 "Sign out & accept invite" keeps the mail key (&k=) on the reload; junk keys are dropped', async () => {
  const { api } = joinHarness({ direct: { fallback: true }, mail: { sent: true } });
  const k = 'ab'.repeat(16);
  assert.equal(api.inviteReloadUrl('tok 1', '?invite=tok&k=' + k.toUpperCase()), 'login.html?invite=tok%201&k=' + k);
  assert.equal(api.inviteReloadUrl('tok', '?invite=tok&k=<script>'), 'login.html?invite=tok');
  assert.equal(api.inviteReloadUrl('tok', ''), 'login.html?invite=tok');
  assert.equal(api.inviteReloadUrl('', '?k=' + k), 'login.html');
  // wiring: the page's button and the Join form use these functions
  assert.match(LOGIN, /location\.replace\(inviteReloadUrl\(tok, location\.search\)\)/);
  assert.match(LOGIN, /if\(\(await inviteDirectJoin\(inviteTok0, email, pw, fullName\)\)==="done"\) return;/);
  // the anonymous "Email me a new link" answer { account: "new" } opens this same Join (create-account) form
  assert.match(LOGIN, /if\(r && r\.account==="new"\)\{ showView\("#loginForm"\); setMode\("signup"\);/);
});

// ---------------------------------------------------------------------------------------------- closure.html
await t('R2-ACL-01 closure: money owed as the only blocker is recognised (so a close_owed role gets the override prompt)', () => {
  const C = rd('public/closure.html');
  const ctx = { BPStore: { studioMoney: (x) => 'Rs ' + x, quoteMoney: (x) => 'Rs ' + x }, evTax: null, tooEarlyText: () => 'too early' };
  vm.createContext(ctx);
  vm.runInContext(fnSource(C, 'closeBlockerLines') + '\n' + fnSource(C, 'owedOnlyBlocker') + '\nthis.api = { closeBlockerLines, owedOnlyBlocker };', ctx);
  const { closeBlockerLines: L, owedOnlyBlocker: O } = ctx.api;
  assert.equal(O(L({ blocked: true, balance_owed: 5000, open_checkouts: 0 }, []), []), true, 'owed only');
  assert.equal(O(L({ blocked: true, balance_owed: 5000, open_checkouts: 2, checkouts: [] }, []), []), false, 'stock out too');
  assert.equal(O(L({ blocked: true, balance_owed: 5000, not_booked: 'unconfirmed' }, []), []), false, 'not booked too');
  assert.equal(O(L({ blocked: true, balance_owed: 5000, no_event_date: true }, []), []), false, 'no date too');
  assert.equal(O(L({ blocked: true, balance_owed: 5000 }, ['Chairs x2']), ['Chairs x2']), false, 'unnamed stock out');
  assert.equal(O(L({ blocked: false }, []), []), false, 'nothing owed');
  assert.match(C, /const owedOk=role!=="admin" && owedOnly && await BPStore\.auth\.canEditArea\("close_owed"\)/);
  assert.match(C, /if\(outstanding\.length \|\| \(role!=="admin" && !owedOk\)\)\{/);
});

// ---------------------------------------------------------------------------------------------- store-api.js
const API = rd('public/store-api.js');
await t('BIZ-03 store-api: a paid plan at its seat limit gets the admin-side wording with the plan\'s number', () => {
  const st = API.indexOf('  function clip(s, n)'), fe = API.indexOf('  function friendlyError(e, o)');
  assert.ok(st > 0 && fe > st);
  const body = fnSource(API.slice(fe), 'friendlyError');
  const ctx = { global: {}, navigator: { onLine: true }, TECHNICAL: /PGRST|relation|column/i,
    isAuthError: () => false, isNetworkError: () => false, isPermissionError: () => false, isMissingTable: () => false, isMissingFunction: () => false,
    errCode: (e) => (e && e.code) || '', errMsg: (e) => (e && e.message) || '' };
  vm.createContext(ctx);
  vm.runInContext(API.slice(st, fe) + body + '\nthis.fe = friendlyError;', ctx);
  const m = ctx.fe({ code: '42501', hint: 'plan_seat_limit', message: 'Your plan allows 2 team invites. Contact sales to add more.', details: '{"limit": 3}' }, { action: 'send the invitation' });
  assert.match(m, /^Couldn’t send the invitation\. Your plan allows 2 team invites and they are all in use/);
  assert.match(m, /Revoke an open invitation or remove someone/);
  assert.match(m, /contact Helm sales/);
  const one = ctx.fe({ code: '42501', hint: 'plan_seat_limit', message: 'x', details: '{"limit": 2}' }, {});
  assert.match(one, /Your plan allows 1 team invite and/);
});

await t('R2-AUTH-02 store-api: an "Add user" refusal answered { refused: true } becomes the usual error (no temp password shown)', async () => {
  const a = API.indexOf('      async createUserTemp(email, role) {');
  const b = API.indexOf('      async setRole(id, role) {');
  assert.ok(a > 0 && b > a);
  const src = API.slice(a, b).replace(/^\s*async createUserTemp/, 'async function createUserTemp').trim().replace(/,\s*$/, '');
  const mk = (data) => { const ctx = { reservedEmailDomain: () => false, reservedEmailError: () => new Error('r'),
    supa: { rpc: async () => ({ data, error: null }) } }; vm.createContext(ctx); vm.runInContext(src + '\nthis.f = createUserTemp;', ctx); return ctx.f; };
  await assert.rejects(mk({ refused: true, code: '22023', error: 'could not create this user - send them an invitation instead' })('x@example.test', 'sales'),
    (e) => /send them an invitation instead/.test(e.message) && e.code === '22023');
  assert.deepEqual(await mk({ user_id: 'u1', temp_password: 'Hm-x' })('x@example.test', 'sales'), { user_id: 'u1', temp_password: 'Hm-x' });
  // the Control Center already words this refusal ("This e-mail already has a Helm account ... send them an invitation")
  assert.match(rd('public/control.html'), /if\(\/send them an invitation instead\/i\.test\(m\)\)/);
});

// ---------------------------------------------------------------------------------------------- check-html-sinks
await t('R2-CLI-01 check-html-sinks: the join separator, the comma operator and per-file helpers', async () => {
  const S = await import('../scripts/check-html-sinks.mjs');
  assert.equal(S.safeExpr('rows.map(r => `<li>${esc(r.name)}</li>`).join("")'), true, 'constant separator');
  assert.equal(S.safeExpr('rows.map(r => `<li>${esc(r.name)}</li>`).join(SEP)'), true, 'ALL_CAPS constant separator');
  assert.equal(S.safeExpr('rows.map(r => `<li>${esc(r.name)}</li>`).join(userSep)'), false, 'separator from data');
  assert.equal(S.safeExpr('(n > 0, evil)'), false, 'comma operator: the value is the LAST operand');
  assert.equal(S.safeExpr('n > 0, evil'), false);
  assert.equal(S.safeExpr('(evil, rows.length)'), true, 'last operand numeric');
  assert.equal(S.mapCallbackSafe('r => { return r.ok, r.name; }'), false, 'return a, b');
  assert.equal(S.mapCallbackSafe('r => { return esc(r.name); }'), true);
  S.setFile('public/leads.html'); assert.equal(S.safeExpr('card(l)'), true, 'card() reviewed in leads.html');
  S.setFile('public/some-new-page.html'); assert.equal(S.safeExpr('card(l)'), false, 'another file\'s card() is not the reviewed one');
  assert.equal(S.safeExpr('rows.map(tab).join("")'), false, 'tab() only reviewed in nurture.html');
  S.setFile('public/nurture.html'); assert.equal(S.safeExpr('rows.map(tab).join("")'), true);
  S.setFile(null);
  const A = JSON.parse(rd('scripts/html-sinks-allowlist.json'));
  for (const h of A.safeHelpers) assert.ok(Array.isArray(h.files), 'files list on ' + h.name);
});

console.log(`r32b-round2: ${n} test(s) passed.`);
