// Public read-only Demo Studio (/demo): a static guided tour with a bundled made-up
// studio. It must never reach Supabase or any API, never carry inline script/style,
// and stay registered as a public, indexable marketing page.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const html = read('public/demo.html');
const js = read('public/demo.js');
const css = read('public/demo.css');

t('demo.html: public page, no auth gate, no Supabase/config/telemetry, no inline script/style', () => {
  assert.ok(!/auth-pending/.test(html));
  assert.ok(!/supabase/i.test(html));
  assert.ok(!/config\.js|store-api\.js|telemetry\.js|photo-render/.test(html));
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(html), 'no inline scripts (CSP)');
  assert.ok(!/<style/.test(html), 'no inline <style>');
  assert.ok(!/\sstyle="/.test(html), 'no style attributes');
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.helm\.events\/demo">/);
});
t('banner says read-only + trial CTA + planner link', () => {
  assert.match(html, /Demo · read-only/);
  assert.match(html, /href="\/login\?trial=1#signup">Start your 8-day free trial/);
  assert.match(html, /href="\/try"/);
});
t('demo.js: no innerHTML / insertAdjacentHTML / eval, no Supabase host, no style attributes', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js));
  assert.ok(!/supabase\.co/.test(js));
  assert.ok(!/setAttribute\(\s*['"]style/.test(js) && !/\.style\./.test(js));
});
t('demo.css stays scoped (html.helm-demo / .dm-*)', () => {
  const sels = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '')
    .match(/(^|\})\s*([^{}@]+)\{/g).map((m) => m.replace(/^\}?\s*/, '').replace(/\{$/, '').trim());
  for (const s of sels) for (const part of s.split(','))
    assert.match(part.trim(), /^(html\.helm-demo|\.dm-)/, 'unscoped selector: ' + part);
});

/* network guard in a sandbox */
function env() {
  const calls = [];
  const win = {
    location: { href: 'https://www.helm.events/demo', origin: 'https://www.helm.events', hash: '' },
    fetch: (u) => { calls.push(String(u)); return Promise.resolve({ ok: true }); },
    XMLHttpRequest: function () {}, WebSocket: function () {}, addEventListener() {}, scrollTo() {},
  };
  win.XMLHttpRequest.prototype.open = function () {};
  const doc = { readyState: 'loading', addEventListener() {}, documentElement: { getAttribute() { return null; }, setAttribute() {} }, getElementById() { return null; } };
  const ctx = { window: win, document: doc, navigator: { sendBeacon: () => true }, URL, Intl, Date, Math, String, Promise, TypeError, Object, Array, setTimeout, clearTimeout, localStorage: { getItem() { return null; }, setItem() {} } };
  ctx.location = win.location;
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  return { win, ctx, calls };
}
t('network guard: only same-origin static GETs; Supabase, APIs, writes, sockets refused', async () => {
  const { win, ctx, calls } = env();
  const ok = win.__demoOk;
  assert.equal(ok('/demo.css?v=1', 'GET'), true);
  assert.equal(ok('https://xizehqgeyjcfpzrdymly.supabase.co/rest/v1/studios', 'GET'), false);
  assert.equal(ok('https://nqltzgiwznphugcfhmbm.supabase.co/auth/v1/token', 'POST'), false);
  for (const p of ['/api/layouts', '/rest/v1/x', '/auth/v1/user', '/functions/v1/x', '/storage/v1/x']) assert.equal(ok(p, 'GET'), false, p);
  assert.equal(ok('/demo.html', 'POST'), false);
  assert.equal(ctx.navigator.sendBeacon('/x', 'y'), false);
  assert.throws(() => new win.WebSocket('wss://x'));
  assert.equal(win.SUPABASE_CONFIG.url, '');
  win.fetch('https://xizehqgeyjcfpzrdymly.supabase.co/rest/v1/x').catch(() => {});
  assert.equal(calls.length, 0, 'blocked fetch never reaches the network');
  assert.throws(() => new win.XMLHttpRequest().open('GET', 'https://evil.example/x'));
});
t('fictional dataset: settlement P&L adds up', () => {
  const { win } = env();
  const st = win.__demoData.settlement;
  const bills = st.bills.reduce((a, b) => a + b[2], 0), exp = st.expenses.reduce((a, x) => a + x[1], 0);
  assert.equal(st.quote - bills - exp, 179000);
  assert.equal(st.payments.reduce((a, p) => a + p[2], 0), st.quote, 'milestones sum to the quote');
});
t('registered as a public marketing page everywhere', () => {
  assert.match(read('server.js'), /INDEXABLE_PAGES = new Set\(\[[^\]]*'demo'/);
  assert.match(read('public/robots.txt'), /Allow: \/demo\$/);
  assert.match(read('public/sitemap.xml'), /helm\.events\/demo<\/loc>/);
});

console.log(`\ndemo-studio: ${n} passed`);
