import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const R = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sql = R("supabase/migrations/0139_crm_restore_lead.sql");
const html = R("public/crm.html");
const api = R("public/store-api.js");

test("0139 is additive and idempotent", () => {
  assert.doesNotMatch(sql, /\bdrop\s+(table|column)|\bdelete\s+from|\btruncate\b/i);
  assert.match(sql, /add column if not exists restored_at/);
  assert.match(sql, /add column if not exists restored_by/);
  assert.match(sql, /create or replace function public\.restore_archived_lead/);
});
test("0139 guards: studio, edit access, deleted only, no live duplicate, not twice", () => {
  assert.match(sql, /security definer/); assert.match(sql, /set search_path = ''/);
  assert.match(sql, /a\.org_id = v_org/); assert.match(sql, /has_area\('leads', 'edit'\)/);
  assert.match(sql, /action <> 'deleted'/); assert.match(sql, /restored_at is not null/);
  assert.match(sql, /exists \(select 1 from public\.leads l where l\.id = v_arc\.lead_id\)/);
  assert.match(sql, /for update/); assert.match(sql, /v_lead\.org_id\s+:= v_org/);
  assert.match(sql, /insert into public\.audit_log[\s\S]*'lead\.restored'/);
  assert.match(sql, /revoke all on function public\.restore_archived_lead\(uuid\) from public, anon/);
  assert.match(sql, /grant execute on function public\.restore_archived_lead\(uuid\) to authenticated/);
});
test("0139 in MANIFEST", () => assert.match(R("supabase/migrations/MANIFEST"), /forward\s+supabase\/migrations\/0139_crm_restore_lead\.sql/));
test("store-api calls the RPC and tolerates a pre-0139 DB", () => {
  assert.match(api, /async restoreArchived\(archiveId\)/);
  assert.match(api, /rpc\("restore_archived_lead", \{ p_archive_id: archiveId \}\)/);
  assert.match(api, /leadArchiveHasRestored = false/);
});
test("crm page: confirm before restore, deleted rows only", () => {
  assert.match(html, /r\.action!=="deleted"/);
  assert.match(html, /BPUI\.confirm\(`Restore/);
  assert.match(html, /BPStore\.leads\.restoreArchived/);
  assert.match(html, /canEditArea\("leads"\)/);
});
