// 0167 trial sample manifest - front end + static migration guards.
//  * trial-demo.js: 2-step welcome helpers (welcomeDue, inviteRows), held-back tour, seat-capped invites
//  * trial.js: 0180 - no "Sample data" badge in the trial strip any more
//  * control.html: "N of M seats used" counter + friendly message at the limit
//  * store-api: my_seat_usage / trial_welcome_setup wrappers, seat_limit friendly error
//  * 0167: additive, ASCII, switch stays OFF, manifest-only seeding, MANIFEST + run-all wired
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const TD = read('public/trial-demo.js'), TJ = read('public/trial.js'), API = read('public/store-api.js'), CTL = read('public/control.html');
const MIG = read('supabase/migrations/0167_trial_sample_manifest.sql');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = {}; vm.runInNewContext(fnSrc(TD, 'welcomeDue') + '\n' + fnSrc(TD, 'inviteRows') + '\n' + fnSrc(TJ, 'bannerSpec').replace(/dayNo\(ymdIn\([^;]*;/, 'null;') +
  '\nglobalThis.due=welcomeDue; globalThis.rows=inviteRows; globalThis.spec=bannerSpec;', ctx);

t('welcome due only for a fresh sign-up flag (2 days)', () => {
  const now = Date.now();
  assert.equal(ctx.due(String(now - 1000), now), true);
  assert.equal(ctx.due(String(now - 3 * 24 * 3600 * 1000), now), false);
  assert.equal(ctx.due(null, now), false); assert.equal(ctx.due('x', now), false);
});
t('invite rows: valid emails only, max 2, no duplicates', () => {
  const r = JSON.parse(JSON.stringify(ctx.rows([{ email: ' A@x.in ', role: 'manager' }, { email: 'a@x.in' }, { email: 'bad' }, { email: 'b@y.com', role: 'sales' }, { email: 'c@z.com' }])));
  assert.deepEqual(r, [{ email: 'a@x.in', role: 'manager' }, { email: 'b@y.com', role: 'sales' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.rows([{ email: '' }]))), []);
});
t('trial strip: 0180 - no "Sample data" badge any more (title + Choose a plan only)', () => {
  const base = { is_trial_org: true, is_admin: true, days_left: 6, ends_at: null };
  assert.equal(ctx.spec(Object.assign({ trial_mode: 'demo' }, base)).badge, undefined);
  assert.equal(ctx.spec(Object.assign({ trial_mode: 'own' }, base)).badge, undefined);
  assert.ok(!/htr-badge/.test(TJ));
});
t('welcome: holds the tour, uses the seat-capped invite path, 2 steps + Skip', () => {
  assert.match(TD, /lsSet\("bp_tour_autorun", "1"\)/); assert.match(TD, /lsSet\("bp_force_tour", "1"\)/);
  assert.match(TD, /st\.trialOrg\.welcome\(/); assert.match(TD, /st\.invitations\.create\(/);
  assert.match(TD, /"Name your trial studio"/); assert.match(TD, /"Invite your team \(up to 2\)"/); assert.match(TD, /btn\("Skip"/);
  assert.match(TD, /"Hyderabad"/);
  assert.ok(!/innerHTML|insertAdjacentHTML|\.style\./.test(TD), 'CSP-safe DOM');
  // 0177: every trial (demo or own data) gets the 2-step welcome
  assert.match(read('public/trial-signup.js'), /\n\s*try \{ global\.localStorage\.setItem\("bp_trial_welcome"/);
});
t('store-api: seat + welcome RPCs and friendly seat error', () => {
  assert.match(API, /seats: \(\) => rpc\("my_seat_usage"\)/);
  assert.match(API, /welcome: \(name, city, phone\) => rpc\("trial_welcome_setup"/);
  assert.match(API, /e\.hint === "seat_limit"/);
});
t('control: seat counter + lock at the limit', () => {
  assert.match(CTL, /id="seat_meter"/); assert.match(CTL, /async function renderSeats\(\)/);
  assert.match(CTL, /seats used/); assert.match(CTL, /All seats are in use/);
});
t('0167 migration: additive, ASCII, OFF, publish model', () => {
  assert.ok(!/[^\x00-\x7F]/.test(MIG), 'ASCII only');
  assert.ok(!/\bdrop\s+(table|column)|truncate\b/i.test(MIG));
  assert.match(MIG, /create table if not exists public\.helm_trial_seed_manifest/);
  assert.match(MIG, /where x\.is_current/); assert.match(MIG, /publish_sample_manifest/);
  assert.ok(!/set active = true/i.test(MIG.replace(/^--.*$/gm, '')), 'switch stays OFF');
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0167_trial_sample_manifest\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /trial-manifest-0167/);
});
console.log(`trial-manifest-ui: ${n} passed`);
