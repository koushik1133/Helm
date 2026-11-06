// r124-trial-followups.test.mjs - R124 follow-up e-mails after a free trial ends without a plan.
//  A  exact subjects, buttons and the required lines of all four; plain text and HTML say the same; date only when one exists
//  B  no invented testimonials, statistics or offers; nothing about clients; studio name escaped and kept on one line
//  C  the footer lands once, inside the card; the mailer's "designed" check sees it so it never doubles
//  D  every button goes to /checkout, which now survives the sign-in step (store-api loginNext), never /signup
//  E  comms-dispatch: new claim called, same mark, marketing footer + unsubscribe for all four, reply-to, warnings still transactional
//  F  SQL: starts_at guard, set once, additive, wrappers, MANIFEST + APPLY-0333 + run-all in step
// Pure + static; the database side: tests/db/r124-trial-followups-0333.sql; transport: tests/edge/comms-dispatch-email.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const m = await import('../supabase/functions/comms-dispatch/trial-reminders.mjs');
const { mktFooter, withFooter } = await import('../supabase/functions/_shared/email-compliance.mjs');
const FN = rd('supabase/functions/comms-dispatch/index.ts');
const MIG = rd('supabase/migrations/0333_r124_trial_followup_emails.sql'), APPLY = rd('supabase/APPLY-0333.sql');
const MAN = rd('supabase/migrations/MANIFEST'), RUN = rd('scripts/db-test/run-all.sh'), PKG = rd('package.json');
const STORE = rd('public/store-api.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const APP = 'https://www.helm.events';
const mail = (k, s = 'Sita Events', d = '2027-01-05') => m.trialFollowupEmail(k, s, { deleteOn: d }, APP);
// removes every match, including one that only appears after an inner match is removed
const stripAll = (h, re) => { let prev; do { prev = h; h = h.replace(re, ''); } while (h !== prev); return h; };
const noStyle = (h) => stripAll(h, /<style[\s\S]*?<\/style[^>]*>/gi);
const visible = (h) => stripAll(noStyle(h), /<!--[\s\S]*?-->/g).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

t('A Day 0: subject, reassurance, date, button', () => {
  const e = mail('x0');
  assert.equal(e.subject, 'Your Helm free trial has ended. Sita Events is safe.');
  assert.match(e.text, /nothing is lost/); assert.match(e.text, /is saved/); assert.match(e.text, /sign in/);
  assert.match(e.text, /kept until 05\/01\/2027/); assert.match(e.text, /Choose a plan: https:\/\/www\.helm\.events\/checkout/);
  assert.ok(!/kept until/.test(mail('x0', 'S', '').text), 'no date, no date sentence');
  assert.ok(mail('x0', 'S', '').text.includes(m.RETENTION_PROMISE), 'deletion off: the one retention promise');
});
t('A Day 2: subject, the three things that go live, button', () => {
  const e = mail('x2');
  assert.equal(e.subject, 'Sita Events is waiting for you');
  assert.ok(e.text.includes("You've seen how Helm works. On a plan, it all goes live:"));
  assert.match(e.text, /approves online with a one-time code/);
  assert.match(e.text, /Booklets and invitations reach real clients and guests/);
  assert.match(e.text, /Downloads, branding and your own templates unlock/);
  assert.match(e.text, /Create your studio: https:\/\/www\.helm\.events\/checkout/);
});
t('A Day 7: subject, everything together, reply, button; no date', () => {
  const e = mail('x7');
  assert.equal(e.subject, 'One place for your next event');
  assert.match(e.text, /Enquiry, quote, layout, team, payments and profit/);
  assert.match(e.text, /is ready and your work is still there/); assert.match(e.text, /reply to this e-mail/);
  assert.match(e.text, /See plans: https:\/\/www\.helm\.events\/checkout/); assert.ok(!/05\/01\/2027/.test(e.text));
});
t('A Day 14: subject, last reminder, date, feedback, button', () => {
  const e = mail('x14');
  assert.equal(e.subject, 'Should we keep Sita Events for you?');
  assert.match(e.text, /last reminder/); assert.match(e.text, /won't keep writing/); assert.match(e.text, /stays until 05\/01\/2027/);
  assert.match(e.text, /one line/); assert.match(e.text, /Keep my studio: https:\/\/www\.helm\.events\/checkout/);
  const none = mail('x14', 'S', '').text;
  assert.ok(!/until/.test(none)); assert.ok(none.includes(m.RETENTION_PROMISE));
});
t('A the HTML says what the text says, on the Helm layout', () => {
  for (const k of m.FOLLOWUP_KINDS) {
    const e = mail(k), v = visible(e.html);
    for (const line of e.text.split('\n').map((x) => x.replace(/^- /, '').trim()).filter(Boolean)) {
      if (/^Hi |^The Helm team|https?:/.test(line)) continue;
      assert.ok(v.includes(line), k + ' html is missing: ' + line);
    }
    assert.match(e.html, /<!DOCTYPE html>/); assert.ok(e.html.includes('helm-logo-v3.png')); assert.ok(e.html.includes('href="https://www.helm.events/checkout"'));
  }
});
t('A a missing studio name reads naturally; unknown kinds give nothing; the retention entry point routes here', () => {
  assert.equal(mail('x0', '').subject, 'Your Helm free trial has ended. Your studio is safe.');
  assert.equal(mail('x2', '  ').subject, 'Your studio is waiting for you');
  assert.equal(mail('x14', '').subject, 'Should we keep your studio for you?');
  assert.match(mail('x0', '').text, /^Hi there,/);
  assert.equal(m.trialFollowupEmail('del7', 'x', {}, APP), null);
  assert.equal(m.trialRetentionEmail('x14', 'Sita', {}, APP).subject, 'Should we keep Sita for you?');
  assert.deepEqual(m.RETENTION_NOTICE_KINDS, ['del30', 'del7', 'del1']);
});
t('B no invented claims: no testimonial, statistic, price or offer', () => {
  for (const k of m.FOLLOWUP_KINDS) {
    const e = mail(k), all = e.subject + ' ' + e.text;
    assert.ok(!/%|discount|\boff\b|free month|offer|coupon|customers|studios (love|use)|trusted|rated|\bsaved? \d|Rs\.?|INR|\u20b9/i.test(all.replace(/free trial/g, '').replace(/helm\.events/g, '')), k + ': ' + all);
  }
});
t('B a hostile studio name is escaped in the HTML and cannot break a header', () => {
  const e = mail('x2', 'Sita<script>alert(1)</script>\r\nBcc: x@y.z');
  assert.ok(!e.html.includes('<script>alert')); assert.ok(e.html.includes('&lt;script&gt;'));
  assert.ok(!/[\r\n]/.test(e.subject));
  assert.ok(m.trialFollowupEmail('x0', 'S'.repeat(500), {}, APP).subject.length < 150);
});
t('C the footer lands once, in the card, and the mailer treats the message as designed', () => {
  const footer = mktFooter('https://www.helm.events/unsubscribe?t=abc', { sender: 'Helm', reason: m.FOLLOWUP_REASON });
  const html = m.placeFooter(mail('x0').html, footer);
  assert.ok(!html.includes(m.FOOTER_SLOT));
  assert.equal(html.split('Unsubscribe').length, 2);
  assert.ok(html.indexOf('Unsubscribe') < html.indexOf('padding:22px 8px 0'), 'inside the card, above the page footer');
  assert.match(html, /You received this because/);   // the mailer's "designed" test (_shared/mailer.ts)
  assert.match(rd('supabase/functions/_shared/mailer.ts'), /designed = !!msg\.html && \/You received this because\/\.test\(msg\.html\)/);
  assert.ok(withFooter({ text: mail('x0').text }, footer).text.includes('Unsubscribe: '));
});
t('D /checkout survives the sign-in step (a signed-out owner used to land on the dashboard); safeNext still refuses it', () => {
  const src = /function loginNext\(raw\) \{[\s\S]*?\n  \}/.exec(STORE)[0];
  const safeNext = () => 'dashboard.html';
  const loginNext = new Function('safeNext', src + '; return loginNext;')(safeNext);
  for (const raw of ['checkout', '/checkout', 'checkout.html']) assert.equal(loginNext(raw), 'checkout.html', raw);
  assert.equal(loginNext('checkout?plan=studio'), 'checkout.html?plan=studio');
  for (const raw of ['https://evil.example/checkout', '//evil.example/checkout', 'checkout/../x', '/checkout#x']) assert.equal(loginNext(raw), 'dashboard.html', raw);
  assert.match(rd('public/login.html'), /const nextUrl=\(\)=>BPStore\.auth\.safeNext\(/);
  assert.match(STORE, /safeNext: \(raw\) => \(\/\^\\\/login\(\\\.html\)\?\\\/\?\$\/\.test\(location\.pathname\) \? loginNext\(raw\) : safeNext\(raw\)\),/, 'the sign-in page only');
  assert.ok(!JSON.parse(/const NEXT_PAGES = (\[[^\]]+\])/.exec(STORE)[1]).includes('checkout'), 'safeNext stays closed: /checkout never sends anyone to itself');
  assert.match(STORE, /next: \(\) => safeNext\(nextParam\(\)\),/);
});
t('D every button is the plan page, never sign-up, and comes from APP_URL, not a row', () => {
  for (const k of m.FOLLOWUP_KINDS) {
    const e = mail(k);
    assert.ok(!/signup|sign-up|\/login/.test(e.text + noStyle(e.html)), k);
    assert.match(m.trialFollowupEmail(k, 'x', { url: 'https://evil.example/' }, 'https://staging.helm.events/').text, /(^|\s)https:\/\/staging\.helm\.events\/checkout(\s|$)/);
    assert.ok(!m.trialFollowupEmail(k, 'x', { url: 'https://evil.example/' }, APP).html.includes('evil'));
  }
});
t('E dispatcher: both claims, one mark, marketing footer for all four kinds, reply-to', () => {
  assert.match(FN, /admin\.rpc\("trial_followup_email_claim", \{ p_limit: batch \}\)/);
  assert.match(FN, /\[\.\.\.\(Array\.isArray\(rrows\) \? rrows : \[\]\), \.\.\.\(Array\.isArray\(frows\) \? frows : \[\]\)\]/);
  assert.equal((FN.match(/admin\.rpc\("trial_retention_email_mark"/g) || []).length, 1);
  assert.match(FN, /if \(msg && RETENTION_NOTICE_KINDS\.includes\(kind\)\) extra = \{ footer: txFooter\(RETENTION_TX_REASON/);
  assert.match(FN, /extra = marketingExtra\(u, "Helm", FOLLOWUP_REASON, origin\)/);
  assert.match(FN, /follow \? \{ reply_to: FOLLOWUP_REPLY_TO \} : \{\}/);
  assert.equal(m.FOLLOWUP_REPLY_TO, 'support@helm.events');
  assert.equal(m.FOLLOWUP_REASON, 'you started a free trial of Helm');
  assert.ok(!m.RETENTION_NOTICE_KINDS.some((k) => m.FOLLOWUP_KINDS.includes(k)));
});
t('F SQL: the old-studio guard, set once, additive, ASCII', () => {
  assert.match(MIG, /_trial_expired_at\(org\.id\) >= cfg\.starts_at/);
  assert.match(MIG, /insert into public\.helm_trial_followups\(id\) values \(true\) on conflict \(id\) do nothing/);
  const code = MIG.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  assert.ok(!/\b(drop\s+table|drop\s+column|truncate|delete\s+from)\b/i.test(code));
  assert.ok(!/create\s+temp/i.test(code), 'paste-safe');
  assert.ok(!/set_config|set\s+local/i.test(code), 'no session state');
  assert.ok(/^[\x00-\x7F]*$/.test(MIG)); assert.ok(/^[\x00-\x7F]*$/.test(APPLY));
  assert.equal((code.match(/security definer/g) || []).length, (code.match(/security definer set search_path = ''/g) || []).length);
});
t('F release files in step: MANIFEST after 0332, APPLY carries the migration verbatim in one transaction, suite and test wired', () => {
  assert.ok(MAN.indexOf('0332_r123a_hq_devices.sql') < MAN.indexOf('forward  supabase/migrations/0333_r124_trial_followup_emails.sql'));
  assert.ok(APPLY.includes(MIG));
  assert.ok(APPLY.indexOf('begin;\n') < APPLY.indexOf(MIG) && APPLY.indexOf(MIG) < APPLY.indexOf('commit;\n'));
  assert.ok(APPLY.indexOf('commit;\n') < APPLY.indexOf('-- VERIFY'));
  assert.match(APPLY, /STOP 0333/);
  assert.match(RUN, /R124-TRIAL-FOLLOWUPS-0333: ALL PASS/);
  assert.ok(PKG.includes('node test/r124-trial-followups.test.mjs'));
});
console.log(process.exitCode ? 'R124 FOLLOW-UPS: FAILED' : 'R124 FOLLOW-UPS: ALL PASS (' + n + ')');
