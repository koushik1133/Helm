// r23 vendors (0256): vendor requests (assign -> accept / decline with a comment -> reassign / cancel) + vendor
// invoices from the same signed-out link into the budget and margins. Static + pure-module checks; the behaviour
// itself is proven against a real database by tests/db/r23-vendors-0256.sql (scripts/db-test/run-all.sh).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { vendorRequestMessage, vendorRequestLink, VENDOR_TX_REASON } from '../supabase/functions/comms-dispatch/vendor-request.mjs';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const M = read('supabase/migrations/0256_vendor_requests_invoices.sql');
const fn = (name) => { const m = M.match(new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?\\nend \\$\\$;|create or replace function public\\.' + name + '\\([\\s\\S]*?\\n\\$\\$;')); return m ? m[0] : ''; };

t('A1 migration: ASCII, MANIFEST after 0253, run-all registered, APPLY-0256 = begin + migration verbatim + commit + VERIFY', () => {
  assert.ok(!/[^\x00-\x7f]/.test(M), 'ASCII only');
  const man = read('supabase/migrations/MANIFEST');
  assert.match(man, /\nforward  supabase\/migrations\/0256_vendor_requests_invoices\.sql\n/);
  assert.ok(man.indexOf('0256_vendor') > man.indexOf('0253_mfa_assisted_reset'));
  assert.match(read('scripts/db-test/run-all.sh'), /R23-VENDORS-0256: ALL PASS \\\(77\/77\\\)" psql -q -f tests\/db\/r23-vendors-0256\.sql/);
  const A = read('supabase/APPLY-0256.sql');
  assert.ok(A.includes('begin;\n' + M + 'commit;'), 'APPLY carries the migration verbatim');
  assert.match(A, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok(!/[^\x00-\x7f]/.test(A));
  assert.ok(!/\bcreate temp|^\\/im.test(A), 'pasteable (no temp tables, no psql meta-commands)');
});
t('A2 additive: no DROP TABLE / DROP COLUMN / DELETE / TRUNCATE; only own policies dropped-and-recreated', () => {
  assert.ok(!/\bdrop\s+table\b|\bdrop\s+column\b|\bdelete\s+from\b|\btruncate\b/i.test(M));
  for (const m of M.matchAll(/drop policy if exists (\S+)/g)) assert.match(m[1], /^vendor_invoices_/);
  for (const m of M.matchAll(/drop trigger if exists (\S+)/g)) assert.equal(m[1], 'vr256_guard');
});
t('A3 every SECURITY DEFINER function pins search_path = \'\'', () => {
  const defs = [...M.matchAll(/create or replace function public\.([a-z0-9_]+)\([^)]*\)[\s\S]*?(?:\$\$|\$b\$)/g)];
  assert.ok(defs.length > 30);
  for (const d of defs) if (/security definer/.test(d[0])) assert.match(d[0], /set search_path = ''/, d[1]);
});
t('A4 tokens: two random UUIDs, only the sha-256 kept; expiring; rate-limited link RPCs', () => {
  assert.match(fn('_vr256_issue'), /gen_random_uuid\(\)::text, '-', ''\) \|\| replace\(gen_random_uuid/);
  assert.match(fn('_vr256_issue'), /values \(public\._vr256_hash\(v_tok\)/);
  assert.match(M, /token_hash   text primary key check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(fn('_vr256_link'), /x\.expires_at > now\(\)/);
  for (const f of ['vendor_link_get', 'vendor_link_respond', 'vendor_invoice_submit']) assert.match(fn(f), /public\.rate_hit\('/, f);
  assert.match(fn('vendor_invoice_upload'), /n >= 20/);
});
t('A5 grants: anon reaches only the 4 link RPCs + the storage upload gate; tick / claim / mark service role only', () => {
  const anonBlock = M.match(/the signed-out vendor link page[\s\S]*?end loop;/)[0];
  assert.deepEqual([...anonBlock.matchAll(/'public\.([a-z_]+)\(/g)].map((m) => m[1]).sort(),
    ['vendor_invoice_submit', 'vendor_invoice_upload', 'vendor_invoice_upload_ok', 'vendor_link_get', 'vendor_link_respond']);
  assert.match(M, /grant execute on function public\.vendor_request_claim\(integer, text\) to service_role/);
  assert.ok(!/vendor_request_claim[^\n]*to (anon|authenticated)/.test(M));
});
t('A6 role checks: assign = Vendors edit, review = Finance edit, money = Finance view or Vendors edit, admin always', () => {
  const c = fn('_vr256_can');
  assert.match(c, /when public\.user_role\(\) = 'admin' then true/);
  assert.match(c, /p_need = 'assign' then coalesce\(public\.has_area\('vendors', 'edit'\)/);
  assert.match(c, /p_need = 'review' then coalesce\(public\.has_area\('finance', 'edit'\)/);
  assert.match(fn('vendor_invoice_review'), /_vr256_can\('review'\)/);
  for (const f of ['vendor_request_save', 'vendor_request_reassign', 'vendor_request_cancel', 'vendor_request_set_status', 'vendor_request_link'])
    assert.match(fn(f), /_vr256_can\('assign'\)/, f);
  for (const f of ['vendor_request_save', 'vendor_request_reassign', 'vendor_invoice_review']) assert.match(fn(f), /_trial_locked/, f);
});
t('A7 tenancy: every studio RPC scopes by current_org_id(); quote-org match trigger on the event tables', () => {
  for (const f of ['vendor_request_save', 'vendor_request_set_status', 'vendor_request_reassign', 'vendor_request_cancel', 'vendor_requests_list', 'vendor_requests_summary', 'vendor_request_history', 'vendor_invoice_review'])
    assert.match(fn(f), /current_org_id\(\)/, f);
  assert.match(M, /foreach t in array array\['vendor_requests', 'vendor_invoices', 'vendor_invoice_grants'\] loop[\s\S]*?zz_quote_org_match/);
  assert.match(fn('vendor_invoice_file_visible'), /i\.org_id = public\.current_org_id\(\)/);
});
t('A8 money: approve writes ONE vendor_bills row (amount + GST + booking); payments via record_vendor_payout; over-agreed needs a tick', () => {
  const r = fn('vendor_invoice_review');
  assert.equal((r.match(/insert into public\.vendor_bills/g) || []).length, 1);
  assert.match(r, /gst_amount, gst_claimable, created_by\)/);
  assert.match(r, /hint = 'over_agreed'/);
  assert.match(read('public/vendor-requests-ui.js'), /S\(\)\.vendorBills\.pay\(i\.bill_id/);
});
t('A9 GST rules: number <= 16 [A-Z0-9/-], unique per vendor per FY, IGST xor CGST+SGST, GSTIN when GST, file required', () => {
  assert.match(M, /invoice_no     text not null check \(invoice_no ~ '\^\[A-Z0-9\/-\]\{1,16\}\$'\)/);
  assert.match(M, /vendor_invoices_no_uq on public\.vendor_invoices\(org_id, vendor_id, invoice_no, fy\)/);
  const s = fn('vendor_invoice_submit');
  assert.match(s, /charge IGST \(other state\) OR CGST \+ SGST/);
  assert.match(s, /enter your GSTIN - it is needed when GST is charged/);
  assert.match(s, /attach the invoice/);
  assert.match(s, /storage\.objects o where o\.bucket_id = 'vendor-invoices' and o\.name = g\.path/);
});
t('B1 vendor-request.mjs: link only from APP_URL + a 64-hex token; no money; fails closed', () => {
  const tok = 'a'.repeat(64);
  const row = { id: 'x', channel: 'email', kind: 'request', token: tok, what: 'Chairs', qty: 120, when_text: '20/10/2026, 04:30 PM',
    respond_by_text: '19/10/2026, 06:00 PM', studio: 'Studio A', event: 'Wedding A', event_date: '20/10/2026', vendor_name: 'Deccan Rentals' };
  const m = vendorRequestMessage(row, 'https://app.helm.events');
  assert.match(m.subject, /^Request from Studio A: Chairs x120 for Wedding A/);
  assert.ok(m.text.includes('https://app.helm.events/vendor-request?t=' + tok));
  assert.ok(!/₹|Rs\.?\s?\d|18000/.test(m.text), 'no money in the e-mail');
  assert.match(vendorRequestMessage({ ...row, kind: 'reminder' }, 'https://app.helm.events').subject, /^Reminder: /);
  assert.equal(vendorRequestMessage({ ...row, token: 'nope' }, 'https://app.helm.events').text, '');
  assert.equal(vendorRequestMessage({ ...row, channel: 'whatsapp' }, 'https://app.helm.events').text, '');
  assert.equal(vendorRequestLink(row, 'http://evil.test'), '');
  assert.equal(vendorRequestMessage({ ...row, what: '' }, 'https://app.helm.events').text, '');
  assert.match(VENDOR_TX_REASON, /vendor request/);
});
t('B2 comms-dispatch claims the e-mail lane only and marks every row', () => {
  const I = read('supabase/functions/comms-dispatch/index.ts');
  assert.match(I, /admin\.rpc\("vendor_request_claim", \{ p_limit: batch, p_channel: "email" \}\)/);
  assert.match(I, /admin\.rpc\("vendor_request_mark", \{ p_id: id/);
});
t('C1 public page: noindex, no-referrer, text only (no innerHTML), only config + its own script; route registered', () => {
  const H = read('public/vendor-request.html'), J = read('public/vendor-request.js');
  assert.match(H, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(H, /<meta name="referrer" content="no-referrer">/);
  assert.deepEqual([...H.matchAll(/<script src="([^"?]+)/g)].map((m) => m[1]), ['/trusted-types.js', '/console-warning.js', '/config.js', '/vendor-request.js']);
  assert.ok(!/<script\s*>/i.test(H) && !/style="/.test(H), 'no inline script / style');
  assert.ok(!/\.innerHTML|insertAdjacentHTML\(|document\.write/.test(J));
  assert.match(J, /credentials: "omit"/);
  assert.match(J, /0x25, 0x50, 0x44, 0x46/, 'PDF magic bytes');
  assert.match(J, /MAX_BYTES = 10 \* 1024 \* 1024/);
  assert.match(J, /"x-upsert": "false"/);
  const V = read('vercel.json'); assert.equal((V.match(/\|vendor-request\|vendors\|/g) || []).length, 2);
  assert.match(read('public/_headers'), /\n\/vendor-request\n  X-Robots-Tag: noindex, nofollow, noarchive\n/);
  assert.match(read('test/auth-gate.test.mjs'), /'vendor-request'\]/);
});
t('C2 Vendors page: "Requests & invoices" tab, DOM-built UI (no innerHTML), store API + payout', () => {
  const H = read('public/vendors.html'), U = read('public/vendor-requests-ui.js');
  assert.match(H, /data-view="requests"[^>]*>Requests &amp; invoices</);
  assert.match(H, /<div id="partnersView">/);
  assert.match(H, /<section id="requestsView" hidden/);
  assert.match(H, /<script src="vendor-requests-ui\.js\?v=\d+"><\/script>/);
  assert.match(H, /<link rel="stylesheet" href="vendor-requests\.css\?v=\d+">/);
  assert.ok(!/\.innerHTML|insertAdjacentHTML\(/.test(U));
  for (const k of ['Approve', 'Query', 'Reject', 'Record payment', 'Reassign', 'Share link', 'Record answer', 'History'])
    assert.ok(U.includes('text: "' + k + '"'), k);
  assert.match(U, /qs\.get\("tab"\) === "requests"/);
});
t('C3 store-api: BPStore.vendorRequests wraps the RPCs (list [] / summary null on an older server)', () => {
  const S = read('public/store-api.js');
  assert.match(S, /const vendorRequests = \{/);
  assert.match(S, /comms, [a-zA-Z, ]*deliveries, vendorRequests, [a-zA-Z, ]*integrations,/);
  for (const r of ['vendor_requests_list', 'vendor_requests_summary', 'vendor_request_save', 'vendor_request_set_status', 'vendor_request_reassign',
    'vendor_request_cancel', 'vendor_request_link', 'vendor_request_history', 'vendor_invoice_review']) assert.ok(S.includes('rpc("' + r + '"'), r);
  assert.match(S, /storage\.from\("vendor-invoices"\)\.createSignedUrl\(path, 120\)/);
  assert.match(S, /location\.origin \+ "\/vendor-request\?t=" \+ token/);
});
t('C4 event workspace: the Vendors card shows request status pills (counts, no money) + a Requests & invoices link', () => {
  const E = read('public/event.html');
  assert.match(E, /vendorReqSummary=await BPStore\.vendorRequests\.summary\(id\)/);
  assert.match(E, /awaiting reply/); assert.match(E, /reply overdue/); assert.match(E, /invoice\$\{/);
  assert.match(E, /\{t:"Requests & invoices", href:"vendors\.html\?tab=requests&quote="\+encodeURIComponent\(id\)\}/);
  assert.match(read('public/event-polish.css'), /\.vrq-pills-ws\{/);
});
t('C5 package.json runs this test', () => {
  assert.match(read('package.json'), /node test\/r23-vendors\.test\.mjs/);
  assert.ok(existsSync(new URL('tests/db/r23-vendors-0256.sql', root)));
});

let n = 0;
for (const [name, f] of tests) { try { f(); n++; console.log('  ✓ ' + name); } catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.message)); process.exitCode = 1; } }
console.log(`\nr23-vendors: ${n}/${tests.length} passed`);
