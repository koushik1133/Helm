// 0185 — after a free trial upgrades: keep (default) / remove sample data / start completely clean
// (archive, never delete, asked twice + typed START CLEAN), Control Center "Delete all sample data"
// (is_demo only) + restore, and the "Sample" badge that keeps the text intact.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const TU = read('public/trial-upgrade.js'), API = read('public/store-api.js'), TD = read('public/trial-demo.js');
const CO = read('public/checkout.js'), COH = read('public/checkout.html');
const MIG = read('supabase/migrations/0185_trial_upgrade_choice.sql'), APPLY = read('supabase/APPLY-0185.sql');
const code = MIG.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

/* ---- a tiny DOM, enough for the badge code (text nodes, elements, tree walker) ---- */
class Node0 {
  constructor(type, name) { this.nodeType = type; this.nodeName = name; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.className = ''; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  get textContent() { return this.nodeType === 3 ? this.nodeValue : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '') this.appendChild(mkText(String(v))); }
  closest(sel) {
    const parts = sel.split(',').map((s) => s.trim());
    for (let e = this; e && e.nodeType === 1; e = e.parentNode) {
      for (const p of parts) {
        if (p.startsWith('.') && (' ' + e.className + ' ').includes(' ' + p.slice(1) + ' ')) return e;
        if (p.startsWith('[') && Object.prototype.hasOwnProperty.call(e.attrs, p.slice(1, -1).split('=')[0])) return e;
        if (/^[a-z]+$/.test(p) && e.nodeName.toLowerCase() === p) return e;
      }
    }
    return null;
  }
}
const mkText = (v) => { const x = new Node0(3, '#text'); x.nodeValue = v; return x; };
const mkEl = (name, kids = [], attrs = {}) => { const e = new Node0(1, name.toUpperCase()); Object.assign(e.attrs, attrs); kids.forEach((k) => e.appendChild(typeof k === 'string' ? mkText(k) : k)); return e; };
const doc = {
  createElement: (n2) => mkEl(n2), createTextNode: mkText, readyState: 'complete',
  querySelector: () => null, body: null,
  createTreeWalker(root) {
    const list = []; (function walk(x) { x.childNodes.forEach((c) => { if (c.nodeType === 3) list.push(c); else walk(c); }); })(root);
    let i = -1; return { nextNode: () => (++i < list.length ? list[i] : null) };
  },
};
const ctx = { document: doc, setTimeout, clearTimeout };
ctx.window = ctx; ctx.globalThis = ctx;
vm.runInNewContext(TU, ctx);
const U = ctx.HelmTrialUpgrade;
const plain = (x) => JSON.parse(JSON.stringify(x));

t('three choices, keep is the default; remove_sample needs sample rows', () => {
  const o = plain(U.options({ has_sample: true }));
  assert.deepEqual(o.map((x) => x.id), ['keep', 'remove_sample', 'clean']);
  assert.deepEqual(o.map((x) => x.checked), [true, false, false]);
  assert.equal(o[0].def, true); assert.equal(o[1].disabled, false);
  assert.equal(plain(U.options({ has_sample: false }))[1].disabled, true);
  assert.equal(plain(U.options(null))[0].checked, true);
});
t('typed confirmation: START CLEAN only (spaces / case forgiven)', () => {
  assert.equal(U.phraseOk('START CLEAN'), true); assert.equal(U.phraseOk('  start   clean '), true);
  for (const v of ['', 'START', 'CLEAN', 'start clean now', null, undefined, 'STARTCLEAN']) assert.equal(U.phraseOk(v), false, String(v));
  assert.equal(U.PHRASE, 'START CLEAN');
  assert.match(code, /upper\(btrim\(coalesce\(p_confirm, ''\)\)\) <> 'START CLEAN'/, 'the server checks the phrase too');
});
t('which card: choose (admin, pending) / manage (Control Center after upgrading) / nothing', () => {
  assert.equal(U.cardView({ is_admin: true, pending: true }, 'dashboard'), 'choose');
  assert.equal(U.cardView({ is_admin: false, pending: true }, 'dashboard'), null, 'members never choose');
  assert.equal(U.cardView({ is_admin: true, pending: false, has_sample: true, in_trial: false }, 'dashboard'), null);
  assert.equal(U.cardView({ is_admin: true, pending: false, has_sample: true, in_trial: false }, 'control'), 'manage');
  assert.equal(U.cardView({ is_admin: true, pending: false, can_restore: true, in_trial: false }, 'control'), 'manage');
  assert.equal(U.cardView({ is_admin: true, pending: false, has_sample: true, in_trial: true }, 'control'), null, 'trial: trial-demo.js cards');
  assert.equal(U.cardView(null, 'control'), null); assert.equal(U.cardView('x', 'control'), null);
});
t('counts in plain words; result messages', () => {
  assert.deepEqual(plain(U.countLines({ events: 2, leads: 1, staff: 0, junk: 4 }, 'sample')), ['2 sample events', '1 sample lead']);
  assert.deepEqual(plain(U.countLines(null)), []);
  assert.match(U.resultText('keep', { result: 'ok' }), /tagged/);
  assert.match(U.resultText('clean', { result: 'ok' }), /archived, not deleted/);
  assert.match(U.resultText('remove_sample', { result: 'ok', kept_in_use: 1 }), /1 sample event was kept as yours/);
  assert.match(U.resultText('keep', { result: 'already' }), /already/);
});
t('Sample badge: text kept exactly, prefix hidden in a badge, idempotent, skips form fields', () => {
  const name = mkEl('span', ['Demo · Royal Banquet Hall']);
  const lead = mkEl('td', ['  Demo · Ananya Reddy']);
  const opt = mkEl('option', ['Demo · Gold package']);
  const ta = mkEl('textarea', ['Demo · notes']);
  const own = mkEl('span', ['My own venue']);
  const ce = mkEl('div', [mkEl('b', ['Demo · typed'])], { contenteditable: '' });
  const root = mkEl('div', [name, lead, mkEl('select', [opt]), ta, own, ce]);
  const before = root.textContent;
  assert.equal(U.tagTree(root), 2);
  assert.equal(root.textContent, before, 'textContent unchanged');
  assert.equal(name.childNodes[0].className, 'hs-tag'); assert.equal(name.childNodes[0].childNodes[0].className, 'hs-pfx');
  assert.equal(name.childNodes[0].childNodes[0].attrs['aria-hidden'], 'true');
  assert.equal(name.childNodes[1].nodeValue, 'Royal Banquet Hall');
  assert.equal(lead.childNodes[0].nodeValue, '  '); assert.equal(lead.childNodes[1].className, 'hs-tag');
  assert.equal(opt.childNodes.length, 1); assert.equal(ta.childNodes.length, 1); assert.equal(own.childNodes.length, 1);
  assert.equal(ce.childNodes[0].childNodes.length, 1, 'contenteditable skipped');
  assert.equal(U.tagTree(root), 0, 'second pass changes nothing');
  assert.equal(U.sampleText('Demo · x'), true); assert.equal(U.sampleText('My Demo · x'), false);
});
t('badge CSS: "Sample" label, hidden prefix, print shows the original text', () => {
  assert.match(TU, /\.hs-tag::before\{content:\\"Sample\\"\}/);
  assert.match(TU, /\.hs-pfx\{position:absolute;width:1px;height:1px/);
  assert.match(TU, /@media print\{\.hs-tag\{all:unset\}\.hs-tag::before\{content:none\}\.hs-pfx\{position:static/);
});
t('CSP-safe: no innerHTML / inline styles / eval in trial-upgrade.js', () => {
  assert.doesNotMatch(TU, /innerHTML|insertAdjacentHTML|\.style\.|style=|eval\(|new Function/);
  assert.match(TU, /__helmAdoptCss/);
});
t('clean is asked twice (confirm, then the typed phrase); remove asks once; keep never', () => {
  const f = TU.slice(TU.indexOf('async function confirmChoice'), TU.indexOf('/* ---- the choice card'));
  assert.match(f, /if \(choice === "keep"\) return "";/);
  assert.match(f, /"Remove the sample data\?"/);
  assert.match(f, /"Start completely clean\?"[\s\S]*return await phraseBox\(\);/);
  assert.match(TU, /go\.disabled = true;[\s\S]*go\.disabled = !phraseOk\(i\.value\)/, 'the final button stays off until the phrase is typed');
});
t('store-api: upgrade namespace -> 0185 RPCs; loader on studio pages', () => {
  for (const f of ['my_upgrade_status', 'upgrade_data_choice', 'delete_all_sample_data', 'restore_clean_start']) assert.match(API, new RegExp('rpc\\("' + f + '"'), f);
  assert.match(API, /p_choice: choice === "clean" \|\| choice === "remove_sample" \? choice : "keep"/, 'unknown -> keep (the default)');
  assert.match(API, /const TRIAL_UPGRADE_VERSION = "\d+";/);
  assert.match(API, /loadTrialBanner\(\);\n    loadTrialUpgrade\(\);/);
});
t('pages host the cards and load trial-upgrade.js after trial-demo.js', () => {
  const d = read('public/dashboard.html'), c = read('public/control.html');
  assert.match(d, /id="tuCard" data-tu-auto hidden/); assert.match(c, /id="tuControl" data-tu-control hidden/);
  assert.match(d, /trial-demo\.js\?v=\d+"><\/script>\n<script src="trial-upgrade\.js\?v=\d+"><\/script>/);
  assert.match(c, /trial-demo\.js\?v=\d+"><\/script>\n<script src="trial-upgrade\.js\?v=\d+"><\/script>/);
  assert.match(c, /\$\{t\.is_demo\?'<span class="hs-tag hs-solo">Sample<\/span>':''\}/, 'sample packages tagged');
  assert.match(c, /\$\{x\.is_demo\?'<span class="hs-tag hs-solo">Sample<\/span>':''\}/, 'sample dishes tagged');
});
t('checkout: after a verified payment trial-upgrade.js offers the choice', () => {
  assert.match(CO, /if \(v && v\.verified\) \{ if \(!\(await offerDemoChoice\(\)\)\) finish/);
  assert.match(CO, /U\.offer\(\$\("#coDemoChoice"\)/);
  assert.match(COH, /id="coDemoChoice" data-tu-checkout[^>]*hidden><\/section>/);
  assert.match(COH, /<script src="trial-upgrade\.js\?v=\d+"><\/script>\n<script src="checkout\.js\?v=\d+"><\/script>/);
  assert.match(CO, /keep it \(default\), remove it, or start completely clean/);
});
t('trial-demo.js hands a converted studio over; auth-ui stops nagging after "keep"', () => {
  assert.match(TD, /if \(t && t\.state === "none" && global\.HelmTrialUpgrade\) \{ if \(dash\) dash\.hidden = true; if \(ctl\) ctl\.hidden = true; return; \}/);
  assert.match(TD, /HelmTrialUpgrade\.takeOver\(\)\) return;\s*\} catch \(e\) \{\}\s*return startFresh\(\{\}\);/);
  assert.match(read('public/auth-ui.js'), /if \(converted && d\.demo_choice === "keep"\) return null;/);
});
t('0185 migration: ASCII, additive, idempotent, no destructive SQL, own org only', () => {
  assert.ok(!/[^\x00-\x7F]/.test(MIG), 'ASCII only');
  assert.doesNotMatch(code, /\b(drop\s+table|truncate|drop\s+column|delete\s+from)\b/i);
  assert.match(code, /add column if not exists upgrade_choice text/);
  assert.match(code, /add column if not exists clean_archived_at timestamptz/);
  assert.match(code, /create table if not exists public\.studio_clean_start_items/);
  assert.match(code, /as restrictive for all to public/);
  for (const f of ['upgrade_data_choice', 'delete_all_sample_data', 'restore_clean_start', 'my_upgrade_status']) {
    const body = code.slice(code.indexOf('function public.' + f + '('));
    assert.match(body.slice(0, 600), /public\.current_org_id\(\)/, f);
  }
  assert.match(code, /not coalesce\(public\.is_admin\(\), false\)/);
  assert.match(code, /public\._is_trial_org\(p_org\)/, 'trial = subscription status');
  assert.doesNotMatch(code.slice(code.indexOf('function public._tu185_converted'), code.indexOf('function public._tu185_was_trial')), /trial_ends_at/, 'never trial_ends_at for "in trial"');
});
t('0185: every own-record step is a soft flag; only _demo_clear removes (is_demo) rows', () => {
  const arch = code.slice(code.indexOf('function public._tu185_archive_own'), code.indexOf('function public._tu185_restore_own'));
  assert.match(arch, /archived_at = now\(\), archived_by = p_actor, archived_reason = 'manual'/);
  for (const tb of ['inventory_items', 'vendors', 'crew_members', 'venues', 'menu_templates', 'dish_catalog']) assert.match(arch, new RegExp('update public\\.' + tb + ' x set active = false'), tb);
  for (const tb of ['leads', 'nurture', 'layouts']) assert.match(arch, new RegExp('update public\\.' + tb + ' x set clean_archived_at = now\\(\\)'), tb);
  assert.match(arch, /and x\.profile_id is null/, 'staff linked to a login stay');
  assert.match(code, /r_clear := public\._demo_clear\(v_org\)/);
  assert.match(code, /v_adopt := public\._tu185_adopt_used_samples\(v_org\)/);
});
t('APPLY-0185 = migration in one transaction + VERIFY; MANIFEST + run-all wired', () => {
  assert.match(APPLY, /^-- APPLY-0185\.sql[^\n]*\n[\s\S]*?\nbegin;\n/);
  assert.ok(APPLY.includes(MIG.trim()), 'APPLY embeds the migration');
  assert.match(APPLY, /commit;\s*\n\s*-- VERIFY/);
  assert.ok(!/[^\x00-\x7F]/.test(APPLY), 'APPLY ASCII only');
  assert.match(read('supabase/migrations/MANIFEST'), /^forward {2}supabase\/migrations\/0185_trial_upgrade_choice\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/trial-upgrade-0185\.sql/);
});
console.log('trial-upgrade-ui: ' + n + ' passed');
