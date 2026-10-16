// QA-E2E ops run (2026-10-13): money consistency fixes across logistics / budget / settlement / DB gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rd = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const logistics = rd("../public/logistics.html");
const budget = rd("../public/budget.html");
const settlement = rd("../public/settlement.html");
const resources = rd("../public/resources.html");
const mig = rd("../supabase/migrations/0110_overpay_cap_includes_changes.sql");
const apply = rd("../supabase/APPLY-0110.sql");

test("payment schedule warns (non-blocking) when milestones exceed the quote total", () => {
  assert.match(logistics, /msScheduled\+ar\.value>qTotal\+0\.5 && !\(await BPUI\.confirm\(/);
  assert.match(logistics, /Scheduled is <b>\$\{inr\(total-qTotal\)\}<\/b> more than the quote total/);
  assert.match(logistics, /async function addMile\(\)/);
});

test("payment totals use theme tokens, not hard-coded inline colours", () => {
  assert.doesNotMatch(logistics, /style="color:#0f7a43">Paid:/);
  assert.match(logistics, /<span class="tb-paid">Paid:/);
  assert.match(rd("../public/logistics-polish.css"), /\.totbar \.tb-due\{color:var\(--warn-text/);
});

test("budget revenue breakdown adds up (ex-tax base + changes)", () => {
  assert.match(budget, /quote \$\{inr\(sum\.revenueExTax - sum\.changeRevenue\)\} \+ changes/);
});

test("settlement explains a server overpayment refusal instead of 'values are invalid'", () => {
  assert.match(settlement, /e\.code==="23514"\|\|\/exceeds the outstanding balance\/i/);
});

test("no internal phase jargon in the resource gap hint", () => {
  assert.doesNotMatch(resources, /rentals \(Phase 9\)/);
});

test("0110: overpay guards + close gate use quote + approved changes; additive only", () => {
  assert.match(mig, /function public\.helm_invoice_total\(p_quote uuid\)/);
  assert.match(mig, /c\.status = 'approved'/);
  assert.equal((mig.match(/v_total := public\.helm_invoice_total\(new\.quote_id\)/g) || []).length, 2);
  assert.match(mig, /_a49_close_blockers[\s\S]*helm_invoice_total\(p_quote\)/);
  for (const bad of [/\bdrop\s+table\b/i, /\bdelete\s+from\b/i, /\btruncate\b/i, /\bdrop\s+trigger\b/i, /\balter\s+table\b/i]) assert.doesNotMatch(mig, bad);
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m);
  assert.doesNotMatch(apply, /[^\x00-\x7F]/);
});
