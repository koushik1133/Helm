// r109-otp-verify-org.test.mjs - R109 (production): "Confirm & approve" on the approval link failed with
// "You don't have permission to verify the OTP." when the browser was signed in to ANOTHER studio. 0319 stamps a new
// consent with its quote's studio (trigger on quote_consents), so the tenant guard no longer refuses it.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const SQL = read('supabase/migrations/0319_r109_consent_org_from_quote.sql');

t('0319 is listed in MANIFEST, has an APPLY file and a DB suite in run-all', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0319_r109_consent_org_from_quote\.sql\n/);
  assert.ok(existsSync(new URL('../supabase/APPLY-0319.sql', import.meta.url)));
  const apply = read('supabase/APPLY-0319.sql');
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /-- VERIFY/);
  assert.ok(apply.includes(SQL.trim()), 'APPLY carries the migration body unchanged');
  assert.match(read('scripts/db-test/run-all.sh'), /R109-OTP-VERIFY-ORG-0319: ALL PASS/);
});
t('0319 only adds a BEFORE INSERT trigger on quote_consents (no table / policy / grant widening, no deletes)', () => {
  assert.match(SQL, /create trigger ab0_r109_consent_org before insert on public\.quote_consents/);
  assert.ok(!/before insert or update/i.test(SQL), 'updates are not re-stamped (tenant guard still refuses a move)');
  assert.ok(!/\b(delete from|truncate|drop table|drop policy|alter table|create policy|grant (insert|update|all) on)\b/i.test(SQL));
  assert.ok(!/grant execute on function public\._r109_tg_consent_org_from_quote/i.test(SQL));
  assert.match(SQL, /select q\.org_id into v_org from public\.quotes q where q\.id = new\.quote_id;/);
  assert.ok(/^[\x00-\x7F]*$/.test(SQL), 'ASCII only');
});
t('approve page still calls wa_verify_and_consent unchanged (no client change needed)', () => {
  const API = read('public/store-api.js');
  assert.match(API, /rpc\("wa_verify_and_consent", \{ p_token: token, p_channel: channel, p_code: code, p_agreed: agreed,/);
});
console.log(`r109-otp-verify-org: ${n} passed`);
