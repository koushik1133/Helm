// audit-run3-edge-client.test.mjs - static guards for the run-3 audit LOW / INFO fixes
// (edge functions, client, CI, supply chain, CSP, local dev server). READ-ONLY, no network.
// Behavioural proof: tests/edge/send-whatsapp.test.ts + send-phone-code.test.ts (Deno),
// tests/db/mfa-verify-hook-0158.sql (local PG), test/layout-api-auth.test.mjs.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = (p) => readFileSync(join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const WF = join(ROOT, '.github', 'workflows');
const workflows = readdirSync(WF).filter((f) => f.endsWith('.yml')).map((f) => [f, r('.github/workflows/' + f)]);

// ---- supply-chain/github-actions/tag-pinned-not-sha ---------------------------------
const { checkWorkflowText } = await import('../scripts/check-actions-pinned.mjs');
t('every GitHub Action is pinned to a 40-char SHA with a version comment', () => {
  for (const [f, y] of workflows) assert.deepEqual(checkWorkflowText(y, f), [], f);
  assert.equal(checkWorkflowText('      - uses: actions/checkout@v7\n').length, 1);
  assert.equal(checkWorkflowText('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n').length, 1, 'comment required');
  assert.deepEqual(checkWorkflowText('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n'), []);
  assert.match(r('.github/workflows/ci.yml'), /node scripts\/check-actions-pinned\.mjs/);
});

// ---- ci/lighthouse/npx-unpinned-lhci-range -------------------------------------------
t('Lighthouse runs an exact, lockfile-pinned @lhci/cli (no npx range)', () => {
  const y = r('.github/workflows/lighthouse.yml');
  assert.doesNotMatch(y, /npx[^\n]*@lhci\/cli@/);
  assert.match(y, /npm ci --prefix tools\/lhci --ignore-scripts/);
  const pkg = JSON.parse(r('tools/lhci/package.json'));
  assert.match(pkg.devDependencies['@lhci/cli'], /^\d+\.\d+\.\d+$/, 'exact version');
  const lock = JSON.parse(r('tools/lhci/package-lock.json'));
  const e = lock.packages['node_modules/@lhci/cli'];
  assert.equal(e.version, pkg.devDependencies['@lhci/cli']);
  assert.match(e.integrity, /^sha512-/);
  assert.doesNotMatch(y, /\$\{\{\s*secrets\./, 'no secrets in the Lighthouse job');
});

// ---- ci/check-html-sinks/guard-blind-spots ---------------------------------------------
t('HTML-sink guard runs in GitHub CI and is tighter', () => {
  assert.match(r('.github/workflows/ci.yml'), /node scripts\/check-html-sinks\.mjs/);
  const g = r('scripts/check-html-sinks.mjs');
  assert.doesNotMatch(g, /JSON\\\.stringify\|/, 'JSON.stringify is not an HTML escaper');
  assert.doesNotMatch(g, /toLocaleString\\\(/, 'no blanket .toLocaleString() pass');
  assert.match(g, /SKIP_DIRS = new Set\(\['vendor', 'node_modules', 'docs'\]\)/);
  assert.match(g, /srcdoc/); assert.match(g, /parseFromString/); assert.match(g, /createContextualFragment/);
  assert.match(g, /allowMap\.get\(k\)\.max/, 'allowlist entries are count-anchored');
});
t('every page esc() encodes the single quote', () => {
  for (const f of readdirSync(join(ROOT, 'public')).filter((x) => x.endsWith('.html'))) {
    for (const m of r('public/' + f).matchAll(/const esc\s*=[^\n]*/g)) assert.match(m[0], /&#39;/, f + ': ' + m[0].slice(0, 80));
  }
});

// ---- ci/secret-scanning/gitleaks-and-jwt-check-gaps ------------------------------------
t('gitleaks: new-format Supabase keys, plain-text doc passwords, fixture allowlist, weekly history scan', () => {
  const g = r('.gitleaks.toml');
  assert.match(g, /id = "helm-supabase-secret-key"/);
  assert.match(g, /id = "helm-supabase-personal-access-token"/);
  assert.match(g, /id = "helm-doc-password-plain"/);
  assert.match(g, /\^0b8c2f1e-1111-4222-8333-944445555666\$/, 'test fixture UUID allowlisted exactly');
  const h = r('.github/workflows/secret-scan-history.yml');
  assert.match(h, /schedule:/); assert.match(h, /fetch-depth: 0/); assert.match(h, /sha256sum -c/);
  assert.match(h, /gitleaks" git \. --config \.gitleaks\.toml --redact/);
  assert.doesNotMatch(h, /\$\{\{\s*secrets\./);
  assert.ok(existsSync(join(ROOT, '.gitleaksignore')));
  for (const l of r('.gitleaksignore').split('\n').filter((x) => x && !x.startsWith('#'))) assert.match(l, /^[0-9a-f]{40}:[^:]+:[a-z0-9-]+:\d+$/, 'fingerprints only: ' + l);
  assert.match(r('scripts/check-jwt-roles.mjs'), /sb_secret_/);
});

// ---- ci/workflows/pull_request-jobs-expose-test-secrets-without-environment -------------
t('secret-bearing PR jobs are bound to the staging-tests Environment', () => {
  for (const f of ['db-tests.yml', 'e2e.yml']) {
    const y = r('.github/workflows/' + f);
    assert.match(y, /\n    environment: staging-tests\n/, f);
  }
});

// ---- supply-chain/telemetry/sentry-cdn-script-no-sri -----------------------------------
t('Sentry bundle carries SRI (Sentry-published sha384 for 8.35.0)', () => {
  const s = r('public/telemetry.js');
  assert.match(s, /var SENTRY_SRI = 'sha384-j1K2\/oFJn\/QPiNs\/Fk58NwXcaEbWzaUEF04vKMBnEprfbZ2hIQrAO0yc0XEfai1E';/);
  assert.match(s, /sc\.integrity = SENTRY_SRI;/);
  assert.match(s, /sc\.crossOrigin = 'anonymous';/);
  assert.match(s, /SENTRY_SRC = 'https:\/\/browser\.sentry-cdn\.com\/8\.35\.0\/bundle\.min\.js'/);
  const { SCRIPT_SRC_BASE } = require('../scripts/csp-hashes.cjs');
  assert.ok(SCRIPT_SRC_BASE.includes('https://browser.sentry-cdn.com/8.35.0/'), 'version in CSP and loader agree');
});

// ---- client/csp/exfil-channels-and-trusted-types-off -----------------------------------
t('CSP: no wildcard Sentry ingest anywhere while telemetry is dormant', () => {
  for (const f of ['vercel.json', 'public/_headers', 'server.js']) assert.doesNotMatch(r(f), /\*\.ingest\./, f);
  assert.match(r('scripts/gen-csp.mjs'), /connect-src allows a wildcard/);
});
t('Trusted Types: report-only on the staging site; trusted-types.js mode follows the enforce flag', () => {
  const { TRUSTED_TYPES_ENFORCE, TT_DIRECTIVES } = require('../scripts/csp-hashes.cjs');
  const tt = r('public/trusted-types.js');
  const mode = /var MODE = '(report|enforce)';/.exec(tt);
  assert.ok(mode, 'MODE constant');
  assert.equal(mode[1], TRUSTED_TYPES_ENFORCE ? 'enforce' : 'report', 'flip both together');
  assert.match(tt, /if \(MODE !== 'enforce'\) \{[\s\S]{0,200}return s;/, 'report mode never rewrites markup');
  const v = JSON.parse(r('vercel.json'));
  const rule = v.headers.find((x) => x.has && x.has.some((c) => c.value === 'helm-v01.vercel.app') && x.headers[0].key === 'Content-Security-Policy');
  const ro = rule.headers.find((h) => h.key === 'Content-Security-Policy-Report-Only');
  if (!TRUSTED_TYPES_ENFORCE) assert.equal(ro && ro.value, TT_DIRECTIVES.join('; '));
  // production hosts / the catch-all never carry Trusted Types yet
  for (const x of v.headers) if (!(x.has && x.has.some((c) => c.value === 'helm-v01.vercel.app')))
    for (const h of x.headers) assert.doesNotMatch(h.value, /require-trusted-types-for/, x.source);
});

// ---- deploy/vercel/helm-v01-union-csp-overrides-per-page -------------------------------
t('staging union CSP no longer widens framing (per-page X-Frame-Options governs)', () => {
  const v = JSON.parse(r('vercel.json'));
  const rule = v.headers.find((x) => x.has && x.has.some((c) => c.value === 'helm-v01.vercel.app') && x.headers[0].key === 'Content-Security-Policy');
  assert.doesNotMatch(rule.headers[0].value, /frame-ancestors/);
  assert.ok(!rule.headers.some((h) => /x-frame-options/i.test(h.key)));
  const xfo = (src) => v.headers.filter((x) => !x.has && new RegExp('^' + x.source + '$').test(src)).flatMap((x) => x.headers).filter((h) => h.key === 'X-Frame-Options').map((h) => h.value).pop();
  assert.equal(xfo('/dashboard'), 'DENY');
  assert.equal(xfo('/invite'), 'SAMEORIGIN');
});

// ---- client/login/invite-fragment-session-fixation -------------------------------------
t('login: a link-derived session is dropped on any refusal and on already:true', () => {
  const l = r('public/login.html');
  const fn = l.slice(l.indexOf('async function acceptPendingInvite(){'), l.indexOf('function inviteWrongAccount('));
  assert.match(fn, /if\(fromLink\) await dropLinkSession\(\);\s*throw e;/);
  assert.match(fn, /if\(fromLink && res && res\.already===true\)\{\s*await dropLinkSession\(\);/);
  assert.match(fn, /sessionStorage\.removeItem\("bp_invite_set_pw"\)/, 'no set-password step for a dropped session');
  assert.doesNotMatch(fn, /fromLink && \/different email\|invalid invitation\//, 'old narrow sign-out guard gone');
});

// ---- edge/send-phone-code + edge/send-whatsapp -----------------------------------------
t('send-phone-code: global / per-country / per-studio daily caps + confirmed account', () => {
  const s = r('supabase/functions/send-phone-code/index.ts');
  for (const k of ['"pv:global:all"', '"pv:cc:" + cc', '"pv:org:" + orgKey', 'PHONE_CODE_ALLOWED_CC', 'email_confirmed_at']) assert.ok(s.includes(k), k);
  assert.ok(s.indexOf('"pv:global:all"') < s.indexOf('admin.rpc("phone_verify_request"'), 'caps before a code is minted');
});
t('send-whatsapp: opt-out, unpaid opt-in, distinct-recipient caps, plain-text params', () => {
  const s = r('supabase/functions/send-whatsapp/index.ts');
  for (const k of ['from("whatsapp_opt_outs")', 'from("wa_proposal_optins")', 'from("studio_subscriptions")', '"wa:rcpt:" + orgId', '"wa:unpaid:" + orgId', 'paramProblem(p)', 'LINK_TOKENS', 'from("subscription_payments")']) assert.ok(s.includes(k), k);
  const iAuthz = s.indexOf('asCaller.rpc("whatsapp_authorize"'), iSend = s.indexOf('/messages`');
  for (const k of ['from("whatsapp_opt_outs")', '"wa:rcpt:" + orgId']) { const i = s.indexOf(k); assert.ok(i > iAuthz && i < iSend, k + ' between authorize and send'); }
  assert.doesNotMatch(s, /slice\(0, 300\)/, 'params are validated, not silently truncated');
  // R32 (Strix vuln-0004): free text (WHATSAPP_ALLOW_TEXT=1) gets the same Helm-site-only link rule
  const iText = s.indexOf('WHATSAPP_ALLOW_TEXT") !== "1"'), iChk = s.indexOf('offSiteLink(text)');
  assert.ok(iText > 0 && iChk > iText && iChk < s.indexOf('content = { type: "text"'), 'free text link-checked before it is sent');
});

// ---- auth/mfa-attempts (0158) -------------------------------------------------------------
t('0158 MFA verification hook: ASCII, additive, MANIFEST, APPLY embeds it, VERIFY rows', () => {
  const m = r('supabase/migrations/0158_mfa_verify_hook.sql'), a = r('supabase/APPLY-0158.sql');
  assert.ok(/^[\x00-\x7f]*$/.test(m) && /^[\x00-\x7f]*$/.test(a), 'ASCII only');
  assert.doesNotMatch(m.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/--[^\n]*/g, ''), /\b(drop table|drop column|delete from|truncate)\b/i);
  assert.match(m, /create or replace function public\.hook_mfa_verification_attempt\(event jsonb\)/);
  assert.match(m, /select item, ok from \(values/);
  assert.match(r('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0158_mfa_verify_hook\.sql/);
  assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m);
  assert.ok(a.includes(m.slice(0, m.indexOf('-- VERIFY (read-only)')).trim()), 'APPLY embeds 0158 verbatim');
  assert.match(r('scripts/db-test/run-all.sh'), /mfa-verify-hook-0158\.sql/);
});

// ---- infra/server.js + local/server.js ----------------------------------------------------
t('server.js: loopback bind by default, Host/Origin checked, JSON-only writes', () => {
  const s = r('server.js');
  assert.match(s, /const HOST = process\.env\.HOST \|\| '127\.0\.0\.1';/);
  assert.match(s, /isLocalHostHeader\(headers\['host'\]\) && originAllowed\(req\)/);
  assert.match(s, /415, \{ error: 'Content-Type must be application\/json' \}/);
});

console.log(`audit-run3-edge-client: ${n} passed`);
