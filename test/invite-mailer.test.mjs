// 0131 invite-mailer: static checks (no database, no network).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const mig = r('supabase/migrations/0131_invite_mailer.sql');
const apply = r('supabase/APPLY-0131.sql');
const verify = r('supabase/VERIFY-0131.sql');
const fn = r('supabase/functions/invite-mailer/index.ts');
const tpl = r('supabase/functions/invite-mailer/templates.ts');
const readme = r('supabase/functions/README.md');
const staff = r('public/staff.html');
const control = r('public/control.html');
const api = r('public/store-api.js');
const pkg = r('package.json');
const manifest = r('supabase/migrations/MANIFEST');
const code = mig.replace(/--[^\n]*/g, ' ');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// ---- SQL: additive, idempotent, locked down ----
ok(!/\b(drop\s+(table|column|function|schema)|delete\s+from|truncate)\b/i.test(code), 'additive only');
ok(/create table if not exists public\.invite_email_outbox/.test(code), 'outbox table idempotent');
ok(/create unique index if not exists invite_email_outbox_inv_uq on public\.invite_email_outbox \(invitation_id\)/.test(code), 'one row per invitation (dedupe)');
ok(/alter table public\.invite_email_outbox enable row level security/.test(code), 'RLS on');
ok(/revoke all on public\.invite_email_outbox from anon/.test(code) && /revoke all on public\.invite_email_outbox from authenticated/.test(code), 'no user access to outbox');
ok(!/create policy/i.test(code), 'no user policies');
ok(/grant execute on function public\.invite_email_outbox_claim\(integer, uuid\) to service_role/.test(code), 'claim to service_role');
ok(/grant execute on function public\.invite_email_outbox_mark\(uuid, text\) to service_role/.test(code), 'mark to service_role');
ok(!/grant execute on function public\.invite_email_outbox_(claim|mark)[^;]*to (anon|authenticated)/.test(code), 'claim/mark never to clients');
ok(!/grant execute on function public\._ie131_enqueue[^;]*to/.test(code), 'enqueue private');
ok(/for update of o skip locked/.test(code), 'claim is concurrency-safe');
ok(/where o\.sent_at is not null;/.test(code), 'a waiting row is never double-queued');
ok(/exception when others then raise warning 'invite-0131/.test(code), 'trigger never blocks the invite');
ok(/after insert or update of token on public\.invitations/.test(code), 'queued on create + re-token');
ok(/public\.is_admin\(\)/.test(code) && /i\.org_id = v_org/.test(code), 'resend admin + same studio');
ok(/v_last > now\(\) - interval '10 minutes'/.test(code) && /'rate_limited'/.test(code), 'resend rate-limited 10 min');
ok(/grant execute on function public\.resend_invitation_email\(uuid\) to authenticated/.test(code), 'resend callable by signed-in');
ok(!/create or replace function public\.create_invitation\(/.test(code), 'create_invitation untouched');
ok(/^[\x00-\x7F]*$/.test(mig), 'migration ASCII');
ok(/^-- APPLY 0131/.test(apply) && /\nbegin;/.test(apply) && /\ncommit;/.test(apply) && apply.includes(mig.trim().slice(0, 200)), 'APPLY wraps migration');
ok(apply.includes(verify.trim()), 'APPLY includes VERIFY');
ok(/^-- VERIFY 0131/.test(verify) && !/\b(insert|update|delete|create|drop|alter|grant|revoke)\b/i.test(verify.replace(/'[^']*'/g, '')), 'VERIFY read-only');
ok(/as item, .* as ok/.test(verify), 'VERIFY item/ok rows');
ok(/forward  supabase\/migrations\/0131_invite_mailer\.sql/.test(manifest), 'MANIFEST lists 0131');

// ---- edge function: dormant, fail-closed, no PII/token logs ----
ok(/if \(!inviteEmailsOn\(Deno\.env\.get\("HELM_INVITE_EMAILS_ENABLED"\)\)\) return json\(\{ status: "dormant" \}\)/.test(fn) && /!== "false"/.test(fn), 'on by default, explicit kill switch');
ok(/admin\.auth\.admin\.inviteUserByEmail\(to, \{ redirectTo: link/.test(fn) && /signInWithOtp\(\{ email: to, options: \{ shouldCreateUser: false, emailRedirectTo: link/.test(fn), 'no Resend key -> Supabase Auth invite / magic link');
ok(/if \(mail && Deno\.env\.get\("RESEND_API_KEY"\)\) res = await sendEmail/.test(fn), 'Resend path kept when key present');
ok(/if \(!key\) return "skipped"/.test(fn), 'no RESEND key -> skipped');
ok(/secretMatches\(cronHeader, Deno\.env\.get\("HELM_INVITE_EMAIL_SECRET"\)/.test(fn), 'cron secret');
ok(/asCaller\.rpc\("invite_email_kick_org"\)/.test(fn) && /p_org: org/.test(fn), 'admin kick limited to own studio by DB');
ok(/ALLOWED_HOSTS = new Set\(\["api\.resend\.com"\]\)/.test(fn) && /redirect: "error"/.test(fn), 'fixed host allowlist');
ok(/rpc\("invite_email_outbox_claim"/.test(fn) && /rpc\("invite_email_outbox_mark"/.test(fn), 'claim + mark');
for (const line of (fn + tpl).split('\n').filter((l) => /console\.(log|error|warn)/.test(l))) {
  ok(!/token|\.to\b|email|inviter|studio|r\?\./i.test(line.replace(/invite-mailer/g, '')), 'log line has no PII/token: ' + line.trim());
}
ok(/Deno\.env\.get\("APP_URL"\)/.test(tpl) && /\/login\?invite=\$\{encodeURIComponent\(token\)\}/.test(tpl), 'join link from APP_URL');
ok(/TOKEN_RE = \/\^\[0-9a-f\]\{16,128\}\$\/i/.test(tpl), 'token shape validated');
ok(/\$\{esc\(inviter\)\}/.test(tpl) && /\$\{esc\(studio\)\}/.test(tpl) && /\$\{esc\(role\)\}/.test(tpl) && /\$\{esc\(link\)\}/.test(tpl), 'all values escaped');
ok(!/\$\{(inviter|studio|role|link)\}/.test(tpl.split('const text =')[0].split('const html =')[1]), 'no raw values in html');
ok(/expires/.test(tpl) && /text: /.test(tpl.slice(-300)) || /html, text/.test(tpl), 'plain-text fallback');
ok(/invited you to join \$\{studio\} on Helm as \$\{role\}/.test(tpl), 'headline wording');
ok(/replace\(\/\[\\r\\n<>\]\/g/.test(tpl), 'subject has no header injection');

// ---- README ----
ok(/supabase functions deploy invite-mailer --no-verify-jwt --project-ref/.test(readme), 'README deploy');
ok(/HELM_INVITE_EMAIL_SECRET=/.test(readme) && /HELM_INVITE_EMAILS_ENABLED=false/.test(readme) && /cron\.schedule\('invite-mailer'/.test(readme), 'README secrets + cron');

// ---- UI ----
ok(/resendEmail: \(id\) => rpc\("resend_invitation_email"/.test(api) && /callFn\("invite-mailer", \{\}\)/.test(api), 'store-api wired');
ok(/id="iv_resend">Resend email</.test(staff) && /id="iv_copy">Copy link</.test(staff), 'modal: Copy link + Resend email');
ok(/id="iv_mail" role="status"/.test(staff) && /Invitation email sent to \$\{email\}/.test(staff) && /Invitation email queued for/.test(staff), 'sent / queued message');
ok(/data-act="resend"/.test(staff) && /invites\.sendNow|invitations\.sendNow\(\)/.test(staff), 'card resend + flush');
ok(/\$\("#iv_mail"\)\.textContent=/.test(staff) && !/\$\("#iv_mail"\)\.innerHTML/.test(staff), 'message via textContent');
ok(/class="btn invResend">Resend email</.test(control) && /invitations\.resendEmail\(tr\.dataset\.id\)/.test(control), 'control center resend next to Copy/Revoke');
ok(/node test\/invite-mailer\.test\.mjs/.test(pkg), 'in npm test chain');

console.log(`invite-mailer: ${n} checks passed`);
