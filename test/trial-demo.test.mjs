// Free-trial demo data (0097) — front end + static migration guards.
//  * trial-demo.js view(): choose (admin, trial, no choice yet) / demo / leftover / nothing
//  * auth-ui demoNotice(): banner in demo mode, "set up your studio" once converted, admins get the action
//  * store-api demo namespace calls the 0097 RPCs; pages load trial-demo.js; CSP-safe code
//  * 0097: every delete is limited to the caller studio's demo rows; additive; MANIFEST + run-all wired
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const TD = read('public/trial-demo.js'), AUI = read('public/auth-ui.js'), API = read('public/store-api.js');
const MIG = read('supabase/migrations/0097_trial_demo.sql');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = {}; vm.runInNewContext(fnSrc(TD, 'view') + '\n' + fnSrc(AUI, 'demoNotice') + '\nglobalThis.view=view; globalThis.notice=demoNotice;', ctx);
const view = ctx.view, notice = (d, tr) => JSON.parse(JSON.stringify(ctx.notice(d, tr)));
const trial = { state: 'trial', days_left: 10 };

t('choice screen: admin, trial running, no choice yet', () => {
  assert.equal(view({ trial_mode: null, has_demo: false, is_admin: true }, trial), 'choose');
  assert.equal(view({ trial_mode: null, has_demo: false, is_admin: false }, trial), null, 'members never choose');
  assert.equal(view({ trial_mode: null, has_demo: false, is_admin: true }, { state: 'none' }), null, 'paid studio: no choice screen');
  assert.equal(view({ trial_mode: 'own', has_demo: false, is_admin: true }, trial), null, 'already chose own');
});
t('demo / leftover / junk', () => {
  assert.equal(view({ trial_mode: 'demo', has_demo: true, is_admin: false }, trial), 'demo');
  assert.equal(view({ trial_mode: 'own', has_demo: true, is_admin: true }, trial), 'leftover');
  assert.equal(view({ trial_mode: 'own', has_demo: true, is_admin: false }, trial), null);
  assert.equal(view(null, trial), null); assert.equal(view('x', trial), null);
});
t('banner: demo mode → exploring + onboarding action for admins only', () => {
  const a = notice({ trial_mode: 'demo', has_demo: true, is_admin: true }, trial);
  assert.equal(a.title, "You're exploring demo data"); assert.match(a.action, /^Start onboarding with your data/);
  assert.equal(notice({ trial_mode: 'demo', has_demo: true, is_admin: false }, trial).action, null);
  assert.equal(ctx.notice({ trial_mode: 'own', has_demo: true, is_admin: true }, trial), null);
  assert.equal(ctx.notice({ trial_mode: 'demo', has_demo: false, is_admin: true }, trial), null);
});
t('banner after converting: prompts to set up the studio', () => {
  const c = notice({ trial_mode: 'demo', has_demo: true, is_admin: true }, { state: 'none' });
  assert.equal(c.converted, true); assert.match(c.action, /^Set up your studio/);
});
t('banner is dismissible for the session only + trial notice gets "Set up your studio"', () => {
  assert.match(AUI, /helm_demo_dismissed_/); assert.match(AUI, /sessionStorage\.setItem\(key, "1"\)/);
  assert.match(AUI, /label: "Set up your studio", onClick: goDemoSwitch/);
});
t('store-api demo namespace → 0097 RPCs', () => {
  for (const f of ['my_demo_status', 'set_trial_mode', 'seed_demo_data', 'clear_demo_data', 'reset_demo_data']) assert.match(API, new RegExp('rpc\\("' + f + '"'), f);
});
t('pages load trial-demo.js and host its cards', () => {
  const d = read('public/dashboard.html'), c = read('public/control.html');
  assert.match(d, /<script src="trial-demo\.js\?v=\d+"><\/script>/); assert.match(d, /id="tdCard" data-td-auto hidden/);
  assert.match(c, /<script src="trial-demo\.js\?v=\d+"><\/script>/); assert.match(c, /id="tdControl" data-td-control hidden/);
});
t('CSP-safe: no innerHTML / inline styles in trial-demo.js; clearing always confirms', () => {
  assert.doesNotMatch(TD, /innerHTML|\.style\.|style=/);
  assert.match(TD, /__helmAdoptCss/);
  assert.match(fnSrc(TD, 'clearDemo'), /confirmDlg\([\s\S]*danger: true/);
});
t('0166: Control Center "Clear sample data" confirms, then calls clear_sample_data()', () => {
  assert.match(fnSrc(TD, 'clearSample'), /confirmDlg\([\s\S]*danger: true/);
  assert.match(fnSrc(TD, 'clearSample'), /demo\.clearSample\(\)/);
  assert.match(TD, /"Clear sample data"/);
  assert.match(TD, /"td-tag", "Sample data"/);
  assert.match(read('public/store-api.js'), /clearSample: \(\) => rpc\("clear_sample_data"\)/);
  const M166 = read('supabase/migrations/0166_trial_sandbox_skeleton.sql');
  assert.doesNotMatch(M166, /[^\x00-\x7f]/);
  assert.match(M166, /_demo_clear\(v_org\)/);
  assert.match(read('supabase/migrations/MANIFEST'), /^forward {2}supabase\/migrations\/0166_trial_sandbox_skeleton\.sql$/m);
});
t('0097: every delete is limited to the caller studio\'s demo rows', () => {
  const dels = MIG.match(/delete from public\.[a-z_]+[^;]*;/g) || [];
  assert.ok(dels.length >= 9, 'deletes found');
  for (const d of dels) assert.ok(/is_demo/.test(d) || /any\(v_q\)/.test(d), d);
  // v_q = this studio's demo events only
  assert.match(MIG, /select coalesce\(array_agg\(id\), '\{\}'\) into v_q from public\.quotes where org_id = p_org and is_demo;/);
  assert.match(MIG, /venues set active = false where org_id = p_org and is_demo/, 'venues are never deleted');
  assert.doesNotMatch(MIG, /drop table|drop column|truncate|alter table [^;]* disable trigger/i);
});
t('0097: admin-gated entry points, flag guard, gate wrappers', () => {
  for (const f of ['seed_demo_data', 'clear_demo_data', 'reset_demo_data', 'set_trial_mode']) {
    const body = MIG.match(new RegExp('create or replace function public\\.' + f + '\\([\\s\\S]*?end \\$\\$;'));
    assert.ok(body, f); assert.match(body[0], /not coalesce\(public\.is_admin\(\), false\)/, f);
  }
  assert.match(MIG, /demo data is managed by Helm, not by the app/);
  for (const f of ['whatsapp_authorize', 'otp_send_authorize', 'payment_link_begin', 'create_payment']) assert.match(MIG, new RegExp(f + '__pre0097\\('), f);
});
t('MANIFEST + run-all + versions', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /^forward {2}supabase\/migrations\/0097_trial_demo\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/trial-demo-0097\.sql/);
  assert.match(API, /const AUTH_UI_VERSION = "36";/);
});
t('0100: seed / reset / load errors are shown (friendlyError toast) with a busy button state', () => {
  assert.match(TD, /BPUI\.friendlyError\(e, \{ action: action \|\| "load the demo data" \}\)/);
  for (const f of ['seed', 'resetDemo']) {
    const b = fnSrc(TD, f);
    assert.match(b, /busy\(b, "/, f); assert.match(b, /catch \(e\) \{ done\(\); toast\(errMsg\(e, "[a-z ]+"\), "err", b\); \}/, f);
  }
  assert.match(fnSrc(TD, 'busy'), /aria-busy/);
  assert.match(TD, /td-err/, 'inline error fallback when BPUI.toast is missing');
});
t('0100: demo seed fix - raw pricing inputs, server total re-read, no money row <= 0', () => {
  const M = read('supabase/migrations/0100_demo_seed_fix.sql');
  assert.match(M, /demo-seed-0100/);
  assert.equal((M.match(/"platePrice":\d+,"chairs":\d+,"chairPrice":\d+,"other":\d+/g) || []).length, 4);
  assert.doesNotMatch(M, /"subtotal":/);
  assert.match(M, /where x\.amt > 0;/); assert.match(M, /if v_a1 > 0 then/);
  assert.doesNotMatch(M, /drop table|drop column|truncate|delete from/i);
  assert.match(read('supabase/migrations/MANIFEST'), /^forward {2}supabase\/migrations\/0100_demo_seed_fix\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/demo-seed-0100\.sql/);
  assert.doesNotMatch(read('supabase/APPLY-0100.sql'), /[^\x00-\x7f]/);
});
console.log(`trial-demo: ${n} passed`);
// 0123 — "Start my own studio"
{
  const ctx2 = {}; vm.runInNewContext('const COUNT_LABELS=' + TD.match(/const COUNT_LABELS = (\[[\s\S]*?\]\]);/)[1] + ';\n' + fnSrc(TD, 'countLines') + '\n' + fnSrc(TD, 'nextAfterFresh') + '\nglobalThis.c=countLines;globalThis.n=nextAfterFresh;', ctx2);
  t('0123: counts in plain words, zero/unknown skipped', () => {
    assert.deepEqual([...ctx2.c({ events: 4, leads: 1, staff: 0, venues: 2, junk: 9 })], ['4 sample events', '1 sample lead', '2 sample venues (switched off, not deleted)']);
    assert.equal(ctx2.c(null).length, 0);
  });
  t('0123: after clearing only onboarding or checkout (no open redirect)', () => {
    assert.equal(ctx2.n(''), 'dashboard.html');   // 0177: a trial never opens the full studio setup
    assert.equal(ctx2.n('checkout'), 'checkout.html?next=onboarding.html%3Ffresh%3D1');
    assert.equal(ctx2.n('https://evil.example'), 'dashboard.html');
  });
  t('0123: start fresh calls the existing clear RPC only; onboarding hook; read-only migration', () => {
    const b = fnSrc(TD, 'startFresh');
    assert.match(b, /S\(\)\.demo\.clear\(\)/); assert.doesNotMatch(b, /rpc\(|delete/);
    assert.match(read('public/onboarding.html'), /<script src="trial-demo\.js\?v=8"><\/script>/);
    const M = read('supabase/migrations/0123_trial_start_fresh.sql');
    assert.doesNotMatch(M.replace(/--.*$/gm, ''), /delete from|update public|insert into|drop |truncate/i);
    assert.doesNotMatch(M, /[^\x00-\x7f]/);
    assert.match(read('supabase/migrations/MANIFEST'), /^forward {2}supabase\/migrations\/0123_trial_start_fresh\.sql$/m);
  });
}
console.log(`trial-demo 0123: ok`);
