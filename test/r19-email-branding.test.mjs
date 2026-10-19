// r19 e-mail branding: every Helm e-mail (Supabase Auth templates + edge-function layout) shows the
// CURRENT compass-H logo from a NEW, versioned hosted URL (the old /email/helm-logo.png URL is cached
// "immutable" by mail image proxies, which kept showing the old two-pill mark).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const r = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const L = await import('../supabase/functions/_shared/email-layout.mjs');

// 1. the URL: absolute https on www.helm.events, versioned, not the cached old one
ok(L.LOGO_URL === 'https://www.helm.events/email/helm-logo-v3.png', 'LOGO_URL is the versioned compass-H PNG');
ok(L.LOGO_ALT === 'Helm Events', 'alt text "Helm Events"');
const local = 'public' + new URL(L.LOGO_URL).pathname;
ok(existsSync(new URL(local, root)), 'logo PNG is shipped under public/ at the LOGO_URL path');
ok(existsSync(new URL('public/email/helm-logo.png', root)), 'old URL kept so already-sent mail resolves');

// 2. the PNG: 80x80 (2x of the 40px display), RGBA, not the old two-pill art
const png = readFileSync(new URL(local, root));
ok(png.subarray(1, 4).toString() === 'PNG', 'is a PNG');
ok(png.readUInt32BE(16) === 80 && png.readUInt32BE(20) === 80, '80x80 = 2x the 40px display');
ok(png[24] === 8 && png[25] === 6, '8-bit RGBA');
ok(createHash('md5').update(png).digest('hex') !== 'c5c2ba47a76f166998e38beb3ca96856', 'not the old two-pill PNG');
// decode (non-interlaced, filter-aware) to check the tile: transparent corner, dark-green body
let idat = []; for (let o = 8; o < png.length;) { const len = png.readUInt32BE(o), t = png.subarray(o + 4, o + 8).toString(); if (t === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len)); o += 12 + len; }
const raw = inflateSync(Buffer.concat(idat)), W = 80, bpp = 4, stride = W * bpp, px = Buffer.alloc(W * stride);
for (let y = 0; y < W; y++) {
  const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    px[y * stride + x] = (line[x] + pred) & 255;
  }
}
const at = (x, y) => [...px.subarray(y * stride + x * bpp, y * stride + x * bpp + 4)];
ok(at(0, 0)[3] === 0, 'rounded corner is transparent');
const edge = at(40, 2); ok(edge[3] === 255 && edge[1] > edge[0] && edge[1] > edge[2] && edge[1] < 90, 'own opaque dark-green tile (dark-mode safe)');
let white = 0, mint = 0;
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const [R, G, B, A] = at(x, y); if (A > 200 && R > 230 && G > 230 && B > 230) white++; if (A > 200 && G > 180 && R < 140 && B > 120) mint++; }
ok(white > 150, 'white H present (' + white + ' px)');
ok(mint > 60, 'mint compass points/ring present (' + mint + ' px)');

// 3. the layout + every generated template carries ONLY the new logo, alt "Helm Events"
const html = L.layout('T', 'P', L.h1('x') + L.button('https://a.test/', 'Go'));
ok(html.includes(`<img src="${L.LOGO_URL}" width="40" height="40" alt="Helm Events"`), 'layout <img> uses LOGO_URL, 40x40, alt');
const files = [...readdirSync(new URL('docs/ops/email-templates/', root)).map((f) => 'docs/ops/email-templates/' + f),
  ...readdirSync(new URL('docs/email-templates/', root)).filter((f) => f.endsWith('.html')).map((f) => 'docs/email-templates/' + f)];
ok(files.length >= 18, 'all auth templates + welcome previews scanned (' + files.length + ')');
for (const f of files) {
  const h = r(f);
  const imgs = (h.match(/<img\b[^>]*>/gi) || []);
  ok(imgs.length === 1 && imgs[0].includes(`src="${L.LOGO_URL}"`) && imgs[0].includes('alt="Helm Events"'), f + ': one image = new logo');
  ok(!h.includes('/email/helm-logo.png'), f + ': old logo URL gone');
}
// buttons + links unchanged: Outlook VML + table button, links on Helm's own /auth/confirm
for (const f of ['confirm-signup', 'invite-user', 'magic-link', 'reset-password', 'change-email']) {
  const h = r('docs/ops/email-templates/' + f + '.html');
  ok(h.includes('<v:roundrect') && h.includes('bgcolor="#0d8a5c"') && h.includes('{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}') && !h.includes('ConfirmationURL'), f + ': Outlook-safe button + /auth/confirm');
}
execFileSync(process.execPath, [new URL('scripts/gen-email-templates.mjs', root).pathname, '--check'], { stdio: 'pipe' });
ok(true, 'generated templates up to date');

// 4. no source in edge functions / scripts hard-codes the old URL; mailers go through the shared layout
const walk = (d) => readdirSync(new URL(d, root), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + e.name + '/') : [d + e.name]);
for (const f of [...walk('supabase/functions/'), ...walk('scripts/')].filter((f) => /\.(ts|mjs|js)$/.test(f)))
  ok(!r(f).includes('/email/helm-logo.png'), f + ': no old logo URL');
for (const f of ['invite-mailer/templates.ts', 'welcome-mailer/templates.ts', 'pkg-client-notify/templates.ts', 'billing-reminder/trial-email.ts', 'client-mailer/logic.mjs', 'wa-proposal/logic.mjs'])
  ok(r('supabase/functions/' + f).includes('_shared/email-layout.mjs'), f + ' uses the shared layout (gets the new logo)');
ok(/helm-logo-v3\.png/.test(r('docs/ops/EMAIL-TEMPLATES.md')) && /never overwrite an e-mail\s+image in place/i.test(r('docs/ops/EMAIL-TEMPLATES.md')), 'owner doc explains the versioned URL');
console.log(`r19-email-branding: ${n} checks passed`);
