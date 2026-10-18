// trial-lockdown (0173 + 0181): free-trial studios only. Static wiring + a small run of trial-lock.js with a fake page:
// a paid studio gets nothing, a trial studio gets html.helm-trial, print/download blocked, onboarding + templates covered;
// 0181: the class is set before first paint from the cached flag and taken off again when the server says "paid".
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
assert.match(mig, /Free trial limit reached \(2\)\. Upgrade to add more\./);
for (const t of ["leads", "quotes", "inventory_items", "vendors", "crew_members", "venues"]) assert.ok(mig.includes("'" + t + "'"), "cap on " + t);
// client wiring
const store = r("public/store-api.js");
assert.match(store, /\/trial-lock\.js\?v=\d+/, "store-api loads trial-lock.js");
assert.match(store, /hint === "trial_cap" \|\| e\.hint === "trial_locked"/, "friendly errors");
const split = r("public/control-split.js");
assert.match(split, /TRIAL_OFF=\{general:1,links:1,data:1,compliance:1,notify:1,reminders:1,renders:1,privacy:1,ltemplates:1\}/);
assert.match(split, /Not available in the free trial/);
const css = r("public/trial-lock.css");
for (const sel of ["#exportBtn", "#printBtn", "#q_pdf", "[data-csv]", '#viewSeg [data-v="render"]', "#dc_add", "a[href*=\"onboarding\"]"]) assert.ok(css.includes(sel), "css hides " + sel);
assert.match(r("public/getting-started.js"), /HelmTrialLock/);

// ---- run trial-lock.js against a fake page --------------------------------------------------------
function page(trialStatus, path, cached) {
  const classes = new Set(cached ? ["helm-trial", "helm-trial-early"] : []), listeners = {}, appended = [], ls = {};
  const el = (tag) => ({ tag, children: [], className: "", attrs: {}, set textContent(v) { this.text = v; }, get textContent() { return this.text; },
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; } });
  const documentElement = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) }, appendChild: (c) => appended.push(c) };
  const body = { appendChild: (c) => appended.push(c) };
  let printed = 0, toasts = 0;
  function A() {} A.prototype.hasAttribute = function (k) { return !!(this.a && this.a[k]); }; A.prototype.click = function () { this.clicked = true; };
  const win = {
    location: { pathname: path || "/dashboard.html" }, HTMLAnchorElement: A, CustomEvent: function (n, o) { this.type = n; this.detail = o && o.detail; },
    setTimeout: (f) => { f(); return 1; }, setInterval: () => 1, clearInterval() {},
    localStorage: { setItem(k, v) { ls[k] = String(v); }, removeItem(k) { delete ls[k]; }, getItem(k) { return k in ls ? ls[k] : null; } },
    dispatchEvent() {}, print() { printed++; }, alert() { toasts++; },
    BPUI: { toast() { toasts++; } },
    BPStore: { init: () => Promise.resolve(), auth: { user: () => ({ id: "u" }) }, subscription: { trial: () => Promise.resolve(trialStatus ? { status: trialStatus } : null) } },
    document: { documentElement, body, head: documentElement, getElementById: () => null, createElement: el,
      addEventListener: (n, f) => { listeners[n] = f; } },
  };
  win.window = win;
  vm.runInNewContext(r("public/trial-lock.js"), win);
  return { win, classes, appended, listeners, ls, get printed() { return printed; }, get toasts() { return toasts; } };
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
{ const p = page("trial", "/templates.html"); await tick(); await tick();
  const d = p.appended.find((c) => c.attrs && c.attrs.role === "dialog");
  assert.ok(d, "0181 trial: templates page covered");
  assert.match(JSON.stringify(d), /Templates are not part of the free trial/); }
{ const p = page("trial", "/dashboard.html", true); await tick(); await tick();
  assert.ok(p.classes.has("helm-trial") && !p.classes.has("helm-trial-early"), "0181: cached trial confirmed by the server: early mark dropped");
  assert.equal(p.ls["helm.trial"], "1"); }
{ const p = page("active", "/dashboard.html", true); await tick(); await tick();
  assert.ok(!p.classes.has("helm-trial") && !p.classes.has("helm-trial-early"), "0181: cached flag but the studio is paid: class taken off");
  assert.equal(p.ls["helm.trial"], undefined, "0181: stale flag cleared"); }

// ---- 0181: server guards (migration + paste file) ---------------------------------------------------
{ const m181 = r("supabase/migrations/0181_trial_guards.sql"), a181 = r("supabase/APPLY-0181.sql");
  assert.ok(/^[\x00-\x7F]*$/.test(m181) && /^[\x00-\x7F]*$/.test(a181), "0181 + APPLY ASCII only");
  assert.ok(a181.includes(m181.trim()), "APPLY-0181 carries the 0181 body unchanged");
  assert.match(a181, /VERIFY/); assert.match(m181, /ROLLBACK/);
  assert.ok(man.indexOf("0181_trial_guards.sql") > man.indexOf("0177_trial_india_defaults.sql"), "0181 after 0177");
  assert.match(r("scripts/db-test/run-all.sh"), /trial-guards-0181/);
  assert.ok(!/\b(drop\s+(table|column|function|trigger)|truncate|delete\s+from)\b/i.test(m181.replace(/--[^\n]*/g, "")), "0181: no drops / deletes");
  assert.ok(!/trial_ends_at/.test(m181.replace(/--[^\n]*/g, "")), "0181: the trial is decided by the subscription status, never trial_ends_at");
  for (const fn of ["_tl181_tg_cap_check", "_tl181_tg_cap_log", "_tl181_tg_catalog_edit", "_tl181_tg_custom_fields"]) {
    const body = m181.slice(m181.indexOf("function public." + fn + "("), m181.indexOf("end $$;", m181.indexOf("function public." + fn + "(")));
    assert.match(body, /_tl173_trial_locked/, fn + " checks the trial");
  }
  for (const f of ["studio_template_save(uuid,jsonb)", "studio_template_set_archived(uuid,boolean)", "studio_template_set_default(uuid,boolean)",
                   "studio_template_duplicate(uuid)", "event_reminder_settings_set(integer)", "privacy_pin_set(text,text)", "privacy_pin_reset()",
                   "payment_reminder_send_now(uuid)"]) assert.ok(m181.includes("'public." + f + "'"), "0181 wraps " + f);
  assert.match(m181, /perform public\._tl173_guard\(\);/);
  assert.match(m181, /create table if not exists public\.trial_create_log/);
  assert.match(m181, /array\['price_per_plate', 'dishes'\]/);
  for (const sel of ["#st_saveBtn", "[data-remind]", ".hb-mi[data-area=\"templates\"]", 'a[href="/templates.html"]', "label:has(.tpl_active)"]) assert.ok(css.includes(sel), "css hides " + sel); }

// ---- 0181: the trial class before first paint ---------------------------------------------------------
{ const early = r("public/trial-early.js"), sp = r("public/shell-proto.js"), bh = r("public/builder.html");
  for (const src of [early, sp, store]) assert.match(src, /getItem\("helm\.trial"\) [!=]== "1"/, "reads the cached flag");
  assert.match(sp, /classList\.add\("helm-trial-early"\)/);
  const head = bh.slice(0, bh.indexOf("</head>"));
  assert.match(head, /<link rel="stylesheet" href="\/trial-lock\.css\?v=\d+" id="trialLockCss"><script src="\/trial-early\.js\?v=\d+"><\/script>/, "builder: lock css + early script in <head>");
  assert.match(r("public/booklet.html").split("</head>")[0], /trial-early\.js\?v=\d+/);
  assert.match(store, /const USER_LOCAL_KEYS = \[[^\]]*"helm\.trial"/, "sign-out clears the cached flag");
  const run = (flag, withBody) => {
    const classes = new Set(), added = [];
    const ctx = { window: { localStorage: { getItem: (k) => (k === "helm.trial" ? flag : null) } },
      document: { body: withBody ? {} : null, head: { appendChild: (c) => added.push(c) }, getElementById: () => null,
        documentElement: { classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) } },
        createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }) } };
    vm.runInNewContext(early, ctx); return { classes, added };
  };
  const on = run("1", false); assert.ok(on.classes.has("helm-trial") && on.classes.has("helm-trial-early"), "cached trial: class before paint");
  assert.equal(on.added.length, 1); assert.equal(on.added[0].attrs.blocking, "render"); assert.match(on.added[0].href, /\/trial-lock\.css\?v=\d+/);
  const off = run(null, false); assert.equal(off.classes.size, 0, "no flag: nothing"); assert.equal(off.added.length, 0); }

// ---- 0181: Templates is not part of the trial; builder gallery ------------------------------------------
{ const tl = r("public/trial-lock.js"), sb = r("public/shell-b.js"), ss = r("public/shell-b-search.js"), st = r("public/studio-templates.js");
  assert.match(tl, /BLOCKED_PAGES = \/\(\^\|\\\/\)\(onboarding\|templates(\|audit)?(\|reports)?\)/);   // 0203: + audit; QA B23: + reports
  assert.match(sb, /!\(trial && c\.area === "templates"\)/); assert.match(sb, /setAttribute\("data-area", c\.area\)/);
  assert.match(ss, /TRIAL_OUT = /); assert.match(ss, /addEventListener\("helm:trial", prune\)/);
  const fp = st.slice(st.indexOf("async function fillPreset()"), st.indexOf("function trialName"));
  assert.ok(fp.indexOf("await isTrial()") > -1 && fp.indexOf("await isTrial()") < fp.indexOf("if (!trial && !list.length) return;"), "trial decided before the empty-list return");
  assert.match(fp, /value: "st:__blank", text: "Start blank"/);
  assert.match(st, /if \(id === "__blank"\)/);
  assert.doesNotMatch(st, /trialOrg\.status\(\)/, "the gallery no longer asks my_trial_org");
  assert.match(st, /HelmTrialLock\.whenKnown/); }
console.log("trial-lockdown-ui: ALL PASS");
