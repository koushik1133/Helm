// r23 link views (migration 0261): "Viewed 3x - last 2h ago" on quote rows / the event workspace / quote flow step 9,
// the timeline dialog (IP admin only), first-open bell, "viewed but not approved" follow-ups with Send a nudge,
// the Attention tab + dashboard, Control Center settings, preview links never counted.
// Behaviour of the SQL: tests/db/r23-link-views-0261.sql (local PG).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const SQL = read('supabase/migrations/0261_client_link_views.sql');
const APPLY = read('supabase/APPLY-0261.sql');
const API = read('public/store-api.js'), JS = read('public/link-views.js'), CSS = read('public/link-views.css');
const QUOTES = read('public/quotes.html'), EVENT = read('public/event.html'), FLOW = read('public/flow.html'), CONTROL = read('public/control.html');
const DASH = read('public/shell-b-dash.js'), SHARE = read('public/booklet-share.js');
require('../public/link-views.js');
const H = globalThis.HelmLinkViews;
const NOW = Date.parse('2026-10-19T12:00:00Z');

await t('helpers: ago / days / state / chip text', () => {
  assert.equal(H.ago('2026-10-19T11:59:30Z', NOW), 'just now');
  assert.equal(H.ago('2026-10-19T11:15:00Z', NOW), '45 min ago');
  assert.equal(H.ago('2026-10-19T10:00:00Z', NOW), '2h ago');
  assert.equal(H.ago('2026-10-16T12:00:00Z', NOW), '3d ago');
  assert.equal(H.ago('nope', NOW), '');
  assert.equal(H.days('2026-10-17T11:00:00Z', NOW), 2);
  assert.equal(H.state(null), 'none');
  assert.equal(H.state({ views: 0 }), 'none');
  assert.equal(H.state({ views: 2 }), 'viewed');
  assert.equal(H.state({ views: 2, approved: true, followup: { status: 'open' } }), 'approved', 'approved wins');
  assert.equal(H.state({ views: 2, followup: { status: 'open' } }), 'followup');
  assert.equal(H.state({ views: 2, followup: { status: 'nudged' } }), 'nudged');
  assert.equal(H.state({ views: 2, followup: { status: 'dismissed' } }), 'viewed');
  assert.equal(H.chipText({ views: 3, last_at: '2026-10-19T10:00:00Z' }, NOW), 'Viewed 3× · last 2h ago');
  assert.equal(H.chipText({ views: 3, last_at: '2026-10-19T10:00:00Z', followup: { status: 'open' } }, NOW), 'Viewed 3× · last 2h ago · not approved');
  assert.equal(H.chipText({ views: 0 }, NOW), '');
});

await t('helpers: device / pages / quote id / nudge messages', () => {
  assert.equal(H.deviceText({ device: 'mobile', os: 'Android', browser: 'Chrome' }), 'Mobile · Android · Chrome');
  assert.equal(H.deviceText({}), 'Device');
  assert.equal(H.pagesText([{ page: 'portal' }, { page: 'portal' }, { page: 'quotation' }, { page: 'approve' }]), 'Proposal → Quotation → Started approving');
  assert.equal(H.pageLabel('evil'), 'Link');
  const id = 'a0000000-0000-4000-8000-0000000261a1';
  assert.equal(H.quoteIdFrom(null, { search: '?id=' + id }), id);
  assert.equal(H.quoteIdFrom(null, { search: '?quote=' + id }), id);
  assert.equal(H.quoteIdFrom(null, { search: '?id=../../etc' }), '', 'only a uuid');
  assert.match(H.nudgeResultText({ status: 'queued', masked: 'r***@x.org' }), /queued to r\*\*\*@x\.org/);
  assert.match(H.nudgeResultText({ status: 'skipped', reason: 'free_trial' }), /Free trial/);
  assert.match(H.nudgeResultText({ status: 'already_queued' }), /already queued/);
});

await t('link-views.js: DOM API only, accessible dialog, IP only when the server says admin', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(JS), 'no HTML-string sinks');
  assert.ok(/showModal/.test(JS) && /aria-modal/.test(JS) && /"cancel"/.test(JS), '<dialog> with Esc');
  assert.ok(/t\.is_admin && v\.ip/.test(JS), 'IP printed only for admins (and the server only sends it to admins)');
  assert.ok(/linkViews\.nudge\(id, channel\)/.test(JS) && /linkViews\.dismiss\(f\.id\)/.test(JS));
  assert.ok(/#link-views/.test(JS), 'the bell / dashboard deep link opens the timeline');
  assert.ok(/data-link-views-rows/.test(JS) && /data-link-views-settings/.test(JS));
  assert.ok(/min-height:44px/.test(CSS) && /@media \(max-width:480px\)/.test(CSS), 'touch targets + phone layout');
});

await t('pages: quotes rows, event workspace chip, flow step 9 panel, Control Center card', () => {
  assert.ok(QUOTES.includes('<tbody id="rows" aria-busy="true" data-link-views-rows>'));
  for (const p of [QUOTES, EVENT, FLOW, CONTROL]) {
    assert.match(p, /<script src="link-views\.js\?v=\d+"><\/script>/);
    assert.match(p, /<link rel="stylesheet" href="link-views\.css\?v=\d+">/);
  }
  assert.ok(EVENT.includes('id="lvChip" data-link-views data-quote-from-url hidden'));
  assert.ok(FLOW.includes('id="lvPanel" data-link-views="panel" data-quote-from-url hidden'));
  assert.ok(FLOW.indexOf('id="lvPanel"') > FLOW.indexOf('id="sec-approve"') && FLOW.indexOf('id="lvPanel"') < FLOW.indexOf('id="sec-pay"'), 'inside step 9');
  assert.ok(CONTROL.includes('id="lvCard" data-link-views-settings hidden') && CONTROL.indexOf('id="lvCard"') < CONTROL.indexOf('id="commsCard"'));
});

await t('preview buttons carry #preview (never counted as a client view)', () => {
  assert.ok(FLOW.includes('href="${esc(link)}#preview"'));
  assert.ok(SHARE.includes('open.setAttribute("href", link + "#preview")') && SHARE.includes('open.setAttribute("href", url + "#preview")'));
  assert.ok(/const lvPreview = \(\) =>/.test(API) && /helm\.lv\.preview/.test(API), 'the flag sticks for the tab (sessionStorage)');
});

await t('store-api: page opens -> public_link_viewed (fallback 0078), approve clicks, portal, linkViews API, bell', () => {
  assert.match(API, /supa\.rpc\("public_link_viewed", \{ p_page: pg, p_token: String\(token\), p_preview: pv \}\)/);
  assert.match(API, /rpcMissing\(r\.error\) && pg !== "approve" && !pv\) \? supa\.rpc\("public_link_opened"/);
  assert.ok(API.includes('rpc("public_get_portal", { p_token: token }).then((r) => { linkOpened("quote", token, "portal"); return r; })'));
  assert.ok(API.includes('requestOtp: (token, phone) => lvApprove(token,') && API.includes('requestChannelOtp: (token, channel) => lvApprove(token,')
    && API.includes('trialTestApprove: (token, phone, clientName, termsVersion, consentText, ua) => lvApprove(token,'));
  for (const r of ['"link_views_summary"', '"link_views_timeline"', '"link_views_attention"', '"link_view_nudge"', '"link_view_followup_dismiss"',
                   '"link_view_settings_get"', '"link_view_settings_set"']) assert.ok(API.includes(r), r);
  assert.ok(/deliveries, [a-zA-Z, ]*linkViews, [a-zA-Z, ]*integrations,/.test(API), 'exported on BPStore');
  assert.ok(API.includes('q.or("event_date.lt." + today + ",id.in.(" + extraIds.join(",") + ")")'), 'Attention tab includes viewed-not-approved');
  assert.ok(/LV_UUID\.test\(String\(x \|\| ""\)\)\)\.slice\(0, 150\)/.test(API), 'only uuids reach the filter');
  assert.ok(API.includes('k === "client_link_viewed" || k === "client_view_followup") return "event.html?id=" + enc(q) + "#link-views"'));
  assert.ok(API.includes('client_link_viewed: ["') && API.includes('client_view_followup: ["') && API.includes('client_link_viewed: "Client opened their link"'));
});

await t('dashboard: Needs attention lists viewed-not-approved with Send a nudge', () => {
  assert.ok(DASH.includes('lv: vQuotes && !signedOut && S().linkViews ? safe(function () { return S().linkViews.attention(); }, null)'));
  assert.ok(DASH.includes('"Send a nudge", x.code, "Viewed "') && DASH.includes('#link-views'));
  assert.ok(/> 3 \* DAY\) \{\n\s+var wd = /.test(DASH), 'the old "waiting" row is added only for its own quotes (braces)');
});

await t('SQL 0261: additive, org-scoped, staff / preview excluded, IP admin-only, nudge queued + re-checked', () => {
  assert.ok(!/\bdrop\s+table\b|\btruncate\b|\bdelete\s+from\b/i.test(SQL), 'nothing dropped / deleted');
  assert.ok(!/[^\x00-\x7f]/.test(SQL) && !/[^\x00-\x7f]/.test(APPLY), 'ASCII only');
  assert.ok(!/create temp(orary)? table/i.test(SQL), 'no temp tables (Supabase editor rule)');
  for (const tb of ['client_link_views', 'client_view_settings', 'client_view_followups']) assert.ok(SQL.includes('create table if not exists public.' + tb + ' ('), tb);
  assert.ok(/foreach t in array array\['client_link_views', 'client_view_settings', 'client_view_followups'\] loop\n\s+execute format\('alter table public\.%I enable row level security', t\);/.test(SQL));
  for (const f of ['public_link_viewed', 'link_views_summary', 'link_views_timeline', 'link_views_attention', 'link_view_nudge',
                   'link_view_followup_dismiss', 'link_view_settings_get', 'link_view_settings_set', 'link_views_tick', '_lv261_sweep'])
    assert.match(SQL, new RegExp('function public\\.' + f + '\\([^)]*\\)\\s*\\nreturns [a-z]+ language plpgsql (stable|volatile) security definer set search_path = \'\''), f);
  assert.ok(SQL.includes("if exists (select 1 from public.profiles p where p.id = auth.uid() and p.org_id = v_org) then return; end if;"), 'studio members not counted');
  assert.ok(SQL.includes('if coalesce(p_preview, false) then return; end if;') && SQL.includes('if public._lv261_is_bot(v_ua) then return; end if;'));
  assert.ok(SQL.includes("'ip', case when v_admin then (array_agg(v.ip order by v.created_at))[1] end"), 'IP only for admins');
  assert.ok(SQL.includes("payload ->> 'r23' = 'nudge'") && SQL.includes("public._tr212_claim_blocked(r.org_id, r.recipient, r.purpose, r.channel, r.payload)"), 'claim re-checks nudges');
  assert.ok(SQL.includes("'manual', true") && SQL.includes("'follow_up', p_channel"), 'nudges use the existing follow_up lane (unsubscribe footer)');
  assert.ok(!/create or replace function public\.public_link_opened\(/.test(SQL), '0078 RPC unchanged');
  assert.ok(SQL.includes("cron.schedule('helm_link_views_tick', '*/30 * * * *'"));
  assert.ok(APPLY.includes(SQL.trim().slice(0, 4000)) && /^begin;$/m.test(APPLY) && /^commit;$/m.test(APPLY) && /'07 trial retention/.test(APPLY));
});

await t('db-test runner + MANIFEST know 0261; user manual section exists', () => {
  assert.ok(read('scripts/db-test/run-all.sh').includes('tests/db/r23-link-views-0261.sql'));
  assert.ok(read('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0261_client_link_views.sql'));
  assert.ok(/Send a nudge/.test(read('docs/manual/r23-link-views.md')));
});

console.log(`\nr23-link-views: ${n} passed`);
