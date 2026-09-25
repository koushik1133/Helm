#!/usr/bin/env node
/* ============================================================================
 * check-migration-canon.mjs — repository consistency guard for migration canon.
 *
 * READ-ONLY, no database, no network. This is a *repository* guard, NOT proof of
 * database authorization. It fails when the repo's own documentation and SQL
 * drift into a state that could cause a fresh deploy (or a documented re-run) to
 * install the PRE-HARDENING SECURITY DEFINER functions.
 *
 * It intentionally treats a file as "production-designated" only when the docs
 * say so — it does NOT assume every historical mirror is authoritative.
 *
 * Fails (exit 1) when:
 *   A. The canonical deploy README stops warning that the aggregate snapshot
 *      (complete-setup.sql) is incomplete / not the production source of truth.
 *   B. The authoritative hardening phase (phase73) is missing, or any of its
 *      privileged DEFINER functions loses its org-scope check.
 *   C. A security/data-integrity phase file (73/76/77/85) disappears from the
 *      authoritative numbered set.
 * ========================================================================== */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPA = join(ROOT, 'supabase');
let errors = 0;
const fail = (m) => { console.error('  ✗ ' + m); errors++; };
const ok = (m) => console.log('  ✓ ' + m);

/* ---- A. Canonical README must not present the stale snapshot as production -- */
console.log('Migration-canon: deploy documentation:');
const readmePath = join(SUPA, 'full-schema', 'README.md');
if (!existsSync(readmePath)) {
  fail('supabase/full-schema/README.md missing');
} else {
  const r = readFileSync(readmePath, 'utf8');
  // must name the numbered phase files as canonical
  /canonical source of truth[\s\S]{0,80}phaseNN-name\.sql/i.test(r)
    ? ok('README names numbered phaseNN-name.sql as canonical')
    : fail('README must name the numbered phaseNN-name.sql files as the canonical source of truth');
  // must warn complete-setup.sql is not the production deploy path
  (/do not deploy production from `?complete-setup\.sql/i.test(r) ||
   /complete-setup\.sql[^\n]*\bincomplete\b/i.test(r) ||
   /historical bootstrap snapshot/i.test(r))
    ? ok('README warns complete-setup.sql is incomplete / not for production')
    : fail('README must explicitly warn that complete-setup.sql is incomplete and not the production deploy path');
  // must NOT still claim the snapshot "contains everything" (the old false claim)
  /complete-setup\.sql[\s\S]{0,60}contains everything/i.test(r) || /It contains everything below/i.test(r)
    ? fail('README still claims complete-setup.sql "contains everything" — false completeness claim')
    : ok('README no longer claims the snapshot contains everything');
}

/* ---- B. Authoritative hardening present + org-scoped -------------------- */
console.log('Migration-canon: org-isolation hardening (phase73):');
const p73 = join(SUPA, 'phase73-definer-org-isolation-final.sql');
if (!existsSync(p73)) {
  fail('phase73-definer-org-isolation-final.sql missing (org-scoped DEFINER bodies gone)');
} else {
  const sql = readFileSync(p73, 'utf8');
  for (const fn of ['admin_set_role', 'admin_create_user', 'admin_delete_user', 'confirm_quote']) {
    const m = sql.match(new RegExp('create or replace function public\\.' + fn + '\\b[\\s\\S]*?\\$\\$;'));
    if (!m) { fail(`phase73 no longer defines ${fn}`); continue; }
    /current_org_id\s*\(\s*\)/.test(m[0])
      ? ok(`phase73 ${fn} is org-scoped (current_org_id present)`)
      : fail(`phase73 ${fn} lost its org-scope check (current_org_id missing) — cross-tenant risk`);
  }
}

/* ---- C. Security/data-integrity phase files still present -------------- */
console.log('Migration-canon: required security/integrity phases present:');
const required = {
  'phase73': /^phase73-.*\.sql$/,
  'phase76': /^phase76-.*\.sql$/,
  'phase77': /^phase77-.*\.sql$/,
  'phase85': /^phase85-.*\.sql$/,
};
let files = [];
try { files = readdirSync(SUPA); } catch { fail('supabase/ folder unreadable'); }
for (const [label, re] of Object.entries(required)) {
  files.some((f) => re.test(f))
    ? ok(`${label} file present`)
    : fail(`${label} security/data-integrity migration missing from supabase/`);
}

/* ---- D. Root README must not advertise the stale snapshot as the deploy path */
console.log('Migration-canon: root README deploy guidance:');
const rootReadme = join(ROOT, 'README.md');
if (!existsSync(rootReadme)) {
  console.log('  ✓ no root README.md (nothing to check)');
} else {
  const rr = readFileSync(rootReadme, 'utf8');
  // Must NOT tell operators to run complete-setup.sql as a fresh-DB install.
  /complete-setup\.sql`?\**\s*\(run once on a fresh database\)/i.test(rr) ||
  /run .{0,40}complete-setup\.sql.{0,40}(fresh|once)/i.test(rr)
    ? fail('root README instructs running complete-setup.sql as the fresh-DB install — stale/unsafe deploy path')
    : ok('root README does not advertise complete-setup.sql as the install path');
  // If it mentions complete-setup.sql at all, it must carry a do-not-deploy warning.
  if (/complete-setup\.sql/i.test(rr)) {
    /do not deploy|incomplete|historical snapshot|revert/i.test(rr)
      ? ok('root README warns about complete-setup.sql')
      : fail('root README references complete-setup.sql without a do-not-deploy warning');
  } else {
    ok('root README does not reference complete-setup.sql');
  }
}

/* ---- E. Root-level STANDALONE aggregate/mirror files (not part of the ordered
 *        numbered phase sequence, and not the full-schema/ snapshot which its own
 *        README quarantines) must carry a DEPRECATED / DO NOT RUN header when they
 *        contain a NON-org-scoped privileged DEFINER body — otherwise a manual
 *        standalone re-run after phase73 could silently revert org-isolation
 *        (PR-DEPLOY-01). Numbered phaseNN files are canonical: an earlier phase's
 *        pre-scope body is intentionally superseded by phase73 later in the run,
 *        so they are exempt. --- */
console.log('Migration-canon: stale standalone privileged-DEFINER files are quarantined:');
// DEPLOY-01: expanded to every privileged SECURITY DEFINER body that phase73
// re-defines org-scoped. Missing any of these was a guard blind spot (a stale
// non-org-scoped copy could revert tenant isolation undetected).
const PRIV_FNS = [
  'admin_set_role', 'admin_delete_user', 'admin_create_user',
  'confirm_quote', 'create_quote', 'generate_approval_token', 'mark_paid',
];
const DEPRECATED_MARK = /deprecated|do not run|do not deploy|historical/i;
// DEPLOY-01: scan RECURSIVELY (was single-level) so full-schema/** mirrors are
// covered too. Numbered `phaseNN` files at any depth remain exempt — an earlier
// phase's pre-scope body is intentionally superseded by phase73 later in order.
function walkSql(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSql(p, out);
    else if (e.name.endsWith('.sql') && !/^phase\d+/i.test(e.name)) out.push(p);
  }
  return out;
}
let rootSql = [];
try { rootSql = walkSql(SUPA); } catch { fail('supabase/ folder unreadable'); }
let unmarked = 0;
for (const f of rootSql) {
  const rel = f.replace(ROOT + '/', '');
  const sql = readFileSync(f, 'utf8');
  for (const fn of PRIV_FNS) {
    const m = sql.match(new RegExp('create or replace function public\\.' + fn + '\\b[\\s\\S]*?\\$\\$;'));
    if (!m) continue;
    if (/current_org_id\s*\(\s*\)/.test(m[0])) continue; // org-scoped body → safe
    const header = sql.slice(0, 800);
    if (!DEPRECATED_MARK.test(header)) {
      fail(`${rel} defines non-org-scoped ${fn} but has no DEPRECATED/DO NOT RUN header — standalone re-run could revert phase73`);
      unmarked++;
    }
  }
}
if (!unmarked) ok('all standalone non-org-scoped privileged DEFINER mirrors carry a DEPRECATED/DO NOT RUN marker');

console.log('');
if (errors) { console.error(`FAILED — ${errors} migration-canon problem(s).`); process.exit(1); }
console.log('Migration-canon checks passed.');
