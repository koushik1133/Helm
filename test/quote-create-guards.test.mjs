// Live audit Oct 2026 - items 7, 8, 13, 14 (NEW work 6, 11, 12): quote-creation guards.
//  7  "New quote" never creates on one click: HelmNewQuote.ask() (name + type, Cancel / Create)
//     runs BEFORE BPStore.quotes.startBlank on Quotes, the dashboard and the shell fallback.
//  8  /quotes?new=1 only OPENS that dialog, and only with Helm's one-time sessionStorage nonce.
//  13 dashboard "All quotes": a confirmed / approved / closed event's ✕ becomes Archive; a draft's
//     ✕ moves it to Deleted (restorable); a server-refused delete (payments) offers Archive.
//  14 saved-filters.js uses BPUI.prompt / BPUI.confirm, never the browser's prompt() / confirm().
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };
const flush = () => new Promise((r) => setImmediate(r));

/* ---------- tiny DOM ---------- */
class El {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.ls = {}; this._t = ''; this.value = ''; this.hidden = false; this.cls = new Set(); this.dataset = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); if (k === 'value') this.value = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; } hasAttribute(k) { return k in this.attrs; }
  set className(v) { this.cls = new Set(String(v).split(/\s+/).filter(Boolean)); } get className() { return [...this.cls].join(' '); }
  get classList() { const s = this.cls; return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c) }; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  set textContent(v) { this.childNodes = []; this._t = String(v); } get textContent() { return this._t + this.childNodes.map((c) => c.textContent).join(''); }
  addEventListener(ev, fn) { (this.ls[ev] = this.ls[ev] || []).push(fn); }
  fire(type, extra) { const e = Object.assign({ type, target: this, preventDefault() {}, stopPropagation() {} }, extra || {}); (this.ls[type] || []).forEach((f) => f(e)); return e; }
  click() { this.fire('click'); }
  focus() { this.ownerDocument.activeElement = this; }
  all() { return this.childNodes.flatMap((c) => [c, ...c.all()]); }
}
function makeWin(search) {
  const doc = { readyState: "complete", ls: {}, getElementById: () => null, querySelector: () => null, createElement: (tg) => new El(tg, doc), addEventListener(ev, fn) { (doc.ls[ev] = doc.ls[ev] || []).push(fn); }, removeEventListener(ev, fn) { doc.ls[ev] = (doc.ls[ev] || []).filter((f) => f !== fn); } };
  doc.body = new El('body', doc); doc.documentElement = doc.body;
  const store = {};
  const win = { document: doc, URLSearchParams, Uint8Array, Date, Math, JSON, Promise, Object, Array, Number, String,
    location: { search: search || '' },
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    crypto: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } },
    adopted: [] };
  win.__helmAdoptCss = (_d, css) => win.adopted.push(css);
  win.globalThis = win; win.window = win;
  return { win, doc, store };
}
const NQ_SRC = read('public/new-quote-dialog.js');
function loadNQ(env) { vm.runInContext(NQ_SRC, vm.createContext(env.win)); return env.win.HelmNewQuote; }
const overlay = (doc) => doc.body.childNodes.find((n) => n.cls.has('bpui-overlay'));

await t('8: arm() adds a one-time nonce only to quotes?new=1 links; consume() accepts it exactly once', () => {
  const env = makeWin(); const NQ = loadNQ(env);
  assert.equal(NQ.arm('builder.html?new=1'), 'builder.html?new=1', 'other pages untouched');
  assert.equal(NQ.arm('quotes.html'), 'quotes.html');
  const h = NQ.arm('quotes.html?new=1&open=builder');
  const m = /^quotes\.html\?new=1&open=builder&nq=([0-9a-f]{32})$/.exec(h); assert.ok(m, h);
  assert.equal(JSON.parse(env.store[NQ.NONCE_KEY]).n, m[1]);
  assert.equal(NQ.consume('?new=1&nq=' + 'f'.repeat(32)), false, 'wrong nonce');
  assert.equal(env.store[NQ.NONCE_KEY], undefined, 'any attempt burns the stored nonce');
  NQ.arm('quotes.html?new=1');
  const n2 = JSON.parse(env.store[NQ.NONCE_KEY]).n;
  assert.equal(NQ.consume('?new=1&nq=' + n2), true, 'Helm-armed link');
  assert.equal(NQ.consume('?new=1&nq=' + n2), false, 'one use only');
  assert.equal(NQ.consume('?new=1'), false, 'bare ?new=1 (a link from anywhere) never opens');
  NQ.arm('/abcd/quotes?new=1'); const n3 = JSON.parse(env.store[NQ.NONCE_KEY]).n;
  env.store[NQ.NONCE_KEY] = JSON.stringify({ n: n3, t: Date.now() - NQ.NONCE_TTL - 1 });
  assert.equal(NQ.consume('?new=1&nq=' + n3), false, 'expired');
  assert.equal(NQ.arm('quotes.html?new=1&nq=old#x').replace(/[0-9a-f]{32}/, 'N'), 'quotes.html?new=1&nq=N#x', 're-arm replaces, keeps hash');
});

await t('7: ask() shows name + type + Cancel/Create; Cancel / Escape resolve null, Create returns the picks', async () => {
  const env = makeWin(); const NQ = loadNQ(env);
  env.win.HelmEventName = { eventTypeOptions: (c) => (c === 'AE' ? ['Iftar'] : ['Wedding', 'Corporate']), canonEventType: (v) => v };
  let p = NQ.ask({ country: 'IN' });
  assert.equal(await NQ.ask({}), null, 'a second caller (double click) gets null: no second dialog, no second create');
  assert.equal(env.doc.body.childNodes.filter((n) => n.cls.has('bpui-overlay')).length, 1, 'only one dialog');
  let ov = overlay(env.doc); assert.ok(ov, 'dialog mounted');
  // the 2nd press of a double click lands on the backdrop: it must NOT dismiss the dialog
  assert.equal((ov.ls.mousedown || []).length + (ov.ls.mouseup || []).length, 0, 'no backdrop dismiss');
  const all = ov.all(); const form = all.find((x) => x.tagName === 'FORM');
  assert.equal(form.getAttribute('role'), 'dialog'); assert.equal(form.getAttribute('aria-modal'), 'true');
  const sel = all.find((x) => x.tagName === 'SELECT'); assert.deepEqual(sel.childNodes.map((o) => o.textContent), ['Choose later', 'Wedding', 'Corporate']);
  const btns = all.filter((x) => x.tagName === 'BUTTON').map((b) => b.textContent); assert.deepEqual(btns, ['Cancel', 'Create quote']);
  all.find((x) => x.tagName === 'BUTTON' && x.textContent === 'Cancel').click();
  assert.equal(await p, null); assert.equal(overlay(env.doc), undefined, 'removed');
  // Escape (no BPUI on this page): handled by the module
  p = NQ.ask({}); env.doc.ls.keydown.forEach((f) => f({ key: 'Escape', preventDefault() {} })); assert.equal(await p, null);
  // Create
  p = NQ.ask({ country: 'IN' }); ov = overlay(env.doc);
  const f2 = ov.all().find((x) => x.tagName === 'FORM'), name = ov.all().find((x) => x.tagName === 'INPUT'), s2 = ov.all().find((x) => x.tagName === 'SELECT');
  name.value = '  Sharma   wedding '; s2.value = 'Wedding'; f2.fire('submit');
  assert.deepEqual(JSON.parse(JSON.stringify(await p)), { title: 'Sharma wedding', eventType: 'Wedding' });
  // too long name -> error, stays open
  p = NQ.ask({}); ov = overlay(env.doc);
  ov.all().find((x) => x.tagName === 'INPUT').value = 'x'.repeat(81); ov.all().find((x) => x.tagName === 'FORM').fire('submit');
  assert.ok(overlay(env.doc), 'still open'); assert.match(ov.all().find((x) => x.cls.has('bpui-field-err')).textContent, /80 characters/);
  ov.all().find((x) => x.tagName === 'BUTTON' && x.textContent === 'Cancel').click(); assert.equal(await p, null);
});

await t('7: free trial message comes from subscription.limits(); paid studios keep the plain text', async () => {
  for (const [lim, want] of [[{ trial: true, cap: 2, used: { quotes: 1 } }, /1 of your 2 \(1 left\)/], [{ trial: true, cap: 2, used: { quotes: 2 } }, /used its 2 new quotes/], [{ trial: false }, /You can change these later/]]) {
    const env = makeWin(); const NQ = loadNQ(env);
    env.win.BPStore = { subscription: { limits: async () => lim } };
    const p = NQ.ask({}); await flush(); await flush();
    const ov = overlay(env.doc); assert.match(ov.all().find((x) => x.tagName === 'P' && x.attrs.id && /-m$/.test(x.attrs.id)).textContent, want);
    ov.all().find((x) => x.tagName === 'BUTTON' && x.textContent === 'Cancel').click(); await p;
  }
});

await t('7: every startBlank caller asks first; Cancel returns before anything is created', () => {
  const q = read('public/quotes.html'), d = read('public/dashboard.html'), sb = read('public/shell-b.js');
  const fn = q.slice(q.indexOf('async function startNewQuote('), q.indexOf('document.addEventListener("click", (e) => {', q.indexOf('async function startNewQuote(')));
  assert.ok(fn.indexOf('await HelmNewQuote.ask(') > 0 && fn.indexOf('await HelmNewQuote.ask(') < fn.indexOf('startBlank('), 'quotes: ask before startBlank');
  assert.match(fn, /if\(!pick\) return;/);
  const cb = d.slice(d.indexOf('$("#createBtn").addEventListener'), d.indexOf('$("#loginForm")'));
  assert.ok(cb.indexOf('await HelmNewQuote.ask(') > 0 && cb.indexOf('await HelmNewQuote.ask(') < cb.indexOf('startBlank('), 'dashboard: ask before startBlank');
  assert.match(cb, /if \(!pick\) return;/);
  const dc = sb.slice(sb.indexOf('function dashCreate()'), sb.indexOf('function autoBell('));
  assert.ok(dc.indexOf('NQ.ask(') > 0 && dc.indexOf('NQ.ask(') < dc.indexOf('Q.startBlank('), 'shell fallback: ask before startBlank');
  assert.match(dc, /!NQ \|\| typeof NQ\.ask !== "function"\) \{ creating = false; location\.href = "\/quotes\.html"/, 'no dialog -> list, never a silent create');
  // every page that creates loads the dialog
  for (const [f, src] of [['quotes.html', q], ['dashboard.html', d]]) assert.match(src, /<script src="new-quote-dialog\.js\?v=\d+"><\/script>/, f);
  for (const f of ['public/quotes.html', 'public/dashboard.html', 'public/shell-b.js']) assert.ok(read(f).split('startBlank(').length - 1 >= 1);
  assert.ok(!/startBlank\(/.test(read('public/getting-started.js')), 'checklist never creates by itself');
});

await t('8: ?new=1 only opens the dialog with a consumed nonce; the checklist link arms it', () => {
  const q = read('public/quotes.html'), gs = read('public/getting-started.js');
  const tail = q.slice(q.indexOf('const newQs = new URLSearchParams(location.search);'));
  assert.match(tail, /const armed = !!\(window\.HelmNewQuote && HelmNewQuote\.consume\(location\.search\)\);/);
  assert.match(tail, /if\(armed && canCreate\) startNewQuote\(\$\("#newBtn"\), openTo\);/);
  assert.match(tail, /history\.replaceState\(null, "", location\.pathname\)/, 'params dropped from the address bar');
  assert.ok(!/startBlank/.test(tail.slice(0, tail.indexOf('</script>'))), 'page-load path never calls startBlank');
  assert.match(gs, /a\.gs-go[\s\S]{0,260}NQ\.isNewQuoteHref\(h\)\) a\.setAttribute\("href", NQ\.arm\(h\)\)/);
  assert.match(read('public/dashboard.html'), /new-quote-dialog\.js[\s\S]*getting-started\.js/, 'dialog module loads before the checklist');
});

await t('13: dashboard keeps confirmed events (Archive), drafts go to Deleted (restorable), refusals offer Archive', async () => {
  const d = read('public/dashboard.html');
  const grab = (name) => { const i = d.indexOf('function ' + name + '('); let j = d.indexOf('\n  }', i); return d.slice(i, j + 4); };
  const keepOnDelete = new Function(grab('keepOnDelete') + '; return keepOnDelete;')();
  const blockedDelete = new Function(grab('blockedDelete') + '; return blockedDelete;')();
  assert.equal(keepOnDelete({ status: 'confirmed' }), true);
  assert.equal(keepOnDelete({ status: 'quote', confirmedAt: '2026-10-01' }), true);
  assert.equal(keepOnDelete({ status: 'quote', approvalStatus: 'approved' }), true);
  assert.equal(keepOnDelete({ status: 'quote', approvalStatus: 'paid' }), true);
  assert.equal(keepOnDelete({ status: 'cancelled', lifecycleStage: 'closed' }), true);
  assert.equal(keepOnDelete({ status: 'quote', approvalStatus: 'sent', lifecycleStage: 'quote' }), false);
  // the exact server refusal from move_quote_to_shelf (0040)
  const srv = read('supabase/migrations/0040_link_expiry_archive.sql').match(/raise exception '(This event has payments[^;]*?deleted\. Cancel it instead\.)'/)[1].replace(/''/g, "'");
  assert.equal(blockedDelete({ message: srv }), true); assert.equal(blockedDelete({ message: 'network down' }), false);
  const list = d.slice(d.indexOf('function renderList()'), d.indexOf('async function dropCard('));
  assert.match(list, /if \(keepOnDelete\(q0\)\) \{[\s\S]{0,120}b\.dataset\.mode = "archive"/);
  assert.match(list, /if \(blockedDelete\(err\)\) return archiveCard\(b, q, code, true\);/);
  assert.match(list, /BPStore\.quoteShelf\.move\(b\.dataset\.id, "archive"\)/);
  assert.ok(!/This can't be undone/.test(list), 'delete is a restorable move, not "can\'t be undone"');
  assert.match(list, /Move \$\{code\} to Deleted quotes\? Nothing is erased/);
});

await t('14: saved views use the app dialog (BPUI), never window.prompt / confirm; no dialog -> clear message, no crash', async () => {
  const SRC = read('public/saved-filters.js');
  assert.ok(!/global\.prompt|global\.confirm|window\.prompt|window\.confirm/.test(SRC));
  const run = async (BPUI) => {
    const env = makeWin(); const toasts = []; const saves = [];
    env.win.location = { pathname: '/leads.html', search: '', hash: '' };
    env.win.history = { replaceState() {} }; env.win.setTimeout = () => 0; env.win.URL = URL;
    env.win.prompt = () => { throw new Error('prompt() is not supported'); };
    env.win.confirm = () => { throw new Error('confirm() is not supported'); };
    env.win.BPUI = Object.assign({ toast: (m, o) => toasts.push([m, o && o.type]) }, BPUI || {});
    vm.runInContext(SRC, vm.createContext(env.win));
    const H = env.win.HelmSavedFilters;
    const st = { list: async () => [], save: async (p, n, s, sh) => { saves.push([n, sh]); return { id: '11111111-1111-4111-8111-111111111111' }; }, update: async () => true, remove: async () => true, setDefault: async () => true };
    const ctl = new H.Ctl('leads', H.PAGES.leads, st); ctl.me = 'me'; ctl.admin = true; ctl.row = null;
    await ctl.saveNew(); await flush();
    return { toasts, saves };
  };
  const asked = [];
  let r = await run({ prompt: async (m, o) => { asked.push(['p', o.title, o.maxLength]); return '  Big weddings '; }, confirm: async (m, o) => { asked.push(['c', o.title]); return true; } });
  assert.deepEqual(r.saves, [['Big weddings', true]]); assert.deepEqual(asked, [['p', 'Save view', 60], ['c', 'Share this view?']]);
  r = await run({ prompt: async () => null, confirm: async () => true });
  assert.deepEqual(r.saves, [], 'Cancel saves nothing');
  r = await run({});   // no BPUI.prompt: never falls back to the browser prompt()
  assert.deepEqual(r.saves, []); assert.match(r.toasts[0][0], /Couldn't open the dialog/); assert.equal(r.toasts[0][1], 'err');
  r = await run({ prompt: () => { throw new Error('boom'); }, confirm: async () => true });
  assert.deepEqual(r.saves, []); assert.match(r.toasts[0][0], /Couldn't open the dialog/);
});

await t('hygiene: dialog module is CSP-safe (no html sinks, no inline style)', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\b|style=|eval\(/.test(NQ_SRC), 'no html sinks / inline style');
  assert.match(NQ_SRC, /__helmAdoptCss/);
  assert.match(NQ_SRC, /getRandomValues/);
});

console.log(`quote-create-guards: ${fail ? fail + ' failed, ' : 'all '}${pass} passed`);
if (fail) process.exit(1);
