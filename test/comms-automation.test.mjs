// 0078 comms automation: deep-link parity (bell == WhatsApp forward), template preview mirror,
// edge function dormant / fail-closed / no PII logs, migration + APPLY hygiene, UI wiring.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const api = read('public/store-api.js');
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = {}; vm.runInNewContext(fnSrc(api, 'notifLink') + '\n' + fnSrc(api, 'commsRender') + '\nglobalThis.link=notifLink; globalThis.render=commsRender;', ctx);
const dl = read('supabase/functions/comms-dispatch/deeplink.js');
const ectx = {}; vm.runInNewContext(dl.replace(/^export /gm, '') + '\nglobalThis.link=notifLink; globalThis.abs=absoluteLink;', ectx);
const fn = read('supabase/functions/comms-dispatch/index.ts');
const mig = read('supabase/migrations/0078_comms_automation.sql');
const ap = read('supabase/APPLY-0078.sql');

const U = '0b8c2f1e-1111-4222-8333-944445555666', I = '1b8c2f1e-1111-4222-8333-944445555666';
const CORPUS = [
  { kind: 'task_due', quote_id: U, detail: { task_id: 't-1' } }, { kind: 'payment_reminder', quote_id: U },
  { kind: 'approval_link', quote_id: U, event_code: 'C-1' }, { kind: 'client_follow_up', quote_id: U, event_code: 'C-2' },
  { kind: 'inventory_low_stock', quote_id: U, detail: { item_id: I } }, { kind: 'inventory_low_stock', detail: { item_id: 'x"><' } },
  { kind: 'design_review', quote_id: U }, { kind: 'pkg_selected', detail: { path: 'event.html?id=' + U } },
  { kind: 'security_alert' }, { kind: 'trial_reminder' }, { kind: 'nurture_birthday' }, { kind: 'whatever', quote_id: U },
  { __chat: true, conversation_id: 'c1', msg_id: 'm1' }, { kind: 'task_due' }, null,
];
t('edge deep links are the bell deep links (verbatim notifLink copy, same results)', () => {
  const norm = (s) => s.replace(/^\s+/gm, '');
  assert.equal(norm(fnSrc(dl, 'notifLink')), norm(fnSrc(api, 'notifLink')), 'deeplink.js drifted from store-api notifLink');
  for (const row of CORPUS) assert.equal(ectx.link(row), ctx.link(row), JSON.stringify(row));
});
t('new kinds: low stock -> event inventory + item focus; follow-up -> quotes', () => {
  assert.equal(ctx.link({ kind: 'inventory_low_stock', quote_id: U, detail: { item_id: I } }), `inventory.html?quote=${U}&item=${I}`);
  assert.equal(ctx.link({ kind: 'inventory_low_stock', detail: { item_id: 'evil"' } }), 'inventory.html');
  assert.equal(ctx.link({ kind: 'client_follow_up', quote_id: U, event_code: 'C-9' }), 'quotes.html?focus=C-9');
  assert.match(api, /if \(item\) return 'tr\[data-item="' \+ item \+ '"\]';/);
  assert.equal((read('public/inventory.html').match(/data-item="\$\{esc\(/g) || []).length, 2);
});
t('absolute link: fixed origin + relative app page only', () => {
  assert.equal(ectx.abs('https://www.helm.events/', { kind: 'task_due', quote_id: U, detail: { task_id: 't1' } }), `https://www.helm.events/ops.html?quote=${U}&task=t1`);
  assert.equal(ectx.abs('https://www.helm.events', { __chat: true, conversation_id: 'c1', msg_id: 'm1' }), 'https://www.helm.events/chat.html?c=c1&msg=m1');
  assert.equal(ectx.abs('https://x.test', null), '');
});
t('template preview mirrors _comms_render', () => {
  assert.equal(ctx.render('Hi {client}, {amount} {unknown}', { client: 'Riya', amount: 'Rs. 5' }), 'Hi Riya, Rs. 5 {unknown}');
  assert.equal(ctx.render('x'.repeat(1200), {}).length, 1000);
  assert.match(mig, /replace\(v, '\{' \|\| k \|\| '\}', coalesce\(p_vars ->> k, ''\)\)/);
  assert.match(mig, /return left\(v, 1000\)/);
});
t('edge function: dormant unless HELM_COMMS_ENABLED, shared-secret gated, fixed hosts, no PII logs', () => {
  assert.match(fn, /if \(Deno\.env\.get\("HELM_COMMS_ENABLED"\) !== "true"\) return json\(\{ status: "dormant" \}\);/);
  assert.ok(fn.indexOf('HELM_COMMS_ENABLED') < fn.indexOf('comms_outbox_claim'), 'claims before the dormant check');
  assert.match(fn, /secretMatches\(req\.headers\.get\("x-helm-cron-secret"\) \|\| "", Deno\.env\.get\("HELM_COMMS_SECRET"\) \|\| ""\)/);
  assert.match(fn, /new Set\(\["api\.resend\.com", "graph\.facebook\.com"\]\)/);
  assert.match(fn, /redirect: "error"/);
  assert.match(fn, /"Idempotency-Key": "comms-" \+ id/);
  assert.match(fn, /from "npm:@supabase\/supabase-js@2\.117\.2"/);
  for (const m of fn.matchAll(/console\.(?:log|error)\(([^;]*)\);/g)) assert.doesNotMatch(m[1], /\bto\b|text|payload|recipient|subject/, 'PII in log: ' + m[1]);
  assert.match(fn, /p_status: res === "failed" \? "retry" : res/);
});
t('migration: additive, idempotent, tenant-scoped, ASCII, no temp tables, registered', () => {
  for (const s of [mig, ap]) {
    assert.doesNotMatch(s, /[^\x00-\x7F]/);
    assert.doesNotMatch(s, /\b(drop table|delete from|truncate|alter table [^;]* drop column)\b/i);
    assert.doesNotMatch(s, /create\s+temp(orary)?\s+table/i);
  }
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0078_comms_automation\.sql/);
  assert.ok((mig.match(/create table if not exists/g) || []).length === 5);
  assert.ok(!(mig.match(/security definer set search_path = (?!'')/g)), 'definer without empty search_path');
  assert.match(mig, /create unique index if not exists comms_outbox_dedupe_key/);
  assert.match(mig, /on conflict \(dedupe_key\) do nothing/);
  for (const f of ['comms_settings_get', 'comms_settings_set', 'payment_reminder_send_now', 'my_wa_forward_get', 'my_wa_forward_set'])
    { const at = mig.indexOf('function public.' + f + '('); assert.ok(at >= 0, f);
      assert.match(mig.slice(at, mig.indexOf('end $$;', at)), /current_org_id\(\)/, f + ' not tenant scoped'); }
  assert.ok(ap.includes(mig), 'APPLY must contain the migration verbatim');
  assert.match(ap, /select item, ok from \(values/);
  assert.match(ap, /\('10 [^']+', /);
});
t('UI: Control Center card is DOM-built, admin tab only, hidden until the server answers', () => {
  const js = read('public/comms-settings.js'), cc = read('public/control.html');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML|\.style\./);
  assert.match(cc, /<div class="card" id="commsCard" hidden>/);
  assert.match(cc, /<script src="comms-settings\.js\?v=2"><\/script>/);
  assert.match(cc, /HelmCommsSettings\.init\(\)/);
  assert.match(js, /if \(!S\) return;/);
});
t('UI: "Send reminder now" goes through the server RPC; profile opt-in; link-open beacons', () => {
  const lg = read('public/logistics.html');
  assert.match(lg, /BPStore\.comms\.remindNow\(m\.id\)/);
  assert.match(lg, />Send reminder now</);
  const au = read('public/auth-ui.js');
  assert.match(au, /Also send my Helm notifications to my WhatsApp/);
  assert.match(api, /rpc\("public_get_booklet", \{ p_token: token \}\)\.then\(\(r\) => \{ linkOpened\("booklet", token\); return r; \}\)/);
  assert.match(api, /rpc\("public_get_quote", \{ p_token: token \}\)\.then\(\(r\) => \{ linkOpened\("quote", token\); return r; \}\)/);
  assert.match(api, /supa\.rpc\("public_link_opened"[^;]*\.catch\(\(\) => \{\}\)/);
});
console.log(`\ncomms-automation: ${n} passed`);
