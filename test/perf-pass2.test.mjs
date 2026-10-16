// Perf pass 2 + rail/activity fixes (Oct 2026, SHELL_V 91) - static guards.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok ' + name); };

const DASH = read('public/shell-b-dash.js'), SHELL = read('public/shell-b.js'), CSS = read('public/shell-b.css');
const API = read('public/store-api.js'), AUI = read('public/auth-ui.js'), CTL = read('public/control.html');

t('activity card re-reads the audit log on return / bfcache / every 60s and re-renders relative times', () => {
  const blk = DASH.slice(DASH.indexOf('S8 activity feed'), DASH.indexOf('root.classList.add("hd-ready")'));
  assert.match(blk, /S\(\)\.audit\.list\(\{ limit: 12 \}\)/);
  assert.match(blk, /visibilitychange/); assert.match(blk, /pageshow/); assert.match(blk, /setInterval\(refresh, 60000\)/);
  assert.match(blk, /setAttribute\("datetime"/);
});
t('Recently viewed is flagged OFF by default; empty rail slots are not rendered', () => {
  assert.match(SHELL, /RECENT_ON = !!\(window\.HELM_FLAGS && window\.HELM_FLAGS\.recentViewed === true\)/);
  assert.match(SHELL, /if \(RECENT_ON\) bottom\.appendChild\(recentSlot\)/);
  assert.match(CSS, /\.hb-slot:empty/);
});
t('per-tab SWR cache: keyed by user + org, cleared by sessClear and by writes', () => {
  assert.match(API, /o\.uid === uid && o\.oid === oid/);
  assert.match(API, /function sessClear\(\) \{[^\n]*swrClear\(\); \}/);
  assert.match(API, /if \(!isRead\) \{ readCache\.clear\(\); if \(!SWR_KEEP_RPCS\.test\(u\)\) swrClear\(\);/);
  ['pricing', 'rates', 'trial', 'demo', 'trialorg'].forEach((k) => assert.ok(API.includes('swr("' + k + '"'), k));
});
t('bell feed + chat bootstrap no longer block bell.mount (except on chat)', () => {
  assert.ok(!/\n      await refresh\(\);\n      const timer/.test(API));
  assert.match(API, /if \(pageKey\(\) === "chat"\) kick\(\);/);
});
t('two-step nudge (listFactors -> /auth/v1/user) waits for idle unless required', () => {
  assert.match(AUI, /if \(mfaReq\) adminTwoStep\(\);/);
});
t('settings boot is parallel; user-control tab loads on first open', () => {
  assert.match(CTL, /await settle\(cards\);/);
  assert.match(CTL, /if\(name==="users"\) initUsersTab\(\);/);
});
console.log('perf-pass2: ' + n + ' passed');
