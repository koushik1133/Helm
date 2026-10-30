#!/usr/bin/env node
// R23 Invitation Studio: built-in music library, photo placement, scroll / sticky-preview fix, dd/mm/yyyy hint.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const load = (file) => { const ctx = { window: {} }; ctx.globalThis = ctx; vm.runInNewContext(read(file), ctx); return ctx.window; };

const studio = read('public/invite-studio.html'), invite = read('public/invite.html');
const M = load('public/invite-music.js').HelmInviteMusic, P = load('public/invite-placement.js').HelmInvitePlace;

/* ---------------- music ---------------- */
t('library lists 3-5 original tracks, each a small local mp3 we generate ourselves', () => {
  assert.ok(M.TRACKS.length >= 3 && M.TRACKS.length <= 5);
  const gen = read('scripts/gen-invite-music.mjs');
  for (const tr of M.TRACKS) {
    assert.equal(tr.src, '/invite/music/' + tr.key + '.mp3');
    const f = join(ROOT, 'public', tr.src);
    assert.ok(existsSync(f), tr.src + ' exists');
    assert.ok(statSync(f).size < 500 * 1024, tr.src + ' < 500 KB');
    assert.ok(gen.includes('"' + tr.key + '": { title: "' + tr.title + '"'), tr.key + ' is composed in gen-invite-music.mjs');
  }
  assert.doesNotMatch(gen, /https?:\/\/|fetch\(|curl|wget/, 'the generator never downloads anything');
});
t('a stored track key maps only to its fixed file; anything else plays nothing', () => {
  assert.equal(M.src('gentle-piano'), '/invite/music/gentle-piano.mp3');
  for (const bad of ['', '../x', 'https://evil/x.mp3', '__proto__', 'constructor', null, 42, ['gentle-piano']]) assert.equal(M.src(bad), '', String(bad));
});
t('public page: library track wins, else the https-only custom link; mute toggle has state', () => {
  assert.match(invite, /<script src="\/invite-music\.js\?v=\d+"><\/script><script src="\/invite-placement\.js\?v=\d+"><\/script>/);
  assert.match(invite, /const siteMusic=d=>\(d&&window\.HelmInviteMusic&&HelmInviteMusic\.src\(d\.musicTrack\)\)\|\|safeMusic\(d&&d\.music\);/);
  assert.match(invite, /const music=siteMusic\(d\);/);
  assert.match(invite, /if\(SITE&&SITE\.data&&siteMusic\(SITE\.data\)\)\{/, 'plays on the Open tap (autoplay rules)');
  assert.match(invite, /b\.setAttribute\("aria-pressed",on\?"true":"false"\);[\s\S]{0,80}const l=on\?"Mute music":"Play music";/);
  assert.match(invite, /\$\("#musicFab"\)\.hidden=!music;/);
});
t('studio: library optgroup, saves the KEY (musicTrack), preview button plays library + https links', () => {
  assert.match(studio, /<optgroup label="Helm music library \(free to use\)" id="musicLib"><\/optgroup>/);
  assert.match(studio, /o\.value="lib:"\+t\.key;/);
  assert.match(studio, /music:musicUrl\(\), musicTrack:libKey\(\),/);
  assert.match(studio, /if\(MUSIC&&MUSIC\.has\(d\.musicTrack\)\)\{ \$\("#f_musicPick"\)\.value="lib:"\+d\.musicTrack; \}/);
  assert.match(studio, /if\(!lib\)\{ if\(!u \|\| u\.protocol!=="https:"\)/);
});
t('CSP: invitation pages allow same-origin media + images', () => {
  const v = JSON.parse(read('vercel.json'));
  // r83: pages sharing one CSP share one rule, so resolve by URL (last matching rule wins, as on Vercel)
  for (const src of ['/invite', '/invite.html', '/invite-studio', '/i/abc', '/demo/invite/abc']) {
    const hs = v.headers.filter((x) => !x.has && new RegExp('^' + x.source + '$').test(src)).flatMap((x) => x.headers).filter((x) => x.key === 'Content-Security-Policy');
    assert.ok(hs.length, src); const csp = hs[hs.length - 1].value;
    assert.match(csp, /media-src 'self'/, src); assert.match(csp, /img-src 'self'/, src);
  }
});

/* ---------------- photo placement ---------------- */
t('normalize: old sites = cover + gallery; singles unique; junk falls back to gallery', () => {
  assert.deepEqual([...P.normalize(3)], ['cover', 'gallery', 'gallery']);
  assert.deepEqual([...P.normalize(4, ['background', 'background', 'names', 'after:rsvp'])], ['background', 'gallery', 'names', 'after:rsvp']);
  assert.deepEqual([...P.normalize(3, ['x', 'after:evil', '<b>'])], ['gallery', 'gallery', 'gallery']);
  assert.equal(P.dim(999), 85); assert.equal(P.dim('abc'), P.DIM_DEFAULT); assert.equal(P.blur(-5), 0);
  const L = P.layout(['a', 'b', 'c', 'd'], ['names', 'gallery', 'after:details', 'cover']);
  assert.equal(L.names, 'a'); assert.equal(L.cover, 'd'); assert.deepEqual([...L.gallery], ['b']); assert.deepEqual([...L.after.details], ['c']);
  assert.deepEqual([...P.OPTIONS.map((o) => o.key)], ['cover', 'background', 'names', 'gallery', 'inline']);
});
t('public page renders every placement (all 5 templates share one renderer)', () => {
  assert.match(invite, /const allPlaces=PL\?PL\.normalize\(raw\.length,d\.photoPlaces\)/);
  assert.match(invite, /\$\{bgBlock\}\s+\$\{heroBlock\}/);
  for (const s of ['details', 'schedule', 'RSVP']) assert.ok(invite.includes('inlineHtml(LY.after.' + s.toLowerCase() + ',"' + s + '")'), s);
  assert.match(invite, /galleryHtml\(LY\.gallery\)/);
  assert.match(invite, /<div class="namespic"><div class="nframe">/);
  assert.match(invite, /filter:blur\(\$\{blur\}px\)[\s\S]{0,80}opacity:\$\{dim\/100\}/);
  // every placed photo goes through cssUrl in a url() sink
  assert.ok((invite.match(/background-image:url\('\$\{cssUrl\(/g) || []).length >= 5);
});
t('studio: per-photo radio cards with diagrams, section picker, background sliders, saved in data JSON', () => {
  assert.match(studio, /<template id="ppIcons">/);
  for (const k of ['cover', 'background', 'names', 'gallery', 'inline']) assert.match(studio, new RegExp('<svg data-k="' + k + '"'));
  assert.match(studio, /<input type="radio" name="pp\$\{i\}"/);
  assert.match(studio, /photos:PHOTOS\.slice\(\), photoPlaces:PL\.normalize\(PHOTOS\.length,PLACES\),/);
  assert.match(studio, /bgDim:PL\.dim\(\$\("#f_bgDim"\)\.value\), bgBlur:PL\.blur\(\$\("#f_bgBlur"\)\.value\),/);
  assert.match(studio, /PHOTOS\.splice\(i,1\); PLACES\.splice\(i,1\);/, 'removing a photo removes its placement');
  assert.match(studio, /id="f_bgDim" type="range" min="0" max="85"/);
});

/* ---------------- scroll fix + dates ---------------- */
t('preview is sticky under the shell top bar and fills the viewport (no inner column scroll)', () => {
  assert.match(studio, /\.preview-wrap\{position:sticky;top:calc\(var\(--hb-top,0px\) \+ 16px\);height:calc\(100vh - var\(--hb-top,0px\) - 32px\)/);
  assert.match(studio, /\.preview-wrap \.frame\{flex:1 1 auto;height:auto;min-height:220px\}/);
  assert.doesNotMatch(studio, /\.preview-wrap\{max-height:calc\(100vh - 32px\);overflow-y:auto/);
  assert.match(studio, /<section class="card ish-card" id="shareCard"/, 'Send to client moved into the form column');
});
t('phone: preview is a bottom sheet toggled by a floating button (Esc / scrim close)', () => {
  assert.match(studio, /id="pvToggle" type="button" aria-controls="pvSheet" aria-expanded="false"/);
  assert.match(studio, /\.preview-wrap\.open\{transform:none;visibility:visible/);
  assert.match(studio, /if\(e\.key==="Escape"&&\$\("#pvSheet"\)\.classList\.contains\("open"\)\) sheet\(false\);/);
  assert.match(studio, /if\(KEEP\.has\(n\.id\)\|\|n\.hasAttribute\("data-ro-keep"\)\) return;/, 'read-only keeps the sheet close button');
  assert.match(invite, /const y=window\.scrollY;[\s\S]{0,140}window\.scrollTo\(0,y\);/, 'preview keeps its scroll spot');
  assert.match(studio, /nb\.focus\(\{preventScroll:true\}\)/, 'template pick no longer jumps the page');
});
t('dates: dd/mm/yyyy note + spelled-out day under both date boxes', () => {
  assert.match(studio, /id="dateFmtNote">Dates read day \/ month \/ year \(dd\/mm\/yyyy\)/);
  assert.match(studio, /BPUI\.dateHint\(\$\("#f_date"\)\); BPUI\.dateHint\(\$\("#f_rsvpBy"\)\);/);
});

console.log('\nr23-invitation: ' + n + ' passed');
