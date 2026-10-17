// Audit 2026-10-17 regressions: P&L loose vendor spend counted once, refunds subtracted,
// trial OTP skip members-only, crypto share token, no iCloud duplicate migrations.
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";

const mig = readFileSync("supabase/migrations/0146_audit_1017_pnl_trial.sql", "utf8");
const app = readFileSync("supabase/APPLY-0146.sql", "utf8");
for (const [n, s] of [["0146", mig], ["APPLY-0146", app]]) assert.ok(!/[^\x00-\x7F]/.test(s), n + " is ASCII");
const code = mig.replace(/--[^\n]*/g, "");
assert.ok(!/\b(drop\s+table|drop\s+column|delete\s+from|truncate)\b/i.test(code), "no destructive DDL/DML");
assert.match(code, /greatest\(v_loose_bills, v_loose_lines\)/, "loose vendor spend once");
assert.match(code, /public\.event_refunds r[\s\S]*r\.status = 'processed'/, "processed refunds");
assert.match(code, /v_net := v_rev - v_vendor - v_other - v_staff - v_refunds/);
assert.match(code, /if not public\._trial_test_mode_ok\(v_org\) or not public\._aud1017_is_member\(v_org\)/);
assert.match(code, /_trial_test_mode_ok\(q\.org_id\) and public\._aud1017_is_member\(q\.org_id\)/);
assert.match(code, /revoke all on function public\._aud1017_is_member\(uuid\) from public, anon, authenticated/);
assert.match(code, /revoke all on function public\._vb_event_pnl\(uuid, uuid\) from public, anon, authenticated/);
assert.ok(/^begin;$/m.test(app) && /^commit;$/m.test(app) && /as item, .* as ok/.test(app), "APPLY is one transaction with verify rows");
assert.ok(readFileSync("supabase/migrations/MANIFEST", "utf8").includes("forward  supabase/migrations/0146_audit_1017_pnl_trial.sql"));
assert.ok(!readdirSync("supabase/migrations").some((f) => / 2\.sql$/.test(f)), "no iCloud ' 2' copies in migrations");

const src = readFileSync("public/store-api.js", "utf8");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(src.slice(src.indexOf("  const vbNum = "), src.indexOf("  const vbTableMissing")) + "\nthis.calc = vendorPnlCalc;", ctx);
const { calc } = ctx;
// the audit case: Budget vendor line 80,000 + unlinked vendor bill 80,000 = ONE 80,000
let r = calc({ revenue: 509000, costs: [{ kind: "vendor", actual: 80000 }], bills: [{ amount: 80000, status: "unpaid" }] });
assert.equal(r.vendors, 80000); assert.equal(r.net_profit, 429000);
// still counts each alone
assert.equal(calc({ revenue: 1000, bills: [{ amount: 300 }] }).vendors, 300);
assert.equal(calc({ revenue: 1000, costs: [{ kind: "vendor", estimated: 200 }] }).vendors, 200);
// processed refunds come off profit; pending / approved / deposit deductions do not
r = calc({ revenue: 10000, refunds: [{ kind: "refund", status: "processed", amount: 3000 }, { kind: "refund", status: "approved", amount: 500 }, { kind: "deduction", status: "processed", amount: 99 }] });
assert.equal(r.refunds, 3000); assert.equal(r.net_profit, 7000);
assert.match(src, /refunds\.list\(quoteId\)\.catch\(\(\) => \[\]\)\]\);/, "client P&L fallback reads refunds");
assert.match(src, /row\.share_token = \(typeof crypto !== "undefined" && crypto\.randomUUID\) \? crypto\.randomUUID\(\)/, "LS share token is crypto");
assert.match(readFileSync("public/vendor-bills-ui.js", "utf8"), /"Refunds to client"/);
console.log("audit-1017: ok");
