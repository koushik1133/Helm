#!/usr/bin/env node
/* ============================================================================
 * check-otp-safety.mjs — regression guard for PR-AUTH-01 (hardcoded OTP bypass).
 *
 * READ-ONLY, no database, no network. Scans every supabase/**.sql file for a
 * hardcoded/predictable OTP assignment (e.g. `code := '123456'`). Such a fixed
 * PIN let any holder of a quote's approval_token guess the code and self-approve.
 *
 * Fails (exit 1) when any SQL assigns the OTP `code` variable to a string
 * literal (a fixed PIN). The safe implementation derives the code at runtime
 * (e.g. lpad((floor(random()*1000000))::int::text,6,'0')), which this guard
 * allows because it is not a quoted literal.
 * ========================================================================== */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUPA = join(ROOT, 'supabase');
let errors = 0;
const fail = (m) => { console.error('  ✗ ' + m); errors++; };
const ok = (m) => console.log('  ✓ ' + m);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.sql')) out.push(p);
  }
  return out;
}

// Strip SQL comments so documentation mentioning 123456 is not flagged.
// Removes -- line comments and /* */ block comments.
function stripComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/--[^\n]*/g, ' ');           // line comments
}

// A PIN-like literal is a quoted run of >=4 digits ('123456', '0000'). The
// legitimate random pattern's only quoted literal is the lpad pad char '0'
// (length 1), so it is not flagged.
const PIN_LITERAL = /'[0-9]{4,}'/;

// An assignment to a var, capturing the RHS up to the statement terminator ';'.
// Comments already stripped, so this spans line breaks (defeats line-splitting).
const ASSIGN = /(\b[a-z_][a-z0-9_]*)\s*:=\s*([^;]*)/gi;

console.log('OTP-safety: scanning supabase/**.sql for hardcoded OTP PINs:');
let files = [];
try { files = walk(SUPA); } catch { fail('supabase/ folder unreadable'); }

let flagged = 0;
for (const f of files) {
  const rel = f.replace(ROOT + '/', '');
  const src = stripComments(readFileSync(f, 'utf8'));
  // Only care about files that actually define request_otp / handle an OTP code.
  if (!/request_otp|\bcode\b|\botp\b/i.test(src)) continue;
  let m;
  ASSIGN.lastIndex = 0;
  while ((m = ASSIGN.exec(src)) !== null) {
    const lhs = m[1].toLowerCase();
    const rhs = m[2];
    const rhsHead = rhs.replace(/^\s+/, '');
    // The dangerous pattern is assigning the OTP code ITSELF to a fixed literal.
    // Flag when either:
    //   (a) the LHS is an OTP code variable (code/pin/otp, incl. v_code/otp_code), or
    //   (b) the RHS *is* a bare PIN literal being assigned as the value (optionally
    //       wrapped in the padding helpers a fixed PIN would use) — this still
    //       catches indirection like `x := '123456'`.
    // This deliberately does NOT flag a PIN literal that merely appears as an
    // ARGUMENT to another function call, e.g. a TEST calling
    // `res := verify_and_consent('<phone>','123456',...)`, which is legitimate
    // fixture input and not a hardcoded generation-path PIN. Production protection
    // is unchanged: a real `code := '123456'` in request_otp is still caught.
    const lhsIsCodeLike = /(^|_)(code|pin|otp)(_|$)/.test(lhs);
    const rhsIsBarePinLiteral = /^(?:lpad\s*\(\s*|rpad\s*\(\s*|trim\s*\(\s*)*'[0-9]{4,}'/.test(rhsHead);
    const pinLiteral = PIN_LITERAL.test(rhs) && (lhsIsCodeLike || rhsIsBarePinLiteral);
    const chrBuilt = lhsIsCodeLike && /chr\s*\(/i.test(rhs);
    if (pinLiteral || chrBuilt) {
      const upto = src.slice(0, m.index);
      const lineNo = upto.split('\n').length;
      fail(`${rel}:${lineNo} assigns ${lhs} from a hardcoded/predictable value — possible fixed OTP PIN (PR-AUTH-01)`);
      flagged++;
    }
  }
}
if (!flagged) ok(`no hardcoded/predictable OTP assignment in ${files.length} SQL file(s)`);

// OTP-01: any request_otp that can echo the code to the caller (dev_code) MUST
// gate that echo on the explicit otp_dev_echo flag. A body that returns the
// code merely because sms_live is false is a token-holder self-approval bypass.
console.log('OTP-safety: dev_code echo is gated on an explicit dev flag:');
let echoLeaks = 0;
for (const f of files) {
  const rel = f.replace(ROOT + '/', '');
  const raw = readFileSync(f, 'utf8');
  if (!/\brequest_otp\b/.test(raw)) continue;
  const src = stripComments(raw);
  if (!/dev_code/.test(src)) continue;                 // never echoes → nothing to gate
  // the known-leaky shape: dev_code returned via `case when live then ... code`
  const leakyShape = /dev_code'?\s*,\s*case\s+when\s+live\s+then\s+null\s+else\s+code\s+end/i.test(src);
  const gated = /otp_dev_echo/.test(src);              // explicit dev echo flag present
  if (leakyShape || !gated) {
    fail(`${rel}: request_otp echoes dev_code without gating on otp_dev_echo (OTP-01 bypass risk)`);
    echoLeaks++;
  }
}
if (!echoLeaks) ok('every request_otp that echoes dev_code gates it on otp_dev_echo');

// audit run 2 (RC-1 / RC-11): the newest canonical verify_and_consent must reject a NULL /
// malformed code before any crypt() comparison (crypt(NULL, h) <> h is NULL, not true)
{
  const migDir = join(SUPA, 'migrations');
  const migs = readdirSync(migDir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
  let latest = null;
  for (const n of migs) {
    const src = stripComments(readFileSync(join(migDir, n), 'utf8'));
    if (/create\s+or\s+replace\s+function\s+public\.verify_and_consent\s*\(/i.test(src)) latest = { n, src };
  }
  if (!latest) fail('no canonical verify_and_consent found in supabase/migrations');
  else if (!/p_code\s+is\s+null|p_code\s+is\s+distinct\s+from/i.test(latest.src))
    fail(`${latest.n}: verify_and_consent does not reject a NULL code (C-01)`);
  else ok(`${latest.n}: verify_and_consent rejects a NULL / malformed code`);
}

console.log('');
if (errors) { console.error(`FAILED — ${errors} OTP-safety problem(s).`); process.exit(1); }
console.log('OTP-safety checks passed.');
