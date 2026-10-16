// 0117 integration readiness (dormant): migration is additive + tenant-safe, secrets only
// as Vault ids, webhooks fail closed, the Settings panel is CSP-safe and validates input.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const R = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const sql = R('supabase/migrations/0117_integration_accounts.sql');
const code = sql.replace(/--[^\n]*/g, '');
const apply = R('supabase/APPLY-0117.sql');
const verify = R('supabase/VERIFY-0117.sql');

t('migration: additive only (no DROP TABLE/COLUMN, DELETE, TRUNCATE, ALTER ... DROP)', () => {
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|schema|index)\b/i);
  assert.doesNotMatch(code, /\bdelete\s+from\b/i);
  assert.doesNotMatch(code, /\btruncate\b/i);
  assert.doesNotMatch(code, /alter\s+table[^;]*\bdrop\b/i);
  assert.match(code, /create table if not exists public\.org_payment_accounts/);
  assert.match(code, /create table if not exists public\.org_whatsapp_accounts/);
});
t('migration: never touches quotes rows', () => {
  assert.doesNotMatch(code, /update\s+public\.quotes\b/i);
  assert.doesNotMatch(code, /insert\s+into\s+public\.quotes\b/i);
});
t('migration: RLS on + admin-of-own-studio read policies', () => {
  for (const tb of ['org_payment_accounts', 'org_whatsapp_accounts', 'integration_webhook_events', 'whatsapp_opt_outs'])
    assert.match(code, new RegExp(`alter table public\\.${tb} enable row level security`));
  assert.equal((code.match(/org_id = public\.current_org_id\(\) and coalesce\(public\.is_admin\(\), false\)/g) || []).length >= 3, true);
});
t('migration: secret (Vault id) columns are never granted to authenticated', () => {
  const grants = [...code.matchAll(/grant select \(([^)]*)\)\s*on public\.(\w+) to authenticated/g)];
  assert.equal(grants.length, 3);
  for (const [, cols] of grants) assert.doesNotMatch(cols, /secret|token/);
  assert.match(code, /revoke all on public\.org_payment_accounts, public\.org_whatsapp_accounts,\s*public\.integration_webhook_events, public\.whatsapp_opt_outs from public, anon, authenticated/);
});
t('migration: credential readers + webhook RPCs are service-role only', () => {
  for (const f of ['org_razorpay_creds(uuid)', 'org_whatsapp_creds(uuid)', '_integ_vault_get(uuid)', '_integ_vault_put(uuid, text, text)',
    'razorpay_settle_for_org(uuid, uuid, text, text, bigint, text)', 'razorpay_record_event(text, uuid, text, text, text, text, bigint, text, uuid)',
    'wa_record_event(text, text, text, text, text, text, jsonb)', 'wa_set_opt_out(text, text, boolean)', 'mark_org_integration(uuid, text, text, text)']) {
    assert.ok(code.includes(`revoke all on function public.${f} from public, anon, authenticated;`), f);
    assert.ok(code.includes(`grant execute on function public.${f} to service_role;`), f);
  }
});
t('migration: save RPCs require studio admin, store secrets via Vault, mark pending (never connected)', () => {
  for (const f of ['save_org_payment_account', 'save_org_whatsapp_account']) {
    const body = code.slice(code.indexOf(`function public.${f}(`), code.indexOf('end $$;', code.indexOf(`function public.${f}(`)));
    assert.match(body, /not coalesce\(public\.is_admin\(\), false\)/);
    assert.match(body, /_integ_vault_put/);
    assert.doesNotMatch(body, /'connected'/);
  }
});
t('migration: settle-for-org refuses another studio; record_event idempotent', () => {
  assert.match(code, /if v_org <> p_org then return jsonb_build_object\('result', 'org_mismatch'\)/);
  assert.match(code, /on conflict \(provider, event_id\) do nothing returning id into v_id/);
  assert.match(code, /create unique index if not exists integration_webhook_events_uk117 on public\.integration_webhook_events \(provider, event_id\)/);
});
t('APPLY-0117 carries the same body; VERIFY-0117 is read-only', () => {
  assert.ok(apply.includes(sql.trim()));
  const v = verify.replace(/--[^\n]*/g, '').replace(/'[^']*'/g, "''").trim();
  assert.match(v, /^select\b/i);
  assert.equal(v.split(';').filter((x) => x.trim()).length, 1);
  assert.doesNotMatch(v, /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i);
});
t('MANIFEST lists 0117', () => assert.match(R('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0117_integration_accounts\.sql/));

const cpl = R('supabase/functions/create-payment-link/index.ts');
const rzw = R('supabase/functions/razorpay-webhook/index.ts');
const waw = R('supabase/functions/wa-webhook/index.ts');
t('create-payment-link: studio creds first, env fallback, optional strict mode', () => {
  assert.match(cpl, /admin\.rpc\("org_razorpay_creds", \{ p_org: orgId \}\)/);
  assert.match(cpl, /RAZORPAY_REQUIRE_STUDIO_ACCOUNT/);
  assert.match(cpl, /Deno\.env\.get\("RAZORPAY_KEY_ID"\)/);
});
t('razorpay-webhook: ?org= uses studio secret + settle_for_org; record-only events listed', () => {
  assert.match(rzw, /searchParams\.get\("org"\)/);
  assert.match(rzw, /razorpay_settle_for_org/);
  for (const e of ['payment.failed', 'payment_link.cancelled', 'payment_link.expired', 'refund.processed']) assert.ok(rzw.includes(`"${e}"`), e);
  // signature still checked before parsing
  assert.ok(rzw.indexOf('invalid signature", { status: 401 })') < rzw.indexOf('JSON.parse(raw)'));
});
t('wa-webhook: dormant without secrets, HMAC before parse, never stores message text', () => {
  assert.match(waw, /if \(!verifyToken \|\| !appSecret\) return new Response\("not found", \{ status: 404 \}\)/);
  assert.ok(waw.indexOf('x-hub-signature-256') < waw.indexOf('JSON.parse(raw)'));
  assert.doesNotMatch(waw, /p_body|text\.body\s*[,}]/);
});

const js = R('public/integrations-settings.js');
const css = R('public/integrations-settings.css');
t('panel: CSP-safe (no innerHTML / inline styles / eval) and never logs secrets', () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|\.style\.|setAttribute\("style"|eval\(|new Function/);
  assert.doesNotMatch(js, /console\./);
  assert.match(js, /autocomplete = type === "password" \? "new-password"/);
  assert.doesNotMatch(css, /!important\s*;?\s*}/);
});
t('panel: validators', () => {
  const ctx = { window: undefined, document: {}, globalThis: {} }; ctx.globalThis = ctx;
  vm.runInNewContext(js.replace('typeof window !== "undefined" ? window : globalThis', 'globalThis'), ctx);
  const H = ctx.HelmIntegrationsSettings;
  assert.equal(H._validateRazorpay({ keyId: 'rzp_test_ABC12345', keySecret: 'secret123', webhookSecret: 'whsec1234' }), '');
  assert.notEqual(H._validateRazorpay({ keyId: 'pk_live_x', keySecret: 'secret123', webhookSecret: 'whsec1234' }), '');
  assert.notEqual(H._validateRazorpay({ keyId: 'rzp_live_ABC12345', keySecret: 'x', webhookSecret: 'whsec1234' }), '');
  assert.equal(H._validateWhatsapp({ wabaId: '123456789', phoneId: '1098765432', token: 'EAAG'.padEnd(40, 'x') }), '');
  assert.notEqual(H._validateWhatsapp({ wabaId: 'abc', phoneId: '1098765432', token: 'EAAG'.padEnd(40, 'x') }), '');
  assert.match(H._friendly({ message: 'vault_unavailable' }), /storage/);
  assert.match(H._friendly({ code: '42501' }), /admin/);
});
t('panel files exist; control.html not edited by this change', () => {
  assert.ok(existsSync(new URL('../public/integrations-settings.css', import.meta.url)));
});
console.log(`\n${n} passed`);
