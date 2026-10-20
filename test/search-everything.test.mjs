// search-everything.test.mjs - both searches are complete and never show a dead link.
//  * search-catalog.js covers every Control Center section in control-split.js, and every card
//    title in control.html (plus the cards other scripts add), with deep links (?cs=<text>#hash)
//  * pages respect role access; the Integrations page only appears when HELM_FEATURES.integrationsPage
//  * synonyms: users / team / staff login / invite / 2fa / otp / pin / privacy / theme / gst / tax /
//    coupon / logo / user details / control center land on the right thing
//  * palette (studio-search.js) shows "Pages & settings" rows, account items, Invite user / New quote
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const CAT = require('../public/search-catalog.js');
const SSC = require('../public/settings-search-core.js');
const SPLIT = read('public/control-split.js');
const CTRL = read('public/control.html');
const SS = read('public/studio-search.js');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const norm = (s) => SSC.normalize(String(s).replace(/&amp;/g, '&').replace(/✦/g, ''));

// fake BPStore.auth
const auth = (role, views = []) => ({ role: async () => role, canView: async (a) => role === 'admin' || views.includes(a) });
const texts = async (a, feat = {}) => (await CAT.entriesFor(a, feat));

await t('every control-split section has a catalog section and settings', () => {
  const block = SPLIT.slice(SPLIT.indexOf('var SECTIONS=['), SPLIT.indexOf('];', SPLIT.indexOf('var SECTIONS=[')));
  const keys = [...block.matchAll(/\{key:"(\w+)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 17, '17 Control Center sections');   // r24 (0269): + Automations
  assert.deepEqual(CAT.SECTIONS.map((s) => s.key).sort(), keys.slice().sort());
  const hashes = Object.fromEntries([...block.matchAll(/\{key:"(\w+)".*?hash:"(#[\w-]+)"/g)].map((m) => [m[1], m[2]]));
  for (const s of CAT.SECTIONS) {
    assert.equal(s.hash, hashes[s.key], 'same hash as control-split for ' + s.key);
    assert.ok(CAT.SETTINGS.some((x) => x[0] === s.key), 'settings indexed for ' + s.key);
  }
  for (const x of CAT.SETTINGS) assert.ok(CAT.SECTIONS.some((s) => s.key === x[0]), 'known section ' + x[0]);
});

await t('every card title and labelled field in control.html is in the catalog', () => {
  const app = CTRL.slice(CTRL.indexOf('id="pane-pricing"'), CTRL.indexOf('id="mp_title"'));
  const all = CAT.SETTINGS.map((x) => norm(x[1]));
  const has = (h) => all.some((x) => x === h || x.startsWith(h) || h.startsWith(x));
  const h3 = [...CTRL.matchAll(/<h3[^>]*>([^<]+)/g)].map((m) => norm(m[1])).filter((h) => h && !/^(edit profile|signin)$/.test(h));
  assert.ok(h3.length >= 28);
  for (const h of h3) assert.ok(has(h), 'catalog misses card: ' + h);
  const btns = [...app.matchAll(/<button[^>]*>([^<]{3,60})</g)].map((m) => norm(m[1])).filter((b) => /^(add|import|create|save|reset|forgot)/.test(b));
  const miss = btns.filter((b) => !has(b) && !/^save$/.test(b)); assert.deepEqual(miss, [], 'catalog misses buttons');
  // cards built by other scripts
  for (const h of ['Event reminders', 'Payment reminders', 'Client follow-ups', 'WhatsApp forwarding']) assert.ok(has(norm(h)), h);
});

await t('deep links: control.html?cs=<text>#hash, handled by control-split', () => {
  assert.equal(CAT.settingHref('users', 'Invite by email link'), 'control.html?cs=Invite%20by%20email%20link#users');
  assert.equal(CAT.settingHref('privacy', ''), 'control.html#privacy-pin');
  assert.match(SPLIT, /get\("cs"\)/);
  assert.ok(CTRL.indexOf('search-catalog.js?v=') > 0 && CTRL.indexOf('search-catalog.js?v=') < CTRL.indexOf('control-split.js?v='), 'catalog loads before control-split');
  assert.ok(!/integrations\.html/.test(SPLIT), 'no hard-coded Integrations link in control-split');
});

await t('pages respect role access; Integrations only when the feature is on', async () => {
  const sales = (await texts(auth('sales', ['quotes', 'leads']))).filter((e) => e.kind === 'page').map((e) => e.key);
  // r20 coord (e): the user manual is hidden for now (HELM_FEATURES.manual) - back in search once flipped on
  assert.deepEqual(sales.sort(), ['chat', 'dashboard', 'leads', 'quotes']);
  const salesManual = (await texts(auth('sales', ['quotes', 'leads']), { manual: true })).filter((e) => e.kind === 'page').map((e) => e.key);
  assert.deepEqual(salesManual.sort(), ['chat', 'dashboard', 'leads', 'manual', 'quotes']);
  const salesAll = await texts(auth('sales', ['quotes', 'leads']));
  assert.ok(!salesAll.some((e) => e.kind === 'section' || e.kind === 'setting'), 'no Control Center for sales');
  assert.ok(salesAll.some((e) => e.kind === 'account' && e.id === 'mfa'), 'own account items for everyone');
  const admin = (await texts(auth('admin'))).filter((e) => e.kind === 'page').map((e) => e.key);
  assert.ok(admin.includes('control') && admin.includes('audit'));
  assert.ok(!admin.includes('integrations'), 'Integrations hidden on live');
  const adminOn = (await texts(auth('admin'), { integrationsPage: true })).filter((e) => e.kind === 'page').map((e) => e.key);
  assert.ok(adminOn.includes('integrations'));
  // manager with controls view but not admin: no admin-only sections
  const mgr = await texts(auth('manager', ['controls', 'quotes']));
  const secs = mgr.filter((e) => e.kind === 'section').map((e) => e.sec);
  assert.ok(secs.includes('pricing') && !secs.includes('users') && !secs.includes('access'));
  // every href is an own page
  for (const e of await texts(auth('admin'), { integrationsPage: true })) if (e.href) assert.match(e.href, /^[a-z-]+\.html([?#].*)?$/);
  // a failing gate check hides the page
  const broken = { role: async () => { throw new Error('x'); }, canView: async () => { throw new Error('x'); } };
  assert.deepEqual((await texts(broken)).filter((e) => e.kind === 'page').map((e) => e.key).sort(), ['chat', 'dashboard']);   // r20 coord (e): manual hidden for now
});

await t('synonyms find the right setting', async () => {
  const list = await texts(auth('admin'));
  const top = (q, k = 3) => CAT.rank(q, list, SSC, k).map((e) => e.text);
  const expect = {
    users: /Users & invites|Team members/, team: /Team members|Users & invites/, 'staff login': /Team members|Add user|Users/,
    invite: /Invite/, '2fa': /Two-step/, otp: /Two-step/, pin: /PIN/, privacy: /privacy PIN|Hide amounts/, theme: /Accent colour|Logo/,
    gst: /GST/, tax: /Tax|GST/, coupon: /coupon/i, logo: /Logo/, 'user details': /Users & invites|Team members/, 'control center': /Control Center/,
    password: /password/i, whatsapp: /WhatsApp/, 'sign out other devices': /Sign out other devices/,
  };
  for (const [q, re] of Object.entries(expect)) assert.ok(top(q).some((x) => re.test(x)), q + ' -> ' + top(q).join(' | '));
  assert.equal(top('control center', 1)[0], 'Control Center');
  assert.match(top('user details', 1)[0], /Users & invites/);
  // plain fallback (no core) still works
  assert.ok(CAT.rank('coupon', list, null, 5).some((e) => /Coupons/.test(e.text)));
});

await t('global palette: pages & settings rows, account rows, actions', async () => {
  assert.match(SS, /"search-catalog\.js\?v=" \+ CATALOG_V/);
  assert.match(SS, /"settings-search-core\.js\?v=" \+ SSC_V/);
  assert.match(SS, /HelmAuthUI\.openAccount\(r\.open/);
  globalThis.window = undefined;
  const api = require('../public/studio-search.js');
  const ids = api.ACTIONS.map((a) => a.id);
  for (const id of ['new-quote', 'new-lead', 'new-staff', 'invite-user']) assert.ok(ids.includes(id), id);
  assert.equal(api.ACTIONS.find((a) => a.id === 'new-quote').href, 'quotes.html?hs_act=new');
  assert.deepEqual(api.ACTIONS.find((a) => a.id === 'invite-user').need, [['role', 'admin']]);
  globalThis.HelmSearchCatalog = CAT; globalThis.HelmSettingsSearch = SSC;
  const list = await texts(auth('admin'));
  const rows = api.localHits('user details', list);
  assert.equal(rows[0].kind, 'nav'); assert.match(rows[0].href, /^control\.html.*#users$/);
  const acc = api.localHits('2fa', list);
  assert.ok(acc.some((r) => r.kind === 'account' && r.open && r.open.focus === 'mfa'));
  assert.deepEqual(api.localHits('a', list), [], 'needs 2 letters');
});

console.log(`\n${n} search-everything checks passed`);
