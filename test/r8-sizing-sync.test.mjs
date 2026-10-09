// R8: one source of truth for event sizing (guests / chairs / tables / plates / hall L×B).
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const R = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok  " + name); };
const ctx = { window: {} }; vm.createContext(ctx);
vm.runInContext(R("public/event-sizing.js"), ctx);
vm.runInContext(R("public/flow-layout-sync.js"), ctx);
const S = ctx.window.HelmSizing, L = ctx.window.HelmFlowLayout;

t("70% rule rounds up", () => {
  assert.equal(S.defaultChairs(100), 70); assert.equal(S.defaultChairs(101), 71); assert.equal(S.defaultChairs(10), 7);
  assert.equal(S.defaultChairs(1), 1); assert.equal(S.defaultChairs(0), 0); assert.equal(S.defaultChairs(""), null); assert.equal(S.defaultChairs(null), null);
});
t("tables derive from chairs (8 per round, editable)", () => {
  assert.equal(S.defaultTables(70), 9); assert.equal(S.defaultTables(70, 10), 7); assert.equal(S.defaultTables(null), null);
});
t("resolve: defaults, manual chairs kept, plates = guests, hall from client then layout", () => {
  let r = S.resolve({ guests: 300 }, {}, null);
  assert.equal(r.chairs, 210); assert.equal(r.plates, 300); assert.equal(r.tables, 27); assert.equal(r.len, null);
  r = S.resolve({ guests: 300, chairs: 250, chairsManual: true, hallLen: 200, hallWid: 140 }, { guests: 280 }, { w: 90, h: 60 });
  assert.equal(r.chairs, 250); assert.equal(r.chairsManual, true); assert.equal(r.plates, 280); assert.equal(r.len, 200); assert.equal(r.wid, 140);
  r = S.resolve({ guests: 10 }, {}, { w: 90, h: 60 }); assert.equal(r.len, 90); assert.equal(r.wid, 60);
});
t("merge: guests change re-derives chairs unless manual; reset clears manual", () => {
  let c = S.merge({ name: "A" }, { guests: 200 }); assert.equal(c.name, "A"); assert.equal(c.chairs, 140);
  c = S.merge(c, { chairs: 180, chairsManual: true }); c = S.merge(c, { guests: 400 }); assert.equal(c.chairs, 180);
  c = S.merge(c, { chairsManual: false, guests: 400 }); assert.equal(c.chairs, 280);
  c = S.merge(c, { hallLen: "200", hallWid: 140 }); assert.equal(c.hallLen, 200); assert.equal(c.hallWid, 140);
  c = S.merge(c, { hallLen: "" }); assert.equal(c.hallLen, null);
});
t("template ranking: type + capacity fit, with reasons", () => {
  const r = S.rankTemplates({ type: "wedding", guests: 300, len: 200, wid: 140 });
  assert.equal(r.length, 3); assert.equal(r[0].key, "wedding_banquet");
  assert.ok(r[0].why.includes("Wedding")); assert.ok(r[0].why.some((w) => /Fits 300 guests in 200×140 ft/.test(w)));
  const c = S.rankTemplates({ type: "conference", chairs: 700, len: 100, wid: 60 });
  assert.ok(["political_theatre", "political_townhall", "conference_classroom"].includes(c[0].key));
  assert.ok(c.some((x) => x.fits === false || /Tight/.test(x.why.join(" "))));
  const tiny = S.rankTemplates({ type: "wedding", guests: 2000, len: 50, wid: 40 });
  assert.ok(tiny.every((x) => x.fits === false));
});
t("layout reconcile keeps hand-set chairs", () => {
  const r = L.reconcile({ chairs: 90, chairsManual: true, other: 0, otherAuto: 0 }, { chairs: 140, objectsCost: 0 });
  assert.equal(r.chairs, 90); assert.equal(r.chairsChanged, false);
  assert.equal(L.reconcile({ chairs: 90 }, { chairs: 140 }).chairs, 90, "R8b: layout never overrides the quote's chairs");
  assert.equal(L.reconcile({}, { chairs: 140 }, { guests: 100 }).chairs, 70, "no saved chairs → 70% of guests, not the layout");
  assert.equal(L.reconcile({}, { chairs: 140 }, {}).chairs, 140, "nothing on the quote at all → the layout count");
});

t("R8b: ONE chairs value per quote is the pricing source", () => {
  assert.equal(S.quoteChairs({ guests: 1000 }, {}), 700, "70% of guests, rounded up");
  assert.equal(S.quoteChairs({ guests: 101 }, { chairs: 40, chairsManual: false }), 71, "auto value follows guests");
  assert.equal(S.quoteChairs({ guests: 101 }, { chairs: 40 }), 40, "R9: pre-R8 quote (no flags) keeps its billed chairs");
  assert.equal(S.quoteChairs({ guests: 1000, chairs: 650, chairsManual: true }, { chairs: 700 }, 999), 650, "edited value wins over layout + default");
  assert.equal(S.quoteChairs({ guests: 1000 }, { chairs: 640, chairsManual: true }, 999), 640, "edited on the quotation");
  assert.equal(S.quoteChairs({}, {}, 120), 120, "nothing on the quote → layout count");
  assert.equal(S.layoutChairsNote(700, 712).text, "Layout has 712 chairs \u2014 use 712 for pricing?");
  assert.equal(S.layoutChairsNote(700, 700), null); assert.equal(S.layoutChairsNote(700, 0), null);
});
t("R8b: pricing uses the quote's chairs on every screen; a differing layout only shows the one-click note", () => {
  const fl = R("public/flow.html"), bj = R("public/builder.js");
  assert.match(fl, /HelmSizing\.quoteChairs\(cl, pr, null\)/); assert.match(fl, /id="q_chairsUseLayout"/);
  assert.match(fl, /HelmFlowLayout\.reconcile\(pr,\{[^\n]*\}, ev\.client\)/);
  assert.ok(!/oi\.chairs>0\) return oi\.chairs/.test(fl), "layout no longer sets the default chairs");
  assert.match(bj, /chairs: quoteChairsNow\(\), guests: PRICING\.guests/); assert.match(bj, /id="bChairs"/); assert.match(bj, /id="bChairsUse"/);
  assert.match(bj, /HelmSizing\.layoutChairsNote\(quoteChairsNow\(\), layoutChairCount\(\)\)/);
});
const flow = R("public/flow.html"), bjs = R("public/builder.js"), bhtml = R("public/builder.html");
t("both pages load event-sizing.js before their code", () => {
  assert.match(flow, /<script src="event-sizing\.js\?v=\d+"><\/script>/);
  assert.match(bhtml, /event-sizing\.js\?v=\d+[\s\S]*builder\.js\?v=26/);
});
t("flow: hall L×B restored on load and saved on the client; genLayout saves layout guests first", () => {
  assert.match(flow, /HelmSizing\.resolve\(cl, ev\.pricing, layoutRoom\)[^\n]*g_len/);
  assert.match(flow, /hallLen:\$\("#g_len"\)\.value, hallWid:\$\("#g_wid"\)\.value/);
  assert.match(flow, /R8 root cause \(b\)[\s\S]{0,300}\$\("#c_guests"\)\.value=gg[\s\S]{0,120}syncClientMem\(\);[\s\S]{0,40}if\(dirty\)/);
  assert.match(flow, /p\.set\("chairs"/);
  assert.match(flow, /id="q_chairsReset"/); assert.match(flow, /chairsManual=false; syncClientMem\(\)/);
  assert.match(flow, /\$\("#g_guests"\)\.addEventListener\("input"/);
});
t("builder: Custom Event prefilled from the quote, 70% chairs, recommendations apply user numbers", () => {
  assert.match(bjs, /prefillCustomForm\(\); wireSizingForm\(\); renderRecommendations\(\);/);
  assert.match(bjs, /HelmSizing\.dialogSizing\(cl, pr, store\.venue/);   // R9: dialog re-reads the quote each open
  assert.match(bjs, /HelmSizing\.rankTemplates\(/);
  assert.match(bjs, /function applyRecommendation[\s\S]{0,200}readCustomForm\(\)[\s\S]{0,400}generateVariants\(o\)/);
  assert.match(bjs, /persistSizing\(sizingPatch\(o\)\)/);
  assert.match(bhtml, /id="c_recs"/); assert.match(bhtml, /id="c_chairsReset"/);
  assert.match(bjs, /const chairs = quoteChairsNow\(\);/);
  assert.match(bjs, /if\(rule\.seatsPerGuest!=null && guests && !params\.get\('chairs'\)\)/);
});
console.log("r8-sizing-sync: " + n + " passed");
