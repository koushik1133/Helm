// r22 mobile (live QA at 375 / 390 / 440 + builder): the "Complete your profile" card never floats (inline on the
// dashboard only), the event stage strip centres the current stage between its arrows, 44px header buttons, drawer
// count pills clear of the favourite star, short status pills on the dashboard quotes list, the builder's view dock
// held inside the phone screen + a centred floor, the "seats fitted to your quote" notice, the draft-restore question
// only after loading, header tooltips prefer below / beside, and a studio-format hint under native date boxes.
// Static + small vm checks only. No network, no DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const AUI = read('public/auth-ui.js'), EV = read('public/event.html'), EPOL = read('public/event-polish.css'), EUI = read('public/event-ui.css');
const SBP = read('public/shell-b-pages.css'), DPOL = read('public/dashboard-polish.css'), SB = read('public/shell-b.css');
const DASH = read('public/dashboard.html'), SBD = read('public/shell-b-dash.css');
const BCSS = read('public/builder.css'), BJS = read('public/builder.js'), ST = read('public/studio-templates.js'), TIP = read('public/builder-tooltip.js');
const API = read('public/store-api.js'), FLOW = read('public/flow.html');
const tests = []; const t = (n, f) => tests.push([n, f]);
const fnSrc = (src, name) => { const i = src.indexOf('function ' + name + '('); assert.ok(i >= 0, name); let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } return src.slice(i); };

t('1. "Complete your profile" is inline-only: in the dashboard slot, never floating on chat / builder / flow / quotes', () => {
  assert.match(AUI, /id: "hauProfileNudge", priority: 3, inline: "only",/);
  assert.match(AUI, /inline: o\.inline === true \|\| o\.inline === "only", inlineOnly: o\.inline === "only"/);
  const lay = fnSrc(AUI, 'layoutNotes');
  assert.ok(lay.indexOf('if (n.inline && slot && inlineHost)') < lay.indexOf('if (n.inlineOnly)'), 'the slot wins when the page has one');
  assert.match(lay, /if \(n\.inlineOnly\) \{ n\.node\.hidden = true; if \(n\.node\.parentNode !== parked\(\)\) parked\(\)\.appendChild\(n\.node\); return; \}/);
  assert.ok(lay.indexOf('if (n.inlineOnly)') < lay.indexOf('fl++'), 'never counted / placed as a floating notice');
  assert.match(AUI, /function parked\(\) \{ if \(!parkHost\) parkHost = doc\.createElement\("div"\); return parkHost; \}/, 'parked node is detached (not in the page)');
  assert.match(fnSrc(AUI, 'syncNotesForModal'), /notes\.some\(function \(n\) \{ return n\.inline; \}\)/, 'a dashboard slot drawn later still receives it');
});

t('2. event stage strip: gutters settled before centring, re-centred on width change + web-font load, gutter = arrow width', () => {
  const c = fnSrc(EV, 'centerStrip');
  assert.ok(c.indexOf('w.classList.remove("ov"); w.classList.toggle("ov", st.scrollWidth-st.clientWidth>1);') > 0);
  assert.ok(c.indexOf('classList.toggle("ov"') < c.indexOf('const max=st.scrollWidth-st.clientWidth'), 'gutters first, then the maths');
  assert.match(EV, /new ResizeObserver\(onResize\)\.observe\(w\)/);
  assert.match(EV, /if\(cw!==lastW\)\{ const first=lastW<0; lastW=cw; if\(!first\)\{ requestAnimationFrame\(\(\)=>centerStrip\(st,false\)\); return; \} \}/);
  assert.match(EV, /document\.fonts\.ready\.then\(re\)/);
  assert.match(EV, /else if\(st\.__gliding\) centerStrip\(st, false\); else stripEdges\(st\);/, 'a re-paint mid-glide finishes the centring');
  assert.match(EPOL, /\.stepwrap\.ov\{--stp-w:40px;padding:0 calc\(var\(--stp-w\) \+ 2px\)\}/);
  assert.match(EPOL, /\.stepwrap\.ov \.stp-arr\{width:var\(--stp-w\);height:var\(--stp-w\);min-width:var\(--stp-w\);min-height:var\(--stp-w\)\}/);
});

t('3. phone header: 44px icon buttons, 40px create caret, tighter bar padding instead', () => {
  assert.match(SBP, /header\.hb-header :is\(\.hb-burger, \.hb-tools \.hb-ibtn, \.hb-tools \.hb-bell \.bpb-btn\) \{ width: 44px; min-width: 44px; height: 44px; \}/);
  assert.match(SBP, /header\.hb-header \.hb-split \.hb-chev \{ width: 40px; min-width: 40px;/);
  assert.match(SBP, /header\.hb-header \{ padding: 0 8px !important; gap: 4px; \}/);
  assert.doesNotMatch(SBP, /width: 36px; min-width: 36px/);
  assert.match(DPOL, /\.hb-chev:not\(\.hb-solo\) \{ width: 40px; min-width: 40px;/);
  assert.doesNotMatch(DPOL, /width: 30px; min-width: 30px|width: 34px; min-width: 34px/);
});

t('4. drawer: count pills keep clear of the favourite star on touch screens', () => {
  assert.match(SB, /@media \(hover: none\) \{\n  html\[data-shell="b"\] \.hb-rail \.hb-row \.hb-cnt, [^\n]*\{ margin-right: 46px; visibility: visible; \}/);
});

t('5. dashboard quotes list: short status on narrow cards, name gets its own line', () => {
  assert.match(DASH, /const STAT_SHORT = \{ sent: "Awaiting approval", locked: "Not sent yet", approved: "Client approved", booked: "Advance paid" \};/);
  assert.match(DASH, /const statBadge = \(q\) => \{ const st = BPStore\.quoteStatus\(q\);/, 'still ONE status source');
  assert.match(DASH, /<span class="st-full">\$\{esc\(st\.label\)\}<\/span><span class="st-short" aria-hidden="true">\$\{esc\(sh\)\}<\/span>/);
  assert.match(DASH, /\.stat \.st-short\{display:none\}/);
  assert.match(SBD, /@container hd \(max-width: 479px\) \{\n  html\[data-shell="b"\] \.hd-quotes \.ecard \{ grid-template-columns: auto minmax\(0, 1fr\);/);
  assert.match(SBD, /\.hd-quotes \.ecard \.elink \{ grid-column: 1 \/ -1; margin-right: 30px; \}/);
  assert.match(SBD, /\.hd-quotes \.stat \.st-full \{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset\(50%\);/, 'the full words stay for screen readers');
  // the short form is used only for these keys; a key without one renders the plain label
  const ctx = { BPStore: { quoteStatus: (q) => q }, out: null };
  const code = DASH.slice(DASH.indexOf('const STAT_CLS'), DASH.indexOf('// qts-1018: the card total'));
  vm.runInNewContext('const esc=(s)=>String(s);' + code + ';out=[statBadge({key:"sent",tone:"sent",label:"Sent · awaiting client approval",title:"t"}),statBadge({key:"quote",tone:"draft",label:"Quote",title:""})];', ctx);
  assert.match(ctx.out[0], /st-short" aria-hidden="true">Awaiting approval</);
  assert.equal(ctx.out[1], '<span class="stat q" data-status="quote" title="">Quote</span>');
});

t('6. builder phone dock inside the viewport; floor centred, rulers / zoom / view centre use its offset; re-fit on resize', () => {
  assert.match(BCSS, /@media \(max-width:480px\)\{\n  \.viewport:not\(\.dock-min\) \.fabstack\{left:8px;right:8px;max-width:calc\(100vw - 16px\);justify-content:center;gap:4px\}/);
  assert.match(BCSS, /\.fabstack \.htour-fab\.in-stack::before\{content:"\?"/);
  assert.match(BCSS, /\.scroll\{display:flex\}\n#svg\{margin:auto;flex:none\}/);
  assert.match(BJS, /function svgOff\(\)\{/);
  assert.match(fnSrc(BJS, 'renderRulers'), /const sx=scrollEl\.scrollLeft-off\.x;/);
  assert.match(fnSrc(BJS, 'renderRulers'), /const sy=scrollEl\.scrollTop-off\.y;/);
  assert.match(fnSrc(BJS, 'viewCenterFt'), /scrollEl\.scrollLeft-o\.x\+scrollEl\.clientWidth\/2/);
  assert.match(fnSrc(BJS, 'setZoom'), /const o0=svgOff\(\), fx=\(a\.x-o0\.x\)\/old, fy=\(a\.y-o0\.y\)\/old;/);
  assert.match(fnSrc(BJS, 'setZoom'), /scrollEl\.scrollLeft=fx\*z\+o1\.x-/);
  assert.match(BJS, /if\(box!==fitBox && scrollEl\.clientWidth>0 && scrollEl\.clientHeight>0 && viewAtFit && !is3DActive\(\)\)\{ fitBox=box;/);
  assert.match(fnSrc(BJS, 'fitView'), /scrollEl\.scrollLeft=\(svg\.width\.baseVal\.value-scrollEl\.clientWidth\)\/2;/);
});

t('7. seats fitted to the quote: notice + one-off full seating; template names say they scale', () => {
  const lt = fnSrc(BJS, 'loadTemplate');
  assert.match(lt, /if\(nat>N\) fullItems=JSON\.parse\(JSON\.stringify\(tItems\)\); exactSeats\(tItems, N\);/, 'the copy is taken BEFORE the trim');
  assert.match(lt, /seatsFittedNotice\(N, natSeats, fullItems, tplSeq\);/);
  const sf = fnSrc(BJS, 'seatsFittedNotice');
  assert.match(sf, /if\(!\(N>0\) \|\| !\(nat>N\) \|\| !Array\.isArray\(full\) \|\| !full\.length\) return;/);
  assert.match(sf, /'Seats fitted to your quote\\u2019s '\+n\(N\)\+' guests/);
  assert.match(sf, /label:'Use the template\\u2019s '\+n\(nat\)\+' seats'/);
  assert.match(sf, /if\(RO \|\| \(seq!=null && window\.__helmTplLoad!==seq\)\) return;/, 'read-only / a newer pick: nothing');
  assert.match(sf, /loadItems\(full, null\);/);
  assert.doesNotMatch(sf, /updateMeta|quotes\.|PRICING\.guests\s*=|currentClient\.guests\s*=/, 'the quote is never changed');
  assert.match(ST, /if \(nat > N\) \{ try \{ fullItems = JSON\.parse\(JSON\.stringify\(items\)\); \} catch \(_\) \{ fullItems = null; \} \}[^\n]*\n      ex\(items, N\);/);
  assert.match(ST, /var sfn = B\.fn\("seatsFittedNotice"\); if \(sfn && fullItems\) sfn\(N, natSeats, fullItems, seq\);/);
  assert.match(ST, /seatsFittedNotice: typeof seatsFittedNotice !== "undefined" \? seatsFittedNotice : null/);
  const sn = vm.runInNewContext('(' + fnSrc(ST, 'scaleName') + ')');
  assert.equal(sn('Political rally — 5,000 seats'), 'Political rally (up to 5,000 seats)');
  assert.equal(sn('Corporate — Round tables gala'), 'Corporate — Round tables gala');
  assert.match(ST, /scaleName\(trial \? trialName\(r\.name\) : r\.name\)/);
});

t('8. builder: loading state ends before "Restore unsaved draft?"', () => {
  const i = BJS.indexOf('if(!CAPTURE_HOST && layoutLoading) setLayoutLoading(false);'), j = BJS.indexOf('if(!CAPTURE_HOST){ await offerDraftRestore();');
  assert.ok(i > 0 && j > i && j - i < 120, 'right before the draft question');
});

t('9. header tooltips: below, then beside, above last; the trial strip counts as an obstacle', () => {
  assert.match(TIP, /cands = hdr \? \[below, \{ side: 'right'[^\]]*\}, \{ side: 'left'[^\]]*\}, above\] : \[below, above\];/);
  assert.match(TIP, /var BANNERS = '#helmTrialStrip';/);
  assert.match(fnSrc(TIP, 'obstacles'), /doc\.querySelectorAll\(BANNERS\)/);
  assert.match(TIP, /if \(!pick && hdr\) pick = \{ side: 'below'/, 'crowded toolbar fallback kept');
});

t('10. studio-format date hint under native date boxes (event workspace + flow)', () => {
  assert.match(API, /dateHint: dateHint, dateHintText: dateHintText,/);
  assert.match(EV, /const di=\$\("#evDate"\), ti=\$\("#evTime"\);\n      try\{ if\(window\.BPUI && BPUI\.dateHint\) BPUI\.dateHint\(di\); \}catch\(_\)\{\}/);
  assert.match(FLOW, /BPUI\.dateHint\(document\.getElementById\("c_date"\)\)/);
  assert.match(SBP, /\.bpui-date-hint \{ display: block;/);
  assert.match(EUI, /#evHead \.evd-f \.bpui-date-hint\{/);
  // the formatter: studio order, never the browser's
  const src = fnSrc(API, 'dateHintText');
  const run = (locale) => vm.runInNewContext('(' + src + ')', { global: { BPStore: {
    studioLocale: () => locale,
    fmtStudioDate: (v, o) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
      return d.toLocaleString(locale, Object.assign({}, o.fmt, { timeZone: 'UTC' })); } } } });
  assert.equal(run('en-IN')('2026-10-29'), 'Thu, 29 Oct 2026');
  assert.equal(run('en-US')('2026-10-29'), 'Thu, Oct 29, 2026');
  assert.equal(run('en-IN')(''), '');
  assert.equal(run('en-IN')('2026-1-2'), '');
  const dh = fnSrc(API, 'dateHint');
  assert.match(dh, /if \(!input \|\| input\.__bpuiDateHint \|\| !input\.ownerDocument\) return null;/, 'idempotent');
  assert.match(dh, /set: function \(x\) \{ base\.set\.call\(this, x\); upd\(\); \}/, 'a value set in code updates the hint');
  assert.doesNotMatch(dh, /input\.value\s*=/, 'never writes the date');
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('✗ ' + name); throw e; } }
console.log('r22-mobile: ' + n + ' tests passed');
