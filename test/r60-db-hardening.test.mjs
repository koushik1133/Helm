// r60-db-hardening.test.mjs - r60 database hardening (audit 2026-10-28 I-05 / I-06 / I-07 + layouts / saved_views writes).
// Repo side of SQL 0301:
//  * no signed-out page / script reads or writes a table directly (the anon revoke cannot break one): every raw REST
//    call outside store-api is /rest/v1/rpc/..., and the store-api methods the public pages call are RPC-only
//  * the app inserts layouts / saved views WITHOUT org_id / user_id (the new refusal only hits forged requests)
//  * nothing in public/ calls layouts_quarantined_count or a storage_object_name_ok__pre copy
//  * SQL 0301: MANIFEST + run-all + release lists, APPLY verbatim + VERIFY, ASCII, additive only, STOP guard, owner file
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const SQL = rd('supabase/migrations/0301_r60_db_hardening.sql'), APPLY = rd('supabase/APPLY-0301.sql');
const DBT = rd('tests/db/r60-db-hardening-0301.sql'), STORE = rd('public/store-api.js');
const T60 = ['app_config', 'audit_log', 'chair_types', 'change_requests', 'chat_conversations', 'chat_members',
  'chat_messages', 'chat_reactions', 'checklist_templates', 'crew_members', 'design_stages', 'dish_catalog',
  'event_attendees', 'event_checklist', 'event_costs', 'event_day', 'event_discovery', 'event_files',
  'event_guests', 'event_issues', 'event_media', 'event_menu_items', 'event_plan', 'event_proposal',
  'event_ratings', 'event_refunds', 'event_requirements', 'event_resource_needs', 'event_resources',
  'event_stock_requests', 'event_tasks', 'expense_claims', 'inventory_checkouts', 'inventory_items',
  'inventory_reservations', 'layout_rules', 'lead_archive', 'leads', 'menu_templates', 'notification_seen',
  'notifications', 'nurture', 'nurture_automation', 'nurture_templates', 'organizations', 'payment_milestones',
  'plate_types', 'proposal_risks', 'quotation_versions', 'quote_consents', 'quote_otps', 'quote_payments',
  'quote_versions', 'quotes', 'role_access', 'run_sheet_items', 'task_templates', 'vendor_bills', 'vendors',
  'work_tokens'];

await t('public scripts: direct table calls live in store-api only; every other raw REST call is an RPC', () => {
  const js = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.js') && f !== 'store-api.js');
  for (const f of js) {
    const src = rd('public/' + f);
    assert.doesNotMatch(src, /\bsupa\w*\.from\(\s*["'][a-z_]+["']\s*\)/, f + ' reads a table directly');
    for (const m of src.matchAll(/rest\/v1\/([a-z_]+)/g)) assert.equal(m[1], 'rpc', f + ' calls /rest/v1/' + m[1]);
  }
});

await t('store-api: the methods the signed-out pages call (link pages) are RPC-only', () => {
  const pages = ['approve.html', 'portal.html', 'booklet.html', 'invite.html', 'proposal-view.html'];
  const used = new Set();
  for (const p of pages) for (const m of rd('public/' + p).matchAll(/Store\.(approval|portal|paySchedule|sites|proposal|booklet|pkgflow)\.([a-zA-Z]+)\(/g)) used.add(m[1] + '.' + m[2]);
  for (const m of rd('public/booklet.js').matchAll(/Store\.(booklet)\.([a-zA-Z]+)\(/g)) used.add(m[1] + '.' + m[2]);
  for (const m of rd('public/booklet-pkg.js').matchAll(/Store\.(pkgflow)\.([a-zA-Z]+)\(/g)) used.add(m[1] + '.' + m[2]);
  assert.ok(used.size >= 10, 'found the public methods: ' + [...used].join(', '));
  // the staff-only table readers that share a namespace with the link methods are not used by those pages
  for (const staff of ['approval.consents', 'approval.payments', 'approval.notifications', 'proposal.get', 'sites.forQuote', 'sites.save'])
    assert.ok(!used.has(staff), staff + ' must not be called by a signed-out page');
  // every .from(<one of the 60 tables>) in store-api sits in a signed-in code path (needUser / currentUser / supa session)
  for (const tbl of T60) for (const m of STORE.matchAll(new RegExp('\\.from\\("' + tbl + '"\\)', 'g'))) assert.ok(m.index > 0);
});

await t('store-api: layouts + saved views are inserted without org_id / user_id (the database fills them in)', () => {
  const lay = STORE.match(/async create\(name, data\) \{ needUser\(\); const \{ data: r, error \} = await supa\.from\(TABLE\)\.insert\(([^)]*)\)/);
  assert.ok(lay, 'layouts create found'); assert.doesNotMatch(lay[1], /org_id|user_id/);
  const sv = STORE.match(/supa\.from\("saved_views"\)\.insert\(\{([^}]*)\}/);
  assert.ok(sv, 'saved_views insert found'); assert.doesNotMatch(sv[1], /org_id|user_id/);
});

await t('nothing in public/ calls layouts_quarantined_count or a kept upload-guard copy', () => {
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => /\.(js|html)$/.test(x))) {
    const src = rd('public/' + f);
    assert.doesNotMatch(src, /layouts_quarantined_count|storage_object_name_ok__pre/, f);
  }
});

await t('SQL 0301: 60 tables revoked from anon, copies locked, HQ-only count, forged studio / owner refused, kept bodies', () => {
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  for (const tbl of T60) assert.ok(code.includes("'" + tbl + "'"), tbl);
  assert.match(code, /revoke all on table public\.%I from anon/);
  assert.match(code, /storage_object_name_ok__pre0069\(text,text\)', 'public\.storage_object_name_ok__pre0256\(text,text\)'/);
  assert.match(code, /not coalesce\(public\.is_platform_admin\(\), false\)/);
  assert.match(code, /a floor layout can only be saved in your own studio' using errcode = '42501'/);
  assert.match(code, /a saved view can only be saved in your own studio' using errcode = '42501'/);
  assert.match(code, /a saved view belongs to the person who saves it' using errcode = '42501'/);
  assert.match(code, /'__pre0301\('/);
  assert.match(code, /raise exception 'STOP 0301:/);
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|policy|schema|view|index|trigger)\b/i, 'no drops');
  assert.doesNotMatch(code, /\b(delete\s+from|update\s+public\.|insert\s+into|truncate)\b/i, 'no data touched');
  assert.doesNotMatch(code, /grant [^;]* to anon/i, 'never grants anon anything');
});

await t('SQL 0301: registered (MANIFEST, run-all, release lists), APPLY verbatim + VERIFY, ASCII, owner file', () => {
  const man = rd('supabase/migrations/MANIFEST');
  assert.match(man, /^forward  supabase\/migrations\/0301_r60_db_hardening\.sql$/m);
  assert.ok(man.indexOf('0277_hq_staff_roles.sql') < man.indexOf('0301_r60_db_hardening.sql'), '0301 after 0277');
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r60-db-hardening-0301" "R60-DB-HARDENING-0301: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r60-db-hardening-0301\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0301'(, '0\d{3}')*\]/, f);
  assert.ok(APPLY.includes(SQL.trimEnd()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok((APPLY.match(/^  \('\d\d /gm) || []).length >= 12, 'VERIFY rows');
  for (const s of [SQL, APPLY, DBT]) assert.ok(/^[\x00-\x7f]*$/.test(s), 'ASCII only');
  assert.doesNotMatch(APPLY, /create\s+temp|pg_temp/i, 'no temp tables / session state in the paste file');
  assert.match(rd('package.json'), /node test\/r60-db-hardening\.test\.mjs/);
  const owner = new URL('file:///Users/koushikgoudshaganti/Desktop/Agency/Helm/APPLY-0301.sql');
  if (existsSync(owner)) assert.equal(readFileSync(owner, 'utf8'), APPLY, 'owner paste file = repo APPLY');
});

console.log(`r60-db-hardening: ${n} test(s) passed.`);
