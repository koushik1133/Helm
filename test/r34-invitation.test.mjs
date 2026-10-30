#!/usr/bin/env node
// R34 invitation site: RSVP form / phone + WhatsApp / both (per site), address privacy, Turn off link / Make new link,
// generic link preview, footer branding, 6 new themes, SQL 0284 shape. Static + vm checks (no browser, no network).
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const ctx = { window: {} }; ctx.globalThis = ctx; vm.runInNewContext(read('public/invite-extras.js'), ctx);
const X = ctx.window.HelmInviteX;
const invite = read('public/invite.html'), studio = read('public/invite-studio.html'), store = read('public/store-api.js');
const sql = read('supabase/migrations/0284_invite_rsvp_privacy.sql');

t('themes: 11 keys (5 old first, 6 new), the same list as the database CHECK', () => {
  assert.deepEqual([...X.KEYS], ['eternal', 'promise', 'confetti', 'summit', 'soiree', 'shubh', 'mehndi', 'solitaire', 'jubilee', 'gala', 'linen']);
  const chk = /check \(template in \(([^)]*)\)\)/.exec(sql)[1].match(/'([a-z]+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual([...chk].sort(), [...X.KEYS].sort());
  for (const k of X.KEYS.slice(5)) {
    assert.match(invite, new RegExp('body\\.t-' + k + '\\{--accent:'), k + ' theme CSS');
    assert.match(studio, new RegExp('\\.sw\\.' + k + '\\{'), k + ' studio swatch');
  }
  assert.match(invite, /document\.body\.className="t-"\+\(\(HX\?HX\.has\(site\.template\)/);
});
t('settings: a site saved before r34 keeps today\'s page (phone buttons, full address, Helm footer, no form)', () => {
  const s = X.settings({ names: 'A', hostPhone: '+91 98765 43210', address: 'x' });
  assert.deepEqual({ ...s }, { rsvpForm: false, rsvpContact: true, addressMode: 'full', helmBrand: true });
  assert.deepEqual({ ...X.settings({ rsvpForm: true, rsvpContact: false, addressMode: 'after_rsvp', hideHelmBrand: true }) },
    { rsvpForm: true, rsvpContact: false, addressMode: 'after_rsvp', helmBrand: false });
  assert.equal(X.settings({ addressMode: 'weird' }).addressMode, 'full');
  assert.equal(X.settings(null).rsvpContact, true);
});
t('studio: one clear setting - phone & WhatsApp (default) / RSVP form / both; NEW sites start exactly like before', () => {
  for (const v of ['form', 'contact', 'both']) assert.match(studio, new RegExp('name="f_rsvpMode" id="f_rsvpMode_' + v + '" value="' + v + '"'));
  assert.match(studio, /rsvpForm:rsvpMode\(\)!=="contact", rsvpContact:rsvpMode\(\)!=="form", addressMode:addrMode\(\)/);
  assert.match(studio, /prefillFromQuote\(\); applySettings\(\{\}\);/, 'a new site gets the defaults (= today)');
  assert.doesNotMatch(studio, /applySettings\(\{rsvpForm:true/);
  assert.match(studio, /id="f_rsvpMode_contact" value="contact"><span>Phone &amp; WhatsApp \(default\)/);
  assert.match(studio, /id="f_addrMode_full" value="full"><span>Full address and map \(default\)/);
  assert.match(studio, /<span>RSVP form \(optional\)<small>Guests tell you if they're coming \(Yes \/ Maybe \/ No\) and how many people\./);
  assert.match(studio, /hide\.disabled=noForm\|\|readOnly;/, 'hiding the address is only offered with the RSVP form');
  assert.ok(studio.indexOf('id="f_rsvpMode_contact"') < studio.indexOf('id="f_rsvpMode_form"'), 'default listed first');
  const d = X.settings({}); assert.equal(d.rsvpForm, false); assert.equal(d.rsvpContact, true); assert.equal(d.addressMode, 'full');
  assert.match(studio, /const mode=S\.rsvpForm&&S\.rsvpContact\?"both":S\.rsvpForm\?"form":"contact";/);
  assert.match(studio, /Object\.assign\(\{\}, s\.data\|\|\{\}, \(s\.private_data&&typeof s\.private_data==="object"\)\?s\.private_data:\{\}\)/, 'private phone / address come back into the form');
  assert.match(studio, /needs the RSVP form - otherwise guests can never see the address/);
});
t('guest page: phone buttons only when the site allows them; the form is a slot filled with DOM nodes', () => {
  assert.match(invite, /const raw=S\.rsvpContact&&typeof d\.hostPhone==="string"\?d\.hostPhone:""/);
  assert.match(invite, /\(S\.rsvpForm\?`<div id="rsvpSlot"><\/div>`/);
  assert.match(invite, /if\(!S\.rsvpContact\) delete d\.hostPhone;/);
  const mount = invite.slice(invite.indexOf('function mountRsvp('), invite.indexOf('function rerender('));
  assert.doesNotMatch(mount, /innerHTML|insertAdjacentHTML/, 'no HTML sinks in the form');
  assert.match(invite, /if\(k==="text"\) n\.textContent=attrs\[k\];/);
  assert.match(mount, /if\(PREVIEW\)\{/, 'the studio preview never sends');
  assert.match(mount, /id:"rsvp_web",tabindex:"-1"/, 'honeypot');
});
t('address privacy: venue + city until the guest replies; the reveal comes only from the server answer', () => {
  assert.match(invite, /if\(S\.addressMode==="after_rsvp"\)\{\s*delete d\.address; delete d\.mapUrl;/);
  assert.match(invite, /The full address and map are shared once you reply Yes or Maybe below\./);
  assert.match(invite, /REVEAL=\(r\.reveal&&typeof r\.reveal==="object"\)\?r\.reveal:null;/);
  assert.match(studio, /after replying Yes or Maybe on the RSVP form they see the full address and map/);
  assert.match(sql, /and p_attending in \('yes', 'maybe'\)/, "a No reply never gets the address");
  assert.match(invite, /const r=await BPStore\.sites\.reveal\(slug,tok\); if\(r&&r\.ok\)\{ REVEAL=r\.reveal\|\|null; REPLY=r\.reply\|\|null; \}/);
  assert.match(invite, /localStorage\.setItem\(tokKey\(\),t\)/);
  assert.equal(X.cityOf('12 Lake Road, Banjara Hills, Hyderabad 500034'), 'Hyderabad');
  assert.equal(X.cityOf('Hyderabad'), '');
});
t('form checks mirror the server limits (name 80, message 500, 1-20 guests, no < >)', () => {
  assert.equal(X.formProblem({ name: 'Ravi', attending: 'yes', guests: '2' }), '');
  assert.equal(X.formProblem({ name: 'Ravi', attending: 'no', guests: '' }), '');
  assert.match(X.formProblem({ name: '', attending: 'yes', guests: 1 }), /name/);
  assert.match(X.formProblem({ name: 'x'.repeat(81), attending: 'yes', guests: 1 }), /80/);
  assert.match(X.formProblem({ name: 'Ravi', attending: 'yes', guests: 1, message: 'm'.repeat(501) }), /500/);
  assert.match(X.formProblem({ name: '<b>', attending: 'yes', guests: 1 }), /< and >/);
  assert.match(X.formProblem({ name: 'Ravi', attending: 'perhaps', guests: 1 }), /Yes, No or Maybe/);
  assert.match(X.formProblem({ name: 'Ravi', attending: 'yes', guests: 21 }), /1 to 20/);
});
t('CSV export: every cell quoted, formula injection neutralised', () => {
  assert.equal(X.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  for (const bad of ['+1', '-2', '@SUM(A1)', '  =1+1', '\tx', '\rx']) assert.ok(X.csvCell(bad).startsWith('"\''), JSON.stringify(bad));
  assert.equal(X.csvCell('Priya'), '"Priya"'); assert.equal(X.csvCell(3), '"3"'); assert.equal(X.csvCell(null), '""');
  assert.equal(X.toCsv([['a', 'b'], ['=c', 'd']]), '"a","b"\r\n"\'=c","d"\r\n');
  assert.match(studio, /new Blob\(\["\\ufeff"\+HX\.toCsv\(out\)\]/);
  const paint = studio.slice(studio.indexOf('function paintReplies('), studio.indexOf('async function loadReplies('));
  assert.doesNotMatch(paint, /innerHTML/, 'the replies list is built with textContent');
});
t('links: Turn off link (unpublish) + Make new link; old links say "moved", off links say "not available"', () => {
  assert.match(studio, /<button class="btn" id="unpubBtn" type="button" hidden>Turn off link<\/button>/);
  assert.match(studio, /<button class="btn" id="newLinkBtn" type="button" hidden>Make new link<\/button>/);
  assert.match(studio, /BPStore\.sites\.newLink\(site\.id\)/);
  assert.match(invite, /<h1>This invitation has moved<\/h1>/);
  assert.match(invite, /Please ask the host for the new link\./);
  assert.match(invite, /\$\(st==="moved"\?"#moved":st==="off"\?"#turnedOff":"#missing"\)\.hidden=false;/);
  assert.match(store, /rpc\("event_site_new_link", \{ p_site: siteId \}\)/);
  assert.match(store, /supa\.rpc\("public_invite_info", \{ p_slug:/);
});
t('link preview: generic OG tags only (no names / address / phone / date), image present', () => {
  const head = invite.slice(0, invite.indexOf('</head>'));
  assert.match(head, /<meta property="og:title" content="You're invited">/);
  assert.match(head, /<meta property="og:image" content="https:\/\/www\.helm\.events\/invite-og\.png">/);
  assert.match(head, /<meta name="twitter:card" content="summary_large_image">/);
  const og = [...head.matchAll(/<meta (?:property|name)="(?:og|twitter):[^"]+" content="([^"]*)"/g)].map((m) => m[1]).join(' ');
  assert.doesNotMatch(og, /\$\{|names|address|phone|\d{4}-\d{2}/);
  assert.ok(existsSync(join(ROOT, 'public/invite-og.png')) && statSync(join(ROOT, 'public/invite-og.png')).size < 400 * 1024);
});
t('footer: "Designed by <studio> · Made with Helm Studios", studio name escaped, Helm part can be hidden per site', () => {
  assert.match(invite, /\$\{studio\?`Designed by <b>\$\{esc\(studio\)\}<\/b>`:""\}/);
  assert.match(invite, /\$\{brand\?`Made with <a href="\/" target="_blank" rel="noopener">Helm Studios<\/a>`:""\}/);
  assert.match(studio, /hideHelmBrand:!\$\("#f_helmBrand"\)\.checked/);
});
t('scripts: shared helper loaded on both pages; store-api v296', () => {
  for (const h of [invite, studio]) { assert.match(h, /invite-extras\.js\?v=1"><\/script>/); assert.match(h, /store-api\.js\?v=311/); }
});
t('SQL 0284: additive, re-runnable, ASCII; anon RPCs rate-limited via cf-connecting-ip helpers', () => {
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(sql), 'ASCII');
  assert.doesNotMatch(sql, /^\s*(drop\s+(table|trigger|function|policy)|truncate|delete\s+from)\b/im);
  assert.doesNotMatch(sql, /create\s+(temp|temporary)\s+table/i);
  assert.match(sql, /public\._lv261_req\(\) ->> 'ip'/);
  assert.match(sql, /rate_hit\(case when v_ip is null then 'inv_rsvp\.noip' else 'inv_rsvp\.ip' end, coalesce\(v_ip, 'noip'\), 3600,\s*case when v_ip is null then 20 else 30 end\)/);
  assert.ok(sql.indexOf("'inv_rsvp.noip'") > sql.indexOf("field', 'guests'"), 'network limit only after validation');
  assert.match(sql, /rate_hit\('inv_rsvp\.site', s\.id::text, 86400, 400\)/);
  assert.match(sql, /perform 1 from public\.public_event_site\(p_slug\);/, 'same gates as opening the invitation');
  assert.match(read('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0284_invite_rsvp_privacy\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /^run "r34-invite-0284" /m);
  const apply = read('supabase/APPLY-0284.sql');
  assert.ok(apply.includes(sql.replace(/\s*$/, '\n')), 'APPLY-0284 carries the migration verbatim');
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /-- VERIFY \(every row must say ok = true\)/);
});
console.log(`r34-invitation: ${n} passed`);
