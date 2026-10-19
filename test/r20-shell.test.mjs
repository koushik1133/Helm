#!/usr/bin/env node
// R20 (fix/r20-shell): live-QA fixes on the app shell (free-trial studio, admin).
//  2. Leads: "Free trial: x of 2 leads used" by + New lead, like Staff / Inventory / Vendors / Venues
//  3. Calendar: the Events calendar's "Event type" filter also filters "Upcoming events & commitments"
//  4. Settings > Users & invites: a space before the "you" badge; no saved display name -> the dashboard's name chain
//  5. Dates: the dashboard's next quote-code guess uses the STUDIO's day; Joined / Insights range / sign-in activity
//     use the studio's date formatter (never the browser's "Oct 18, 2026")
//  6. Nurture: the sample "Demo · " prefix never goes into a WhatsApp / preview message
//  7. Trial: a blocked page (audit log ...) tells the dashboard why you landed there (one-shot toast)
//  8. Dashboard: the "Complete your profile" notice sits in the page flow, never over the KPI tiles
// Pure Node, no deps.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const LEADS = read('public/leads.html'), CAL = read('public/calendar.html'), EVC = read('public/events-calendar.js');
const CTL = read('public/control.html'), S = read('public/store-api.js'), RB = read('public/range-bar.js'), AUI = read('public/auth-ui.js');
const NUR = read('public/nurture.html'), TL = read('public/trial-lock.js'), DASH = read('public/shell-b-dash.js');

t('2. leads: capGate on + New lead (and the first-run button) on every load, for creators only', () => {
  assert.match(LEADS, /function gateCap\(\)\{ if\(canCreate&&window\.BPUI&&BPUI\.capGate\) BPUI\.capGate\(\[\$\("#newBtn"\),\$\("#firstRunBtn"\)\],"leads","leads"\)\.catch\(\(\)=>\{\}\); \}/);
  assert.match(fnSrc(LEADS, 'load'), /^function load\(\)\{\n    gateCap\(\);/);
  assert.match(LEADS, /BPUI\.capDialog\(\$\("#lm_save"\),\$\("#lm_err"\),"leads","leads"/, 'the New lead form keeps its cap dialog');
});

t('3. calendar: events-calendar tells the page the type filter; the agenda + lead markers follow it', () => {
  assert.match(EVC, /if \(opts\.onType && st\.type !== notifiedType\) \{ notifiedType = st\.type; try \{ opts\.onType\(st\.type\); \} catch \(e\) \{\} \}/);
  assert.match(CAL, /onType:\(t\)=>\{ agendaType=String\(t\|\|""\); if\(data\) render\(\); \}/);
  assert.match(CAL, /const tf=\(cvNow!=="team"&&evUI\)\?agendaType:"", typeOk=\(t\)=>!tf\|\|String\(t\|\|""\)\.trim\(\)\.toLowerCase\(\)===tf;/);
  assert.match(CAL, /data\.agenda\.filter\(a=>validDate\(a\.event\.eventDate\)&&typeOk\(a\.event\.eventType\)\)/);
  assert.match(CAL, /leadDates\.filter\(l=>typeOk\(l\.event_type\)\)/);
  assert.match(CAL, /No dated events of this type\./);
  // the calendar's own filter value is the lower-cased type, same as typeOk compares
  assert.match(EVC, /String\(it\.type \|\| ""\)\.toLowerCase\(\) === st\.type/);
});

t('4. users & invites: name chain (full name -> my sign-up name -> e-mail name), "you" badge spaced (vm)', () => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ctx = { esc };
  vm.runInNewContext(fnSrc(CTL, 'ucShownName') + '\n' + fnSrc(CTL, 'ucNameHtml') + '\nglobalThis.N=ucShownName; globalThis.H=ucNameHtml;', ctx);
  assert.deepEqual({ ...ctx.N({ full_name: ' Asha Rao ' }, true, 'X') }, { name: 'Asha Rao', set: true });
  assert.deepEqual({ ...ctx.N({ full_name: '', email: 'koushik@x.in' }, true, 'Koushik Goud') }, { name: 'Koushik Goud', set: false });
  assert.deepEqual({ ...ctx.N({ full_name: '', email: 'koushik@x.in' }, false, 'Koushik Goud') }, { name: 'Koushik', set: false }, 'someone else never gets MY name');
  assert.deepEqual({ ...ctx.N({ full_name: '', email_name: 'meera' }, false, '') }, { name: 'Meera', set: false });
  assert.match(ctx.H({ name: '', set: false }), />Not set</);
  assert.match(ctx.H({ name: '<b>', set: false }), /&lt;b&gt;/);
  assert.match(CTL, /\$\{self\?' <span class="me">you<\/span>':""\}/);
  assert.doesNotMatch(CTL, /\$\{self\?'<span class="me">you<\/span>'/, 'no badge glued to the name ("Not setyou")');
  assert.match(CTL, /meName:meMeta\.full_name\|\|meMeta\.name\|\|""/);
  assert.match(fnSrc(CTL, 'ucDate'), /BPStore\.fmtStudioDate\(iso,\{style:"long"\}\)/);
});

t('5. quote-code guess: no date -> the studio day (todayLocal); an explicit date keeps its day (vm)', () => {
  const at = S.indexOf('const quoteCodeStamp = (date) => {'); assert.ok(at > 0);
  const src = S.slice(at, S.indexOf('\n  };', at) + 5);
  const ctx = { BPStore: { todayLocal: () => '2026-10-19' }, Date };
  vm.runInNewContext(src + '\nglobalThis.Q=quoteCodeStamp;', ctx);
  assert.equal(ctx.Q(), '10192026', 'studio day, not the browser day');
  assert.equal(ctx.Q(new Date(2026, 9, 7)), '10072026');
  const ctx2 = { BPStore: {}, Date }; vm.runInNewContext(src + '\nglobalThis.Q=quoteCodeStamp;', ctx2);
  assert.match(ctx2.Q(), /^\d{8}$/, 'falls back to the device day when the studio day is unknown');
  assert.match(S, /async nextCodeFor\(date\) \{\n      const stamp = quoteCodeStamp\(date\);\n      return quotes\.nextCode\(await qt\(\)\.codesFor\(stamp\), date\);/);
  assert.match(S, /nextCode\(list, date\) \{\n      const stamp = quoteCodeStamp\(date\);/);
});

t('5. dates: Insights range + sign-in activity use the studio formatter, browser-default locale gone', () => {
  assert.match(fnSrc(RB, 'fmt'), /S\.fmtStudioDate\(String\(iso\), \{ style: "long" \}\)/);
  assert.doesNotMatch(RB, /toLocaleDateString\(undefined/);
  assert.match(fnSrc(AUI, 'fmt'), /S\.fmtStudioDate\(ts, \{ style: "long", time: true \}\)/);
  assert.doesNotMatch(fnSrc(AUI, 'fmt'), /toLocaleString\(undefined/);
  assert.doesNotMatch(fnSrc(CTL, 'ucDate'), /toLocaleDateString\(\[\]/);
});

t('6. nurture: "Demo · " is stripped from message text only (vm)', () => {
  const ctx = {}; vm.runInNewContext(fnSrc(NUR, 'msgName') + '\nglobalThis.M=msgName;', ctx);
  assert.equal(ctx.M('Demo · Vamshi Krishna'), 'Vamshi Krishna');
  assert.equal(ctx.M('Demolition Co'), 'Demolition Co');
  assert.equal(ctx.M(null), '');
  assert.match(NUR, /encodeURIComponent\("Hi "\+msgName\(d\.name\)\+", warm wishes/);
  assert.match(NUR, /libExtra=\{ client_name:msgName\(u\.name\)/);
  assert.match(NUR, /<b>\$\{esc\(n\.name\)\}<\/b>/, 'the list itself still shows the saved name');
});

t('7. trial: a blocked page leaves a one-shot notice for the dashboard; showFlash reads "i|" as info', () => {
  assert.match(TL, /audit: "The audit log isn't available on the free trial\."/);
  assert.match(TL, /sessionStorage\.setItem\("bp_flash", "i\|" \+ why\)[^\n]*\n[^\n]*\n\s*try \{ location\.replace\(home\(\)\); \}/);
  const re = /^[\w .,'!—-]{1,80}$/;
  for (const m of TL.match(/"[A-Z][^"]*free trial\."/g)) assert.ok(re.test(m.slice(1, -1)), 'passes the flash allowlist: ' + m);
  assert.match(fnSrc(S, 'showFlash'), /if \(f && f\.indexOf\("i\|"\) === 0\) \{ ty = "info"; f = f\.slice\(2\); \}/);
});

t('8. dashboard: "Complete your profile" goes into the page\'s notice slot, other notices still float', () => {
  assert.match(DASH, /noteSlot\.setAttribute\("data-hau-notes-slot", ""\); root\.appendChild\(noteSlot\);/);
  assert.ok(DASH.indexOf('data-hau-notes-slot') > DASH.indexOf('root.appendChild(kpis)'), 'slot sits below the KPI strip');
  assert.match(AUI, /id: "hauProfileNudge", priority: 3, inline: "only",/);   // r22: inline-only (never floats)
  assert.match(AUI, /inline: o\.inline === true/);
  assert.match(fnSrc(AUI, 'layoutNotes'), /if \(n\.inline && slot && inlineHost\) \{ n\.node\.hidden = false; inlineHost\.appendChild\(n\.node\); inl\+\+; return; \}/);
  assert.match(fnSrc(AUI, 'layoutNotes'), /if \(slot\) slot\.hidden = !inl;/);
  assert.match(AUI, /\.hau-notes\.is-inline\{position:static;/);
  assert.match(fnSrc(AUI, 'syncNotesForModal'), /notes\.some\(function \(n\) \{ return n\.inline; \}\)/, 'a slot drawn later still receives the notice');
});

console.log(`\nr20-shell: ${n} passed`);
