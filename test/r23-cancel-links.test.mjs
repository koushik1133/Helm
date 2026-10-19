// r23-cancel-links.test.mjs - r23 live bug (fix/r23-cancel-expires-links): after "Cancel event" the invitation site
// (and booklet, proposal, portal, crew and vendor links) still opened, although the dialog said client links expire.
//  1  SQL 0260: every public / tokenized entry point is wrapped once with the read-time "cancelled" refusal (the DB
//     behaviour is proven on Postgres in tests/db/r23-cancel-links-0260.sql); storage checks + publish guard; APPLY file
//  2  every public page shows a friendly "This event has been cancelled" card (no event details)
//  3  the Cancel event dialog lists exactly which links stop working
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0, fail = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };

const SQL = read('supabase/migrations/0260_cancel_expires_links.sql'), APPLY = read('supabase/APPLY-0260.sql');
const MANIFEST = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh');
const DBT = read('tests/db/r23-cancel-links-0260.sql');
const EV = read('public/event.html'), INV = read('public/invite.html'), APR = read('public/approve.html');
const POR = read('public/portal.html'), PRO = read('public/proposal-view.html'), BK = read('public/booklet.js');
const WK = read('public/work.html'), DS = read('public/delivery-status.js'), STORE = read('public/store-api.js');

const WRAPPED = ['public_get_quote', 'public_get_portal', 'public_portal_extras', 'public_quote_paid_status', 'request_otp',
  'verify_and_consent', 'create_payment', 'wa_request_otp', 'wa_verify_and_consent', 'trial_test_approve', 'otp_send_authorize',
  'payment_link_begin', 'wa_otp_begin', 'trial_email_otp_begin', 'public_get_booklet', 'public_booklet_choose',
  'public_booklet_otp_request', 'public_booklet_packages', 'public_booklet_pay_terms', 'public_get_booklet_image',
  'booklet_snapshot_path', 'public_get_proposal', 'public_event_site', 'delivery_link_get', 'delivery_link_update',
  'wa_proposal_prepare', '_work_token_live', 'cancel_event'];

console.log('r23 cancel expires links - SQL 0260:');
t('every client / crew / vendor link entry point is wrapped once (rename guard + wrapper + old body closed)', () => {
  assert.equal(WRAPPED.length, 28);
  for (const f of WRAPPED) {
    assert.match(SQL, new RegExp(`to_regprocedure\\('public\\.${f}__pre0260\\([^)]*\\)'\\) is null and to_regprocedure\\('public\\.${f}\\(`), f + ' rename guard');
    assert.match(SQL, new RegExp(`alter function public\\.${f}\\([^)]*\\) rename to ${f}__pre0260;`), f + ' rename');
    assert.match(SQL, new RegExp(`revoke all on function public\\.${f}__pre0260\\([^)]*\\) from public, anon, authenticated, service_role;`), f + ' old body closed');
    assert.match(SQL, new RegExp(`create or replace function public\\.${f}\\(`), f + ' wrapper');
  }
});
t('wrappers refuse through ONE helper + ONE message (no event details), checked at read time', () => {
  assert.match(SQL, /raise exception 'This event has been cancelled\. This link is no longer active\.'\s+using errcode = 'P0001', hint = 'event_cancelled';/);
  assert.equal((SQL.match(/perform public\._a260_gate\('/g) || []).length, 26, '25 generated (delivery_link_get answers ok:false instead) + _work_token_live');
  assert.match(SQL, /if public\._a260_link_state\('delivery', p_token\) is not null then\s+return jsonb_build_object\('ok', false, 'reason', public\._a260_link_state\('delivery', p_token\)\);/);
  assert.match(SQL, /if p_kind = 'site' and v = 'paused' then return null; end if;/, 'the site follows only cancelled (re-publish decides)');
  assert.match(SQL, /raise exception 'This link has expired\. Please ask your event planner to share it again\.'/);
  assert.match(SQL, /select coalesce\(\(select q\.status = 'cancelled' from public\.quotes q where q\.id = p_quote\), false\)/);
  for (const k of ['approval', 'booklet', 'proposal', 'site', 'delivery', 'staff']) assert.match(SQL, new RegExp(`_a260_gate\\('${k}'`), k);
  for (const h of ['_a260_quote_cancelled(uuid)', '_a260_link_quote(text, text)', '_a260_link_cancelled(text, text)', '_a260_refuse()',
                   '_a260_quote_state(uuid)', '_a260_link_state(text, text)', '_a260_gate(text, text)', '_a260_can_restore()', '_a260_bell(uuid, uuid, text, text)'])
    assert.ok(SQL.includes(`revoke all on function public.${h} from public, anon, authenticated, service_role;`), h + ' private');
});
t('every wrapper first revokes the default grants, then grants exactly the old set (same ACL, proven on PG)', () => {
  const re = /create or replace function public\.([a-z_0-9]+)\([\s\S]*?\$\$;\nrevoke all on function public\.\1\([^)]*\) from public, anon, authenticated, service_role;\n(grant execute on function public\.\1\([^)]*\) to [a-z_, ]+;)?/g;
  const seen = new Set(); let m; while ((m = re.exec(SQL))) seen.add(m[1]);
  for (const f of WRAPPED.concat(['invite_media_on_published_site', 'invite_media_guest_read_ok', 'task_proof_upload_ok'])) assert.ok(seen.has(f), f);
  assert.match(SQL, /grant execute on function public\.payment_link_begin\(uuid, integer\) to service_role;/);
  assert.match(SQL, /grant execute on function public\.otp_send_authorize\(uuid, text\) to service_role;/);
  assert.match(SQL, /grant execute on function public\.public_event_site\(text\) to anon, authenticated, service_role;/);
  assert.match(SQL, /grant execute on function public\.cancel_event\(uuid, text\) to authenticated, service_role;/);
});
t('0256 vendor request links (accept / decline / invoice) are wrapped too - only where 0256 is applied', () => {
  for (const f of ['vendor_link_get', 'vendor_link_respond', 'vendor_invoice_upload', 'vendor_invoice_submit']) assert.ok(SQL.includes(`('${f}',`), f);
  assert.match(SQL, /if to_regprocedure\('public\.' \|\| r\.fn \|\| '\(' \|\| r\.types \|\| '\)'\) is null then continue; end if;/);
  assert.match(SQL, /declare v text := public\._a260_link_state\('vendor', p_token\);/);
  assert.match(read('public/vendor-request.js'), /if \(d && d\.reason === "cancelled"\) return bad\("This event has been cancelled"/);
});
t('storage checks are replaced IN PLACE (policies point at them) with "not cancelled"', () => {
  for (const f of ['invite_media_on_published_site', 'invite_media_guest_read_ok', 'task_proof_upload_ok']) {
    assert.ok(!new RegExp(`alter function public\\.${f}\\(`).test(SQL), f + ' must not be renamed');
    assert.match(SQL, new RegExp(`create or replace function public\\.${f}\\(p_name text\\)`));
  }
  assert.equal((SQL.match(/and not public\._a260_quote_cancelled\(s\.quote_id\)/g) || []).length, 2, 'invitation photos: cancelled only');
  assert.match(SQL, /and public\._a260_quote_state\(g\.quote_id\) is null\);/, 'crew proofs: cancelled or paused');
});
t('cancel_event unpublishes the invitation site (content kept, stamp), publish guard, no destructive SQL', () => {
  assert.match(SQL, /add column if not exists cancel_unpublished_at timestamptz/);
  assert.match(SQL, /set status = 'unpublished', cancel_unpublished_at = now\(\)\s+where s\.quote_id = p_quote_id and s\.org_id = v_org and s\.status = 'published'/);
  assert.match(SQL, /v := public\.cancel_event__pre0260\(p_quote_id, p_reason\);/);
  assert.match(SQL, /jsonb_build_object\('links_expired', true, 'invitation_unpublished', n > 0\)/);
  assert.match(SQL, /create trigger ac_a260_site_publish_guard before insert or update on public\.event_sites/);
  assert.ok(!/\b(delete from|truncate|drop table|drop column|drop function|drop policy)\b/i.test(SQL), 'nothing dropped / deleted');
  assert.ok(!/[^\x00-\x7f]/.test(SQL), 'ASCII only');
});
t('APPLY-0260 = header + begin + the migration + commit + VERIFY again; MANIFEST + run-all register it', () => {
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'), 'migration embedded verbatim');
  assert.ok(APPLY.trimEnd().endsWith(') v(item, ok) order by item;'));
  assert.equal((APPLY.match(/\('07 invitation: unpublish stamp \+ publish guard'/g) || []).length, 2);
  assert.ok(!/[^\x00-\x7f]/.test(APPLY), 'ASCII only');
  assert.match(MANIFEST, /\nforward  supabase\/migrations\/0260_cancel_expires_links\.sql\n/);
  assert.match(RUNALL, /run "r23-cancel-links-0260" "R23-CANCEL-LINKS-0260: ALL PASS \\\(40\/40\\\)" psql -q -f tests\/db\/r23-cancel-links-0260\.sql/);
  assert.match(DBT, /\\ir \.\.\/\.\.\/supabase\/migrations\/0260_cancel_expires_links\.sql\n\\ir \.\.\/\.\.\/supabase\/migrations\/0260_cancel_expires_links\.sql/);
  assert.match(DBT, /^rollback;\s*$/m);
});

t('restore_event + resume_client_links: roles, reason, log, bell, links paused until re-shared', () => {
  assert.match(SQL, /select public\.has_area\('quotes', 'edit'\) and coalesce\(public\.user_role\(\), ''\) in \('admin', 'manager', 'coordinator'\);/);
  assert.match(SQL, /update public\.quotes qq set status = v_status, client_links_paused_at = now\(\), updated_at = now\(\) where qq\.id = p_quote_id;/);
  assert.match(SQL, /v_status := case when c\.prev_status in \('quote', 'confirmed'\) then c\.prev_status else 'quote' end;/);
  assert.match(SQL, /insert into public\.event_restorations\(/);
  assert.match(SQL, /'event_restored', 'quotes'/); assert.match(SQL, /'client_links_resumed', 'quotes'/);
  assert.match(SQL, /perform public\._a260_bell\(v_org, p_quote_id, 'event_restored',/);
  assert.match(SQL, /v_tok := q\.approval_token_revoked_at is not null and v_cancel_at is not null and q\.approval_token_revoked_at >= v_cancel_at;/);
  assert.match(SQL, /alter table public\.event_restorations enable row level security;/);
  for (const f of ['restore_event(uuid, text)', 'resume_client_links(uuid)', 'event_link_state(uuid)'])
    assert.ok(SQL.includes(`grant execute on function public.${f} to authenticated;`), f);
});

console.log('r23 cancel expires links - pages:');
t('approve / portal / proposal pages: a cancelled event shows its own card before "link not found"', () => {
  for (const [name, src, el] of [['approve', APR, '#badlink'], ['portal', POR, '#bad'], ['proposal', PRO, '#error']]) {
    assert.match(src, /const isCancelled=\(e\)=>\/has been cancelled\/i\.test\(\(e&&e\.message\)\|\|""\);/, name);
    assert.ok(src.includes(`if(isCancelled(e)){ showCancelled($("${el}")); return; }\n      if(isBadLink(e))`), name + ' order');
    assert.ok(src.includes('"This event has been cancelled"'), name);
  }
});
t('invitation site: minimal cancelled state on the "ended" card (no other renderer change)', () => {
  assert.match(INV, /if\(\/has been cancelled\/i\.test\(\(e&&e\.message\)\|\|""\)\)\{[^}]*\$\("#ended"\)\.querySelector\("h1"\)\.textContent="This event has been cancelled";/);
  assert.ok(INV.indexOf('/has been cancelled/i') < INV.indexOf('/has ended|expired/i'));
});
t('booklet, crew task page and vendor delivery page say the event was cancelled', () => {
  assert.match(BK, /if \(\/has been cancelled\/i\.test\(String\(\(e && e\.message\) \|\| ""\)\)\) \{/);
  assert.ok(BK.indexOf('/has been cancelled/i') < BK.indexOf('if (isBad(e)) { show("#bad"); return; }'));
  assert.match(WK, /if\(\/expired\|revoked\|invalid link\/i\.test\(em\) \|\| \/has been cancelled\/i\.test\(em\)\)\{/);
  assert.match(WK, /gone\?"This event has been cancelled"/);
  assert.match(DS, /if \(d && d\.reason === "cancelled"\) return bad\("This event has been cancelled"/);
});

console.log('r23 cancel expires links - the Cancel event dialog matches reality:');
t('dialog lists every link that stops working + the Razorpay caveat; toast reports the unpublished site', () => {
  const i = EV.indexOf('const reason=await BPUI.prompt("Cancel "'); assert.ok(i > 0);
  const msg = EV.slice(i, EV.indexOf('{ title:"Cancel this event?"', i));
  for (const w of ['quote approval and payment link', 'client portal', 'booklet', 'proposal', 'invitation website',
                   'unpublished; its content is kept', 'crew task links', 'vendor delivery links', 'This event has been cancelled',
                   'Razorpay payment link already sent', 'Settlement', 'audit log'])
    assert.ok(msg.includes(w), 'dialog mentions: ' + w);
  assert.ok(!/client's approval link stops working\./.test(msg), 'old (incomplete) wording gone');
  assert.match(EV, /r&&r\.invitation_unpublished\?" and the invitation website is unpublished":""/);
  assert.match(STORE, /0260: every public link of a cancelled event refuses/);
});

t('Restore event + Re-share links on the event page (footer + ••• menu) and on the quotes Cancelled tab', () => {
  assert.match(EV, /<button type="button" class="btn" id="restoreEvBtn" hidden>↺ Restore event<\/button>/);
  assert.match(EV, /<button type="button" class="btn" id="reshareBtn"[^>]*hidden>🔗 Re-share links<\/button>/);
  assert.match(EV, /data-proxy="restoreEvBtn"/); assert.match(EV, /data-proxy="reshareBtn"/);
  assert.match(EV, /\$\("#restoreEvBtn"\)\.hidden=!\(may && ev\.status==="cancelled" && !evClosedNow\(\)\);/);
  assert.match(EV, /\$\("#reshareBtn"\)\.hidden=!\(may && ev\.status!=="cancelled" && !!\(linkState&&linkState\.links_paused\)\);/);
  assert.match(EV, /await BPStore\.quotes\.restoreEvent\(id, reason\.trim\(\)\)/); assert.match(EV, /await BPStore\.quotes\.resumeLinks\(id\)/);
  assert.match(EV, /Client links do NOT come back by themselves/);
  assert.match(STORE, /supa\.rpc\("restore_event", \{ p_quote_id: id, p_reason: r \}\)/);
  assert.match(STORE, /supa\.rpc\("resume_client_links", \{ p_quote_id: id \}\)/);
  assert.match(STORE, /supa\.rpc\("event_link_state", \{ p_quote_id: id \}\)/);
  const QH = read('public/quotes.html');
  assert.match(QH, /canEdit&&canUncancel&&x\.status==="cancelled"\?`<button type="button" class="ic restore" data-act="uncancel"/);
  assert.match(QH, /else if\(act==="uncancel"\) uncancelEvent\(id, b\);/);
  assert.match(QH, /await BPStore\.quotes\.restoreEvent\(id, reason\.trim\(\)\)/);
});

console.log(`\n${n} passed, ${fail} failed`);
if (fail) process.exit(1);
