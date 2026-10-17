// Role access audit (docs/ops/ROLE-ACCESS-AUDIT.md) - static guards for the UI gate <-> DB gate fixes.
// UI: every page is gated on the SAME fine matrix area its tables use; event cards hide per area.
// DB (0144): can_edit() follows the matrix, can_edit-only RPCs carry their own area check,
// payment receipts need a money area, event_activity / task_verify_summary need area view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

const PAGE_AREA = {
  budget: "finance", closure: "closure", settlement: "settlement",
  calendar: "calendar", command: "command", issues: "issues", logistics: "logistics", media: "media",
  plan: "plan", ready: "ready", resources: "resources", runsheet: "runsheet", staff: "staff",
  teardown: "inventory", templates: "templates", vendors: "vendors",
  crm: "crm", discovery: "discovery", leads: "leads", proposal: "proposal",
  event: "quotes", quotes: "quotes", ops: "staff", inventory: "inventory", nurture: "nurture",
};

test("each page gate uses its own fine area (no coarse ops/pipeline/finance/workspace gate)", () => {
  for (const [page, area] of Object.entries(PAGE_AREA)) {
    const html = read(`public/${page}.html`);
    assert.ok(html.includes(`requireView("${area}")`), `${page}.html must requireView("${area}")`);
    assert.ok(!/requireView\("(ops|pipeline|workspace)"\)/.test(html), `${page}.html still uses a coarse gate`);
  }
});

test("every gated area is a real matrix area", () => {
  const api = read("public/store-api.js");
  const keys = new Set([...api.matchAll(/\{ key: "([a-z_]+)",/g)].map((m) => m[1]));
  for (const area of new Set(Object.values(PAGE_AREA))) assert.ok(keys.has(area), `unknown area ${area}`);
});

test("event workspace hides each tool card the role cannot view", () => {
  const ev = read("public/event.html");
  assert.match(ev, /const CARD_AREA=\{/);
  assert.match(ev, /cardDenied=new Set\(keys\.filter/);
  assert.match(ev, /\.\.\.cardDenied\]\);/);
  for (const k of ["settle:\"settlement\"", "budget:\"finance\"", "tasks:\"staff\"", "layout:\"layouts\""]) assert.ok(ev.includes(k), k);
});

test("quotes page: New button follows quotes EDIT + can(create) (server create_quote needs both, 0147)", () => {
  const q = read("public/quotes.html");
  assert.match(q, /BPStore\.auth\.can\("delete"\),\n\s+\/\/ create needs can_create\(\)[^\n]*\n\s+Promise\.all\(\[BPStore\.auth\.can\("create"\), BPStore\.auth\.canEditArea\("quotes"\)\]\)/);
});

const sql = read("supabase/migrations/0144_role_gate_fixes.sql");
const apply = read("supabase/APPLY-0144.sql");

test("0144: can_edit() reads the matrix, not a hard-coded role list", () => {
  const m = sql.match(/create or replace function public\.can_edit\(\)[\s\S]*?\$\$;/);
  assert.ok(m);
  assert.match(m[0], /public\.role_access/);
  assert.ok(!/in \('admin','planner','sales','operations'\)/.test(m[0]));
});

test("0144: every can_edit-only RPC is wrapped with its area check BEFORE can_edit widens", () => {
  const want = {
    add_quote_version: /has_area\('quotes', 'edit'\) or public\.has_area\('layouts', 'edit'\)/,
    assign_tasks: /has_area\('staff', 'edit'\)/,
    assign_tasks_vendor: /has_area\('staff', 'edit'\) or public\.has_area\('vendors', 'edit'\)/,
    reassign_task: /has_area\('staff', 'edit'\)/,
    set_plan_signoff: /has_area\('plan', 'edit'\) or public\.has_area\('ready', 'edit'\)/,
    set_plan_lock: /has_area\('plan', 'edit'\)/,
    confirm_quote: /has_area\('quotes', 'edit'\)/,
    publish_proposal: /has_area\('proposal', 'edit'\)/,
    mgr_notify: /has_area\('quotes', 'edit'\) or public\.has_area\('finance', 'edit'\)/,
  };
  const canEditAt = sql.indexOf("create or replace function public.can_edit()");
  for (const [fn, re] of Object.entries(want)) {
    const at = sql.indexOf(`create or replace function public.${fn}(`);
    assert.ok(at > 0 && at < canEditAt, `${fn} wrapper must come before can_edit()`);
    const body = sql.slice(at, sql.indexOf("$$;", at));
    assert.match(body, re, fn);
    assert.ok(body.includes(`${fn}__pre0144(`), `${fn} must call its renamed inner`);
    assert.ok(sql.includes(`['${fn}',`), `${fn} must be in the rename list`);
  }
});

test("0144: payment receipts need a money area (restrictive, never drops data)", () => {
  assert.match(sql, /create policy a144_qp_money_read on public\.quote_payments as restrictive for select/);
  for (const op of ["ins", "upd", "del"]) assert.match(sql, new RegExp(`a144_qp_money_${op} on public\\.quote_payments as restrictive`));
  assert.ok(!/\b(delete from|truncate|drop table|drop column)\b/i.test(sql), "no data-destroying statements");
  for (const m of sql.matchAll(/drop policy if exists (\w+)/g)) assert.ok(m[1].startsWith("a144_"), "drops only its own policies");
});

test("0144: event_activity needs quotes view; payment lines need a money area", () => {
  const m = sql.match(/create or replace function public\.event_activity[\s\S]*?end; \$\$;/);
  assert.ok(m);
  assert.match(m[0], /has_area\('quotes', 'view'\)/);
  assert.match(m[0], /from public\.quote_payments where quote_id = p_quote and v_fin/);
  assert.match(m[0], /status='paid' and v_fin/);
  assert.match(sql, /task_verify_summary[\s\S]*has_area\('staff', 'view'\) or public\.has_area\('quotes', 'view'\)/);
});

test("APPLY-0144: one transaction, contains the migration, ends with verify rows", () => {
  assert.match(apply, /^-- APPLY 0144/);
  assert.ok(apply.includes(sql.trim().split("\n").slice(-3).join("\n")));
  assert.match(apply, /\nbegin;\n[\s\S]*\ncommit;\n[\s\S]*-- ===== VERIFY \(read-only\) =====/);
  assert.match(read("supabase/migrations/MANIFEST"), /forward  supabase\/migrations\/0144_role_gate_fixes\.sql/);
});
