#!/usr/bin/env node
// R20 (fix/r20-coord-a): live-QA fixes seen as an "Event coordinator" (Quotes view-only, no Control Center).
//  9. Invitation Studio: gated on the SAME area the server uses (Quotes & workspace): no view -> "No access";
//     view only -> read-only editor (Save draft / Publish / every write control disabled + a "View only" banner)
// 18. Control Center / Settings: pkg_settings_get is only asked when the role passes the server's own check
//     (controls view OR pkg_review view) - no 403 in the console for a coordinator
// 20. Audit log / checkout: a ROLE block lands on the dashboard with a one-time "Your role can't open that page."
//     notice (same bp_flash mechanism as the trial notice; the trial case keeps its trial wording)
// Pure Node, no deps.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const INV = read('public/invite-studio.html'), PKR = read('public/pkg-review.js'), TL = read('public/trial-lock.js');
const AUD = read('public/audit.html'), S = read('public/store-api.js');
const SQL87 = read('supabase/phase87-event-sites.sql'), SQL69 = read('supabase/migrations/0069_package_flow.sql');

// ---- 9. Invitation Studio ----
t('9. server: every invitation-site write checks Quotes & workspace EDIT', () => {
  assert.match(fnSrc(SQL87, 'public.create_event_site'), /if not has_area\('quotes','edit'\) then raise exception 'not permitted'/);
  assert.match(fnSrc(SQL87, 'public.publish_event_site'), /if not has_area\('quotes','edit'\) then raise exception 'not permitted'/);
  assert.match(SQL87, /create policy event_sites_update on public\.event_sites\s+for update using \( has_area\('quotes','edit'\)/);
});
t('9. load(): requireView("quotes") after the login check, then canEditArea("quotes") decides read-only', () => {
  const L = fnSrc(INV, 'load');
  const login = L.indexOf('location.replace("login.html'), gate = L.indexOf('await BPStore.auth.requireView("quotes")'), get = L.indexOf('BPStore.quotes.get(qid)');
  assert.ok(login > 0 && gate > login && get > gate, 'gate sits between the login check and the event fetch');
  assert.match(L, /if\(!\(await BPStore\.auth\.requireView\("quotes"\)\)\) return;/);
  assert.match(L, /readOnly=!\(await BPStore\.auth\.canEditArea\("quotes"\)\);/);
  assert.match(L, /await loadSite\(\);\n    applyReadOnly\(\); paintActions\(\);/);
  assert.match(L, /if\(!share && !readOnly && window\.HelmInviteShare\)/, '"Send to client" is not mounted view-only');
});
t('9. view-only banner + every write control disabled (preview / copy / open / song preview stay usable)', () => {
  assert.match(INV, /<div id="roBanner" class="robanner" role="status" hidden>View only — your role can't change the invitation site\.<\/div>/);
  const A = fnSrc(INV, 'applyReadOnly');
  assert.match(A, /if\(!readOnly\) return;/);
  assert.match(A, /\$\("#roBanner"\)\.hidden=false;/);
  assert.match(A, /const KEEP=new Set\(\["copyBtn","pubLink","musicTryBtn"\]\);/);
  assert.match(A, /querySelectorAll\("input,select,textarea,button"\)\.forEach\(n=>\{ if\(KEEP\.has\(n\.id\)\|\|n\.hasAttribute\("data-ro-keep"\)\) return; n\.disabled=true;/);   // r23: the phone preview sheet's close button (data-ro-keep) stays usable
  assert.match(A, /\$\("#shareCard"\)\.hidden=true;/);
  // re-rendered controls stay disabled
  ['paintTpls', 'paintPhotos', 'addSchedRow'].forEach((f) => assert.match(fnSrc(INV, f), /applyReadOnly\(\);\n  \}$/, f));
});
t('9. Save draft / Publish / Unpublish stay off view-only (busy reset too) and refuse with the banner text', () => {
  assert.match(fnSrc(INV, 'paintActions'), /const off=siteLoadFailed\|\|readOnly; b\.disabled=off;/);
  assert.match(fnSrc(INV, 'blockedBySiteLoad'), /if\(readOnly\)\{ BPUI\.toast\(RO_MSG,\{type:"err"\}\); return true; \}/);
  assert.match(fnSrc(INV, 'doSave'), /if\(blockedBySiteLoad\(\)\) return;/);
  assert.match(fnSrc(INV, 'doPublish'), /if\(blockedBySiteLoad\(\)\) return;/);
  assert.match(INV, /const RO_MSG="View only — your role can't change the invitation site\.";/);
});

// ---- 18. pkg_settings_get ----
t('18. server: pkg_settings_get answers controls view OR pkg_review view only', () => {
  assert.match(SQL69, /not \(public\.has_area\('controls', 'view'\) or public\.has_area\('pkg_review', 'view'\)\)/);
});
t('18. pkg-review.js asks pkg_settings_get only for a role that passes the same check', () => {
  const W = fnSrc(PKR, 'wire');
  assert.match(W, /read = \(await st\.auth\.canView\("controls"\)\) \|\| \(await st\.auth\.canView\("pkg_review"\)\);/);
  assert.match(W, /if \(read\) \{ try \{ can = await st\.auth\.canEditArea\("controls"\); \} catch \(e\) \{ can = false; \} sets\.forEach\(\(c\) => wireSettings\(c, can\)\); \}/);
  // wireSettings is the only caller of settingsGet
  assert.equal((PKR.match(/pkgflow\.settingsGet\(\)/g) || []).length, 1);
  assert.match(fnSrc(PKR, 'wireSettings'), /pkgflow\.settingsGet\(\)/);
});

// ---- 20. role-block notice ----
t('20. trial-lock.js: roleBlocked() = one-time "Your role can\'t open that page." + dashboard; trial case untouched', () => {
  assert.match(TL, /var ROLE_MSG = "Your role can't open that page\.";/);
  assert.match(fnSrc(TL, 'flash'), /sessionStorage\.setItem\("bp_flash", "i\|" \+ msg\)/);
  const R = fnSrc(TL, 'roleBlocked');
  assert.match(R, /whenKnown\(\)\.then\(function \(trial\) \{\n\s+if \(trial && BLOCKED_PAGES\.test\(location\.pathname \|\| ""\)\) return false;/);
  assert.match(R, /flash\(ROLE_MSG\);\n\s+try \{ location\.replace\(dashHome\(\)\); \}/);
  assert.match(TL, /roleBlocked: roleBlocked,/);
  // the trial wording is still there
  assert.match(TL, /audit: "The audit log isn't available on the free trial\."/);
});
t('20. the notice passes the dashboard flash filter (store-api showFlash)', () => {
  const m = /if \(f && \/(\^\[[^\n]+\$)\/\.test\(f\)\)/.exec(fnSrc(S, 'showFlash'));
  assert.ok(m, 'showFlash filter');
  assert.ok(new RegExp(m[1]).test("Your role can't open that page."));
});
t('20. audit log: a role block calls HelmTrialLock.roleBlocked() (card shows meanwhile)', () => {
  assert.match(fnSrc(AUD, 'load'), /if\(!ok\)\{ \$\("#noaccess"\)\.hidden=false; try\{ if\(window\.HelmTrialLock&&HelmTrialLock\.roleBlocked\) HelmTrialLock\.roleBlocked\(\); \}catch\(_\)\{\} return; \}/);
});
t('20. checkout: a teammate (reason "member") is sent on with the same one-time notice; admins are not', () => {
  assert.match(S, /const ROLE_BLOCK_MSG = "Your role can't open that page\.";/);
  assert.match(S, /if \(cst && !checkoutPageStays\(cst\)\) \{\n[^\n]*\n[^\n]*\n\s+if \(!cst\.missing && cst\.reason === "member"\) \{ try \{ sessionStorage\.setItem\("bp_flash", "i\|" \+ ROLE_BLOCK_MSG\); \} catch \(e\) \{\} \}\n\s+try \{ location\.replace\(safeNext\(nextParam\(\)\)\); \} catch \(e\) \{\}/);
});
t('20. trial-lock.js still parses', () => { new vm.Script(TL); });

console.log(`\n${n} checks passed`);
