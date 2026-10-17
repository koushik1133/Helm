// security audit run-3, Medium findings (db group) - migration 0155 + the WhatsApp edge functions:
// trial date server-owned, admin-created accounts releasable, booklet byte budget, WhatsApp STOP on
// every send path, recipient caps, template value hygiene, package fan-out cap, invitation caps.
// Behaviour is proven in tests/db/audit-medium-0155.sql (local PG) and tests/edge/*.test.ts (deno).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const mig = r('supabase/migrations/0155_audit_medium_fixes.sql'), apply = r('supabase/APPLY-0155.sql');
const manifest = r('supabase/migrations/MANIFEST'), runAll = r('scripts/db-test/run-all.sh');
const wa = r('supabase/functions/send-whatsapp/index.ts'), disp = r('supabase/functions/comms-dispatch/index.ts');
const pkg = r('supabase/functions/pkg-client-notify/index.ts'), wap = r('supabase/functions/wa-proposal/index.ts');
const fn = (name) => { const i = mig.indexOf('create or replace function public.' + name + '('); assert.ok(i >= 0, name); return mig.slice(i, mig.indexOf('end $$;', i)); };
let n = 0; const t = (name, f) => { f(); n++; };

t('migration is ASCII, additive, idempotent and listed', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(mig) && /^[\x00-\x7F]*$/.test(apply));
  for (const s of [mig, apply].map((x) => x.replace(/--[^\n]*/g, ''))) {
    assert.ok(!/\b(delete\s+from|drop\s+(table|function|column|policy|index)|truncate|alter\s+table\s+\S+\s+drop)\b/i.test(s));
  }
  assert.ok(manifest.includes('forward  supabase/migrations/0155_audit_medium_fixes.sql'));
  assert.ok(/^begin;/m.test(apply) && /^commit;/m.test(apply) && apply.includes('VERIFY') && apply.includes(mig.trim()));
  assert.match(mig, /select item, ok from \(values/);
  assert.match(runAll, /audit-medium-0155\.sql/);
});
t('renames run once and keep the previous bodies private', () => {
  assert.match(mig, /position\('audit-p1-0155' in pg_get_functiondef\(to_regprocedure\(v_old\)\)\) = 0/);
  assert.match(mig, /rename to %I', f\[1\], f\[2\], f\[1\] \|\| '__pre0155'/);
  for (const f of ['admin_create_user', 'accept_invitation', 'create_invitation', 'whatsapp_authorize', 'comms_outbox_claim',
                   'pkg_outbox_claim', 'invite_email_outbox_claim', 'wa_proposal_prepare']) {
    assert.match(mig, new RegExp("array\\['" + f + "'"), f);
    assert.match(fn(f), new RegExp('public\\.' + f + '__pre0155\\('), f + ' wraps its previous body');
    assert.match(fn(f), /audit-p1-0155/);
  }
});
t('trial end date / mode / demo choice are server-owned', () => {
  assert.match(mig, /tg_mass_assign_guard\('plan', 'created_by', 'trial_ends_at', 'trial_mode', 'demo_choice', 'demo_choice_at'\)/);
});
t('admin-created accounts: trial by invitation, capped, recorded, releasable', () => {
  const a = fn('admin_create_user');
  assert.match(a, /_a155_unpaid_trial\(v_org\)/); assert.match(a, /hint = 'use_invitation'/);
  assert.match(a, /v_n >= 100/); assert.match(a, /insert into public\.a155_admin_created/);
  assert.match(a, /current_org_id\(\)/);
  const x = fn('accept_invitation');
  assert.match(x, /email_confirmed_at is not null and lower\(u\.email\) = v_inv\.email/);
  assert.match(x, /hint = 'other_sessions'/);
  assert.match(x, /member\.moved_out/); assert.match(x, /member\.moved_in/);
  assert.match(x, /must_change_password = true/);
});
t('booklet pictures: byte budget per studio, photo copies rate limited, nothing deleted', () => {
  const q = mig.slice(mig.indexOf('function public._a155_tg_booklet_quota'), mig.indexOf('zz_a155_booklet_quota on'));
  assert.match(q, /rate_hit\('booklet\.img_photo'/);
  assert.match(q, /52428800 else 1073741824/); assert.match(q, /157286400 else 21474836480/);
  assert.match(q, /photo_renders/);
  assert.match(mig, /create trigger zz_a155_booklet_quota before insert on public\.client_booklet_images/);
});
t('WhatsApp STOP enforced on every SQL send path', () => {
  assert.match(mig, /create or replace function public\._wa_opted_out\(p_phone text, p_org uuid\)/);
  for (const f of ['whatsapp_authorize', 'comms_outbox_claim', 'pkg_outbox_claim', 'wa_proposal_prepare']) assert.match(fn(f), /_wa_opted_out\(/, f);
  assert.match(fn('whatsapp_authorize'), /errcode = 'HL451'/);
  assert.match(fn('wa_proposal_prepare'), /errcode = 'HL451'/);
  assert.match(fn('comms_outbox_claim'), /set status = 'skipped'/);
  assert.match(fn('pkg_outbox_claim'), /set status = 'skipped'/);
});
t('shared number: recipient caps + trial opt-in', () => {
  const w = fn('whatsapp_authorize');
  assert.match(w, /hint = 'trial_optin'/); assert.match(w, /wa_proposal_optins/);
  assert.match(w, /a155_wa_recipients/); assert.match(w, /\(case when v_trial then 3 else 200 end\)/);
});
t('package staff fan-out coalesced and capped', () => {
  const p = mig.slice(mig.indexOf('function public._a155_tg_pkg_staff_cap'), mig.indexOf('zz_a155_pkg_staff_cap on'));
  assert.match(p, /floor\(extract\(epoch from now\(\)\) \/ 600\)/); assert.match(p, />= 30/);
  assert.match(fn('pkg_outbox_claim'), /interval '1 day'/);
});
t('invitations capped on create and on e-mail', () => {
  assert.match(fn('create_invitation'), /\(case when v_trial then 20 else 200 end\)/);
  assert.match(fn('create_invitation'), /\(case when v_trial then 50 else 500 end\)/);
  assert.match(fn('invite_email_outbox_claim'), /interval '50 minutes'/);
});
t('owner decisions respected: profile edits and paid re-approval untouched', () => {
  assert.ok(!/function public\.(update_my_profile|complete_my_profile|set_my_display_name|tg_a52_consent_stale)\b/.test(mig));
});
t('send-whatsapp: STOP / trial answers + clean template values', () => {
  assert.match(wa, /code === "HL451"\) return \[409/);
  assert.match(wa, /hint === "trial_optin"\) return \[403/);
  // ONE param rule set (merged with the edge-client fixes): Helm links only, control characters rejected
  assert.match(wa, /paramProblem\(p\)/);
  assert.match(wa, /template values may only link to the Helm site/);
  assert.ok(!/cleanParam/.test(wa), 'no second (cleaning) rule set');
  assert.match(wa, /WHATSAPP_DISTINCT_PER_DAY_UNPAID", 3\)/);
  assert.match(wa, /from\("subscription_payments"\)/, 'unpaid = _trial_paid aware');
  assert.ok(wa.indexOf('paramProblem(p)') < wa.indexOf('/messages`'));
});
t('dispatchers: last STOP check right before each WhatsApp send; comment fixed', () => {
  for (const [src, tag] of [[disp, 'comms-dispatch'], [pkg, 'pkg-client-notify']]) {
    assert.match(src, /rpc\("wa_recipient_opted_out", \{ p_phone: to \}\)/, tag);
    assert.match(src, /\(await waStopped\(admin, to\)\) \?\? await sendWhatsApp\(to/, tag);
    for (const m of src.matchAll(/console\.(?:log|error)\(([^;]*)\);/g)) assert.doesNotMatch(m[1], /\bto\b|text|payload|recipient/, tag + ' PII in log');
  }
  assert.match(disp, /WhatsApp STOP replies/);
  assert.match(wap, /code === "HL451"\) return \[409/);
});
console.log('audit-medium-0155: ' + n + ' checks passed');
