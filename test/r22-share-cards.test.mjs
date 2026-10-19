// r22 share + cards (owner feedback on r21 event-ui):
//  A) event workspace: the card's action buttons are visible again (Invitation site / Cancel event back in the header
//     card footer; the ••• menu repeats them as shortcuts), tool-card buttons solid again, and a clean grid -
//     3 per row on desktop, 2 on tablet, 1 on phones, the last row of each section widens (no lone card next to a gap).
//  B) quote page: step 9 "Share with client & approval" is back ON THE PAGE, before step 10 "Advance payment" (the
//     client approves first). The rail dialog stays as the quick way and borrows the SAME nodes (one copy of every id).
// No network, no DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const EV = read('public/event.html'), UI = read('public/event-ui.css'), FLOW = read('public/flow.html'), FP = read('public/flow-polish.css');
const FR = read('public/flow-resume.js');
const tests = []; const t = (n, f) => tests.push([n, f]);
const count = (s, re) => (s.match(re) || []).length;

/* ---------------- A) event workspace ---------------- */
t('event: Invitation site + Cancel event are visible buttons in the header card footer (same ids, gates, handlers)', () => {
  const foot = EV.slice(EV.indexOf('<div class="nextbar evfoot">'), EV.indexOf('</div>', EV.indexOf('id="advBtn"')));
  assert.match(foot, /<a class="btn" id="inviteBtn" hidden>✨ Invitation site<\/a>/);
  assert.match(foot, /<button type="button" class="btn" id="cancelEvBtn" hidden>Cancel event<\/button>/);
  assert.match(foot, /id="advBtn"/);
  for (const id of ['inviteBtn', 'cancelEvBtn', 'advBtn', 'evMenu', 'evMenuBtn', 'evMenuPop']) assert.equal(count(EV, new RegExp('id="' + id + '"', 'g')), 1, id);
  assert.match(EV, /\$\("#cancelEvBtn"\)\.hidden=!\(canEdit && \(myRole==="admin"\|\|myRole==="manager"\) && !evLocked\(\)\);/);
  assert.match(EV, /if\(canEdit && cur>=stageIndex\("confirmed"\)\)\{ inv\.hidden=false; inv\.href="invite-studio\.html\?quote="/);
  assert.match(EV, /\$\("#cancelEvBtn"\)\.addEventListener\("click",async\(\)=>\{/);
  // the footer only hides when it holds nothing at all
  assert.match(UI, /#evHead \.evfoot:not\(:has\(#advBtn:not\(\[hidden\]\),#inviteBtn:not\(\[hidden\]\),#cancelEvBtn:not\(\[hidden\]\)\)\):has\(#nextHint\[hidden\]\)\{display:none\}/);
});

t('event: the ••• menu items are shortcuts that follow and click the real footer buttons', () => {
  const fn = EV.slice(EV.indexOf('function syncEvMenu(){'), EV.indexOf('function evMenuOpen(on){'));
  const mk = (tag, attrs = {}) => ({ tagName: tag, hidden: true, dataset: {}, _a: { ...attrs },
    getAttribute(k) { return k in this._a ? this._a[k] : null; }, setAttribute(k, v) { this._a[k] = String(v); }, removeAttribute(k) { delete this._a[k]; } });
  const inv = mk('A'), cancel = mk('BUTTON');
  const pInv = mk('A'); pInv.dataset.proxy = 'inviteBtn'; const pCan = mk('BUTTON'); pCan.dataset.proxy = 'cancelEvBtn';
  const pop = { children: [pInv, pCan], querySelectorAll: () => [pInv, pCan] }, menu = { hidden: true };
  const $ = (s) => (s === '#evMenu' ? menu : s === '#evMenuPop' ? pop : null);
  const doc = { getElementById: (id) => (id === 'inviteBtn' ? inv : id === 'cancelEvBtn' ? cancel : null) };
  const sync = new Function('$', 'document', 'evMenuOpen', fn + ' return syncEvMenu;')($, doc, () => {});
  sync(); assert.equal(menu.hidden, true, 'nothing visible: no menu'); assert.equal(pInv.hidden, true);
  cancel.hidden = false; sync(); assert.equal(menu.hidden, false); assert.equal(pCan.hidden, false); assert.equal(pInv.hidden, true);
  inv.hidden = false; inv.setAttribute('href', 'invite-studio.html?quote=q1'); sync();
  assert.equal(pInv.hidden, false); assert.equal(pInv.getAttribute('href'), 'invite-studio.html?quote=q1');
  assert.match(EV, /if\(p && !\(p\.tagName==="A" && p\.getAttribute\("href"\)\)\)\{ e\.preventDefault\(\); const o=document\.getElementById\(p\.dataset\.proxy\); if\(o&&!o\.hidden\) o\.click\(\); \}/);
});

t('event: rows always fill - the last row of a section widens instead of leaving a lone card', () => {
  const src = EV.slice(EV.indexOf('function fitCls(i,n){'), EV.indexOf('function fitMods(){'));
  const fitCls = new Function(src + ' return fitCls;')();
  const row = (n) => Array.from({ length: n }, (_, i) => fitCls(i, n).join(' '));
  // 3 per row (6 tracks: plain = 2, l3-w = 3, l3-f = 6)
  const span3 = (c) => (/l3-f/.test(c) ? 6 : /l3-w/.test(c) ? 3 : 2);
  for (let n = 1; n <= 13; n++) {
    const spans = row(n).map(span3); let used = 0;
    for (const s of spans) { used += s; if (used > 6) { used = s; } else if (used === 6) used = 0; }
    assert.equal(used, 0, 'desktop: every row full for ' + n + ' cards (' + spans.join(',') + ')');
  }
  // 2 per row (4 tracks: plain / l3-* = 2, l2-f = 4)
  for (let n = 1; n <= 13; n++) {
    const total = row(n).reduce((a, c) => a + (/l2-f/.test(c) ? 4 : 2), 0);
    assert.equal(total % 4, 0, 'tablet: every row full for ' + n + ' cards');
  }
  assert.deepEqual(row(1), ['l3-f l2-f']); assert.deepEqual(row(2), ['l3-w', 'l3-w']);
  assert.deepEqual(row(4), ['l3-w', 'l3-w', 'l3-w', 'l3-w']);
  // applied after every render, per section (cards between two group heads); the card markup itself is unchanged
  assert.equal(count(EV, /\$\("#mods"\)\.innerHTML=[^\n]*\n\s*fitMods\(\);/g), 3);
  assert.match(EV, /\[\.\.\.grid\.children\]\.forEach\(el=>\{ if\(el\.classList\.contains\("mod"\)\) sec\.push\(el\); else flush\(\); \}\); flush\(\);/);
  assert.match(EV, /return `<div class="mod \$\{reco\}">/);
});

t('event-ui.css: 6-track grid (3 / 2 / 1 per row), equal heights, buttons in one row at the card bottom', () => {
  assert.match(UI, /#app #mods\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\);gap:16px;align-items:stretch;grid-auto-flow:row\}/);
  assert.match(UI, /#app #mods > \.mod\{grid-column:span 2;min-width:0\}/);
  assert.match(UI, /#app #mods > \.mod\.l3-w\{grid-column:span 3\}/);
  assert.match(UI, /#app #mods > \.mod\.l3-f\{grid-column:1\/-1;min-height:0\}/);
  assert.match(UI, /@media \(max-width:1199px\)\{\s*#app #mods\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/);
  assert.match(UI, /@media \(max-width:639px\)\{\s*#app #mods\{grid-template-columns:minmax\(0,1fr\);gap:12px\}/);
  assert.match(UI, /#app \.mod \.act\{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:auto;padding-top:4px\}/);
  assert.match(UI, /#app \.morehead\{[^}]*grid-column:1\/-1\}/);
  assert.doesNotMatch(UI, /\.mod:not\(\.reco\) \.act \.btn\.primary\{background:var\(--panel\)/, 'card buttons are solid again');
});

/* ---------------- B) quote page ---------------- */
t('flow: step 9 "Share with client & approval" sits on the page BEFORE step 10 "Advance payment"', () => {
  const iq = FLOW.indexOf('id="sec-quote"'), ia = FLOW.indexOf('<section class="card" id="sec-approve">'), ip = FLOW.indexOf('<section class="card" id="sec-pay">');
  assert.ok(iq > 0 && ia > iq && ip > ia, 'quotation → share & approval → advance');
  assert.match(FLOW, /<h2><span class="step-n">9<\/span> <span id="apTitle">Share with client &amp; approval<\/span><\/h2>/);
  assert.match(FLOW, /<h2><span class="step-n">10<\/span> Advance payment &amp; booking/);
  const sec = FLOW.slice(ia, ip);
  for (const id of ['csHome', 'shareBody', 'csGets', 'csAskRow', 'csAsk', 'csDoneNote', 'csApprove', 'csApprState', 'csApproved', 'sendApproval', 'apprLinks', 'sec-share', 'csBkFold', 'csInc', 'csAway'])
    assert.match(sec, new RegExp('id="' + id + '"'), id);
  assert.match(sec, /<section class="card" id="sec-share" data-share-checklist hidden>/);
  // one copy of every id on the page - the dialog only has a slot
  for (const id of ['shareBody', 'sendApproval', 'apprLinks', 'sec-share', 'csAsk', 'csApprove', 'csSlot', 'apprState'])
    assert.equal(count(FLOW, new RegExp('id="' + id + '"', 'g')), 1, id);
  const modal = FLOW.slice(FLOW.indexOf('<div id="shareModal"'), FLOW.indexOf('<div class="mbar" id="mPriceBar"'));
  assert.match(modal, /<div class="cs-slot" id="csSlot"><\/div>/); assert.doesNotMatch(modal, /id="sendApproval"|id="sec-share"/);
});

t('flow: the rail dialog borrows the same nodes while open and hands them back on close', () => {
  const fn = FLOW.slice(FLOW.indexOf('function placeShare(inDialog){'), FLOW.indexOf('function openShare(){'));
  const node = (id) => ({ id, hidden: true, kids: [], parentNode: null, appendChild(c) { if (c.parentNode) c.parentNode.kids = c.parentNode.kids.filter((k) => k !== c); this.kids.push(c); c.parentNode = this; } });
  const home = node('csHome'), slot = node('csSlot'), body = node('shareBody'), away = node('csAway'); home.appendChild(body);
  const $ = (s) => ({ '#shareBody': body, '#csSlot': slot, '#csHome': home, '#csAway': away }[s]);
  const place = new Function('$', fn + ' return placeShare;')($);
  place(true); assert.equal(body.parentNode, slot); assert.equal(away.hidden, false, 'the page says the controls are in the dialog');
  place(true); assert.equal(slot.kids.length, 1, 'idempotent');
  place(false); assert.equal(body.parentNode, home); assert.equal(away.hidden, true);
  assert.match(FLOW, /function openShare\(\)\{\s*placeShare\(true\); syncShare\(\);/);
  assert.match(FLOW, /function closeShare\(\)\{ \$\("#shareModal"\)\.hidden=true; placeShare\(false\); syncShare\(\);/);
  assert.match(FLOW, /\$\("#shareClient"\)\.addEventListener\("click",openShare\);/);
  // the step-9 status line mirrors the rail card's status (text only, no second copy of the approval logic)
  assert.match(FLOW, /function mirrorApprState\(\)\{ const a=\$\("#apprState"\), b=\$\("#csApprState"\); if\(a&&b&&b\.textContent!==a\.textContent\) b\.textContent=a\.textContent; \}/);
  assert.match(FLOW, /new MutationObserver\(mirrorApprState\)\.observe\(a,\{childList:true,characterData:true,subtree:true\}\)/);
});

t('flow: after approval the section is "Share booklet" and the approval step says "Approved ✓ on <date>"', () => {
  const fn = FLOW.slice(FLOW.indexOf('function approvedOnText(){'), FLOW.indexOf('let shareFrom=null;'));
  const S = new Function('$', 'document', 'state', 'BPStore', `let sharePaid=false, PAID_SUM=state.paid, ev=state.ev;
    function clientApproved(){ const ap=(ev&&(ev.approvalStatus||ev.approval_status))||""; return sharePaid || PAID_SUM>0 || ap==="approved" || ap==="paid"; }
    function updateProgress(){} ${fn} return syncShare;`);
  const run = (ev, paid, inPage = true) => {
    const home = { id: 'home' }, nodes = {};
    const get = (sel) => nodes[sel] || (nodes[sel] = { hidden: false, textContent: '', checked: true, dataset: {}, open: true, parentNode: null });
    get('#shareBody').parentNode = inPage ? home : {}; nodes['#csHome'] = home;
    const sync = S(get, { querySelectorAll: () => [] }, { ev, paid }, { fmtStudioDate: (v) => (String(v).slice(0, 10) === '2026-10-19' ? '19/10/2026' : '') });
    sync(); return nodes;
  };
  let n = run({ approvalStatus: 'sent' }, 0);
  assert.equal(n['#apTitle'].textContent, 'Share with client & approval'); assert.equal(n['#csApproved'].hidden, true);
  assert.equal(n['#csApprState'].hidden, false); assert.equal(n['#csBkFold'].open, true, 'the page shows the full booklet settings');
  n = run({ approvalStatus: 'sent' }, 0, false); assert.equal(n['#csBkFold'].open, false, 'the dialog folds them while asking approval');
  n = run({ approvalStatus: 'approved', confirmedAt: '2026-10-19T09:30:00Z' }, 0);
  assert.equal(n['#apTitle'].textContent, 'Share booklet'); assert.equal(n['#csApprove'].hidden, false);
  assert.equal(n['#csApproved'].textContent, 'Approved ✓ on 19/10/2026'); assert.equal(n['#csAskRow'].hidden, true);
  assert.match(n['#apSub'].textContent, /step 10/);
  n = run({ approvalStatus: 'approved' }, 0); assert.equal(n['#csApproved'].textContent, 'Approved ✓', 'no date known: no date shown');
  n = run({ approvalStatus: 'none' }, 1000); assert.equal(n['#csApproved'].hidden, false, 'an advance in counts as approved');
});

t('flow: rail Steps list + "x of N done" include step 9; next-step texts follow share & approve → record advance', () => {
  assert.match(FLOW, /\["quote","8 · Quotation"\],\["approve","9 · Share & approval"\]\];/);
  assert.match(FLOW, /approve:\(\(\)=>\{ try\{ return clientApproved\(\); \}catch\(_\)\{ return false; \} \}\)\(\) \};/);
  assert.match(FLOW, /t\.textContent=n\+" of "\+STEPS\.length\+" done"/);
  assert.match(FLOW, /check the Quotation \(step 8\), then share it with the client for approval \(step 9\)\./);
  assert.match(FLOW, /share it with the client: “Send for approval →” in step 9 \(or “Share with client” in the right rail\); once they approve, record the advance under step 10\./);
  assert.match(FLOW, /id="pay_next" data-next-step><b>Next step:<\/b> record the advance above once the client has approved \(step 9\)/);
  assert.doesNotMatch(FLOW, /under step 9 to confirm the booking|see step 9\./);
  // the resume card ("you left this quote at step N") uses the page's numbers
  assert.match(FR, /quote: 8, pay: 10 \}/);
});

t('flow-polish.css: the share controls look the same on the page and in the dialog', () => {
  assert.match(FP, /\.share-body > section\{border:1px solid var\(--line\)/);
  assert.match(FP, /\.share-body #apprLinks \.fld input\{height:38px/);
  assert.match(FP, /\.cs-approved\{display:inline-flex/);
  assert.match(FP, /\.cs-approved\[hidden\],\.cs-apst\[hidden\],\.cs-away\[hidden\]\{display:none\}/);
  assert.doesNotMatch(FP, /\.cs-sheet > section/);
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('✗ ' + name); throw e; } }
console.log('r22-share-cards: ' + n + ' tests passed');
