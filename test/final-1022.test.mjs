// final QA 1022: crew app task actions notify the studio (0154), Business money asks in the
// studio currency (dashboard_money_for), worker link rate limit, closed events say Closed,
// crew calendar shows the event date for tasks without a start time, and on a phone the demo
// note no longer floats over the next-shift Open button.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const mig = r('supabase/migrations/0154_final_fixes.sql'), apply = r('supabase/APPLY-0154.sql');
const api = r('public/store-api.js'), ev = r('public/event.html'), dash = r('public/dashboard.html');
const cal = r('public/calendar.html'), css = r('public/shell-b-dash.css'), manifest = r('supabase/migrations/MANIFEST');
let n = 0; const t = (name, fn) => { fn(); n++; };

t('migration is ASCII, additive and listed', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(mig) && /^[\x00-\x7F]*$/.test(apply));
  for (const s of [mig, apply].map((x) => x.replace(/--[^\n]*/g, ""))) assert.ok(!/\b(delete\s+from|drop\s+(table|function|column|policy)|truncate)\b/i.test(s));
  assert.ok(manifest.includes('forward  supabase/migrations/0154_final_fixes.sql'));
  assert.ok(/^begin;/m.test(apply) && /^commit;/m.test(apply) && apply.includes('VERIFY'));
});
t('crew_task_respond notifies like worker_respond', () => {
  const f = mig.slice(mig.indexOf('create or replace function public.crew_task_respond'), mig.indexOf('-- ---- 2)'));
  assert.match(f, /perform public\._notify\(tsk\.quote_id, 'sms', null, 'task_' \|\| p_action/);
  assert.match(f, /_a153_my_crew_ids/);
});
t('dashboard_money_for honours the asked currency, dashboard_money untouched', () => {
  assert.match(mig, /function public\.dashboard_money_for\(p_months integer default 12, p_currency text default null\)/);
  assert.match(mig, /v_cur := upper\(btrim\(p_currency\)\)/);
  assert.ok(!/function public\.dashboard_money\(p_months/.test(mig));
  assert.match(api, /rpc\("dashboard_money_for", \{ p_months: n, p_currency: cur \}\)/);
  assert.match(api, /rpc\("dashboard_money", \{ p_months: n \}\)/);
});
t('worker link rate limit wraps the previous token check', () => {
  assert.match(mig, /rename to _work_token_live__pre0154/);
  assert.match(mig, /return public\._work_token_live__pre0154\(p_token\)/);
  assert.match(mig, /_a154_hit\('t:'/); assert.match(mig, /errcode = '54000'/);
  assert.match(mig, /enable row level security/);
});
t('closed events say Closed', () => {
  assert.match(ev, /\(s==="confirmed"&&lc==="closed"\)\?'<span class="stat ok">Closed<\/span>'/);
  assert.match(ev, /evClosed=ev\.lifecycleStage==="closed"\|\|!!ev\.closedAt/);
  assert.match(dash, /statBadge\(s\.status, s\.lifecycleStage\)/);
});
t('crew calendar falls back to the event date', () => {
  assert.match(cal, /t\.planned_start\|\|t\.event_date/);
  assert.match(cal, /BPStore\.ops&&BPStore\.ops\.crew/);
});
t('phone: demo note stops floating over the dashboard', () => {
  assert.match(css, /@media \(max-width: 600px\) \{ html\[data-shell="b"\] body:has\(\.hd-dash\) \.hau-notes:has\(> \.hau-note\.dock-left:only-child\) \{ position: static;/);
});
console.log('final-1022: ' + n + ' checks passed');
