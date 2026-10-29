// r75: every page reached through a studio "pretty" URL (/<slug>/<page>, vercel.json rewrites) must load its scripts
// and styles from the site root. A page with relative src/href and no <base href="/"> resolves them under /<slug>/,
// gets 404s and never boots (discovery + proposal shipped stuck on the loader).
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const vercel = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8'));
const pages = new Set();
for (const r of vercel.rewrites || []) {
  if (!/^\/\(\[a-z0-9-\]\+\)\//.test(r.source)) continue;   // studio-slug routes only
  const d = String(r.destination).replace(/^\//, '').replace(/[?#].*$/, '');
  if (!d || d.includes('$') || d.includes('/')) continue;
  const f = d.endsWith('.html') ? d : d + '.html';
  if (existsSync(new URL('public/' + f, root))) pages.add(f);
}
assert.ok(pages.size > 5, 'found studio-slug pages: ' + pages.size);
const bad = [];
for (const f of pages) {
  const h = readFileSync(new URL('public/' + f, root), 'utf8');
  const relative = /<(script|link)\b[^>]*\b(src|href)="(?![a-z]+:|\/|#|data:)[^"]+"/i.test(h);
  if (relative && !/<base href="\/">/.test(h)) bad.push(f);
}
assert.deepEqual(bad, [], 'studio-slug pages with relative assets but no <base href="/">');
console.log(`r75 pretty-path base: ${pages.size} pages checked, all load assets from the site root`);
