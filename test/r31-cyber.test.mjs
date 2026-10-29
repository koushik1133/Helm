// r31 cyber review (2026 attack classes) - static guards that also run in GitHub CI (which skips the Deno harness).
// 1  rate limits key on Cloudflare's cf-connecting-ip, not the caller-typed first x-forwarded-for hop (edge + DB 0281)
// 2  every edge-function fetch refuses redirects (SSRF / CVE-2025-21620-style credential leak on redirect)
// 3  razorpay-webhook: non-INR never settles at face value; an event without a payment id must be fresh
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('edge clientIp trusts cf-connecting-ip before x-forwarded-for', () => {
  const s = read('supabase/functions/_shared/limits.ts');
  const i = s.indexOf('export function clientIp'), body = s.slice(i, s.indexOf('\n}\n', i));
  // r57 (0298): cf-connecting-ip (a real IP) first, then the LAST x-forwarded-for hop - never the first one
  assert.ok(body.indexOf('cf-connecting-ip') > 0 && body.indexOf('cf-connecting-ip') < body.indexOf('x-forwarded-for'));
  assert.match(body, /for \(let i = hops\.length - 1; i >= 0; i--\)/);
  assert.ok(!/split\(","\)\[0\]/.test(body), 'never the first x-forwarded-for entry');
});

t('no edge function reads x-forwarded-for on its own (one helper only)', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const hits = walk(join(ROOT, 'supabase/functions')).filter((p) => /\.(ts|mjs|js)$/.test(p))
    .filter((p) => /x-forwarded-for/.test(readFileSync(p, 'utf8')) && !p.endsWith('_shared/limits.ts'));
  assert.deepEqual(hits, []);
});

t('every edge-function fetch() refuses redirects (redirect: "error") or goes through a safeFetch wrapper', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const bad = [];
  for (const p of walk(join(ROOT, 'supabase/functions')).filter((x) => /\.(ts|mjs|js)$/.test(x))) {
    const lines = readFileSync(p, 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/(^|[^A-Za-z_.])fetch\(/.test(l) || /^\s*\/\//.test(l)) return;
      const win = lines.slice(i, i + 4).join('\n');            // the init object may continue on the next lines
      if (!/redirect: "error"/.test(win)) bad.push(p.replace(ROOT + '/', '') + ':' + (i + 1));
    });
  }
  assert.deepEqual(bad, [], 'fetch without redirect:"error": ' + bad.join(', '));
});

t('razorpay-webhook: non-INR paid events go to reconciliation (amount blank), never settled at face value', () => {
  const s = read('supabase/functions/razorpay-webhook/index.ts');
  assert.match(s, /const payCur = String\(payEnt\.currency \|\| linkEnt\.currency \|\| "INR"\)/);
  assert.match(s, /const paidPaise = payCur === "INR" \? Number\(/);
});

t('razorpay-webhook: an event without a payment id is used only while fresh (no replay)', () => {
  const s = read('supabase/functions/razorpay-webhook/index.ts');
  const i = s.indexOf('if (!payId) {');
  assert.ok(i > 0 && i < s.indexOf('admin = db();'), 'the freshness check runs before razorpay_settle');
  assert.match(s.slice(i, i + 600), /RAZORPAY_EVENT_MAX_AGE_SEC/);
});

t('0281: DB helpers read cf-connecting-ip first; listed in MANIFEST; additive (no drop / delete / truncate)', () => {
  const m = read('supabase/migrations/0281_client_ip_trust.sql');
  assert.match(m, /coalesce\(nullif\(btrim\(coalesce\(h ->> 'cf-connecting-ip', ''\)\), ''\),\s*\n\s*nullif\(btrim\(split_part\(coalesce\(h ->> 'x-forwarded-for'/);
  for (const f of ['_r24_ip_hash', '_r24s_ip_hash', '_pkg_req_meta', 'tg_consent_snapshot'])
    assert.match(m, new RegExp('create or replace function public\\.' + f + '\\(\\)[\\s\\S]{0,200}r31-client-ip-0281'));
  const code = m.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\b(drop|delete|truncate|alter\s+table)\b/i);
  assert.match(read('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0281_client_ip_trust\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /R31-CLIENT-IP-0281: ALL PASS/);
});

console.log(`r31-cyber: ${n} checks passed`);
