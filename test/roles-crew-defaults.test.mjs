// 0143: Worker merged into Crew + Designer/Crew starting access (only where nothing is on).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const api = read("public/store-api.js"), ctl = read("public/control.html");
const sql = read("supabase/migrations/0143_roles_crew_defaults.sql");
const apply = read("supabase/APPLY-0143.sql");

test("store-api: worker kept valid but never offered in pickers", () => {
  assert.match(api, /const PICK_ROLES = ALL_ROLES\.filter\(\(r\) => r !== "worker"\)/);
  assert.match(api, /roles: \(\) => PICK_ROLES\.slice\(\)/);
  assert.match(api, /staffRoles: \(\) => PICK_ROLES\.filter\(/);
  assert.match(api, /worker: "Crew"/);
  assert.ok(!/worker: "Worker"/.test(api));
});

test("control.html: suggestions use real areas only; no worker entry", () => {
  const m = ctl.match(/var ROLE_SUGGEST = \{([\s\S]*?)\};/);
  assert.ok(m);
  assert.ok(!/worker/.test(m[1]) && !/briefing/.test(m[1]));
  assert.match(ctl, /Apply suggested access/);
  const areas = [...api.matchAll(/\{ key: "([a-z_]+)",/g)].map((x) => x[1]);
  for (const [, a] of m[1].matchAll(/\["([a-z_]+)",(?:true|false)\]/g)) assert.ok(areas.includes(a), a);
  for (const [, a] of sql.matchAll(/\('(?:designer|crew)','([a-z_]+)',(?:true|false)/g)) assert.ok(areas.includes(a), a);
  assert.match(ctl, /NP\.roles\|\|\[\]\)\.filter\(r=>r!=="worker"\)/);
});

test("0143 SQL: exact-match migration, never overwrites, never deletes", () => {
  assert.ok(!/\bdelete\s+from\b|\bdrop\s+table\b|\btruncate\b/i.test(sql));
  for (const t of ["profiles", "invitations", "crew_members"])
    assert.match(sql, new RegExp("update public\\." + t + " set role = 'crew' where role = 'worker'"));
  assert.match(sql, /c\.role = 'crew' and c\.area = w\.area\)\s*on conflict \(org_id, role, area\) do nothing/);
  assert.match(sql, /\(ra\.can_view or ra\.can_edit\)\)/);   // only roles with nothing on
  assert.match(sql, /where public\.role_access\.can_view = false and public\.role_access\.can_edit = false/);
  assert.match(sql, /create_studio__pre0143/);
  assert.ok(!/_valid_role/.test(sql.replace(/^--.*$/gm, "")), "_valid_role untouched (worker stays valid)");
});

test("APPLY-0143: one transaction + read-only verify", () => {
  assert.match(apply, /^begin;/m);
  assert.match(apply, /^commit;/m);
  const verify = apply.split("===== VERIFY")[1];
  assert.ok(verify && !/\b(update|insert|delete|alter|create)\b/i.test(verify.replace(/'[^']*'/g, "")));
});
