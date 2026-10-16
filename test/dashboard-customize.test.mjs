// Dashboard customisation (0109): pure layout merge logic, front-end safety contracts, store fail-soft,
// and migration 0109 shape (additive, idempotent, RLS own-row, no delete, no anon).
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const js = readFileSync("public/shell-b-dash.js", "utf8");
const css = readFileSync("public/shell-b-dash.css", "utf8");
const api = readFileSync("public/store-api.js", "utf8");
const sql = readFileSync("supabase/migrations/0109_user_dashboard_prefs.sql", "utf8");
const apply = readFileSync("supabase/APPLY-0109.sql", "utf8");
let passed = 0; const t = (n, f) => { f(); passed++; console.log("  ✓ " + n); };

// load the file with a non-shell-B document: only the pure helpers run
const win = {}; const ctx = { window: win, globalThis: {}, document: { documentElement: { getAttribute: () => "a" } } };
vm.runInNewContext(js, ctx);
const Lay = win.HelmDashLayout; assert.ok(Lay, "HelmDashLayout exported");
const B = (id, col, gated) => ({ id, col, gated: !!gated });
const blocks = [B("calendar", "wide"), B("attention", "side"), B("upcoming", "wide"), B("revenue", "wide", true), B("pipeline", "side"), B("notes", "side")];
const col = (o, c) => [...o].filter((id) => blocks.find((b) => b.id === id).col === c);

t("empty / garbage saved layout -> default order", () => {
  for (const bad of [null, undefined, "x", 42, [], { order: "calendar" }, { order: Array(10000).fill("zz") }])
    assert.deepEqual(JSON.parse(JSON.stringify(Lay.merge(bad, blocks).order)), blocks.map((b) => b.id));
});
t("unknown ids are ignored, duplicates removed", () => {
  const m = Lay.merge({ order: ["ghost", "upcoming", "upcoming", "calendar", "<script>"], hidden: ["ghost", "Bad Id"] }, blocks);
  assert.deepEqual(col(m.order, "wide"), ["upcoming", "revenue", "calendar"], "revenue (not saved) follows its default neighbour upcoming");
  assert.equal(m.order.length, blocks.length); assert.deepEqual([...m.hidden], []);
});
t("new blocks are appended next to their default neighbour", () => {
  const m = Lay.merge({ order: ["notes", "attention"] }, blocks);         // pipeline is new to this saved layout
  assert.deepEqual(col(m.order, "side"), ["notes", "attention", "pipeline"]);
  assert.deepEqual(col(m.order, "wide"), ["calendar", "upcoming", "revenue"]);
});
t("reorder stays inside the column", () => {
  const m = Lay.merge({ order: ["notes", "calendar", "attention"] }, blocks);
  assert.deepEqual(col(m.order, "side"), ["notes", "attention", "pipeline"]);
  const o2 = Lay.move(m.order, blocks, "calendar", 1);
  assert.deepEqual(col(o2, "wide"), ["upcoming", "calendar", "revenue"]);
  assert.deepEqual(col(o2, "side"), col(m.order, "side"), "other column untouched");
  assert.deepEqual([...Lay.move(o2, blocks, "calendar", 1)], [...o2], "cannot move past a gated block / end of column");
});
t("role-gated blocks stay gated whatever is saved", () => {
  const m = Lay.merge({ order: ["revenue", "calendar"], hidden: [] }, blocks);
  assert.equal(m.visible.revenue, false); assert.equal(m.visible.calendar, true);
  const h = Lay.merge({ hidden: ["revenue", "notes"] }, blocks);
  assert.deepEqual([...h.hidden], ["notes"]); assert.equal(h.visible.notes, false);
});
t("colOf maps span classes to columns", () => {
  assert.equal(Lay.colOf("hd-card hd-s-wide"), "wide"); assert.equal(Lay.colOf("hd-card hd-s-side hd-act-card"), "side"); assert.equal(Lay.colOf("hd-s-full"), "full");
});

const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
const code = noComments(js);
t("front-end: CSP-safe DOM (no data innerHTML, no style attribute, no inline handlers)", () => {
  for (const m of code.matchAll(/\b(innerHTML|outerHTML)\s*\+?=\s*([^;\n]*)/g)) assert.match(m[2].trim(), /^(""|''|``)$/);
  assert.ok(!/setAttribute\(\s*["']style["']/.test(code)); assert.ok(!/\.style\.(?!setProperty)[a-zA-Z]+\s*=/.test(code), "no el.style.x = (CSSOM vars only)");
  assert.ok(!/setAttribute\(\s*["']on[a-z]+["']/.test(code));
});
t("front-end: entry points, a11y and gating contracts", () => {
  assert.match(code, /addEventListener\("hb:customize"/); assert.match(code, /get\("customize"\) === "1"/); assert.match(code, /history\.replaceState/);
  assert.match(code, /aria-live/); assert.match(code, /"Escape"/); assert.match(code, /setPointerCapture/); assert.match(code, /dragstart/);
  assert.match(code, /n\.hidden \|\| n\.classList\.contains\("hd-off"\)/, "gated = hidden attr or .hd-off");
  assert.match(code, /setupNewMenu\(createSlot, createBtn, items\)/); assert.match(code, /aria-haspopup", "menu"/);
  for (const a of ["inventory", "vendors", "staff", "crm"]) assert.match(code, new RegExp('canEdit\\("' + a + '"\\)'));
});
t("desk notes: server first, local copy kept until the server confirms", () => {
  assert.match(code, /"helm\.dash3\.notes\." \+ uid/);
  assert.match(code, /if \(r === true\) \{ if \(!v\.trim\(\)\) lsSet\(key, ""\)/, "local only cleared after server ack");
  assert.match(code, /pagehide/);
});
t("css: hidden blocks gone outside edit mode; theme tokens only", () => {
  assert.match(css, /\.hd-dash:not\(\.hd-editing\) \.hd-uhide \{ display: none !important; \}/);
  const tail = css.slice(css.indexOf("Customize mode (0109)"));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(tail), "no hard-coded hex colours in customize css");
});
t("store-api: prefs / saveLayout / saveNotes fail soft", () => {
  for (const f of ["my_dashboard_prefs", "save_dashboard_layout", "save_desk_notes"]) assert.ok(api.includes('rpc("' + f + '"'));
  const m = api.match(/async prefs\(\) \{([\s\S]*?)\n    \},/); assert.ok(m); assert.match(m[1], /catch \(e\) \{ return null; \}/);
  assert.match(api, /return \(rpcMissing\(e\) \|\| st === 404\) \? null : false;/);
});

const s = sql.replace(/--[^\n]*/g, "");
t("0109: additive + idempotent (no DROP TABLE / DELETE / TRUNCATE / ALTER ... DROP)", () => {
  assert.ok(!/\bdrop\s+(table|column|function|schema)\b/i.test(s)); assert.ok(!/\bdelete\s+from\b/i.test(s)); assert.ok(!/\btruncate\b/i.test(s));
  assert.ok(!/alter\s+table[^;]*\bdrop\b/i.test(s)); assert.match(s, /create table if not exists public\.user_dashboard_prefs/);
  for (const m of s.matchAll(/create policy "([^"]+)"/g)) assert.ok(s.includes('drop policy if exists "' + m[1] + '"'), "policy guarded: " + m[1]);
  for (const m of s.matchAll(/add constraint (\w+)/g)) assert.ok(s.includes("conname = '" + m[1] + "'"), "constraint guarded: " + m[1]);
  assert.ok(!/create (temp|temporary) table|^\s*set\s+(local|session)\b|^\s*set\s+\w+\s+(to|=)|set_config/im.test(s), "no session state");
});
t("0109: RLS own row in current org, no delete, no anon", () => {
  assert.match(s, /enable row level security/);
  assert.equal((s.match(/user_id = \(select auth\.uid\(\)\) and org_id = \(select public\.current_org_id\(\)\)/g) || []).length, 4);
  assert.ok(!/for (delete|all)\b/i.test(s)); assert.ok(!/grant[^;]*\bdelete\b/i.test(s));
  assert.match(s, /revoke all on table public\.user_dashboard_prefs from anon/);
  assert.match(s, /check \(char_length\(desk_notes\) <= 2000\)/);
});
t("0109: RPCs are definer, empty search_path, derive user + org server-side, anon revoked", () => {
  for (const f of ["my_dashboard_prefs", "save_dashboard_layout", "save_desk_notes"]) {
    const body = s.slice(s.indexOf("function public." + f));
    assert.match(body.slice(0, 200), /security definer set search_path = ''/);
    assert.match(body.slice(0, 400), /v_uid uuid := auth\.uid\(\); v_org uuid := public\.current_org_id\(\)/);
  }
  assert.match(s, /revoke all on function ' \|\| f \|\| ' from anon/);
});
t("APPLY-0109: one transaction, contains the migration, ends with verify rows, ASCII", () => {
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.ok(apply.includes(sql.trim().slice(0, 2000)));
  assert.match(apply, /select item, ok from \(values/); assert.ok(!/[^\x00-\x7F]/.test(apply));
});
t("Reset / Cancel / Esc restore exact default DOM slots (cross-column moves), not just in-column order", () => {
  assert.match(js, /function czResetSlots\(grid, def\)/);
  assert.match(js, /czResetSlots\(grid, DEF\); czApply\(grid, \{ order: DEF\.slice\(\), hidden: \[\] \}\)/);
  assert.match(js, /czResetSlots\(grid, snap\.order\); czApply\(grid, snap\)/);
  assert.match(js, /czResetSlots\(grid, grabSnap\.order\); czApply\(grid, grabSnap\)/);
});
console.log(`dashboard-customize: ${passed} assertion groups passed.`);
