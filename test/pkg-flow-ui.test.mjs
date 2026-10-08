// Client package flow (0069) — UI only; BPStore.pkgflow is STUBBED (the backend lives on feat/pkg-flow).
//  * booklet-pkg.js: phase / timeline / guest limits / estimate / safe URLs, and a full
//    choose → OTP → success run against a tiny fake DOM with a stubbed pkgflow
//  * pkg-review.js: row view, accept/decline validation, self-approval message kept verbatim,
//    settings normalisation, and accept → approve link with a stubbed review()
//  * pages: CSP-clean markup (no inline script/style/style=), booklet has no app links,
//    store-api AREAS + bell labels + deep links for the pkg_* notifications
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
const J = (x) => JSON.parse(JSON.stringify(x));
const tick = async (k = 8) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };

/* ---- a deliberately tiny DOM: enough for createElement / textContent / querySelector / click ---- */
class Node_ {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this._text = ''; this.hidden = false;
    this.listeners = {}; this.dataset = {}; this.value = ''; this.disabled = false; this.checked = false; this.style = { setProperty() {} };
    const self = this; this.classList = { add(c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); s.add(c); self.className = [...s].join(' '); },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); }, contains(c) { return self.className.split(/\s+/).includes(c); } };
    this.className = ''; }
  get firstChild() { return this.children[0] || null; }
  get isConnected() { let p = this; while (p.parentNode) p = p.parentNode; return p === doc.documentElement; }
  get offsetParent() { return this.hidden ? null : {}; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k === 'id' ? (this.id || null) : (k in this.attrs ? this.attrs[k] : null); }
  hasAttribute(k) { return k in this.attrs; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); }
  dispatch(ev, e = {}) { (this.listeners[ev] || []).forEach((f) => f(Object.assign({ target: this, preventDefault() {} }, e))); }
  click() { if (!this.disabled) this.dispatch('click'); }
  focus() { doc.activeElement = this; }
  select() {}
  all() { const out = []; const walk = (x) => x.children.forEach((c) => { out.push(c); walk(c); }); walk(this); return out; }
  matches(sel) {
    return sel.split(',').map((s) => s.trim()).some((one) => {
      const parts = one.split(/\s+/); const last = parts.pop();
      if (!simple(this, last)) return false;
      let p = this.parentNode;
      for (let i = parts.length - 1; i >= 0; i--) { while (p && !simple(p, parts[i])) p = p.parentNode; if (!p) return false; p = p.parentNode; }
      return true;
    });
  }
  querySelectorAll(sel) { return this.all().filter((x) => x.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function simple(x, s) {
  const m = /^([a-z]*)(#[\w-]+)?((?:\.[\w-]+)*)(\[([\w-]+)\])?$/i.exec(s); if (!m) return false;
  if (m[1] && x.tagName !== m[1].toUpperCase()) return false;
  if (m[2] && x.id !== m[2].slice(1)) return false;
  if (m[3]) for (const c of m[3].split('.').filter(Boolean)) if (!x.className.split(/\s+/).includes(c)) return false;
  if (m[5] && !(m[5] in x.attrs)) return false;
  return true;
}
const doc = { documentElement: new Node_('html'), activeElement: null, readyState: 'complete', listeners: {},
  createElement: (t) => new Node_(t), createTextNode: (s) => { const x = new Node_('#text'); x._text = String(s); return x; },
  getElementById: (id) => doc.documentElement.querySelector('#' + id),
  querySelector: (s) => doc.documentElement.querySelector(s), querySelectorAll: (s) => doc.documentElement.querySelectorAll(s),
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
  removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); } };
doc.body = doc.documentElement.appendChild(new Node_('body'));
const mk = (tag, id, parent) => { const x = new Node_(tag); if (id) x.setAttribute('id', id); (parent || doc.body).appendChild(x); return x; };

/* ================= booklet-pkg.js ================= */
const sec = mk('section', 'packages'); sec.hidden = true;
mk('h2', 'h_packages', sec); mk('p', 'pkLede', sec); mk('div', 'pkLive', sec); mk('div', 'pkCards', sec);
const modal = mk('div', 'pkModal'); modal.hidden = true; mk('h2', 'pkModalTitle', modal); mk('div', 'pkModalBody', modal);

const calls = [];
let server = null;
const PKG = [{ id: 'p-gold', name: 'Gold', description: 'Full service', per_person: 1200, currency: 'INR', min_guests: 50, max_guests: 300, items: [{ name: 'Welcome drink' }, 'Live counter'] },
  { id: 'p-silver', name: 'Silver', per_person: 800, currency: 'INR', min_guests: 20, max_guests: 200, items: [] }];
const base = () => ({ packages: PKG, current_selection: null, quote_ready: null, locked: false, require_otp: true, totals: { total: 0, paid: 0, balance: 0, currency: 'INR' } });
const pkgflow = {
  packages: async (tok) => { calls.push(['packages', tok]); return server; },
  otpRequest: async (tok) => { calls.push(['otpRequest', tok]); return { sent: true, channel: 'whatsapp' }; },
  choose: async (tok, pkg, guests, note, otp) => { calls.push(['choose', tok, pkg, guests, note, otp]);
    server = Object.assign(base(), { current_selection: { status: 'pending', package_id: pkg, guests, decline_reason: null, updated_at: '2026-10-08' } }); return { ok: true, status: 'pending' }; },
};
const ctx = { console, URLSearchParams, Intl, setTimeout, document: doc, BPStore: { pkgflow } };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(read('public/booklet-pkg.js'), ctx);
const B = ctx.HelmBookletPkg;

await t('phase: choose / pending / accepted / ready / paid / locked / declined', () => {
  const sel = (status, extra) => Object.assign(base(), { current_selection: { status, package_id: 'p-gold', guests: 80 } }, extra || {});
  assert.equal(B.phase(null), 'off');
  assert.equal(B.phase(base()), 'choose');
  assert.equal(B.phase(sel('pending')), 'pending');
  assert.equal(B.phase(sel('accepted')), 'accepted');
  assert.equal(B.phase(sel('accepted', { quote_ready: { approve_url: 'https://helm.events/a/x' } })), 'ready');
  assert.equal(B.phase(sel('accepted', { quote_ready: { approve_url: 'javascript:alert(1)' } })), 'accepted');
  assert.equal(B.phase(sel('accepted', { totals: { total: 96000, paid: 20000, balance: 76000 } })), 'paid');
  assert.equal(B.phase(Object.assign(base(), { locked: true })), 'locked');
  assert.equal(B.phase(sel('pending', { locked: true })), 'pending', 'a pending choice still shows its status when locked');
  assert.equal(B.phase(sel('declined')), 'declined');
  assert.equal(B.phase(sel('superseded')), 'choose');
  assert.equal(B.canChoose(sel('declined')), true);
  assert.equal(B.canChoose(Object.assign(base(), { locked: true })), false);
});
await t('timeline: done / current / todo per phase', () => {
  const s = (st, x) => J(B.timeline(Object.assign(base(), { current_selection: { status: st, package_id: 'p-gold' } }, x || {}))).map((v) => v.state);
  assert.deepEqual(s('pending'), ['done', 'current', 'todo', 'todo']);
  assert.deepEqual(s('accepted'), ['done', 'done', 'current', 'todo']);
  assert.deepEqual(s('accepted', { quote_ready: { approve_url: 'https://x.test/a' } }), ['done', 'done', 'done', 'current']);
  assert.deepEqual(s('accepted', { totals: { paid: 5 } }), ['done', 'done', 'done', 'done']);
});
await t('guest limits clamp to min/max; estimate = per_person × guests', () => {
  assert.equal(B.clampGuests(10, PKG[0]), 50);
  assert.equal(B.clampGuests(999, PKG[0]), 300);
  assert.equal(B.clampGuests('abc', PKG[0]), 50);
  assert.equal(B.estimate(PKG[0], 100), 120000);
  assert.equal(B.estimate({ per_person: null }, 10), null);
  assert.deepEqual(J(B.limits({})), { min: 1, max: 5000 });
});
await t('safeUrl: https or same-site path only', () => {
  assert.equal(B.safeUrl('https://helm.events/approve?t=1'), 'https://helm.events/approve?t=1');
  assert.equal(B.safeUrl('/approve?t=1'), '/approve?t=1');
  for (const bad of ['//evil.test/x', 'javascript:alert(1)', 'http://x.test', 'https://x.test/a b', 'https://x.test/"onload=1', null]) assert.equal(B.safeUrl(bad), null, String(bad));
});
await t('money follows the quote locale + currency', () => {
  B.setFormat('en-US', 'USD'); assert.match(B.money(1500), /^\$1,500$/);
  B.setFormat('bogus-locale-@@', 'usd'); assert.match(B.money(1500), /\$1,500/, 'invalid values are ignored');
  B.setFormat('en-IN', 'INR'); assert.match(B.money(120000), /1,20,000/);
});
await t('flow: choose → WhatsApp code → choice sent → "under review" status', async () => {
  server = base();
  await B.mount('tok-1', { quote: { currency: 'INR', locale: 'en-IN' } });
  assert.equal(sec.hidden, false);
  const cards = doc.querySelectorAll('.pk-card');
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /Gold/); assert.match(cards[0].textContent, /Welcome drink/); assert.match(cards[0].textContent, /50–300 guests/);
  // stepper: + raises guests, estimate updates
  const plus = cards[0].querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'More guests');
  plus.click();
  assert.equal(cards[0].querySelector('input').value, '51');
  assert.match(cards[0].querySelector('.pk-est').textContent, /61,200/);
  const go = cards[0].querySelectorAll('button').find((b) => b.textContent === 'Choose this package');
  go.click();
  assert.equal(modal.hidden, false, 'confirm modal opens');
  assert.match(modal.textContent, /Gold/); assert.match(modal.textContent, /51/); assert.match(modal.textContent, /61,200/);
  assert.equal(doc.activeElement && doc.activeElement.id, 'pkConfirm', 'focus moves into the dialog');
  doc.getElementById('pkNote').value = 'Veg only please';
  doc.getElementById('pkConfirm').click(); await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'otpRequest'), [['otpRequest', 'tok-1']]);
  assert.match(modal.textContent, /code to you on WhatsApp/);
  doc.getElementById('pkOtp').value = '12';
  doc.getElementById('pkConfirm').click(); await tick();
  assert.match(modal.textContent, /6-digit code/);
  assert.equal(calls.filter((c) => c[0] === 'choose').length, 0, 'no submit with a short code');
  doc.getElementById('pkOtp').value = '123456';
  doc.getElementById('pkConfirm').click(); await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'choose'), ['choose', 'tok-1', 'p-gold', 51, 'Veg only please', '123456']);
  assert.match(modal.textContent, /now with the studio/);
  assert.match(doc.getElementById('pkLive').textContent, /your choice is with the studio/);
  assert.match(doc.getElementById('pkLive').textContent, /Under review/);
  assert.equal(doc.getElementById('pkCards').hidden, true, 'cards hidden while a choice is pending');
  // Escape closes and returns focus
  doc.listeners.keydown.slice().forEach((f) => f({ key: 'Escape', preventDefault() {} }));
  assert.equal(modal.hidden, true);
});
await t('declined: reason shown + "Choose again" brings the cards back; locked hides them', async () => {
  B.render(Object.assign(base(), { require_otp: false, current_selection: { status: 'declined', package_id: 'p-silver', guests: 30, decline_reason: 'Date clashes with <b>another</b> booking' } }));
  const live = doc.getElementById('pkLive');
  assert.match(live.textContent, /Date clashes with <b>another<\/b> booking/, 'reason as plain text');
  assert.equal(doc.getElementById('pkCards').hidden, true);
  doc.getElementById('pkAgain').click();
  assert.equal(doc.getElementById('pkCards').hidden, false);
  B._state.choosing = false;
  B.render(Object.assign(base(), { locked: true }));
  assert.match(live.textContent, /closed/);
  assert.equal(doc.getElementById('pkCards').hidden, true);
});
await t('ready → "Review & pay" link; paid with balance → "Pay the balance"', () => {
  B.render(Object.assign(base(), { current_selection: { status: 'accepted', package_id: 'p-gold', guests: 80 }, quote_ready: { approve_url: 'https://helm.events/s/approve?t=abc' },
    totals: { total: 96000, paid: 0, balance: 96000, currency: 'INR' } }));
  const a = doc.getElementById('pkLive').querySelector('a');
  assert.equal(a.textContent, 'Review & pay'); assert.equal(a.getAttribute('href'), 'https://helm.events/s/approve?t=abc');
  B.render(Object.assign(base(), { current_selection: { status: 'accepted', package_id: 'p-gold', guests: 80 }, quote_ready: { approve_url: 'https://helm.events/s/approve?t=abc' },
    totals: { total: 96000, paid: 30000, balance: 66000, currency: 'INR' } }));
  assert.equal(doc.getElementById('pkLive').querySelector('a').textContent, 'Pay the balance');
  assert.match(doc.getElementById('pkLive').textContent, /66,000/);
});
await t('booklet without 0069 (packages → null) keeps the section hidden', async () => {
  sec.hidden = true; server = null; await B.mount('tok-2', {});
  assert.equal(sec.hidden, true);
});

/* ================= pkg-review.js ================= */
const c2 = { console, URLSearchParams, Intl, document: undefined }; c2.window = c2; c2.globalThis = c2;
vm.createContext(c2); vm.runInContext(read('public/pkg-review.js'), c2);
const R = c2.HelmPkgReview;
await t('reviewArgs: decline needs a reason; override must be positive', () => {
  assert.match(R.reviewArgs('decline', '', '  ').error, /reason/);
  assert.deepEqual(J(R.reviewArgs('decline', '', 'Venue full')), { action: 'decline', price: null, reason: 'Venue full' });
  assert.deepEqual(J(R.reviewArgs('accept', '', '')), { action: 'accept', price: null, reason: null });
  assert.deepEqual(J(R.reviewArgs('accept', '1,250', '')), { action: 'accept', price: 1250, reason: null });
  assert.match(R.reviewArgs('accept', '-5', '').error, /positive/);
  assert.match(R.reviewArgs('accept', 'abc', '').error, /positive/);
  assert.match(R.reviewArgs('delete', '', '').error, /Unknown/);
});
await t('errText keeps the server self-approval message verbatim', () => {
  assert.equal(R.errText(new Error('You cannot approve a selection you created yourself.')), 'You cannot approve a selection you created yourself.');
  assert.equal(R.errText(new Error('self-approval blocked: ask another reviewer')), 'self-approval blocked: ask another reviewer');
});
await t('rowView + settingsView normalise server rows', () => {
  const v = R.rowView({ id: 's1', package_name: 'Gold', guests: 80, status: 'weird', created_at: '2026-10-01T10:00:00Z', draft_totals: { total: 96000, currency: 'INR' } });
  assert.equal(v.status, 'pending'); assert.equal(v.statusLabel, 'Awaiting review'); assert.equal(v.total, 96000);
  assert.deepEqual(J(R.settingsView({})), { pkg_require_otp: false, pkg_client_channel: 'whatsapp', overpay_mode: 'credit', pkg_lock_days: 3 });
  assert.deepEqual(J(R.settingsView({ pkg_require_otp: 1, pkg_client_channel: 'both', overpay_mode: 'manual_refund', pkg_lock_days: 500 })),
    { pkg_require_otp: true, pkg_client_channel: 'both', overpay_mode: 'manual_refund', pkg_lock_days: 90 });
  assert.equal(R.settingsView({ pkg_client_channel: 'sms' }).pkg_client_channel, 'whatsapp');
  assert.equal(R.safeUrl('https://helm.events/a?t=1'), 'https://helm.events/a?t=1');
  assert.equal(R.safeUrl('javascript:1'), null);
});
await t('panel: editor accepts → approve link + copy; viewer sees no buttons; self-approval error shown', async () => {
  const run = async (canEdit, reviewImpl) => {
    const d = { documentElement: new Node_('html'), activeElement: null, readyState: 'complete', listeners: {},
      createElement: (tg) => new Node_(tg), createTextNode: (s) => { const x = new Node_('#text'); x._text = String(s); return x; } };
    d.body = d.documentElement.appendChild(new Node_('body'));
    d.querySelectorAll = (s) => d.documentElement.querySelectorAll(s); d.querySelector = (s) => d.documentElement.querySelector(s);
    const panel = new Node_('section'); panel.setAttribute('data-pkg-review', ''); panel.setAttribute('data-quote', '0b8c2f1e-1111-4222-8333-944445555666'); panel.hidden = true; d.body.appendChild(panel);
    const log = []; let rows = [{ id: 'sel-1', package_name: 'Gold', guests: 80, status: 'pending', created_at: '2026-10-01T10:00:00Z', note: 'Veg please' }];
    const st = { init: async () => {}, mode: () => 'supabase',
      auth: { canView: async (a) => { log.push(['view', a]); return true; }, canEditArea: async (a) => { log.push(['edit', a]); return canEdit; } },
      pkgflow: { list: async (q) => { log.push(['list', q]); return rows; },
        review: async (...a) => { log.push(['review', ...a]); const r = await reviewImpl(...a); rows = [Object.assign({}, rows[0], { status: 'accepted' })]; return r; } } };
    const cx = { console, URLSearchParams, Intl, document: d, BPStore: st, location: { search: '' }, navigator: { clipboard: { writeText: async (s) => log.push(['copy', s]) } } };
    cx.window = cx; cx.globalThis = cx; vm.createContext(cx); vm.runInContext(read('public/pkg-review.js'), cx);
    await tick();
    return { panel, log, d };
  };
  const ed = await run(true, async () => ({ ok: true, version_id: 'v2', approve_url: 'https://helm.events/s/approve?t=new' }));
  assert.equal(ed.panel.hidden, false);
  assert.ok(ed.log.some((x) => x[0] === 'edit' && x[1] === 'pkg_review'));
  assert.match(ed.panel.textContent, /Gold/); assert.match(ed.panel.textContent, /Client note: Veg please/);
  const decBtn = ed.panel.querySelectorAll('button').find((b) => b.textContent === 'Decline');
  decBtn.click(); await tick();
  assert.match(ed.panel.textContent, /reason/, 'decline without a reason is blocked client-side');
  assert.ok(!ed.log.some((x) => x[0] === 'review'));
  ed.panel.querySelector('input').value = '1100';
  ed.panel.querySelectorAll('button').find((b) => b.textContent === 'Accept').click(); await tick();
  assert.deepEqual(ed.log.find((x) => x[0] === 'review'), ['review', 'sel-1', 'accept', 1100, null]);
  const url = ed.panel.querySelector('.pkr-url');
  assert.equal(url.value, 'https://helm.events/s/approve?t=new');
  ed.panel.querySelectorAll('button').find((b) => b.textContent === 'Copy link').click(); await tick();
  assert.ok(ed.log.some((x) => x[0] === 'copy' && x[1] === 'https://helm.events/s/approve?t=new'));

  const vw = await run(false, async () => ({}));
  assert.equal(vw.panel.hidden, false);
  assert.equal(vw.panel.querySelectorAll('button').length, 0, 'view-only: no Accept / Decline');
  assert.match(vw.panel.textContent, /view only/);

  const self = await run(true, async () => { throw new Error('You cannot approve a package choice you requested yourself.'); });
  self.panel.querySelectorAll('button').find((b) => b.textContent === 'Accept').click(); await tick();
  assert.match(self.panel.querySelector('.pkr-err').textContent, /cannot approve a package choice you requested yourself/);
});

/* ================= pages / wiring ================= */
await t('pages: CSP-clean markup, panels + settings card + scripts wired', () => {
  for (const f of ['public/booklet.html']) {
    const h = read(f);
    assert.doesNotMatch(h, /<script(?![^>]*\ssrc=)[^>]*>/i, f); assert.doesNotMatch(h, /<style/i, f);
  }
  for (const f of ['public/booklet.html', 'public/event.html', 'public/client.html', 'public/control.html']) {
    const h = read(f); const added = h.match(/<(section|div)[^>]*(data-pkg-review|data-pkg-settings|id="packages"|id="pkModal")[^>]*>/g) || [];
    added.forEach((tag) => assert.doesNotMatch(tag, /\sstyle=|\son[a-z]+=/i, f));
  }
  assert.match(read('public/booklet.html'), /booklet-pkg\.js\?v=1/); assert.match(read('public/booklet.html'), /booklet-pkg\.css\?v=1/);
  assert.match(read('public/booklet.html'), /id="pkModal" role="dialog" aria-modal="true"/);
  assert.match(read('public/booklet.html'), /id="pkLive" role="status" aria-live="polite"/);
  assert.match(read('public/event.html'), /id="pkg-selections" class="card" data-pkg-review data-quote-from-url/);
  assert.match(read('public/client.html'), /id="pkg-selections" class="card" data-pkg-review data-wait-quote/);
  assert.match(read('public/control.html'), /id="pkgFlowCard" data-pkg-settings hidden/);
  for (const f of ['public/event.html', 'public/client.html', 'public/control.html']) assert.match(read(f), /pkg-review\.js\?v=2/, f);
  for (const f of ['public/booklet-pkg.js', 'public/pkg-review.js', 'public/booklet.js'])
    assert.doesNotMatch(read(f), /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, f);
  assert.match(read('public/booklet-pkg.css'), /@media print\{[^}]*\.pk-ctl/);
});
await t('booklet stays a private document: no links into the app, noindex', () => {
  const h = read('public/booklet.html');
  assert.match(h, /noindex/); assert.match(h, /bp-theme-toggle" content="off"/);
  const hrefs = [...h.replace(/<base href="\/">/, "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(#|https:\/\/fonts\.|https:\/\/[a-z0-9]+\.supabase\.co$|\/booklet[\w-]*\.css|\/vendor\/)/.test(u));
  assert.deepEqual(hrefs, [], 'only in-page anchors / assets');
  assert.doesNotMatch(h, /<nav[^>]*aria-label="Main"|dashboard\.html|studio-search|profile/i);
});
await t('store-api: role-matrix areas, bell labels, deep links for pkg_* (pkgflow namespace untouched)', () => {
  const s = read('public/store-api.js');
  assert.match(s, /key: "pkg_review",\s+label: "Package selections \(review\)"/);
  assert.match(s, /key: "pkg_payments", label: "Package payment alerts"/);
  for (const k of ['pkg_selected', 'pkg_accepted', 'pkg_declined', 'pkg_payment']) assert.match(s, new RegExp(k + ': \\['), k);
  const c = { console, URLSearchParams }; c.window = c; c.globalThis = c;
  const m = /function notifLink\(n\) \{[\s\S]*?\n  \}\n/.exec(s); assert.ok(m);
  vm.createContext(c); vm.runInContext(m[0] + 'globalThis.notifLink = notifLink;', c);
  const q = '0b8c2f1e-1111-4222-8333-944445555666';
  assert.equal(c.notifLink({ kind: 'pkg_selected', quote_id: q }), 'event.html?id=' + q + '#pkg-selections');
  assert.equal(c.notifLink({ kind: 'pkg_payment', quote_id: q }), 'settlement.html?quote=' + q + '#payments');
  const d = /function deeplinkTarget\(search, hash\) \{[\s\S]*?\n  \}\n/.exec(s);
  vm.runInContext(d[0] + 'globalThis.dt = deeplinkTarget;', c);
  assert.equal(c.dt('?id=' + q, '#pkg-selections'), '#pkg-selections');
});

await t('final contract: mode selected/hidden, choose error hints, review outcomes, relative approve URL', () => {
  assert.equal(B.phase(Object.assign(base(), { mode: 'selected', locked: true })), 'off');
  assert.equal(B.phase(Object.assign(base(), { mode: 'hidden' })), 'off');
  const E = (hint, msg, code) => Object.assign(new Error(msg || 'x'), { hint, code });
  assert.match(B.errText(E('locked', 'package selection is closed for this event (too_close)')), /too close/);
  assert.match(B.errText(E('otp_required')), /enter the code/);
  assert.match(B.errText({ status: 'otp_invalid' }), /didn't match/);
  assert.match(B.errText(E('rate_limited')), /wait/);
  assert.match(B.errText(E(null, 'Read-only', '25006')), /paused/);
  assert.match(R.reviewOutcome({ ok: true, status: 'pending', needs_checker: true }, 'accept').msg, /second approver/);
  const o = R.reviewOutcome({ ok: true, status: 'accepted', approve_url: '/approve?token=abc', reapproval_required: true, credit: { mode: 'credit', amount: 500 } }, 'accept');
  assert.match(o.msg, /approve the new quote again/); assert.match(o.msg, /credit/);
  assert.match(String(o.url), /\/approve\?token=abc$/);
  assert.equal(R.safeUrl('/approve?token=a', 'https://www.helm.events'), 'https://www.helm.events/approve?token=a');
  assert.equal(R.safeUrl('//evil.test/a', 'https://x'), null);
  assert.match(read('public/pkg-review.js'), /Price per person override/);
  assert.equal(R.rowView({ can_review: false }).canReview, false);
});

/* ================= share checklist (0069 scope addition) ================= */
{
  const c3 = { console, URLSearchParams, Intl, document: undefined, location: { search: '' } }; c3.window = c3; c3.globalThis = c3;
  vm.createContext(c3); vm.runInContext(read('public/share-checklist.js'), c3);
  const S = c3.HelmShareChecklist;
  await t('share checklist: normalize / menu rule / preview / payload / fit', () => {
    assert.deepEqual(J(S.normalize(null)), { studio: true, client: true, venue: true, menu: true, layout2d: true, layout3d: true, quotation: true, payments: true, terms: true });
    assert.equal(S.normalize({ studio: true, menu: 'yes' }).menu, false, 'only real true counts');
    assert.equal(S.menuRule(true), 'Client will see your selected package');
    assert.equal(S.menuRule(false), "Client will choose from all packages and you'll be notified");
    const pv = J(S.preview({ menu: true, terms: true }, false));
    assert.deepEqual(pv, ['Event title and date', "Menu — Choose from all packages and you'll be notified", 'Terms']);
    assert.ok(J(S.preview({ layout2d: true }, true)).includes('2D floor plan'));
    const pl = J(S.sharePayload({ days: '14', versions: ['v1'], note: 'Hi', terms: '', sections: { menu: true } }));
    assert.equal(pl.days, 14); assert.deepEqual(pl.versions, ['v1']); assert.deepEqual(pl.versionIds, ['v1']); assert.equal(pl.sections.menu, true); assert.equal(pl.sections.terms, false);
    assert.deepEqual(J(S.fitSize(3200, 1600)), { w: 1600, h: 800 }); assert.deepEqual(J(S.fitSize(800, 600)), { w: 800, h: 600 });
  });
  await t('share checklist mount: toggles drive the preview; uploads snapshots via uploadSnapshot', async () => {
    const d = { documentElement: new Node_('html'), readyState: 'complete', createElement: (tg) => new Node_(tg), createTextNode: (x) => { const k = new Node_('#text'); k._text = String(x); return k; } };
    d.body = d.documentElement.appendChild(new Node_('body')); d.getElementById = (id) => d.documentElement.querySelector("#" + id); d.querySelector = (q) => d.documentElement.querySelector(q);
    const ups = [];
    const cx = { console, URLSearchParams, Intl, document: d, location: { search: '' }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      BPStore: { plan: { get: async () => ({ menu_template: 'Gold' }) }, booklet: { uploadSnapshot: async (q, k, b) => { ups.push([q, k, b.size]); } } },
      HelmBooklet: null };
    cx.window = cx; cx.globalThis = cx; vm.createContext(cx); vm.runInContext(read('public/share-checklist.js'), cx);
    const host = d.body.appendChild(new Node_('div'));
    const ck = cx.HelmShareChecklist.mount(host, { quoteId: 'q1', cur: { sections: { studio: true, menu: true, layout2d: false, layout3d: false, terms: true } } });
    await tick();
    assert.match(host.textContent, /Client will see your selected package/);
    const terms = host.querySelectorAll('input').find((i) => i.getAttribute('data-sec') === 'terms');
    terms.checked = false; terms.dispatch('change');
    assert.equal(ck.sections().terms, false);
    assert.doesNotMatch(host.querySelector('.sc-pvl').textContent, /Terms/);
    const two = host.querySelectorAll('input').find((i) => i.getAttribute('data-sec') === 'layout2d');
    two.checked = true; two.dispatch('change'); await tick();
    assert.match(host.textContent, /Screenshot tools aren't loaded|Retake|Capture/);
    ck.snapshots.layout2d = { blob: { size: 4096 }, url: 'blob:x' };
    await ck.uploadSnapshots();
    assert.deepEqual(ups, [['q1', '2d', 4096]]);
  });
  await t('booklet renders only shared sections and hides empty ones', () => {
    const H = (() => { const c = { console, URLSearchParams }; c.window = c; c.globalThis = c; vm.createContext(c); vm.runInContext(read('public/booklet.js'), c); return c.HelmBooklet; })();
    const legacy = J(H.visibleSections({})); assert.ok(Object.values(legacy.show).every(Boolean), 'no sections from server → legacy, all shown');
    const v = J(H.visibleSections({ sections: { menu: true, terms: true, layout2d: true, quotation: false }, menu: { package: 'Gold' }, layout: { items: [] } }));
    assert.equal(v.show.menu, true); assert.equal(v.show.packages, true); assert.equal(v.show.terms, true);
    assert.equal(v.show.layout2d, false, 'ticked but empty → hidden, no placeholder');
    assert.equal(v.show.quote, false); assert.equal(v.show.payments, false); assert.equal(v.studio, false);
    const w = J(H.visibleSections({ sections: { layout2d: true }, snapshots: { layout2d: 'https://x.supabase.co/s/a.png?token=1' } }));
    assert.equal(w.show.layout2d, true);
    assert.equal(H.snapUrl({ snapshots: { layout3d: { url: 'javascript:1' } } }, 'layout3d'), null);
  });
  await t('share checklist wired on flow.html + Share booklet dialog', () => {
    const f = read('public/flow.html');
    assert.ok(f.indexOf('id="sec-share"') > f.indexOf('id="sec-pay"') && f.indexOf('id="sec-share"') < f.indexOf('id="sec-activity"'));
    assert.match(f, /share-checklist\.js\?v=2/); assert.match(f, /share-checklist\.css\?v=1/);
    for (const p of ['public/event.html', 'public/client.html']) assert.match(read(p), /share-checklist\.js\?v=2[\s\S]*booklet-share\.js/, p);
    assert.match(read('public/booklet-share.js'), /HelmShareChecklist\.mount\(form/);
    assert.doesNotMatch(read('public/share-checklist.js'), /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  });
}
console.log(`\npkg-flow-ui: ${n} passed`);
