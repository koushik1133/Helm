// gen-apply-release-1019.mjs - builds supabase/APPLY-RELEASE-1019.sql: ONE paste for the Supabase SQL editor with
// every database change of release/1019 (round 19: the migrations written after release 1018-c, which is in production
// with 0206 / 0207 / 0208 / 0236 / 0237), in MANIFEST (= numeric) order:
//   APPLY-0210 (sign-up invite check + studio location), APPLY-0211 (trial quotes not capped + "no package"),
//   APPLY-0212 (trial client e-mail), APPLY-0213 (sample event floor plans), APPLY-0220 ("New quote" never reuses a
//   used draft + booklet sections), APPLY-0222 (sample re-pricing alerts), APPLY-0223 (trial end date in the studio zone)
//   - each paste file verbatim, each in its own begin / commit - then ONE combined VERIFY grid (the last result the
//   editor shows; every row must say ok = true).
// No temp tables, no session settings, no psql meta-commands; safe to paste twice (every section is idempotent).
//   node scripts/gen-apply-release-1019.mjs           rewrite supabase/APPLY-RELEASE-1019.sql
//   node scripts/gen-apply-release-1019.mjs --check   exit 1 if it is out of date
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const r = (p) => readFileSync(ROOT + p, 'utf8');
const OUT = 'supabase/APPLY-RELEASE-1019.sql';

// plain-words header for each section (what it does for the owner, in one or two lines)
const WHAT = {
  '0210': 'Sign-up: "You have been invited to join <Studio>" check before a trial / paid sign-up (service role only: studio + role, never the token) and the trial welcome\'s City + State + Country India step.',
  '0211': 'Free trial: quotes / events are no longer capped (the 2-new cap stays for the other lists), trial terms version trial-2026-10-19, NEW clear_menu_template ("No package - decide later"; dishes kept).',
  '0212': 'Free trial: e-mail to clients really goes out (30 a day per studio, 5 a day per address; demo events never), WhatsApp / SMS / payment links stay off; owner switch trial_email_settings.enabled.',
  '0213': 'Free-trial sample events SMP-1000 / 1002 / 1004 / 1005 / 1006 get real floor plans on their empty layout version (sample master only; one new sample version for NEW trials).',
  '0220': '"New quote" reuses a draft only when nothing was put into it (otherwise a new quote); the booklet link turns on floor plan + 3D once a layout is saved and its sections can be switched in place.',
  '0222': 'Re-pricing alerts skip sample data, confirmed and client-approved / paid quotes; the sample master\'s open quotes are priced at its own chair rate 100; one new sample version for NEW trials.',
  '0223': 'Trial end date and days left in the studio\'s time zone on every screen (my_trial_status + hq_trial_info re-issued, same signatures; no row written).',
};
// the release = these migrations, in MANIFEST order. FROZEN once shipped: later work gets its own paste file.
export const RELEASE_1019 = ['0210', '0211', '0212', '0213', '0220', '0222', '0223'];

const man = r('supabase/migrations/MANIFEST');
const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((m) => m[1]).filter((n) => RELEASE_1019.includes(n));
if (nums.join() !== RELEASE_1019.join()) throw new Error('MANIFEST does not list the 1019 migrations once each, in order: ' + nums.join());
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
const out = `-- APPLY-RELEASE-1019.sql - ONE paste for the Supabase SQL editor: every database change of release/1019
-- (round 19: trial sign-up + welcome, trial quotes / e-mail, builder sample floor plans, live QA fixes).
-- GENERATED by scripts/gen-apply-release-1019.mjs from the paste files below - edit those, not this.
-- Run on STAGING first, check the last result grid, then on PRODUCTION only when the owner says go.
-- Works on a database at the current production state (release 1018-c: migrations up to 0208 + 0236 + 0237).
--
-- What it runs, in this order (each section is that file unchanged; each migration in its own transaction):
${list}
-- Rows are only written where a section says so: 0212 (the one-row trial_email_settings + its own bookkeeping of the
-- replaced function bodies), 0213 (the sample master's empty sample floors + one new sample version), 0222 (the sample
-- master's 5 open sample quotes re-priced at its own chair rate, its confirmed sample events' sample milestones /
-- advance follow, + one new sample version). Existing free trials and paid studios are not changed. Everything else is new
-- tables / one nullable column, functions, wrappers (old bodies kept as *__pre0212), triggers, policies and grants;
-- 0211 drops only the three trial cap TRIGGERS on public.quotes. Nothing else is deleted or overwritten.
-- Safe to paste twice: every section is idempotent (the second paste changes nothing).
-- If a section stops with an error, fix the cause and paste the whole file again.
-- After it: redeploy the edge functions and deploy the site together (docs/release/RELEASE-1019-OWNER-STEPS.md) -
-- the free-trial terms version becomes trial-2026-10-19 here and in public/trial-facts.js.
--
-- The LAST result grid is the combined VERIFY: every row must say ok = true.
${body}
-- ##########################################################################################
-- COMBINED VERIFY (every section's checks; every row must say ok = true)
-- ##########################################################################################
select item, ok from (
${verify.join('\nunion all\n')}
) z order by item;
`;

if (process.argv.includes('--check')) {
  const cur = existsSync(ROOT + OUT) ? r(OUT) : '';
  if (cur !== out) { console.error(`${OUT} is out of date - run: node scripts/gen-apply-release-1019.mjs`); process.exit(1); }
  console.log(`${OUT} is current (${sections.length} sections)`);
} else {
  writeFileSync(ROOT + OUT, out);
  console.log(`wrote ${OUT} (${sections.length} sections, ${verify.length} VERIFY blocks)`);
}
