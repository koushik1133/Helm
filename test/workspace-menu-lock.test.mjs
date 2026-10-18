// Event Workspace "Venue & menu": a direct "Lock menu" on the card (one-line why), "Open details" deep-links
// to the menu section (#menu) with the Lock button pointed out, Locked chip + warning gone after locking.
// Trial studios: only the catalog / package definitions are fixed, never an event's own menu.
// Quote form (quotes.html) + plan.html venue field: studio venues as a dropdown, free text still works.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const ev = r("public/event.html"), plan = r("public/plan.html"), quotes = r("public/quotes.html");

// ---- event.html: card wiring ------------------------------------------------------------------------
assert.match(ev, /canEditPlan = await BPStore\.auth\.canEditArea\("plan"\)/, "Lock button follows the plan edit right");
assert.match(ev, /menuCount=\(m\|\|\[\]\)\.length/, "selected dish count loaded for the card");
assert.match(ev, /\{t:"🔒 Lock menu", act:"lockmenu", primary:true\}/, "direct Lock menu action");
assert.match(ev, /data-act="\$\{esc\(a\.act\)\}"/, "button actions render escaped");
assert.match(ev, /closest\('\[data-act="lockmenu"\]'\)/, "delegated click on the module grid");
assert.match(ev, /await BPStore\.plan\.setLock\(id, true\)/, "card lock uses the same server call as details (set_plan_lock)");
assert.match(ev, /planSummary=await BPStore\.plan\.get\(id\)/);
assert.match(ev, /🔒 Locked/, "locked chip");
assert.match(ev, /Locking fixes the package and dishes the price is based on/, "one-line why");
assert.ok(!/data-act="(download|dl)"/.test(ev.slice(ev.indexOf("lockMenuFromCard"), ev.indexOf("lockMenuFromCard") + 2000)), "never a trial-blocked action name");

// ---- event.html: the card's decision logic, run in a sandbox ------------------------------------------
const start = ev.indexOf("    const preConfirm = "), end = ev.indexOf("    const discSum = ");
assert.ok(start > 0 && end > start, "card block found");
const block = ev.slice(start, end);
const decide = (o) => vm.runInNewContext(`(function(){ ${block}; return { menuGate, canLockMenu, planHref, menuNext }; })()`,
  Object.assign({ id: "q-1", encodeURIComponent, staleInfo: null, menuCount: 0, canEditPlan: true, planSummary: null,
    ev: { lifecycleStage: "quote", status: "quote" } }, o));
const PKG = { venue_name: "DEMO 2", package: "Standard — Vegetarian", menu_locked: false };
let d = decide({ planSummary: PKG, menuCount: 12 });
assert.ok(d.canLockMenu, "draft menu with a package -> Lock menu offered");
assert.match(d.menuGate, /Lock the menu first/, "warning while draft");
assert.equal(d.planHref, "plan.html?quote=q-1#menu", "Open details goes to the menu section");
assert.match(d.menuNext, /Locking fixes/);
d = decide({ planSummary: { ...PKG, package: null }, menuCount: 3 });
assert.ok(d.canLockMenu, "dishes without a package can be locked");
d = decide({ planSummary: { ...PKG, menu_locked: true }, menuCount: 12 });
assert.ok(!d.canLockMenu && d.menuGate === "" && d.menuNext === "", "locked -> no Lock button, no warning");
assert.equal(d.planHref, "plan.html?quote=q-1");
d = decide({ planSummary: { venue_name: "DEMO 2" }, menuCount: 0 });
assert.ok(!d.canLockMenu, "nothing chosen -> no Lock button");
assert.match(d.menuNext, /Pick a package or add dishes in details, then lock the menu/);
assert.ok(!decide({ planSummary: PKG, menuCount: 12, canEditPlan: false }).canLockMenu, "no plan edit -> details only");
assert.equal(decide({ planSummary: PKG, menuCount: 12, canEditPlan: false }).menuNext, "");
assert.ok(!decide({ planSummary: PKG, menuCount: 12, staleInfo: { prev: 1, next: 2 } }).canLockMenu, "client must re-approve -> no lock (server refuses it)");
assert.ok(!decide({ planSummary: PKG, ev: { lifecycleStage: "quote", status: "cancelled" } }).canLockMenu, "cancelled event -> no lock");
assert.equal(decide({ planSummary: PKG, ev: { lifecycleStage: "planning", status: "confirmed" } }).menuGate, "", "confirmed -> no warning");

// ---- plan.html: #menu deep link, hint, empty-menu guard, venue dropdown ------------------------------
assert.match(plan, /<div class="card" id="menuCard">/);
assert.match(plan, /function focusMenuFromHash\(\)\{[\s\S]*?"#menu"[\s\S]*?classList\.add\("nextstep"\)/);
assert.match(plan, /await load\(\); await renderApproval\(\);[\s\S]{0,200}focusMenuFromHash\(\);/, "runs after the page loaded");
assert.match(plan, /id="lockHint" hidden>Locking fixes the package and dishes/);
assert.match(plan, /\$\("#lockHint"\)\.hidden = !canEdit \|\| locked \|\| planFailed;/);
assert.match(plan, /Pick a package or add at least one dish, then lock the menu\./, "empty menu is not locked");
assert.match(plan, /prefers-reduced-motion:no-preference/, "highlight pulse respects reduced motion");
assert.match(plan, /<script src="venue-suggest\.js\?v=\d+"><\/script>/);
assert.match(plan, /HelmVenueSuggest\.attach\(\$\("#v_name"\),\{address:\$\("#v_addr"\)\}\)/);

// ---- trial lockdown never touches an event's own menu -------------------------------------------------
const tlCss = r("public/trial-lock.css"), tlJs = r("public/trial-lock.js"), tl = r("supabase/migrations/0173_trial_lockdown.sql");
for (const sel of ["lockBtn", "lockmenu", "dishSearch", "selDishes", "rmdish", "pkgCards", "p_save", "menuCard"]) {
  assert.ok(!tlCss.includes(sel) && !tlJs.includes(sel), "trial lock leaves " + sel + " alone");
}
assert.match(tl, /array\['dish_catalog', 'menu_templates', 'chair_types', 'plate_types'\]/, "trial: only catalog / package definitions are fixed");
assert.ok(!/event_plan|event_menu_items|set_plan_lock|apply_menu_template|add_event_dish/.test(tl), "0173 never guards event menus");
assert.match(r("scripts/db-test/run-all.sh"), /menu-lock-trial/);
const dbs = r("tests/db/menu-lock-trial.sql");
assert.ok(/^[\x00-\x7F]*$/.test(dbs), "DB suite ASCII only");
assert.match(dbs, /rollback;\s*$/);

// ---- quotes.html: venue dropdown + link -------------------------------------------------------------
assert.match(quotes, /<script src="venue-suggest\.js\?v=\d+"><\/script>/);
assert.match(quotes, /HelmVenueSuggest\.attach\(\$\("#c_venue"\),\{address:\$\("#c_address"\)\}\)/);
assert.match(quotes, /cmVenueAtOpen=\$\("#c_venue"\)\.value\.trim\(\);/);
assert.match(quotes, /\.\.\.venueLink\(\) \};/);
{
  const fn = quotes.slice(quotes.indexOf("  function venueLink(){"), quotes.indexOf("  }", quotes.indexOf("  function venueLink(){")) + 3);
  const run = (txt, atOpen, hit) => JSON.parse(vm.runInNewContext(fn + "; JSON.stringify(venueLink())", { $: () => ({ value: txt }), cmVenueAtOpen: atOpen, cmVenueSug: { match: () => hit } }));
  assert.deepEqual(run("DEMO 2", "DEMO 2", null), {}, "unchanged venue -> link untouched");
  assert.deepEqual(run("Grand Hall", "", { id: "v1", name: "Grand Hall" }), { venueId: "v1", venueName: "Grand Hall" }, "saved venue picked -> linked");
  assert.deepEqual(run("DEMO 2", "Grand Hall", null), { venueId: null, venueName: null }, "typed a different venue -> old link dropped");
}

// ---- venue-suggest.js in a fake DOM -----------------------------------------------------------------
{
  const src = r("public/venue-suggest.js");
  assert.ok(!/innerHTML|insertAdjacentHTML/.test(src), "DOM nodes only");
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.ls = {}; this.value = ""; this.firstChild = null; }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; }
    appendChild(c) { c.parentNode = this; this.children.push(c); this.firstChild = this.children[0]; return c; }
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); this.firstChild = this.children[0] || null; return c; }
    addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
    dispatchEvent(e) { (this.ls[e.type] || []).forEach((f) => f(e)); }
  }
  const wrap = new El("div"), input = new El("input"), addr = new El("input");
  input.id = "c_venue"; wrap.appendChild(input); wrap.appendChild(addr);
  let addrEvents = 0; addr.addEventListener("input", () => addrEvents++);
  let resolve; const p = new Promise((res) => (resolve = res));
  const rows = [{ id: "v1", name: "Grand Hall", city: "Hyderabad", address: "Road 1" }, { id: "v2", name: "grand hall", city: "" }, { id: "v3", name: "Lawn", address: "" }, { id: "v4", name: "" }];
  const cx = { document: { createElement: (t) => new El(t) }, Event: class { constructor(t) { this.type = t; } }, setTimeout: (f) => f(), console,
    BPStore: { venues: { list: () => { resolve(); return Promise.resolve(rows); } }, auth: { user: () => ({ id: "u" }) } } };
  cx.window = cx;
  vm.runInNewContext(src, cx);
  let picked = "unset";
  const api = cx.HelmVenueSuggest.attach(input, { address: addr, onPick: (v) => { picked = v; } });
  await p; await new Promise((res) => setImmediate(res));
  const dl = wrap.children.find((c) => c.tag === "datalist");
  assert.ok(dl && input.attrs.list === dl.id && dl.id === "c_venue_venues", "datalist wired to the field");
  assert.deepEqual(dl.children.map((o) => o.value), ["Grand Hall", "Lawn"], "saved venues listed once each (blank names skipped)");
  assert.match(input.attrs.placeholder, /Pick a saved venue or type one/);
  assert.equal(cx.HelmVenueSuggest.attach(input, {}), api, "attach twice -> same instance");
  input.value = "  grand HALL "; input.dispatchEvent({ type: "change" });
  assert.equal(picked && picked.id, "v1"); assert.equal(addr.value, "Road 1, Hyderabad", "empty address filled"); assert.equal(addrEvents, 1);
  addr.value = "My own address"; input.value = "Lawn"; input.dispatchEvent({ type: "change" });
  assert.equal(picked.id, "v3"); assert.equal(addr.value, "My own address", "a typed address is never overwritten");
  input.value = "DEMO 2"; input.dispatchEvent({ type: "change" });
  assert.equal(picked, null, "free text that is not a saved venue stays free text");
  assert.equal(api.match(), null);
}
console.log("workspace-menu-lock: all assertions passed");
