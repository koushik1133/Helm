// r106-trial-gaps.test.mjs - R106 (free-trial rules audit): client images off in the trial (share checklist + builder
// capture + database trigger 0316), a clear "own free-trial studio" invite answer, the shared trial e-mail counter,
// "ends today" for trials ending 00:00-00:07 IST, the duplicate "Change date" date, and the stuck "Creating…" invite button.
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const R = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name); };
const tick = async (k = 10) => { for (let i = 0; i < k; i++) await new Promise((r) => setImmediate(r)); };

const SQL = R('supabase/migrations/0316_r106_trial_gaps.sql');

await t('0316: additive - no table / column / row delete, drop or alter (only the house function rename)', () => {
  const body = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').toLowerCase();
  assert.doesNotMatch(body, /\bdelete from\b|\btruncate\b|\bdrop table\b|\bdrop column\b|\balter table\b|\bdrop function\b|\bdrop policy\b/);
  assert.match(body, /alter function public\.accept_invitation\(text\) rename to accept_invitation__pre0316/);
  assert.match(body, /if to_regprocedure\('public\.accept_invitation__pre0316\(text\)'\) is null then/, 'rename only once');
  assert.match(body, /drop trigger if exists zz_r316_trial_client_images on public\.client_booklet_images/);
  assert.ok(!/[^\x00-\x7f]/.test(SQL), 'ASCII only');
  assert.ok(existsSync(new URL('../supabase/APPLY-0316.sql', import.meta.url)), 'APPLY-0316.sql paste file');
  assert.match(R('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0316_r106_trial_gaps\.sql/);
  assert.match(R('scripts/db-test/run-all.sh'), /R106-TRIAL-GAPS-0316: ALL PASS/);
  const apply = R('supabase/APPLY-0316.sql');
  assert.ok(apply.includes(SQL.trim()), 'APPLY embeds the migration unchanged');
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m);
});

await t('0316: trial 2D / 3D pictures refused for app sign-ins only; photos + paid studios untouched', () => {
  assert.match(SQL, /before insert on public\.client_booklet_images/);
  assert.match(SQL, /coalesce\(auth\.jwt\(\) ->> 'role', ''\) not in \('authenticated', 'anon'\) then return new/);
  assert.match(SQL, /new\.kind in \('2d', '3d'\) and public\._r316_trial_studio\(new\.org_id\)/);
  assert.match(SQL, /Client images unlock on a paid plan/);
  assert.match(SQL, /hint = 'trial_client_images'/);
  assert.match(SQL, /_is_trial_org\(p_org\)[\s\S]{0,80}_trial_locked\(p_org\)/);
  assert.match(SQL, /coalesce\(o\.is_sample_master, false\)/);
});

await t('0316: ONE trial e-mail counter for link e-mails / approval codes and delivery reminders', () => {
  const used = SQL.slice(SQL.indexOf('function public._r316_trial_email_used'), SQL.indexOf('function public._tr212_take'));
  assert.match(used, /public\.trial_email_sends/); assert.match(used, /public\.delivery_reminder_sends s where s\.org_id = p_org and s\.trial_slot/);
  for (const fn of ['_tr212_take', '_dl241_trial_take', 'my_trial_messaging']) {
    const b = SQL.slice(SQL.indexOf('function public.' + fn + '('));
    assert.match(b.slice(0, 1600), /_r316_trial_email_used\(/, fn + ' uses the shared counter');
  }
  assert.match(SQL, /pg_advisory_xact_lock\(hashtextextended\('helm:trial-email:' \|\| p_org::text, 0\)\)/);
});

await t('0316: "ends today" for a trial ending before the next hourly tick (00:00-00:07 IST)', () => {
  const m = SQL.slice(SQL.indexOf('function public._trial_reminder_milestone'));
  assert.match(m, /if p_ends - p_now <= interval '65 minutes' then return 'd8'; end if;/);
  assert.match(m, /when 3 then 'd5' when 1 then 'd7' when 0 then 'd8'/, 'old windows kept');
  // JS mirror of the rule (IST, hourly :07 ticks): every end instant gets d8 exactly once from some tick
  const IST = 330 * 60000;
  const day = (ms) => Math.floor((ms + IST) / 86400000);
  const ms = (ends, now) => { if (ends <= now) return null; if (ends - now <= 65 * 60000) return 'd8';
    const left = day(ends - 1) - day(now); return left === 3 ? 'd5' : left === 1 ? 'd7' : left === 0 ? 'd8' : null; };
  const midnight = Date.UTC(2026, 10, 14) - IST;   // 14 Nov 2026 00:00 IST
  for (let m2 = 0; m2 < 24 * 60; m2 += 1) {
    const ends = midnight + m2 * 60000 + 30000;
    const got = new Set();
    for (let h = -6 * 24; h <= 2; h++) { const now = midnight + h * 3600000 + 7 * 60000; const v = ms(ends, now); if (v) got.add(v); }
    assert.ok(got.has('d8'), 'trial ending at minute ' + m2 + ' gets "ends today"');
  }
});

await t('0316: a free-trial login invited elsewhere gets own_trial words; nothing joined / left', () => {
  const b = SQL.slice(SQL.indexOf('function public._r316_accept_invitation'));
  assert.match(b, /You are already in your own free-trial studio/);
  assert.match(b, /contact Helm support to close your free trial first/);
  assert.match(b, /hint = 'own_trial'/);
  assert.match(b, /return public\.accept_invitation__pre0316\(p_token\)/);
  assert.doesNotMatch(b, /update public\.(profiles|invitations)|insert into/);
  const login = R('public/login.html');
  assert.match(login, /err\.hint==="own_trial"/);
  assert.match(login, /"Go to my trial studio"/);
  // the accept path still treats it as a final answer (the message says "already")
  assert.match(login, /const terminal=\/invalid invitation\|invitation is \|has expired\|different email\|already\|no longer\//);
});

/* ---- share checklist: 2D / 3D off in the trial ---- */
class N {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this._t = ''; this.hidden = false; this.listeners = {}; this.checked = false; this.disabled = false; this.className = ''; }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  set textContent(v) { this.children = []; this._t = String(v); }
  get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); }
  all() { const o = []; const w = (x) => x.children.forEach((c) => { o.push(c); w(c); }); w(this); return o; }
}
function load(trial, captured) {
  const d = { createElement: (x) => new N(x), createTextNode: (x) => { const k = new N('#text'); k._t = String(x); return k; }, querySelector: () => null, readyState: 'complete' };
  const BPStore = { booklet: { imageInfo: async () => ({}), staffImage: async () => null, setImageVariants: async () => { captured.variants = true; } },
    quotes: { versions: async () => [{ createdAt: '2026-10-01T00:00:00Z' }], get: async () => null }, packages: { forQuote: async () => [] } };
  const cx = { console, URLSearchParams, setTimeout, clearTimeout, setImmediate, document: d, location: { search: '', origin: 'https://www.helm.events' }, addEventListener() {}, removeEventListener() {},
    HelmTrialLock: { isTrial: () => trial, whenKnown: () => Promise.resolve(trial) }, BPStore };
  cx.window = cx; cx.globalThis = cx; vm.createContext(cx); vm.runInContext(R('public/share-checklist.js'), cx);
  return cx;
}

await t('share checklist (trial): 2D / 3D unticked + disabled, note shown, never captured or attached', async () => {
  const captured = {}; const cx = load(true, captured); const S = cx.HelmShareChecklist;
  const host = new N('div');
  const ck = S.mount(host, { quoteId: '11111111-2222-4333-8444-555555555555', cur: { sections: { layout2d: true, layout3d: true, menu: true } },
    autoCapture: async () => { captured.capture = true; return { ok: true }; } });
  await tick();
  const boxes = host.all().filter((x) => x.getAttribute('data-sec') === 'layout2d' || x.getAttribute('data-sec') === 'layout3d');
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((b) => b.disabled && !b.checked), '2D / 3D off + disabled');
  const note = host.all().find((x) => /sc-trial-note/.test(x.className));
  assert.ok(note && !note.hidden && /unlock on a paid plan/.test(note.textContent), 'friendly note');
  const s = ck.sections(); assert.equal(s.layout2d, false); assert.equal(s.layout3d, false); assert.equal(s.menu, true);
  await ck.uploadSnapshots(); await ck.attachSnapshots();
  assert.ok(!captured.capture, 'no background capture'); assert.ok(!captured.variants, 'no picture styles attached');
  assert.equal(S.trialSections({ layout2d: true, layout3d: true }, true).layout2d, false);
  assert.equal(S.trialSections({ layout2d: true, layout3d: true }, false).layout3d, true);
});

await t('share checklist (paid): 2D / 3D kept as before', async () => {
  const captured = {}; const cx = load(false, captured); const S = cx.HelmShareChecklist;
  const host = new N('div');
  const ck = S.mount(host, { quoteId: '11111111-2222-4333-8444-555555555555', cur: { sections: { layout2d: true, layout3d: true } } });
  await tick();
  const boxes = host.all().filter((x) => x.getAttribute('data-sec') === 'layout2d' || x.getAttribute('data-sec') === 'layout3d');
  assert.ok(boxes.every((b) => !b.disabled && b.checked));
  assert.equal(ck.sections().layout2d, true);
  const note = host.all().find((x) => /sc-trial-note/.test(x.className));
  assert.ok(note.hidden);
});

await t('builder: capture refuses in the trial (button, share capture host, after-save refresh)', () => {
  const b = R('public/builder.js');
  const cap = b.slice(b.indexOf('function captureClientImages(silent)'), b.indexOf('async function captureClientImagesRun'));
  assert.match(cap, /if\(builderInTrial\(\)\)\{ if\(!silent\) BPUI\.toast\(CLIENT_IMG_TRIAL_MSG\+'\.',\{type:'info'\}\); return Promise\.resolve\(false\); \}/);
  const host = b.slice(b.indexOf('async function runCaptureHost'), b.indexOf('// capture style -> label mode'));
  assert.match(host, /if\(await captureTrialOff\(\)\)\{ post\(\{type:'helm-capture-done', ok:false, code:'trial', error:CLIENT_IMG_TRIAL_MSG\}\); return; \}/);
  assert.ok(host.indexOf('captureTrialOff') < host.indexOf('captureClientImages(true)'), 'checked before rendering');
  const auto = b.slice(b.indexOf('async function autoCaptureIfStale'), b.indexOf('function importJSON'));
  assert.match(auto, /if\(await captureTrialOff\(\)\) return;/);
  assert.match(b, /const CLIENT_IMG_TRIAL_MSG='Client images unlock on a paid plan';/);
});

/* ---- ui-pickers: no second date face on a page's own hidden helper date box ---- */
await t('ui-pickers: hidden helper date inputs (aria-hidden / hidden) are not enhanced; enhanced natives forced hidden', () => {
  const js = R('public/ui-pickers.js'), css = R('public/ui-pickers.css');
  assert.match(js, /function helperInput\(inp\) \{ return inp\.getAttribute\("aria-hidden"\) === "true" \|\| inp\.hidden \|\| inp\.type === "hidden"; \}/);
  assert.match(js, /if \(inp\.__hp \|\| optedOut\(inp\) \|\| helperInput\(inp\)\) return;/);
  assert.match(css, /opacity: 0 !important; pointer-events: none !important;/);
  assert.match(css, /position: absolute !important;/);
  // behaviour: run the real enhanceDate on fake inputs
  const fn = js.slice(js.indexOf('function helperInput'), js.indexOf('function enhanceDate'));
  const cx = {}; vm.runInNewContext(fn + '\nglobalThis.f=helperInput;', cx);
  const inp = (a, hidden) => ({ getAttribute: (k) => (k in a ? a[k] : null), hidden: !!hidden, type: 'date' });
  assert.equal(cx.f(inp({ 'aria-hidden': 'true' })), true, 'quote-validity qv-native skipped');
  assert.equal(cx.f(inp({}, true)), true);
  assert.equal(cx.f(inp({})), false, 'a normal date field is still enhanced');
  const qv = R('public/quote-validity.js');
  assert.match(qv, /type: "date", cls: "qv-native", tabindex: "-1", "aria-hidden": "true", "data-native-picker": ""/);
  // no other page builds a hidden helper date box that would be enhanced
  for (const f of ['flow.html', 'event.html']) assert.match(R('public/' + f), /ui-pickers\.js\?v=\d+/);
});

/* ---- control center: "Create invite link" label comes back once the invite exists ---- */
await t('control: the guard covers create only; the e-mail flush runs after the label is restored', () => {
  const c = R('public/control.html');
  const h = c.slice(c.indexOf('$("#inv_add").addEventListener("submit"'), c.indexOf('$("#inv_link").addEventListener("click"'));
  const g0 = h.indexOf('await BPUI.guard($("#inv_submit")'), g1 = h.indexOf('{busyLabel:"Creating…"})');
  assert.ok(g0 > 0 && g1 > g0);
  const inGuard = h.slice(g0, g1), after = h.slice(g1);
  assert.match(inGuard, /BPStore\.invitations\.create\(email, role\)/);
  assert.doesNotMatch(inGuard, /sendNow|resendEmail/, 'no slow mail call inside the busy guard');
  assert.match(after, /await renderInvites\(\)/, 'seat lock re-applied after the guard re-enabled the button');
  assert.match(after, /BPStore\.invitations\.sendNow\(\)/);
  assert.match(after, /setUMsg\(\.\.\.inviteMailMsg\(sent,email\)\)/);
});

await t('page tour: the share & approval step mentions client images + the trial', () => {
  assert.match(R('public/page-tours.js'), /sel: "#sec-approve", title: "Share & approval"[^}]*Client 2D \/ 3D images come with a paid plan, so they are off in the free trial/);
});

/* ---- coordinator additions (staging trial walk-through, TRIAL-ADMIN-FLOWS.md) ---- */
await t('layout rules: "Seats for each guest" + stepper goes 1 -> 1.1 -> 1.2 and saves (no float "2 decimals" error)', () => {
  const win = { document: { createElement() { return {}; } }, addEventListener() {} }; win.window = win;
  const ctx = vm.createContext({ window: win, document: win.document, Promise, Object, Array, String, Number, Math, JSON, RegExp });
  vm.runInContext(R('public/layout-rules.js').replace('typeof window !== "undefined" ? window : globalThis', 'window'), ctx);
  const C = win.HelmLayoutRules.core, f = C.FIELDS.find((x) => x.key === 'seatsPerGuest');
  const round = (n, dp) => { const p = Math.pow(10, dp || 0); return Math.round(n * p) / p; };
  let v = 1; const seen = [];
  for (let i = 0; i < 12; i++) { const c = C.checkNumber(f, String(v)); assert.ok(c.ok, String(v) + ' ' + c.error); v = round(c.value + f.step, 2); seen.push(v); }
  assert.deepEqual(seen.slice(0, 3), [1.1, 1.2, 1.3]);
  for (const ok of ['1.1', '2.25', '0.5', '3']) assert.ok(C.checkNumber(f, ok).ok, ok);
  assert.match(C.checkNumber(f, '1.123').error, /2 decimals at most/);
});

await t('e-mail send: a transport error is said in plain words (never "HTTP 404")', () => {
  const js = R('public/email-send.js');
  const fn = js.slice(js.indexOf('function friendlyReason'), js.indexOf('// opts: { quoteId'));
  const cx = {}; vm.runInNewContext(fn + '\nglobalThis.f=friendlyReason;', cx);
  for (const raw of ['HTTP 404', 'HTTP 500', 'HTTP 401', 'HTTP 429', 'Failed to fetch', '']) assert.doesNotMatch(cx.f(raw), /HTTP \d|fetch/i, raw);
  assert.match(cx.f('HTTP 404'), /isn't switched on yet/);
  assert.match(js, /msg\.textContent = "Not sent: " \+ friendlyReason\(\(err && err\.message\) \|\| ""\);/);
});

await t('automations: trial wording matches the approval panel (client link e-mails DO send, automations do not)', () => {
  const a = R('public/automations.js');
  assert.match(a, /Free trial: these automatic e-mails and WhatsApp messages are not sent during the trial, even when switched on\. The approval and booklet links you e-mail to a client yourself DO go out \(up to 30 a day\)\./);
  assert.doesNotMatch(a, /"Free trial: e-mails and WhatsApp messages are not sent during the trial, even when switched on\."/);
});

await t('builder: click-to-add steps each new item off the one before (no stacking)', () => {
  const b = R('public/builder.js');
  assert.match(b, /if\(!atFt\)\{ const p=newItemSpot\(x, y, a\.w, a\.h\); x=p\.x; y=p\.y; \}/);
  const fn = b.slice(b.indexOf('function newItemSpot'), b.indexOf('async function addAsset'));
  const cx = { store: { items: [] }, WORLD: { w: 200, h: 120 }, clamp: (v, a, z) => Math.min(z, Math.max(a, v)), snapFt: (v) => Math.round(v) };
  vm.runInNewContext(fn + '\nglobalThis.f=newItemSpot;', cx);
  const spots = [];
  for (let i = 0; i < 5; i++) { const p = cx.f(100, 60, 4, 4); spots.push(p.x + ',' + p.y); cx.store.items.push({ x: p.x, y: p.y }); }
  assert.equal(new Set(spots).size, 5, 'five adds = five different spots: ' + spots.join(' '));
  assert.equal(spots[0], '100,60', 'the first lands at the centre');
});

await t('0316: a task from a sample "Demo . " template on a real event drops the prefix (sample events keep it)', () => {
  assert.match(SQL, /create trigger a1_r316_task_title before insert on public\.event_tasks/);
  assert.match(SQL, /new\.title like \('Demo ' \|\| chr\(183\) \|\| ' %'\)/);
  assert.match(SQL, /select coalesce\(q\.is_demo, false\) into v_demo from public\.quotes q where q\.id = new\.quote_id/);
});

console.log(`r106-trial-gaps: ${n} ok`);
