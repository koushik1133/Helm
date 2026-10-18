// trial-data-v4 (0170): the paste file and the migration are ASCII only, the paste file carries the
// migration body unchanged, the migration is in the MANIFEST after 0169, and the DB suite is wired.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const mig = r("supabase/migrations/0170_trial_data_v4.sql");
const apply = r("supabase/APPLY-0170.sql");
assert.ok(/^[\x00-\x7F]*$/.test(mig), "0170 is ASCII only");
assert.ok(/^[\x00-\x7F]*$/.test(apply), "APPLY-0170 is ASCII only");
assert.ok(apply.includes(mig.trim()), "APPLY-0170 carries the 0170 body unchanged");
assert.match(apply, /set_current_sample_manifest\(3\)/, "roll-back note");
const man = r("supabase/migrations/MANIFEST");
assert.ok(man.indexOf("0170_trial_data_v4.sql") > man.indexOf("0169_trial_data_v3.sql"), "0170 after 0169");
assert.match(r("scripts/db-test/run-all.sh"), /trial-data-0170/);
// only the sample master studio is written
for (const m of mig.matchAll(/(?:update|insert into|delete from) public\.([a-z_]+)/g)) {
  assert.ok(["dish_catalog","menu_templates","quotes","payment_milestones","quote_payments","vendors","inventory_items",
             "inventory_reservations","crew_members","helm_sample_template"].includes(m[1]), "unexpected table " + m[1]);
}
assert.ok(!/\bdrop\s+(table|column)|truncate/i.test(mig), "no drops / truncates");
console.log("trial-data-v4-ui: ALL PASS");
