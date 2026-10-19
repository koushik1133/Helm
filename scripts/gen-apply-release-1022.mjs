// gen-apply-release-1022.mjs - builds supabase/APPLY-RELEASE-1022.sql: ONE paste for the Supabase SQL editor with
// every database change of release/r21-b (round 21, part b), in MANIFEST (= numeric) order:
//   APPLY-0241 (delivery & arrival reminders), APPLY-0242 (studio target margin), APPLY-0244 (trial -> paid),
//   APPLY-0246 (event money ledger), APPLY-0248 (reserved e-mail domains)
//   - first a REQUIRE check (0240, shipped separately with PR #215, must already be applied), then each paste file
//   verbatim, each in its own begin / commit - then ONE combined VERIFY grid (the last result the editor shows;
//   every row must say ok = true).
// No temp tables, no session settings, no psql meta-commands; safe to paste twice (every section is idempotent).
//   node scripts/gen-apply-release-1022.mjs           rewrite supabase/APPLY-RELEASE-1022.sql (the owner copy
//                                                      ~/Desktop/Agency/Helm/APPLY-RELEASE-1022.sql is a plain copy of it)
//   node scripts/gen-apply-release-1022.mjs --check   exit 1 if it is out of date
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const r = (p) => readFileSync(ROOT + p, 'utf8');
const OUT = 'supabase/APPLY-RELEASE-1022.sql';

// plain-words header for each section (what it does for the owner, in one or two lines)
const WHAT = {
  '0241': 'Delivery & arrival reminders: per-assignment e-mail reminders with a one-tap status link, replies tracked and posted by Helm into the event chat group (@admins, the scheduler and the coordinators / managers in the group) + the bell. OFF until an admin switches it on in Control Center. 5 new tables, new functions, one pg_cron job (helm_delivery_reminders) when pg_cron is installed.',
  '0242': 'Studio target margin %: get_studio_target_margin() / set_studio_target_margin(pct) for the Insights Benchmarks card; one additive app_config row per studio (key insights).',
  '0244': 'Trial -> paid: HQ "Activate plan" (payment + GST invoice + plan active, trial caps lifted), the dormant Razorpay subscription webhook activates through the same function, Contact sales saved in Helm (HQ Requests tab + e-mail to sales@helm.events), "Ask my admin to upgrade".',
  '0246': 'Event money ledger (correct margin): every event cost with Estimated / Committed / Actual, staff wages counted, estimated / expected / actual margin + accuracy; events closed before this keep their recorded numbers (legacy); re-issues insights_event_costs (needs 0240 first).',
  '0248': 'Reserved e-mail domains: nobody can sign up / be invited on helm.events / helm.com except allowlisted Helm staff; the Auth "Before User Created" hook function (DORMANT until switched on in the Dashboard) + backstop triggers; HQ Staff access. Existing logins are not changed.',
};
// the release = these migrations, in MANIFEST order. FROZEN once shipped: later work gets its own paste file.
export const RELEASE_1022 = ['0241', '0242', '0244', '0246', '0248'];

const man = r('supabase/migrations/MANIFEST');
const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]).filter((n) => RELEASE_1022.includes(n));
if (nums.join() !== RELEASE_1022.join()) throw new Error('MANIFEST does not list the 1022 migrations once each, in order: ' + nums.join());
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
-- REQUIRE: 0240 (Insights per-event costs, shipped with PR #215 / APPLY-0240.sql) must already be applied.
-- Stops here, before anything is changed, if it is not.
-- ##########################################################################################
do $$ begin
  if to_regprocedure('public.insights_event_costs(date,date)') is null then
    raise exception 'STOP 1022: APPLY-0240.sql (insights_event_costs) is not applied on this database - paste APPLY-0240.sql first, then this file';
  end if;
end $$;
`;
const out = `-- APPLY-RELEASE-1022.sql - ONE paste for the Supabase SQL editor: every database change of release/r21-b
-- (round 21, part b: delivery reminders, target margin, trial -> paid, event money ledger, reserved e-mail domains).
-- GENERATED by scripts/gen-apply-release-1022.mjs from the paste files below - edit those, not this.
-- Run on STAGING first, check the last result grid, then on PRODUCTION only when the owner says go.
-- REQUIRES 0240 (APPLY-0240.sql, Insights per-event costs - shipped separately, already applied): the first block
-- stops before any change if it is missing. Everything else it needs is already on production.
--
-- What it runs, in this order (each section is that file unchanged; each migration in its own transaction):
${list}
-- Additive only: new tables / functions / rows; functions that change are renamed once to *__preNNNN (kept) behind
-- wrappers with the same names and inputs. Nothing is dropped, deleted or overwritten.
-- Safe to paste twice: every section is idempotent (the second paste changes nothing).
-- If a section stops with an error, fix the cause and paste the whole file again (finished sections are kept).
-- After it: docs/release/RELEASE-1022-OWNER-STEPS.md (deploy the site, redeploy 4 edge functions, switch on the
-- Auth "Before User Created" hook, cron checks, HELM_PAY_MANUAL, delivery reminders, target margin).
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
  if (cur !== out) { console.error(`${OUT} is out of date - run: node scripts/gen-apply-release-1022.mjs`); process.exit(1); }
  console.log(`${OUT} is current (${sections.length} sections)`);
} else {
  writeFileSync(ROOT + OUT, out);
  console.log(`wrote ${OUT} (${sections.length} sections, ${verify.length} VERIFY blocks)`);
}
