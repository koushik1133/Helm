// r21 event UI: the event workspace, quote page, Share booklet / Share with client dialog, client page, client
// booklet and portal were re-laid out (presentation only). These checks pin what must NOT change (ids used by JS,
// gates, data calls) and the new pieces: the header ••• menu, the one-line stepper, the ONE "Share with client"
// dialog (booklet + approval link) on the quote page and the event workspace. No network, no DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const EV = read('public/event.html'), UI = read('public/event-ui.css'), FLOW = read('public/flow.html'), FP = read('public/flow-polish.css');
const BS = read('public/booklet-share.js'), BSC = read('public/booklet-share.css'), PORTAL = read('public/portal.html');
const CL = read('public/client.css'), BV2 = read('public/booklet-v2.css');
const tests = []; const t = (n, f) => tests.push([n, f]);

t('event: every id the page script uses is still in the markup', () => {
  for (const id of ['code', 'statusBadge', 'apprBadge', 'title', 'meta', 'dateRow', 'total', 'clientLink', 'bkShare', 'inviteBtn', 'cancelEvBtn',
    'advBtn', 'nextHint', 'nextStepBar', 'nextStepBtn', 'nextStepWhy', 'nextPayBtn', 'steps', 'stepsMini', 'stepWrap', 'stagePanel', 'reapprBanner',
    'mods', 'evStick', 'evStickIn', 'esCode', 'esTitle', 'esNow', 'capIssues', 'conflictBanner', 'filesPanel', 'egPanel', 'evHead'])
    assert.equal((EV.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
  assert.match(EV, /<link rel="stylesheet" href="event-ui\.css\?v=\d+">/);
  assert.match(EV, /id="bkShare" data-approval data-booklet-share data-quote-from-url hidden/);
});
t('event: Invitation site + Cancel event are on the card again (r22) and repeated in the ••• menu; the menu shows only with a visible item', () => {
  const pop = EV.slice(EV.indexOf('id="evMenuPop"'), EV.indexOf('</div>', EV.indexOf('id="evMenuPop"')));
  assert.match(pop, /data-proxy="inviteBtn"/); assert.match(pop, /data-proxy="cancelEvBtn"/);
  assert.doesNotMatch(pop, /id="inviteBtn"|id="cancelEvBtn"/);
  const foot = EV.slice(EV.indexOf('class="nextbar evfoot"'), EV.indexOf('id="advBtn"'));
  assert.match(foot, /id="inviteBtn"/); assert.match(foot, /id="cancelEvBtn"/);
  assert.match(EV, /function syncEvMenu\(\)\{[\s\S]*?const any=\[\.\.\.pop\.children\]\.some\(c=>!c\.hidden\);\s*m\.hidden=!any;/);
  assert.match(EV, /inv\.hidden=true;\n    syncEvMenu\(\);/);
  assert.match(EV, /e\.key==="Escape" && !pop\.hidden/);
  // the gates themselves are unchanged
  assert.match(EV, /\$\("#cancelEvBtn"\)\.hidden=!\(canEdit && \(myRole==="admin"\|\|myRole==="manager"\) && !evLocked\(\)\);/);
  assert.match(EV, /if\(canEdit && cur>=stageIndex\("confirmed"\)\)\{ inv\.hidden=false;/);
});
t('event: the date row keeps its inputs + save rules, without inline styles', () => {
  assert.match(EV, /<input type="date" data-min-today id="evDate" aria-label="Event date" value="\$\{esc\(d\)\}" class="evd-in">/);
  assert.match(EV, /id="evTime" aria-label="Event time" value="\$\{esc\(evTimeInput\(tm\)\)\}" class="evd-in"/);
  const fn = EV.slice(EV.indexOf('function renderDateRow(){'), EV.indexOf('function evDateLabel'));
  assert.doesNotMatch(fn, /style="\$\{inp\}"/);
  assert.match(fn, /di\.addEventListener\("change",\(\)=>commitDate\(false\)\);/);
});
t('event: one share action - "Share with client" until approved, then "Share booklet"', () => {
  assert.match(EV, /bk\.textContent=done\?"📖 Share booklet":"📤 Share with client";/);
  assert.match(EV, /window\.addEventListener\("helm:approval-link"/);
});
t('event-ui.css: the stepper fits one line on desktop (11 columns, no arrows); arrows stay on small screens', () => {
  assert.match(UI, /@media \(min-width:1024px\)\{\s*#evHead #stepWrap\{/);
  assert.match(UI, /#evHead #stepWrap \.steps\{display:grid;grid-template-columns:repeat\(11,minmax\(0,1fr\)\)/);
  assert.match(UI, /#evHead #stepWrap \.stp-arr\{display:none!important\}/);
  assert.match(UI, /\.evstick \.steps\{display:grid;grid-template-columns:repeat\(11,minmax\(0,1fr\)\)/);
});
t('event-ui.css: card buttons are solid again (r22, owner) + masked money keeps its size', () => {
  assert.doesNotMatch(UI, /#app \.mod:not\(\.reco\) \.act \.btn\.primary\{background:var\(--panel\)/);
  assert.match(UI, /html\.hb-priv-on #evHead \.tot \.amt\{min-width:6ch/);
});

t('booklet-share: approvalDone - an approval step only before the client approved', () => {
  const sb = { window: {}, document: { querySelector: () => null }, location: { search: '' } };
  sb.window = sb; sb.globalThis = sb;
  vm.runInNewContext(BS, sb);
  const done = sb.HelmBookletShare.approvalDone;
  assert.equal(done(null), true, 'unreadable quote: never offer approval');
  assert.equal(done({ status: 'quote', approvalStatus: 'none' }), false);
  assert.equal(done({ status: 'quote', approvalStatus: 'sent' }), false);
  assert.equal(done({ status: 'confirmed', approvalStatus: 'approved' }), true);
  assert.equal(done({ status: 'confirmed', approvalStatus: 'paid' }), true);
  assert.equal(done({ status: 'cancelled', approvalStatus: 'sent' }), true);
  assert.equal(done({ status: 'quote', approvalStatus: 'sent', lifecycleStage: 'closed' }), true);
});
t('booklet-share: the approval link uses the SAME existing calls (no new RPC) and is DOM-safe', () => {
  const fn = BS.slice(BS.indexOf('async function renderApproval'), BS.indexOf('let dlg = null;'));
  assert.match(fn, /st\.approval\.generateToken\(quoteId\)/);
  assert.match(fn, /st\.links\.build\("portal", token, global\.location\.origin \+ "\/portal\.html\?token=" \+ encodeURIComponent\(token\)\)/);
  assert.match(fn, /HelmEmailSend\.mount\(out, \{ quoteId: quoteId, kind: "approval"/);
  assert.match(fn, /global\.HelmCapacity\.gate\(\{ quoteId: quoteId, quote: q, why: "send" \}\)/);
  assert.doesNotMatch(fn, /\brpc\(|innerHTML|insertAdjacentHTML|\.style\./);
  assert.match(BS, /await renderApproval\(quoteId, btn\.hasAttribute\("data-approval"\)\);\n    await load\(quoteId\);/);
  assert.match(BS, /if \(approvalDone\(q\) \|\| !st\.approval/);
  // the booklet's own Send box is folded (not removed) while the approval link is being made
  assert.match(BS, /if \(asking\) \{ const more = el\("details", "bk-more"\);[\s\S]*?mountSend\(more, quoteId, cur, url\); \}\s*else mountSend\(box, quoteId, cur, url\);/);
  assert.match(BSC, /\.bk-ask\{/); assert.match(BSC, /\.bk-acts\{position:sticky/);
});

t('flow: ONE "Share with client" dialog holds the booklet card and the approval link', () => {
  const m = FLOW.slice(FLOW.indexOf('<div id="shareModal"'), FLOW.indexOf('<div class="mbar" id="mPriceBar"'));
  // r22: the dialog keeps its head; the share controls (#shareBody) live in step 9 on the page and move in while it is open
  for (const id of ['csTitle', 'csClose', 'csSlot']) assert.match(m, new RegExp('id="' + id + '"'), id);
  const pg = FLOW.slice(FLOW.indexOf('<section class="card" id="sec-approve">'), FLOW.indexOf('<section class="card" id="sec-pay">'));
  for (const id of ['shareBody', 'csAsk', 'csAskRow', 'csApprove', 'sendApproval', 'apprLinks', 'sec-share', 'csBkFold', 'csDoneNote'])
    assert.match(pg, new RegExp('id="' + id + '"'), id);
  assert.match(pg, /<section class="card" id="sec-share" data-share-checklist hidden>/);
  assert.match(pg, /<div class="sc-body"><\/div>/);
  assert.equal((FLOW.match(/id="sendApproval"/g) || []).length, 1);
  assert.equal((FLOW.match(/id="apprLinks"/g) || []).length, 1);
  assert.match(FLOW, /<button type="button" class="btn primary s-0466783" id="shareClient"/);
  assert.match(FLOW, /\$\("#shareClient"\)\.addEventListener\("click",openShare\);/);
});
t('flow: once approved / paid the dialog is "Share booklet" with no approval step', () => {
  assert.match(FLOW, /sb\.hidden = paidCount>0 \|\| ap==="approved" \|\| ap==="paid"; try\{ syncShare\(paidCount>0\); \}catch\(_\)\{\}/);
  const fn = FLOW.slice(FLOW.indexOf('function approvedOnText(){'), FLOW.indexOf('let shareFrom=null;'));
  const S = new Function('$', 'document', 'state', `let sharePaid=false, PAID_SUM=state.paid, ev=state.ev;
    function clientApproved(){ const ap=(ev&&(ev.approvalStatus||ev.approval_status))||""; return sharePaid || PAID_SUM>0 || ap==="approved" || ap==="paid"; }
    ${fn} return syncShare;`);
  const mk = () => { const n = {}; return new Proxy(n, { get: (o, k) => (k in o ? o[k] : (o[k] = { hidden: false, textContent: '', checked: true, dataset: {}, open: true })) }); };
  const run = (ev, paid) => { const nodes = mk(); const sync = S((sel) => nodes[sel], { querySelectorAll: () => [] }, { ev, paid }); sync(); return nodes; };
  let n = run({ approvalStatus: 'sent' }, 0);
  assert.equal(n['#csTitle'].textContent, 'Share with client'); assert.equal(n['#csApprove'].hidden, false); assert.equal(n['#csAskRow'].hidden, false);
  assert.equal(n['#shareClient'].textContent, 'Share with client →');
  n = run({ approvalStatus: 'approved' }, 0);
  // r22: the approval step stays, saying "Approved ✓ (on <date>)" - "Send for approval" itself is hidden by paintApprBtn
  assert.equal(n['#csTitle'].textContent, 'Share booklet'); assert.equal(n['#csApprove'].hidden, false); assert.equal(n['#csAskRow'].hidden, true);
  assert.equal(n['#csApproved'].hidden, false); assert.match(n['#csApproved'].textContent, /^Approved ✓/); assert.equal(n['#apTitle'].textContent, 'Share booklet');
  assert.equal(n['#csDoneNote'].hidden, false); assert.equal(n['#shareClient'].textContent, 'Share booklet →');
  n = run({ approvalStatus: 'none' }, 500);
  assert.equal(n['#csApproved'].hidden, false, 'an advance in = booked: the approval step says Approved'); assert.equal(n['#csApprState'].hidden, true);
});
t('flow: the approval link code and gates are the same as before', () => {
  assert.match(FLOW, /HelmEmailSend\.mount\(\$\("#apprLinks"\), \{ quoteId:id, kind:"approval"/);
  assert.match(FLOW, /const r=await BPStore\.approval\.generateToken\(id\);/);
  assert.match(FLOW, /if\(!canEdit\) \["#q_save","#sendApproval"\]\.forEach/);
  assert.match(FLOW, /if\(!canEdit\)\{ const b=\$\("#shareClient"\); if\(b\)\{ b\.disabled=true;/);
});
t('flow-polish.css: sticky summary rail order, progress bar, neat masked money', () => {
  assert.match(FP, /#app \.rail > #priceCard\{order:1\}/); assert.match(FP, /#app \.rail > \.apprcard\{order:2\}/);
  assert.match(FP, /html\.hb-priv-on #priceRows \.prow\[data-money\]:not\(\.total\)\{display:none\}/);
  assert.match(FLOW, /if\(f\) f\.style\.width=Math\.round\(n\/STEPS\.length\*100\)\+"%";/);
});
t('client page, booklet, portal: tidier layout without changing data', () => {
  assert.match(CL, /html\.hb-priv-on #app \.totals dd\{min-width:6ch/);
  assert.match(BV2, /#payTable,#receiptTable\{display:block;max-width:100%;overflow-x:auto/);
  assert.ok(PORTAL.indexOf('id="docsCard"') < PORTAL.indexOf('id="proposalCard"'), 'the booklet + documents come right after the event');
  assert.match(PORTAL, /id="docsCard" hidden/);
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('✗ ' + name); throw e; } }
console.log('r21-event-ui: ' + n + ' tests passed');
