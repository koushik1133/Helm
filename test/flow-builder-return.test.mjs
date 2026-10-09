// Flow ⇄ floor builder round trip: "Save & back to quote" + re-pricing from the latest layout.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const R = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  " + name); };

const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(R("public/flow-layout-sync.js"), ctx);
const L = ctx.window.HelmFlowLayout;

t("chairs follow the layout", () => {
  const r = L.reconcile({ chairs: 100, other: 5000, otherAuto: 5000 }, { chairs: 140, objectsCost: 5000, layoutBase: 0 });
  assert.equal(r.chairs, 140); assert.equal(r.chairsChanged, true); assert.equal(r.otherChanged, false); assert.equal(r.changed, true);
});
t("auto 'other' follows the objects cost", () => {
  const r = L.reconcile({ chairs: 10, other: 5000, otherAuto: 5000 }, { chairs: 10, objectsCost: 7000, layoutBase: 1000 });
  assert.equal(r.other, 8000); assert.equal(r.otherChanged, true); assert.equal(r.otherAuto, 8000);
});
t("hand-edited 'other' is never clobbered", () => {
  const r = L.reconcile({ chairs: 10, other: 1234, otherAuto: 5000 }, { chairs: 10, objectsCost: 9000 });
  assert.equal(r.other, 1234); assert.equal(r.otherHand, true); assert.equal(r.changed, false);
  const r2 = L.reconcile({ other: 999 }, { chairs: 0, objectsCost: 9000 });   // no auto record → keep
  assert.equal(r2.other, 999);
});
t("no change → nothing to save (no save loop)", () => {
  assert.equal(L.reconcile({ chairs: 50, other: 0, otherAuto: 0 }, { chairs: 50, objectsCost: 0 }).changed, false);
  assert.equal(L.reconcile({}, { chairs: 0, objectsCost: 0 }).changed, false);
});
t("one-shot flag is consumed exactly once", () => {
  const m = new Map(), s = { setItem: (k, v) => m.set(k, v), getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k) };
  L.mark(s, "q1"); assert.equal(L.consume(s, "q1"), true); assert.equal(L.consume(s, "q1"), false); assert.equal(L.consume(s, "q2"), false);
  assert.equal(L.consume({ getItem() { throw new Error("blocked"); } }, "q"), false);
});
t("return URL targets the same quote's quotation step", () => {
  assert.equal(L.returnUrl("a b"), "flow.html?quote=a%20b&from=builder#sec-quote");
});

const flow = R("public/flow.html"), bjs = R("public/builder.js"), bhtml = R("public/builder.html");
t("flow loads the helper, marks the trip and opens the builder with from=flow", () => {
  assert.match(flow, /<script src="flow-layout-sync\.js\?v=\d+"><\/script>/);
  assert.match(flow, /HelmFlowLayout\.mark\(sessionStorage, id\);[^\n]*\n\s*location\.href="builder\.html\?quote="\+encodeURIComponent\(id\)\+"&from=flow"/);
  assert.match(flow, /gen:"1", from:"flow"/);
});
t("flow re-prices on return (load + bfcache) via the Save quotation path", () => {
  assert.match(flow, /async function syncFromLayout\(fromBuilder\)/);
  assert.match(flow, /fromBuilder && canEdit\)\{\s*try\{ await saveQuotation\(\);/);
  assert.match(flow, /if\(HelmFlowLayout\.consume\(sessionStorage, id\)\) refreshAfterBuilder\(\)/);
  assert.match(flow, /Layout updated — quotation recalculated/);
  assert.match(flow, /layoutSyncBusy/);
  assert.doesNotMatch(flow.slice(flow.indexOf("async function syncFromLayout")), /quotes\.updateMeta\(id,\{ pricing \}\)[^\n]*\n[^\n]*syncFromLayout/);
});
t("builder: Save & back button, saves then writes pricing un-debounced, then returns", () => {
  assert.match(bhtml, /id="backToFlowBtn" hidden/);
  assert.match(bhtml, /flow-layout-sync\.js[\s\S]*builder\.js/);
  assert.match(bjs, /params\.get\('from'\)==='flow'\) bb\.hidden=false/);
  assert.match(bjs, /async function syncQuotePricingNow\(\)/);
  assert.match(bjs, /await saveLayout\(false\);\s*\n\s*if\(!ok\) return;[^\n]*\n\s*if\(!RO\) await syncQuotePricingNow\(\);[^\n]*\n\s*location\.href = HelmFlowLayout\.returnUrl\(currentQuoteId\);/);
});
console.log(`flow-builder-return: ${n} passed`);
