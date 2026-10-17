// helm-v01-e2e-fixes.test.mjs - static guards for the helm-v01 trial E2E fixes (Oct 2026)
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };

t('Settlements CSV applies the vendor-bills rule (bills replace booked cost, payouts count as paid)', () => {
  assert.match(r('public/reports.html'), /settlement\.summary\(e\.id\);\s*\n\s*if\(BPStore\.settlement\.applyBills\) await BPStore\.settlement\.applyBills\(s,e\.id\)/);
});
t('Budget page + workspace Budget card use the same bills-adjusted margin as Closure', () => {
  const api = r('public/store-api.js');
  assert.match(api, /applyBillsToBudget\(bs, delta\)/); assert.match(api, /async billsDelta\(quoteId\)/);
  assert.match(r('public/budget.html'), /applyBillsToBudget\(sum, await BPStore\.settlement\.billsDelta\(id\)\)/);
  assert.match(r('public/event.html'), /applyBillsToBudget\(budgetSummary,billsDelta\)/);
});
t('Settlement re-reads its summary when a vendor bill / payout changes', () => {
  assert.match(r('public/settlement.html'), /addEventListener\("helm:vendor-bills-changed",\(\)=>\{ if\(!s\) return;/);
});
t('Audit: payout rows resolve their event through the bill', () => {
  assert.match(r('public/store-api.js'), /r\.entity === "vendor_payouts" && !r\.quote_id && r\.changed && m\[r\.changed\.bill_id\]/);
});
t('Chat grid columns cannot be widened by a long thread name', () => {
  const h = r('public/chat.html');
  assert.match(h, /grid-template-columns:min\(380px,34%\) minmax\(0,1fr\)/);
  assert.match(h, /@media\(max-width:760px\)\{\.app\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(h, /\.side\{[^}]*min-width:0/);
});
t('Notices hide while a visible modal or the tour is open', () => {
  const a = r('public/auth-ui.js');
  assert.match(a, /function modalOpen\(\)/); assert.match(a, /modalOpen\(\) \|\| tourActive\(\)/);
  assert.match(a, /\.hau-notes\[hidden\]\{display:none\}/);
});
t('No page hardcodes a Supabase preconnect / dns-prefetch', () => {
  for (const f of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html')))
    assert.doesNotMatch(r('public/' + f), /<link rel="(?:preconnect|dns-prefetch)" href="https:\/\/[a-z0-9]+\.supabase\.co"/, f);
});
t('staging-site rule pairs frame-ancestors self with X-Frame-Options SAMEORIGIN', () => {
  const v = JSON.parse(r('vercel.json'));
  const rule = v.headers.find((x) => x.has && x.has.some((c) => c.value === 'helm-v01.vercel.app') && x.headers[0].key === 'Content-Security-Policy');
  assert.ok(rule); const csp = rule.headers[0].value;
  if (/frame-ancestors 'self'/.test(csp)) assert.deepEqual(rule.headers[1], { key: 'X-Frame-Options', value: 'SAMEORIGIN' });
  // audit run-3: the union no longer widens framing; per-page X-Frame-Options governs
  assert.doesNotMatch(csp, /frame-ancestors/);
  assert.ok(!rule.headers.some((h) => h.key.toLowerCase() === 'x-frame-options'));
});
t('0137 + APPLY-0136-0137: ASCII, chr(183), MANIFEST, verify rows', () => {
  const m = r('supabase/migrations/0137_event_group_title_dot.sql'), a = r('supabase/APPLY-0136-0138.sql');
  assert.ok(/^[\x00-\x7f]*$/.test(m) && /^[\x00-\x7f]*$/.test(a), 'ASCII only');
  assert.match(m, /chr\(183\)/); assert.doesNotMatch(m.replace(/\$\$[\s\S]*?\$\$/g, ''), /\b(drop table|delete from|truncate|update public\.|alter table)/i, 'no top-level data / table change');
  assert.match(r('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0137_event_group_title_dot\.sql/);
  assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m);
  assert.ok(a.includes(r('supabase/migrations/0136_tenant_guard_catchup.sql').trim()), 'APPLY embeds 0136 verbatim');
  assert.ok(a.includes(m.trim()), 'APPLY embeds 0137 verbatim');
  assert.match(a, /as item,/); assert.match(a, /0137 create_event_group uses chr\(183\)/);
  assert.doesNotMatch(r('supabase/migrations/0136_tenant_guard_catchup.sql'), /\('public\.' \|\| t\)::regclass/, '0136 must not cast a missing table name');
});
console.log(`helm-v01-e2e-fixes: ${n} passed`);
