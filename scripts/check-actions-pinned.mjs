#!/usr/bin/env node
/* ============================================================================
 * check-actions-pinned.mjs - every `uses:` in .github/workflows must be pinned to
 * a full 40-character commit SHA with a `# vX.Y.Z` comment (audit run-3
 * supply-chain/github-actions/tag-pinned-not-sha). Mutable tags (@v7, @main)
 * fail. Local actions (./path) and docker:// images with a sha256 digest pass.
 *
 * To re-pin after a Dependabot bump (or by hand), resolve a tag locally:
 *   git ls-remote --tags https://github.com/<owner>/<repo> 'refs/tags/vX.Y.Z*'
 * Use the `^{}` (dereferenced) line for an annotated tag, else the plain line.
 * Dependabot (.github/dependabot.yml) keeps SHA pins current and rewrites the
 * version comment.
 * ========================================================================== */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkWorkflowText(text, file = '<yaml>') {
  const bad = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(#.*)?$/.exec(lines[i]);
    if (!m) continue;
    const ref = m[1].replace(/^['"]|['"]$/g, '');
    if (ref.startsWith('./')) continue;
    if (ref.startsWith('docker://')) { if (!/@sha256:[0-9a-f]{64}$/.test(ref)) bad.push({ file, line: i + 1, ref, why: 'docker image without sha256 digest' }); continue; }
    const at = ref.lastIndexOf('@');
    const sha = at > 0 ? ref.slice(at + 1) : '';
    if (!/^[0-9a-f]{40}$/.test(sha)) { bad.push({ file, line: i + 1, ref, why: 'not pinned to a 40-char commit SHA' }); continue; }
    if (!m[2] || !/#\s*v\d+(?:\.\d+){0,2}\b/.test(m[2])) bad.push({ file, line: i + 1, ref, why: 'missing "# vX.Y.Z" version comment' });
  }
  return bad;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  const bad = files.flatMap((f) => checkWorkflowText(readFileSync(join(dir, f), 'utf8'), '.github/workflows/' + f));
  if (bad.length) {
    for (const b of bad) console.error(`  x ${b.file}:${b.line} ${b.ref} - ${b.why}`);
    console.error(`\nFAILED - ${bad.length} GitHub Action reference(s) not SHA-pinned.`);
    process.exit(1);
  }
  console.log(`Actions pinned: all uses: lines in ${files.length} workflow(s) are full-SHA pins.`);
}
