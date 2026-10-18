// trial-gates-0202: free-trial studios only. Server (migration + paste file, static) and the screens:
// - trial-lock.js sends a trial away from /:slug/onboarding, /:slug/audit, /:slug/templates (cover + redirect)
// - Control Center: a deep link to a trial-hidden section goes to the first section the trial has
// - store-api.js: photo renders, templates and the activity log are never "allowed" for a trial (admins too)
// - nurture.html: automation off, no Run / Send greeting, "Greetings are sent once you choose a plan"
// - auth-ui.js: the two-step card never shows in the trial; compact, once per session, folds away by itself
// Paid studios: nothing changes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

// ---- server: migration + paste file ------------------------------------------------------------------
const mig = read("supabase/migrations/0202_trial_gates.sql"), apply = read("supabase/APPLY-0202.sql");
assert.ok(/^[\x00-\x7F]*$/.test(mig) && /^[\x00-\x7F]*$/.test(apply), "0202 + APPLY ASCII only");
assert.ok(apply.includes(mig.trim()), "APPLY-0202 carries the 0202 body unchanged");
assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /VERIFY/); assert.match(mig, /ROLLBACK/);
const man = read("supabase/migrations/MANIFEST");
assert.ok(man.indexOf("0202_trial_gates.sql") > man.indexOf("0187_trial_outbound_gaps.sql"), "0202 after the trial bundle");
assert.match(read("scripts/db-test/run-all.sh"), /trial-gates-0202" "TRIAL-GATES-0202: ALL PASS/);
const code = mig.replace(/--[^\n]*/g, "");
assert.ok(!/\b(drop\s+(table|column|function|trigger|policy)|truncate|delete\s+from|update\s+public\.|insert\s+into)\b/i.test(code), "0202: no drops, no row written");
assert.ok(!/trial_ends_at/.test(code), "0202: the trial is decided by the subscription status, never trial_ends_at");
for (const fn of ["_tl202_tg_nurture_auto", "_tl202_tg_menu_dishes", "_tl202_tg_templates"]) {
  const at = code.indexOf("function public." + fn + "("), body = code.slice(at, code.indexOf("end $$;", at));
  assert.ok(at > 0, fn + " defined"); assert.match(body, /_tl173_trial_locked/, fn + " checks the trial");
  assert.match(body, /current_user (not )?in \('anon', 'authenticated'\)/, fn + " only checks app writes");
}
for (const fn of ["queue_nurture_greeting", "run_nurture_auto", "nurture_due"]) {
  const at = code.indexOf("function public." + fn + "("), body = code.slice(at, code.indexOf("end $$;", at));
  assert.match(body, /_tl202_no_send\(public\.current_org_id\(\)\)/, fn + " asks the 0179 no-send rule");
  assert.match(body, new RegExp(fn + "__pre0202\\("), fn + " then calls the kept original");
}
assert.match(code, /Greetings are sent once you choose a plan\./);
assert.match(code, /as restrictive for select to authenticated/);
assert.match(code, /'has_subscription', s\.org_id is not null and not v_trial and not v_ended/);
assert.match(code, /when v_trial then 'trial'/);
// "required" is exactly the 0159 expression
const m159 = read("supabase/migrations/0159_direct_studio_plan_gate.sql");
const req = (s) => (s.match(/'required', v_admin and [\s\S]*?b\.checkout_required_after\)\),/) || [""])[0].replace(/\s+/g, " ");
assert.ok(req(code) && req(code) === req(m159), "my_checkout_status: required unchanged from 0159");

// ---- trial-lock.js: pages that are not part of the trial ------------------------------------------------
function page(trialStatus, path) {
  const classes = new Set(), appended = [], replaced = [], ls = {};
  const el = (tag) => ({ tag, children: [], className: "", attrs: {}, set textContent(v) { this.text = v; }, get textContent() { return this.text; },
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; } });
  const documentElement = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }, appendChild: (c) => appended.push(c) };
  function A() {} A.prototype.hasAttribute = function () { return false; }; A.prototype.click = function () {};
  const win = {
    location: { pathname: path, replace: (u) => replaced.push(u) }, HTMLAnchorElement: A, CustomEvent: function () {},
    setTimeout: (f) => { f(); return 1; }, setInterval: () => 1, clearInterval() {},
    localStorage: { setItem(k, v) { ls[k] = String(v); }, removeItem(k) { delete ls[k]; }, getItem(k) { return k in ls ? ls[k] : null; } },
    dispatchEvent() {}, print() {}, alert() {}, BPUI: { toast() {} },
    BPStore: { init: () => Promise.resolve(), auth: { user: () => ({ id: "u" }) }, subscription: { trial: () => Promise.resolve(trialStatus ? { status: trialStatus } : null) } },
    document: { documentElement, body: { appendChild: (c) => appended.push(c) }, head: documentElement, getElementById: () => null, createElement: el, addEventListener() {} },
  };
  win.window = win;
  vm.runInNewContext(read("public/trial-lock.js"), win);
  return { win, appended, replaced };
}
const tick = () => new Promise((res) => setImmediate(res));
for (const [path, to] of [["/abcd/audit", "/abcd/dashboard"], ["/abcd/templates", "/abcd/dashboard"], ["/abcd/onboarding", "/abcd/dashboard"],
                          ["/audit.html", "/dashboard.html"], ["/templates.html", "/dashboard.html"], ["/onboarding.html", "/dashboard.html"]]) {
  const p = page("trial", path); await tick(); await tick();
  assert.deepEqual(p.replaced, [to], "trial: " + path + " -> " + to);
  assert.ok(p.appended.some((c) => c.attrs && c.attrs.role === "dialog"), "trial: " + path + " covered while it goes");
}
{ const p = page("trial", "/abcd/audit"); await tick(); await tick();
  assert.match(JSON.stringify(p.appended), /The activity log is not part of the free trial/); }
for (const path of ["/abcd/audit", "/abcd/templates", "/audit.html"]) {
  const p = page("active", path); await tick(); await tick();
  assert.deepEqual(p.replaced, [], "paid studio: " + path + " opens normally");
}
{ const p = page("trial", "/abcd/dashboard"); await tick(); await tick(); assert.deepEqual(p.replaced, [], "trial: the dashboard itself never redirects"); }
const tl = read("public/trial-lock.js"), css = read("public/trial-lock.css");
assert.match(tl, /#seedBtn, #firstSeed, #btn-export-gdpr/, "starter items + studio archive clicks blocked");
for (const sel of ["#seedBtn", "#firstSeed", "#btn-export-gdpr", "#runNow", "#occBody [data-greet]", ".hd-act-card", "a[href$=\"/templates\"]", "a[href$=\"/audit\"]", "a[href*=\"tplEdit=\"]"]) assert.ok(css.includes(sel), "css hides " + sel);
assert.match(read("public/shell-b.js"), /\[\(ctl \|\| rl === "admin"\) && !inTrial, "audit"/, "no Audit log nav item in the trial");

// ---- Control Center deep link to a trial-hidden section -------------------------------------------------
{ const split = read("public/control-split.js");
  const at = split.indexOf("function show(key, opts){"), body = split.slice(at, split.indexOf("// empty state", at));
  assert.ok(body.indexOf("var to=firstOpen();") > body.indexOf("if(locked(key)){"), "locked section -> first open section");
  assert.match(body, /if\(to && to!==key && !locked\(to\) && available\(BYKEY\[to\]\)\)\{\s*wanted=to; setHash\(SECHASH\[to\]\);/);
  assert.match(body, /is not part of the free trial\./);
  assert.match(split, /function available\(s\)\{ if\(locked\(s\.key\)\) return false;/, "hidden sections never in the nav"); }

// ---- nurture page --------------------------------------------------------------------------------------
{ const n = read("public/nurture.html");
  assert.match(n, /<p id="autoTrial" class="tl-note" hidden>Greetings are sent once you choose a plan\./);
  assert.match(n, /\$\("#autoToggle"\)\.disabled=trial; \$\("#runNow"\)\.hidden=trial; \$\("#autoTrial"\)\.hidden=!trial;/);
  assert.match(n, /\$\("#autoToggle"\)\.checked=!trial&&!!a\.enabled;/, "automation shown off in the trial");
  assert.match(n, /\$\{trial\?"":`<button type="button" class="lnk" data-greet=/, "no Send greeting button in the trial");
  assert.match(n, /d\.auto_on&&!trial\?"checked":""\}\$\{trial\?" disabled":""\}/, "per-contact auto-greet off + locked in the trial");
  assert.match(n, /if\(want&&\(await inTrial\(\)\)\)/, "switching automation on is refused in the page too"); }

// ---- two-step card --------------------------------------------------------------------------------------
{ const a = read("public/auth-ui.js");
  const at = a.indexOf("function adminTwoStep()"), body = a.slice(at, a.indexOf("function showMfaNudge()", at));
  assert.match(body, /classList\.contains\("helm-trial"\)\) return;/, "never in the trial (cached class)");
  assert.match(body, /inTrialStudio\(\)\.then\(function \(t\) \{\s*if \(t \|\| banner\) return;/, "never in the trial (server answer)");
  assert.match(body, /sessionStorage\.getItem\(SK\)/, "once per browser session");
  assert.match(a, /id: "hauMfaNudge", priority: 2, icon: "shield", compact: true, dock: false, autoHideMs: 20000/, "compact, stays in the stack, folds away");
  assert.match(a, /" compact" \+ \(o\.dock === false \? "" : " dock-left"\)/, "dock option (other compact notices keep dock-left)"); }

// ---- store-api.js: trial-off areas (run in a sandbox) ---------------------------------------------------
const SRC = read("public/store-api.js");
function memStore(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function makeEnv(o) {
  const calls = [], user = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", email: "a@studio.test" }, session = { user, access_token: "x" };
  const rpcs = Object.assign({ current_org_id: { data: "11111111-2222-4333-8444-555555555555", error: null },
    my_profile_status: { data: { complete: true, required: false, nudge: false }, error: null },
    my_checkout_status: { data: { required: false, reason: o.trial ? "trial" : "subscribed", is_admin: true, has_subscription: !o.trial }, error: null },
    my_trial_status: { data: o.trial ? { state: "trial", status: "trial", days_left: 5 } : { state: "none", status: "active" }, error: null } }, o.rpc || {});
  const client = {
    auth: { async getSession() { return { data: { session } }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; }, async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }; } } },
    async rpc(name, args) { calls.push(name); return rpcs[name] || { data: null, error: null }; },
    from() { const q = { select: (c) => { q._c = c; return q; }, eq: () => q, order: () => q, in: () => q, limit: () => q,
      then: (res) => res({ data: (o.matrix || []), error: null }),
      single: async () => ({ data: { role: o.role }, error: null }), maybeSingle: async () => ({ data: { role: o.role }, error: null }) }; return q; },
    storage: { from: () => ({}) },
  };
  const cls = new Set();
  const doc = { readyState: "complete", addEventListener() {}, removeEventListener() {}, currentScript: { src: "https://www.helm.events/store-api.js?v=1" },
    createElement: () => ({ style: {}, attrs: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {} }), head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {}, insertBefore() {} },
    documentElement: { setAttribute() {}, getAttribute() { return "light"; }, classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c), remove: (c) => cls.delete(c) } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { SUPABASE_CONFIG: { url: "https://abcdefghijklmnopqrst.supabase.co", anonKey: "anon" }, supabase: { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: "/dashboard", search: "", hash: "", origin: "https://www.helm.events", href: "", hostname: "www.helm.events", replace() {}, reload() {} },
    document: doc, navigator: { onLine: true }, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }), addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, "base64").toString("binary"), crypto: globalThis.crypto, Blob, Response, Uint8Array, ArrayBuffer,
    console: { log() {}, info() {}, warn() {}, error() {} }, Date, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(SRC, win, { filename: "store-api.js" });
  return { S: win.BPStore, calls };
}
{ const e = makeEnv({ trial: true, role: "admin" }); await e.S.init();
  for (const a of ["photo_render", "templates", "audit"]) {
    assert.equal(await e.S.auth.canView(a), false, "trial admin: no " + a);
    assert.equal(await e.S.auth.canEditArea(a), false, "trial admin: cannot edit " + a);
  }
  assert.equal(await e.S.auth.canView("quotes"), true, "trial admin: other areas unchanged");
  assert.equal(await e.S.auth.canEditArea("leads"), true, "trial admin: other edits unchanged");
  assert.ok(e.calls.filter((c) => c === "my_trial_status").length <= 1, "one trial-status call shared by every check"); }
{ const e = makeEnv({ trial: false, role: "admin" }); await e.S.init();
  for (const a of ["photo_render", "templates", "audit"]) assert.equal(await e.S.auth.canView(a), true, "paid admin: " + a + " as before"); }
{ const e = makeEnv({ trial: false, role: "manager", matrix: [{ area: "templates", can_view: true, can_edit: true }, { area: "photo_render", can_view: true, can_edit: true }] }); await e.S.init();
  assert.equal(await e.S.auth.canView("templates"), true, "paid manager: the saved matrix decides");
  assert.equal(await e.S.auth.canEditArea("photo_render"), true); }
{ const e = makeEnv({ trial: true, role: "manager", matrix: [{ area: "templates", can_view: true, can_edit: true }, { area: "photo_render", can_view: true, can_edit: true }] }); await e.S.init();
  assert.equal(await e.S.auth.canView("templates"), false, "trial manager: saved matrix says yes, trial says no");
  assert.equal(await e.S.auth.canEditArea("photo_render"), false); }
console.log("trial-gates-0202: ALL PASS");
