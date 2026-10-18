// SEO / GEO / AEO: every public marketing page carries a unique title + description,
// canonical www URL, Open Graph + Twitter card with the current Helm share image,
// the favicon set + manifest, valid JSON-LD (Organization + WebSite, plus
// SoftwareApplication/FAQPage on home and BreadcrumbList on subpages) and one <h1>.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url);
const rd = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; };
const PAGES = ['index', 'pricing', 'services', 'about', 'demo', 'try', 'privacy', 'terms', 'refund-policy', 'data-deletion',
  'cookie-policy', 'dpa', 'acceptable-use', 'subprocessors', 'security', 'sla', 'accessibility', 'grievance', 'ai-notice', 'copyright'];
const titles = new Set();
for (const p of PAGES) {
  t(p, () => {
    const h = rd(`public/${p}.html`); const head = h.split('</head>')[0];
    const title = head.match(/<title>([^<]+)<\/title>/)[1];
    assert.ok(/Helm Events/.test(title), `${p}: title names Helm Events`);
    assert.ok(!titles.has(title), `${p}: unique title`); titles.add(title);
    assert.match(head, /<meta name="description" content="[^"]{50,}">/);
    const url = 'https://www.helm.events' + (p === 'index' ? '/' : '/' + p);
    assert.ok(head.includes(`<link rel="canonical" href="${url}">`), `${p}: canonical`);
    assert.ok(head.includes(`<meta property="og:url" content="${url}">`));
    assert.ok(head.includes('content="https://www.helm.events/og/helm-og.png"'), `${p}: og image`);
    assert.ok(head.includes('<meta name="twitter:card" content="summary_large_image">'));
    assert.ok(head.includes('<link rel="manifest" href="/site.webmanifest">'));
    assert.ok(head.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">'));
    assert.equal((h.match(/<h1[\s>]/g) || []).length, p === 'demo' ? 0 : 1, `${p}: single h1`); // demo renders its h1 in demo.js
    const lds = [...head.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)];
    assert.equal(lds.length, 1, `${p}: one JSON-LD block`);
    const g = JSON.parse(lds[0][1])['@graph']; const types = g.map((x) => x['@type']);
    assert.ok(types.includes('Organization') && types.includes('WebSite'));
    assert.equal(g.find((x) => x['@type'] === 'Organization').name, 'Helm Events');
    if (p === 'index') {
      assert.ok(types.includes('SoftwareApplication'));
      const faq = g.find((x) => x['@type'] === 'FAQPage');
      assert.ok(faq && faq.mainEntity.length >= 5, 'FAQPage mirrors the landing FAQ');
      assert.ok(!/</.test(JSON.stringify(faq)), 'FAQ answers are plain text');
    } else assert.ok(types.includes('BreadcrumbList'), `${p}: breadcrumbs`);
  });
}
t('assets + manifest', () => {
  for (const f of ['og/helm-og.png', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'])
    assert.ok(existsSync(new URL('public/' + f, root)), f);
  const png = readFileSync(new URL('public/og/helm-og.png', root));
  assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
  const m = JSON.parse(rd('public/site.webmanifest'));
  assert.equal(m.name, 'Helm Events'); assert.equal(m.theme_color, '#0d8a5c');
  assert.ok(m.icons.some((i) => i.sizes === '512x512'));
});
t('robots + sitemap + llms', () => {
  const r = rd('public/robots.txt');
  for (const a of ['Allow: /og/', 'Allow: /icon-', 'Allow: /site.webmanifest', 'Sitemap: https://www.helm.events/sitemap.xml']) assert.ok(r.includes(a), a);
  const s = rd('public/sitemap.xml');
  for (const p of ['/', '/pricing', '/services', '/about', '/try', '/demo']) assert.ok(s.includes(`<loc>https://www.helm.events${p}</loc>`), p);
  const l = rd('public/llms.txt');
  assert.match(l, /^# Helm Events/); assert.ok(l.includes('https://www.helm.events/pricing') && l.includes('sales@helm.events'));
});
console.log(`seo-geo: ${n} checks passed`);
