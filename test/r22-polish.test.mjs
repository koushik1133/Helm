// r22 polish (live-QA P3s, public pages + app shell):
//  1  landing: the trial-guide bottom sheet sits flush on the bottom edge while the sticky CTA bar is on (and the bar hides)
//  2  /grievance, /refund-policy, /security (+ copyright, ai-notice, data-deletion): titles single-encoded
//  3  CSP: report-to group + Reporting-Endpoints header next to report-uri (vercel.json, _headers, server.js prod hosts)
//  4  checkout Contact sales: studio name (organization) + your name (profile / auth user_metadata) prefilled
//  5  chat: Escape closes the ⋮ menu and returns focus to its button
//  6  shell: profile button aria-label uses the display name (profile, then sign-up name, then e-mail)
//  7  "Choose a plan" from a pretty /<slug>/events/<code> page passes that path as next (checkout safeNext re-builds it)
//  8  a closed event: Closed step ticked, no card tagged "Next"
//  9  /flow?quote=<event number> resolves within the caller's studio (resolve_event_ref); a UUID still works
// 10  quote page receipt dates use the studio formatter's default (dd/mm/yyyy)
// 11  /manual: no inline <style> (stylesheet); imported manual <style> elements are stripped (CSS adopted)
// 12  notification types: "Security alerts (Helm HQ only)" (bell muted list + Settings catalog)
// 13  staff sheet: only one button reads "Cancel" (the department row says "Discard")
// 14  landing phone-reel thumbnails use small webp variants with srcset / sizes
import { readFileSync, existsSync, statSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const API = read('public/store-api.js'), AUI = read('public/auth-ui.js'), TJS = read('public/trial.js');

await t('1 landing: guide sheet bottom:0 beats the has-mcta offset; sticky bar hides while the sheet is open', () => {
  const css = read('public/home.css'), g = read('public/home-guide.css'), js = read('public/home-guide.js');
  assert.match(css, /body\.has-mcta \.hg\{bottom:calc\(/);
  assert.match(css, /body\.has-mcta \.hg\.sheet,body\.hg-sheet-open \.hg\.sheet\{bottom:0\}/);
  assert.ok(css.indexOf('body.has-mcta .hg.sheet') > css.indexOf('body.has-mcta .hg{'), 'override comes after the offset');
  assert.match(g, /body\.hg-sheet-open \.mcta\{transform:translateY\(110%\);visibility:hidden\}/);
  assert.match(js, /document\.body\.classList\.toggle\('hg-sheet-open', open && smallMq\.matches\)/);
});

await t('2 legal titles: no double-encoded &amp;amp; anywhere in public HTML', () => {
  for (const f of ['grievance', 'refund-policy', 'security', 'copyright', 'ai-notice', 'data-deletion']) {
    const h = read(`public/${f}.html`);
    assert.doesNotMatch(h, /&amp;amp;/, f);
    const title = /<title>([^<]*)<\/title>/.exec(h)[1];
    assert.match(title, / &amp; /, f + ' title');
    assert.match(h, new RegExp(`<meta property="og:title" content="${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`), f + ' og');
    assert.match(h, new RegExp(`<meta name="twitter:title" content="${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`), f + ' twitter');
  }
});

await t('3 CSP report-to + Reporting-Endpoints on production policies only; vercel.json under the size limit', () => {
  const { withReporting, reportingEndpoints } = require('../scripts/csp-hashes.cjs');
  const URI = 'https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/csp-report';
  assert.equal(reportingEndpoints(URI), 'csp-endpoint="' + URI + '"');
  assert.equal(reportingEndpoints(''), '');
  assert.equal(withReporting("default-src 'self'; report-to old; report-uri x", { reportUri: 'https://r' }), "default-src 'self'; report-uri https://r; report-to csp-endpoint");
  assert.equal(withReporting("default-src 'self'", {}), "default-src 'self'", 'no report URL -> no report-to');
  const raw = read('vercel.json'), VJ = JSON.parse(raw);
  assert.ok(Buffer.byteLength(raw) < 200 * 1024, 'vercel.json < 200 KB');
  for (const rule of VJ.headers) for (const h of rule.headers || []) {
    if (h.key !== 'Content-Security-Policy') continue;
    const staging = rule.has && rule.has[0].value === 'helm-v01.vercel.app';
    assert.equal(/; report-to csp-endpoint(;|$)/.test(h.value), !staging, rule.source + (staging ? ' (staging)' : ''));
  }
  const all = VJ.headers.find((r) => r.source === '/(.*)' && !r.has);
  const re = all.headers.find((h) => h.key === 'Reporting-Endpoints');
  assert.ok(re, 'catch-all has Reporting-Endpoints');
  assert.equal(re.value, 'csp-endpoint="' + URI + '"');
  const HDR = read('public/_headers');
  assert.equal((HDR.match(/^\s+Reporting-Endpoints: /gm) || []).length, 1);
  // R65: single leading [ \t] per line (not [ \t]+.*) avoids ReDoS (js/redos); matches the same _headers block.
  assert.match(HDR, /^\/\*\n(?:[ \t][^\n]*\n)*?[ \t]+Content-Security-Policy:.*\n[ \t]+Reporting-Endpoints: csp-endpoint="https:\/\/nqltzgiwznphugcfhmbm\.supabase\.co\/functions\/v1\/csp-report"\n/m);
  assert.equal((HDR.match(/report-to csp-endpoint/g) || []).length, (HDR.match(/report-uri https:\/\/nqltzgiwznphugcfhmbm/g) || []).length);
  const SRV = read('server.js');
  assert.match(SRV, /const re = reportingEndpoints\(prodReporting\(\)\.reportUri\);[^\n]*\n\s*if \(re\) h\['Reporting-Endpoints'\] = re;/);
  // the edge function takes the Reporting API body type
  assert.match(read('supabase/functions/csp-report/index.ts'), /reports\\\+json/);
});

await t('4 checkout Contact sales: studio name + your name prefilled for a trial admin', () => {
  const CO = read('public/checkout.js');
  assert.match(CO, /var meta = u\.user_metadata && typeof u\.user_metadata === "object" \? u\.user_metadata : \{\};/);
  assert.match(CO, /if \(!who\.name\) who\.name = String\(meta\.full_name \|\| meta\.name \|\| ""\)/);
  assert.match(CO, /S\.profile\.mine\(\)\.then\(function \(p\) \{ var n = p && String\(p\.full_name \|\| ""\)\.trim\(\); if \(n && !acct\.primary_contact_name\) who\.name = n; \}/);
  assert.match(CO, /if \(!who\.studio && S\.org && typeof S\.org\.identity === "function"\)\s*Promise\.resolve\(S\.org\.identity\(\)\)\.then\(function \(d\) \{ if \(d && d\.name && !who\.studio\) who\.studio = String\(d\.name\); \}/);
  // openSales only fills EMPTY fields from who (never overwrites what was typed)
  assert.match(CO, /if \(!f\.value && who\[k\]\) f\.value = who\[k\];/);
});

await t('5 chat: Escape closes the ⋮ menu (and reaction popover) and refocuses the opener', () => {
  const C = read('public/chat.html');
  assert.match(C, /document\.addEventListener\("keydown",\(e\)=>\{ if\(e\.key!=="Escape"\|\|!document\.querySelector\("\.menu,\.rxpop"\)\) return;\s*e\.preventDefault\(\); e\.stopPropagation\(\); closeMenus\(\);\s*if\(menuAnchor&&menuAnchor\.isConnected&&menuAnchor\.focus\)\{ try\{ menuAnchor\.focus\(\); \}catch\(err\)\{\} \} \}\);/);
  assert.match(C, /function openMenu\(anchor, items\)\{ closeMenus\(\); menuAnchor=anchor;/);
});

await t('6 profile button label: profile name > sign-up name (user_metadata) > e-mail local part', () => {
  const ctx = { S: () => ({ auth: { admin: { roleLabel: (r) => r } } }) };
  vm.runInNewContext('var AV_COLORS = 8;\n' + ['initials', 'avColorIdx', 'menuModel'].map((f) => fnSrc(AUI, f)).join('\n') + '\nglobalThis.mm=menuModel;', ctx);
  const u = { id: 'u1', email: 'koushik.lf38@example.test', user_metadata: { full_name: 'Koushik  Goud' } };
  assert.equal(ctx.mm(u, null, 'admin').name, 'Koushik Goud', 'before the profile loads');
  assert.equal(ctx.mm(u, { full_name: 'S Koushik' }, 'admin').name, 'S Koushik', 'profile wins');
  assert.equal(ctx.mm({ id: 'u2', email: 'koushik.lf38@example.test' }, null, 'admin').name, 'koushik.lf38', 'last resort');
  assert.equal(ctx.mm(u, null, 'admin').initials, 'KG');
  assert.match(AUI, /"aria-label": "Open profile menu for " \+ m\.name/);
});

await t('7 "Choose a plan" next = the pretty same-origin path; checkout safeNext accepts + rebuilds it', () => {
  const T = (() => { const g = { document: { readyState: 'complete', addEventListener() {} } }; return g; })();
  vm.runInNewContext(fnSrc(TJS, 'planHref') + '\n' + fnSrc(TJS, 'talkHref') + '\nthis.planHref=planHref;this.talkHref=talkHref;', T);
  assert.equal(T.planHref(null, '/sparkv/events/SMP-1001'), 'checkout.html?next=%2Fsparkv%2Fevents%2FSMP-1001');
  assert.equal(T.planHref(null, 'leads'), 'checkout.html?next=leads.html'); assert.equal(T.planHref(null, ''), 'checkout.html?next=dashboard.html');
  assert.equal(T.talkHref('/sparkv/events/SMP-1001'), 'checkout.html?next=%2Fsparkv%2Fevents%2FSMP-1001&sales=banner');
  assert.match(fnSrc(TJS, 'hereRef'), /U\.route\(\)\) return U\.here\(\)\.split\("#"\)\[0\]/);
  assert.match(TJS, /a\.href = planHref\(lastT, hereRef\(\)\);/); assert.doesNotMatch(TJS, /planHref\(lastT, page\(\)\)/);
  assert.match(fnSrc(AUI, 'checkoutNextRef'), /U\.here\(\)\.split\("#"\)\[0\];[\s\S]*return pageName\(\) \+ "\.html";/);
  assert.match(AUI, /location\.assign\("checkout\.html\?next=" \+ encodeURIComponent\(checkoutNextRef\(\)\)\)/);
  assert.match(fnSrc(API, 'capHref'), /U\.route\(\)\) return "\/checkout\?next=" \+ encodeURIComponent\(U\.here\(\)\.split\("#"\)\[0\]\)/);
  // checkout: next() = safeNext(?next=) and safeNext re-builds a pretty path from HelmUrl.parse (fixed sections, no open redirect)
  assert.match(API, /next: \(\) => safeNext\(nextParam\(\)\),/);
  const sn = fnSrc(API, 'safeNext');
  assert.match(sn, /raw\.charAt\(0\) === "\/" && raw\.charAt\(1\) !== "\/" && raw\.charAt\(1\) !== "\\\\"/);
  assert.match(sn, /return HelmUrl\.build\(r\.kind, \{ studio: r\.studio, ref: r\.ref, query: q \}\);/);
});

await t('8 closed event: effStage = closed, the Closed step is ticked, nothing tagged "Next"', () => {
  const E = read('public/event.html');
  assert.match(E, /if\(ev && k!=="cancelled" && \(k==="closed" \|\| !!ev\.closedAt \|\| !!\(closureSummary&&closureSummary\.closed\)\)\) return "closed";/);
  assert.match(E, /const fin=STAGES\[cur\]&&STAGES\[cur\]\.k==="closed";/);
  assert.match(E, /const done=\(i<cur && stageMet\(s\.k\)\) \|\| \(fin && i===cur\)/);
  assert.match(E, /const reco=!evClosedNow\(\) && recommended\.includes\(c\.key\)\?"reco":"";/);
  assert.equal((E.match(/margin-left:auto">Next</g) || []).length, 1, 'the only Next tag is behind reco');
});

await t('9 /flow?quote=<code>: resolved in the caller\'s studio, then the same page with the id; UUID unchanged', async () => {
  const F = read('public/flow.html');
  assert.match(F, /if\(!HelmUrl\.isUuid\(id\) && HelmUrl\.eventId\)\{ let rid=null; try\{ rid=await HelmUrl\.eventId\(id\); \}catch\(_\)\{ rid=null; \}\s*if\(!rid\)\{ showNotFound\(\); return; \}/);
  assert.match(F, /sp\.delete\("id"\); sp\.set\("quote",rid\);\s*location\.replace\(location\.pathname\+"\?"\+sp\.toString\(\)\+location\.hash\); return; \}/);
  assert.ok(F.indexOf('HelmUrl.eventId(id)') < F.indexOf('await openQuote();\n  });'), 'resolved before the quote loads');
  const at = API.indexOf('HelmUrl.eventId = async function (ref) {'); assert.ok(at > 0);
  const body = API.slice(at, API.indexOf('};', at) + 2);
  // run it against stubs: UUID passes straight through; a code goes through refToId("event", …) (resolve_event_ref)
  const calls = [];
  const HelmUrl = { isUuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')) };
  const ctx = { HelmUrl, ready: async () => {}, refToId: async (k, r) => { calls.push([k, r]); return r === 'SMP-1003' ? { id: '11111111-2222-4333-8444-555555555555', ref: 'SMP-1003' } : null; } };
  vm.runInNewContext(body, ctx);
  assert.equal(await HelmUrl.eventId('11111111-2222-4333-8444-555555555555'), '11111111-2222-4333-8444-555555555555');
  assert.equal(calls.length, 0, 'a UUID needs no lookup');
  assert.equal(await HelmUrl.eventId(' SMP-1003 '), '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(calls[0], ['event', 'SMP-1003']);
  assert.equal(await HelmUrl.eventId('SMP-9999'), null);
  assert.equal(await HelmUrl.eventId(''), null); assert.equal(await HelmUrl.eventId('x'.repeat(81)), null);
  // the RPC is the studio-scoped one (0067: current_org_id + has_area quotes view)
  assert.match(fnSrc(API, 'refToId'), /rpc\("resolve_event_ref", \{ p_ref: ref \}\)/);
  assert.match(read('supabase/migrations/0067_pretty_urls.sql'), /where q\.org_id = v_org and upper\(q\.code\) = upper\(v_r\)/);
});

await t('10 quote page receipts: studio date format (no long "7 Oct 2026" style)', () => {
  const F = read('public/flow.html');
  assert.match(F, /BPStore\.fmtStudioDate\(p\.paid_at\)/);
  assert.doesNotMatch(F, /fmtStudioDate\(p\.paid_at,\{style:"long"\}\)/);
});

await t('11 /manual: shell CSS in manual.css; parsed manual <style> elements stripped after their CSS is adopted', () => {
  const H = read('public/manual.html'), M = read('public/manual.js');
  assert.doesNotMatch(H, /<style[\s>]/);
  assert.match(H, /<link rel="stylesheet" href="\/manual\.css\?v=\d+">/);
  assert.match(read('public/manual.css'), /\.mstate\{max-width:560px;/);
  assert.match(M, /root\.querySelectorAll\("script,style,iframe,frame,object,embed,link,meta,base,form,noscript,template"\)/);
  assert.ok(M.indexOf('doc.querySelectorAll("style")') < M.indexOf('sanitize(doc);'), 'CSS read before the sanitize strips it');
  assert.match(M, /if \(css\) __helmAdoptCss\(document, css\);/);
});

await t('12 notification types: "Security alerts (Helm HQ only)" in the bell map and Settings catalog', async () => {
  assert.match(API, /security_alert: "Security alerts \(Helm HQ only\)"/);
  const at = API.indexOf('get: async () => { const r = await rpc("admin_get_notification_prefs", {});');
  assert.ok(at > 0);
  const fn = API.slice(at + 5, API.indexOf('return r; },', at) + 'return r; }'.length);
  const ctx = { BELL_TYPE_LABELS: { security_alert: 'Security alerts (Helm HQ only)' },
    rpc: async () => ({ catalog: [{ type: 'security_alert', label: 'Security alerts' }, { type: 'chat_message', label: 'Chat messages' }] }) };
  vm.runInNewContext('this.get = ' + fn, ctx);
  const r = await ctx.get();
  assert.equal(r.catalog[0].label, 'Security alerts (Helm HQ only)'); assert.equal(r.catalog[1].label, 'Chat messages');
  ctx.rpc = async () => null; assert.equal(await ctx.get(), null, 'no answer passes through');
});

await t('13 staff sheet: one "Cancel" (department row says "Discard")', () => {
  const S = read('public/staff.html');
  const modal = S.slice(S.indexOf('<div id="staffModal"'), S.indexOf('<div id="inviteModal"'));
  assert.equal((modal.match(/>Cancel</g) || []).length, 1);
  assert.match(modal, /<button type="button" class="btn" id="sm_cancel">Cancel<\/button>/);
  assert.match(modal, /<button type="button" class="btn sm" id="s_dept_new_x" aria-label="Discard the new department">Discard<\/button>/);
  assert.match(S, /\$\("#s_dept_new_x"\)\.addEventListener\("click",\(\)=>\{ \$\("#s_dept_new"\)\.hidden=true; \}\);/);
});

await t('14 landing reel thumbnails: small webp variants + srcset/sizes; no full-size hero webp at 120/240px', () => {
  const H = read('public/index.html');
  for (const [f, max] of [['hero-2d-240', 15e3], ['hero-3d-240', 15e3], ['hero-2d-480', 40e3], ['hero-3d-480', 40e3], ['hero-render-480', 60e3]]) {
    const p = new URL(`../public/mk/media/${f}.webp`, import.meta.url);
    assert.ok(existsSync(p), f); assert.ok(statSync(p).size < max, f + ' small');
    assert.equal(readFileSync(p).subarray(8, 12).toString(), 'WEBP', f + ' is a webp');
  }
  assert.doesNotMatch(H, /<img src="\/mk\/media\/hero-(2d|3d|render)\.webp"[^>]*width="(120|240)"/);
  for (const v of ['2d', '3d'])
    assert.equal(H.split(`<img src="/mk/media/hero-${v}-240.webp" srcset="/mk/media/hero-${v}-240.webp 240w, /mk/media/hero-${v}-480.webp 480w" sizes="120px" alt="" loading="lazy" decoding="async" width="120" height="80">`).length - 1, 2);
  assert.equal(H.split('<img src="/mk/media/hero-render-480.webp" srcset="/mk/media/hero-render-480.webp 480w, /mk/media/hero-render.webp 1559w" sizes="240px" alt="" loading="lazy" decoding="async" width="240" height="110">').length - 1, 2);
});

console.log(`\nr22-polish: ${n} test(s) passed.`);
