// 0108: dashboard_money - one read-only, org-scoped, area-gated DEFINER function; the dashboard
// uses it when installed and keeps its client-side fallback; pipeline conversion never shows a
// fake "100% moved on" from an empty stage.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const mig = readFileSync("supabase/migrations/0108_dashboard_money.sql", "utf8");
const app = readFileSync("supabase/APPLY-0108.sql", "utf8");
const manifest = readFileSync("supabase/migrations/MANIFEST", "utf8");
const strip = (s) => s.replace(/--[^\n]*/g, "");
const code = strip(mig);
assert.ok(!/[^\x00-\x7F]/.test(app), "APPLY-0108 is ASCII");
assert.ok(!/[^\x00-\x7F]/.test(mig), "0108 is ASCII");
assert.ok(app.includes(mig.trim()), "APPLY-0108 contains the migration verbatim");
assert.match(app, /^begin;$/m, "one transaction"); assert.match(app, /^commit;$/m, "commits");
for (const w of [/\bdelete\s+from\b/i, /\bupdate\s+public\./i, /\binsert\s+into\b/i, /\balter\s+table\b/i, /\bdrop\s+/i, /\btruncate\b/i, /\bcreate\s+table\b/i, /\bcreate\s+temp/i, /\bset\s+(local\s+)?role\b/i])
  assert.ok(!w.test(code), "no data / schema change: " + w);
assert.match(code, /create or replace function public\.dashboard_money\(p_months integer default 12\)/);
assert.match(code, /language plpgsql stable security definer set search_path = ''/, "stable definer, empty search_path");
assert.match(code, /public\.current_org_id\(\)/, "org-scoped");
assert.match(code, /has_area\('quotes', 'view'\)/); assert.match(code, /has_area\('finance', 'view'\)/); assert.match(code, /has_area\('leads', 'view'\)/);
assert.match(code, /least\(greatest\(coalesce\(p_months, 12\), 1\), 24\)/, "months clamped 1..24");
assert.match(code, /from public\.quote_payments p/, "collected from the payment ledger");
assert.match(code, /revoke all on function public\.dashboard_money\(integer\) from public/);
assert.match(code, /revoke all on function public\.dashboard_money\(integer\) from anon/);
assert.match(code, /grant execute on function public\.dashboard_money\(integer\) to authenticated/);
for (const n of ["01 function installed", "02 definer function with empty search_path", "03 read-only (stable)", "04 studio users yes, anon no", "05 org-scoped and area-gated"])
  assert.ok(app.includes("'0108 " + n + "'"), "verify row " + n);
assert.match(manifest, /^forward  supabase\/migrations\/0108_dashboard_money\.sql$/m, "MANIFEST entry");
const store = readFileSync("public/store-api.js", "utf8");
assert.match(store, /rpc\("dashboard_money", \{ p_months: n \}\)/, "store calls the RPC");
assert.match(store, /rpcMissing\(e\) \|\| st === 404/, "missing function -> null (fallback)");
assert.match(store, /insights, dashboard, venues/, "BPStore.dashboard exported");
const dash = readFileSync("public/shell-b-dash.js", "utf8");
assert.match(dash, /S\(\)\.dashboard\.money\(12\)/, "dashboard uses the RPC");
assert.match(dash, /settlement\.html\?quote=/, "overdue rows link to settlement");
assert.match(dash, /prevN > 0 \? Math\.min\(100, Math\.round\(100 \* nextN \/ prevN\)\) : null/, "conversion safe when the base is 0");
console.log("dashboard-money: ok");
// Business page: money moved off the client-facing dashboard; privacy mode masks [data-money]
const biz = readFileSync("public/shell-b-money.js", "utf8");
assert.match(biz, /S\(\)\.dashboard\.money\(12\)/, "business page uses the RPC");
assert.match(biz, /settlement\.html\?quote=/, "overdue rows link to settlement (Collect)");
assert.match(biz, /setAttribute\("data-money"/, "amounts are marked data-money");
assert.ok(!/quoteMoney|% paid/.test(dash), "dashboard shows no per-quote money"); assert.match(dash, /h\.compact\(n\)/, "revenue total via HelmMoney.compact");
const bizJs = readFileSync("public/business.js", "utf8");
assert.match(bizJs, /canView\("business"\)/, "business page gated on its own business area (r20 / 0239)");
const priv = readFileSync("public/shell-b-privacy.js", "utf8");
// 0157: the PIN is one per studio, checked on the server (bcrypt hash there); nothing about it is stored in the browser
assert.match(priv, /a\.check\(pin\)/, "PIN checked on the server (BPStore.privacyPin.check)");
assert.ok(!/helm\.priv\.pin|savePin|PBKDF2/.test(priv), "no PIN (or PIN hash) kept in this browser any more");
assert.ok(!/setItem\([^)]*pin\b[^)]*\)/i.test(priv), "plain PIN never stored");
console.log("dashboard-money: business page + privacy checks ok");
