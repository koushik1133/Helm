// 0127: trial sample data is owner-replaceable (helm_env_settings 'trial_demo_seed'), and after
// subscribing a trial admin chooses "Start fresh" (only own is_demo rows) or "Keep".
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const sql = read('supabase/migrations/0127_trial_fresh_start.sql');
const apply = read('supabase/APPLY-0127.sql');
const code = sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

t('migration is ASCII, additive and idempotent', () => {
  assert.ok(!/[^\x00-\x7F]/.test(sql), 'ASCII only');
  assert.ok(!/\b(drop\s+table|truncate|drop\s+column|delete\s+from)\b/i.test(code), 'no destructive statements');
  assert.match(code, /add column if not exists demo_choice text/);
  assert.match(code, /add column if not exists demo_choice_at timestamptz/);
});
t('seed config is owner-replaceable and fill-only, every row is_demo', () => {
  assert.match(code, /helm_env_settings s where s\.key = 'trial_demo_seed'/);
  for (const tb of ['inventory_items', 'vendors', 'crew_members', 'menu_templates']) assert.match(code, new RegExp('insert into public\\.' + tb));
  assert.equal((code.match(/, true\);/g) || []).length >= 4, true);
  assert.match(code, /pfx constant text := E'Demo \\u00b7 '/);
  assert.match(code, /revoke all on function public\._trial_seed_custom\(uuid\) from public, anon, authenticated/);
});
t('seed trigger fires only when a demo trial starts and never blocks it', () => {
  assert.match(code, /old\.trial_ends_at is null and new\.trial_ends_at is not null and new\.trial_mode = 'demo'/);
  assert.match(code, /exception when others then null/);
});
t('trial_demo_choice: admin, own org, trial only, clears via _demo_clear', () => {
  const f = code.slice(code.indexOf('function public.trial_demo_choice'), code.indexOf('function public.my_demo_status'));
  assert.match(f, /public\.is_admin\(\)/);
  assert.match(f, /v_org uuid := public\.current_org_id\(\)/);
  assert.match(f, /o\.trial_ends_at is null/);
  assert.match(f, /public\._demo_clear\(v_org\)/);
  assert.ok(!/delete from/i.test(f));
  assert.match(code, /revoke all on function public\.trial_demo_choice\(text\) from public, anon/);
});
t('my_demo_status keeps 0123 keys and adds choice_pending', () => {
  assert.match(code, /'counts', v_counts/);
  assert.match(code, /'choice_pending'/);
});
t('APPLY wraps the migration in one transaction and ends with VERIFY', () => {
  assert.match(apply, /^-- APPLY 0127[^\n]*\nbegin;/);
  assert.ok(apply.includes(sql.trim()));
  assert.match(apply, /commit;\s*\n\s*-- VERIFY 0127/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0127_trial_fresh_start\.sql/);
});
t('checkout offers the data choice after a verified payment (0185: keep / remove sample / start clean)', () => {
  const js = read('public/checkout.js'); const html = read('public/checkout.html');
  assert.match(js, /if \(v && v\.verified\) \{ if \(!\(await offerDemoChoice\(\)\)\) finish/);
  assert.match(js, /HelmTrialUpgrade/);
  assert.match(html, /id="coDemoChoice"[^>]*hidden/);
  assert.ok(!/id="coDemoChoice"[\s\S]{0,900}style="/.test(html));
  // the 0127 RPC stays callable (older clients); the new flow is upgrade_data_choice (0185)
  assert.match(read('public/store-api.js'), /choose: \(choice\) => rpc\("trial_demo_choice", \{ p_choice: choice === "fresh" \? "fresh" : "keep" \}\)/);
  assert.match(read('public/store-api.js'), /rpc\("upgrade_data_choice"/);
});
console.log(n + ' passed');
