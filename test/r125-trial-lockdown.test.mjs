// r125-trial-lockdown.test.mjs - R125 (owner: in a free trial no link and no message leaves Helm).
//  1  0334 / APPLY: MANIFEST, run-all, begin / commit, STOP guard, VERIFY rows, zero data loss, ASCII
//  2  every public function an outsider can reach is gated; every kept body has no app privilege
//  3  the screens: trial-preview.js loads for a trial only, never in a frame or on a client page; every way out is listed
//  4  wording: the disclaimer states nothing was sent + the private link + how long + WhatsApp or e-mail; one plain page for
//     every dead address; no "copy the link" left in a trial message; terms version moved in both places
//  5  a paid studio: the frame script does nothing on any other address; the new files are never loaded
//  6  the frames: same-origin routes without a token, on vercel.json + server.js + the CSP allow-list
// Static + pure-function checks. Database: tests/db/r125-trial-lockdown-0334.sql. Browser: test/r125-trial-preview.harness.mjs.
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SQL = rd('supabase/migrations/0334_r125_trial_preview_lockdown.sql'), AP = rd('supabase/APPLY-0334.sql'), MAN = rd('supabase/migrations/MANIFEST');
const RUN = rd('scripts/db-test/run-all.sh'), TP = rd('public/trial-preview.js'), FR = rd('public/trial-preview-frame.js'), TL = rd('public/trial-lock.js');
const CSS = rd('public/trial-lock.css'), VJ = JSON.parse(rd('vercel.json')), SRV = rd('server.js'), API = rd('public/store-api.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const require = createRequire(import.meta.url);
global.window = undefined;
const H = require('../public/trial-preview.js');

t('0334: MANIFEST + run-all + APPLY with begin/commit, the 0333 STOP guard and 11 VERIFY rows', () => {
  assert.match(MAN, /forward  supabase\/migrations\/0334_r125_trial_preview_lockdown\.sql/);
  assert.match(RUN, /R125-TRIAL-LOCKDOWN-0334: ALL PASS \\\(104\/104\\\)/);
  assert.match(RUN, /helm\.r125_gate=off/);
  assert.match(AP, /^begin;$/m); assert.match(AP, /^commit;$/m);
  assert.match(SQL, /STOP 0334: 0333 \(R124\) is not applied/);
  const rows = AP.slice(AP.indexOf('-- VERIFY')).match(/^\s+\('\d\d /gm) || [];
  assert.equal(rows.length, 11);
  assert.ok(AP.includes(SQL.trim()), 'APPLY carries the migration body unchanged');
});
t('0334: zero data loss, paste-safe, ASCII', () => {
  const body = SQL.replace(/^--.*$/gm, '');
  assert.doesNotMatch(body, /\bdrop\s+(table|column|policy|function)\b/i);
  assert.doesNotMatch(body, /\btruncate\b/i);
  assert.doesNotMatch(body, /\bcreate\s+temp/i, 'no temp tables in a paste file');
  const del = body.match(/\bdelete\s+from\s+[a-z_.]+/gi) || [];
  assert.deepEqual(del, ['delete from public.client_link_issued'], 'only the audit row of the transient token, same transaction');
  assert.match(body, /c\.kind = 'quote' and c\.token = v_tok/);
  assert.doesNotMatch(SQL, /[^\x00-\x7f]/);
  assert.doesNotMatch(AP, /[^\x00-\x7f]/);
});
t('0334: every link function an outsider can reach is listed', () => {
  for (const f of ['public_get_quote', 'public_get_portal', 'public_portal_extras', 'public_quote_paid_status', 'public_quote_ready', 'public_trial_approval_mode',
    'public_trial_payment_sim', 'trial_test_mode_for_token', 'trial_simulate_payment', 'trial_test_approve', 'trial_test_approve_code', 'create_payment', 'request_otp',
    'verify_and_consent', 'wa_request_otp', 'wa_verify_and_consent', 'public_get_booklet', 'public_get_booklet_image', 'public_booklet_choose', 'public_booklet_otp_request',
    'public_booklet_packages', 'public_booklet_pay_terms', 'public_booklet_studio', 'public_get_proposal', 'public_trial_simulation_for_proposal', 'public_event_site',
    'public_invite_info', 'public_invite_reveal', 'public_invite_rsvp', 'vendor_link_get', 'vendor_link_respond', 'vendor_invoice_submit', 'vendor_invoice_upload',
    'delivery_link_get', 'delivery_link_update']) assert.ok(SQL.includes("('" + f + "',"), f);
  for (const f of ['public_quote_validity', 'public_request_new_quote', 'public_trial_simulation', 'public_trial_sim_payments', 'public_link_opened', 'public_link_viewed',
    'public_link_studio', 'invite_media_guest_read_ok', 'invite_media_on_published_site', 'task_proof_upload_ok', 'vendor_invoice_upload_ok', '_work_token_live', '_r24_enquiry_org',
    '_r29_code_problem', 'my_referral', 'generate_approval_token', 'booklet_share', 'publish_proposal', 'publish_event_site', 'event_site_new_link', 'delivery_link_issue', 'vendor_request_link'])
    assert.ok(SQL.includes("'" + f + "'") && SQL.includes('public.' + f + '('), f);
});
t('0334: storage policies keep working: the four policy functions are not renamed, a sample clone is not refused', () => {
  const b = SQL.slice(SQL.indexOf('-- ---- 3) the ones with their own shape'), SQL.indexOf('-- four functions used BY storage policies'));
  for (const f of ['invite_media_guest_read_ok', 'invite_media_on_published_site', 'task_proof_upload_ok', 'vendor_invoice_upload_ok']) assert.ok(!b.includes("'" + f + "'"), f + ' must not be renamed');
  assert.match(SQL, /if not v_demo and public\._r125_closed\(v_org\) then perform public\._r125_refuse\(\);/);
  assert.match(RUN, /trial-clone-0190-r125-gate/);
});
t('0334: team invitations are not touched', () => { assert.doesNotMatch(SQL.replace(/^--.*$/gm, ''), /invitation_preview|accept_invitation|public\.invitations|invite_email_outbox/); });
t('0334: the dry run always rolls back', () => {
  const b = SQL.slice(SQL.indexOf('create or replace function public.trial_preview_bundle'), SQL.indexOf('-- The test approval for signed-in staff'));
  assert.match(b, /raise exception 'r125 dry run' using errcode = 'R1250';\s+exception\s+when sqlstate 'R1250' then null;\s+when others then v_err/);
  const inner = b.slice(b.indexOf("perform set_config('helm.r125_gate', 'off', true);"), b.indexOf("raise exception 'r125 dry run'"));
  assert.doesNotMatch(inner, /^\s*return\b/m, 'nothing returns from inside the block, so nothing can commit');
});
t('frame + pop-up files: CSP-safe, no HTML strings', () => {
  for (const s of [TP, FR]) { assert.doesNotMatch(s, /innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/); assert.doesNotMatch(s, /\son[a-z]+=/); }
});
t('trial-lock.js loads the pop-up for a trial only, never in a frame or on a client page', () => {
  assert.match(TL, /if \(window\.parent !== window \|\| window\.HELM_TRIAL_PREVIEW/);
  assert.match(TL, /\(t\.status === "trial" \|\| t\.state === "trial" \|\| t\.state === "ended"\)\) previewScript\(\)/);
  assert.match(TL, /s\.src = "\/trial-preview\.js\?v=\d+"/);
  for (const f of readdirSync(new URL('../public/', import.meta.url))) if (/\.html$/.test(f)) assert.doesNotMatch(rd('public/' + f), /src="\/?trial-preview\.js/, f + ' must not load it');
});
t('the disclaimer says nothing was sent, private link, how long, WhatsApp or e-mail', () => {
  const v = { approval: /until 30 days after the event/, booklet: /7 to 180 days \(30 by default\)/, invitation: /until 7 days after the event/, proposal: /until 7 days after the event/,
    crew: /until 7 days after the event, or 60 days/, vendor: /90 days after the work date, and at most 180 days/, enquiry: /no end date/ };
  for (const k of Object.keys(v)) { const d = H.disclaimer(k); assert.equal(d.lead, 'Preview only.'); assert.match(d.text, /no link was made/); assert.match(d.text, /private link/); assert.match(d.text, /by WhatsApp or e-mail/); assert.match(d.text, v[k]); assert.match(d.text, /signed-in studio/); }
  assert.match(H.disclaimer('approval').text, /Nothing was sent/); assert.match(H.disclaimer('invitation').text, /Nothing was published or sent/);
  for (const k of Object.keys(H.TITLE)) assert.match(H.TITLE[k], /\(Preview\)$/);
});
t('the wording has no address and keeps the real e-mail words', () => {
  const m = H.messages('approval', { client_name: 'Demo · Priya Sharma' }, 'Aurora Events');
  assert.equal(m.subject, 'Your event proposal from Aurora Events'); assert.equal(m.button, 'Review & approve'); assert.match(m.body[0], /^Hi Priya Sharma,$/);
  for (const k of ['approval', 'booklet', 'proposal', 'invitation']) assert.doesNotMatch(JSON.stringify(H.messages(k, {}, 'S')), /https?:|\/\//);
});
t('outsiderHref: wa.me, sms, a client mailto are out; Helm addresses and teammates in chat stay', () => {
  for (const u of ['https://wa.me/919800000000?text=x', 'http://wa.me/1', 'https://api.whatsapp.com/send?phone=1', 'whatsapp://send?text=1', 'sms:+919800000000', 'mailto:client@example.com', 'MAILTO:c@x.co?subject=a'])
    assert.equal(H.outsiderHref(u, 'flow'), true, u);
  for (const u of ['mailto:sales@helm.events?subject=x', 'mailto:support@helm.events', '/plan', 'https://www.helm.events/pricing', 'tel:+919800000000']) assert.equal(H.outsiderHref(u, 'flow'), false, u);
  assert.equal(H.outsiderHref('mailto:teammate@studio.test', 'chat'), false);
});
t('every way out from the owner list is covered on the screens', () => {
  for (const s of ['#linkModal', '#lk_copy', '#lk_sms', '#lk_open', '#apprLinks', '[data-email-send]', '[data-wa-proposal]', '.pkr-link', '#sec-share', '#shareHost', '#unpubBtn', '#newLinkBtn',
    '#linkWrap', '#copyBtn', '#openBtn', '#copyLink', '#openView', '.linkline', '.au-link', '#sm_wa', '#lib_wa']) assert.ok(TP.includes('"' + s + '"'), s);
  for (const s of ['#linkModal', '#apprLinks', '[data-email-send]', '[data-wa-proposal]', '#copyBtn', '#openBtn', '.linkline', '.au-link', '#sm_wa', '#lib_wa']) assert.ok(CSS.includes('html.helm-trial:not(.tp-framed) ' + s), 'no flash: ' + s);
  for (const s of ['#sendApproval', '#shareClient', '#reapprBtn', '[data-act=\\"link\\"]', '[data-booklet-share]']) assert.ok(TP.includes(s), s);
});
t('team invitations stay: Settings and Staff keep their Copy link', () => {
  for (const s of ['#inv_link', '#inv_copy', '#iv_link', '#iv_copy']) { assert.ok(!TP.includes(s), s); assert.ok(!CSS.includes(s), s); }
  assert.match(rd('public/staff.html'), /id="iv_copy"/); assert.match(rd('public/control.html'), /inv_link/);
});
t('one plain page for every dead address, on every client page', () => {
  for (const f of ['approve.html', 'portal.html', 'booklet.html', 'invite.html', 'work.html', 'vendor-request.js', 'delivery-status.js', 'enquiry.js']) assert.ok(rd('public/' + f).includes("This link isn't available"), f);
  assert.ok(rd('public/proposal-view.html').includes('This link isn’t available'));
  for (const f of ['approve.html', 'portal.html', 'work.html', 'booklet.html', 'invite.html']) { const h = rd('public/' + f), i = h.indexOf("This link isn't available"); assert.doesNotMatch(h.slice(i, i + 120), /trial|studio/i, f); }
});
t('no trial message says copy the link', () => {
  for (const f of ['email-send.js', 'wa-proposal.js', 'invite-site-share.js']) assert.doesNotMatch(rd('public/' + f), /free trial[^"]*copy the link/i, f);
});
t('terms: version moved in both places, wording says no link leaves', () => {
  const F = rd('public/trial-facts.js');
  assert.match(F, /var VERSION = "trial-2026-11-05";/); assert.match(SQL, /select 'trial-2026-11-05'::text;/);
  assert.match(F, /Links for clients, guests, crew and vendors/);
  assert.match(rd('public/terms.html'), /no link is made for your clients, guests, crew or vendors/);
});
t('the frame script does nothing on any other address', () => {
  assert.match(FR, /var m = \/\^\\\/trial-preview-\(\[a-z\]\+\)\\\/\?\$\/\.exec\(w\.location\.pathname\);\s+if \(!m\) return;/);
  assert.match(FR, /if \(!bridge\) return;/);
  assert.match(FR, /w\.parent\.location\.origin === w\.location\.origin/);
  for (const f of ['approve', 'portal', 'booklet', 'proposal-view', 'invite', 'work', 'vendor-request', 'enquiry']) assert.match(rd('public/' + f + '.html'), /<script src="\/trial-preview-frame\.js\?v=\d+"><\/script>\n<script src="\/?trusted-types\.js/, f);
  assert.doesNotMatch(FR, /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[1-9a-f][0-9a-f]{11}/, 'the only token in the address is the one that cannot exist');
});
t('the frame routes: no token in the address, same-origin only, in vercel.json + server.js + the CSP list', () => {
  const pages = ['approve', 'portal', 'booklet', 'proposal', 'invite', 'work', 'vendor', 'enquiry'];
  for (const p of pages) { assert.ok(VJ.rewrites.some((r) => r.source === '/trial-preview-' + p), p); assert.ok(SRV.includes(p), p); }
  assert.ok(VJ.rewrites.findIndex((r) => r.source === '/trial-preview-approve') < VJ.rewrites.findIndex((r) => /\/\(\[a-z0-9-\]\+\)\/quote/.test(r.source)));
  const inv = VJ.headers.find((h) => h.source.includes('trial-preview-approve') && h.headers.some((x) => x.key === 'X-Frame-Options'));
  assert.ok(inv); assert.equal(inv.headers.find((x) => x.key === 'X-Frame-Options').value, 'SAMEORIGIN');
  assert.match(inv.headers.find((x) => x.key === 'Content-Security-Policy').value, /frame-ancestors 'self'/);
  // the paid client pages keep DENY: only the /trial-preview-* addresses may be framed
  assert.ok(!VJ.headers.some((h) => /^\/\(?approve/.test(h.source) && h.headers.some((x) => x.key === 'X-Frame-Options')));
  assert.match(API, /BPStore\.trialPreview = trialPreview;/);
});
if (process.exitCode) console.error('r125-trial-lockdown: FAILED'); else console.log('r125-trial-lockdown: ' + n + ' passed');
