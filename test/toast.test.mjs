// On-screen toasts (Oct 2026): BPUI.toast cards + bell → toast pipeline.
// Pins the pure picker (bellToastPick): first load = baseline only, only NEW unread rows pop,
// already-seen keys never re-show, newest 3, type mapping, links built from encoded ids, text
// stays plain. Plus static checks on BPUI.toast (stack, max 3, progress bar + hover pause,
// aria-live, types, dark mode, reduced motion, safe hrefs) and the bell wiring (per-user
// storage with try/catch, no toast while the panel is open, CSP: CSS only via __helmAdoptCss).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = {}; vm.runInNewContext(['notifLink', 'bellTypeOf', 'bellLabel', 'bellToastPick'].map((f) => fnSrc(api, f)).join('\n') + '\nglobalThis.pick=bellToastPick; globalThis.label=bellLabel;', ctx);
const pick = (items, seen) => JSON.parse(JSON.stringify(ctx.pick(items, seen, { label: ctx.label })));

const FEED = [
  { id: 'n1', kind: 'task_assigned', detail: { count: 2, category: 'Decor' }, quote_id: 'q 1', event_code: 'C-101', event_title: 'Sharma wedding', created_at: '2026-10-07T10:00:00Z', unread: true },
  { id: 'n2', kind: 'payment_received', detail: {}, quote_id: 'q2', created_at: '2026-10-07T09:00:00Z', unread: true },
  { id: 'n3', kind: 'otp', detail: {}, created_at: '2026-10-07T08:00:00Z', unread: false },
  { __chat: true, conversation_id: 'g1', kind: 'group', title: 'Crew', who: 'Ravi', preview: 'on my way', created_at: '2026-10-07T10:05:00Z', count: 1 },
];

t('first load: baseline only, nothing pops (no backlog flood)', () => {
  const r = pick(FEED, null);
  assert.equal(r.toasts.length, 0);
  assert.equal(r.seen.t, '2026-10-07T10:05:00Z');
});

t('only new unread rows after the baseline pop; seen ones never re-show', () => {
  const base = { t: '2026-10-07T08:30:00Z', ids: [] };
  const r = pick(FEED, base);
  assert.deepEqual(r.toasts.map((x) => x.key), ['c:g1@2026-10-07T10:05:00Z', 'n:n1@2026-10-07T10:00:00Z', 'n:n2@2026-10-07T09:00:00Z']);
  assert.equal(pick(FEED, r.seen).toasts.length, 0);                 // same feed again → nothing
  // read rows never toast
  assert.equal(pick([FEED[2]], { t: '2026-10-01T00:00:00Z', ids: [] }).toasts.length, 0);
});

t('newest 3 at most', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, kind: 'task_due', detail: {}, created_at: `2026-10-07T1${i}:00:00Z`, unread: true }));
  const r = pick(many, { t: '2026-10-01T00:00:00Z', ids: [] });
  assert.deepEqual(r.toasts.map((x) => x.key.split('@')[0]), ['n:m5', 'n:m4', 'n:m3']);
});

t('content: title, one-line message, type mapping, encoded links', () => {
  const r = pick(FEED.concat([{ id: 's', kind: 'security_alert', detail: { label: 'New sign-in' }, created_at: '2026-10-07T11:00:00Z', unread: true }]), { t: '2026-10-07T08:30:00Z', ids: [] });
  const by = Object.fromEntries(r.toasts.map((x) => [x.key.split('@')[0], x]));
  assert.equal(by['n:s'].type, 'security'); assert.match(by['n:s'].title, /^Security: New sign-in/);
  assert.equal(by['n:n1'].type, 'info'); assert.equal(by['n:n1'].title, '2 task(s) assigned · Decor');
  assert.equal(by['n:n1'].message, 'C-101 · Sharma wedding'); assert.equal(by['n:n1'].href, 'ops.html?quote=q%201');
  assert.equal(by['c:g1'].title, 'Crew · Ravi'); assert.equal(by['c:g1'].message, 'on my way'); assert.equal(by['c:g1'].href, 'chat.html?c=g1');
  const pay = pick([FEED[1]], { t: '2026-10-01T00:00:00Z', ids: [] }).toasts[0];
  assert.equal(pay.type, 'success'); assert.equal(pay.message, 'Open to see details');
});

t('hostile text stays plain strings (rendered via textContent), ids URL-encoded', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const r = pick([{ __chat: true, conversation_id: 'c"><svg>', kind: 'dm', who: evil, preview: evil, created_at: '2026-10-08T00:00:00Z' }], { t: '2026-10-01T00:00:00Z', ids: [] });
  assert.equal(r.toasts[0].title, evil); assert.equal(r.toasts[0].href, 'chat.html?c=c%22%3E%3Csvg%3E');
  const tsrc = fnSrc(api, 'toast');
  assert.doesNotMatch(tsrc, /innerHTML/);
  assert.match(tsrc, /tEl\.textContent = title; body\.textContent = text;/);
});

t('BPUI.toast: top-right stack, bottom on phones, max 3, progress bar + hover pause, types, dark, reduced motion', () => {
  assert.match(api, /\.bpui-toasts\{position:fixed;top:72px;right:16px;/);
  assert.match(api, /@media \(max-width:640px\)\{\.bpui-toasts\{top:auto;[^}]*bottom:max\(16px/);
  assert.match(api, /while \(cards\.length > 3\)/);
  assert.match(api, /bar\.style\.animation = "bpuiBar " \+ timeout \+ "ms linear forwards"/);
  assert.match(api, /\.bpui-toast\.is-paused \.bpui-toast-bar\{animation-play-state:paused!important\}/);
  assert.match(api, /t\.addEventListener\("mouseenter", pause\);/);
  assert.match(api, /var TOAST_TYPES = \{ ok: "ok", success: "ok", err: "err", error: "err", warn: "warn", warning: "warn", security: "sec"/);
  assert.match(api, /html\[data-theme=dark\] \.bpui-toasts\{/);
  assert.match(api, /@media \(prefers-reduced-motion:reduce\)\{\.bpui-toast-bar\{display:none\}\}/);
  assert.match(api, /lanes\.polite = h\("div", \{ class: "bpui-lane", role: "status", "aria-live": "polite" \}\)/);
  assert.match(api, /var timeout = o\.timeout != null \? \+o\.timeout : \(type === "err" \? 8000 : 5000\);/);
});

t('BPUI.toast: hrefs limited to relative / same-origin', () => {
  const c = {}; vm.runInNewContext(fnSrc(api, 'safeHref') + '\nglobalThis.f=safeHref;', Object.assign(c, { global: { location: { href: 'https://helm.test/dashboard.html', origin: 'https://helm.test' } }, URL }));
  assert.equal(c.f('event.html?id=1'), 'event.html?id=1');
  assert.equal(c.f('javascript:alert(1)'), null);
  assert.equal(c.f('JaVaScRiPt:alert(1)'), null);
  assert.equal(c.f('//evil.example/x'), null);
  assert.equal(c.f('https://evil.example/x'), null);
  assert.equal(c.f('https://helm.test/chat.html'), 'https://helm.test/chat.html');
  assert.equal(c.f(''), null);
});

t('bell wiring: per-user seen key with try/catch, no toast while open, prefs-filtered feed, CSS via adopt', () => {
  assert.match(api, /const seenKey = "bpBellToastSeen:" \+ /);
  assert.match(api, /const readSeen = \(\) => \{ try \{ const v = JSON\.parse\(localStorage\.getItem\(seenKey\)/);
  assert.match(api, /const writeSeen = \(v\) => \{ try \{ localStorage\.setItem\(seenKey, JSON\.stringify\(v\)\); \} catch \(e\) \{\} \};/);
  assert.match(api, /if \(isOpen \|\| !window\.BPUI \|\| !window\.BPUI\.toast\) return;/);
  assert.match(api, /const merged = mergedFeed\(f && f\.items\); if \(f\) popToasts\(merged\);/);
  assert.match(api, /doc\.__bpuiStyle = true; __helmAdoptCss\(doc, CSS\);/);
  assert.doesNotMatch(fnSrc(api, 'bellToastPick'), /innerHTML|document\.|localStorage/);
});

console.log(`\ntoast: ${n} passed`);
