// r107-client-reply-to.test.mjs - R107 (live trial SparkV): a studio with no business e-mail had client replies
// going to Helm's sending address (lost). Reply-To now falls back business e-mail -> studio owner's e-mail ->
// none (never the sender); EMAIL_BRAND_MODE=studio shows "<Studio> via Helm Events" and signs client mail off
// with the studio name; Settings > General explains where replies go.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok - ' + name); };
const RT = await import('../supabase/functions/_shared/reply-to.mjs');
const { otpEmail } = await import('../supabase/functions/wa-proposal/logic.mjs');
const { linkEmail } = await import('../supabase/functions/client-mailer/logic.mjs');
const ORG = 'a0000000-0000-4000-8000-0000000000b1', OWNER = 'a0000000-0000-4000-8000-0000000000c1', ROW = 'a0000000-0000-4000-8000-0000000000d1';
const SENDER = (k) => ({ SMTP_FROM: 'Helm <notifications@helm.events>', SMTP_USER: 'notifications@helm.events' })[k];

// fake service-role client: org row, studio_billing_email answer (or missing), auth admin, lane tables
function fakeAdmin({ business = null, owner = 'owner@sparkv.in', rpcMissing = false, rpcError = false, createdBy = OWNER, authEmail = 'creator@sparkv.in', laneOrg = ORG } = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push('rpc:' + name);
      if (name !== 'studio_billing_email' || args.p_org !== ORG) return { data: null, error: null };
      if (rpcMissing) return { data: null, error: { code: 'PGRST202' } };
      if (rpcError) return { data: null, error: { code: '57014' } };
      return { data: owner, error: null };
    },
    from: (table) => {
      const q = { cols: '', id: '' };
      const api = {
        select: (c) => { q.cols = c; return api; },
        eq: (_k, v) => { q.id = v; return api; },
        maybeSingle: async () => {
          calls.push('from:' + table + ':' + q.cols);
          if (table === 'organizations' && q.id === ORG) return { data: { business_email: business, created_by: createdBy }, error: null };
          if (q.id === ROW) return { data: { org_id: laneOrg }, error: null };
          return { data: null, error: null };
        },
      };
      return api;
    },
    auth: { admin: { getUserById: async (id) => ({ data: { user: id === OWNER ? { email: authEmail } : null }, error: null }) } },
  };
}

await t('pickReplyTo: first valid address, never a sender address (any case / "Name <addr>" form)', () => {
  assert.equal(RT.pickReplyTo(['', 'bad', 'studio@sparkv.in'], []), 'studio@sparkv.in');
  assert.equal(RT.pickReplyTo(['Notifications@Helm.Events', 'owner@sparkv.in'], RT.senderAddresses(SENDER)), 'owner@sparkv.in');
  assert.equal(RT.pickReplyTo(['notifications@helm.events'], RT.senderAddresses(SENDER)), '');
  assert.equal(RT.pickReplyTo(['a@b.com\r\nBcc: x@y.com'], []), '');
  assert.deepEqual(RT.senderAddresses(SENDER), ['notifications@helm.events', 'notifications@helm.events']);
  assert.deepEqual(RT.senderAddresses((k) => ({ RESEND_FROM: 'Helm <Mail@Helm.events>' })[k]), ['mail@helm.events']);
});

await t('studioReplyTo: business e-mail wins (no owner lookup)', async () => {
  const a = fakeAdmin();
  assert.equal(await RT.studioReplyTo(a, ORG, { business: 'hello@sparkv.in', env: SENDER }), 'hello@sparkv.in');
  assert.equal(a.calls.length, 0);
  assert.equal(await RT.studioReplyTo(a, ORG, { explicit: 'desk@sparkv.in', business: 'hello@sparkv.in' }), 'desk@sparkv.in', 'Integrations reply-to first');
});

await t('studioReplyTo: no business e-mail (SparkV) -> the studio owner (studio_billing_email, 0300)', async () => {
  const a = fakeAdmin();
  assert.equal(await RT.studioReplyTo(a, ORG, { business: null, env: SENDER }), 'owner@sparkv.in');
  assert.ok(a.calls.includes('rpc:studio_billing_email'));
  // business not passed -> read from organizations, then owner
  const b = fakeAdmin();
  assert.equal(await RT.studioReplyTo(b, ORG, { env: SENDER }), 'owner@sparkv.in');
  assert.ok(b.calls.some((c) => c.startsWith('from:organizations:business_email')));
  const c = fakeAdmin({ business: 'biz@sparkv.in' });
  assert.equal(await RT.studioReplyTo(c, ORG, { env: SENDER }), 'biz@sparkv.in');
});

await t('studioReplyTo: database without 0300 -> organizations.created_by auth e-mail; any error -> "" (no header)', async () => {
  assert.equal(await RT.studioReplyTo(fakeAdmin({ rpcMissing: true }), ORG, { business: null }), 'creator@sparkv.in');
  assert.equal(await RT.studioReplyTo(fakeAdmin({ rpcError: true }), ORG, { business: null }), '');
  assert.equal(await RT.studioReplyTo(fakeAdmin({ owner: 'notifications@helm.events' }), ORG, { business: null, env: SENDER }), '', 'owner == sender -> no Reply-To');
  assert.equal(await RT.studioReplyTo(fakeAdmin(), 'not-a-uuid', { business: null }), '');
  assert.equal(await RT.studioReplyTo(null, ORG, { business: null }), '');
});

await t('rowReplyTo: queued row -> its studio (lane table org_id), cached per studio; own reply-to kept', async () => {
  const a = fakeAdmin(), cache = new Map();
  assert.equal(await RT.rowReplyTo(a, 'outbox', ROW, null, { env: SENDER, cache }), 'owner@sparkv.in');
  assert.ok(a.calls.includes('from:comms_outbox:org_id'));
  const before = a.calls.length;
  assert.equal(await RT.rowReplyTo(a, 'vendor', ROW, '', { env: SENDER, cache }), 'owner@sparkv.in');
  assert.equal(a.calls.filter((c) => c === 'rpc:studio_billing_email').length, 1, 'one owner lookup per studio per run');
  assert.ok(a.calls.length > before && a.calls.includes('from:vendor_request_sends:org_id'));
  assert.equal(await RT.rowReplyTo(a, 'enquiry', ROW, 'desk@sparkv.in', { env: SENDER }), 'desk@sparkv.in');
  assert.equal(await RT.rowReplyTo(a, 'nope', ROW, null, {}), '');
  for (const [lane, table] of [['outbox', 'comms_outbox'], ['delivery', 'delivery_reminder_sends'], ['vendor', 'vendor_request_sends'],
    ['runsheet', 'runsheet_reminder_sends'], ['enquiry', 'lead_enquiries'], ['pkg', 'pkg_outbox']]) assert.equal(RT.LANE_TABLES[lane], table);
});

await t('mailer: studio mode "<Studio> via Helm Events" (address unchanged); helm mode "Helm Events"; Reply-To == sender dropped', () => {
  const m = read('supabase/functions/_shared/mailer.ts');
  assert.match(m, /HELM_BRAND = "Helm Events"/);
  assert.match(m, /return s \? s \+ " via " \+ HELM_BRAND : HELM_BRAND;/);
  assert.match(m, /if \(mode !== "studio"\) return HELM_BRAND;/);
  assert.match(m, /rt\.toLowerCase\(\) !== senderAddr\(cfg\.from!\)\.toLowerCase\(\)/);
});

await t('OTP e-mail: studio mode signs off with the studio; helm mode / unknown studio "Helm Events"; footer stays', () => {
  const s = otpEmail('123456', 'SparkV', { brand: 'studio' });
  assert.ok(s.text.includes('\n\nSparkV') && s.html.includes('SparkV</strong>'));
  assert.ok(!/<strong[^>]*>Helm Events<\/strong>/.test(s.html));
  assert.ok(s.html.includes('Helm Events &middot;') || s.html.includes('Helm Events,'), 'Helm footer kept');
  const h = otpEmail('123456', 'SparkV');
  assert.ok(h.text.includes('\n\nHelm Events') && /<strong[^>]*>Helm Events<\/strong>/.test(h.html));
  const u = otpEmail('123456', '', { brand: 'studio' });
  assert.ok(u.text.includes('\n\nHelm Events'), 'no studio name -> Helm Events');
  const x = otpEmail('123456', 'A <b>&', { brand: 'studio' });
  assert.ok(x.html.includes('A &lt;b&gt;&amp;</strong>'), 'studio sign-off escaped');
});

await t('client link e-mail: studio mode signs off with the studio (approval + booklet)', () => {
  for (const kind of ['approval', 'booklet']) {
    const e = linkEmail(kind, { studio: 'SparkV', client: 'Asha', link: 'https://www.helm.events/x', brand: 'studio' });
    assert.ok(e.text.includes('\n\nSparkV') && e.html.includes('SparkV</strong>'));
    const h = linkEmail(kind, { studio: 'SparkV', client: 'Asha', link: 'https://www.helm.events/x' });
    assert.ok(h.text.includes('\n\nHelm Events'));
  }
});

await t('client-mailer + send-otp: Reply-To from the shared helper; owner e-mail never in a response', () => {
  const cm = read('supabase/functions/client-mailer/index.ts'), so = read('supabase/functions/send-otp/index.ts');
  assert.match(cm, /import \{ studioReplyTo \} from "\.\.\/_shared\/reply-to\.mjs";/);
  assert.match(cm, /const replyTo = await studioReplyTo\(admin, String\(q\.org_id \|\| ""\), \{ business: \(org && org\.business_email\) \|\| null, env: envGet \}\);/);
  assert.match(cm, /replyTo: replyTo \|\| null, txReason: "client_link"/);
  assert.doesNotMatch(cm, /replyTo: org && org\.business_email/);
  for (const line of cm.split('\n').filter((l) => /return json\(/.test(l))) assert.doesNotMatch(line, /replyTo|business_email/);
  assert.match(so, /replyTo = \(await studioReplyTo\(admin, String\(q\.org_id\), \{ business: \(o && o\.business_email\) \|\| null, env: envGet \}\)\) \|\| null;/);
  assert.match(so, /otpEmail\(code, studio \|\| "your planner", \{ address: postalAddress\(envGet\), brand: brandMode\(envGet\) \}\)/);
  for (const line of so.split('\n').filter((l) => /return json\(/.test(l))) assert.doesNotMatch(line, /replyTo|business_email/);
});

await t('comms-dispatch: every studio e-mail lane gets the Reply-To fallback; Helm\'s own lanes untouched', () => {
  const cd = read('supabase/functions/comms-dispatch/index.ts');
  assert.match(cd, /import \{ rowReplyTo \} from "\.\.\/_shared\/reply-to\.mjs";/);
  assert.match(cd, /ident = await withReply\("outbox", id, ident\);/);
  for (const lane of ['delivery', 'vendor', 'runsheet', 'enquiry']) assert.match(cd, new RegExp('const ident: Identity = await withReply\\("' + lane + '", id,'));
  assert.equal((cd.match(/withReply\("/g) || []).length, 5);
  assert.match(cd, /sendEmail\(id, to, msg\.subject, msg\.text, "Helm", \{\}, extra\)/, 'trial mail stays Helm, no studio reply-to');
});

await t('pkg-client-notify: client package e-mails get Reply-To + studio-mode sender', () => {
  const pk = read('supabase/functions/pkg-client-notify/index.ts');
  assert.match(pk, /rowReplyTo\(admin, "pkg", id, null,/);
  assert.match(pk, /reply_to: replyTo/);
  assert.match(pk, /return s \? s \+ " via " \+ HELM_BRAND : "Helm";/);
});

await t('Settings > General: business e-mail hint (static, CSP-safe)', () => {
  const c = read('public/control.html');
  assert.match(c, /aria-describedby="o_email_hint"><p class="lock-note" id="o_email_hint">Client replies go here\. If empty, they go to the studio owner's email\.<\/p>/);
});

console.log(`r107-client-reply-to: ${n} checks passed`);
