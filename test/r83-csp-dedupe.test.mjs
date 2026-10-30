// r83: vercel.json must stay under Vercel's 204,800-byte config limit. Pages that share one
// Content-Security-Policy share ONE headers rule (a combined "source"), instead of repeating
// the ~9 KB policy per page group. Vercel applies every matching rule in order (later wins),
// so a policy may repeat only where a later rule must re-assert it over an earlier one:
//   - /:studio/(proposal|portal|booklet)/:ref  re-asserts the portal policy over /i/(.*) (slug "i")
//   - the builder rule re-asserts the catch-all policy over /i/(.*) (/i/builder, /i/events/x/floor-plan)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const raw = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
const v = JSON.parse(raw);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const ORDER_REQUIRED = new Set(['/([a-z0-9-]+)/(proposal|portal|booklet)/([^/]+)',
  '/(builder|try|builder\\.html|try\\.html|[a-z0-9-]+/events/[^/]+/floor-plan|[a-z0-9-]+/builder)']);

t('vercel.json stays well below the 204,800-byte Vercel limit (< 190,000)', () => {
  assert.ok(Buffer.byteLength(raw) < 190000, 'vercel.json is ' + Buffer.byteLength(raw) + ' bytes');
});
t('no CSP value is repeated across header rules (except the documented order-required re-assertions)', () => {
  const seen = new Map();
  for (const r of v.headers) for (const h of r.headers) {
    if (!/^content-security-policy(-report-only)?$/i.test(h.key)) continue;
    const k = h.key.toLowerCase() + '\n' + h.value;
    if (seen.has(k) && !ORDER_REQUIRED.has(r.source)) assert.fail(`${r.source} repeats the ${h.key} of ${seen.get(k)} - merge them into one rule`);
    if (!seen.has(k)) seen.set(k, r.source);
  }
});
t('the order-required re-assertions are still present (removing them would change /i/... pages)', () => {
  for (const s of ORDER_REQUIRED) assert.ok(v.headers.some((r) => r.source === s && r.headers.some((h) => /content-security-policy/i.test(h.key))), s);
});
console.log(`r83-csp-dedupe: ${n} passed`);
