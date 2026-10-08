// Client event booklet (0065) — front end + wiring.
//  * pure helpers in public/booklet.js: token parsing, safe accent / logo, quotation lines,
//    layout normalisation (bad shapes dropped), iso projection
//  * booklet.html: no inline script/style/style=, noindex + no-referrer meta, store-api v=136
//  * booklet.js / booklet-share.js never use innerHTML / insertAdjacentHTML / document.write
//  * vercel.json: /booklet is noindex, no-store, no-referrer and gets the user-image CSP
//  * store-api: BPStore.booklet → public_get_booklet / booklet_share / booklet_revoke / booklet_current
//  * share buttons on event.html + client.html ("Booklet" header link on client.html)
//  * migration 0065 in MANIFEST, suspended-studio guard, APPLY-0065.sql pure ASCII with verify rows
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const ctx = { console, URLSearchParams };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(read('public/booklet.js'), ctx);
const api = ctx.HelmBooklet;
const J = (x) => JSON.parse(JSON.stringify(x));

t('tokenFrom: only a uuid in ?t= (or legacy ?token=)', () => {
  assert.equal(api.tokenFrom('?t=0b8c2f1e-1111-4222-8333-944445555666'), '0b8c2f1e-1111-4222-8333-944445555666');
  assert.equal(api.tokenFrom('?token=0b8c2f1e-1111-4222-8333-944445555666'), '0b8c2f1e-1111-4222-8333-944445555666');
  assert.equal(api.tokenFrom('?t=abc'), null);
  assert.equal(api.tokenFrom('?t=<script>'), null);
  assert.equal(api.tokenFrom(''), null);
});
t('safeHex / safeLogo reject hostile values', () => {
  assert.equal(api.safeHex('#aa3355'), '#aa3355');
  assert.equal(api.safeHex('red;background:url(x)'), null);
  assert.equal(api.safeLogo('https://cdn.example.test/l.png'), 'https://cdn.example.test/l.png');
  assert.equal(api.safeLogo('javascript:alert(1)'), null);
  assert.equal(api.safeLogo('http://insecure.test/l.png'), null);
  assert.equal(api.safeLogo('https://x.test/a" onerror="x'), null);
});
t('quoteLines: client-facing lines, GST split, discount, total', () => {
  const r = api.quoteLines({ chairs: 100, chairPrice: 200, guests: 120, platePrice: 500, gstPct: 18, discount: 1000, couponCode: 'WED10', total: 117000,
    computed: { subtotal: 80000, discount: 1000, cgst: 7110, sgst: 7110, total: 117000 } });
  const labels = r.lines.map((l) => l.label);
  assert.deepEqual(J(labels), ['Seating', 'Catering', 'Subtotal', 'Discount', 'CGST', 'SGST']);
  assert.equal(r.lines.find((l) => l.label === 'Discount').amount, -1000);
  assert.equal(r.total, 117000);
  const c = api.quoteLines({ cateringMode: 'client', guests: 50, platePrice: 400, computed: { igst: 10, total: 10 } });
  assert.ok(c.lines.some((l) => l.label === 'Catering' && l.amount === 0));
  assert.ok(c.lines.some((l) => l.label === 'IGST'));
  assert.equal(J(api.quoteLines(null)).lines.length, 0);
});
t('normalizeItems: drops bad shapes, keeps safe colours only', () => {
  const m = api.normalizeItems({ room: { w: 100, h: 60 }, items: [
    { type: 'stage', category: 'structure', label: 'Stage', x: 1, y: 2, width: 20, height: 10, color: '#7c3aed' },
    { type: 'x', x: 'a', y: 0, width: 1, height: 1 },
    { type: 'bar', category: 'evil', x: 0, y: 0, width: 5, height: 5, color: 'url(javascript:1)' },
    null] });
  assert.equal(m.items.length, 2);
  assert.equal(m.items[1].cat, 'other');
  assert.ok(/^#[0-9a-f]{6}$/i.test(m.items[1].color));
  assert.deepEqual(J(api.bounds(m)), { x0: 0, y0: 0, x1: 100, y1: 60 });
  assert.equal(api.normalizeItems(null).items.length, 0);
});
t('iso projection + shade are numeric', () => {
  assert.deepEqual(J(api.iso(10, 0, 0).map((v) => Math.round(v * 100) / 100)), [8.66, 5]);
  assert.equal(api.shade('#ffffff', 0.5), '#808080');
});
t('booklet.html: no inline script/style/style=, noindex, no-referrer, store-api v=136', () => {
  const h = read('public/booklet.html');
  assert.doesNotMatch(h, /<script(?![^>]*\ssrc=)[^>]*>/i);
  assert.doesNotMatch(h, /<style/i);
  assert.doesNotMatch(h, /\sstyle=/i);
  assert.doesNotMatch(h, /\son[a-z]+=/i);
  assert.match(h, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(h, /<meta name="referrer" content="no-referrer">/);
  assert.match(h, /store-api\.js\?v=136/);
  assert.match(h, /booklet\.js\?v=6/);
  for (const id of ['details', 'layout2d', 'layout3d', 'menu', 'quote', 'versions', 'payments', 'receiptTable', 'receiptLines', 'terms', 'printBtn', 'tocList'])
    assert.match(h, new RegExp('id="' + id + '"'), id);
});
t('booklet.js + booklet-share.js: DOM APIs only, print via window.print', () => {
  for (const f of ['public/booklet.js', 'public/booklet-share.js', 'public/client.js']) {
    const s = read(f);
    assert.doesNotMatch(s, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/, f);
  }
  assert.match(read('public/booklet.js'), /global\.print\(\)/);
  assert.match(read('public/booklet.css'), /@media print/);
});
t('booklet.js: receipts rendered via textContent; 0070 outstanding wins, credit shown, client fallback kept', () => {
  const s = read('public/booklet.js');
  assert.match(s, /function renderReceipts\(rc\)/);
  assert.match(s, /Array\.isArray\(p\.receipts\)/);
  assert.match(s, /"Credit"/);
  assert.match(s, /total - \(Number\(p\.paid\) \|\| 0\)/);
});
t('vercel.json: /booklet noindex + no-store + no-referrer + user-image CSP', () => {
  const v = JSON.parse(read('vercel.json'));
  const hdrs = (p) => { const o = {}; for (const r of v.headers) if (!r.has && new RegExp('^' + r.source + '$').test(p)) for (const h of r.headers) o[h.key.toLowerCase()] = h.value; return o; };
  for (const p of ['/booklet', '/booklet.html']) {
    const h = hdrs(p);
    assert.match(h['x-robots-tag'] || '', /noindex/, p);
    assert.match(h['cache-control'] || '', /no-store/, p);
    assert.equal(h['referrer-policy'], 'no-referrer', p);
    assert.match(h['content-security-policy'] || '', /img-src 'self' data: blob: https:/, p);
  }
  assert.ok(Buffer.byteLength(read('vercel.json')) < 200 * 1024);
  assert.match(read('public/_headers'), /^\/booklet$/m);
});
t('store-api: booklet API + public page registration', () => {
  const s = read('public/store-api.js');
  assert.match(s, /rpc\("public_get_booklet", \{ p_token: token \}\)/);
  assert.match(s, /rpc\("booklet_share", \{ p_quote_id: quoteId/);
  assert.match(s, /rpc\("booklet_revoke", \{ p_quote_id: quoteId \}\)/);
  assert.match(s, /rpc\("booklet_current", \{ p_quote_id: quoteId \}\)/);
  assert.match(s, /links\.base\(\) \+ "\/booklet\?t="/);
  assert.match(s, /PUBLIC_PAGES = \{[^}]*booklet: 1/);
});
t('share buttons: event page + client page (with Booklet header link)', () => {
  const ev = read('public/event.html'), cl = read('public/client.html');
  assert.match(ev, /data-booklet-share data-quote-from-url hidden/);
  assert.match(ev, /booklet-share\.js\?v=3/); assert.match(ev, /booklet-share\.css\?v=1/);
  assert.match(cl, /data-booklet-share data-wait-quote hidden/);
  assert.match(cl, /id="bkLink" hidden>Booklet<\/a>/);
  assert.match(cl, /booklet-share\.js\?v=3/);
  assert.match(read('public/booklet-share.js'), /canEditArea\("quotes"\)/);
});
t('client.js bookletQuote: opened event wins, else newest event link', () => {
  const c = { console, URLSearchParams }; c.window = c; c.globalThis = c;
  vm.createContext(c); vm.runInContext(read('public/client.js'), c);
  const a = '0b8c2f1e-1111-4222-8333-944445555666', b = '1b8c2f1e-1111-4222-8333-944445555666';
  const m = { items: [{ href: 'event.html?id=' + a }, { href: 'leads.html?hs=x' }, { href: 'event.html?id=' + b }] };
  assert.equal(c.HelmClient360.bookletQuote(m, b), b);
  assert.equal(c.HelmClient360.bookletQuote(m, 'nope'), a);
  assert.equal(c.HelmClient360.bookletQuote({ items: [] }, a), null);
});
t('migration 0065: MANIFEST, RLS, guard, client-safe allow-list; APPLY-0065 ASCII + verify rows', () => {
  const m = read('supabase/migrations/0065_client_booklet.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0065_client_booklet\.sql/);
  assert.match(m, /enable row level security/);
  assert.match(m, /zzz_studio_read_only/);
  assert.match(m, /has_area\('quotes', case when p_edit then 'edit' else 'view' end\)/);
  assert.match(m, /rate_hit\('booklet\.read'/);
  assert.doesNotMatch(m, /'vendor'|venue_contact'|access_notes'|'note', m\.note/);
  const a = read('supabase/APPLY-0065.sql');
  assert.ok(/^[\x00-\x7F]*$/.test(a), 'APPLY-0065 must be pure ASCII');
  assert.match(a, /select item, ok from \(values/);
  assert.match(a, /suspended-studio guard attached/);
});
console.log(`\nclient-booklet-ui: ${n} passed`);
