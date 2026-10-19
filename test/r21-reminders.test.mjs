// r21-reminders.test.mjs - owner r21: automatic reminders for vendors / staff about deliveries and arrivals.
//  * per assignment: what / qty / who (+ e-mail) / due time + ITS OWN reminder times picked at the bottom of the form
//    (defaults from Control Center 60 / 30 / 0 min); e-mail only, one-tap status link /delivery?t=<64 hex>
//  * replies (on the way / arrived / delayed + new time / problem) tracked on the assignment, shown on the event-day
//    page (late = red) and posted by Helm into the event's team chat + the bell; "No response from X" alert
//  * Control Center switch per studio + the 'deliveries' access area (falls back to Event-day command)
//  * 0241 SQL additive, ASCII, in the MANIFEST + DB suite; comms-dispatch sends the claimed rows (no URL from the DB)
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };

// ---- the pure helpers of the board (delivery-tracker.js), run without a DOM ----
const ctx = { Intl, Date, Math, Number, String, Array, Object, URLSearchParams, isFinite, JSON };
ctx.globalThis = ctx; ctx.window = undefined;
vm.runInNewContext(read('public/delivery-tracker.js'), ctx);
const D = ctx.HelmDelivery;
const { deliveryMessage, deliveryLink, whenText, DELIVERY_TOKEN } = await import('../supabase/functions/comms-dispatch/delivery-reminder.mjs');
const { txFooter, TX_REASONS } = await import('../supabase/functions/_shared/email-compliance.mjs');
const TOK = 'a'.repeat(32) + '0123456789abcdef0123456789abcdef';
const ORIGIN = 'https://www.helm.events';

await t('reminder labels: 60 -> "1 hour before", 30 -> "30 min before", 0 -> "At the time", 1440 -> "1 day before"', () => {
  assert.equal(D.offsetLabel(60), '1 hour before'); assert.equal(D.offsetLabel(30), '30 min before');
  assert.equal(D.offsetLabel(0), 'At the time'); assert.equal(D.offsetLabel(1440), '1 day before'); assert.equal(D.offsetLabel(120), '2 hours before');
});
await t('reminder list cleaned: whole minutes 0..1440, unique, latest first, at most 6', () => {
  assert.deepEqual([...D.cleanOffsets([0, 60, 30, 60, -5, 2000, 1.5, 'x'])], [60, 30, 0]);
  assert.equal(D.cleanOffsets([1, 2, 3, 4, 5, 6, 7, 8]).length, 6);
});
await t('typed reminder times: "45", "1.5h", "2 hours", "at the time"; nonsense / > 1 day refused', () => {
  assert.equal(D.parseOffset('45'), 45); assert.equal(D.parseOffset('1.5h'), 90); assert.equal(D.parseOffset('2 hours'), 120);
  assert.equal(D.parseOffset('at the time'), 0); assert.equal(D.parseOffset('soon'), null); assert.equal(D.parseOffset('3d'), null);
});
await t('due time typed in the studio zone: 20/10/2026 16:30 IST = 11:00 UTC, and back', () => {
  assert.equal(D.zonedToIso('2026-10-20', '16:30', 'Asia/Kolkata'), '2026-10-20T11:00:00.000Z');
  assert.equal(D.zonedToIso('2026-10-20', '16:30', 'Asia/Dubai'), '2026-10-20T12:30:00.000Z');
  const z = D.isoToZoned('2026-10-20T11:00:00.000Z', 'Asia/Kolkata'); assert.equal(z.date, '2026-10-20'); assert.equal(z.time, '16:30');
  assert.equal(D.zonedToIso('2026-10-20', '', 'Asia/Kolkata'), '');
});
await t('late = still open and past the due time (or the promised new time); arrived / cancelled never late', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  assert.equal(D.isLate({ status: 'reminded', due_at: '2026-10-20T11:00:00Z' }, now), true);
  assert.equal(D.isLate({ status: 'delayed', due_at: '2026-10-20T11:00:00Z', eta_at: '2026-10-20T12:30:00Z' }, now), false);
  assert.equal(D.isLate({ status: 'arrived', due_at: '2026-10-20T11:00:00Z' }, now), false);
  assert.equal(D.isLate({ status: 'cancelled', due_at: '2026-10-20T11:00:00Z' }, now), false);
  assert.equal(D.summary([{ status: 'arrived', due_at: '2026-10-20T11:00:00Z' }, { status: 'scheduled', due_at: '2026-10-20T11:00:00Z' }, { status: 'cancelled', due_at: 'x' }], now),
    '1 / 2 arrived · 1 late');
});
await t('shortage link prefill: vendor / item / qty from the URL, only with deliver=1', () => {
  const p = D.prefillFromSearch('?quote=q&deliver=1&src=shortage&vendor=11111111-2222-4333-8444-555555555555&what=Chairs&qty=40');
  assert.equal(p.vendor_id, '11111111-2222-4333-8444-555555555555'); assert.equal(p.what, 'Chairs'); assert.equal(p.qty, 40); assert.equal(p.source, 'shortage');
  assert.equal(D.prefillFromSearch('?quote=q'), null);
  assert.equal(D.prefillFromSearch('?deliver=1&vendor=<x>').vendor_id, null);
});

// ---- the e-mail (comms-dispatch) ----
const ROW = { id: 'x', kind: 'party', to: 'orders@deccan.test', offset_min: 60, what: 'Chairs', qty: 120, party_name: 'Deccan Rentals',
  due_text: '20/10/2026, 04:30 PM', event: 'Wedding A', event_date: '20/10/2026', studio: 'Aurora Events', token: TOK, quote_id: '11111111-2222-4333-8444-555555555555' };
await t('vendor e-mail: what x qty, event, due time, "in 1 hour", and the one-tap link on APP_URL', () => {
  const m = deliveryMessage(ROW, ORIGIN);
  assert.match(m.subject, /^Reminder: Chairs x120 for Wedding A - due 20\/10\/2026, 04:30 PM$/);
  assert.match(m.text, /Hello Deccan Rentals/); assert.match(m.text, /due in 1 hour \(20\/10\/2026, 04:30 PM\)/);
  assert.ok(m.text.includes(ORIGIN + '/delivery?t=' + TOK)); assert.match(m.text, /On the way, Arrived, Delayed .* or Problem/);
});
await t('"at the time" reminder says "Due now"', () => {
  const m = deliveryMessage({ ...ROW, offset_min: 0 }, ORIGIN);
  assert.match(m.subject, /^Due now: /); assert.match(m.text, /is due now/); assert.equal(whenText(30), 'in 30 minutes'); assert.equal(whenText(120), 'in 2 hours');
});
await t('scheduler copy links to the event-day page (no status token)', () => {
  const m = deliveryMessage({ ...ROW, kind: 'cc', token: null }, ORIGIN);
  assert.ok(m.text.includes(ORIGIN + '/command.html?quote=' + ROW.quote_id)); assert.ok(!m.text.includes('/delivery?t='));
});
await t('fails closed: bad token / bad origin / bad due text / unknown kind -> empty (row skipped)', () => {
  assert.equal(deliveryMessage({ ...ROW, token: 'abc' }, ORIGIN).text, '');
  assert.equal(deliveryMessage(ROW, 'http://evil.test').text, '');
  assert.equal(deliveryMessage({ ...ROW, due_text: 'tomorrow' }, ORIGIN).text, '');
  assert.equal(deliveryMessage({ ...ROW, kind: 'other' }, ORIGIN).text, '');
  assert.equal(deliveryLink({ ...ROW, kind: 'cc', quote_id: '../x' }, ORIGIN), '');
  assert.ok(DELIVERY_TOKEN.test(TOK));
});
await t('markup in names never reaches the e-mail text', () => {
  const m = deliveryMessage({ ...ROW, what: '<b>Chairs</b>', studio: 'A<script>' }, ORIGIN);
  assert.ok(!/[<>]/.test(m.text)); assert.ok(!/[<>]/.test(m.subject));
});
await t('transactional footer reason for deliveries (never an unsubscribe link)', () => {
  assert.ok(TX_REASONS.delivery); assert.doesNotMatch(txFooter('delivery').html, /unsubscribe/i);
});
await t('comms-dispatch claims + marks delivery rows, e-mail only, transactional footer, link host from APP_URL', () => {
  const src = read('supabase/functions/comms-dispatch/index.ts');
  assert.match(src, /admin\.rpc\("delivery_reminder_claim", \{ p_limit: batch \}\)/);
  assert.match(src, /admin\.rpc\("delivery_reminder_mark", \{ p_id: id, p_status: res === "failed" \? "retry" : res \}\)/);
  assert.match(src, /deliveryMessage\(r, origin\)/); assert.match(src, /txFooter\("delivery"/);
  const block = src.slice(src.indexOf('admin.rpc("delivery_reminder_claim"'), src.indexOf('console.log("comms-dispatch: run"'));
  assert.ok(block.length > 100 && !/sendWhatsApp/.test(block), 'delivery block sends e-mail only');
});

// ---- the SQL ----
const SQL = read('supabase/migrations/0241_delivery_reminders.sql');
await t('0241: in the MANIFEST after 0239, ASCII only, additive (no drop table / delete / truncate / alter existing)', () => {
  const man = read('supabase/migrations/MANIFEST');
  assert.ok(man.indexOf('0241_delivery_reminders.sql') > man.indexOf('0239_business_area_admin_only.sql'));
  assert.ok(!/[^\x00-\x7F]/.test(SQL));
  assert.ok(!/\bdrop\s+table\b|\btruncate\b|\bdelete\s+from\b|alter\s+table\s+public\.(?!delivery_|%I)/i.test(SQL), 'additive only');
  assert.match(SQL, /STOP 0241/); assert.match(SQL, /ROLLBACK/);
});
await t('0241: no role_access rows written; deliveries falls back to command', () => {
  assert.doesNotMatch(SQL, /insert into public\.role_access/i);
  assert.match(SQL, /coalesce\(public\.has_area\('command', p_need\), false\)/);
});
await t('0241: token = 2 random UUIDs (64 hex), only its sha-256 stored, expiring; link RPCs rate-limited', () => {
  assert.match(SQL, /replace\(gen_random_uuid\(\)::text, '-', ''\) \|\| replace\(gen_random_uuid\(\)::text, '-', ''\)/);
  assert.match(SQL, /token_hash\s+text primary key check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(SQL, /x\.expires_at > now\(\)/);
  assert.match(SQL, /rate_hit\('delivery_link_get'/); assert.match(SQL, /rate_hit\('delivery_link_update'/);
});
await t('0241: replies posted by Helm into the event group (system, @admins + scheduler) and the bell (via comms)', () => {
  assert.match(SQL, /insert into public\.chat_messages\(conversation_id, org_id, sender_id, kind, body, meta\)\s+values \(v_conv, c\.org_id, null, 'system'/);
  assert.match(SQL, /'via', 'comms', 'source', '0241'/);
  assert.match(SQL, /'no_response'/);
});
await t('0241: free trial uses the 0212 numbers; ended trial / sample master / demo events never send', () => {
  assert.match(SQL, /_dl241_trial_take/); assert.match(SQL, /'trial_ended'/); assert.match(SQL, /'sample_master'/); assert.match(SQL, /'sample_event'/);
});
await t('APPLY-0241 = begin + the migration + commit + VERIFY rows; DB suite registered', () => {
  const a = read('supabase/APPLY-0241.sql');
  assert.ok(a.includes(SQL)); assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m); assert.match(a, /select item, ok from \(values/);
  assert.match(read('scripts/db-test/run-all.sh'), /r21-reminders-0241\.sql/);
  assert.ok(existsSync(new URL('../tests/db/r21-reminders-0241.sql', import.meta.url)));
});

// ---- the app ----
const STORE = read('public/store-api.js');
await t('store-api: deliveries API through the RPCs + the "deliveries" area (Event day, defaultFrom command)', () => {
  for (const fn of ['delivery_settings_get', 'delivery_settings_set', 'delivery_list', 'delivery_save', 'delivery_set_status', 'delivery_history', 'delivery_link_issue'])
    assert.ok(STORE.includes('rpc("' + fn + '"'), fn);
  const areasSrc = /const AREAS = (\[[\s\S]*?\n  \]);/.exec(STORE)[1];
  const AREAS = vm.runInNewContext('(' + areasSrc + ')');
  const d = AREAS.find((a) => a.key === 'deliveries');
  assert.ok(d); assert.equal(d.group, 'Event day'); assert.equal(d.defaultFrom, 'command'); assert.equal(d.page, null);
  assert.match(STORE, /if \(!acc\.map\[area\] && AREA_FALLBACK\[area\]\) return !!\(acc\.map\[AREA_FALLBACK\[area\]\] && acc\.map\[AREA_FALLBACK\[area\]\]\.view\)/);
  assert.match(STORE, /if \(!acc\.map\[area\] && AREA_FALLBACK\[area\]\) return !!\(acc\.map\[AREA_FALLBACK\[area\]\] && acc\.map\[AREA_FALLBACK\[area\]\]\.edit\)/);
});
await t('Control Center: matrix cell follows defaultFrom; reminder settings card + scripts', () => {
  const c = read('public/control.html');
  assert.match(c, /if\(a&&a\.defaultFrom\)\{ const f=MTX\[role\]&&MTX\[role\]\[a\.defaultFrom\]/);
  assert.match(c, /<div class="card" id="dlvCard" hidden><\/div>/);
  assert.match(c, /delivery-tracker\.js\?v=\d+/); assert.match(c, /delivery-settings\.js\?v=\d+/);
  assert.match(c, /HelmDeliverySettings\.init\(\)/);
  const s = read('public/delivery-settings.js');
  assert.doesNotMatch(s, /innerHTML/); assert.match(s, /saveSettings\(patch\)/); assert.match(s, /cfg\.can_manage/);
});
await t('event-day page: Deliveries & arrivals card mounted for the event; board + dialog build DOM only', () => {
  const c = read('public/command.html');
  assert.match(c, /<div class="card" id="dlvBoard" hidden><\/div>/); assert.match(c, /HelmDelivery\.mount\(\$\("#dlvBoard"\),\{quoteId:id\}\)/);
  assert.match(c, /delivery-tracker\.js\?v=\d+/); assert.match(c, /delivery-tracker\.css\?v=\d+/);
  const j = read('public/delivery-tracker.js');
  assert.doesNotMatch(j, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(j, /offsets: ed\.get\(\)/); assert.match(j, /"Reminders"/); assert.match(j, /canEditArea\("deliveries"\)/);
});
await t('shortage list: "Delivery reminder" link for vendor-sourced shortages -> event-day page, prefilled', () => {
  const ctx2 = { globalThis: null }; ctx2.globalThis = ctx2;
  vm.runInNewContext(read('public/capacity-shortage.js'), ctx2);
  const href = ctx2.HelmShortage.deliveryHref('q1', { vendor_id: 'v1', qty: 40, label: 'Short: 40 x Chairs' }, { name: 'Chairs' });
  assert.equal(href, 'command.html?quote=q1&deliver=1&src=shortage&vendor=v1&what=Chairs&qty=40');
});
await t('status link page: public, noindex, no inline script / handlers, text only, talks to the two link RPCs', () => {
  const h = read('public/delivery.html');
  assert.match(h, /noindex/); assert.doesNotMatch(h, /<script>(?!<\/script>)|<script(?![^>]*src=)[^>]*>/); assert.doesNotMatch(h, /\son[a-z]+=/i);
  const j = read('public/delivery-status.js');
  assert.doesNotMatch(j, /innerHTML/); assert.match(j, /rpc\("delivery_link_get"/); assert.match(j, /rpc\("delivery_link_update"/);
  assert.match(j, /\^\[0-9a-f\]\{64\}\$/);
  const v = read('vercel.json'); assert.equal((v.match(/dashboard\|delivery\|design/g) || []).length, 2);
});

console.log(`\nr21-reminders: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
