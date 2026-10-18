// Live production QA round 19 - free-trial sample data (one guard per bug):
//   L6  a new trial got 6 "Prices changed - review & re-price" alerts + a chair-rate drift banner on its confirmed
//       sample events: 0222 makes the re-pricing alert skip sample data / confirmed / client-approved / paid quotes
//       and prices the sample master's open quotes at its own Control Center chair rate (one new manifest)
//   L7  sample vendors / staff ("+91 00000 00211", the reserved never-deliverable sample number) were shown as
//       "+91 211" and could not be saved ("That number looks too short"): HelmPhone keeps the stored placeholder
//       as it is (display + validate), anything typed is checked exactly as before. Fake numbers only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const P = require('../public/phone-input.js');
globalThis.HelmPhone = P;
const V = require('../public/form-validate.js');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };
const ascii = (s) => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);

// ---- L7 -------------------------------------------------------------------------------------------------------
t('L7: the stored sample placeholder is recognised (the server rule: last 10 digits start 00000, + form only)', () => {
  for (const raw of ['+91 00000 00211', '+910000000211', ' +91 00000 00101 ', '+91-00000-00218']) {
    const sp = P.samplePlaceholder(raw);
    assert.ok(sp, raw); assert.equal(sp.iso, 'IN', raw); assert.equal(sp.national.length, 10, raw);
    assert.match(sp.e164, /^\+910000000\d{3}$/, raw);
  }
  for (const raw of ['', null, '00000 00211', '0000000211', '+91 211', '+91 00000 0021', '+91 98765 43210', '+91 90000 00201', '+44 7700 900123'])
    assert.equal(P.samplePlaceholder(raw), null, String(raw));
});
t('L7: display shows the placeholder as stored ("+91 00000 00211", was "+91 211"); real numbers unchanged', () => {
  assert.equal(P.display('+910000000211'), '+91 00000 00211');
  assert.equal(P.display('+91 00000 00103'), '+91 00000 00103');
  assert.equal(P.display('+919876543210'), '+91 98765 43210');
  assert.equal(P.display('+447700900123'), '+44 7700 900123');
});
t('L7: validate accepts the unchanged placeholder (also as a mobile field) and keeps it undeliverable', () => {
  for (const o of [{}, { mobile: true }, { required: true }]) {
    const r = P.validate('+91 00000 00211', o);
    assert.equal(r.ok, true, JSON.stringify(o)); assert.equal(r.e164, '+910000000211');
    assert.ok(r.e164.replace(/\D/g, '').slice(-10).startsWith('00000'), 'still the never-deliverable sample number');
  }
  const f = V.rules.phone('+91 00000 00211', { label: 'Phone' });
  assert.equal(f.ok, true); assert.equal(f.value, '+910000000211');
});
t('L7: anything typed is checked exactly as before (short / long / mobile rule / real numbers)', () => {
  assert.match(P.validate('+91 211').error, /too short/);
  assert.match(P.validate('+91 00000 0021').error, /too short/, 'a 9-digit placeholder is not the sample pattern');
  assert.match(P.validate('+91 98765 432101').error, /too long/);
  assert.match(P.validate('+91 51234 56789', { mobile: true }).error, /starting with 6, 7, 8 or 9/);
  assert.equal(P.validate('+91 98765 43210').e164, '+919876543210');
  assert.equal(P.validate({ iso: 'IN', national: '211' }).ok, false, 'the field object path is unchanged');
});
t('L7: the attached field keeps an untouched placeholder (display, validate, e164) and drops it once edited', () => {
  const src = read('public/phone-input.js');
  assert.match(src, /function keptSample\(\) \{ return !dirty && pristine \? samplePlaceholder\(pristine\) : null; \}/);
  assert.match(src, /var sp = byUser \? null : samplePlaceholder\(raw\);\n\s+if \(sp\) \{ iso = sp\.iso; paint\(\); show\(sp\.national\); return; \}/);
  assert.match(src, /validate: function \(extra\) \{ var x = extra \|\| \{\}; if \(keptSample\(\)\) return validate\(pristine\);/);
  assert.match(src, /e164: function \(\) \{ var ks = keptSample\(\); if \(ks\) return ks\.e164;/);
  assert.match(src, /if \(keptSample\(\)\) d = stripTrunk\(d, newIso\);/);
  // the first edit of a shown placeholder drops its zeros (they are not a "00" country prefix -> no "+0000")
  assert.match(src, /var fromSample = !!keptSample\(\);\n\s+dirty = true;/);
  assert.match(src, /if \(fromSample && \/\^\[\\s0\]\*0\/\.test\(raw\)\)/);
  // typing still drops leading zeros (a placeholder can't be typed in)
  assert.match(src, /if \(d\.charAt\(0\) === "0" && !KEEP_ZERO\[iso\] && d\.length > 1\) \{ var z = d\.length; d = d\.replace\(\/\^0\+\/, ""\);/);
  assert.ok(P.samplePlaceholder && typeof P.samplePlaceholder === 'function');
});
t('L7: the sample seed keeps the reserved never-deliverable numbers (no real-looking number introduced)', () => {
  const m = read('supabase/migrations/0167_trial_sample_manifest.sql');
  assert.match(m, /when right\(regexp_replace\(p, '\\D', '', 'g'\), 10\) like '00000%' then p/);
  assert.doesNotMatch(read('supabase/migrations/0222_trial_seed_r20.sql'), /\+91 9\d{4}/);
});

// ---- L6 -------------------------------------------------------------------------------------------------------
const M = read('supabase/migrations/0222_trial_seed_r20.sql');
const A = read('supabase/APPLY-0222.sql');
const code = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
t('L6 SQL 0222: ASCII, additive (no drop / truncate / delete / alter table), MANIFEST in numeric order, run-all suite', () => {
  assert.ok(ascii(M), 'migration ASCII'); assert.ok(ascii(A), 'APPLY ASCII');
  assert.doesNotMatch(code(M), /\b(drop\s+(table|function|column|policy|trigger|index)|truncate|delete\s+from|alter\s+table)\b/i);
  const man = read('supabase/migrations/MANIFEST');
  const i208 = man.indexOf('forward  supabase/migrations/0208_'), i222 = man.indexOf('forward  supabase/migrations/0222_trial_seed_r20.sql'),
    i236 = man.indexOf('forward  supabase/migrations/0236_');
  assert.ok(i208 > 0 && i222 > i208 && i236 > i222, 'MANIFEST: 0208 < 0222 < 0236');
  assert.match(read('scripts/db-test/run-all.sh'), /run "trial-seed-0222" "TRIAL-SEED-0222: ALL PASS \\\(18\/18\\\)" psql -q -f tests\/db\/trial-seed-0222\.sql/);
});
t('L6 SQL 0222: the alert skips sample data, confirmed events and approved / paid quotes; keeps every 0082 rule', () => {
  const f = M.slice(M.indexOf('create or replace function public._r3_price_change_notify'), M.indexOf('end $$;', M.indexOf('create or replace function public._r3_price_change_notify')));
  assert.match(f, /returns integer language plpgsql security definer set search_path = ''/);
  assert.match(f, /and not coalesce\(q\.is_demo, false\)/);
  assert.match(f, /and coalesce\(q\.status, ''\) not in \('cancelled', 'confirmed'\)/);
  assert.match(f, /and coalesce\(q\.approval_status, ''\) not in \('approved', 'paid'\)/);
  for (const keep of ["q.deleted_at is null and q.archived_at is null", "not in ('settlement', 'closed')", 'q.event_date >= current_date',
    "interval '10 minutes'", 'limit 200', "p_source = 'menu'", "'chairPrice' = any (p_fields)"]) assert.ok(f.includes(keep), keep);
  assert.doesNotMatch(code(M), /update public\.notifications|delete from public\.notifications/, 'existing bell rows untouched');
  assert.match(M, /revoke all on function public\._r3_price_change_notify\(uuid, text, text\[\], text\) from authenticated/);
});
t('L6 SQL 0222: master quotes at the studio chair rate - once, only while still shipped, money follows, then publish', () => {
  assert.match(M, /select 'sample quotes at the studio chair rate \(0222\)'::text;/);
  assert.match(M, /if exists \(select 1 from public\.helm_trial_seed_manifest m where m\.notes = N\) then return; end if;/);
  assert.match(M, /select public\._r3_num\(c\.value, 'chairPrice'\) into v_rate\s+from public\.app_config c where c\.org_id = M and c\.key = 'pricing';/);
  assert.match(M, /and q\.pricing ->> 'chairPrice' = s\.old_price/);
  for (const id of ['0000000000a1', '0000000000a2', '0000000000a3', '0000000000b6', '0000000000b7']) assert.ok(M.includes(id), id);
  assert.ok(!M.includes("'a5a5a5a5-0167-4000-8000-0000000000a4'"), 'SMP-1000 (closed) not touched');
  assert.match(M, /perform set_config\('helm\.maintenance', 'on', true\);/);
  assert.match(M, /pm\.label = 'Advance \(30%\)' and pm\.amount = a_old and pm\.status = 'paid'/);
  assert.match(M, /if v_changed > 0 and exists \(select 1 from public\.quotes x where x\.org_id = M\) then\s+perform public\.publish_sample_manifest\(N\);/);
  assert.doesNotMatch(code(M), /studio_subscriptions/, 'existing trial studios are not rewritten');
});
t('L6 APPLY-0222: one transaction, the migration body verbatim, VERIFY rows', () => {
  assert.match(A, /^-- APPLY-0222\.sql/);
  assert.ok(A.includes('\nbegin;\n') && A.includes('\ncommit;\n'));
  assert.ok(A.includes(M.trim()), 'APPLY carries the migration verbatim');
  assert.match(A, /-- VERIFY \(every row should say ok = true\)/);
  for (const k of ["'01 re-pricing alerts skip", "'02 sample master", "'03 sample master", "'04 the 0222 sample version", "'05 helpers internal"]) assert.ok(A.includes(k), k);
});
t('L6 pin test: trial-data-0171 accepts the 0222 sample totals', () => {
  assert.match(read('tests/db/trial-data-0171.sql'), /'SMP-1004=700\/472000,SMP-1005=650\/424800,SMP-1006=450\/150450'/);
});

console.log(`r19-trial-seed: ${n}/${n} passed`);
