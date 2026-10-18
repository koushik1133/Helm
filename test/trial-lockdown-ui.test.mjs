// trial-lockdown (0173): free-trial studios only. Static wiring + a small run of trial-lock.js with a fake page:
// a paid studio gets nothing, a trial studio gets html.helm-trial, print/download blocked, onboarding covered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const mig = r("supabase/migrations/0173_trial_lockdown.sql"), apply = r("supabase/APPLY-0173.sql");
assert.ok(/^[\x00-\x7F]*$/.test(mig) && /^[\x00-\x7F]*$/.test(apply), "0173 + APPLY ASCII only");
assert.ok(apply.includes(mig.trim()), "APPLY-0173 carries the 0173 body unchanged");
assert.match(apply, /VERIFY/); assert.match(mig, /ROLLBACK/);
const man = r("supabase/migrations/MANIFEST");
assert.ok(man.indexOf("0173_trial_lockdown.sql") > man.indexOf("0172_wa_proposal_quote_guard.sql"), "0173 after 0172");
assert.match(r("scripts/db-test/run-all.sh"), /trial-lockdown-0173/);
assert.ok(!/\b(drop\s+(table|column|function|trigger)|truncate|delete\s+from)\b/i.test(mig.replace(/--[^\n]*/g, "")), "no drops / deletes");
// every new guard asks the trial question first
for (const fn of ["_tl173_tg_create_cap", "_tl173_tg_no_add", "_tl173_tg_org_lock", "_tl173_guard"]) {
  const body = mig.slice(mig.indexOf("function public." + fn + "("), mig.indexOf("end $$;", mig.indexOf("function public." + fn + "(")));
  assert.match(body, /_tl173_trial_locked/, fn + " checks the trial");
}
assert.match(mig, /Free trial limit reached \(20\)\. Upgrade to add more\./);
for (const t of ["leads", "quotes", "inventory_items", "vendors", "crew_members", "venues"]) assert.ok(mig.includes("'" + t + "'"), "cap on " + t);
// client wiring
const store = r("public/store-api.js");
assert.match(store, /\/trial-lock\.js\?v=\d+/, "store-api loads trial-lock.js");
assert.match(store, /hint === "trial_cap" \|\| e\.hint === "trial_locked"/, "friendly errors");
const split = r("public/control-split.js");
assert.match(split, /TRIAL_OFF=\{general:1,links:1,data:1,compliance:1,notify:1,reminders:1,renders:1,privacy:1\}/);
assert.match(split, /Not available in the free trial/);
const css = r("public/trial-lock.css");
for (const sel of ["#exportBtn", "#printBtn", "#q_pdf", "[data-csv]", '#viewSeg [data-v="render"]', "#dc_add", "a[href*=\"onboarding\"]"]) assert.ok(css.includes(sel), "css hides " + sel);
assert.match(r("public/getting-started.js"), /HelmTrialLock/);

// ---- run trial-lock.js against a fake page --------------------------------------------------------
function page(trialStatus, path) {
  const classes = new Set(), listeners = {}, appended = [];
  const el = (tag) => ({ tag, children: [], className: "", attrs: {}, set textContent(v) { this.text = v; }, get textContent() { return this.text; },
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; } });
  const documentElement = { classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) }, appendChild: (c) => appended.push(c) };
  const body = { appendChild: (c) => appended.push(c) };
  let printed = 0, toasts = 0;
  function A() {} A.prototype.hasAttribute = function (k) { return !!(this.a && this.a[k]); }; A.prototype.click = function () { this.clicked = true; };
  const win = {
    location: { pathname: path || "/dashboard.html" }, HTMLAnchorElement: A, CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    setTimeout: (f) => { f(); return 1; }, setInterval: () => 1, clearInterval() {},
    localStorage: { setItem() {}, removeItem() {}, getItem() { return null; } },
    dispatchEvent() {}, print() { printed++; }, alert() { toasts++; },
    BPUI: { toast() { toasts++; } },
    BPStore: { init: () => Promise.resolve(), auth: { user: () => ({ id: "u" }) }, subscription: { trial: () => Promise.resolve(trialStatus ? { status: trialStatus } : null) } },
    document: { documentElement, body, head: documentElement, getElementById: () => null, createElement: el,
      addEventListener: (n, f) => { listeners[n] = f; } },
  };
  win.window = win;
  vm.runInNewContext(r("public/trial-lock.js"), win);
  return { win, classes, appended, listeners, get printed() { return printed; }, get toasts() { return toasts; } };
}
const tick = () => new Promise((res) => setImmediate(res));
{ const p = page("active"); await tick(); await tick();
  assert.ok(!p.classes.has("helm-trial"), "paid studio: no trial class");
  p.win.print(); assert.equal(p.printed, 1, "paid studio: print works");
  assert.equal(await p.win.HelmTrialLock.whenKnown(), false); }
{ const p = page("trial"); await tick(); await tick();
  assert.ok(p.classes.has("helm-trial"), "trial studio: trial class");
  p.win.print(); assert.equal(p.printed, 0, "trial: print blocked"); assert.ok(p.toasts >= 1, "trial: message shown");
  const a = new p.win.HTMLAnchorElement(); a.a = { download: 1 }; a.click(); assert.ok(!a.clicked, "trial: download link blocked");
  const b = new p.win.HTMLAnchorElement(); b.click(); assert.ok(b.clicked, "trial: normal link works");
  assert.equal(await p.win.HelmTrialLock.whenKnown(), true); }
{ const p = page("trial", "/onboarding.html"); await tick(); await tick();
  assert.ok(p.appended.some((c) => c.attrs && c.attrs.role === "dialog"), "trial: onboarding page covered"); }
{ const p = page("trial", "/budget.html"); await tick(); await tick(); assert.ok(p.classes.has("tl-budget"), "budget keeps vendor-booking import"); }
console.log("trial-lockdown-ui: ALL PASS");
