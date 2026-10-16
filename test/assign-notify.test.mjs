// 0132 assignment notify: static checks (SQL safety + UI wiring + dispatcher)
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sql = r("supabase/migrations/0132_assignment_notify.sql");
const apply = r("supabase/APPLY-0132.sql");
const rs = r("public/runsheet.html"), work = r("public/work.html"), api = r("public/store-api.js");
const disp = r("supabase/functions/comms-dispatch/index.ts");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// zero data loss: no destructive statements
const code = sql.replace(/--[^\n]*/g, "");
ok(!/\b(delete\s+from|truncate|drop\s+table|drop\s+column|alter\s+column)\b/i.test(code), "no destructive SQL");
ok(/add column if not exists assign_changed_at/i.test(sql), "additive columns");
ok(/create table if not exists public\.assign_notify_outbox/i.test(sql), "idempotent outbox");
ok(/revoke all on table public\.assign_notify_outbox from authenticated/.test(sql), "outbox closed to users");
// never errors the save
ok((sql.match(/exception when others then\s+raise warning 'helm-0132/g) || []).length === 2, "both triggers swallow notify errors");
// 10 minute dedupe + advisory lock
ok(/interval '10 minutes'/.test(sql) && /pg_advisory_xact_lock\(hashtextextended\('helm\.assign132:/.test(sql), "10-min dedupe under lock");
// dormant until WhatsApp is on: gate at claim time
ok(/studio_whatsapp' , ''\) ~|studio_whatsapp', ''\) ~/.test(sql) && /whatsapp_opt_outs/.test(sql), "claim gates on studio number + opt-out");
ok(/grant execute on function %s to service_role/.test(sql), "claim/mark service role only");
// group post: only own event group + member only
ok(/c\.quote_id = i\.quote_id and c\.org_id = v_org/.test(sql) && /'not_member'/.test(sql), "posts only to the item's own event group, members only");
ok(/has_area\('runsheet', 'edit'\)/.test(sql), "group post needs run-sheet edit");
ok(apply.startsWith("-- APPLY 0132") && /\bcommit;/.test(apply) && /VERIFY 0132/.test(apply), "APPLY bundle shape");
// message text
ok(/you''ve been assigned/.test(sql) && /Open your link:/.test(sql), "message wording");
// UI
ok(/id="r_grp"/.test(rs) && /id="e_grp"/.test(rs) && /Also post in the event group/.test(rs), "run-sheet checkbox on add + edit");
ok(/BPStore\.runsheet\.postToGroup/.test(rs) && /BPStore\.runsheet\.groupStatus/.test(rs), "run-sheet wires group RPCs");
ok(!/style="/.test(rs.match(/grpopt[^\n]*/g).join("")), "no inline style on new markup");
ok(/runsheet_post_to_group/.test(api) && /worker_assignment_updates/.test(api), "store-api RPCs");
ok(/class="upd"/.test(work) && /id="rsSec"/.test(work) && /worker\.updates\(token\)/.test(work), "staff link shows Updated + run-sheet");
ok(/setInterval\(/.test(work) && /visibilitychange/.test(work), "staff link refreshes while open");
// dispatcher
ok(/assign_notify_claim/.test(disp) && /assign_notify_mark/.test(disp), "dispatcher drains 0132 outbox");
ok(/ASSIGN_LINK = \/\^work\\\.html\\\?token=/.test(disp), "link path validated; host from APP_URL");
console.log(`assign-notify: ${n} checks passed`);
