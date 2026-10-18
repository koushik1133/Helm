// gen-apply-release-1018.mjs - builds supabase/APPLY-RELEASE-1018.sql: ONE paste for the Supabase SQL
// editor with every database change of release/trial-and-fixes-1018, in the canonical MANIFEST order:
//   1. the trial bundle: APPLY-0173 .. APPLY-0187 (each file that exists, as in APPLY-TRIAL-BUNDLE.sql),
//      then FIX-0177-existing-trials.sql,
//   2. APPLY-0189 .. APPLY-0205 (each file that exists, verbatim, each in its own begin / commit),
//   3. APPLY-0178-refresh-trials.sql LAST, so the existing trial studios move to the newest sample with
//      every release rule already installed,
//   4. ONE combined VERIFY grid (the last result the editor shows; every row must say ok = true).
// Every section is the reviewed paste file unchanged under a plain-words header, so the bundle is exactly
// "paste them one by one". No temp tables, no session settings; safe to paste twice (every section is
// idempotent).
//   node scripts/gen-apply-release-1018.mjs           rewrite supabase/APPLY-RELEASE-1018.sql
//   node scripts/gen-apply-release-1018.mjs --check   exit 1 if it is out of date
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const r = (p) => readFileSync(ROOT + p, 'utf8');
const OUT = 'supabase/APPLY-RELEASE-1018.sql';
export const LAST_MIGRATION = 205;

// plain-words header for each section (what it does for the owner, in one or two lines)
const WHAT = {
  '0173': 'Free-trial lockdown: 2 own rows per main list, no new catalog items, no studio-settings / export changes; paid studios unchanged.',
  '0174': 'Every trial seed ("Load demo data", sign-up) uses the CURRENT published sample, never the old built-in demo.',
  '0175': 'Trial sample gets the owner\'s 3 layout templates (one theatre sample archived, never deleted).',
  '0176': 'Trial client portal: "Skip OTP" for the test client, and the trial event shows confirmed after it.',
  '0177': 'Free trial is India only: new trials land on INR / Asia/Kolkata / GST and stay there.',
  '0179': 'No real client message from a free-trial studio (approval code, WhatsApp, e-mail); seat limit admin + 2.',
  '0180': 'Trial sign-up: every new trial starts WITH the sample data + India defaults + the welcome tour.',
  '0181': 'More free-trial server guards: layout templates, reminder days, privacy PIN, custom fields; 2 created in total per list.',
  '0182': 'Trial layout builder prices items at the owner\'s inventory rates (chair 100).',
  '0183': 'An ended, unpaid free trial is read-only for everyone.',
  '0184': 'Trial data retention: upgrade reminder 7 days after the trial ends; deletion stays SWITCHED OFF.',
  '0185': 'Upgrade data choice: keep / remove sample data, or start clean (archive, never delete).',
  '0186': 'One free trial per studio / e-mail; one trial extension that only Helm HQ can grant.',
  '0187': 'Ended trials queue no payment reminders; no real Razorpay link from a trial studio.',
  'FIX-0177': 'Existing free-trial studios corrected to the India defaults (5 columns of trial studios only).',
  '0189': 'One quote status label everywhere ("sent - awaiting client approval" until the client approves).',
  '0190': 'Faster free-trial sign-up and sample clone (stays far inside the 8 second API limit).',
  '0192': 'Menu packages: the database refuses a cleared / zero price or an active package with no dishes.',
  '0194': 'Event group "Add people": staff / vendors / client as group contacts (nothing is sent).',
  '0195': 'Invitation website "Send to client" (queued e-mail / WhatsApp; free trial = skipped).',
  '0196': 'Budget & margin from the client\'s requirements (4 nullable columns on event_costs, no row changed).',
  '0197': 'Over-capacity decision on a quote + stock-shortage sourcing on "Reserve for this event".',
  '0198': 'Event stages: no closing before the event day, Cancel event, calendar conflict acknowledgements.',
  '0199': 'Budget + guests single source: the quote leads; EMPTY lead / discovery values are filled, never overwritten.',
  '0200': 'Client booklet "Send to client" (queued e-mail / WhatsApp; free trial = skipped).',
  '0201': 'Release integration fix: sign-up keeps the one-trial-per-e-mail guard; retention list knows group contacts.',
  '0203': 'Free-trial server gates: no client greeting, fixed sample menu dishes, no activity log, no template edits, checkout says "trial".',
  '0204': 'Signed-out (anon) API tidy: no table grants / "to public" studio policies on 6 tables (link pages use their own functions).',
  '0205': 'Team invitations: a brand-new invitee can always join (service-role helpers for the invite edge functions).',
  '0178': 'LAST: every existing FREE-TRIAL studio is refreshed to the newest sample (its sample rows re-cloned, its own rows kept).',
};

const sections = [];
for (let n = 173; n <= 187; n++) {
  const p = `supabase/APPLY-0${n}.sql`;
  if (existsSync(ROOT + p)) sections.push({ n: '0' + n, p });
}
sections.push({ n: 'FIX-0177', p: 'supabase/FIX-0177-existing-trials.sql' });
for (let n = 188; n <= LAST_MIGRATION; n++) {
  const p = `supabase/APPLY-0${n}.sql`;
  if (existsSync(ROOT + p)) sections.push({ n: '0' + n, p });
}
sections.push({ n: '0178', p: 'supabase/APPLY-0178-refresh-trials.sql' });

const VSTART = 'select item, ok from (values\n';
const VEND_AT = '\n) v(item, ok) order by item;';
const BVSTART = '-- COMBINED VERIFY (read-only): every row must say ok = true\n';
const verify = [];
let body = '';
sections.forEach((s, i) => {
  const src = r(s.p).replace(/\s*$/, '\n');
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(src)) throw new Error(s.p + ': not ASCII');
  if (/^\s*\\/m.test(src)) throw new Error(s.p + ': psql meta-command (not pasteable)');
  if (/\bcreate\s+(temp|temporary)\s+table\b/i.test(src)) throw new Error(s.p + ': temp table (not pasteable)');
  if (!WHAT[s.n]) throw new Error(s.p + ': no plain-words header in WHAT');
  body += `\n-- ##########################################################################################\n`
        + `-- RELEASE SECTION ${String(i + 1).padStart(2, '0')}/${sections.length}: ${s.p.replace('supabase/', '')}\n`
        + `-- In plain words: ${WHAT[s.n]}\n`
        + `-- ##########################################################################################\n` + src;
  if (/^0\d{3}$/.test(s.n) && s.n !== '0178') {
    // the VERIFY grid is the last "select item, ok from (values ... ) v(item, ok) order by item;" of the file
    // (a read-only INFO query may follow it, e.g. 0204)
    const at = src.lastIndexOf(VSTART), end = at < 0 ? -1 : src.indexOf(VEND_AT, at);
    if (at < 0 || end < 0) throw new Error(s.p + ': VERIFY block missing or not in the expected shape');
    const rows = src.slice(at + VSTART.length, end);
    verify.push(`select '${s.n} ' || item as item, ok from (values\n${rows}\n) v(item, ok)`);
  } else if (s.n === 'FIX-0177') {
    const m = src.match(/-- 3\) VERIFY[^\n]*\n(select [\s\S]*?);\s*$/);
    if (!m) throw new Error(s.p + ': VERIFY query not found');
    verify.push(`select 'FIX-0177 no self-serve trial studio left off the India defaults' as item,\n  not exists (\n${m[1]}\n) as ok`);
  } else {
    const m = src.match(/-- ---- 3\) VERIFY[^\n]*\n(select [\s\S]*?);\s*$/);
    if (!m) throw new Error(s.p + ': VERIFY query not found');
    verify.push(`select 'REFRESH-0178 every trial studio on the current sample, India, 4 sample venues, no queued send' as item,\n  not exists (select 1 from (\n${m[1]}\n) z where not coalesce(z.ok, false)) as ok`);
  }
});

const list = sections.map((s, i) => `--   ${String(i + 1).padStart(2, '0')}  ${s.p.replace('supabase/', '').padEnd(32)} ${WHAT[s.n]}`).join('\n');
const out = `-- APPLY-RELEASE-1018.sql - ONE paste for the Supabase SQL editor: every database change of the
-- release/trial-and-fixes-1018 merge (free-trial bundle + the Control Center / quote / event fixes).
-- GENERATED by scripts/gen-apply-release-1018.mjs from the paste files below - edit those, not this.
-- Run on STAGING first, check the last result grid, then on PRODUCTION only when the owner says go.
-- Works on a database at the current production state (migrations up to 0172).
--
-- What it runs, in this order (each section is that file unchanged; each migration in its own transaction):
${list}
-- Rows are only written where a section says so: FIX-0177 (India defaults on existing FREE-TRIAL studios),
-- 0182 (the sample master studio's builder rates), 0199 (fills EMPTY event budget / guest values from the
-- other copy - never overwrites a value that is there) and, LAST, REFRESH-0178 (each existing FREE-TRIAL
-- studio's SAMPLE rows are cleared and cloned again from the newest sample; the studio's own rows are kept).
-- Paid studios are not changed. Everything else is functions, triggers, policies, grants, new tables and
-- nullable columns.
-- Nothing is deleted outside the trial sample refresh: the trial retention deletion (0184) is installed
-- SWITCHED OFF.
-- Safe to paste twice: every section is idempotent (the second paste changes nothing).
-- If a section stops with an error, fix the cause and paste the whole file again.
--
-- The LAST result grid is the combined VERIFY: every row must say ok = true. Expected false rows: 0184
-- row 03 only once the owner switched trial deletion on; 0174 row 04 and 0190 row 06 while the sample
-- switch (helm_sample_template.active) is still off.
${body}
-- ##########################################################################################
-- RELEASE COMBINED VERIFY (read-only): every row must say ok = true
-- ##########################################################################################
${verify.join('\nunion all\n')}
order by 1;
`;
if (/[^\x09\x0a\x0d\x20-\x7e]/.test(out)) throw new Error('release bundle is not ASCII');
if (process.argv.includes('--check')) {
  let cur = ''; try { cur = r(OUT); } catch {}
  if (cur !== out) { console.error(OUT + ' is out of date (node scripts/gen-apply-release-1018.mjs)'); process.exit(1); }
  console.log('  ok ' + OUT + ' up to date (' + sections.length + ' sections)');
} else {
  writeFileSync(ROOT + OUT, out);
  console.log('wrote ' + OUT + ' (' + sections.length + ' sections, ' + verify.length + ' VERIFY blocks)');
}
