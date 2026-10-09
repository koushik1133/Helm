#!/usr/bin/env node
/* gen-capture-host.mjs — R8b: public/capture.html is GENERATED from public/builder.html.
 *
 *   node scripts/gen-capture-host.mjs          rewrite public/capture.html
 *   node scripts/gen-capture-host.mjs --check  exit 1 if it is stale (CI)
 *
 * capture.html is the builder running headless inside a hidden same-origin iframe from the
 * share checklist: it loads the quote's latest saved layout, renders the 2D + 3D client pictures
 * (with / without labels), uploads them and postMessages the result to its same-origin parent.
 * It is the ONLY app page served with frame-ancestors 'self' (builder.html keeps 'none'); the
 * marker <meta name="helm-capture"> switches builder.js into capture-host mode. Keeping it a
 * generated copy means the capture always uses exactly the builder's drawing code.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
export function captureHtml(builder) {
  let s = builder;
  const must = (re, to) => { if (!re.test(s)) throw new Error('builder.html changed shape: ' + re); s = s.replace(re, to); };
  must(/<title>[^<]*<\/title>/, '<title>Helm Events · preparing pictures</title>\n<meta name="helm-capture" content="1">\n<meta name="robots" content="noindex, nofollow">');
  must(/<!doctype html>\n/i, '<!doctype html>\n<!-- GENERATED from builder.html by scripts/gen-capture-host.mjs — do not edit by hand -->\n');
  s = s.replace(/<script src="tour\.js\?v=\d+"><\/script>\n/, '');   // no product tour in the headless host
  return s;
}
const out = join(PUB, 'capture.html');
const next = captureHtml(readFileSync(join(PUB, 'builder.html'), 'utf8'));
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== next) { console.error('  ✗ public/capture.html is stale — run: node scripts/gen-capture-host.mjs'); process.exit(1); }
  console.log('  ✓ capture.html matches builder.html');
} else if (process.argv[1] && process.argv[1].endsWith('gen-capture-host.mjs')) { writeFileSync(out, next); console.log('  ✓ wrote public/capture.html'); }
