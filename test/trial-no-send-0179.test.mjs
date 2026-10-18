// 0179: a free-trial studio sends no real client message - DB wrappers + edge-function service-role check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let fail = 0; const t = (n, f) => { try { f(); console.log('  ok ' + n); } catch (e) { fail++; console.log('  FAIL ' + n); console.log(e.message); } };
const M = read('supabase/migrations/0179_trial_no_client_messages.sql'), A = read('supabase/APPLY-0179.sql');
const G = read('supabase/functions/_shared/trial-guard.ts');
t('0179 SQL: ASCII, additive, in MANIFEST, APPLY carries the migration verbatim + VERIFY', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(M) && /^[\x00-\x7F]*$/.test(A) && /^[\x00-\x7F]*$/.test(G));
  assert.ok(!/\b(drop table|drop function|delete from|truncate)\b/i.test(M.replace(/--.*/g, '')));
  assert.ok(A.includes(M)); assert.match(A, /-- VERIFY/); assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0179_trial_no_client_messages\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/trial-no-send-0179\.sql/);
});
t('0179 SQL: trial = subscription status (never trial_ends_at); all 5 send paths wrapped', () => {
  assert.match(M, /public\._is_trial_org\(p_org\)/);
  assert.ok(!/trial_ends_at/.test(M.replace(/--.*/g, '')));
  for (const f of ['otp_send_authorize', 'request_otp', 'wa_otp_begin', 'whatsapp_authorize', 'wa_proposal_prepare']) {
    assert.match(M, new RegExp("array\\['" + f + "'"), f + ' renamed once');
    assert.match(M, new RegExp('return public\\.' + f + '__pre0179\\('), f + ' wrapper calls the kept body');
  }
  assert.match(M, /coalesce\(p_simulate, false\) is not true/);
  assert.match(M, /before update of status on public\.%I/);
  assert.match(M, /zzzz_tb179_seat_role before update of role on public\.profiles/);
  assert.match(M, /zzzz_tb179_seat_role before update of role on public\.invitations/);
});
t('edge guard: service-role rpc, literal true, table fallback on status, fail closed', () => {
  assert.match(G, /admin\.rpc\("trial_send_blocked"/);
  assert.match(G, /return data === true;/);
  assert.match(G, /\.eq\("status", "trial"\)/);
  assert.ok(!/trial_ends_at/.test(G.replace(/\/\/.*/g, '')));
  assert.match(G, /catch \(_\) \{\s*return true;/);
});
t('edge functions ask before any real send', () => {
  const otp = read('supabase/functions/send-otp/index.ts');
  assert.equal((otp.match(/await trialSendBlocked\(admin, \{ token \}\)/g) || []).length, 2, 'SMS + WhatsApp/e-mail paths');
  assert.ok(otp.indexOf('trialSendBlocked(admin, { token })') < otp.indexOf('admin.rpc("admin_store_otp"'), 'before a code is stored');
  const cm = read('supabase/functions/client-mailer/index.ts');
  assert.ok(cm.indexOf('trialSendBlocked(admin') > 0 && cm.indexOf('trialSendBlocked(admin') < cm.indexOf('await sendMail('));
  const wa = read('supabase/functions/send-whatsapp/index.ts');
  assert.ok(wa.indexOf('trialSendBlocked(admin') > 0 && wa.indexOf('trialSendBlocked(admin') < wa.indexOf('/messages`'));
  assert.match(wa, /hint === TRIAL_NO_SEND_HINT/);
  const wp = read('supabase/functions/wa-proposal/index.ts');
  assert.match(wp, /trial = await trialSendBlocked\(admin0, \{ quote: quoteId \}\);\s*if \(trial\) live = false;/);
  assert.ok(wp.indexOf('trialSendBlocked(admin0') < wp.indexOf('rpc("wa_proposal_prepare"'), 'decided before prepare (p_simulate)');
});
if (fail) { console.log('trial-no-send-0179: ' + fail + ' FAILED'); process.exit(1); }
console.log('trial-no-send-0179: ok');
