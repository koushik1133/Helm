// 0196: Budget & margin built from the client's requirements (public/budget-plan.js + budget.html + store-api).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const P = require("../public/budget-plan.js");
const rd = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { fn(); n++; };

const reqs = [
  { id: "r1", service: "Décor & flowers", priority: "mandatory" },
  { id: "r2", service: "Stage & lighting", priority: "mandatory" },
  { id: "r3", service: "  décor  &  FLOWERS ", priority: "optional" },   // duplicate, case/space/accent-insensitive
  { id: "r4", service: "Catering", priority: "nice" },
  { id: "r5", service: "Photo booth", priority: "optional" },
];
const pricing = { chairs: 200, chairPrice: 50, guests: 200, platePrice: 700, other: 45000, gstPct: 18, total: 236000 };
const vendors = [
  { id: "v1", name: "Gulmohar Florists", category: "Florist" },
  { id: "v2", name: "Deccan Sound & Lights", category: "Sound & lights" },
  { id: "v3", name: "Spice Route Caterers", category: "Catering" },
];

t("requirements are deduplicated case/space/accent-insensitively, highest priority kept", () => {
  const d = P.dedupeReqs(reqs);
  assert.equal(d.length, 4);
  assert.equal(d[0].key, "req:decor & flowers");
  assert.equal(d[0].priority, "mandatory");
  assert.equal(P.reqKey("DÉCOR &  Flowers"), "req:decor & flowers");
});

t("classify maps requirement names to standard lines", () => {
  assert.equal(P.classify("Décor & flowers"), "decor");
  assert.equal(P.classify("Stage & lighting"), "sound");
  assert.equal(P.classify("Catering"), "catering");
  assert.equal(P.classify("Chairs"), "furniture");
  assert.equal(P.classify("Photo booth"), null);
});

t("quote line items prefill Quoted to client (chairs / catering / decor)", () => {
  assert.deepEqual(P.quoteLines(pricing), { furniture: 10000, catering: 140000, decor: 45000 });
  assert.deepEqual(P.quoteLines({ guests: 100, platePrice: 500, catering: { mode: "client" } }), {});
});

t("empty budget: one missing line per requirement, grouped by priority, auto-pull on", () => {
  const m = P.build([], reqs, pricing, vendors, {});
  assert.equal(m.missing.length, 4);
  assert.deepEqual(m.missing.map((r) => r.priority), ["mandatory", "mandatory", "nice", "optional"]);
  const decor = m.missing.find((r) => r.key === "req:decor & flowers");
  assert.equal(decor.quoted, 45000);
  assert.equal(m.missing.find((r) => r.key === "req:catering").quoted, 140000);
  assert.equal(m.missing.find((r) => r.key === "req:photo booth").quoted, null);
  assert.ok(P.shouldAutoPull(m));
  const row = P.reqRow(decor);
  assert.equal(row.requirement_key, "req:decor & flowers"); assert.equal(row.priority, "mandatory"); assert.equal(row.estimated, 0);
});

t("after the pull: nothing missing (no duplicates on reload), groups + margins + totals", () => {
  const costs = [
    { id: "c1", description: "Décor & flowers", requirement_key: "req:decor & flowers", priority: "mandatory", estimated: 30000, quoted: 45000, vendor_id: "v1" },
    { id: "c2", description: "Stage & lighting", requirement_key: "req:stage & lighting", priority: "mandatory", estimated: 0, quoted: null },
    { id: "c3", description: "Catering", requirement_key: "req:catering", priority: "nice", estimated: 120000, actual: 150000, quoted: 140000 },
    { id: "c4", description: "Photo booth", requirement_key: "req:photo booth", priority: "optional", estimated: 8000, quoted: null },
  ];
  const m = P.build(costs, reqs, pricing, vendors, {});
  assert.equal(m.missing.length, 0);
  assert.equal(P.shouldAutoPull(m), false);
  assert.deepEqual(m.groups.map((g) => g.id), ["mandatory", "nice", "optional"]);
  const c1 = m.lines.find((l) => l.id === "c1"); assert.equal(c1.margin, 15000); assert.equal(c1.pct, 33);
  const c3 = m.lines.find((l) => l.id === "c3"); assert.equal(c3.cost, 150000); assert.equal(c3.margin, -10000);
  assert.equal(m.groups[0].totals.estimated, 30000); assert.equal(m.groups[0].totals.quoted, 45000);
  assert.equal(m.totals.estimated, 158000); assert.equal(m.totals.quoted, 185000);
  assert.equal(m.totals.margin, 185000 - (30000 + 0 + 150000 + 8000));
  assert.ok(m.warnings.some((w) => w.kind === "must" && /Stage & lighting/.test(w.text)), "must-have without estimate warned");
  assert.ok(m.warnings.some((w) => w.kind === "negline" && /Catering/.test(w.text)), "line costing more than quoted warned");
  assert.ok(m.warnings.some((w) => w.kind === "neg" || w.kind === "low"), "margin below target warned");
  // vendor filtered by category
  assert.deepEqual(c1.vMatch.map((v) => v.id), ["v1"]);
  assert.deepEqual(m.lines.find((l) => l.id === "c2").vMatch.map((v) => v.id), ["v2"]);
});

t("a quoted line with no cost yet shows no margin (never a fake 100 %)", () => {
  const m = P.build([{ id: "z", description: "Catering", requirement_key: "req:catering", priority: "nice", estimated: 0, quoted: 140000 }], [{ service: "Catering", priority: "nice" }], {}, [], {});
  assert.equal(m.lines[0].margin, null); assert.equal(m.lines[0].pct, null);
  assert.ok(m.totals.incomplete);
});

t("a requirement added later is a new suggestion; a removed one never deletes its line", () => {
  const costs = [{ id: "c1", description: "Décor & flowers", requirement_key: "req:decor & flowers", priority: "mandatory", estimated: 30000 },
                 { id: "c9", description: "Fireworks", requirement_key: "req:fireworks", priority: "nice", estimated: 5000 }];
  const m = P.build(costs, reqs, pricing, vendors, { dismissed: { "req:photo booth": true } });
  assert.equal(P.shouldAutoPull(m), false, "already pulled once: no silent auto-add");
  assert.deepEqual(m.missing.map((r) => r.key).sort(), ["req:catering", "req:photo booth", "req:stage & lighting"]);
  assert.ok(m.missing.find((r) => r.key === "req:photo booth").dismissed);
  const gone = m.lines.find((l) => l.id === "c9");
  assert.ok(gone && gone.reqRemoved, "line of a removed requirement is kept and flagged");
  assert.equal(gone.priority, "nice");
});

t("hand-typed line with the same name covers the requirement (no duplicate)", () => {
  const m = P.build([{ id: "x", description: "catering", estimated: 1000 }], [{ service: "Catering", priority: "mandatory" }], {}, [], {});
  assert.equal(m.missing.length, 0);
  assert.equal(m.lines[0].priority, "mandatory");
});

t("suggested standard lines skip what the event already has; contingency is 5% of estimates", () => {
  const costs = [{ id: "a", description: "Venue hire", estimated: 100000 }, { id: "b", description: "Sound and DJ", estimated: 40000 }];
  const m = P.build(costs, [{ service: "Catering", priority: "mandatory" }], pricing, vendors, {});
  const ids = m.suggestions.map((s) => s.id);
  assert.ok(!ids.includes("venue") && !ids.includes("sound") && !ids.includes("catering"));
  assert.ok(ids.includes("furniture") && ids.includes("decor") && ids.includes("staff") && ids.includes("logistics") && ids.includes("contingency"));
  assert.equal(m.suggestions.find((s) => s.id === "contingency").estimated, 7000);
  assert.equal(m.suggestions.find((s) => s.id === "furniture").quoted, 10000);
  assert.equal(P.stdRow(m.suggestions.find((s) => s.id === "staff")).requirement_key, "std:staff");
});

t("budget page + store wiring", () => {
  const html = rd("../public/budget.html"), api = rd("../public/store-api.js"), js = rd("../public/budget-plan.js");
  assert.match(html, /<script src="budget-plan\.js\?v=\d+"><\/script>/);
  assert.match(html, /HelmBudgetPlan\.render\(\{ el:\$\("#planMount"\)/);
  assert.match(api, /async addPlanLines\(quoteId, rows\)/);
  assert.match(api, /if \(!r \|\| !r\.requirement_key\) continue;/, "only keyed rows are inserted");
  assert.match(api, /e\.code === "23505"\) continue;/, "duplicate key = already there, skipped");
  assert.match(api, /async planReady\(\)/);
  assert.match(js, /data-pl-pull/); assert.match(js, /New requirement: /); assert.match(js, /<details class="bp-sugg">/);
  assert.doesNotMatch(js, /removeCost\((?!k\))/, "the planner removes a line only on the user's own click");
});

t("0196 migration: additive, idempotent, ASCII; APPLY + MANIFEST + db suite", () => {
  const mig = rd("../supabase/migrations/0196_budget_from_requirements.sql"), apply = rd("../supabase/APPLY-0196.sql");
  for (const c of ["requirement_key", "priority", "quoted", "vendor_id"]) assert.match(mig, new RegExp("add column if not exists " + c + " "));
  assert.match(mig, /create unique index if not exists event_costs_req_key_0196_uq on public\.event_costs \(quote_id, requirement_key\)/);
  assert.match(mig, /v\.org_id = new\.org_id/);
  const code = mig.replace(/--.*$/gm, "");   // SQL only, not the plain-words header
  for (const bad of [/\bdrop\s+table\b/i, /\bdelete\s+from\b/i, /\btruncate\b/i, /\bdrop\s+column\b/i, /\bupdate\s+public\./i]) assert.doesNotMatch(code, bad);
  assert.doesNotMatch(mig, /[^\x00-\x7F]/); assert.doesNotMatch(apply, /[^\x00-\x7F]/);
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /-- VERIFY/);
  assert.match(rd("../supabase/migrations/MANIFEST"), /^forward  supabase\/migrations\/0196_budget_from_requirements\.sql$/m);
  assert.match(rd("../scripts/db-test/run-all.sh"), /budget-plan-0196\.sql/);
  // 0173 trial caps never cover the budget table
  assert.match(rd("../supabase/migrations/0173_trial_lockdown.sql"), /array\['leads', 'quotes', 'inventory_items', 'vendors', 'crew_members', 'venues'\]/);
});

console.log(`budget-plan-0196: ${n} checks passed`);
