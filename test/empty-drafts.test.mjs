// 0141 — empty draft clean-up. Pins: soft-only (no DELETE FROM), every content check present,
// check runs twice (candidate loop + inside the UPDATE WHERE, row-locked), dynamic child-table
// scan fails closed, grants, guarded cron, rollback proof in APPLY, and the Quotes UI toggle.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const mig = r('supabase/migrations/0141_empty_draft_cleanup.sql');
const apply = r('supabase/APPLY-0139-0141.sql');
const qh = r('public/quotes.html');
const api = r('public/store-api.js');
const manifest = r('supabase/migrations/MANIFEST');
const code = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnBody = (name) => { const m = code.match(new RegExp(`function public\\.${name}\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`)); assert.ok(m, name); return m[1]; };

t('never hard-deletes quotes or children', () => {
  assert.doesNotMatch(code, /delete\s+from/i);
  assert.doesNotMatch(code, /drop\s+(table|column)/i);
  assert.doesNotMatch(code, /truncate/i);
});
t('additive + idempotent', () => {
  assert.match(code, /add column if not exists auto_discarded_at timestamptz/);
  assert.match(code, /drop trigger if exists zz_quote_auto_discard_restore/);
  assert.match(code, /not exists \(select 1 from cron\.job where jobname = 'helm_discard_empty_drafts'\)/);
  assert.match(code, /pg_extension where extname = 'pg_cron'/);
});
t('reason helper checks every field', () => {
  const b = fnBody('_empty_draft_reason');
  for (const s of ["'status'", "'sent'", "'too_new'", "'recently_edited'", "'title'", "'event_type'", "'event_date'",
                   "'client'", "'pricing.'", "'versions'", "'layout'", "'has:'", "'unreadable:'", "'restored_before'", "'shelved'"])
    assert.ok(b.includes(s), 'missing check ' + s);
  assert.match(b, /interval '24 hours'/);
  assert.match(b, /information_schema\.columns[\s\S]*column_name = 'quote_id'/);
  assert.match(b, /contype = 'f' and con\.confrelid = 'public\.quotes'::regclass/);
  assert.match(b, /not in \('quotes', 'quote_versions', 'audit_log'\)/);   // only audit_log ignored
  assert.match(b, /exception when others then\s*return 'unreadable:'/);  // fail closed
});
t('checked twice; second check inside the update, row locked', () => {
  const b = fnBody('_discard_empty_drafts_for');
  assert.match(b, /continue when public\._empty_draft_reason\(r\.id\) is not null/);
  assert.match(b, /for update of x skip locked/);
  assert.match(b, /where q\.id = r\.id and q\.org_id = p_org[\s\S]*and public\._empty_draft_reason\(q\.id\) is null/);
  assert.match(b, /deleted_reason = 'auto_empty_draft'/);
  assert.match(b, /insert into public\.audit_log/);
});
t('scope + grants', () => {
  const app = fnBody('discard_empty_drafts');
  assert.match(app, /public\.current_org_id\(\)/);
  assert.match(app, /has_area\('quotes', 'edit'\)/);
  assert.match(code, /grant execute on function public\.discard_empty_drafts\(\) to authenticated/);
  assert.match(code, /revoke all on function public\.discard_empty_drafts_all\(\) from authenticated/);
  assert.match(code, /grant execute on function public\.discard_empty_drafts_all\(\) to service_role/);
  assert.match(code, /revoke all on function public\._empty_draft_reason\(uuid\) from authenticated/);
  assert.match(code, /revoke all on function public\._discard_empty_drafts_for\(uuid, int\) from authenticated/);
  for (const f of ['_empty_draft_reason', '_discard_empty_drafts_for', 'discard_empty_drafts', 'discard_empty_drafts_all'])
    assert.match(code, new RegExp(`function public\\.${f}\\([^)]*\\)\\s*returns [a-z]+ language plpgsql volatile security definer set search_path = ''`));
});
t('APPLY 0139-0141: one transaction, embeds the migration, read-only verify, no test writes', () => {
  assert.ok(apply.startsWith('-- APPLY 0139-0141'));
  assert.ok(apply.includes(mig.trim()), 'APPLY embeds the migration verbatim');
  assert.equal((apply.match(/^begin;$/gm) || []).length, 1);
  assert.equal((apply.match(/^commit;$/gm) || []).length, 1);
  assert.ok(!/insert into public\.quotes\s*\(/i.test(apply), 'no test quotes written on prod');
  assert.ok(/[\x00-\x7F]*/.test(apply) && !/[^\x00-\x7F]/.test(apply), 'ASCII only');
  assert.match(apply, /'0141 worker re-checks inside the update'/);
  assert.match(manifest, /forward\s+supabase\/migrations\/0141_empty_draft_cleanup\.sql/);
});
t('Quotes UI: hidden by default, toggle, note, restore path, throttled run', () => {
  assert.match(qh, /id="showDiscarded"/);
  assert.match(qh, /Show discarded drafts/);
  assert.match(qh, /!isDiscarded\(r\) \|\| showDiscarded\(\)/);
  assert.match(qh, /reason==="auto_empty_draft"/);
  assert.match(qh, /bp_q_discard/);
  assert.match(api, /rpc\("discard_empty_drafts", \{\}\)/);
  assert.match(api, /discardEmptyDrafts: \(\) =>/);
  assert.doesNotMatch(qh, /<label class="discard-toggle"[^>]*style=/);
});
console.log(`\nempty-drafts: ${n} passed`);
