// r56-client-links.test.mjs - r56 (audit 2026-10-28 group C): client links show only what the client should see.
//  * SQL 0297: approval / proposal links answer an allow-list (C-01), portal brand = accent only (C-05), no rate-limit
//    row for a random token + purge of expired counters (C-04), client_mailer_check (C-02 / C-03); registered
//    (MANIFEST, run-all, release lists), APPLY verbatim + VERIFY, ASCII, additive (only expired counters deleted).
//  * the client pages read only keys that survive the allow-list (approve, proposal-view, portal).
//  * client-mailer asks client_mailer_check AS THE CALLER before reading / sending, refuses on any error, and never
//    e-mails an expired approval link.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const SQL = rd('supabase/migrations/0297_r56_client_link_payloads.sql'), APPLY = rd('supabase/APPLY-0297.sql');
const MAILER = rd('supabase/functions/client-mailer/index.ts');
const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
const arr = (src, name) => { const m = new RegExp(name + ' constant text\\[\\] := array\\[([^\\]]*)\\]').exec(src); assert.ok(m, name); return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]); };
const TOP = arr(SQL, 'top'), COMP = arr(SQL, 'comp'), CLI = arr(SQL, 'cli');

await t('C-01 allow-list: price inputs + totals only; client = name (+ couple names / type / date); nothing personal', () => {
  for (const k of ['chairs', 'chairPrice', 'guests', 'platePrice', 'other', 'serviceChargePct', 'discount', 'discountPct', 'gstPct',
                   'placeOfSupply', 'currency', 'subtotal', 'total', 'taxInclusive', 'taxExempt', 'taxCountry', 'taxRegion', 'taxName']) assert.ok(TOP.includes(k), k);
  assert.deepEqual(CLI, ['name', 'names', 'coupleNames', 'eventType', 'eventDate']);
  for (const bad of ['notes', 'email', 'phone', 'address', 'company', 'trn', 'gstin', 'budget', 'client', 'supplier', '_ratesAt', 'otherAuto',
                     'objectLines', '_objectsCost', 'vendorCost', 'cost', 'margin']) {
    assert.ok(!TOP.includes(bad) && !COMP.includes(bad) && !CLI.includes(bad), bad + ' never allow-listed');
  }
  assert.match(SQL, /if p_mode = 'quote' and jsonb_typeof\(p -> 'client'\) = 'object'/, 'client object only on the approval link');
  assert.match(SQL, /'mode', public\._cl297_val\(p #> '\{catering,mode\}'\)/); assert.match(SQL, /'kind', public\._cl297_val\(p #> '\{coupon,kind\}'\)/);
  assert.match(SQL, /when 'string' then to_jsonb\(left\(v #>> '\{\}', 120\)\)/, 'plain values only, strings capped');
});

await t('C-01 / C-05 wrappers: kept body first (every earlier check), then the allow-list; portal brand = {accent}', () => {
  const q = between(SQL, 'create or replace function public.public_get_quote(', 'end $$;');
  assert.match(q, /public\.public_get_quote__pre0297\(p_token\)/); assert.match(q, /_cl297_pricing\(v -> 'pricing', 'quote'\)/);
  for (const k of ['code', 'title', 'event_type', 'status', 'approval_status', 'client_name', 'reapproval_required']) assert.ok(q.includes(`'${k}'`), k);
  const p = between(SQL, 'create or replace function public.public_get_proposal(', 'end $$;');
  assert.match(p, /public\.public_get_proposal__pre0297\(p_token\)/); assert.match(p, /_cl297_pricing\(v -> 'pricing', 'proposal'\)/);
  const o = between(SQL, 'create or replace function public.public_get_portal(', 'end $$;');
  assert.match(o, /public\.public_get_portal__pre0297\(p_token\)/); assert.match(o, /jsonb_build_object\('accent', ac\)/);
  assert.doesNotMatch(o, /'billing'|'onboarding'|'logo'/);
});

await t('pages read only keys that survive the allow-list', () => {
  const AP = rd('public/approve.html'), PV = rd('public/proposal-view.html'), PO = rd('public/portal.html');
  const keep = new Set([...TOP, 'catering', 'coupon', 'computed', 'client']);
  const rp = between(AP, 'function serverBreakdown(p){', '  // Only an explicit https URL');
  for (const m of rp.matchAll(/\bp\.([A-Za-z_]+)/g)) assert.ok(keep.has(m[1]), 'approve.html reads pricing.' + m[1]);
  assert.match(AP, /client:\(quote\.pricing&&quote\.pricing\.client\)\|\|\{\}/, 'title uses pricing.client (name / names / eventDate)');
  const pv = between(PV, 'const pr=p.pricing||{};', 'if(rows.length)');
  for (const m of pv.matchAll(/\bpr\.([A-Za-z_]+)/g)) assert.ok(keep.has(m[1]), 'proposal-view reads pricing.' + m[1]);
  for (const m of PO.matchAll(/d\.studio\.brand\.([A-Za-z_]+)/g)) assert.equal(m[1], 'accent', 'portal reads brand.' + m[1]);
  // the canonical client-side recompute (store-api quoteTotal) only needs allow-listed keys
  const st = rd('public/store-api.js'); const qt = between(st, '    quoteTotal(p){', '    // THE unified breakdown.');
  for (const m of qt.matchAll(/\bp\.([A-Za-z_]+)/g)) assert.ok(keep.has(m[1]), 'quoteTotal reads pricing.' + m[1]);
});

await t('C-04: token looked up before any rate-limit row; purge deletes only expired counters (service role)', () => {
  const bi = between(SQL, 'create or replace function public.public_get_booklet_image(', 'end $$;');
  assert.ok(bi.indexOf('from public.client_booklets b where b.token = p_token') < bi.indexOf('public_get_booklet_image__pre0297'));
  const qv = between(SQL, 'create or replace function public.public_quote_validity(', 'end $$;');
  assert.ok(qv.indexOf('_qv262_quote_for(p_kind, p_token) is null then return null') > 0 && qv.indexOf('_qv262_quote_for') < qv.indexOf('public_quote_validity__pre0297'));
  assert.doesNotMatch(bi + qv, /rate_hit/);
  const pu = between(SQL, 'create or replace function public.auth_rate_hits_purge(', 'end $$;');
  assert.match(pu, /delete from public\.auth_rate_hits h/); assert.match(pu, /window_start < now\(\) - interval '2 days'/);
  assert.match(rd('supabase/migrations/0050_auth_limits.sql'), /p_window_s > 86400 then raise/, 'rate_hit windows are at most 1 day');
  assert.match(SQL, /grant execute on function public\.auth_rate_hits_purge\(integer\) to service_role/);
  assert.match(SQL, /if exists \(select 1 from pg_extension where extname = 'pg_cron'\)/, 'pg_cron only if installed');
});

await t('C-02 / C-03: client_mailer_check (quotes EDIT, own studio, live link) and client-mailer uses it as the caller', () => {
  const c = between(SQL, 'create or replace function public.client_mailer_check(', 'end $$;');
  assert.match(c, /not public\.has_area\('quotes', 'edit'\)/); assert.match(c, /q\.org_id = v_org and q\.deleted_at is null/);
  assert.match(c, /v_exp is null or v_exp > now\(\)/); assert.match(c, /link_age_expired/); assert.match(c, /not in \('cancelled', 'paused'\)/);
  assert.match(SQL, /revoke all on function public\.client_mailer_check\(uuid, text\) from anon/);
  const i = MAILER.indexOf('asCaller.rpc("client_mailer_check"'), j = MAILER.indexOf('asCaller.from("quotes")'), k = MAILER.indexOf('sendMail(');
  assert.ok(i > 0 && i < j && j < k, 'check (as the caller) before the quote is read and before any send');
  assert.doesNotMatch(MAILER, /admin\.rpc\("client_mailer_check"/, 'never asked with the service role');
  assert.match(MAILER, /if \(cErr \|\| !chk \|\| chk\.ok !== true\)/, 'any error / odd answer refuses');
  assert.match(MAILER, /approval_token_expires_at"\)\.eq\("id", quoteId\)/);
  assert.match(MAILER, /if \(!UUID_RE\.test\(token\) \|\| expired \|\| chk\.link_live === false\)/);
});

await t('SQL 0297: registered (MANIFEST, run-all, release lists), APPLY verbatim + VERIFY, ASCII, additive only', () => {
  const man = rd('supabase/migrations/MANIFEST');
  assert.match(man, /^forward  supabase\/migrations\/0297_r56_client_link_payloads\.sql$/m);
  assert.ok(man.indexOf('0262_quote_validity.sql') < man.indexOf('0297_r56_client_link_payloads.sql'), '0297 after 0262');
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r56-client-links-0297" "R56-CLIENT-LINKS-0297: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r56-client-links-0297\.sql/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0292'(, '02\d\d')*, '0297'(, '02\d\d')*\]/, f);
  assert.ok(APPLY.includes(SQL.trimEnd()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok((APPLY.match(/^  \('\d\d /gm) || []).length >= 10, 'VERIFY rows');
  for (const s of [SQL, APPLY, rd('tests/db/r56-client-links-0297.sql')]) assert.ok(/^[\x00-\x7f]*$/.test(s), 'ASCII only');
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|policy|schema|view|index|trigger)\b/i, 'no drops');
  assert.doesNotMatch(code, /\b(update\s+public\.|insert\s+into|truncate)\b/i, 'no data written');
  assert.deepEqual([...code.matchAll(/delete\s+from\s+([a-z_.]+)/gi)].map((m) => m[1]), ['public.auth_rate_hits'], 'only expired rate-limit counters deleted');
  assert.match(SQL, /STOP 0297:/);
  assert.doesNotMatch(APPLY, /create\s+temp|pg_temp/i, 'no temp tables / session state in the paste file');
  assert.match(rd('package.json'), /node test\/r56-client-links\.test\.mjs/);
  const owner = new URL('file:///Users/koushikgoudshaganti/Desktop/Agency/Helm/APPLY-0297.sql');
  if (existsSync(owner)) assert.equal(readFileSync(owner, 'utf8'), APPLY, 'owner paste file = repo APPLY');
});

console.log(`r56-client-links: ${n} test(s) passed.`);
