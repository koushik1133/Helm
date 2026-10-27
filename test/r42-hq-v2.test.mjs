// r42-hq-v2.test.mjs - Helm HQ v2 as a PR on today's main (R42): the demo can never fall through to real data,
// studio-login changes from HQ are "Coming soon" (wait for PR #271), the home page pricing note, SQL 0278 / 0280 are
// additive, re-runnable, STOP without 0277 and go through the 0277 gates; owner paste files in house style.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = rd('public/hq.js'), H = rd('public/hq.html'), D = rd('public/hq-demo.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const strip = (s) => s.replace(/--[^\n]*/g, '');

t('demo: fails closed - no fake store in place = "not found", never the real database under ?demo=1', () => {
  const i = J.indexOf('async function start()'); const body = J.slice(i, J.indexOf('BPStore.init()', i));
  assert.match(body, /if \(dm\) \{/);
  assert.match(body, /if \(!window\.HelmHqDemo \|\| !window\.BPStore \|\| window\.BPStore\.__helmHqDemo !== true\) \{ notFound\(\); return; \}/);
  assert.match(D, /__helmHqDemo: true/);
  // the fake store never talks to the network or reads the saved sign-in
  assert.doesNotMatch(D, /fetch\(|XMLHttpRequest|supabase|createClient|localStorage|sessionStorage|sendBeacon|WebSocket/);
  // changes are refused, not passed through
  assert.match(D, /if \(!h\) return refuse\(\);/);
  // hosted HQ ignores ?demo=1 and never ships the demo file
  assert.ok(rd('.vercelignore').split('\n').includes('public/hq-demo.js'));
  assert.doesNotMatch(H, /hq-demo\.js/);
});
t('studio logins from HQ: Coming soon (no write call), the reason and the PR #271 dependency', () => {
  assert.match(J, /id: "studioLoginsSoon"/);
  assert.match(J, /text: "Coming soon"/);
  assert.match(J, /PR #271/);
  for (const fn of ['team_deactivate_member', 'team_reactivate_member', 'admin_delete_user', 'hq_studio_member_', 'hq_add_studio_user'])
    assert.ok(!J.includes(fn), 'HQ page calls no studio-member write: ' + fn);
});
t('home page pricing: stays fixed (coming soon) - HQ says so; /pricing reads live prices with a safe fallback', () => {
  assert.match(H, /The home page’s pricing section still shows its fixed prices - live prices there are coming soon\./);
  assert.doesNotMatch(rd('public/index.html'), /pricing-live\.js|public_pricing_plans/);
  assert.match(rd('public/pricing.html'), /<script src="\/pricing-live\.js\?v=1" defer><\/script>/);
});
t('SQL 0278 + 0280: STOP without 0277, additive, re-runnable, every new HQ function gated (_hq27_require), never anon', () => {
  const s78 = rd('supabase/migrations/0278_hq_reveal_log.sql'), s80 = rd('supabase/migrations/0280_hq_v2_round2.sql');
  assert.match(s78, /raise exception 'STOP 0278: 0277 \(_hq27_require\) is not applied'/);
  assert.match(s80, /raise exception 'STOP 0280: 0277 \(HQ staff roles\) is not applied'/);
  for (const s of [s78, s80]) {
    const c = strip(s);
    assert.doesNotMatch(c, /\bdelete\s+from\b|\bdrop\s+(table|column|function|schema)\b|(?<!before )\btruncate\b|\bupdate\s+public\b|\binsert\s+into\s+public\.platform_admins\b/i);
    assert.doesNotMatch(c, /create\s+table\s+(?!if not exists)/i, 'create table if not exists only');
    assert.doesNotMatch(c, /create\s+function/i, 'create or replace only');
    assert.doesNotMatch(c, /create\s+temp/i);
    assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(s), 'ASCII');
  }
  const c80 = strip(s80);
  for (const fn of ['hq_my_session', 'hq_studio_credits', 'hq_grant_studio_credit']) {
    const i = c80.indexOf('function public.' + fn + '('); const body = c80.slice(i, c80.indexOf('end $$;', i));
    assert.match(body, /perform public\._hq27_require\('[a-z.]+', (true|false)\);/, fn + ' gated');
  }
  assert.match(c80, /create trigger a280_credits_void_only before update on public\.hq_studio_credits/);
  assert.match(c80, /create trigger a280_credits_no_truncate before truncate on public\.hq_studio_credits/);
  assert.doesNotMatch(c80, /grant execute on function public\.(hq_my_session|hq_studio_credits|hq_grant_studio_credit)[^;]*to anon/);
});
t('owner paste files: verbatim migration between begin / commit, VERIFY rows, ASCII, no temp tables; same copy in the Helm folder when present', () => {
  for (const [n, f] of [['0278', '0278_hq_reveal_log.sql'], ['0280', '0280_hq_v2_round2.sql']]) {
    const A = rd('supabase/APPLY-' + n + '.sql'), S = rd('supabase/migrations/' + f);
    assert.ok(A.includes('begin;\n' + S + 'commit;'), n + ' verbatim');
    assert.match(A, /-- VERIFY \(every row must say ok = true\)\nselect item, ok from \(values/);
    assert.match(A, /Run AFTER APPLY-0277\.sql/);
    assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(A), 'ASCII');
    assert.doesNotMatch(A, /temp(orary)? table|pg_temp|set local|set session/i);
  }
});
t('run-all registers the DB suite; MANIFEST + release lists carry 0278 / 0280', () => {
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r42-hq-v2-0278-0280" "R42-HQ-V2: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r42-hq-v2-0278-0280\.sql/);
  const man = rd('supabase/migrations/MANIFEST');
  assert.ok(man.indexOf('0277_hq_staff_roles.sql') < man.indexOf('0278_hq_reveal_log.sql') && man.indexOf('0278_hq_reveal_log.sql') < man.indexOf('0280_hq_v2_round2.sql'));
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0277', '0278', '0280'/);
});
console.log(process.exitCode ? 'r42-hq-v2: FAILED' : `r42-hq-v2: ${n} passed`);
