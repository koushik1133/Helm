// Crew-role QA 2026-10-20: bell money leak, crew event view + own task actions, my_tasks link +
// upcoming bucket, nav (chat always, no Quotes/Leads flash), not-found copy, ops/issues slugs,
// calendar crew list, worker link token guard (0153).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (m, f) => { f(); n++; console.log('ok - ' + m); };
const SQL = 'supabase/migrations/0153_crew_fixes.sql', APPLY = 'supabase/APPLY-0153.sql';

t('0153 + APPLY: ASCII, no drop/delete/truncate, APPLY wraps in a transaction and ends with VERIFY', () => {
  for (const p of [SQL, APPLY]) {
    const s = r(p);
    assert.ok(/^[\x00-\x7F]*$/.test(s), p + ' ascii');
    assert.doesNotMatch(s, /\b(drop|delete|truncate)\b/i, p);
  }
  const a = r(APPLY).trimEnd();
  assert.match(a, /^-- APPLY-0153/); assert.match(a, /\nbegin;\n/); assert.match(a, /\ncommit;\n/);
  assert.match(a, /select item, ok from \(values[\s\S]*\) v\(item, ok\) order by item;$/);
  assert.match(r('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0153_crew_fixes\.sql/);
});

t('bell_feed: money kinds + fields hidden from non-quote viewers, old body kept, mojibake cleaned', () => {
  const s = r(SQL);
  assert.match(s, /rename to bell_feed__pre0153/);
  assert.match(s, /has_area\('quotes', 'view'\)/);
  assert.match(s, /reapproval/); assert.match(s, /_a153_money_key/);
  assert.match(s, /chr\(8218\) \|\| chr\(196\) \|\| chr\(238\)/);
  const re = /\(\^\|_\)\((.*?)\)\(_\|\$\)/.exec(s); assert.ok(re);
  const k = new RegExp('(^|_)(' + re[1] + ')(_|$)');
  for (const x of ['new_total', 'approved_total', 'amount', 'unit_price', 'balance_owed']) assert.ok(k.test(x), x);
  for (const x of ['created_at', 'feedback', 'message', 'code']) assert.ok(!k.test(x), x);
});

t('my_tasks: profile_id link + start-time bucketing; crew RPCs scoped to the caller', () => {
  const s = r(SQL);
  assert.match(s, /cm\.profile_id = auth\.uid\(\)/);
  assert.match(s, /coalesce\(t\.planned_end, t\.planned_start\) as due_at/);
  assert.match(s, /function public\.crew_event_brief\(p_quote uuid\)/);
  assert.match(s, /function public\.crew_task_respond\(p_task uuid, p_action text\)/);
  const brief = s.slice(s.indexOf('function public.crew_event_brief'), s.indexOf('function public.crew_task_respond'));
  assert.doesNotMatch(brief.replace(/--[^\n]*/g, ''), /client|phone|email|pricing|total/i);
  assert.match(brief, /_a153_my_crew_ids/);
});

t('dashboard renders the Upcoming bucket; crew Open goes to the run-sheet', () => {
  assert.match(r('public/dashboard.html'), /bucket\("upcoming","Upcoming","upcoming"\)/);
  assert.match(r('public/shell-b-dash.js'), /link\("runsheet\.html\?id=" \+ encodeURIComponent\(id\)/);
});

t('runsheet crew mode + event/ops redirect crew to their own view', () => {
  const s = r('public/runsheet.html');
  assert.match(s, /BPStore\.ops\.crew\.eventBrief\(id\)/); assert.match(s, /BPStore\.ops\.crew\.respond\(/);
  for (const p of ['public/event.html', 'public/ops.html']) assert.match(r(p), /location\.replace\("runsheet\.html\?id="/);
  assert.match(r('public/store-api.js'), /rpc\("crew_event_brief", \{ p_quote: quoteId \}\)/);
});

t('not-found copy never points to Quotes', () => {
  for (const p of ['runsheet', 'settlement', 'closure', 'issues', 'event'])
    assert.doesNotMatch(r('public/' + p + '.html'), /Event not found\. Go to <a[^>]*quotes\.html/);
});

t('nav: chat always shown, gated items start hidden; ops/issues slug routes', () => {
  const s = r('public/shell-b.js');
  assert.match(s, /ALWAYS_NAV = \{ dashboard: 1, chat: 1 \}/);
  assert.match(s, /if \(!ALWAYS_NAV\[x\[0\]\]\) it\.hidden = true/);
  assert.match(r('vercel.json'), /"source": "\/\(\[a-z0-9-\]\+\)\/ops"/);
  assert.match(r('vercel.json'), /"source": "\/\(\[a-z0-9-\]\+\)\/issues"/);
  assert.match(r('server.js'), /command\|ready\|ops\|issues\)/);
});

t('calendar lists crew events; worker tokens validated before the RPC', () => {
  assert.match(r('public/calendar.html'), /renderCrewEvents/);
  const s = r('public/store-api.js');
  assert.match(s, /const wrpc = async/); assert.match(s, /22P02/);
  for (const f of ["worker_get_tasks", "worker_assignment_updates", "worker_respond", "worker_get_equipment", "worker_checkin_equipment"]) assert.ok(s.includes(`wrpc("${f}"`), f);
});
console.log(n + ' passed');
