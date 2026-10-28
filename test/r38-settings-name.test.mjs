// R38: the studio admin area is called "Settings" (r38-keep: this file names the old text on purpose).
// /control and control.html keep working; /settings serves the same page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok ' + name); };

t('1 no user-visible "Control Center" left (rename script --check)', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts/r38-rename-settings.mjs'), '--check'], { stdio: 'pipe' });
});

t('3 /settings rewrite -> /control in vercel.json; /control untouched; size guard', () => {
  const raw = read('vercel.json'), v = JSON.parse(raw);
  assert.ok(v.rewrites.some((r) => r.source === '/settings' && r.destination === '/control'));
  assert.ok(!v.rewrites.some((r) => r.source === '/control'), 'no redirect away from /control');
  assert.ok(Buffer.byteLength(raw) < 200 * 1024, 'vercel.json < 200 KB');
  const noindex = v.headers.find((h) => !h.has && new RegExp('^' + h.source + '$').test('/settings') && h.headers.some((x) => x.key === 'X-Robots-Tag'));
  assert.ok(noindex, '/settings is noindex + no-store like /control');
  assert.ok(noindex.headers.some((x) => x.key === 'Cache-Control' && x.value === 'no-store'));
});

t('4 public/_headers + server.js parity for /settings', () => {
  assert.match(read('public/_headers'), /\n\/settings\n  X-Robots-Tag: noindex, nofollow, noarchive\n  ! Cache-Control\n  Cache-Control: no-store\n/);
  assert.match(read('server.js'), /rel === '\/settings'\) return serveFile\(res, req, path\.join\(PUBLIC_DIR, 'control\.html'\)\)/);
});

t('5 the page, nav and search say Settings; ids / area keys unchanged', () => {
  const c = read('public/control.html');
  assert.match(c, /<title>Settings — Helm Events<\/title>/);
  assert.match(c, /<h1>Settings<\/h1>/);
  assert.match(read('public/store-api.js'), /key: "controls",\s+label: "Settings",\s+icon: "⚙", page: "control\.html"/);
  assert.match(read('public/shell-b.js'), /a\.key === "controls" \? "Settings"/);
  assert.match(read('public/shell-b.js'), /if \(page === "settings\.html"\) page = "control\.html";/);
  assert.match(read('public/nav-trail.js'), /settings: \["Settings", "control\.html"\]/);
  // people who type the old name still land on Settings
  assert.match(read('public/search-catalog.js'), /label: "Settings",\s+href: "control\.html"[^\n]*alias: \["control center", "control centre", "settings"/);
});

t('6 older database texts are shown with the new name (display layer, no SQL change)', () => {
  const src = read('public/store-api.js');
  const start = src.indexOf('const SETTINGS_NAME'), end = src.indexOf('global.HelmSettingsName = settingsName;');
  assert.ok(start > 0 && end > start);
  const g = {};
  vm.runInNewContext(src.slice(start, end) + 'g.f = settingsName;', { g });
  const f = g.f;
  assert.equal(f('Only a studio admin (or someone allowed to edit Control Center) can change the target margin.'),
    'Only a studio admin (or someone allowed to edit Settings) can change the target margin.');
  assert.equal(f('Open shifts are switched off (Control Center -> Crew).'), 'Open shifts are switched off (Settings -> Crew).');
  assert.equal(f('choose a reminder channel in the Control Centre first'), 'choose a reminder channel in Settings first');
  assert.equal(f('no change'), 'no change');
  assert.match(src, /error\.message = global\.HelmSettingsName\(error\.message\)/, 'rpc() errors');
  assert.match(src, /e\.message = global\.HelmSettingsName\(e\.message\)/, 'friendlyError');
  assert.match(read('public/control.html'), /HelmSettingsName\(c\.description\)/, 'notification catalog descriptions');
});

console.log(`r38-settings-name: ${n} checks passed`);
