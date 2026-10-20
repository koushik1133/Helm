// Phase C (0124): vendor bills, payouts and per-event net profit.
// SQL is additive (no drop of existing objects, no data change), has RLS with no delete policy,
// payouts are idempotent and refuse overpayment; the P&L maths (client mirror of _vb_event_pnl)
// gives Revenue - Vendors - Logistics/Other - Staff = Net profit with no vendor double count.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";

const mig = readFileSync("supabase/migrations/0124_vendor_bills.sql", "utf8");
const app = readFileSync("supabase/APPLY-0124.sql", "utf8");
const ver = readFileSync("supabase/VERIFY-0124.sql", "utf8");
const manifest = readFileSync("supabase/migrations/MANIFEST", "utf8");
const code = mig.replace(/--[^\n]*/g, "");

// ---- additive / ASCII / packaging ----
for (const [n, s] of [["0124", mig], ["APPLY-0124", app], ["VERIFY-0124", ver]]) assert.ok(!/[^\x00-\x7F]/.test(s), n + " is ASCII");
assert.ok(app.includes(mig.trim()), "APPLY contains the migration verbatim");
assert.match(app, /^begin;$/m); assert.match(app, /^commit;$/m);
assert.ok(app.includes(ver.trim()), "APPLY ends with the verify checks");
assert.match(manifest, /^forward  supabase\/migrations\/0124_vendor_bills\.sql$/m, "MANIFEST entry");
assert.ok(!/\bdelete\s+from\b/i.test(code), "no delete from");
assert.ok(!/\btruncate\b/i.test(code), "no truncate");
assert.ok(!/\bupdate\s+public\./i.test(code), "no data update");
assert.ok(!/\bdrop\s+(table|column|function|schema|index)\b/i.test(code), "never drops tables/columns/functions");
assert.ok(!/alter\s+table\s+public\.(?!vendor_)/i.test(code), "existing tables are not altered");
for (const d of code.match(/drop\s+(policy|trigger)\s+if\s+exists\s+\w+\s+on\s+public\.\w+/gi) || [])
  assert.match(d, /on public\.vendor_(bills|payouts)$/i, "only drops its own policy/trigger: " + d);
assert.match(code, /create table if not exists public\.vendor_bills/);
assert.match(code, /create table if not exists public\.vendor_payouts/);
for (const c of ["org_id", "quote_id", "booking_id", "vendor_id", "bill_no", "bill_date", "description", "amount", "currency", "due_date", "file_id", "status", "created_by", "created_at"])
  assert.match(code.split("create table if not exists public.vendor_payouts")[0], new RegExp("\\n  " + c + " "), "vendor_bills." + c);
for (const c of ["bill_id", "org_id", "amount", "paid_on", "method", "reference", "created_by", "created_at"])
  assert.match(code.split("create table if not exists public.vendor_payouts")[1], new RegExp("\\n  " + c + " "), "vendor_payouts." + c);

// ---- RLS: org + finance; no delete anywhere ----
assert.match(code, /alter table public\.vendor_bills force row level security/);
assert.match(code, /alter table public\.vendor_payouts force row level security/);
const policies = code.match(/create policy[^;]+;/gi) || [];
assert.ok(policies.length >= 4);
for (const p of policies) {
  assert.ok(!/for\s+(delete|all)\b/i.test(p), "no delete/all policy: " + p.slice(0, 60));
  assert.match(p, /org_id = public\.current_org_id\(\)/, "org-scoped");
  assert.match(p, /has_area\('finance', '(view|edit)'\)/, "finance area");
}
assert.ok(!/create policy \w+ on public\.vendor_payouts for (insert|update)/i.test(code), "payouts only via the RPC");
assert.match(code, /revoke delete on public\.vendor_bills from anon, authenticated/);
assert.match(code, /revoke insert, update, delete on public\.vendor_payouts from authenticated/);
assert.match(code, /vendor_bills_void_ck check \(status <> 'void' or length\(btrim\(coalesce\(void_reason, ''\)\)\) >= 3\)/, "void needs a reason");
assert.match(code, /A bill with payments cannot be voided/);
assert.match(code, /tg_studio_read_only\(''org_id''\)/, "ended trials are read-only here too");

// ---- payout RPC: idempotent + refuses overpayment ----
const rpc = code.slice(code.indexOf("create or replace function public.record_vendor_payout"), code.indexOf("create or replace function public._vb_event_pnl"));
assert.match(rpc, /security definer set search_path = ''/);
assert.match(rpc, /has_area\('finance', 'edit'\)/);
assert.match(rpc, /p\.idempotency_key = v_key/, "replays the same key");
assert.match(rpc, /'duplicate', true/);
assert.match(rpc, /for update/, "row lock against races");
assert.match(rpc, /if v_paid \+ p_amount > b\.amount then\s+raise exception 'That would overpay/, "refuses overpayment");
assert.match(rpc, /b\.status = 'void'/);
assert.match(code, /ux_vendor_payouts_idem on public\.vendor_payouts \(org_id, idempotency_key\)/);
assert.match(code, /revoke all on function public\.record_vendor_payout\(uuid, numeric, date, text, text, text\) from public, anon/);
assert.match(code, /revoke all on function public\._vb_event_pnl\(uuid, uuid\) from public, anon, authenticated/, "helper is private");
for (const f of ["event_pnl(uuid)", "vendor_payables_summary()", "business_pnl(date, date)"]) {
  assert.ok(code.includes("revoke all on function public." + f + " from public, anon"), f + " not for anon");
  assert.ok(code.includes("grant execute on function public." + f + " to authenticated"), f + " for users");
}
assert.match(code, /when exists \(select 1 from public\.vendor_bills vb where vb\.booking_id = b\.id/, "bills replace the booking cost");

// ---- P&L maths (store-api pure helpers in a sandbox) ----
const src = readFileSync("public/store-api.js", "utf8");
const start = src.indexOf("  const vbNum = ");
const end = src.indexOf("  const vbTableMissing");
assert.ok(start > 0 && end > start, "helpers found");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(src.slice(start, end) + "\nthis.calc = vendorPnlCalc; this.state = vendorBillState;", ctx);
const { calc, state } = ctx;
// client's paper example: 100000 - 50000 - 10000 = 40000
let r = calc({ revenue: 100000, bookings: [{ id: "b1", cost: 50000, status: "booked" }], costs: [{ kind: "other", estimated: 10000 }], staff: 0 });
assert.equal(r.vendors, 50000); assert.equal(r.other, 10000); assert.equal(r.net_profit, 40000); assert.equal(r.margin_pct, 40);
// bills replace the booking cost (and its imported cost line) - no double count
r = calc({ revenue: 100000, bookings: [{ id: "b1", cost: 50000, status: "booked" }],
  costs: [{ kind: "vendor", booking_id: "b1", estimated: 50000 }, { kind: "other", estimated: 10000 }],
  bills: [{ booking_id: "b1", amount: 30000 }, { booking_id: "b1", amount: 25000 }, { booking_id: "b1", amount: 99999, status: "void" }], staff: 2000 });
assert.equal(r.vendors, 55000); assert.equal(r.other, 10000); assert.equal(r.staff, 2000); assert.equal(r.net_profit, 33000);
// imported cost line wins over booking.cost when no bills; cancelled bookings ignored; loose bills/lines counted once
r = calc({ revenue: 80000, bookings: [{ id: "b1", cost: 50000, status: "booked" }, { id: "b2", cost: 9000, status: "cancelled" }],
  costs: [{ kind: "vendor", booking_id: "b1", estimated: 50000, actual: 48000 }, { kind: "vendor", estimated: 1000 }],
  bills: [{ amount: 500 }], changeCost: 1500 });
// 0146 (audit 2026-10-17): loose bills + loose vendor lines -> the larger one, never both
assert.equal(r.vendors, 48000 + Math.max(1000, 500)); assert.equal(r.other, 1500); assert.equal(r.net_profit, 80000 - 49000 - 1500);
assert.equal(calc({ revenue: 0 }).margin_pct, null);
// bill states
const t = "2026-10-15";
assert.equal(state({ amount: 100, vendor_payouts: [{ amount: 100 }] }, t), "paid");
assert.equal(state({ amount: 100, vendor_payouts: [{ amount: 40 }] }, t), "part");
assert.equal(state({ amount: 100, due_date: "2026-10-01", vendor_payouts: [{ amount: 40 }] }, t), "overdue");
assert.equal(state({ amount: 100, due_date: "2026-10-20" }, t), "unpaid");
assert.equal(state({ amount: 100, status: "void" }, t), "void");

// ---- store + UI wiring ----
assert.match(src, /settlement, closure, vendorBills, (moneyLedger, )?bell,/, "BPStore.vendorBills exported");
assert.match(src, /rpc\("record_vendor_payout"/); assert.match(src, /rpc\("event_pnl"/);
assert.match(src, /er\.code = "vendor_bills_missing"/, "graceful 'run 0124' state");
const ui = readFileSync("public/vendor-bills-ui.js", "utf8");
assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(ui), "no HTML sinks");
assert.ok(!/style\s*=|\.style\./.test(ui), "no inline styles");
assert.match(ui, /setAttribute\("data-money", ""\)/, "amounts are privacy-masked");
assert.match(ui, /APPLY-0124\.sql/);
assert.ok(!/\.delete\(|vendorBills\.remove/.test(ui), "UI never deletes bills");
for (const [p, m] of [["settlement", "bills"], ["closure", "pnl"], ["budget", "pnl"], ["business", "business"]]) {
  const h = readFileSync("public/" + p + ".html", "utf8");
  assert.ok(h.includes('data-vb-mount="' + m + '"'), p + " mounts " + m);
  assert.match(h, /vendor-bills-ui\.js\?v=10"/); assert.match(h, /vendor-bills\.css\?v=2"/);
  assert.ok(h.indexOf("store-api.js") < h.indexOf("vendor-bills-ui.js"), p + ": store before UI");
}
// QA fixes (2026-10-15): one profit card on Closure, live refresh on Budget, upcoming events on Business,
// phone card labels stay visible under privacy masking, file tab opened inside the click
assert.match(readFileSync("public/closure.html", "utf8"), /id="plCard"[\s\S]*data-vb-replaces="plCard"/, "closure: net profit replaces the older card");
assert.match(ui, /replaces\.hidden = p\.source === "server"/);
assert.match(readFileSync("public/budget.html", "utf8"), /helm:pnl-refresh/, "budget refreshes the P&L card after cost edits");
assert.match(ui, /addEventListener\("helm:pnl-refresh"/);
assert.match(ui, /d\.getMonth\(\) \+ 13, 0\)/, "business includes the next 12 months");
assert.ok(!/money\(el\("td"/.test(ui), "mask the amount span, not the labelled cell");
assert.match(ui, /w = window\.open\("", "_blank"\)/, "file tab opened synchronously");
console.log("vendor-bills: ok");
