// r116-trial-admin-fixes.test.mjs - R116: fixes from live end-to-end testing of a free-trial studio.
//   1  CI cache-bust guard (bump-changed-assets.mjs --check, run in CI against the PR base)
//   2  plan.html dish-search results above the next card       3  trial wording: test code 000000, never a real code
//   4  portal "Simulated schedule (trial)" label (no 2nd banner) 5  inventory empty state + boot never blocked
//   6  dashboard Audit log card/link never shown in a trial       7  event page "Price the quote first" numbering
//   8  nurture paints its shell at once                           9  simulated TEST payments on client + studio schedules
//   10 trial-test-note.js page() works with clean URLs            11 "Confirmed (test)" label in a trial
//   12 booklet banner on /<studio>/booklet/<uuid>                  13 Share booklet: floor plan / 3D "(paid plan)" in a trial
// Static + pure-function checks; the database side: tests/db/r116-trial-sim-reads-0324.sql. Paid studios unchanged.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const TS = require('../public/trial-sim.js');
const TN = require('../public/trial-test-note.js');

// ---- 1 CI guard --------------------------------------------------------------------------------------------------
t('1 CI runs the cache-bust guard on pull requests against the PR base (full history)', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /- name: Cache-bust guard[^\n]*\n\s+if: github\.event_name == 'pull_request'\n\s+env:\n\s+BASE_REF: \$\{\{ github\.base_ref \}\}/);
  assert.match(ci, /node scripts\/bump-changed-assets\.mjs --check --base "origin\/\$\{BASE_REF\}"/);
});
t('1 --check is read-only and judges the files on disk (not the planned rewrite)', () => {
  const s = read('scripts/bump-changed-assets.mjs');
  assert.match(s, /const CHECK = args\.includes\('--check'\)/);
  assert.match(s, /--check is read-only; do not combine with --apply/);
  assert.match(s, /const effective = APPLY \? texts : origTexts;/);
  assert.match(s, /r\.v <= bv/);
});
// a throwaway git repo with the real script: base commit, then a change to store-api.js / shell-proto.js
function sandbox() {
  const d = mkdtempSync(join(tmpdir(), 'r116-bump-'));
  mkdirSync(join(d, 'scripts')); mkdirSync(join(d, 'public'));
  writeFileSync(join(d, 'scripts', 'bump-changed-assets.mjs'), read('scripts/bump-changed-assets.mjs'));
  writeFileSync(join(d, 'public', 'a.html'), '<script src="store-api.js?v=324"></script>\n');
  writeFileSync(join(d, 'public', 'b.html'), '<script src="/store-api.js?v=324"></script>\n');
  writeFileSync(join(d, 'public', 'store-api.js'), '(function(){ var s=document.createElement("script"); s.src = "/shell-proto.js?v=56"; })();\n');
  writeFileSync(join(d, 'public', 'shell-proto.js'), 'var SHELL_V = "161";\n');
  writeFileSync(join(d, 'public', 'shell-b-dash.js'), '// dash\n');
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-qm', 'base');
  return { d, g, run: (...a) => spawnSync(process.execPath, ['scripts/bump-changed-assets.mjs', ...a], { cwd: d, encoding: 'utf8' }) };
}
t('1 guard: the #357 case (store-api.js changed, every ?v=324 kept) FAILS; after --apply it passes', () => {
  const s = sandbox();
  try {
    assert.equal(s.run('--check', '--base', 'HEAD').status, 0, 'no change -> ok (main itself never false-fails)');
    writeFileSync(join(s.d, 'public', 'store-api.js'), read('public/store-api.js').slice(0, 0) + '(function(){ var s=document.createElement("script"); s.src = "/shell-proto.js?v=56"; /* new */ })();\n');
    const bad = s.run('--check', '--base', 'HEAD');
    assert.equal(bad.status, 1, bad.stdout); assert.match(bad.stdout, /store-api\.js: public\/a\.html still \?v=324/); assert.match(bad.stdout, /CHECK FAILED/);
    assert.equal(readFileSync(join(s.d, 'public', 'a.html'), 'utf8').includes('?v=324'), true, '--check never writes');
    assert.equal(s.run('--apply', '--base', 'HEAD').status, 0);
    const ok = s.run('--check', '--base', 'HEAD'); assert.equal(ok.status, 0, ok.stdout); assert.match(ok.stdout, /check: OK/);
    assert.match(readFileSync(join(s.d, 'public', 'b.html'), 'utf8'), /store-api\.js\?v=325/);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});
t('1 guard covers store-api.js -> shell-proto.js?v= and SHELL_V (shell-group files)', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.d, 'public', 'shell-proto.js'), 'var SHELL_V = "161"; // changed\n');
    let r = s.run('--check', '--base', 'HEAD');
    assert.equal(r.status, 1); assert.match(r.stdout, /shell-proto\.js: public\/store-api\.js still \?v=56/);
    s.run('--apply', '--base', 'HEAD'); assert.equal(s.run('--check', '--base', 'HEAD').status, 0);
    s.g('add', '-A'); s.g('commit', '-qm', 'bumped');
    writeFileSync(join(s.d, 'public', 'shell-b-dash.js'), '// dash changed\n');
    r = s.run('--check', '--base', 'HEAD');
    assert.equal(r.status, 1); assert.match(r.stdout, /SHELL_V/);
    s.run('--apply', '--base', 'HEAD'); assert.match(readFileSync(join(s.d, 'public', 'shell-proto.js'), 'utf8'), /SHELL_V = "162"/);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

// ---- 2 dish dropdown ---------------------------------------------------------------------------------------------
t('2 plan.html: the open dish-results list lifts its card above later cards and is not clipped', () => {
  const p = read('public/plan.html');
  assert.match(p, /\.card:has\(#dishResults:not\(:empty\)\)\{position:relative;z-index:30;overflow:visible\}/);
  assert.match(p, /function hideResults\(\)\{ const r=\$\("#dishResults"\); r\.style\.display="none"; r\.innerHTML=""; \}/);
});

// ---- 3 trial wording ---------------------------------------------------------------------------------------------
const { linkEmail, TRIAL_APPROVAL_CONFIRM } = await import('../supabase/functions/client-mailer/logic.mjs');
t('3 linkEmail(): trial:true -> test code 000000 (no real code); without it the paid wording is unchanged', () => {
  const paid = linkEmail('approval', { studio: 'S', client: 'A', link: 'https://helm.events/x' });
  assert.match(paid.text, /\(you will get a one-time code to confirm\)\./);
  const tr = linkEmail('approval', { studio: 'S', client: 'A', link: 'https://helm.events/x', trial: true });
  assert.ok(tr.text.includes(TRIAL_APPROVAL_CONFIRM + '.')); assert.doesNotMatch(tr.text, /one-time code/);
  assert.match(TRIAL_APPROVAL_CONFIRM, /test code 000000 - nothing is sent/);
  const bk = linkEmail('booklet', { studio: 'S', link: 'https://helm.events/x', trial: true });
  assert.doesNotMatch(bk.text, /000000/);
  assert.match(read('supabase/functions/client-mailer/index.ts'), /address: postalAddress\(envGet\), trial: true \}\);/);
});
t('3 an old client-mailer preview is rewritten on screen too (works before the edge redeploy)', () => {
  assert.equal(TS.previewText('approve when ready (you will get a one-time code to confirm).'), 'approve when ready ' + TS.TRIAL_CONFIRM + '.');
  assert.match(read('public/trial-sim.js'), /el\("pre", "trial-sim-preview-body", previewText\(/);
  assert.match(read('public/email-send.js'), /replace\(\/\\\(you will get a one-time code to confirm\\\)\/g, "\(trial simulation: they confirm with the test code 000000 - nothing is sent\)"\)/);
});
t('3 flow step 9 / Share dialog: a trial says "they confirm with the test code 000000 (trial simulation - nothing is sent)"', () => {
  const want = 'Their page gets an Approve button - they confirm with the test code 000000 (trial simulation - nothing is sent). Untick to share the booklet only.';
  assert.equal(TN.ASK_TEXT, want); assert.equal(TN.shareSpec({ is_trial_org: true }).ask, want); assert.equal(TN.shareSpec({ is_trial_org: false }), null);
  assert.ok(read('public/booklet-share.js').includes('const TRIAL_ASK = "' + want + '"'));
  assert.match(read('public/flow.html'), /they confirm with a one-time code\. Untick to share the booklet only\./, 'paid wording unchanged');
});

// ---- 4 portal ----------------------------------------------------------------------------------------------------
t('4 portal: the schedule heading becomes "Simulated schedule (trial) - no real payment"; no second banner', () => {
  assert.equal(TS.SCHEDULE_LABEL, 'Simulated schedule (trial) — no real payment');
  const js = read('public/trial-sim.js'), m = /api\.markSchedule = function \(card\) \{([\s\S]*?)\n  \};/.exec(js);
  assert.ok(m); assert.doesNotMatch(m[1], /trial-sim-banner/); assert.match(m[1], /h\.textContent = SCHEDULE_LABEL/);
  assert.match(js, /api\.banner\(host\); api\.active = true;/);
  const p = read('public/portal.html');
  assert.match(p, /ledgerPaid\(\)\.finally\(paySchedule\)\.finally\(trialSched\)/);
  assert.match(p, /window\.addEventListener\("helm:trial-simulation",trialSched\);/);
  assert.match(p, /if\(!TS\|\|!TS\.active\|\|!TS\.markSchedule\) return;/, 'paid studio: nothing changes');
});

// ---- 5 inventory -------------------------------------------------------------------------------------------------
t('5 inventory: friendly empty state; a failed people read never blocks the stock list', () => {
  const p = read('public/inventory.html');
  assert.match(p, /<b>No stock items yet — add your first item\.<\/b>/);
  assert.match(p, /id="firstAdd">＋ Add your first item/);
  assert.match(p, /try\{ await fillPeople\(\); \}catch\(_\)\{\}/);
  assert.match(p, /items=Array\.isArray\(itemsR\.value\)\?itemsR\.value:\[\];/);
});

// ---- 6 audit -----------------------------------------------------------------------------------------------------
t('6 dashboard: the Recent activity / Audit log card is never unhidden for a trial and hides when the trial is known', () => {
  const s = read('public/shell-b-dash.js');
  assert.match(s, /if \(vAudit && !actTrial\(\)\) cAct\.hidden = false;/);
  assert.match(s, /window\.addEventListener\("helm:trial", hideActForTrial\);/);
  assert.match(s, /TOa\.inTrial\(\)\)\.then\(function \(t\) \{ if \(t === true\) \{ cAct\.hidden = true; dropMore\(cAct\); \} \}/);
  assert.match(read('public/trial-lock.css'), /html\.helm-trial \.hd-act-card/);
});

// ---- 7 numbering -------------------------------------------------------------------------------------------------
t('7 payment schedule hint: "(step 8)" only in the quote flow; elsewhere "(Quotation in the quote flow)"', () => {
  const s = read('public/payment-schedule.js');
  assert.match(s, /\(onFlowPage\(\) \? "\(step 8\)" : "\(Quotation in the quote flow\)"\)/);
  assert.match(s, /function onFlowPage\(\) \{ try \{ return \/\(\^\|\\\/\)flow\(\\\.html\)\?\\\/\?\$\/\.test/);
});

// ---- 8 nurture ---------------------------------------------------------------------------------------------------
t('8 nurture: #app paints right after the session check; checks run together; no data before requireView', () => {
  const p = read('public/nurture.html');
  const i = p.indexOf('BPUI.boot(async ()=>{'), b = p.slice(i, i + 2000);
  assert.ok(b.indexOf('$("#app").hidden=false;') < b.indexOf('await pView'));
  assert.ok(b.indexOf('location.replace("login.html') < b.indexOf('$("#app").hidden=false;'));
  assert.match(b, /if\(!\(await pView\)\)\{ \$\("#app"\)\.hidden=true; return; \}/);
  assert.ok(b.indexOf('await pView') < b.indexOf('await render()'));
});

// ---- 9 simulated payments ----------------------------------------------------------------------------------------
t('9 simList / simMarks / simReceivedLine (pure): TEST rows marked by id, else label + amount; paid -> null', () => {
  assert.equal(TS.simList(null), null); assert.equal(TS.simList({ simulation: false }), null);
  const sim = TS.simList({ simulation: true, currency: 'INR', rows: [{ milestone_id: 'm1', amount: 1000, label: 'Part 1', receipt: 'TEST-ABCDEF12' }] });
  assert.deepEqual(TS.simMarks([{ label: 'Part 1', amount: 1000 }, { label: 'Part 2', amount: 2000 }], sim), ['TEST-ABCDEF12', null]);
  assert.deepEqual(TS.simMarks([{ id: 'm2', label: 'Part 1' }, { id: 'm1', label: 'Part 1' }], sim), [null, 'TEST-ABCDEF12']);
  assert.deepEqual(TS.simMarks([{ label: 'Part 1', amount: 1000 }, { label: 'Part 1', amount: 1000 }], sim), ['TEST-ABCDEF12', null], 'one row per payment');
  assert.match(TS.simReceivedLine(sim), /^Simulated received ₹1,000(\.00)? \(test, no real money\)$/);
  assert.equal(TS.simReceivedLine(TS.simList({ simulation: true, rows: [] })), '');
  assert.equal(TS.receiptOf('abcdef12-0000-4000-8000-000000000000'), 'TEST-ABCDEF12');
  assert.equal(TS.PAID_TEST, 'Paid (test)');
});
t('9 store-api: public_trial_sim_payments (client) + own-studio trial_sim_payments read (studio)', () => {
  const a = read('public/store-api.js');
  assert.match(a, /trialSimList: \(kind, ref\) => mode === "supabase" && ref \? rpc\("public_trial_sim_payments", \{ p_kind: String\(kind \|\| ""\), p_ref: String\(ref\)\.slice\(0, 200\) \}\)\.catch\(\(\) => null\)/);
  assert.match(a, /supa\.from\("trial_sim_payments"\)\.select\("id, milestone_id, amount, currency, label, created_at"\)\.eq\("quote_id", quoteId\)/);
});
t('9 portal / booklet / studio schedule show "Paid (test) · TEST-..." + the simulated-received line', () => {
  const p = read('public/portal.html');
  assert.match(p, /BPStore\.approval\.trialSimList\("quote",token\)/);
  assert.match(p, /b\.className="paybadge paid"; b\.textContent=TS\.PAID_TEST\+" \\u00b7 "\+rc;/);
  const b = read('public/booklet.js');
  assert.match(b, /B\.approval\.trialSimList\("booklet", token\)/);
  assert.match(b, /el\("span", "st paid paid-test", TS\.PAID_TEST \+ " \\u00b7 " \+ marks\[i\]\)/);
  const s = read('public/payment-schedule.js');
  assert.match(s, /TL && TL\.isTrial && TL\.isTrial\(\) && B\.approval && B\.approval\.trialSimRows/);
  assert.match(s, /el\("span", "psch-chip psch-chip-paid", TSm\.PAID_TEST \+ " \\u00b7 " \+ marks\[ri\]\)/);
});
t('9 SQL 0324: one read-only definer function, additive, guarded; APPLY file + MANIFEST + DB suite', () => {
  const sql = read('supabase/migrations/0324_r116_trial_sim_reads.sql'), ap = read('supabase/APPLY-0324.sql');
  assert.match(sql, /create or replace function public\.public_trial_sim_payments\(p_kind text, p_ref text\)\nreturns jsonb language plpgsql stable security definer set search_path = ''/);
  assert.doesNotMatch(sql.replace(/--[^\n]*/g, ''), /\b(drop|delete|truncate|alter table|insert|update)\b/i);
  assert.match(sql, /raise exception 'STOP 0324: 0323/);
  assert.ok(ap.includes(sql.trim())); assert.match(ap, /^begin;$/m); assert.match(ap, /^commit;$/m);
  assert.equal((ap.match(/^  \('0\d /gm) || []).length, 4);
  assert.doesNotMatch(ap, /[^\x00-\x7f]/); assert.doesNotMatch(ap, /temp table|^\\/im);
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0324_r116_trial_sim_reads\.sql\n/);
  assert.match(read('scripts/db-test/run-all.sh'), /R116-TRIAL-SIM-READS-0324: ALL PASS \\\(12\/12\\\)/);
});

// ---- 10 clean URLs -----------------------------------------------------------------------------------------------
t('10 trial-test-note.js page(): clean URLs (/flow, /<studio>/flow, /settlement) as well as *.html', () => {
  for (const [p, want] of [['/flow', 'flow'], ['/flow.html', 'flow'], ['/flow/', 'flow'], ['/sparkv/flow', 'flow'], ['/settlement', 'settlement'],
    ['/sparkv/settlement', 'settlement'], ['/settlement.html', 'settlement'], ['/', ''], ['', '']]) assert.equal(TN.pageFrom(p), want, p);
  assert.doesNotMatch(read('public/trial-test-note.js'), /\/\(\[a-z0-9_-\]\+\)\\\.html\/i\.exec/);
});

// ---- 11 status label ---------------------------------------------------------------------------------------------
t('11 quoteStatus: a trial approval reads "Confirmed (test) · Approved (test mode)"; paid studios unchanged', () => {
  const a = read('public/store-api.js');
  assert.match(a, /if \(ap === "approved" && qsTrial\(opts\)\) return mk\("approved", "Confirmed \(test\) · Approved \(test mode\)", "confirmed"/);
  assert.match(a, /if \(ap === "approved"\) return mk\("approved", "Confirmed · client approved", "confirmed", "The client approved this quote\.", true\);/);
  // run the real function in a sandbox
  const i = a.indexOf('  var QS_STAGES = '), j = a.indexOf('  // ---- r23 (0263): ONE canonical stage');
  const code = a.slice(i, j);
  const mkQS = (trialOn) => { const BPStore = {}; const global = { HelmTrialLock: { isTrial: () => trialOn } };
    new Function('BPStore', 'global', code)(BPStore, global); return BPStore.quoteStatus; };
  assert.equal(mkQS(true)({ approval_status: 'approved' }).label, 'Confirmed (test) · Approved (test mode)');
  assert.equal(mkQS(false)({ approval_status: 'approved' }).label, 'Confirmed · client approved');
  assert.equal(mkQS(true)({ approval_status: 'approved' }, { trial: false }).label, 'Confirmed · client approved');
  assert.equal(mkQS(true)({ approval_status: 'approved' }).confirmed, true);
  assert.equal(mkQS(true)({ approval_status: 'sent' }).label, 'Sent · awaiting client approval');
});

// ---- 12 booklet clean URL ----------------------------------------------------------------------------------------
t('12 refFrom: every client page form (booklet / quote / portal / proposal / invitation) incl. clean branded paths', () => {
  const u = '1031d36c-1111-4222-8333-444455556666';
  const r = (k, pathname, search = '') => TS.refFrom(k, { pathname, search });
  assert.equal(r('booklet', '/sparkv/booklet/' + u), u); assert.equal(r('booklet', '/sparkv/booklet/' + u + '/'), u);
  assert.equal(r('booklet', '/booklet', '?t=' + u), u); assert.equal(r('booklet', '/booklet.html', '?token=' + u), u);
  assert.equal(r('booklet', '/sparkv/booklet/not-a-uuid'), '');
  assert.equal(r('quote', '/sparkv/quote/' + u), u); assert.equal(r('quote', '/sparkv/portal/' + u), u);
  assert.equal(r('quote', '/approve', '?token=' + u), u); assert.equal(r('quote', '/portal.html', '?token=' + u), u);
  assert.equal(r('site', '/i/asha-wedding'), 'asha-wedding'); assert.equal(r('site', '/sparkv/invite/asha-wedding'), 'asha-wedding');
  const v = JSON.parse(read('vercel.json'));
  assert.ok(v.rewrites.some((x) => x.source === '/([a-z0-9-]+)/booklet/([^/]+)' && x.destination === '/booklet'));
});

// ---- 13 share dialog ---------------------------------------------------------------------------------------------
t('13 Share booklet in a trial: Floor plan / 3D view switches say "(paid plan)" and are off', () => {
  const s = read('public/booklet-share.js');
  assert.match(s, /\["layout2d", "layout3d"\]\.forEach\(\(k\) => \{/);
  assert.match(s, /cb\.disabled = true; cb\.checked = false; lab\.title = "Paid plan - client floor plan and 3D images are off in the free trial";/);
  assert.match(s, /lab\.appendChild\(doc\.createTextNode\(" \(paid plan\)"\)\);/);
});

// ---- 14 in-app trial copy (not the agreed terms) -----------------------------------------------------------------
t('14 teammate notice + in-app lines say simulation; the agreed terms (SECTIONS / SIGNUP_* / VERSION) are untouched', () => {
  const F = read('public/trial-facts.js');
  assert.match(F, /"Trial simulation: nothing is sent to clients \\u2014 approval, booklet and invitation links show a preview, the approval uses the test code 000000, and payments are simulated \(TEST receipts\)\.",/);
  assert.doesNotMatch(F, /"E-mail works: approval, booklet and invitation links/);
  assert.match(F, /var VERSION = "trial-2026-11-01";/, 'R117 (0325): the terms text changed, so the version did');
  // R117 (owner approved, 0325): the agreed terms now say "nothing is sent to clients" (test/r117-trial-terms-proposal.test.mjs)
  assert.match(F, /\{ t: "Try sending to clients \(simulation\)", s: "Approval, booklet and invitation links show a preview/);
  assert.match(F, /"During the trial nothing is sent to your clients: approval, booklet and invitation links show a preview/);
  assert.doesNotMatch(read('public/email-send.js'), /this e-mail really goes to your client/);
  assert.doesNotMatch(read('public/getting-started.js'), /it really reaches your client in the trial/); assert.match(read("public/getting-started.js"), /nothing is sent in the trial - you see a preview; the client approves with code 000000/);
  assert.doesNotMatch(read('public/invite-site-share.js'), /the e-mail really goes to your client/);
});

// ---- 15 active-trial "Ask my admin to upgrade" -------------------------------------------------------------------
t('15 active trial: a teammate gets "Ask my admin to upgrade" (0244 flow); an admin keeps "Choose a plan" only', () => {
  const TR = require('../public/trial.js');
  const ends = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const mate = TR.bannerSpec({ is_trial_org: true, is_admin: false, ends_at: ends, days_left: 5, timezone: 'Asia/Kolkata' });
  assert.equal(mate.ask, 'Ask my admin to upgrade'); assert.equal(mate.cta, null); assert.equal(mate.locked, false);
  const adm = TR.bannerSpec({ is_trial_org: true, is_admin: true, ends_at: ends, days_left: 5, timezone: 'Asia/Kolkata' });
  assert.equal(adm.ask, undefined); assert.equal(adm.cta, 'Choose a plan');
  const ended = TR.bannerSpec({ is_trial_org: true, is_admin: false, read_only: true });
  assert.equal(ended.ask, 'Ask my admin to upgrade', 'ended trial unchanged');
  assert.equal(TR.askResultText({ sent: true }), 'Done - your studio admin has been asked to choose a plan.');
  assert.equal(TR.askResultText({ already: true }), 'Your studio admin has already been asked today.');
  assert.equal(TR.bannerSpec({ is_trial_org: false }), null, 'paid studio: no strip');
  const src = read('public/trial.js');
  assert.match(src, /if \(spec\.ask\) \{[\s\S]*?st\.trialOrg\.askAdmin\(\)[\s\S]*?am\.textContent = askResultText\(r\);/);
  const sql = read('supabase/migrations/0244_trial_to_paid_activation.sql');
  assert.match(sql, /if not \(public\._is_trial_org\(v_org\) or public\._trial_locked\(v_org\)\) then/, 'active trial allowed server-side');
  assert.match(sql, /nt\.detail ->> 'ask_by' = v_uid::text\s+and nt\.created_at > now\(\) - interval '1 day'/, 'once a day per teammate');
  assert.match(sql, /where p\.org_id = r\.org_id and p\.role = 'admin' and p\.email is not null/, "this studio's admins only");
});

console.log(`\nr116-trial-admin-fixes: ${n} passed`);
