// 0140: lead birthday/anniversary flow into Nurture automatically; only auto rows are ever touched.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const mig = readFileSync("supabase/migrations/0140_lead_dates_to_nurture.sql", "utf8");
const man = readFileSync("supabase/migrations/MANIFEST", "utf8");
assert.ok(man.includes("forward  supabase/migrations/0140_lead_dates_to_nurture.sql"), "in MANIFEST");
assert.match(mig, /add column if not exists source text/);
assert.match(mig, /add column if not exists lead_id uuid/);
assert.match(mig, /create unique index if not exists nurture_lead_occ_uidx[\s\S]*where source = 'lead'/, "one per lead+type");
assert.ok(!/drop\s+(table|column)|truncate|alter column/i.test(mig), "additive only");
// every delete/update on nurture is scoped to source='lead' rows of this lead
const writes = [...mig.matchAll(/(delete from|update) public\.nurture n[\s\S]*?;/g)];
assert.equal(writes.length, 2, "exactly one delete and one hand-over update");
for (const m of writes) {
  assert.match(m[0], /n\.source = 'lead'/, "scoped to auto rows");
  assert.match(m[0], /n\.lead_id = p_lead\.id/, "scoped to this lead");
}
assert.match(mig, /n\.note is null and n\.status = 'active' and n\.last_greeted is null/, "worked-on rows are never deleted");
assert.match(mig, /on conflict \(org_id, lead_id, occasion_type\) where source = 'lead' do update/, "idempotent upsert");
assert.match(mig, /on conflict \(org_id, lead_id, occasion_type\) where source = 'lead' do nothing/, "backfill insert-only");
assert.match(mig, /exception when others then\s+raise warning/, "lead save never blocked");
assert.match(mig, /_a84_phone_ok/, "invalid phone not copied (would fail nurture phone check)");
assert.match(mig, /revoke all on function public\._n140_sync_one[^;]*authenticated/);
assert.match(mig, /revoke all on function public\._n140_tg_lead_dates[^;]*authenticated/);
assert.ok(!/after (insert or update or )?delete/i.test(mig), "deleting a lead leaves nurture rows");
const html = readFileSync("public/nurture.html", "utf8");
assert.match(html, /n\.source==="lead"\?' <span class="occ fromlead"/);
assert.match(html, />From lead<\/span>/);
assert.match(html, /\.occ\.fromlead\{/);
console.log("nurture-lead-dates: ok");
