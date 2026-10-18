// guest-budget: one guest number (step 1) shown read-only in steps 7/8; chairs/plates stay editable
// with a "differs from guests" hint; one budget range in step 1 that still saves to Discovery
// (budget_min/max) AND client.budget, without silently rewriting legacy data.
import fs from "node:fs"; import vm from "node:vm"; import assert from "node:assert/strict";
const f = fs.readFileSync(new URL("../public/flow.html", import.meta.url), "utf8");
const sec = (id) => f.slice(f.indexOf(`id="${id}"`), f.indexOf("</section>", f.indexOf(`id="${id}"`)));
let n = 0; const t = (name, fn) => { fn(); n++; };

t("step 1 has the single budget range; step 2 has none; old c_budget input gone", () => {
  const s1 = sec("sec-client"), s2 = sec("sec-discovery");
  assert.match(s1, /<label for="d_bmax">Budget/); assert.match(s1, /id="d_bmin"/); assert.match(s1, /id="d_bmax"/);
  assert.doesNotMatch(s2, /d_bmin|d_bmax/); assert.doesNotMatch(f, /id="c_budget"/); assert.doesNotMatch(f, /#c_budget/);
});
t("range saves to Discovery storage and is autosaved as discovery", () => {
  assert.match(f, /d_bmin:"discovery", d_bmax:"discovery"/);
  const sd = f.slice(f.indexOf("async function saveDiscovery"), f.indexOf("async function saveVenue"));
  assert.match(sd, /budget_min:\$\("#d_bmin"\)/); assert.match(sd, /budget_max:\$\("#d_bmax"\)/);
});
t("legacy client.budget is read into the range when Discovery has no budget", () => {
  const ld = f.slice(f.indexOf("async function loadDiscovery"), f.indexOf("async function loadPlan"));
  assert.match(ld, /d\.budget_min==null && d\.budget_max==null\)\) && cl\.budget!=null\)\{ \$\("#d_bmax"\)\.value=cl\.budget/);
});
t("client.budget is preserved until the range is edited, then mirrors max (or min)", () => {
  const fn = f.slice(f.indexOf("function budgetFromRange(){"), f.indexOf('["#d_bmin","#d_bmax"].forEach(s=>{ const el=$(s); if(el) el.addEventListener("input",()=>'));
  const els = { "#d_bmin": { value: "" }, "#d_bmax": { value: "" } };
  const ctx = { $: (s) => els[s] }; vm.createContext(ctx); vm.runInContext(fn + "this.f=budgetFromRange;", ctx);
  assert.equal(ctx.f().v, null); els["#d_bmin"].value = "300000"; assert.equal(ctx.f().v, 300000);
  els["#d_bmax"].value = "500000"; assert.equal(ctx.f().v, 500000);
  const sc = f.slice(f.indexOf("async function saveClient"), f.indexOf("const client=Object.assign", f.indexOf("async function saveClient")));
  assert.match(sc, /budgetN=\(ev\.client\|\|\{\}\)\.budget!=null/); assert.match(sc, /if\(budgetTouched\)/);
  assert.match(f, /budget:budgetTouched\?budgetFromRange\(\)\.v:\(\(ev\.client\|\|\{\}\)\.budget/);
  assert.match(f, /if\(loading \|\| failed\.discovery\) return; budgetTouched=true/);
});
t("steps 7 and 8 show guests read-only with an edit-in-step-1 link", () => {
  for (const [s, id] of [["sec-layout", "g_guests"], ["sec-quote", "q_guestsRo"]]) {
    const h = sec(s); assert.match(h, new RegExp(`<a href="#sec-client" class="edit-step1">edit in step 1</a></label><input class="s-10bfcec" id="${id}"[^>]*readonly`));
  }
  assert.match(f, /\$\("#q_guestsRo"\)\.value=gv/);
});
t("chairs and plates stay editable with a differs-from-guests hint", () => {
  const q = sec("sec-quote");
  assert.match(q, /<input id="q_chairs" type="number" min="1">/); assert.match(q, /<input id="q_guests" type="number" min="0">/);
  assert.match(q, /id="q_chairsDiff"[^>]*hidden/); assert.match(q, /id="q_platesDiff"[^>]*hidden/);
  const fn = f.slice(f.indexOf("function syncQtyHints(){"), f.indexOf("  function renderPrice(){"));
  const mk = (v) => ({ value: v, hidden: true, textContent: "" });
  const els = { "#c_guests": mk("200"), "#q_chairs": mk("140"), "#q_guests": mk("200"), "#q_chairsDiff": mk(""), "#q_platesDiff": mk("") };
  const ctx = { $: (s) => els[s] }; vm.createContext(ctx); vm.runInContext(fn + "this.f=syncQtyHints;", ctx); ctx.f();
  assert.equal(els["#q_chairsDiff"].hidden, false); assert.match(els["#q_chairsDiff"].textContent, /140.*200/);
  assert.equal(els["#q_platesDiff"].hidden, true);
  assert.match(f, /function renderPrice\(\)\{ syncQtyHints\(\);/);
});
t("no inline styles added", () => { for (const s of ["sec-client", "sec-layout", "sec-quote"]) assert.doesNotMatch(sec(s), /style="/); });
console.log(`guest-budget-flow: ${n} passed`);
