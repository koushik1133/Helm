// r21 (0250): security notices are Helm HQ only. The bell on the page drops studio security rows (and their
// unread count) even if an older database still sends them, HQ notices (detail.hq) stay, are labelled with the
// studio and open HQ; the migration + APPLY file are wired, additive and ASCII.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const api = rd('public/store-api.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const labelsSrc = api.slice(api.indexOf('const BELL_TYPE_LABELS'), api.indexOf('};', api.indexOf('const BELL_TYPE_LABELS')) + 2);
const ctx = { URLSearchParams };
vm.runInNewContext(labelsSrc + '\n' + ['bellHqOnlySecurity', 'bellLabel', 'notifLink', 'notifHref', 'bellTypeOf', 'bellPanelView', 'bellChatKey'].map((f) => fnSrc(api, f)).join('\n')
  + '\nglobalThis.only=bellHqOnlySecurity; globalThis.label=bellLabel; globalThis.link=notifLink; globalThis.view=bellPanelView;', ctx);
const J = (x) => JSON.parse(JSON.stringify(x));

const studioSec = (id, unread) => ({ id, kind: 'security_alert', unread, created_at: '2026-10-19T06:00:00Z',
  detail: { alert: 'member_removed', label: 'Member removed', count: 3 } });
const hqSec = { id: 'h1', kind: 'security_alert', unread: true, created_at: '2026-10-19T06:05:00Z',
  detail: { hq: true, alert: 'member_removed', label: 'Member removed', count: 6, studio: 'Sita Events' } };
const task = { id: 't1', kind: 'task_assigned', unread: true, created_at: '2026-10-19T05:00:00Z', detail: { count: 2 } };

t('the owner screenshot: two studio "Member removed x3" rows are dropped, unread drops by 2', () => {
  const r = ctx.only({ items: [studioSec('s1', true), studioSec('s2', true), task], unread: 3 });
  assert.deepEqual(J(r.items.map((i) => i.id)), ['t1']);
  assert.equal(r.unread, 1);
});
t('read studio rows are dropped without touching unread; never below 0', () => {
  assert.equal(ctx.only({ items: [studioSec('s1', false), task], unread: 1 }).unread, 1);
  assert.equal(ctx.only({ items: [studioSec('s1', true)], unread: 0 }).unread, 0);
});
t('detail.hq must be exactly true (a string or missing detail is a studio row)', () => {
  const fake = { id: 'x', kind: 'Security_Alert ', unread: true, detail: { hq: 'true' } };
  assert.equal(ctx.only({ items: [fake, { id: 'y', kind: 'security_alert' }], unread: 2 }).items.length, 0);
});
t('HQ notices stay; a feed without security rows is returned as is', () => {
  const f = { items: [hqSec, task], unread: 2 };
  assert.equal(ctx.only(f), f);
  const r = ctx.only({ items: [hqSec, studioSec('s1', true)], unread: 2 });
  assert.deepEqual(J(r.items.map((i) => i.id)), ['h1']); assert.equal(r.unread, 1);
});
t('bad input passes through', () => {
  assert.equal(ctx.only(null), null); assert.equal(ctx.only(undefined), undefined);
  const odd = { unread: 1 }; assert.equal(ctx.only(odd), odd);
});
t('HQ label names the studio; a grouped notice names nobody', () => {
  assert.equal(ctx.label(hqSec).text, 'Security: Member removed ×6 · Sita Events');
  assert.equal(ctx.label({ kind: 'security_alert', detail: { hq: true, label: 'Member removed', count: 1, subject_name: 'Ravi', studio: 'Sita Events' } }).text,
    'Security: Member removed · Ravi · Sita Events');
  // a studio-shaped row (no hq flag) keeps the old label (it never reaches the bell any more)
  assert.equal(ctx.label({ kind: 'security_alert', detail: { label: 'Member removed', count: 3, studio: 'X' } }).text, 'Security: Member removed ×3');
});
t('HQ notice opens HQ; other links unchanged', () => {
  assert.equal(ctx.link(hqSec), 'hq.html');
  assert.equal(ctx.link(studioSec('s1', true)), 'control.html#users');
});
t('bell panel after the filter: no Security tab, no shield row for a studio user', () => {
  const f = ctx.only({ items: [studioSec('s1', true), studioSec('s2', true), task], unread: 3 });
  const v = ctx.view(f.items, { now: Date.parse('2026-10-19T09:00:00Z'), label: ctx.label });
  assert.ok(!v.tabs.some((x) => x.id === 'security'));
  assert.ok(!/Member removed/.test(v.html));
  assert.equal(v.unread, 1);
});
t('bell feed is filtered on the way in (BPStore.bell.feed)', () => {
  assert.ok(/feed: \(limit\) => memoRead\("bell\.feed:"[^\n]*\)\.then\(bellHqOnlySecurity\),/.test(api));
});
t('migration 0250: in MANIFEST, APPLY file, ASCII, additive, wrappers marked', () => {
  const mig = rd('supabase/migrations/0250_security_notices_hq_only.sql');
  const man = rd('supabase/migrations/MANIFEST');
  assert.ok(/^forward\s+supabase\/migrations\/0250_security_notices_hq_only\.sql$/m.test(man));
  assert.ok(existsSync(new URL('../supabase/APPLY-0250.sql', import.meta.url)));
  const apply = rd('supabase/APPLY-0250.sql');
  for (const s of [mig, apply]) {
    assert.ok(!/[^\x00-\x7F]/.test(s), 'ASCII only');
    assert.ok(!/\bdelete\s+from\b/i.test(s) && !/\bdrop\s+(table|column)\b/i.test(s) && !/\btruncate\b/i.test(s), 'no delete / drop table / truncate');
  }
  assert.ok(apply.includes(mig.trim().split('\n').slice(-1)[0]));
  assert.ok(/^begin;$/m.test(apply) && /^commit;$/m.test(apply) && /select item, ok from \(values/.test(apply));
  for (const f of ['bell_feed', '_notify_hidden_types', 'notification_type_of', 'notification_catalog', 'event_activity', 'bell_mark_seen'])
    assert.ok(mig.includes(`['${f}',`), f + ' renamed once');
  assert.equal((mig.match(/r21-secnotice-0250/g) || []).length >= 7, true);
  assert.ok(/create policy sa250_read on public\.notifications as restrictive for select/.test(mig));
  assert.ok(/unique \(org_key, alert_type, day\)/.test(mig));
});
t('mailer: an HQ copy of a studio alert names the studio', () => {
  const m = rd('supabase/functions/security-alert-mailer/index.ts');
  assert.ok(/const where = hq \? \(studio \|\| "Helm HQ"\)/.test(m));
});
console.log(`r21-security-notices: ${n} passed`);
