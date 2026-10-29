// r33-team-safety.test.mjs - r33 team safety (SQL 0283, owner-approved EDGE-CASES-PLAN B1 / B4 / B5), the browser / repo side:
//  * team-safety.js: the overview -> table view, the waiting-change / hand-over banner lines, open-work links, refusals in
//    plain words (by the server's hint), the fresh two-step retry; DOM by createElement only (no innerHTML)
//  * Settings (control.html): "Remove" is Deactivate (never "permanently deletes"), Owner badge, no Deactivate on the
//    owner, deactivated rows offer Reactivate + Open work, a non-owner's admin change says "24 hours", banner box wired
//  * store-api: BPStore.team.* -> the team_* RPCs; bell kind team_safety (label + Settings link); v286 everywhere
//  * comms-dispatch: the team_safety e-mail for every event (names only), unknown event -> null
//  * hq.js: "Studio owner" card + "Recover studio owner" (Owner role only, written reason 20+)
//  * SQL 0283: MANIFEST + run-all + release lists, APPLY verbatim + VERIFY, ASCII, additive only, STOP guard
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const TS = rd('public/team-safety.js'), C = rd('public/control.html'), API = rd('public/store-api.js'), HQ = rd('public/hq.js');
const SQL = rd('supabase/migrations/0283_r33_team_safety.sql'), APPLY = rd('supabase/APPLY-0283.sql');
function loadTeam() { const w = {}; vm.runInNewContext(TS, { window: w, globalThis: w, document: undefined, encodeURIComponent }); return w.HelmTeam; }
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name);
  let d = 0; for (let k = src.indexOf('{', i); k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && !--d) return src.slice(i, k + 1); }
  throw new Error('unbalanced ' + name);
}
function ucTable() {
  const ctx = { esc };
  vm.runInNewContext('const ucId=(u)=>u.user_id||u.id;' + ['ucDate', 'ucShownName', 'ucNameHtml', 'ucPhone', 'ucInitials', 'ucPrivateVisible', 'ucMatches', 'ucTable']
    .map((f) => fnSrc(C, f)).join('\n') + '\nglobalThis.T=ucTable;', ctx);
  return ctx.T;
}
const ROW = (i, o) => Object.assign({ id: 'u' + i, email: 'p' + i + '@studio.test', full_name: 'Person ' + i, role: 'crew', complete: true, created_at: '2026-09-01', whatsapp_same: true }, o || {});
const OV = { owner_id: 'u1', i_am_owner: false, is_admin: true, me: 'u2', deactivated: [{ user_id: 'u4', deactivated_at: '2026-10-20T10:00:00Z' }],
  pending: [{ id: 'c1', target_user: 'u3', target_name: 'Meera', kind: 'deactivate', requested_by_name: 'Ravi', effective_at: '2026-10-28T08:30:00Z', can_cancel: true }],
  transfer: null, admins: [{ user_id: 'u1', name: 'Anil' }, { user_id: 'u2', name: 'Ravi' }, { user_id: 'u3', name: 'Meera' }] };

await t('team-safety.js: view() - owner, deactivated set, waiting change per person; null before 0283', () => {
  const H = loadTeam();
  const v = H.view(OV);
  assert.equal(v.ownerId, 'u1'); assert.equal(v.iAmOwner, false); assert.ok(v.isOff('u4')); assert.ok(!v.isOff('u3'));
  assert.equal(v.pending.u3.id, 'c1');
  assert.equal(H.view(null), null);
});
await t('team-safety.js: banner lines - waiting change (+ Cancel when allowed), hand-over for the new owner / the owner / others', () => {
  const H = loadTeam();
  const b = H.bannerItems(OV);
  assert.equal(b.length, 1); assert.match(b[0].text, /^Meera will be deactivated on .+ \(asked by Ravi\)\.$/);
  assert.deepEqual([...b[0].actions].map((a) => a.act + ':' + a.id), ['cancel-change:c1']);
  const noCancel = H.bannerItems({ ...OV, pending: [{ ...OV.pending[0], can_cancel: false, kind: 'demote', role_label: 'Event manager' }] });
  assert.match(noCancel[0].text, /^Meera will become Event manager on /); assert.equal(noCancel[0].actions.length, 0);
  const tr = { id: 't1', from_user: 'u1', from_name: 'Anil', to_user: 'u2', to_name: 'Ravi', expires_at: '2026-11-03T00:00:00Z' };
  const mine = H.bannerItems({ ...OV, pending: [], transfer: tr });
  assert.match(mine[0].text, /^Anil wants to make you the studio owner\./);
  assert.deepEqual([...mine[0].actions].map((a) => a.act), ['transfer-accept', 'transfer-decline']);
  const owner = H.bannerItems({ ...OV, pending: [], me: 'u1', i_am_owner: true, transfer: tr });
  assert.match(owner[0].text, /^Waiting for Ravi to accept ownership/); assert.deepEqual([...owner[0].actions].map((a) => a.act), ['transfer-cancel']);
  const other = H.bannerItems({ ...OV, pending: [], me: 'u3', transfer: tr });
  assert.match(other[0].text, /Anil is handing ownership to Ravi\./); assert.equal(other[0].actions.length, 0);
});
await t('team-safety.js: open-work links (tasks -> Operations row, events -> event, leads -> Leads), ids encoded', () => {
  const H = loadTeam();
  const l = H.workLinks({ tasks: [{ id: 't 1', title: 'Stage', quote_id: 'q1', code: 'A-1' }], events: [{ quote_id: 'q2', code: 'A-2', event: 'Wedding' }], leads: [{ id: 'l1', name: 'Rahul' }] });
  assert.deepEqual([...l].map((x) => x.group), ['Tasks', 'Events they manage', 'Leads they own']);
  assert.equal(l[0].href, 'ops.html?quote=q1&task=t%201'); assert.equal(l[1].href, 'event.html?id=q2'); assert.equal(l[2].href, 'leads.html');
  assert.equal(l[0].text, 'Stage - A-1'); assert.equal(l[1].text, 'A-2 - Wedding');
  assert.equal(H.workLinks(null).length, 0);
});
await t('team-safety.js: refusals in plain words by hint; a seat refusal says to free a seat; "not authorized" never shown raw', () => {
  const H = loadTeam();
  for (const h of ['owner_protected', 'admin_change_delay', 'change_pending', 'self', 'not_owner', 'not_admin', 'transfer_pending', 'deactivated', 'use_deactivate']) {
    assert.equal(H.errText({ hint: h, message: 'raw' }), H.HINT_TEXT[h], h);
  }
  assert.match(H.errText({ hint: 'plan_seat_limit', message: 'Your plan allows 2 team invites. Contact sales to add more.' }), /Your plan allows 2 team invites\. Contact sales to add more\. To reactivate this person, free a seat first\./);
  assert.equal(H.errText({ message: 'not authorized' }, 'Fallback.'), 'Fallback.');
  assert.equal(H.errText({ message: 'Something specific' }), 'Something specific');
});
await t('team-safety.js: a "reauth" refusal asks for the two-step code once and retries; other errors pass through', async () => {
  const H = loadTeam();
  let calls = 0, code = null;
  const deps = { prompt: async () => '123456', mfa: { challenge: async (c) => { code = c; } } };
  const r = await H.call(async () => { calls++; if (calls === 1) { const e = new Error('x'); e.hint = 'reauth'; throw e; } return 'ok'; }, deps);
  assert.equal(r, 'ok'); assert.equal(calls, 2); assert.equal(code, '123456');
  await assert.rejects(H.call(async () => { const e = new Error('no'); e.hint = 'owner_protected'; throw e; }, deps), /no/);
  await assert.rejects(H.call(async () => { const e = new Error('x'); e.hint = 'reauth'; throw e; }, { prompt: async () => null, mfa: { challenge: async () => {} } }), /Cancelled/);
});
await t('team-safety.js: no innerHTML / insertAdjacentHTML / document.write (textContent only)', () => {
  const code = TS.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

await t('Settings: members table - Owner badge, no Deactivate on the owner, Deactivate (class rm) on others, deactivated rows', () => {
  const T = ucTable(), H = loadTeam();
  const rows = [ROW(1, { role: 'admin' }), ROW(2, { role: 'admin' }), ROW(3, { role: 'admin' }), ROW(4)];
  const r = T(rows, { profiles: true, meId: 'u2', roles: ['admin', 'crew'], roleLabel: (x) => x, canEdit: true, q: '', filter: '', team: H.view(OV) });
  assert.equal((r.body.match(/<span class="tag ts-own"/g) || []).length, 1, 'one Owner badge');
  assert.match(r.body, /<tr class="ucr" data-id="u1">[\s\S]*?Owner<\/span>/);
  assert.equal((r.body.match(/class="rm"/g) || []).length, 1, 'Deactivate only on u3 (not me, not the owner, not the deactivated)');
  assert.match(r.body, /aria-label="Deactivate p3@studio\.test">Deactivate<\/button>/);
  assert.match(r.body, /<tr class="ucr ucoff" data-id="u4">/);
  assert.match(r.body, /class="btn sm ucReact" aria-label="Reactivate p4@studio\.test">Reactivate<\/button><button type="button" class="btn sm ucWork"/);
  assert.match(r.body, /<span class="tag ts-off"[^>]*>Deactivated<\/span>/);
  assert.match(r.body, /<span class="tag ts-wait"[^>]*>Change waiting<\/span>/);
  assert.match(r.body, /<tr class="ucr" data-id="u1">[\s\S]*?<select class="roleSel"[^>]* disabled title="The studio owner always stays an admin"/);
  assert.match(r.body, /data-id="u4">[\s\S]*?<select class="roleSel"[^>]* disabled title="Reactivate them first"/);
  // without 0283 (no team state): every other row keeps its (Deactivate) button, as before
  const old = T(rows, { profiles: true, meId: 'u2', roles: ['admin', 'crew'], q: '', filter: '' });
  assert.equal((old.body.match(/class="rm"/g) || []).length, 3); assert.doesNotMatch(old.body, /ts-own|ucoff/);
});
await t('Settings: Deactivate wording + flow (never "permanently deletes"), 24-hour wording for a non-owner, Reactivate / Open work', () => {
  assert.doesNotMatch(C, /permanently deletes their account/);
  assert.doesNotMatch(C, /Delete user account\?/);
  assert.match(C, /BPStore\.team\?BPStore\.team\.deactivate\(id, null\):BPStore\.auth\.admin\.deleteUser\(id\)/);
  assert.match(C, /const delayed=!!\(team&&!team\.iAmOwner&&u\.role==="admin"\);/);
  assert.match(C, /your request takes effect in 24 hours\. The owner and \$\{email\} are told now, and the owner can cancel it\./);
  assert.match(C, /Everything they made stays, with their name marked "\(deactivated\)"\. They no longer use a seat, and you can reactivate them later\./);
  assert.match(C, /BPStore\.team\.reactivate\(id\)/); assert.match(C, /BPStore\.team\.openWork\(id\)/);
  assert.match(C, /HelmTeam\.paintWork\(\$\("#team_work"\)/);
  assert.match(C, /if\(r&&r\.scheduled\)\{ if\(prev\) e\.target\.value=prev\.value; setUMsg\("ok","Asked\. The change happens in 24 hours unless the owner cancels it\."\)/);
  assert.match(C, /team&&BPStore\.team\?BPStore\.team\.setRole\(id, role\):BPStore\.auth\.admin\.setRole\(id, role\)/);
  assert.match(C, /try\{ ucTeam=BPStore\.team\?await BPStore\.team\.overview\(\):null; \}catch\(e\)\{ ucTeam=null; \}/);
  assert.match(C, /HelmTeam\.paint\(\$\("#team_safety"\), ucTeam, \{ store:BPStore\.team, guard:BPUI\.guard, confirm:BPUI\.confirm, prompt:BPUI\.prompt,/);
  assert.match(C, /<div id="team_safety" aria-live="polite" hidden><\/div>\s*<div id="team_work" aria-live="polite" hidden><\/div>/);
  assert.match(C, /<script src="team-safety\.js\?v=3"><\/script>/); assert.match(C, /<link rel="stylesheet" href="team-safety\.css\?v=2">/);
  assert.ok(C.indexOf('team-safety.js?v=3') < C.indexOf('async function renderUsers()'), 'loaded before the page script');
});

await t('store-api: BPStore.team -> team_* RPCs; bell kind team_safety (label + Settings link); v286 on every page', () => {
  for (const [fn, rpc] of [['overview', 'team_safety_overview'], ['deactivate', 'team_deactivate_member'], ['reactivate', 'team_reactivate_member'],
    ['setRole', 'team_set_role'], ['cancelChange', 'team_change_cancel'], ['openWork', 'team_member_open_work'], ['transferStart', 'team_owner_transfer_start'],
    ['transferAccept', 'team_owner_transfer_accept'], ['transferCancel', 'team_owner_transfer_cancel']]) {
    assert.match(API, new RegExp(fn + ': \\([^)]*\\) => [^\\n]*rpc\\("' + rpc + '"'), fn);
  }
  assert.match(API, /team_safety: \["🛡️", String\(d\.label \|\| "Team change"\)\],/);
  assert.match(API, /if \(k === "team_safety"\) return "control\.html#users";/);
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const m = rd('public/' + f).match(/store-api\.js\?v=(\d+)/); if (m) assert.equal(m[1], '304', f);
  }
});
await t('comms-dispatch: the team_safety e-mail for every event (names only, Team link on APP_URL); unknown event -> null', async () => {
  const m = await import('../supabase/functions/comms-dispatch/helm-notices.mjs');
  assert.ok(m.NOTICE_KINDS.includes('team_safety') && m.NOTICE_TX_REASON.team_safety);
  const app = 'https://www.helm.events', base = { studio: 'Aurora Events', target: 'Meera', by: 'Ravi', from: 'Anil', to: 'Ravi', role_label: 'Event manager', when: '28 Oct 2026, 14:00 (Asia/Kolkata)' };
  const cases = {
    admin_change_requested: [/Meera will be deactivated in 24 hours - Aurora Events/, /Ravi asked to deactivate Meera in Aurora Events\. It happens on 28 Oct 2026, 14:00 \(Asia\/Kolkata\) unless the studio owner cancels it\./],
    admin_change_cancelled: [/the change for Meera was cancelled/, /Nothing was changed\./],
    admin_change_applied: [/Meera was deactivated - Aurora Events/, /Their records are kept; an admin can reactivate them\./],
    admin_deactivated: [/Meera was deactivated/, /Ravi \(the studio owner\) deactivated Meera/],
    admin_demoted: [/Meera is now Event manager/, /from Admin to Event manager/],
    owner_transfer_started: [/Anil wants to make Ravi the owner of Aurora Events/, /must accept it in Settings -> Team within 7 days/],
    owner_transfer_accepted: [/Ravi is now the owner of Aurora Events/, /Anil stays an admin/],
    owner_transfer_cancelled: [/hand-over was cancelled/, /Nothing changed\./],
    owner_transfer_declined: [/Ravi declined/, /Anil stays the owner/],
    owner_recovered: [/Helm support made Ravi the owner of Aurora Events/, /security@helm\.events/],
  };
  for (const [ev, [subj, body]] of Object.entries(cases)) {
    const e = m.helmNoticeEmail('team_safety', { ...base, event: ev, kind: 'deactivate' }, app);
    assert.ok(e, ev); assert.match(e.subject, subj, ev); assert.match(e.text, body, ev);
    assert.match(e.text, /https:\/\/www\.helm\.events\/control#users|security@helm\.events/, ev);
    assert.doesNotMatch(e.text, /@studio|token|password/i, ev);
  }
  assert.match(m.helmNoticeEmail('team_safety', { ...base, event: 'admin_change_requested', kind: 'demote' }, app).subject, /Meera will become Event manager in 24 hours/);
  assert.equal(m.helmNoticeEmail('team_safety', { ...base, event: 'nope' }, app), null);
});
await t('hq.js: "Studio owner" card + "Recover studio owner" (HQ Owner only, active admins only, reason 20+, confirm)', () => {
  assert.match(HQ, /call\("hq_studio_owner_info", \{ p_org: org \}\)/);
  assert.match(HQ, /call\("hq_studio_owner_recover", \{ p_org: org, p_email: sel\.value, p_reason: reason \}\)/);
  assert.match(HQ, /if \(!can\("owner\.only"\)\) \{/);
  assert.match(HQ, /if \(reason\.length < 20\) \{/);
  assert.match(HQ, /a && a\.active && \(!o \|\| a\.user_id !== o\.user_id\)/);
  assert.match(HQ, /"hq\.studio\.owner_recover": "Studio owner recovered"/);
  assert.match(rd('public/hq.html'), /<script src="hq\.js\?v=28"><\/script>/);
});

await t('SQL 0283: registered (MANIFEST, run-all, release lists), APPLY verbatim + VERIFY, ASCII, additive only, STOP guard', () => {
  assert.match(rd('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0283_r33_team_safety\.sql$/m);
  const man = rd('supabase/migrations/MANIFEST');
  assert.ok(man.indexOf('0282_r32_security_review.sql') < man.indexOf('0283_r33_team_safety.sql'), '0283 after 0282');
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r33-team-safety-0283" "R33-TEAM-SAFETY-0283: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r33-team-safety-0283\.sql/);
  // later releases (0284 / 0285 ...) may follow 0283 once merged
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0282', '0283'(, '0[23]\d\d')*\]/, f);
  assert.ok(APPLY.includes(SQL.trimEnd()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok((APPLY.match(/^  \('\d\d /gm) || []).length >= 10, 'VERIFY rows');
  for (const s of [SQL, APPLY, rd('tests/db/r33-team-safety-0283.sql')]) assert.ok(/^[\x00-\x7f]*$/.test(s), 'ASCII only');
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|policy|schema|view|index)\b/i, 'no drops (triggers re-created; the outbox kind check replaced by a superset)');
  assert.doesNotMatch(code, /\bdelete\s+from\b|\btruncate\s+(table\s+)?(public|auth)\./i, 'no data deleted');
  assert.doesNotMatch(code, /delete from auth\.users|create\s+temp|pg_temp/i, 'no login deleted, no temp tables / session state');
  assert.match(code, /STOP 0283:/, 'STOP guard when 0282 is missing');
  assert.match(code, /create table if not exists public\.team_member_status/);
  assert.match(code, /perform public\.team_deactivate_member\(p_id, 'Removed in Control Center'\);/, 'admin_delete_user deactivates');   // r38-keep: applied SQL 0283 text (immutable)
  assert.match(code, /grant execute on function %s to authenticated/);
  assert.match(code, /alter table public\.%I enable row level security/);
  assert.match(rd('package.json'), /node test\/r33-team-safety\.test\.mjs/);
});

console.log(`r33-team-safety: ${n} test(s) passed.`);
