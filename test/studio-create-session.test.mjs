// Regression: creating a new studio (owner logs out in one tab, signs up in another)
// must not show "Your session expired" in the other tabs, must not silently adopt the
// NEW account's session in an old tab, and a wrong-account invite gets a clear message.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const LOGIN = read('public/login.html');

// pure helper, evaluated on its own
const m = SRC.match(/function signedOutElsewhere\(raw, uid, now\) \{[\s\S]*?\n  \}\n/);
assert.ok(m, 'signedOutElsewhere exists');
const ctx = {}; vm.createContext(ctx); vm.runInContext(m[0] + ';this.f=signedOutElsewhere;', ctx);
const f = ctx.f, now = 1_000_000_000;
assert.equal(f(JSON.stringify({ uid: 'a', ts: now - 5000 }), 'a', now), true, 'recent logout by same person');
assert.equal(f(JSON.stringify({ uid: 'a', ts: now - 300000 }), 'a', now), false, 'old marker ignored');
assert.equal(f(JSON.stringify({ uid: 'b', ts: now }), 'a', now), false, 'other person ignored');
assert.equal(f(null, 'a', now), false);
assert.equal(f('{bad', 'a', now), false);
assert.equal(f(JSON.stringify({ uid: 'a', ts: now + 9000 }), 'a', now), false, 'future ts ignored');

// wiring in store-api.js
assert.match(SRC, /async signOut\(\) \{ explicitSignOut = true; reauthClear\(\); if \(currentUser && currentUser\.id\) lsSet\(SIGNOUT_KEY/, 'signOut stamps the marker');
assert.match(SRC, /byLogout \? "&reason=signout" : "&expired=1"/, 'expireSession uses reason=signout after a deliberate logout');
assert.match(SRC, /data\.session\.user\.id !== currentUser\.id\)[\s\S]{0,300}location\.reload\(\)/, 'refresh that returns a different user reloads instead of adopting it');
assert.match(SRC, /signedOutElsewhere: signedOutElsewhere/, 'exported for tests');

// login.html wiring
assert.match(LOGIN, /QS\.get\("reason"\)==="signout"/, 'login shows a calm signed-out note');
assert.match(LOGIN, /async function resumeSession\(\)\{\n    \$\("#expiredMsg"\)\.hidden=true;/, 'expired banner hidden when a session resumes');
assert.match(LOGIN, /function inviteWrongAccount/, 'wrong-account invite detection');
assert.match(LOGIN, /Sign out & accept invite/, 'sign-out-and-accept action');
assert.doesNotMatch(LOGIN, /innerHTML\s*=\s*[^"'`]*err/, 'no innerHTML with error data');
console.log('studio-create-session: all checks passed');
