#!/usr/bin/env node
/*
 * r38-rename-settings.mjs - R38: the studio admin area is called "Settings" (it was "Control Center").
 *
 * Re-applies the TEXT rename across the app, so it can be redone cleanly after other branches that
 * still say the old name are merged:
 *
 *   node scripts/r38-rename-settings.mjs           rewrite the files in place, list what changed
 *   node scripts/r38-rename-settings.mjs --check   exit 1 if any file still says the old name (CI-safe, writes nothing)
 *
 * After a rewrite: node scripts/build-manual.mjs && node scripts/gen-csp.mjs, bump the ?v= of every changed
 * script, then npm run ci.
 *
 * Only words change. URLs (/control, control.html), ids, function names, CSS classes and access-area keys
 * ("controls") are left alone. Lower-case "control center" is left alone on purpose: it is a search keyword /
 * alias so people who type the old name still find Settings. A line that contains the marker "r38-keep" is
 * skipped. supabase/migrations is never touched (applied SQL is immutable): older database texts are mapped
 * to the new name at display time by HelmSettingsName in public/store-api.js.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

// where user-visible text lives (+ the tests that assert it)
const DIRS = ['public', 'supabase/functions', 'docs/manual', 'test', 'tests/e2e'];
const FILES = ['scripts/manual-capture.mjs', 'scripts/build-manual.mjs'];
const EXT = new Set(['.html', '.js', '.mjs', '.css', '.ts', '.md', '.json', '.txt']);
const SKIP = new Set(['scripts/r38-rename-settings.mjs', 'test/r38-settings-name.test.mjs']);
const SKIP_DIR = /(^|\/)(node_modules|vendor|\.git)(\/|$)/;

// ordered: the more specific phrases first
const RULES = [
  [/\bThe Control[ -]Cent(?:er|re)'s\b/g, "The Settings page's"],
  [/\b(?:the )?Control[ -]Cent(?:er|re)'s\b/g, "the Settings page's"],
  [/\b(?:the )?Control[ -]Cent(?:er|re) settings\b/g, 'Settings'],
  [/\bThe Control[ -]Cent(?:er|re)\b/g, 'Settings'],
  [/\bthe Control[ -]Cent(?:er|re)\b/g, 'Settings'],
  [/\bControl[ -]Cent(?:er|re)\b/g, 'Settings'],
  [/\bCONTROL[ -]CENT(?:ER|RE)\b/g, 'SETTINGS'],
];
const OLD = /\bControl[ -]Cent(?:er|re)\b|\bCONTROL[ -]CENT(?:ER|RE)\b/;

function walk(dir, out) {
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n), rel = relative(ROOT, p);
    if (SKIP_DIR.test(rel)) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXT.has(extname(n)) && !/\.min\./.test(n)) out.push(rel);
  }
  return out;
}

export function renameText(text) {
  return text.split('\n').map((line) => {
    if (line.includes('r38-keep') || !OLD.test(line)) return line;
    let s = line;
    for (const [re, to] of RULES) s = s.replace(re, to);
    return s;
  }).join('\n');
}

const files = [...new Set([...DIRS.flatMap((d) => walk(join(ROOT, d), [])), ...FILES])].filter((f) => !SKIP.has(f)).sort();
const changed = [];
for (const f of files) {
  let src;
  try { src = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
  if (!OLD.test(src)) continue;
  const out = renameText(src);
  if (out === src) continue;
  changed.push(f);
  if (!CHECK) writeFileSync(join(ROOT, f), out);
}
if (CHECK) {
  if (changed.length) { console.error('r38: still says the old name:\n  ' + changed.join('\n  ')); process.exit(1); }
  console.log('r38: OK - no user-visible "Control Center" left');
} else {
  console.log(changed.length ? 'r38: renamed in ' + changed.length + ' file(s):\n  ' + changed.join('\n  ') : 'r38: nothing to rename');
}
