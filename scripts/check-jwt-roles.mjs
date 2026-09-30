#!/usr/bin/env node
/* ============================================================================
 * check-jwt-roles.mjs — no privileged JWT may ever be committed.
 *
 * Scans every tracked text file (`git ls-files`) for JWT-shaped strings
 * (eyJ<header>.eyJ<payload>.<signature>), base64url-decodes the payload and
 * FAILS (exit 1) when any token:
 *   - has a `role` other than "anon" (e.g. service_role, authenticated, missing), or
 *   - carries a `service_role` claim/value anywhere in its payload.
 *
 * Only `file:line` and the offending role are printed — never the token itself.
 * The committed Supabase anon keys (public/config.js) are role=anon and pass.
 * Complements gitleaks (.gitleaks.toml allowlists those exact anon literals).
 *
 * Usage: node scripts/check-jwt-roles.mjs      (wired into `npm run ci` / CI)
 * ========================================================================== */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// header.payload.signature — both header and payload are base64url JSON ("eyJ" = '{"').
export const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

export function decodePayload(token) {
  try {
    const seg = token.split('.')[1];
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Classify one token: null when acceptable, else a short reason (never the token).
export function problemWith(token) {
  const p = decodePayload(token);
  if (!p || typeof p !== 'object') return null;     // JWT-shaped but not JSON → not a credential
  if (JSON.stringify(p).includes('service_role')) return 'service_role claim';
  if (p.role !== 'anon') return `role=${p.role === undefined ? '(none)' : String(p.role).slice(0, 32)}`;
  return null;
}

// Scan one file's text; returns [{ file, line, reason }].
export function scanText(text, file = '<text>') {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(JWT_RE)) {
      const reason = problemWith(m[0]);
      if (reason) out.push({ file, line: i + 1, reason });
    }
  }
  return out;
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function scanRepo(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const findings = [];
  let scanned = 0, tokens = 0;
  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;                      // deleted in the working tree
    let st; try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > 20 * 1024 * 1024) continue;
    const buf = readFileSync(abs);
    if (isProbablyBinary(buf)) continue;
    const text = buf.toString('utf8');
    scanned++;
    tokens += (text.match(JWT_RE) || []).length;
    findings.push(...scanText(text, rel));
  }
  return { findings, scanned, tokens };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  console.log('JWT roles (tracked files):');
  const { findings, scanned, tokens } = scanRepo(ROOT);
  if (findings.length) {
    for (const f of findings) console.error(`  ✗ ${f.file}:${f.line} — JWT with ${f.reason} (must be role=anon; never commit service_role)`);
    console.error(`\nFAILED — ${findings.length} privileged/non-anon JWT(s) in tracked files.`);
    process.exit(1);
  }
  console.log(`  ✓ ${tokens} JWT(s) across ${scanned} tracked text files — all role=anon`);
}
