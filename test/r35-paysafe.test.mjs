// r35-paysafe.test.mjs - payment-details change protection (SQL 0285):
//  * store-api.js withStepUp (run in a vm): R35_REAUTH -> asks for the 6-digit code ONCE, verifies it, retries the same
//    call once; R35_SETUP_2STEP -> offers the two-step set-up, never retries; R35_FLAGGED -> no prompt; cancel -> not saved
//  * payment-schedule-settings.js with a tiny DOM: the change waiting 24 hours (who / when / new details), "This wasn't
//    us" for another admin, "Withdraw my change" for the one who made it, "Make it live now" only for a DIFFERENT admin,
//    flagged accounts (sign out everywhere / clear flag), masked view for non-admins, the save message - textContent only
//  * the bell: kind studio_security -> admin pages, the security toast; the e-mail (comms-dispatch) masks everything
//  * SQL 0285: server-side gates on every sensitive path, masked logs, nothing dropped / deleted, APPLY verbatim +
//    VERIFY, MANIFEST + run-all + release lists, the owner file
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const API = rd('public/store-api.js'), SET = rd('public/payment-schedule-settings.js'), CC = rd('public/control.html');
const SQL = rd('supabase/migrations/0285_r35_payment_details_safety.sql'), APPLY = rd('supabase/APPLY-0285.sql');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

// ---- A. store-api withStepUp in a vm ---------------------------------------------------------------------------------
const stepUpSrc = API.slice(API.indexOf('  const STEPUP_TEXT = {'), API.indexOf('  /* ---------------- client approval: OTP + consent + payment'));
function stepUpEnv(o) {
  const log = [];
  const cx = { log, global: null, console };
  cx.global = cx;
  cx.BPUI = {
    prompt: async (msg, opt) => { log.push(['prompt', opt.title, opt.validate('12345'), opt.validate('123 456')]); return o.code === undefined ? '123456' : o.code; },
    confirm: async (msg, opt) => { log.push(['confirm', opt.okLabel]); return !!o.confirm; },
  };
  cx.HelmAuthUI = { openAccount: () => log.push(['openAccount']) };
  cx.BPStore = { auth: { mfa: { challenge: async (c) => { log.push(['challenge', c]); if (o.badCode) throw new Error('That code didn\'t work.'); } } } };
  vm.createContext(cx);
  vm.runInContext(stepUpSrc + '\nglobal.withStepUp = withStepUp; global.stepUpKind = stepUpKind;', cx);
  return cx;
}
const r35err = (word) => Object.assign(new Error(word + ': server text'), { code: '42501', hint: word === 'R35_REAUTH' ? 'reauth' : 'x' });

await t('A1 withStepUp: R35_REAUTH -> one code prompt (6 digits checked), challenge, the SAME call retried once', async () => {
  const cx = stepUpEnv({}); let calls = 0;
  const out = await cx.withStepUp(async () => { calls++; if (calls === 1) throw r35err('R35_REAUTH'); return 'saved'; });
  assert.equal(out, 'saved'); assert.equal(calls, 2);
  assert.deepEqual(cx.log[0], ['prompt', 'Confirm with two-step', 'Enter the 6-digit code from your authenticator app.', null]);
  assert.deepEqual(cx.log[1], ['challenge', '123456']);
});
await t('A2 withStepUp: a second refusal is not retried again (no loop)', async () => {
  const cx = stepUpEnv({}); let calls = 0;
  await assert.rejects(cx.withStepUp(async () => { calls++; throw r35err('R35_REAUTH'); }), /R35_REAUTH/);
  assert.equal(calls, 2); assert.equal(cx.log.filter((x) => x[0] === 'prompt').length, 1);
});
await t('A3 withStepUp: cancelling the code prompt -> not saved, error marked cancelled + friendly', async () => {
  const cx = stepUpEnv({ code: null });
  await assert.rejects(cx.withStepUp(async () => { throw r35err('R35_REAUTH'); }),
    (e) => e.cancelled === true && e.stepUp === 'reauth' && /fresh two-step code/.test(e.message));
});
await t('A4 withStepUp: R35_SETUP_2STEP -> "Set up two-step now" (r44 guided set-up), never a code prompt; not set up -> not retried', async () => {
  const cx = stepUpEnv({ confirm: true }); let calls = 0;
  await assert.rejects(cx.withStepUp(async () => { calls++; throw r35err('R35_SETUP_2STEP'); }),
    (e) => e.stepUp === 'setup' && /Set up two-step verification/.test(e.message));
  assert.equal(calls, 1); assert.deepEqual(cx.log, [['confirm', 'Set up two-step now'], ['openAccount']]);
});
await t('A5 withStepUp: R35_FLAGGED -> plain refusal; other errors pass through untouched', async () => {
  const cx = stepUpEnv({});
  await assert.rejects(cx.withStepUp(async () => { throw r35err('R35_FLAGGED'); }), (e) => e.stepUp === 'flagged' && /Another admin/.test(e.message));
  const other = new Error('not authorized');
  await assert.rejects(cx.withStepUp(async () => { throw other; }), (e) => e === other);
  assert.equal(cx.log.length, 0);
});
await t('A6 store-api: every sensitive path goes through withStepUp (rpc, money switches, admins, business e-mail)', () => {
  assert.match(API, /const rpc = \(fn, args\) => withStepUp\(\(\) => rpcOnce\(fn, args\)\);/);
  for (const fn of ['admin_set_role_access', 'admin_set_role', 'admin_delete_user', 'admin_create_user', 'admin_create_user_temp']) {
    assert.match(API, new RegExp('withStepUp\\(async \\(\\) => \\{ const \\{ (data, )?error \\} = await supa\\.rpc\\("' + fn + '"'), fn);
  }
  assert.match(API, /await withStepUp\(async \(\) => \{ const r = await supa\.from\("organizations"\)\.update\(patch\)/);
  assert.match(API, /cancelChange: \(id, signOut\) => \(supa \? rpc\("pay_details_cancel", \{ p_change: id, p_sign_out: !!signOut \}\)/);
  assert.match(API, /approveNow: \(id\) => \(supa \? rpc\("pay_details_approve_now"/);
  assert.match(API, /if \(e && e\.stepUp && e\.message\) return pre \+ endDot/);   // friendlyError says it in plain words
});
await t('A7 the bell: studio_security opens the right admin page, shows the server label, security toast', () => {
  assert.match(API, /if \(k === "studio_security"\) \{[\s\S]{0,200}control\.html#payment-schedules/);
  assert.match(API, /studio_security: \["🛡️", String\(d\.label \|\| "A sensitive studio setting was changed"\)\]/);
  assert.match(API, /\(k === "security_alert" \|\| k === "studio_security"\) \? "security"/);
});

// ---- B. payment-schedule-settings.js with a tiny DOM -------------------------------------------------------------------
function runCard(S0, actions) {
  const byId = {};
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.ls = {}; this.value = ''; this._t = ''; this.hidden = false; this.className = ''; this.dataset = {}; this.disabled = false; this.type = ''; }
    set id(v) { this._id = v; byId[v] = this; } get id() { return this._id; }
    setAttribute(k, v) { this[k] = v; if (k === 'id') byId[v] = this; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
    get firstChild() { return this.children[0] || null; }
    set textContent(v) { this._t = String(v); this.children = []; } get textContent() { return this._t + this.children.map((c) => c.textContent).join(' '); }
    addEventListener(tp, f) { (this.ls[tp] = this.ls[tp] || []).push(f); }
    click() { return Promise.all((this.ls.click || []).map((f) => f({ type: 'click' }))); }
    querySelector() { return null; } scrollIntoView() {} focus() {}
  }
  const mk = (id, tag) => { const e = new El(tag || 'div'); e.id = id; return e; };
  ['pstCard', 'pst_rem', 'pst_list', 'pst_ed', 'pst_msg', 'pst_pending', 'pst_flags', 'pst_ro'].forEach((i) => mk(i));
  mk('pst_upi', 'input'); mk('pst_note', 'input'); mk('pst_default', 'select'); mk('pst_save', 'button'); mk('pst_new', 'button');
  byId.pstCard.hidden = true;
  const calls = [];
  const P = {
    settings: async () => S0(), saveSettings: async (p) => { calls.push(['save', p]); return actions.afterSave ? actions.afterSave() : S0(); },
    cancelChange: async (id, so) => { calls.push(['cancel', id, so]); return { cancelled: true, flagged: actions.flagged !== false }; }, approveNow: async (id) => { calls.push(['approve', id]); },
    clearFlag: async (u) => { calls.push(['clear', u]); }, signOutFlagged: async (u) => { calls.push(['signout', u]); },
  };
  const cx = { console, document: { readyState: 'complete', getElementById: (id) => byId[id] || null, createElement: (tg) => new El(tg), addEventListener() {} },
    setTimeout: (f) => f(), location: { hash: '' }, Date, Promise };
  cx.window = cx; cx.globalThis = cx;
  cx.BPStore = { auth: { user: () => ({ id: 'u1' }) }, paySchedule: P };
  cx.HelmPaySchedule = { reminderLine: () => 'Reminders on.', cleanLines: (l) => ({ ok: true, lines: l }), compute: () => [], addDays: (d) => d };
  cx.BPUI = { confirm: async (msg, o) => { calls.push(['confirm', o.okLabel]); return actions.confirm !== false; }, alert: async (msg) => { calls.push(['alert', msg]); } };
  vm.createContext(cx);
  vm.runInContext(SET, cx);
  return { byId, calls, cx };
}
const tick = () => new Promise((r) => setImmediate(r));
const base = () => ({ can_edit: true, upi_id: 'studioa@okaxis', pay_note: 'HDFC ****1234', default_template: 'builtin:30-50-20', builtins: [], templates: [],
  reminders: { enabled: true }, flags: [], is_admin: true, two_step: { has_2step: true }, pending: null });
const find = (el, txt) => { if (el.tag === 'button' && el.textContent.trim() === txt) return el; for (const c of el.children || []) { const r = find(c, txt); if (r) return r; } return null; };

await t('B1 the live (old) details stay in the fields; the change waiting shows who / until when / the new details', async () => {
  const S = Object.assign(base(), { pending: { id: 'c1', requested_by: 'Asha Admin', requested_by_me: false, requested_at: '2026-10-27T10:00:00Z',
    effective_at: '2026-10-28T10:00:00Z', new_upi: 'thief9@okicici', new_note: 'SBI A/c 9999', old_upi_masked: '****axis', old_note_masked: '****1234',
    masked: false, can_cancel: true, can_approve: true } });
  const { byId } = runCard(() => S, {}); await tick();
  assert.equal(byId.pstCard.hidden, false);
  assert.equal(byId.pst_upi.value, 'studioa@okaxis', 'fields = what clients see now');
  assert.equal(byId.pst_pending.hidden, false);
  const tx = byId.pst_pending.textContent;
  assert.match(tx, /New payment details are waiting/); assert.match(tx, /Changed by Asha Admin/); assert.match(tx, /Clients keep seeing the current details until/);
  assert.match(tx, /thief9@okicici/); assert.match(tx, /UPI \*\*\*\*axis, note \*\*\*\*1234/);
  assert.ok(find(byId.pst_pending, "This wasn't us")); assert.ok(find(byId.pst_pending, 'Make it live now'));
});
await t('B2 "This wasn\'t us": confirm, offer sign-out everywhere, cancel with sign-out, then the next-steps advice', async () => {
  const S = Object.assign(base(), { pending: { id: 'c1', requested_by: 'Asha Admin', requested_by_me: false, requested_at: '2026-10-27T10:00:00Z',
    effective_at: '2026-10-28T10:00:00Z', new_upi: 'x@ok', new_note: null, can_cancel: true, can_approve: false } });
  const { byId, calls } = runCard(() => S, {}); await tick();
  assert.equal(find(byId.pst_pending, 'Make it live now'), null, 'no early approval button when the server says no');
  await find(byId.pst_pending, "This wasn't us").click(); await tick();
  assert.deepEqual(calls.slice(0, 3), [['confirm', 'Cancel the change'], ['confirm', 'Sign out everywhere'], ['cancel', 'c1', true]]);
  assert.ok(calls.some((c) => c[0] === 'alert' && /reset their password/.test(c[1])));
});
await t('B2b cancelled by an admin without two-step: the page says the account was NOT flagged / signed out', async () => {
  const S = Object.assign(base(), { pending: { id: 'c1', requested_by: 'Asha Admin', requested_by_me: false, requested_at: '2026-10-27T10:00:00Z',
    effective_at: '2026-10-28T10:00:00Z', new_upi: 'x@ok', can_cancel: true, can_approve: false } });
  const { byId, calls } = runCard(() => S, { flagged: false }); await tick();
  await find(byId.pst_pending, "This wasn't us").click(); await tick();
  assert.ok(calls.some((c) => c[0] === 'alert' && /was NOT flagged or signed out: that needs two-step/.test(c[1])));
  assert.ok(!calls.some((c) => c[0] === 'alert' && /reset their password/.test(c[1])));
});
await t('B3 the admin who made the change sees "Withdraw my change" (no flag, no sign-out question), never "Make it live now"', async () => {
  const S = Object.assign(base(), { pending: { id: 'c2', requested_by: 'Asha Admin', requested_by_me: true, requested_at: '2026-10-27T10:00:00Z',
    effective_at: '2026-10-28T10:00:00Z', new_upi: 'x@ok', can_cancel: true, can_approve: false } });
  const { byId, calls } = runCard(() => S, {}); await tick();
  assert.equal(find(byId.pst_pending, "This wasn't us"), null); assert.equal(find(byId.pst_pending, 'Make it live now'), null);
  await find(byId.pst_pending, 'Withdraw my change').click(); await tick();
  assert.deepEqual(calls, [['confirm', 'Withdraw'], ['cancel', 'c2', false]]);
});
await t('B4 a non-admin editor: masked details, no buttons', async () => {
  const S = Object.assign(base(), { is_admin: false, pending: { id: 'c3', requested_by: 'Asha Admin', requested_at: '2026-10-27T10:00:00Z',
    effective_at: '2026-10-28T10:00:00Z', new_upi: '****cici', new_note: '****3333', masked: true, can_cancel: false, can_approve: false } });
  const { byId } = runCard(() => S, {}); await tick();
  assert.match(byId.pst_pending.textContent, /\*\*\*\*cici/); assert.match(byId.pst_pending.textContent, /Only admins see the new details in full/);
  assert.equal(find(byId.pst_pending, "This wasn't us"), null);
});
await t('B5 "Make it live now" (a different admin) asks first, then approves', async () => {
  const S = Object.assign(base(), { pending: { id: 'c4', requested_by: 'Ravi', requested_by_me: false, requested_at: '2026-10-27T10:00:00Z',
    effective_at: '2026-10-28T10:00:00Z', new_upi: 'x@ok', can_cancel: true, can_approve: true } });
  const { byId, calls } = runCard(() => S, {}); await tick();
  await find(byId.pst_pending, 'Make it live now').click(); await tick();
  assert.deepEqual(calls.slice(0, 2), [['confirm', 'Make it live now'], ['approve', 'c4']]);
});
await t('B6 flagged accounts: sign out everywhere + clear flag for others; nothing to press on your own flag', async () => {
  const S = Object.assign(base(), { flags: [{ user_id: 'u9', name: 'Asha Admin', flagged_at: '2026-10-27T10:00:00Z', by: 'Ravi', is_me: false },
    { user_id: 'u1', name: 'Me', flagged_at: '2026-10-27T10:00:00Z', by: 'Ravi', is_me: true }] });
  const { byId, calls } = runCard(() => S, {}); await tick();
  assert.equal(byId.pst_flags.hidden, false); assert.match(byId.pst_flags.textContent, /Flagged accounts/); assert.match(byId.pst_flags.textContent, /Me \(you\)/);
  const btns = []; (function w(e) { if (e.tag === 'button') btns.push(e.textContent.trim()); (e.children || []).forEach(w); })(byId.pst_flags);
  assert.deepEqual(btns, ['Sign out everywhere', 'Clear flag']);
  await find(byId.pst_flags, 'Sign out everywhere').click(); await tick();
  await find(byId.pst_flags, 'Clear flag').click(); await tick();
  assert.deepEqual(calls.filter((c) => c[0] !== 'confirm'), [['signout', 'u9'], ['clear', 'u9']]);
});
await t('B7 saving a new UPI ID: the page says every admin was told and when clients will see it', async () => {
  const waiting = Object.assign(base(), { pending: { id: 'c5', requested_by: 'Me', requested_by_me: true, requested_at: '2026-10-27T10:00:00Z',
    effective_at: '2026-10-28T10:00:00Z', new_upi: 'new@okaxis', can_cancel: true } });
  const { byId, calls } = runCard(() => base(), { afterSave: () => waiting }); await tick();
  byId.pst_upi.value = 'new@okaxis'; byId.pst_default.value = 'builtin:30-50-20';
  await byId.pst_save.click(); await tick();
  assert.equal(calls[0][0], 'save'); assert.equal(calls[0][1].upi_id, 'new@okaxis');
  assert.match(byId.pst_msg.textContent, /Every admin was told\. Clients will see the new payment details from/);
});
await t('B8 the card: no innerHTML, the safety note + both regions in control.html, versions bumped', () => {
  assert.doesNotMatch(SET, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(CC, /id="pst_safe"[^>]*>For your clients' safety: changing these needs your two-step code, every admin is told at once, and clients see new details only after 24 hours\./);
  assert.match(CC, /id="pst_pending" role="region"/); assert.match(CC, /id="pst_flags" role="region"/);
  assert.match(CC, /payment-schedule-settings\.js\?v=4/); assert.match(CC, /payment-schedule\.css\?v=4/);
  assert.match(CC, /store-api\.js\?v=307/);
});

// ---- C. e-mail (comms-dispatch) ----------------------------------------------------------------------------------------
await t('C1 studio_security e-mail: who / when / from when, old -> new masked; anything unmasked is hidden', async () => {
  const m = await import('../supabase/functions/comms-dispatch/helm-notices.mjs');
  assert.ok(m.NOTICE_KINDS.includes('studio_security')); assert.ok(m.NOTICE_TX_REASON.studio_security);
  const r = m.helmNoticeEmail('studio_security', { event: 'pay_details_requested', studio: 'Studio A', by: 'Asha Admin', at_text: '27 Oct 2026, 10:00 AM (Asia/Kolkata)',
    effective_text: '28 Oct 2026, 10:00 AM (Asia/Kolkata)', old_upi: '****axis', new_upi: 'thief9@okicici', old_note: '****1234', new_note: 'SBI A/c 99990000111122223333' }, 'https://www.helm.events');
  assert.match(r.subject, /^Helm security: Payment details for Studio A were changed/);
  assert.match(r.text, /changed by Asha Admin at 27 Oct 2026, 10:00 AM \(Asia\/Kolkata\)\. Clients will see the new details from 28 Oct 2026/);
  assert.match(r.text, /UPI ID: +\*\*\*\*axis {2}-> {2}\*\*\*\*\n/); assert.match(r.text, /Payment note: \*\*\*\*1234 {2}-> {2}\*\*\*\*\n/);
  assert.doesNotMatch(r.text, /thief9|9999000011112222/);
  assert.match(r.text, /press "This wasn't us" before 28 Oct/);
  const c = m.helmNoticeEmail('studio_security', { event: 'pay_details_cancelled', studio: 'Studio A', by: 'Ravi', target: 'Asha Admin', old_upi: '****axis', new_upi: '****cici' }, '');
  assert.match(c.text, /Ravi cancelled the payment-details change made by Asha Admin\. Clients keep the old details/);
  assert.match(m.helmNoticeEmail('studio_security', { event: 'reply_to_changed', by: 'Ravi', old: 'none', new: 'pay@thief.example' }, '').text, /none {2}-> {2}\(hidden\)/);
  assert.match(m.helmNoticeEmail('studio_security', { event: 'pay_details_cancelled_unverified', by: 'Ravi', target: 'Asha' }, '').text, /had no fresh two-step code, so the account was not flagged or signed out/);
  assert.equal(m.helmNoticeEmail('studio_security', { event: 'nope' }, ''), null);
});

// ---- D. SQL 0285 ---------------------------------------------------------------------------------------------------------
await t('D1 SQL: the two-step gate is enforced in the database on every sensitive path', () => {
  assert.match(SQL, /'R35_SETUP_2STEP: /); assert.match(SQL, /'R35_REAUTH: /); assert.match(SQL, /'R35_FLAGGED: /);
  assert.match(SQL, /coalesce\(auth\.jwt\(\) ->> 'aal', ''\) <> 'aal2' or v_at is null or v_at < now\(\) - interval '15 minutes'/);
  for (const re of [/perform public\._r285_step_up\(v_org\);\n      perform public\._r285_request\(v_org, v_upi, v_note\);/,   // payment details
                    /if v_new is distinct from v_old then perform public\._r285_step_up\(v_org\); end if;/,              // reply-to
                    /function public\.save_org_payment_account[\s\S]{0,400}perform public\._r285_step_up\(v_org\);/,   // Razorpay keys
                    /if p_kind = 'razorpay' then perform public\._r285_step_up\(v_org\); end if;/,                       // Razorpay on / off
                    /v_money boolean := p_area in \('finance', 'discount_approve', 'close_owed'\)/,                    // money switches
                    /create trigger zz_r285_email_gate before update of business_email, business_email_confirmed on public\.organizations/,        // business e-mail
                    /create trigger zz_r285_admin_gate before insert or update of role, org_id or delete on public\.profiles/,
                    /create trigger zz_r285_invite_gate before insert or update of role on public\.invitations/,
                    /after update of status or delete on auth\.mfa_factors/]) assert.match(SQL, re);
  assert.match(SQL, /c\.requested_by = v_me then\n    raise exception 'Another admin has to approve this/);
  // R35-01: a flagged admin cannot cancel / sign out; flag + sign-out only with the canceller's own fresh two-step;
  // one sign-out per account per 10 minutes; the HQ Owner way out goes through the audited HQ write gate
  assert.match(SQL, /function public\.pay_details_cancel[\s\S]{0,900}if public\._r285_flagged\(v_org, v_me\) then\n    raise exception 'R35_FLAGGED/);
  assert.match(SQL, /begin perform public\._r285_step_up\(v_org\); v_strong := true;\n    exception when others then v_strong := false;/);
  assert.match(SQL, /function public\.studio_flagged_sign_out[\s\S]{0,600}if public\._r285_flagged\(v_org, auth\.uid\(\)\) then/);
  assert.match(SQL, /e\.at > now\(\) - interval '10 minutes'/);
  assert.match(SQL, /perform public\._hq_wgate\('hq\.studio\.flag_clear', 'studio_account_flags'/);
});
await t('D2 SQL: 24-hour wait, first set-up at once, lazy switch on read + tick, clients never see a pending change', () => {
  assert.match(SQL, /v_eff := case when v_first then now\(\) else now\(\) \+ interval '24 hours' end;/);
  assert.match(SQL, /x\.status = 'pending' and x\.effective_at <= now\(\)/);
  assert.match(SQL, /from public\.quotes q cross join lateral public\._r285_effective\(q\.org_id\) e/);
  assert.match(SQL, /perform cron\.schedule\('helm_pay_details_tick', '\*\/5 \* \* \* \*', 'select public\.pay_details_tick\(\)'\)/);
  assert.match(SQL, /v2 := public\.pay_details_tick\(\);/);
});
await t('D3 SQL: masked everywhere (alerts, audit, e-mail lane); additive only; ASCII; marker for the claim branch', () => {
  assert.match(SQL, /'\*\*\*\*' \|\| right\(btrim\(p\), 4\)/);
  assert.doesNotMatch(SQL.replace(/--[^\n]*/g, ''), /'old_upi', s\.upi_id|'new_upi', p_upi\)/);
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /\bdelete\s+from\b/i); assert.doesNotMatch(code, /\bdrop\s+(table|column|policy)\b/i); assert.doesNotMatch(code, /\btruncate\b/i);
  assert.doesNotMatch(SQL, /[^\x00-\x7F]/, 'ASCII only');
  assert.match(SQL, /r35-paysafe-0285: payment details \/ sensitive settings -> every admin/);
  assert.match(SQL, /add constraint helm_notice_outbox_kind_check_0285/);
});
await t('D4 APPLY-0285: migration verbatim between begin / commit + VERIFY rows; MANIFEST, run-all, release lists; owner file', () => {
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'));
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only'); assert.doesNotMatch(APPLY, /create temp/i);
  assert.ok(rd('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0285_r35_payment_details_safety.sql'));
  assert.match(rd('scripts/db-test/run-all.sh'), /R35-PAYSAFE-0285: ALL PASS \\\(100\/100\\\)/);
  // 0285 sits after 0283 (it requires it) and before any later release
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0282', '0283', '0285'(, '0[23]\d\d')*\]/, f);
  const owner = new URL('file:///Users/koushikgoudshaganti/Desktop/Agency/Helm/APPLY-0285.sql');
  if (existsSync(owner)) assert.equal(readFileSync(owner, 'utf8'), APPLY);
});
console.log(process.exitCode ? 'r35-paysafe: FAILED' : `r35-paysafe: ${n} passed`);
