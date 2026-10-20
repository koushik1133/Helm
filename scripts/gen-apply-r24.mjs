// gen-apply-r24.mjs - builds supabase/APPLY-R24.sql: ONE paste for the Supabase SQL editor with every database change
// of release/r24-staging (round 24) in MANIFEST (= numeric) order - each paste file verbatim, each in its own
// begin / commit - then ONE combined VERIFY grid (the last result the editor shows; every row ok = true).
// R24 builds on R23: a read-only PRECHECK first stops (nothing changed) when any R23 migration (0257, 0261 - 0266) is
// missing and names APPLY-R23-STAGING.sql. No temp tables, no session settings, no psql
// meta-commands; safe to paste twice (every section is idempotent).
//   node scripts/gen-apply-r24.mjs           rewrite supabase/APPLY-R24.sql (the owner copy
//                                            ~/Desktop/Agency/Helm/APPLY-R24.sql is a plain copy of it)
//   node scripts/gen-apply-r24.mjs --check   exit 1 if it is out of date
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = new URL('..', import.meta.url).pathname;
const r = (p) => readFileSync(ROOT + p, 'utf8');
const OUT = 'supabase/APPLY-R24.sql';

// plain-words header for each section (what it does for the owner, in one or two lines)
const WHAT = {
  '0268': 'Stock, one story per item on an event: Reserved -> Out (who has it, since when) -> Back / Missing / Damaged. Event-day "Give out" really checks the stock out; reservations release themselves; Closure only stops for stock that is still out.',
  '0269': 'Run-sheet reminders (each line can name a real owner; bell / e-mail / WhatsApp queued), one Automations settings row per studio, and a public enquiry form per studio that turns every enquiry into a lead (off until an admin opens it).',
};
// the R24 set = these migrations, in MANIFEST order. FROZEN once shipped: later work gets its own paste file.
export const R24 = ['0268', '0269'];

const man = r('supabase/migrations/MANIFEST');
const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]).filter((n) => R24.includes(n));
if (nums.join() !== R24.join()) throw new Error('MANIFEST does not list the r24 migrations once each, in order: ' + nums.join());
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
  // a session SET / RESET statement (ends with ';'); a function's own "set search_path = ''" attribute line is fine
  if (/^\s*(set\s+(session\s+)?(role|search_path|statement_timeout|lock_timeout|session_replication_role|"?[a-z_]+\.[a-z_]+"?)\s*(=|to)\s[^\n]*;\s*$|reset\s+\w)/im.test(src)) throw new Error(s.p + ': session setting (not pasteable)');
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
-- PRECHECK (read-only): R23 must already be applied - 0257 and 0261 to 0266 (APPLY-R23-STAGING.sql).
-- One marker per migration (a table / function it created). If any is missing this block STOPS before anything is
-- changed and names the file to paste first. (APPLY-R23-STAGING.sql has its own precheck for 0240 - 0256 / 0260.)
-- ##########################################################################################
do $$ declare m text[] := '{}'; begin
  if to_regprocedure('public.tg_r23_org_identity_lock()') is null then m := m || '0257 studio name & link lock'::text; end if;
  if to_regclass('public.client_link_views') is null then m := m || '0261 client link views'::text; end if;
  if to_regclass('public.quote_validity') is null then m := m || '0262 quote valid-until'::text; end if;
  if to_regclass('public.quote_stage_transitions') is null then m := m || '0263 event stages'::text; end if;
  if to_regclass('public.payment_schedule_settings') is null then m := m || '0264 payment schedules'::text; end if;
  if to_regclass('public.crew_availability') is null then m := m || '0265 crew availability & shifts'::text; end if;
  if to_regclass('public.notification_inbox_state') is null then m := m || '0266 notification inbox'::text; end if;
  if cardinality(m) > 0 then
    raise exception 'STOP r24 PRECHECK: R23 is not fully applied on this database (missing: %) - nothing was changed. Paste APPLY-R23-STAGING.sql first (check its last grid: every row ok = true), then this file again.',
      array_to_string(m, ' ; ');
  end if;
end $$;
`;
const out = `-- APPLY-R24.sql - ONE paste for the Supabase SQL editor: every database change of release/r24-staging
-- (round 24: stock one flow, run-sheet reminders + Automations + enquiry-form leads). Plain words and the resources
-- flow (also in R24) need no database change.
-- GENERATED by scripts/gen-apply-r24.mjs from the paste files below - edit those, not this.
-- Run on STAGING first, check the last result grid, then on PRODUCTION only when the owner says go.
-- REQUIRES R23 (APPLY-R23-STAGING.sql: 0257, 0261 - 0266) already applied: the first block (PRECHECK, read-only)
-- stops before any change and names the file to paste first if any of it is missing.
--
-- What it runs, in this order (each section is that file unchanged; each migration in its own transaction):
${list}
-- Additive only: new tables / columns (nullable or defaulted) / functions / triggers; three functions replaced in
-- place by 0268 (_checkout_free, checkout_availability, _r22_close_checks); the 0184 trial purge / keep lists patched
-- in place by 0269. Nothing is dropped, deleted or overwritten.
-- Safe to paste twice: every section is idempotent (the second paste changes nothing).
-- If a section stops with an error, fix the cause and paste the whole file again (finished sections are kept).
-- After it: redeploy the edge function comms-dispatch (--no-verify-jwt) for the run-sheet reminder and enquiry
-- reply lanes. pg_cron: 0269 schedules helm_runsheet_reminders (every 5 min) only when pg_cron is already installed.
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

const MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];   // imported by a test: build only, write nothing
if (!MAIN) { /* nothing */ } else if (process.argv.includes('--check')) {
  const cur = existsSync(ROOT + OUT) ? r(OUT) : '';
  if (cur !== out) { console.error(`${OUT} is out of date - run: node scripts/gen-apply-r24.mjs`); process.exit(1); }
  console.log(`${OUT} is current (${sections.length} sections)`);
} else {
  writeFileSync(ROOT + OUT, out);
  console.log(`wrote ${OUT} (${sections.length} sections, ${verify.length} VERIFY blocks)`);
}
