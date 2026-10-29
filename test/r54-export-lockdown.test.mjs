// r54-export-lockdown.test.mjs - r54 security hotfix for Settings -> "Download studio data archive". Browser / repo side:
//  * control.html: the button is for the studio owner / admins only (disabled + a plain message for anyone else, no
//    server call), a short "keep it private" confirm before any download (cancel = no call), the file is named after
//    the studio (organizations.slug, else org_id) with the India date, the trial / not-allowed errors read plainly
//  * store-api.js still calls export_tenant_organization_package; no page calls the closed export_org_data
//  * page-tours.js: the export card step says owner / admins only + keep it private
//  * SQL 0295: MANIFEST + run-all + release lists, APPLY verbatim + VERIFY, ASCII, additive only, STOP guard
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const CTRL = rd('public/control.html'), STORE = rd('public/store-api.js'), TOURS = rd('public/page-tours.js');
const SQL = rd('supabase/migrations/0295_r54_export_lockdown.sql'), APPLY = rd('supabase/APPLY-0295.sql');
const DBT = rd('tests/db/r54-export-lockdown-0295.sql');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
const WARN = "This file contains your clients' and team's personal details. Keep it private and don't share it. You are responsible for this copy.";

// a tiny DOM stand-in for the export card
function el() {
  const h = {};
  return { hidden: false, disabled: false, innerHTML: 'Download studio data archive', textContent: '', attrs: {}, h,
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(ev, fn) { h[ev] = fn; }, click() {}, remove() {}, href: '', download: '' };
}
function card({ admin, confirmAnswer = true, pkg, fail }) {
  const els = { '#btn-export-gdpr': el(), '#exp_status': el(), '#exp_gate': el() };
  els['#exp_gate'].hidden = true;
  const calls = { rpc: 0, confirm: [], downloads: [] };
  const anchors = [];
  const ctx = {
    $: (s) => els[s] || null, console, setTimeout: () => 0, Intl, Date, String,
    BPStore: { org: { exportPackage: async () => { calls.rpc++; if (fail) throw fail; return pkg; } } },
    BPUI: { confirm: async (text, opts) => { calls.confirm.push({ text, opts }); return confirmAnswer; } },
    Blob: class { constructor(parts) { this.parts = parts; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { createElement: () => { const a = el(); anchors.push(a); return a; }, body: { appendChild() {} } },
  };
  const src = ['let isAdmin = ' + JSON.stringify(!!admin) + ';',
    between(CTRL, '  // ---- GDPR / data portability export', '\n  $("#inv_copy")'),
    'globalThis.expGate = expGate; globalThis.expFileName = expFileName;'].join('\n');
  vm.runInNewContext(src, ctx);
  ctx.expGate();
  return { ctx, els, calls, anchors, click: () => els['#btn-export-gdpr'].h.click() };
}
const PKG = { org_id: 'a0000000-0000-4000-8000-000000000001', organizations: { id: 'a0000000-0000-4000-8000-000000000001', slug: 'sparkv-events' }, quotes: [] };

await t('non-admin: button disabled with a plain message, a click never calls the server or opens the confirm', async () => {
  const c = card({ admin: false, pkg: PKG });
  assert.equal(c.els['#btn-export-gdpr'].disabled, true);
  assert.equal(c.els['#exp_gate'].hidden, false);
  await c.click();
  assert.equal(c.calls.rpc, 0); assert.equal(c.calls.confirm.length, 0);
  assert.match(CTRL, /<p class="mnote" id="exp_gate" hidden>Only the studio owner or an admin can download studio data\.<\/p>/);
  assert.match(CTRL, /expGate\(\);   \/\/ r54: the data export button is for the studio owner \/ admins only/);
});

await t('admin: the confirm shows the exact plain-English warning first; cancel = no server call', async () => {
  const c = card({ admin: true, confirmAnswer: false, pkg: PKG });
  assert.equal(c.els['#btn-export-gdpr'].disabled, false);
  assert.equal(c.els['#exp_gate'].hidden, true);
  await c.click();
  assert.equal(c.calls.confirm.length, 1);
  assert.equal(c.calls.confirm[0].text, WARN);
  assert.equal(c.calls.rpc, 0, 'nothing fetched before the confirm');
});

await t('admin: after confirm the file downloads, named after the studio slug with the India date', async () => {
  const c = card({ admin: true, pkg: PKG });
  await c.click();
  assert.equal(c.calls.rpc, 1);
  assert.equal(c.anchors.length, 1);
  assert.match(c.anchors[0].download, /^helm-export-sparkv-events-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(c.els['#btn-export-gdpr'].disabled, false, 'button usable again');
});

await t('filename: slug, else org_id (the old code always fell back to "studio"); date is India time; unsafe chars cleaned', () => {
  const { ctx } = card({ admin: true, pkg: PKG });
  const late = new Date('2026-10-28T20:00:00Z');   // 01:30 on 29 Oct in India
  assert.equal(ctx.expFileName(PKG, late), 'helm-export-sparkv-events-2026-10-29.json');
  assert.equal(ctx.expFileName({ org_id: 'B0000000-0000-4000-8000-000000000001', organizations: { slug: null } }, late),
    'helm-export-b0000000-0000-4000-8000-000000000001-2026-10-29.json');
  assert.equal(ctx.expFileName({ organizations: { slug: '../Evil Slug/<x>' } }, new Date('2026-10-28T10:00:00Z')), 'helm-export-evil-slug-x-2026-10-28.json');
  assert.equal(ctx.expFileName({}, new Date('2026-03-01T00:00:00Z')), 'helm-export-studio-2026-03-01.json');
  assert.doesNotMatch(CTRL, /pkg\.organization && pkg\.organization\.id/, 'the old broken lookup is gone');
});

await t('errors read plainly: not allowed / free trial / other', async () => {
  const deny = card({ admin: true, fail: new Error('Only the studio owner or an admin can download studio data.') });
  await deny.click();
  assert.match(deny.els['#exp_status'].innerHTML, /Only the studio owner or an admin can download studio data\./);
  const trial = card({ admin: true, fail: new Error('Not available in the free trial. Upgrade to use this.') });
  await trial.click();
  assert.match(trial.els['#exp_status'].innerHTML, /Not available in the free trial\./);
  const other = card({ admin: true, fail: new Error('boom') });
  await other.click();
  assert.match(other.els['#exp_status'].innerHTML, /Couldn't build the export: boom/);
});

await t('copy + tour: owner / admins only, logged; tour step says keep it private', () => {
  assert.match(CTRL, /Only the studio owner or an admin can download it, and every download is recorded in the activity log\./);
  assert.doesNotMatch(CTRL, /Available to admins only\./);
  assert.match(TOURS, /\{ sel: "#btn-export-gdpr", title: "Download your data", desc: "Owner and admins only\. [^"]*keep it private\. Every download is logged\." \}/);
});

await t('store-api: the Settings export still uses export_tenant_organization_package; no page calls export_org_data', () => {
  assert.match(STORE, /exportPackage: \(\) => rpc\("export_tenant_organization_package", \{\}\)/);
  assert.match(CTRL, /BPStore\.org\.exportPackage\(\)/);
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => /\.(html|js)$/.test(x) && x !== 'store-api.js')) {
    const s = rd('public/' + f);
    assert.doesNotMatch(s, /\.exportData\(|export_org_data/, f + ' calls the closed export_org_data');
  }
});

await t('SQL 0295: owner / admin gate, trial guard kept, recursive scrub, audit row, export_org_data revoked', () => {
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.match(code, /create or replace function public\.export_tenant_organization_package\(\)\s*returns jsonb language plpgsql volatile security definer set search_path = ''/);
  assert.match(code, /if not \(coalesce\(public\.is_admin\(\), false\) or public\._r283_owner\(v_org\) is not distinct from v_uid\) then/);
  assert.match(code, /perform public\._tl173_guard\(\);/);
  assert.match(code, /v := public\._r295_scrub\(v\);/);
  assert.match(code, /insert into public\.audit_log\(actor, actor_email, action, entity, entity_id, changed, org_id, at\)/);
  assert.match(code, /'studio\.data_export'/);
  for (const k of ['mail_key_hash', 'must_change_password', 'approval_token', 'share_token', 'code_hash']) assert.ok(code.includes(`'${k}'`), k);
  assert.match(code, /alter function public\.export_tenant_organization_package\(\) rename to export_tenant_organization_package__pre0295/);
  assert.match(code, /revoke all on function public\.export_tenant_organization_package__pre0295\(\) from authenticated/);
  assert.match(code, /array\['public\.export_org_data\(\)', 'public\.export_org_data__pre0173\(\)'\]/);
  assert.match(code, /grant execute on function public\.export_tenant_organization_package\(\) to authenticated/);
  assert.match(code, /STOP 0295:/);
  assert.doesNotMatch(code, /0117|org_payment_accounts|org_whatsapp_accounts/, 'needs nothing prod lacks (no 0117)');
});

await t('SQL 0295: registered (MANIFEST, run-all, release lists), APPLY verbatim + VERIFY, ASCII, additive only', () => {
  const man = rd('supabase/migrations/MANIFEST');
  assert.match(man, /^forward  supabase\/migrations\/0295_r54_export_lockdown\.sql$/m);
  for (const a of ['0173_trial_lockdown.sql', '0283_r33_team_safety.sql', '0292_r47_my_pending_speed.sql'])
    assert.ok(man.indexOf(a) < man.indexOf('0295_r54_export_lockdown.sql'), '0295 after ' + a);
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r54-export-lockdown-0295" "R54-EXPORT-LOCKDOWN-0295: ALL PASS \\\(24\/24\\\)" psql -q -f tests\/db\/r54-export-lockdown-0295\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0292'(, '0\d{3}')*, '0295'(, '0\d{3}')*\]/, f);   // r60: loosened, later releases (0301+) may append
  assert.ok(APPLY.includes(SQL.trimEnd()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok((APPLY.match(/^  \('\d\d /gm) || []).length >= 12, 'VERIFY rows');
  for (const s of [SQL, APPLY, DBT]) assert.ok(/^[\x00-\x7f]*$/.test(s), 'ASCII only');
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|policy|schema|view|index|trigger)\b/i, 'no drops');
  assert.doesNotMatch(code, /\b(delete\s+from|update\s+public\.|truncate)\b/i, 'no data changed');
  assert.equal((code.match(/insert\s+into/gi) || []).length, 1, 'the only insert is the audit row');
  assert.doesNotMatch(APPLY, /create\s+temp|pg_temp/i, 'no temp tables / session state in the paste file');
  assert.match(rd('package.json'), /node test\/r54-export-lockdown\.test\.mjs/);
  const owner = new URL('file:///Users/koushikgoudshaganti/Desktop/Agency/Helm/APPLY-0295.sql');
  if (existsSync(owner)) assert.equal(readFileSync(owner, 'utf8'), APPLY, 'owner paste file = repo APPLY');
});

await t('DB suite covers: admin ok, manager / coordinator / crew / sales refused, deny-list, audit row, other studio', () => {
  for (const s of ["'manager', 'coordinator', 'crew', 'sales'", 'pg_temp.bad_keys(j) is null', "action = 'studio.data_export'",
                   "another studio''s rows are never in the file", '\\ir ../../supabase/migrations/0295_r54_export_lockdown.sql'])
    assert.ok(DBT.includes(s), s);
});

console.log(`r54-export-lockdown: ${n} passed`);
