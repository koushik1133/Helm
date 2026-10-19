// r21 mobile: landing page pop-ups made non-intrusive on phones + mobile hero/tap-target polish.
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const html = read('public/index.html'), css = read('public/home.css'), js = read('public/home.js');
const gjs = read('public/home-guide.js'), gcss = read('public/home-guide.css'), dpol = read('public/dashboard-polish.css');

t('trial guide never floats on phones and respects "Don\'t show again" without deleting itself', () => {
  assert.match(gjs, /smallMq = window\.matchMedia\('\(max-width: 767px\)'\)/);
  assert.match(gjs, /function floating\(\) \{ return !muted && !smallMq\.matches; \}/);
  assert.match(gjs, /if \(shown \|\| !timeOk \|\| !floating\(\)\) return;/);
  assert.doesNotMatch(gjs, /if \(store\.get\(\)\) return;/, 'muting must not remove the in-page way to open the guide');
  assert.doesNotMatch(gjs, /root\.remove\(\)/);
  assert.match(gcss, /@media \(max-width:767px\)\{\s*\.hg-launch\{display:none\}\s*\.hg:not\(\.open\)\{display:none\}/);
});

t('guide opens on demand from an in-page button (bottom sheet on phones), focus returns to it', () => {
  assert.match(html, /<button class="btn btn-line hg-ask" type="button" data-guide-open hidden>/);
  assert.match(gjs, /querySelectorAll\('\[data-guide-open\]'\)/);
  assert.match(gjs, /toggle\(true, b\)/);
  assert.match(gjs, /opener && document\.contains\(opener\)/);
  assert.match(gcss, /\.hg\.sheet \.hg-panel\{width:100%/);
});

t('mobile bottom bar: slim, dismissible, dismissal remembered, no layout jump', () => {
  assert.match(html, /<button class="mcta-x" type="button" aria-label="Hide this bar">/);
  assert.match(js, /MCTA_KEY = 'helm-mcta-hidden', MCTA_DAYS = 14/);
  assert.match(js, /localStorage\.setItem\(MCTA_KEY, String\(Date\.now\(\)\)\)/);
  assert.match(js, /try \{ var t = Number\(window\.localStorage\.getItem\(MCTA_KEY\)\)/, 'storage reads guarded');
  assert.doesNotMatch(css, /body\.has-mcta \.foot\{padding-bottom/, 'footer padding must not toggle with the bar (CLS)');
  assert.match(css, /\.foot\{padding-bottom:calc\(84px \+ env\(safe-area-inset-bottom\)\)\}/);
  assert.match(css, /body\.lock \.mcta\{transform:translateY\(110%\);visibility:hidden\}/);
});

t('Save-Data / 2G: no autoplaying video; phones fetch the hero film only when it scrolls into view', () => {
  assert.match(js, /var liteData = !!netInfo\.saveData \|\| \/\(\^\|-\)2g\$\/\.test/);
  assert.match(js, /var userPaused = reduce \|\| liteData;/);
  assert.match(js, /var heroUserPaused = reduce \|\| liteData, heroVisible = false;/);
  assert.match(js, /if \(!reduce && !liteData\) \{[\s\S]{0,260}if \(!smallScreen\) loadV\(heroVideo\);/);
});

t('mobile hero: one-line eyebrow, fluid headline, stacked CTAs, softer ticker fade, 44px controls', () => {
  assert.match(html, /<span class="ew-l">For event studios, planners and decorators — worldwide<\/span><span class="ew-s">For studios, planners &amp; decorators<\/span>/);
  assert.match(css, /\.hl\{font-size:clamp\(38px,11\.2vw,56px\)/);
  assert.match(css, /\.hero \.cta-row\{flex-direction:column;align-items:stretch/);
  assert.match(css, /\.trust\{margin-top:28px;padding:20px 0 4px;mask-image:linear-gradient\(90deg,transparent,#000 18%/);
  assert.match(css, /\.hv-play\{width:44px;height:44px/);
  assert.match(css, /\.hv-seg\{height:44px;padding:20px 0\}/);
  assert.match(css, /\.wrap\.snap\{margin-left:0!important;margin-right:0!important\}/);
});

t('below-fold morph image is lazy; every <img> has width and height', () => {
  assert.match(html, /class="mimg mx0"[^>]*loading="lazy"/);
  for (const m of html.matchAll(/<img\b[^>]*>/g)) assert.ok(/\bwidth="\d+"/.test(m[0]) && /\bheight="\d+"/.test(m[0]), m[0].slice(0, 80));
});

t('dashboard header on phones: caret no longer 26px; r22: 44px icon buttons + 40px caret on every phone', () => {
  assert.match(dpol, /body header\.hb-header \.hb-split \.hb-chev:not\(\.hb-solo\) \{ width: 40px; min-width: 40px;/);
  assert.match(dpol, /@media \(max-width: 480px\) \{[\s\S]{0,400}width: 44px; min-width: 44px;/);
});

console.log(`r21-landing-mobile: ${n} passed`);
