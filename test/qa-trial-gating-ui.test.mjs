// QA (release 1018-b, staging) - free-trial gating UI: B2 B3 B4 B5 B22 B23 B25 B26.
// Pure functions are run for real (require / vm); page wiring is checked in the source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0, failed = 0;
function t(name, fn) { try { fn(); n++; console.log('ok - ' + name); } catch (e) { failed++; console.error('FAIL - ' + name + '\n', e); process.exitCode = 1; } }
// the source of one function (brace-matched) so a browser-only file can be run in a sandbox
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const docStub = (cls) => ({ documentElement: { classList: { contains: (c) => (cls || []).includes(c) } } });

const AUI = r('public/auth-ui.js'), TRIAL = r('public/trial.js'), TD = r('public/trial-demo.js'), SB = r('public/shell-b.js');
const TL = r('public/trial-lock.js'), TLC = r('public/trial-lock.css'), SS = r('public/studio-search.js'), SBS = r('public/shell-b-search.js');
const CS = r('public/control-split.js'), CSC = r('public/control-split.css'), TSU = r('public/trial-signup.js');

// ---------------------------------------------------------------------------------------------- B2
const T = require('../public/trial.js');
t('B2: a trial studio my_trial_org() does not cover still gets "Free trial · N days left" + Choose a plan', () => {
  const now = Date.parse('2026-10-18T10:00:00Z');
  const s = T.subscriptionStrip({ state: 'trial', status: 'trial', ends_at: '2026-10-29', days_left: 11, is_admin: true }, { is_trial_org: false }, now, 'Asia/Kolkata');
  const b = T.bannerSpec(s);
  assert.equal(b.title, 'Free trial · 11 days left'); assert.equal(b.cta, 'Choose a plan'); assert.equal(b.body, null); assert.equal(b.locked, false);
  // member: strip, no button
  assert.equal(T.bannerSpec(T.subscriptionStrip({ state: 'trial', ends_at: '2026-10-29', is_admin: false }, null, now, 'Asia/Kolkata')).cta, null);
  // last day / tomorrow, counted in the studio zone (late evening UTC = next day in IST)
  assert.equal(T.bannerSpec(T.subscriptionStrip({ state: 'trial', ends_at: '2026-10-29' }, null, Date.parse('2026-10-28T20:00:00Z'), 'Asia/Kolkata')).title, 'Free trial · ends today');
  assert.equal(T.bannerSpec(T.subscriptionStrip({ state: 'trial', ends_at: '2026-10-29' }, null, Date.parse('2026-10-28T10:00:00Z'), 'Asia/Kolkata')).title, 'Free trial · 1 day left');
});
t('B2: no second strip for a start_trial() studio, none for an ended / paid / missing answer', () => {
  assert.equal(T.subscriptionStrip({ state: 'trial', ends_at: '2026-10-29' }, { is_trial_org: true }, Date.now(), 'Asia/Kolkata'), null);
  assert.equal(T.subscriptionStrip({ state: 'ended', ends_at: '2026-10-01' }, null, Date.now()), null);
  assert.equal(T.subscriptionStrip({ state: 'none' }, null, Date.now()), null);
  assert.equal(T.subscriptionStrip(null, null, Date.now()), null);
  assert.match(TRIAL, /render\(bannerSpec\(subscriptionStrip\(s, t, Date\.now\(\), tz\)\)\)/);
  assert.match(TRIAL, /if \(!\(t && t\.is_trial_org === true\) && st\.subscription && typeof st\.subscription\.trial === "function"\)/);
});
t('B2: auth-ui - trial = the subscription answer; no demo card, no old "ends in N days" card, no "Set up your studio"', () => {
  const ctx = {}; vm.runInNewContext(fnSrc(AUI, 'onTrial') + '\nglobalThis.f = onTrial;', Object.assign(ctx, { doc: docStub([]) }));
  assert.equal(ctx.f({ state: 'trial', status: 'trial' }), true);
  assert.equal(ctx.f({ state: 'ended', status: 'trial' }), true);          // ended unpaid: still no remove-the-samples card
  assert.equal(ctx.f({ state: 'none', status: 'active' }), false);
  const c2 = {}; vm.runInNewContext(fnSrc(AUI, 'onTrial') + '\nglobalThis.f = onTrial;', Object.assign(c2, { doc: docStub(['helm-trial']) }));
  assert.equal(c2.f(null), true); assert.equal(c2.f({ state: 'none', status: 'active' }), false);   // the server answer wins over the cached class
  assert.match(AUI, /if \(!onTrial\(t\)\) demoStatus\(t, d\);/);
  assert.match(AUI, /var spec = \(o && o\.is_trial_org === true\) \|\| \(t && t\.state === "trial"\) \? null : trialNotice\(t\);/);
  assert.match(AUI, /secondary: null,/); assert.doesNotMatch(AUI, /label: "Set up your studio", onClick: goDemoSwitch/);
});
t('B2: Plan & billing date - a calendar day is never moved a day by the zone, India format', () => {
  const ctx = { S: () => null }; vm.runInNewContext(fnSrc(AUI, 'day') + '\nglobalThis.day = day;', ctx);
  assert.equal(ctx.day('2026-10-29'), '29 Oct 2026');
  assert.equal(ctx.day(null), '—');
  // with the store: BPStore.fmtStudioDate (studio zone + locale) is used
  const c2 = { S: () => ({ fmtStudioDate: (v, o) => 'X' + v + o.style }) }; vm.runInNewContext(fnSrc(AUI, 'day') + '\nglobalThis.day = day;', c2);
  assert.equal(c2.day('2026-10-29'), 'X2026-10-29long');
});

// ---------------------------------------------------------------------------------------------- B3
t('B3: trial-demo - no remove / clear entry point during the trial', () => {
  const ctx = {}; vm.runInNewContext(fnSrc(TD, 'trialOn') + '\nglobalThis.f = trialOn;', Object.assign(ctx, { doc: docStub([]) }));
  assert.equal(ctx.f({ state: 'trial', status: 'trial' }), true); assert.equal(ctx.f({ state: 'none', status: 'active' }), false);
  for (const fn of ['startFresh', 'openSwitch', 'clearSample', 'clearDemo']) assert.match(fnSrc(TD, fn), /if \(await trialNow\(\)\) \{ toast\(TRIAL_KEEP, "info"\); return/, fn);
  assert.match(TD, /if \(place === "control" && !inTrial\) \{ const c = btn\("Clear sample data"/);
  assert.match(fnSrc(TD, 'render'), /if \(v === "leftover"\) \{\s*if \(inTrial\) \{ host\.hidden = true; return; \}/);
  assert.match(TD, /if \(!inTrial && d\.is_admin && d\.has_demo && \/\[\?&\]demo=\(switch\|fresh\)\\b\/\.test\(q\)\) startFresh\(\{\}\);/);
  assert.match(TD, /const inTrial = trialOn\(t\);/);
  assert.match(fnSrc(AUI, 'goDemoSwitch'), /if \(onTrial\(null\)\) return;/);
});

// ---------------------------------------------------------------------------------------------- B4 + B23
t('B4/B23: sidebar - no Audit log, Studio setup or Reports in any free trial (subscription answer)', () => {
  const ae = fnSrc(SB, 'adminExtras');
  assert.match(ae, /var trial = trialKnown\(\);/);
  assert.match(ae, /\[\(ctl \|\| rl === "admin"\) && !inTrial, "audit"/);
  assert.match(ae, /\[ctl && !inTrial, "setup"/);
  assert.match(ae, /\[\(ctl \|\| \/\^\(admin\|manager\|planner\)\$\/\.test\(rl\)\) && !inTrial, "reports"/);
  const tk = fnSrc(SB, 'trialKnown');
  assert.match(tk, /HelmTrialLock/); assert.match(tk, /whenKnown\(\)/); assert.match(tk, /t\.status === "trial" \|\| t\.state === "trial"/);
});
t('B4/B23: direct URL - audit + reports pages are covered and sent back to the dashboard', () => {
  const m = /var BLOCKED_PAGES = (\/.*\/);/.exec(TL); assert.ok(m);
  const re = vm.runInNewContext(m[1]);
  for (const p of ['/audit.html', '/koushik/audit', '/reports.html', '/koushik/reports', '/onboarding.html', '/koushik/templates']) assert.ok(re.test(p), p);
  for (const p of ['/dashboard.html', '/koushik/business', '/audit-co/dashboard', '/koushik/insights']) assert.ok(!re.test(p), p);
  assert.match(TL, /else if \(which === "reports"\) cover\("Reports & exports are not part of the free trial"/);
  assert.match(TL, /else if \(which === "audit"\) cover\("The activity log is not part of the free trial"/);
  assert.match(TL, /\(onboarding\|templates\|audit\|reports\)\\\/\?\$\/\.exec/);   // pretty-URL home()
});
t('B4/B23/B26: trial-lock.css hides the rail / pinned items + every Reports link + builder More menu', () => {
  for (const sel of ['a.hb-item[data-key="audit"]', 'a.hb-item[data-key="setup"]', 'a.hb-item[data-key="reports"]', 'a.hb-item[data-key="templates"]',
    '[data-fkey="audit"]', '[data-fkey="reports"]', 'a[href="reports.html"]', 'a[href="/reports.html"]', 'a[href$="/reports"]', '#moreMenu',
    'a[href$="/audit"]', '.hd-act-card']) assert.ok(TLC.includes('html.helm-trial ' + sel), sel);
  // every rule stays scoped to html.helm-trial (a paid studio is unchanged)
  const rules = TLC.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((x) => x.split('{')[0].trim()).filter(Boolean);
  for (const sel of rules) { if (/^\.tl-/.test(sel)) continue; sel.split(',').forEach((s) => assert.match(s.trim(), /^html\.helm-trial/, s)); }
});

// ---------------------------------------------------------------------------------------------- B5
const CAT = require('../public/search-catalog.js');
const admin = { role: async () => 'admin', canView: async () => true };
await (async () => {
  const paid = await CAT.entriesFor(admin, { integrationsPage: true }, { trial: false });
  const trial = await CAT.entriesFor(admin, { integrationsPage: true }, { trial: true });
  const txt = (l) => l.map((e) => e.text);
  const OFF = ['Studio setup', 'General', 'Studio account', 'Import & custom fields', 'Import from Excel', 'Import staff', 'Import dishes',
    'Import inventory', 'Import vendors', 'Data & compliance', 'Notifications', 'Photo renders', 'Client links — auto-expire', 'Templates',
    'Layout templates', 'Logo URL', 'Accent colour', 'Audit log', 'Reports'];
  t('B5: search catalog - trial hides ' + OFF.length + ' restricted entries; paid studio unchanged', () => {
    for (const x of OFF) { assert.ok(txt(paid).includes(x), 'paid has ' + x); assert.ok(!txt(trial).includes(x), 'trial hides ' + x); }
    for (const x of ['Dashboard', 'Quotes & events', 'Leads', 'Plan & billing', 'Pricing & coupons', 'Menus & catalog', 'Users & invites', 'Venues', 'Two-step sign-in (2FA)'])
      assert.ok(txt(trial).includes(x), 'trial keeps ' + x);
    // ranked: "import" / "audit" / "studio" find nothing restricted in the trial
    for (const q of ['import', 'audit', 'studio', 'render', 'expire', 'template', 'brand', 'compliance', 'notification', 'general'])
      CAT.rank(q, trial, require('../public/settings-search-core.js'), 20).forEach((e) => assert.ok(!CAT.trialOff(e), q + ' -> ' + e.text));
    assert.deepEqual(Object.keys(CAT.TRIAL_OFF_SECTIONS).sort(), ['compliance', 'data', 'general', 'links', 'ltemplates', 'notify', 'privacy', 'reminders', 'renders']);
    // the same list as control-split.js
    const m = /var TRIAL_OFF=(\{[^}]*\})/.exec(CS); assert.ok(m);
    assert.deepEqual(Object.keys(vm.runInNewContext('(' + m[1] + ')')).sort(), Object.keys(CAT.TRIAL_OFF_SECTIONS).sort());
    // no trial flag -> asks the page (Node: no document -> not a trial)
    assert.equal(CAT.forTrial([{ kind: 'page', key: 'audit' }]).length, 1);
    assert.equal(CAT.forTrial([{ kind: 'page', key: 'audit' }], true).length, 0);
  });
})();
t('B5: palette - filtered at search time, trial-off actions dropped, footer counts the rows shown', () => {
  assert.match(SS, /if \(typeof cat\.forTrial === "function"\) list = cat\.forTrial\(list, trialOn\(\)\);/);
  assert.match(SS, /filter\(\(a\) => trialAction\(a\) && matchAction\(a, q\)\)/);
  assert.match(SS, /const TRIAL_OUT = \/\(\^\|\\\/\)\(onboarding\|templates\|audit\|reports\)/);
  assert.match(SS, /const c = S\.opts\.length;/); assert.doesNotMatch(SS, /const c = S\.groups\.reduce/);
  assert.match(SBS, /var TRIAL_OUT = \/\^\\\/\?\(templates\|onboarding\|audit\|reports\)/);
  const m = /var TRIAL_OUT = (\/.*\/);/.exec(SBS); const re = vm.runInNewContext(m[1]);
  for (const h of ['/audit.html', '/reports.html', '/onboarding.html', '/templates.html']) assert.ok(re.test(h), h);
  assert.ok(!re.test('/insights.html') && !re.test('/business.html'));
});
t('B5: Control Center settings search - no trial-off page hits; dropdown fits the settings column', () => {
  assert.match(CS, /PAGES\.forEach\(function\(p\)\{ if\(trial\(\) && CAT && CAT\.trialOff && CAT\.trialOff\(\{kind:"page",key:p\.key,href:p\.href\}\)\) return;/);
  assert.match(CS, /return \{key:e\.key,text:e\.text,href:e\.href,kw:e\.keywords\};/);
  assert.match(CSC, /\.cs-results\{position:absolute;left:0;top:100%;margin-top:8px;z-index:40;width:100%;/);
  assert.doesNotMatch(CSC, /width:max\(100%,360px\)/);
});

// ---------------------------------------------------------------------------------------------- B22
t('B22 + r19: quotes are not capped in the trial - "New quote" opens the flow directly (no dialog, no "1 of 2" text)', () => {
  const NQ = r('public/new-quote-dialog.js');
  assert.doesNotMatch(NQ, /Free trial: a new quote uses|used its|used\.quotes/);
  const dash = r('public/dashboard.html'), quotes = r('public/quotes.html');
  for (const [name, src] of [['dashboard', dash], ['quotes', quotes], ['shell-b', SB]]) {
    assert.ok(src.indexOf('startBlank(') > 0, name + ': creates through startBlank (reuses an untouched blank quote)');
    assert.ok(src.indexOf('HelmNewQuote.ask(') < 0 && src.indexOf('NQ.ask(') < 0, name + ': no pre-create dialog');
  }
});

// ---------------------------------------------------------------------------------------------- B25
const TS = require('../public/trial-signup.js');
t('B25: "What\'s in your free trial" box on the trial sign-up (caps, test mode, sample data, N days)', () => {
  const all = TS.TRIAL_KEY.map((k) => k.t + ' ' + k.s).join(' ') + ' ' + TS.TRIAL_ALL.join(' ');
  assert.match(all, /8 days free/); assert.match(all, /sample data/i); assert.match(all, /test mode/i); assert.match(all, /up to 2 new records/);
  assert.match(TSU, /What’s in your free trial/);
  assert.match(fnSrc(TSU, 'trialTerms'), /var show = mode === "signup" && !joining && !direct(?: && TRIAL_KEY\.length > 0)?;/);   // + 0207 (trial-facts.js)
  assert.match(r('public/login.html'), /trial-terms\.css\?v=\d+/);
});

// ---------------------------------------------------------------------------------------------- B26
t('B26: a new trial is locked from its very first page (cached flag at sign-up); early lock loads trial-lock.css', () => {
  assert.match(fnSrc(TSU, 'start'), /localStorage\.setItem\("helm\.trial", "1"\)/);
  const EARLY = r('public/trial-early.js');
  assert.match(EARLY, /getItem\("helm\.trial"\) !== "1"/); assert.match(EARLY, /trial-lock\.css\?v=\d+/);
  // the pin is the same everywhere it is loaded
  const v = /trial-lock\.css\?v=(\d+)/.exec(EARLY)[1];
  for (const f of ['public/trial-lock.js', 'public/shell-proto.js', 'public/store-api.js', 'public/builder.html']) assert.match(r(f), new RegExp('trial-lock\\.css\\?v=' + v), f);
});

// ---------------------------------------------------------------------------------------------- review
t('review: the dashboard "Finish setting up your studio" nudge is hidden in the trial (not only its link)', () => {
  assert.match(TLC, /html\.helm-trial #obNudge[^{]*\{ display: none !important; \}/);
});
{
  // async: run before the summary line (t() is sync, so this one awaits on its own)
  const name = 'review: trial-demo trialNow() - a confirmed trial refuses at once; the early (cached) class asks the server';
  const src = fnSrc(TD, 'trialOn') + '\nglobalThis.trialNow = async ' + fnSrc(TD, 'trialNow') + ';';
  const run = async (cls, sub) => {
    const ctx = { doc: docStub(cls), S: () => ({ subscription: { trial: async () => { if (sub instanceof Error) throw sub; return sub; } } }) };
    vm.createContext(ctx); vm.runInContext(src, ctx);
    return ctx.trialNow();
  };
  try {
    assert.equal(await run(['helm-trial'], { state: 'none', status: 'active' }), true);                    // confirmed class wins
    assert.equal(await run(['helm-trial', 'helm-trial-early'], { state: 'none', status: 'active' }), false); // just paid: server says no
    assert.equal(await run(['helm-trial', 'helm-trial-early'], new Error('offline')), true);                 // cannot ask: refuse
    assert.equal(await run([], { state: 'trial', status: 'trial' }), true);
    assert.equal(await run([], { state: 'none', status: 'active' }), false);
    n++; console.log('ok - ' + name);
  } catch (e) { failed++; console.error('FAIL - ' + name + '\n', e); process.exitCode = 1; }
}

console.log(`qa-trial-gating-ui: ${n} passed${failed ? ', ' + failed + ' FAILED' : ''}`);
