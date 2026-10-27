#!/usr/bin/env node
// R40 optional invitation passcode (SQL 0289). Static checks always (guest page, studio, store-api, SQL / APPLY shape).
// A headless-Chromium run follows when Playwright is available (`playwright`, or HELM_PLAYWRIGHT=<path to playwright-core>);
// it is skipped, not failed, without it. The browser run uses a local static server on port 4971, blocks EVERY
// non-localhost request and answers Supabase calls from a stub that checks the passcode proof header like the server.
// HELM_R40_SHOTS=<dir> also saves the gate screenshots (mobile, two themes) + the studio card there.
import { readFileSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const invite = read('public/invite.html'), studio = read('public/invite-studio.html'), store = read('public/store-api.js');
const sql = read('supabase/migrations/0289_invite_passcode.sql');

t('guest page: a passcode box on the cover, hidden unless the server says the invitation needs one', () => {
  assert.match(invite, /<form id="passForm" class="pass-form" novalidate hidden>/);
  assert.match(invite, /<input id="passIn" type="text" maxlength="40" autocomplete="off" autocapitalize="none"/);
  assert.match(invite, /if\(BPStore\.sites\.isPasscodeError&&BPStore\.sites\.isPasscodeError\(e\)\)\{/);
  const gate = invite.slice(invite.indexOf('async function showLocked('), invite.indexOf('async function submitPass('));
  assert.match(gate, /\$\("#coverNames"\)\.textContent="You're invited";/);
  assert.match(gate, /Please enter the passcode your host shared with you\./);
  assert.match(gate, /HX\.has\(tpl\)/, 'the theme comes from the server (public_invite_info), validated against the 11 keys');
  assert.doesNotMatch(gate, /innerHTML|insertAdjacentHTML/, 'gate text set with textContent only');
  assert.match(gate, /\$\("#page"\)\.replaceChildren\(\)/, 'nothing from an earlier render stays in the page');
  assert.match(invite, /\$\("#passForm"\)\.hidden=true; \$\("#openBtn"\)\.hidden=false;/, 'the normal cover once unlocked');
});
t('guest page: the proof is remembered on this device until it expires, sent with every guest call', () => {
  assert.match(invite, /const passKey=\(\)=>"helm-pass:"\+getSlug\(\);/);
  assert.match(invite, /Number\(String\(o\.t\)\.split\("\."\)\[1\]\)\*1000>Date\.now\(\)/, 'an expired proof is not used');
  for (const re of [/BPStore\.sites\.public\(slug,PASS\)/, /BPStore\.sites\.publicInfo\(slug,PASS\)/, /BPStore\.sites\.reveal\(slug,tok,PASS\)/,
    /BPStore\.sites\.rsvp\(getSlug\(\),f,PASS\)/, /BPStore\.sites\.mediaUrls\(need,undefined,\(site&&site\.slug\)\|\|getSlug\(\),PASS\)/]) assert.match(invite, re);
  assert.match(invite, /const had=!!PASS; clearPass\(\); await showLocked\(slug, had\?"Please enter the passcode again - the host changed it\.":""\)/);
  assert.match(invite, /if\(r&&r\.reason==="passcode"\)\{ clearPass\(\); showLocked\(getSlug\(\),""\); return; \}/);
  // the studio live preview never asks (it returns before load() and renders the posted draft)
  assert.match(invite, /if\(new URLSearchParams\(location\.search\)\.get\("preview"\)==="1"\)\{ document\.documentElement\.classList\.add\("pv"\);[^\n]*return; \}/);
});
t('guest page: link preview (OG) stays generic', () => {
  const head = invite.slice(0, invite.indexOf('</head>'));
  assert.match(head, /<meta property="og:title" content="You're invited">/);
  assert.match(head, /<meta property="og:description" content="Tap to open your invitation\.">/);
});
t('store-api: the proof travels in x-helm-invite-pass on a session-less guest client; studio RPCs', () => {
  assert.match(store, /const INVITE_PASS_RE = \/\^p1\\\.\[0-9\]\{9,11\}\\\.\[0-9a-f\]\{64\}\$\/;/);
  assert.match(store, /if \(pass\) headers\["x-helm-invite-pass"\] = pass;/);
  assert.match(store, /guestRpcClient\(slug, pass\)\.rpc\("public_event_site"/);
  assert.match(store, /guestRpcClient\(slug, pass\)\.rpc\("public_invite_info"/);
  assert.match(store, /guestRpcClient\(slug, pass\)\.rpc\("public_invite_rsvp"/);
  assert.match(store, /guestRpcClient\(slug, pass\)\.rpc\("public_invite_reveal"/);
  assert.match(store, /guestMediaClient\(slug, pass\) \|\| supa/);
  assert.match(store, /supa\.rpc\("public_invite_unlock", \{ p_slug:/);
  assert.match(store, /passcodeState: \(siteId\) => rpc\("event_site_passcode_state"/);
  assert.match(store, /setPasscode: \(siteId, on, code\) => rpc\("event_site_set_passcode"/);
});
t('studio: OFF by default, one-line explanation, 4-20 characters, applied on Save / Publish, never read back', () => {
  assert.match(studio, /<label class="ish-opt"><input type="checkbox" id="f_passOn"> Ask guests for a passcode \(optional\)<\/label>/);
  assert.doesNotMatch(studio, /id="f_passOn" checked/);
  assert.match(studio, /Share it with your guests along with the link\./);
  assert.match(studio, /<input id="f_pass" type="text" maxlength="20"/);
  assert.match(studio, /if\(code&&\(code\.length<4\|\|code\.length>20\)\) return "The passcode must be 4 to 20 characters\.";/);
  assert.match(studio, /const bad=inputProblem\(gather\(\)\)\|\|passProblem\(\);/);
  assert.match(studio, /const pc=publish\?await applyPass\(\):"";/, 'the passcode is in place before the link goes live');
  assert.ok(studio.indexOf('const pc=publish?await applyPass():"";') < studio.indexOf('BPStore.sites.publish(site.id)'));
  assert.match(studio, /if\(PASS_STATE==="missing"\)\{ box\.hidden=true; return; \}/, 'not offered before 0289 is installed');
  const g = studio.slice(studio.indexOf('function gather(){'), studio.indexOf('function preview(){'));
  assert.doesNotMatch(g, /f_pass/, 'the passcode is never part of the saved site data (or the preview)');
});
t('SQL 0289: additive, re-runnable, ASCII, hash only, server-signed proof, rate limits incl. the noip bucket', () => {
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(sql), 'ASCII');
  assert.doesNotMatch(sql, /^\s*(drop\s+(table|trigger|policy|column)|truncate|delete\s+from|alter\s+table\s+\S+\s+drop)\b/im);
  assert.doesNotMatch(sql, /create\s+(temp|temporary)\s+table/i);
  assert.match(sql, /raise exception 'STOP 0289: apply 0284 \(invitation RSVP \+ privacy\) first'/);
  assert.match(sql, /extensions\.crypt\(v_code, extensions\.gen_salt\('bf', 8\)\)/);
  assert.match(sql, /extensions\.hmac\(s\.id::text \|\| '\.' \|\| v_exp::text, k\.secret, 'sha256'\)/);
  assert.match(sql, /h ->> 'x-helm-invite-pass'/);
  assert.match(sql, /v_ipb := case when v_ip is null then 'inv_pass\.noip' else 'inv_pass\.ip' end; v_ipk := coalesce\(v_ip, 'noip'\);/);
  assert.match(sql, /public\._r40_full\(v_ipb, v_ipk, 900, 10\)/);
  assert.match(sql, /public\._r40_full\('inv_pass\.site', s\.id::text, 3600, 100\)/);
  assert.ok(sql.indexOf("_r40_full(v_ipb") < sql.indexOf('extensions.crypt(v_code, k.pass_hash)'), 'limits before the hash is checked');
  assert.match(sql, /secret = encode\(extensions\.gen_random_bytes\(32\), 'hex'\), version = version \+ 1/, 'a new passcode = a new secret');
  for (const f of ['public_event_site', 'public_invite_info', 'public_invite_rsvp', 'public_invite_reveal'])
    assert.match(sql, new RegExp("\\('" + f + "', '"), f + ' wrapped');
  assert.match(sql, /raise exception 'This invitation needs a passcode' using errcode = 'P0001', hint = 'passcode';/);
  assert.match(sql, /and public\._r40_pass_ok\(s\.id\) \/\* r40-passcode-0289 \*\//, 'photo read check');
  assert.match(read('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0289_invite_passcode\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /^run "r40-invite-passcode-0289" /m);
  const apply = read('supabase/APPLY-0289.sql');
  assert.ok(apply.includes(sql.replace(/\s*$/, '\n')), 'APPLY-0289 carries the migration verbatim');
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(apply), 'APPLY ASCII');
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /-- VERIFY \(every row must say ok = true\)/);
  assert.match(apply, /raise exception 'STOP: apply APPLY-0284\.sql/);
  for (const rel of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(read(rel), /'0284', '0289'\]/, rel);
});

// ---------------------------------------------------------------------------------------------------------------------
let pw = null;
try { pw = await import('playwright'); } catch (e) {
  if (process.env.HELM_PLAYWRIGHT) { try { pw = await import(join(resolve(process.env.HELM_PLAYWRIGHT), 'index.mjs')); } catch (e2) { pw = null; } }
}
if (!pw || !pw.chromium) { console.log('  - headless browser checks skipped (playwright not installed)'); console.log(`r40-passcode: ${n} passed`); process.exit(0); }

const PUB = join(ROOT, 'public'), PORT = 4971, BASE = 'http://127.0.0.1:' + PORT;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  let u = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  if (/^\/i\/[^/]+$/.test(u)) u = '/invite.html';
  const f = join(PUB, u);
  if (!f.startsWith(PUB)) { r.writeHead(403); return r.end(); }
  try { const b = readFileSync(f); r.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); r.end(b); }
  catch (e) { r.writeHead(404); r.end(); }
});
await new Promise((ok, no) => { srv.once('error', no); srv.listen(PORT, '127.0.0.1', ok); });

// the stub "server": one locked site (the passcode is "Rose 2026"), one open site
const SLUG = 'ayla-sam-0123456789abcdef', OPEN = 'maya-0123456789abcdef';
let VALID = 'p1.4102444800.' + 'ab'.repeat(32);
const NEW_VALID = 'p1.4102444800.' + 'cd'.repeat(32);
const PRIVATE = { names: 'Ayla & Sam', headline: 'are getting married', date: '2026-12-28', time: '18:30', venue: 'The Grand Palm', address: '12 Lake Road, Hyderabad',
  host: 'Rao family', hostPhone: '+91 98765 43210', country: 'IN', schedule: [{ time: '7 PM', label: 'Sangeet' }], rsvpForm: true, rsvpContact: true };
const SECRET_WORDS = ['Ayla', 'Grand Palm', 'Lake Road', '98765', 'Sangeet', 'Rao family', 'Studio A'];
const blocked = new Set(), errors = [], calls = [];
let THEME = 'gala';
async function stub(r) {
  const req = r.request(), u = new URL(req.url());
  if (u.hostname === '127.0.0.1') return r.continue();
  if (!u.hostname.endsWith('.supabase.co')) { blocked.add(u.hostname); return r.abort(); }   // never reaches the network
  const H = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-range': '0-0/1' };
  const J = (o, st) => r.fulfill({ status: st || 200, contentType: 'application/json', headers: H, body: JSON.stringify(o) });
  if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: H, body: '' });
  const fn = (/\/rest\/v1\/rpc\/(\w+)/.exec(u.pathname) || [])[1];
  if (u.pathname === '/auth/v1/user') return J(STUDIO_USER);
  if (!fn) return STUDIO_TABLE(r, u, J);
  const body = (() => { try { return JSON.parse(req.postData() || '{}'); } catch (e) { return {}; } })();
  const pass = req.headers()['x-helm-invite-pass'] || '';
  calls.push({ fn, pass, slug: body.p_slug });
  const locked = body.p_slug === SLUG && pass !== VALID;
  if (fn === 'public_event_site') {
    if (body.p_slug === OPEN) return J([{ event_type: 'birthday', template: 'jubilee', title: 'Maya', data: { names: 'Maya turns 30', venue: 'Skyline Rooftop', country: 'IN' } }]);
    if (locked) return J({ code: 'P0001', message: 'This invitation needs a passcode', hint: 'passcode', details: null }, 400);
    return J([{ event_type: 'wedding', template: THEME, title: 'Ayla & Sam', data: PRIVATE }]);
  }
  if (fn === 'public_invite_info') return J(locked ? { state: 'live', locked: true, template: THEME } : { state: 'live', studio: 'Studio A' });
  if (fn === 'public_invite_unlock') {
    const c = String(body.p_code || '').trim().toLowerCase();
    return J(c === 'rose 2026' ? { ok: true, token: VALID, expires_at: '2100-01-01T00:00:00Z' }
      : { ok: false, reason: 'wrong', message: "That passcode didn't work. Please check it and try again." });
  }
  if (fn === 'public_invite_rsvp') return J(locked ? { ok: false, reason: 'passcode', message: 'Please enter the passcode first.' } : { ok: true, token: 'a'.repeat(64) });
  if (fn === 'public_invite_reveal') return J(locked ? { ok: false, reason: 'passcode' } : { ok: false });
  return STUDIO_RPC(fn, body, J);
}

// ---- the studio stubs (a signed-in admin of "Studio A", one confirmed event, one published site) ----
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ORG = 'a0000000-0000-4000-8000-000000000001', Q = 'a0000000-0000-4000-8000-00000000da01';
const JWT = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: UID, role: 'authenticated', exp: 4102444800, aud: 'authenticated', email: 'owner@studio.test', aal: 'aal1' }) + '.sig';
const STUDIO_USER = { id: UID, aud: 'authenticated', role: 'authenticated', email: 'owner@studio.test', user_metadata: {}, app_metadata: {} };
const SESSION = { access_token: JWT, refresh_token: 'rrrrrrrr', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, user: STUDIO_USER };
const QUOTE = { id: Q, org_id: ORG, code: 'WED-001', title: 'Ayla & Sam Wedding', status: 'confirmed', event_type: 'Wedding', event_date: '2026-12-28', client: { name: 'Ayla Rao' }, pricing: {}, current_version: 1 };
const SITE = { id: '11111111-1111-4111-8111-111111111111', org_id: ORG, quote_id: Q, event_type: 'wedding', template: 'gala', slug: SLUG, status: 'published',
  published_at: '2026-10-20T10:00:00Z', title: 'Ayla & Sam', data: { names: 'Ayla & Sam', venue: 'The Grand Palm', country: 'IN' }, private_data: {} };
let PASS_STATE = { on: false, set: false };
function STUDIO_RPC(fn, body, J) {
  if (fn === 'event_site_passcode_state') return J(PASS_STATE);
  if (fn === 'event_site_set_passcode') {
    const code = body.p_code;
    if (body.p_on && code != null && (String(code).trim().length < 4 || String(code).trim().length > 20)) return J({ code: '22023', message: 'The passcode must be 4 to 20 characters.' }, 400);
    PASS_STATE = { on: !!body.p_on, set: PASS_STATE.set || code != null, changed_at: '2026-10-27T10:00:00Z' };
    return J(PASS_STATE);
  }
  const R = { user_role: 'admin', current_org_id: ORG, has_area: true, event_site_rsvp_list: { rows: [], replies: 0, yes: 0, maybe: 0, no: 0, guests_yes: 0 },
    event_site_old_links: [], event_site_live_until: '2027-01-04T18:30:00Z', event_site_send_log: [], my_role_access: [], mfa_status: {} }[fn];
  return J(R === undefined ? null : R);
}
function STUDIO_TABLE(r, u, J) {
  const tbl = (/\/rest\/v1\/(\w+)/.exec(u.pathname) || [])[1], one = /vnd\.pgrst\.object/.test(r.request().headers()['accept'] || '');
  if (r.request().method() === 'PATCH') { calls.push({ fn: 'PATCH ' + tbl, body: r.request().postData() }); return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' }, body: '' }); }
  if (tbl === 'profiles') { const p = { id: UID, email: 'owner@studio.test', role: 'admin', org_id: ORG, must_change_password: false, full_name: 'Owner' }; return J(one ? p : [p]); }
  if (tbl === 'organizations') { const o = { id: ORG, name: 'Studio A', public_slug: 'studio-a', country: 'IN', timezone: 'Asia/Kolkata', currency: 'INR' }; return J(one ? o : [o]); }
  if (tbl === 'quotes') return J(one ? QUOTE : [QUOTE]);
  if (tbl === 'event_sites') return J(one ? SITE : [SITE]);
  return J(one ? null : []);
}

const SHOTS = process.env.HELM_R40_SHOTS || '';
const br = await pw.chromium.launch();
const MOB = { width: 390, height: 844 };
async function guestPage(viewport) {
  const ctx = await br.newContext({ viewport: viewport || MOB, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.route('**/*', stub);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|status of 400/.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
}
const pageText = (page) => page.evaluate(() => document.body.innerText + ' ' + document.getElementById('page').innerHTML + ' ' + document.title);

try {
  // 1) locked: only the theme + "You're invited" + the passcode box; nothing private anywhere in the DOM
  for (const theme of ['gala', 'mehndi']) {
    THEME = theme; calls.length = 0;
    const { ctx, page } = await guestPage();
    await page.goto(BASE + '/i/' + SLUG, { waitUntil: 'load' });
    await page.waitForSelector('#passForm', { state: 'visible', timeout: 15000 });
    const txt = await pageText(page);
    for (const w of SECRET_WORDS) assert.ok(!txt.includes(w), theme + ': "' + w + '" must not be on the locked page');
    assert.equal(await page.evaluate(() => document.body.className), 't-' + theme, 'the gate wears the theme');
    assert.equal((await page.textContent('#coverNames')).trim(), "You're invited");
    assert.ok(await page.isHidden('#openBtn') && await page.isHidden('#shareBtm') && await page.isHidden('#fabs'));
    assert.ok(calls.some((c) => c.fn === 'public_event_site' && !c.pass), 'asked the server first, without a proof');
    const box = await page.locator('#passIn').boundingBox(); assert.ok(box && box.width >= 280 && box.height >= 48, 'a big enough box on a phone');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll on a phone');
    if (SHOTS) { await page.waitForTimeout(1100); await page.screenshot({ path: join(SHOTS, `passcode-gate-${theme}-mobile.png`) }); }
    if (theme === 'gala') {
      // wrong passcode: a friendly generic line, still nothing private
      await page.fill('#passIn', 'tulip'); await page.click('#passBtn');
      await page.waitForFunction(() => /didn't work/.test(document.getElementById('passSt').textContent));
      if (SHOTS) await page.screenshot({ path: join(SHOTS, 'passcode-wrong-gala-mobile.png') });
      for (const w of SECRET_WORDS) assert.ok(!(await pageText(page)).includes(w), 'wrong passcode: ' + w);
      // right passcode (other capitals / spaces): the invitation opens straight away, the proof is kept on the phone
      await page.fill('#passIn', '  ROSE 2026 '); await page.click('#passBtn');
      await page.waitForFunction(() => document.getElementById('cover').classList.contains('gone'), null, { timeout: 15000 });
      await page.waitForTimeout(400);
      const open = await page.textContent('#page');
      assert.ok(open.includes('Ayla & Sam') && open.includes('The Grand Palm') && open.includes('Sangeet'), 'unlocked: the full invitation');
      const kept = await page.evaluate((s) => localStorage.getItem('helm-pass:' + s), SLUG);
      assert.equal(JSON.parse(kept).t, VALID, 'the proof (not the passcode) is remembered');
      assert.ok(!kept.toLowerCase().includes('rose'), 'the passcode itself is never stored');
      assert.ok(calls.filter((c) => /^public_(event_site|invite_info)$/.test(c.fn) && c.pass === VALID).length >= 2, 'later calls carry the proof header');
      if (SHOTS) { await page.waitForTimeout(1000); await page.evaluate(() => document.querySelectorAll('.rv').forEach((e) => e.classList.add('in'))); await page.waitForTimeout(1000); await page.screenshot({ path: join(SHOTS, 'passcode-unlocked-gala-mobile.png') }); }
      // the same phone later: no passcode asked again
      await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#openBtn', { state: 'visible', timeout: 15000 });
      assert.ok(await page.isHidden('#passForm'), 'remembered on this device');
      // the host changes the passcode: the old proof stops working, the gate comes back with a plain note
      VALID = NEW_VALID;
      await page.reload({ waitUntil: 'load' }); await page.waitForSelector('#passForm', { state: 'visible', timeout: 15000 });
      assert.match(await page.textContent('#passSt'), /the host changed it/);
      assert.equal(await page.evaluate((s) => localStorage.getItem('helm-pass:' + s), SLUG), null, 'the stale proof is dropped');
      VALID = 'p1.4102444800.' + 'ab'.repeat(32);
    }
    await ctx.close();
  }
  console.log('  ✓ browser: locked gate shows only the theme + "You\'re invited" (gala, mehndi on a phone); wrong / right passcode; remembered; a new passcode asks again');

  // 2) a site without a passcode: exactly the old cover (Open Invitation), no passcode box
  { const { ctx, page } = await guestPage();
    await page.goto(BASE + '/i/' + OPEN, { waitUntil: 'load' }); await page.waitForSelector('#openBtn', { state: 'visible', timeout: 15000 });
    assert.ok(await page.isHidden('#passForm')); assert.equal((await page.textContent('#coverNames')).trim(), 'Maya turns 30');
    await ctx.close(); }
  console.log('  ✓ browser: an invitation without a passcode opens exactly as before');

  // 3) the studio live preview never asks for the passcode
  { const { ctx, page } = await guestPage({ width: 1200, height: 900 });
    await page.goto(BASE + '/invite.html?preview=1', { waitUntil: 'load' });
    await page.evaluate((d) => window.postMessage({ type: 'helm-preview', site: { template: 'gala', event_type: 'wedding', title: 'Ayla & Sam', data: d } }, location.origin), PRIVATE);
    await page.waitForFunction(() => /Grand Palm/.test(document.getElementById('page').textContent), null, { timeout: 10000 });
    assert.ok(await page.isHidden('#passForm'));
    await ctx.close(); }
  console.log('  ✓ browser: the studio live preview bypasses the gate');

  // 4) the studio: OFF by default, switch on -> the field + the one-line explanation; short passcode refused; saved -> on
  { const ctx = await br.newContext({ viewport: { width: 1366, height: 1000 } });
    await ctx.addInitScript(([s]) => { try { for (const k of ['sb-xizehqgeyjcfpzrdymly-auth-token', 'sb-nqltzgiwznphugcfhmbm-auth-token']) localStorage.setItem(k, s); } catch (e) {} }, [JSON.stringify(SESSION)]);
    await ctx.route('**/*', stub);
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push('studio pageerror: ' + e.message));
    await page.goto(BASE + '/invite-studio.html?quote=' + Q, { waitUntil: 'load' });
    await page.waitForSelector('#passBox', { state: 'visible', timeout: 20000 });
    assert.equal(await page.isChecked('#f_passOn'), false, 'off by default');
    assert.ok(await page.isHidden('#passWrap'));
    await page.check('#f_passOn');
    assert.ok(await page.isVisible('#f_pass') && /Share it with your guests along with the link\./.test(await page.textContent('#passHelp')));
    await page.fill('#f_pass', 'abc'); await page.click('#saveBtn');
    await page.waitForFunction(() => /4 to 20 characters/.test(document.getElementById('msg').textContent));
    assert.ok(!calls.some((c) => c.fn === 'event_site_set_passcode'), 'nothing sent for a too-short passcode');
    await page.fill('#f_pass', 'Rose 2026'); await page.click('#saveBtn');
    await page.waitForFunction(() => /passcode is on/i.test(document.getElementById('msg').textContent), null, { timeout: 10000 });
    const set = calls.filter((c) => c.fn === 'event_site_set_passcode');
    assert.equal(set.length, 1);
    const patch = calls.filter((c) => c.fn === 'PATCH event_sites').map((c) => c.body).join(' ');
    assert.ok(!/rose/i.test(patch), 'the passcode is not in the saved site data');
    assert.equal(await page.inputValue('#f_pass'), '', 'the field is emptied - the passcode is never shown again');
    assert.match(await page.textContent('#passState'), /A passcode is on/);
    if (SHOTS) await page.locator('#rsvpCard').screenshot({ path: join(SHOTS, 'studio-passcode-on.png') });
    await ctx.close(); }
  console.log('  ✓ browser: studio - off by default, explanation, 4-20 check, saved through the RPC only, never shown again');

  assert.deepEqual(errors, [], 'no page errors');
  assert.ok([...blocked].every((h) => h !== '127.0.0.1'), 'only non-localhost hosts were blocked');
  console.log('  ✓ browser: no page errors; blocked non-localhost hosts: ' + ([...blocked].join(', ') || 'none'));
} finally { await br.close(); srv.close(); }
console.log(`r40-passcode: ${n} static + browser checks passed`);
