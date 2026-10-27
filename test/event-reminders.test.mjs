// 0129 event-approaching reminders: static checks on the migration + client wiring.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
const R = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sql = R("supabase/migrations/0129_event_approaching_reminders.sql");
const apply = R("supabase/APPLY-0129.sql");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// zero data loss: additive only
const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
ok(!/\bdrop\s+(table|column|function|index)\b/i.test(code), "no DROP");
ok(!/\bdelete\s+from\b/i.test(code) && !/\btruncate\b/i.test(code), "no DELETE/TRUNCATE");
ok(/add column if not exists event_reminder_days integer not null default 7/.test(sql), "setting column default 7");
ok(/check \(event_reminder_days between 1 and 30\) not valid/.test(sql), "1-30 check");
ok(/create table if not exists public\.event_reminders/.test(sql), "ledger table");
ok(/alter table public\.event_reminders enable row level security/.test(sql), "ledger RLS on");
ok(!/create policy[^;]*event_reminders/i.test(sql), "no user policy on ledger");
ok(/on conflict \(dedupe_key\) do nothing/.test(sql), "idempotent dedupe");
ok(/grant execute on function public\.event_reminders_tick\(\) to service_role/.test(sql), "tick service_role");
ok(!/grant execute on function public\.event_reminders_tick\(\) to (anon|authenticated)/.test(sql), "tick not public");
ok(/'via', 'comms'/.test(sql), "bell row never forwarded to WhatsApp");
ok(!/comms_outbox|_notify\(/.test(code), "no e-mail / SMS / WhatsApp");
ok(/c\.kind = 'group'/.test(sql), "posts only into a group chat (never broadcast)");
ok(/pg_extension where extname = 'pg_cron'/.test(sql) && /helm_event_reminders/.test(sql), "guarded cron");
ok(/raise exception 'not authorized'/.test(sql) && /public\.is_admin\(\)/.test(sql), "settings_set admin-gated");
ok(apply.startsWith("-- APPLY 0129") && /\nbegin;\n/.test(apply) && /\ncommit;\n/.test(apply) && /VERIFY 0129/.test(apply), "APPLY wraps migration + verify");
ok(apply.includes(sql.trim()), "APPLY carries the exact migration");
ok(/0129_event_approaching_reminders\.sql/.test(R("supabase/migrations/MANIFEST")), "manifest");

// client wiring
const js = R("public/event-reminders.js");
ok(!/innerHTML|insertAdjacentHTML|\.style\./.test(js), "DOM-only, no inline style");
for (const p of ["control", "event", "dashboard"]) {
  const h = R("public/" + p + ".html");
  ok(h.includes('<script src="event-reminders.js?v=5"></script>') && h.includes('href="event-reminders.css?v=1"'), p + " loads event-reminders");
}
const api = R("public/store-api.js");
ok(/reminderGet:.*event_reminder_settings_get/.test(api) && /reminderSet:.*event_reminder_settings_set/.test(api) && /reminderUpcoming:.*event_reminder_upcoming/.test(api), "store API");
ok(/event_reminder: \["📅"/.test(api), "bell label");
ok(/HelmEventReminders/.test(R("public/shell-b-dash.js")), "dashboard needs-attention");

// JS helper behaviour (sandbox)
const ctx = { window: {}, document: { readyState: "complete", getElementById: () => null, addEventListener() {} },
  location: { pathname: "/x.html", search: "" }, URLSearchParams, setTimeout: () => 0, localStorage: { getItem: () => null, setItem() {} } };
ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(js, ctx);
const H = ctx.window.HelmEventReminders;
ok(H.days() === 7, "default window 7");
const now = new Date(2026, 9, 16);
ok(H.daysUntil("2026-10-23", now) === 7 && H.daysUntil("2026-10-17", now) === 1 && H.daysUntil("2026-10-16", now) === 0, "daysUntil");
ok(H.chipText(7) === "Upcoming in 7 days" && H.chipText(1) === "Tomorrow" && H.chipText(0) === "Today", "chip text");
console.log("event-reminders: " + n + " checks passed");
