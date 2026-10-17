// Retest 1017: lead guest cap, New-quote a11y name, contrast, hint size, builder matrix gate, designer create, P&L finance gate, currency mixing
import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8'); let n = 0; const t = (m, f) => { f(); n++; console.log('ok - ' + m); };
t('lead guests capped at 100000 (input + V.count + convert guard)', () => { const h = r('public/leads.html'); assert.match(h, /id="f_guests"[^>]*max="100000"/); assert.match(h, /field:"Guest count",max:100000/); assert.match(h, /guest_count\)>100000/); });
t('New quote button has an aria-label', () => assert.match(r('public/shell-b.js'), /nq\.setAttribute\("aria-label", "New quote"\)/));
t('try CTA dark ink in dark mode', () => assert.match(r('public/try.css'), /\[data-theme="dark"\] \.try-cta\{color:#0a0f0c\}/));
t('marketing accent >= 4.5:1 with white', () => { for (const f of ['home.css', 'legal.css']) assert.match(r('public/' + f), /--acc:#0b7d53;/); assert.match(r('public/home-guide.css'), /\.hg-cta\{background:#0b7d53;/); });
t('builder hint buttons 24px', () => assert.match(r('public/builder.css'), /\.hint-btn\{[^}]*width:24px;height:24px/));
t('builder editable uses the access matrix', () => { const j = r('public/builder.js'); assert.match(j, /editable = \(await BPStore\.auth\.canEditArea\('layouts'\)\) \|\| \(await BPStore\.auth\.canEditArea\('quotes'\)\)/); assert.doesNotMatch(j, /editable = await BPStore\.auth\.can\('edit'\)/); });
t('designer has no client create cap', () => assert.match(r('public/store-api.js'), /designer:\s+\["view", "edit"\]/));
t('P&L card checks finance view first', () => assert.match(r('public/vendor-bills-ui.js'), /canView\("finance"\)[^\n]*\n\s*if \(!finOk\) \{ box\.hidden = true; return; \}/));
t('business totals never mix currencies', () => { const j = r('public/vendor-bills-ui.js'); assert.match(j, /studioCurrency\(\)/); assert.match(j, /pay\.currencies\.length > 1/); });
console.log('retest-1017: ' + n + ' checks passed');
