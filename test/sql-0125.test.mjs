import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const MIG = rd('supabase/migrations/0125_lead_audit_and_milestone_fix.sql');
const APPLY = rd('supabase/APPLY-0125.sql');
const VERIFY = rd('supabase/VERIFY-0125.sql');
const code = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').toLowerCase();

test('0125 is additive: no drop table / delete / truncate / update of rows', () => {
  for (const s of [code(MIG), code(APPLY)]) {
    assert.doesNotMatch(s, /drop\s+(table|column|function|schema)/);
    assert.doesNotMatch(s, /\bdelete\s+from\b/);
    assert.doesNotMatch(s, /\btruncate\b/);
    assert.doesNotMatch(s, /\bupdate\s+public\.\w+\s+set\b/);
    assert.doesNotMatch(s, /temp(orary)?\s+table/);
  }
});

test('0125 is ASCII only', () => {
  for (const s of [MIG, APPLY, VERIFY]) assert.ok(!/[^\x00-\x7f]/.test(s));
});

test('leads get the shared tg_audit trigger (idempotent)', () => {
  const s = code(MIG);
  assert.match(s, /drop trigger if exists audit_trg on public\.leads/);
  assert.match(s, /create trigger audit_trg after insert or delete or update on public\.leads for each row execute function public\.tg_audit\(\)/);
});

test('milestone guard: fixed marker, no ledger double count, same definer/search_path/message', () => {
  const body = MIG.slice(MIG.indexOf('create or replace function public.enforce_no_overpayment_ms'));
  assert.match(body, /helm-0125-ms-no-double-count/);
  assert.match(body, /security definer set search_path = public/);
  assert.doesNotMatch(code(body), /helm_total_paid\(/);
  assert.match(body, /pm\.id is distinct from new\.id/);
  assert.match(body, /tg_op = 'UPDATE'/);
  assert.match(body, /exceeds the outstanding balance \(already paid %, invoice total %\)/);
  assert.match(body, /errcode = '23514'/);
});

test('APPLY wraps migration + verify; VERIFY is read-only select', () => {
  assert.match(APPLY, /^begin;$/m);
  assert.match(APPLY, /^commit;$/m);
  assert.ok(APPLY.includes('helm-0125-ms-no-double-count'));
  assert.ok(APPLY.includes("'0125 leads audit trigger exists'"));
  assert.doesNotMatch(code(VERIFY).replace(/'[^']*'/g, "''"), /\b(insert|update|delete|create|drop|alter)\b/);
  assert.match(VERIFY, /to_regprocedure\('public\.enforce_no_overpayment_ms\(\)'\)/);
});

test('MANIFEST lists 0125', () => {
  assert.match(rd('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0125_lead_audit_and_milestone_fix\.sql/);
});
