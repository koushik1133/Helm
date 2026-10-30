// R91: signed-in-only reads are never sent with the bare anon key (no 42501 noise in the Postgres log),
// pollers stop on sign-out / expiry, and the public pages' RPCs are never blocked by the local guard.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const S = read('public/store-api.js');
let n = 0; const t = (name, fn) => { fn(); n++; };
const rx = (name) => { const m = S.match(new RegExp('const ' + name + ' = (/.*/);')); assert.ok(m, name); return eval(m[1]); };
const READ_RPCS = rx('READ_RPCS'), SIGNED_IN_ONLY = rx('SIGNED_IN_ONLY');
const blocked = (u) => READ_RPCS.test(u) || SIGNED_IN_ONLY.test(u);
const B = 'https://x.supabase.co/rest/v1/';

t('guard exists and runs before the network call', () => {
  assert.match(S, /function anonDenied\(input, init\)/);
  const a = S.indexOf('function authAwareFetch'); const body = S.slice(a, a + 400);
  assert.ok(body.indexOf('anonDenied(input, init)') > -1 && body.indexOf('anonDenied') < body.indexOf('coalescedFetch'));
  assert.match(S, /"Bearer " \+ CFG\.anonKey/);
});
t('signed-in-only reads are matched', () => {
  for (const u of ['rpc/bell_feed', 'rpc/my_notification_mutes', 'rpc/my_notification_prefs', 'rpc/chat_directory',
    'chat_conversations?select=*', 'chat_members?select=*', 'chat_prefs', 'leads?select=*', 'quotes?select=id']) assert.ok(blocked(B + u), u);
});
t('public RPCs (approval, invitation, site, enquiry, login) are never blocked', () => {
  const names = new Set(['public_get_portal', 'public_enquiry_info', 'public_enquiry_submit', 'submit_sales_enquiry']);
  for (const f of ['public/store-api.js', 'public/enquiry.js', 'public/contact-sales.js', 'public/approve.html', 'public/login.html'])
    for (const m of read(f).matchAll(/rpc\(\s*["'](public_[a-z0-9_]+|submit_[a-z0-9_]+)["']/g)) names.add(m[1]);
  assert.ok(names.size > 5);
  for (const nme of names) assert.ok(!blocked(B + 'rpc/' + nme), nme);
  for (const u of ['quotes_public?x=1', 'leadsx', 'storage/v1/object/x']) assert.ok(!blocked(B + u), u);
});
t('bell + inbox pollers stop without a signed-in user', () => {
  assert.match(S, /const refresh = \(\) => \{ if \(!\(auth\.enabled\(\) && auth\.user\(\)\)\) \{ bellStop\(\); return Promise\.resolve\(null\); \}/);
  assert.match(S, /const kick = \(\) => \{ if \(kicked\) return; if \(!auth\.user\(\)\) return;/);
  assert.match(S, /async signOut\(\) \{ explicitSignOut = true; reauthClear\(\); stopSignedInPollers\(\);/);
  assert.ok((S.match(/stopSignedInPollers\(\);/g) || []).length >= 3);
  const I = read('public/inbox.js');
  assert.match(I, /setInterval\(function \(\) \{ if \(signedIn\(\) &&/);
});
console.log(`r91-anon-denied: ${n} checks passed`);
