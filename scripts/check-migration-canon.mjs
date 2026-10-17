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
    const header = sql.slice(0, 1400);   // room for the a156guard block + its transaction line above the DEPRECATED marker
    if (!DEPRECATED_MARK.test(header)) {
      fail(`${rel} defines non-org-scoped ${fn} but has no DEPRECATED/DO NOT RUN header — standalone re-run could revert phase73`);
      unmarked++;
    }
  }
}
if (!unmarked) ok('all standalone non-org-scoped privileged DEFINER mirrors carry a DEPRECATED/DO NOT RUN marker');

/* ---- F. (audit run 3, 0156) legacy bundles that redefine the OTP consent function, and every
 *        full-schema file, carry an EXECUTABLE refusal guard (not just a comment), and no SQL file
 *        seeds an account with a literal password. --- */
console.log('Migration-canon: legacy bundles carry an executable refusal guard (0156):');
const SKIP_DIRS = new Set(['migrations', 'canonical-base', 'test-harness', 'tests', 'audit']);
function walkAll(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!(dir === SUPA && SKIP_DIRS.has(e.name))) walkAll(p, out); }
    else if (e.name.endsWith('.sql')) out.push(p);
  }
  return out;
}
const activeSql = (src) => src.split('\n').map((l) => l.split('--')[0]).join('\n');
const GUARD = /do\s+\$a(42|156)guard\$[\s\S]{0,1200}?raise\s+exception/i;
const DDL = /create\s+or\s+replace\s+function|create\s+policy|drop\s+policy|create\s+trigger|alter\s+table|^\s*grant\s|^\s*revoke\s/im;
// the newest MANIFEST migration that (re)defines verify_and_consent: an APPLY-<n> paste copy of that
// layer (or newer) is the current canonical body; an OLDER APPLY copy must refuse to run.
const consentRe = /create\s+or\s+replace\s+function\s+public\.verify_and_consent(__base)?\s*\(/i;
let newestConsent = 0;
for (const line of readFileSync(join(SUPA, 'migrations', 'MANIFEST'), 'utf8').split('\n')) {
  const m = line.match(/^forward\s+(supabase\/migrations\/(\d{4})_\S+\.sql)/);
  if (m && consentRe.test(activeSql(readFileSync(join(ROOT, m[1]), 'utf8')))) newestConsent = Math.max(newestConsent, Number(m[2]));
}
let unguarded = 0, literalPw = 0;
for (const f of walkAll(SUPA)) {
  const rel = f.replace(ROOT + '/', '');
  const sql = readFileSync(f, 'utf8');
  const act = activeSql(sql);
  const head = sql.slice(0, 4000);
  const applyN = (f.match(/\/APPLY-(\d{4})(?:-(\d{4}))?\.sql$/) || []);
  const applyTop = applyN[0] ? Number(applyN[2] || applyN[1]) : 0;
  const redefinesConsent = consentRe.test(act) && !(applyTop && applyTop >= newestConsent);
  const fullSchema = /\/full-schema\//.test(f) && DDL.test(act);
  if ((redefinesConsent || fullSchema) && !GUARD.test(head)) {
    fail(`${rel} ${redefinesConsent ? 'redefines verify_and_consent' : 'is a full-schema DDL file'} but has no executable refusal guard (a156guard) at the top`);
    unguarded++;
  }
  if (/create_helm_user\s*\(\s*'[^']*'\s*,\s*'[^']*'/i.test(act)) {
    fail(`${rel} seeds an account with a literal password (create_helm_user(..., '<literal>', ...))`);
    literalPw++;
  }
}
if (!unguarded) ok('every legacy verify_and_consent redefinition and full-schema file refuses to run on a current DB');
// the refusal must sit INSIDE a transaction: under psql -f without ON_ERROR_STOP a bare DO-block
// error is skipped and the rest of the old bundle would still run.
let bareGuard = 0;
for (const f of walkAll(SUPA)) {
  const sql = readFileSync(f, 'utf8');
  const re = /do\s+\$a(42|156)guard\$/gi; let m;
  while ((m = re.exec(sql))) {
    const before = activeSql(sql.slice(0, m.index));
    const last = (rx) => { let i = -1, x; rx.lastIndex = 0; while ((x = rx.exec(before))) i = x.index; return i; };
    const lastBegin = last(/^\s*begin\s*;/gim);
    const lastCommit = last(/^\s*(commit|rollback)\s*;/gim);
    if (lastBegin < 0 || lastCommit > lastBegin) { fail(`${f.replace(ROOT + '/', '')} has an a${m[1]}guard refusal outside a transaction (psql would carry on)`); bareGuard++; break; }
  }
}
if (!bareGuard) ok('every legacy refusal guard runs inside a transaction (a failed guard stops the whole bundle under psql too)');
if (!literalPw) ok('no SQL file seeds an account with a literal password');

console.log('');
if (errors) { console.error(`FAILED — ${errors} migration-canon problem(s).`); process.exit(1); }
console.log('Migration-canon checks passed.');
