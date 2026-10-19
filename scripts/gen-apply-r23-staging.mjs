// gen-apply-r23-staging.mjs - builds supabase/APPLY-R23-STAGING.sql: ONE paste for the Supabase SQL editor with every
// database change of release/r23-staging (round 23, all open PRs) that is not applied yet, in MANIFEST (= numeric) order - each paste file verbatim,
// each in its own begin / commit - then ONE combined VERIFY grid (the last result the editor shows; every row ok = true).
// 0256 (vendor requests, #233) and 0260 (cancel expires links, #237) are already applied by the owner - NOT in this file.
// No temp tables, no session settings, no psql meta-commands; safe to paste twice (every section is idempotent).
//   node scripts/gen-apply-r23-staging.mjs           rewrite supabase/APPLY-R23-STAGING.sql (the owner copy
//                                                    ~/Desktop/Agency/Helm/APPLY-R23-STAGING.sql is a plain copy of it)
//   node scripts/gen-apply-r23-staging.mjs --check   exit 1 if it is out of date
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const r = (p) => readFileSync(ROOT + p, 'utf8');
const OUT = 'supabase/APPLY-R23-STAGING.sql';

// plain-words header for each section (what it does for the owner, in one or two lines)
const WHAT = {
  '0257': 'Studio name & link are set once at sign-up: nobody in the studio can change them; only Helm HQ (two-step, reason, audited; the studio admins get a bell + e-mail; old links keep working). Look-alike / Helm-word links refused.',
  '0261': 'Client link views: which page of their private links a client opened, visits, device; "Viewed 3x - last 2h ago" on quotes / event / flow; bell "opened the proposal" + "viewed but not approved" follow-ups. Wraps bell_feed / event_activity once.',
  '0262': 'Quote "Valid until": new quotes get a valid-until date (default 14 days); client approval page + booklet show it; after expiry "Request a new quote"; reminders + bell; existing quotes get NO date until an admin applies it.',
  '0263': 'Event stages: one canonical stage per quote / event worked out from existing columns, every stage change recorded by triggers (who, when, why); out-of-order moves only logged (warn mode). No existing write path changed.',
  '0264': 'Payment schedules: built-in 30/50/20, 50/50, 100% upfront + the studio\'s own templates, added automatically when a client approves (only when the event has no milestones); payment reminders ON by default; overdue bell; a recorded payment marks every milestone it fully covers as paid.',
  '0265': 'Crew availability, open shifts with one-tap claim, event-day self check-in feeding actual wages; the ledger crew section and the WhatsApp claim function replaced in place (guarded).',
  '0266': 'Notification inbox: per-person read / Done / Snoozed state, /inbox page, snoozes come back on time, the bell follows the inbox (bell_feed wrapped once, fail-open), e-mail digests only for still-unread items (dormant until comms-dispatch sends e-mail).',
};
// the staging set = these migrations, in MANIFEST order. FROZEN once shipped: later work gets its own paste file.
export const R23_STAGING = ['0257', '0261', '0262', '0263', '0264', '0265', '0266'];

const man = r('supabase/migrations/MANIFEST');
const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]).filter((n) => R23_STAGING.includes(n));
if (nums.join() !== R23_STAGING.join()) throw new Error('MANIFEST does not list the r23 staging migrations once each, in order: ' + nums.join());
export const SECTIONS = nums;
const sections = nums.map((n) => {
  const p = `supabase/APPLY-${n}.sql`;
  if (!existsSync(ROOT + p)) throw new Error(p + ': paste file missing for migration ' + n);
  if (!WHAT[n]) throw new Error(p + ': no plain-words header in WHAT');
  return { n, p };
});

const VSTART = 'select item, ok from (values\n';
const VEND_AT = '\n) v(item, ok) order by item;';
const verify = [];
let body = '';
sections.forEach((s, i) => {
  const src = r(s.p).replace(/\s*$/, '\n');
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(src)) throw new Error(s.p + ': not ASCII');
  if (/^\s*\\/m.test(src)) throw new Error(s.p + ': psql meta-command (not pasteable)');
  if (/\bcreate\s+(temp|temporary)\s+table\b/i.test(src)) throw new Error(s.p + ': temp table (not pasteable)');
  if (/^\s*(set\s+(session\s+)?(role|search_path|statement_timeout|lock_timeout|session_replication_role|"?[a-z_]+\.[a-z_]+"?)\s*(=|to)\s|reset\s+\w)/im.test(src)) throw new Error(s.p + ': session setting (not pasteable)');
  if (!/^begin;$/m.test(src) || !/^commit;$/m.test(src)) throw new Error(s.p + ': no begin; / commit;');
  body += `\n-- ##########################################################################################\n`
        + `-- RELEASE SECTION ${String(i + 1).padStart(2, '0')}/${sections.length}: ${s.p.replace('supabase/', '')}\n`
        + `-- In plain words: ${WHAT[s.n]}\n`
        + `-- ##########################################################################################\n` + src;
  const at = src.lastIndexOf(VSTART), end = at < 0 ? -1 : src.indexOf(VEND_AT, at);
  if (at < 0 || end < 0) throw new Error(s.p + ': VERIFY block missing or not in the expected shape');
  verify.push(`select '${s.n} ' || item as item, ok from (values\n${src.slice(at + VSTART.length, end)}\n) v(item, ok)`);
});

const list = sections.map((s, i) => `--   ${String(i + 1).padStart(2, '0')}  ${s.p.replace('supabase/', '').padEnd(16)} ${WHAT[s.n]}`).join('\n');
const REQUIRE = `
-- ##########################################################################################
-- PRECHECK (read-only): every migration this release builds on - 0240 to 0256 and 0260 - must already be applied.
-- One marker per migration (a table / function it created, or for 0251 / 0252 the row / body it wrote). If any is
-- missing this block STOPS before anything is changed and names exactly which APPLY file(s) to paste first.
-- ##########################################################################################
do $$ declare m text[] := '{}'; begin
  if to_regprocedure('public.insights_event_costs(date,date)') is null then m := m || 'APPLY-0240.sql (0240 Insights per-event costs)'::text; end if;
  if to_regclass('public.delivery_settings') is null then m := m || 'APPLY-RELEASE-1022.sql or APPLY-0241.sql (0241 delivery reminders)'::text; end if;
  if to_regprocedure('public.get_studio_target_margin()') is null then m := m || 'APPLY-RELEASE-1022.sql or APPLY-0242.sql (0242 studio target margin)'::text; end if;
  if to_regclass('public.sales_requests') is null or to_regclass('public.helm_notice_outbox') is null then m := m || 'APPLY-RELEASE-1022.sql or APPLY-0244.sql (0244 trial -> paid)'::text; end if;
  if to_regclass('public.helm_money_rules') is null then m := m || 'APPLY-RELEASE-1022.sql or APPLY-0246.sql (0246 event money ledger)'::text; end if;
  if to_regclass('public.reserved_email_domains') is null then m := m || 'APPLY-RELEASE-1022.sql or APPLY-0248.sql (0248 reserved e-mail domains)'::text; end if;
  if to_regclass('public.captcha_passes') is null then m := m || 'APPLY-0249.sql (0249 security readiness)'::text; end if;
  if to_regclass('public.hq_security_notices') is null then m := m || 'APPLY-0250.sql (0250 security notices HQ only)'::text; end if;
  if exists (select 1 from public.organizations o where o.id = 'a5a5a5a5-0166-4000-8000-000000000001' and o.is_sample_master)
     and not exists (select 1 from public.studio_layout_templates t where t.org_id = 'a5a5a5a5-0166-4000-8000-000000000001'
                       and t.name = E'Demo \\u00b7 Political rally \\u2014 5,000 seats') then
    m := m || 'APPLY-0251.sql (0251 political rally sample layout)'::text; end if;
  if to_regprocedure('public._r21_cost_lines(uuid,uuid)') is null
     or (position('r22-money-0252' in (select prosrc from pg_proc where oid = to_regprocedure('public._r21_cost_lines(uuid,uuid)'))) = 0
         and position('r23-crew-0265' in (select prosrc from pg_proc where oid = to_regprocedure('public._r21_cost_lines(uuid,uuid)'))) = 0) then
    m := m || 'APPLY-0252.sql (0252 crew wages = staff on the event)'::text; end if;
  if to_regclass('public.mfa_resets') is null then m := m || 'APPLY-0253.sql (0253 MFA assisted reset)'::text; end if;
  if to_regclass('public.event_close_requests') is null or to_regprocedure('public.helm_notice_outbox_claim(integer)') is null then
    m := m || 'APPLY-0254.sql (0254 closure checklist)'::text; end if;
  if to_regclass('public.account_terms_acceptances') is null then m := m || 'APPLY-0255.sql (0255 create studio sign-up)'::text; end if;
  if to_regclass('public.vendor_requests') is null then m := m || 'APPLY-0256.sql (0256 vendor requests & invoices)'::text; end if;
  if to_regclass('public.event_restorations') is null then m := m || 'APPLY-0260.sql (0260 cancel expires links)'::text; end if;
  if cardinality(m) > 0 then
    raise exception 'STOP r23 staging PRECHECK: % prerequisite migration(s) missing on this database - nothing was changed. Paste these first, in this order, then this file again: %',
      cardinality(m), array_to_string(m, ' ; ');
  end if;
end $$;
`;
const out = `-- APPLY-R23-STAGING.sql - ONE paste for the Supabase SQL editor: every database change of release/r23-staging
-- (round 23: studio name & link lock, client link views, quote valid-until, event stages, payment schedules, crew
-- shifts & check-in, notification inbox).
-- GENERATED by scripts/gen-apply-r23-staging.mjs from the paste files below - edit those, not this.
-- Run on STAGING first, check the last result grid, then on PRODUCTION only when the owner says go.
-- REQUIRES 0240 - 0256 and 0260 already applied: the first block (PRECHECK, read-only) stops before any change and
-- names the APPLY file(s) to paste first if one is missing. 0256 (vendor requests) and 0260 (cancel expires links) are NOT in here - the owner applied them already.
--
-- What it runs, in this order (each section is that file unchanged; each migration in its own transaction):
${list}
-- Additive only: new tables / functions / rows; functions that change are renamed once to *__preNNNN (kept) behind
-- wrappers with the same names and inputs, or patched in place. Nothing is dropped, deleted or overwritten.
-- Safe to paste twice: every section is idempotent (the second paste changes nothing).
-- If a section stops with an error, fix the cause and paste the whole file again (finished sections are kept).
--
-- The LAST result grid is the combined VERIFY: every row must say ok = true.
${REQUIRE}${body}
-- ##########################################################################################
-- COMBINED VERIFY (every section's checks; every row must say ok = true)
-- ##########################################################################################
select item, ok from (
${verify.join('\nunion all\n')}
) z order by item;
`;

if (process.argv.includes('--check')) {
  const cur = existsSync(ROOT + OUT) ? r(OUT) : '';
  if (cur !== out) { console.error(`${OUT} is out of date - run: node scripts/gen-apply-r23-staging.mjs`); process.exit(1); }
  console.log(`${OUT} is current (${sections.length} sections)`);
} else {
  writeFileSync(ROOT + OUT, out);
  console.log(`wrote ${OUT} (${sections.length} sections, ${verify.length} VERIFY blocks)`);
}
