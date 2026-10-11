// Owner: Nurture templates were missing occasions. Library: short + long per occasion, owner's
// placeholders, country-aware festivals, no currency / prices, test previews + self-only test send,
// auto-capable occasions seeded fill-only in 0105 with server-fillable placeholders only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const T = require('../public/nurture-templates.js');
const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const keys = T.LIBRARY.map((x) => x.key);

t('every requested occasion exists', () => {
  for (const k of ['birthday', 'anniversary', 'corporate_annual_day', 'annual_day_wishes', 'client_anniversary', 'new_year', 'diwali', 'holi', 'ramadan', 'eid',
    'christmas', 'raksha_bandhan', 'dussehra', 'uae_national_day', 'post_event_thanks', 'feedback_request', 'quote_followup', 'payment_reminder',
    'referral_request', 're_engagement', 'wedding_season']) assert.ok(keys.includes(k), k);
  assert.equal(new Set(keys).size, keys.length, 'unique keys');
});
t('each has a short and a long (subject + body) variant', () => {
  for (const x of T.LIBRARY) { assert.ok(x.short && x.short.length < 320, x.key + ' short'); assert.ok(x.subject && x.body && x.body.length > x.short.length - 40, x.key + ' long'); }
});
t('owner placeholders are used and render; old {{name}} / {{studio}} and single braces still work', () => {
  const all = T.LIBRARY.map((x) => x.short + x.subject + x.body).join(' ');
  for (const p of ['client_name', 'studio_name', 'event_date', 'planner_name', 'phone']) assert.ok(all.includes('{{' + p + '}}'), p);
  const d = { client_name: 'Asha', studio_name: 'Bloom', event_date: '28 Dec 2026', planner_name: 'Ravi', phone: '+91 98765 43210' };
  assert.equal(T.render('Hi {{client_name}} / {{name}} / {client_name} from {{studio}} on {{event_date}}', d), 'Hi Asha / Asha / Asha from Bloom on 28 Dec 2026');
  assert.equal(T.render('{{unknown}} stays', d), '{{unknown}} stays');
  for (const x of T.LIBRARY) for (const s of [x.short, x.subject, x.body]) assert.doesNotMatch(T.render(s, T.sample('IN')), /\{\{/, x.key);
});
t('no prices / currency symbols / promises of discounts', () => {
  for (const x of T.LIBRARY) for (const s of [x.short, x.subject, x.body]) {
    assert.doesNotMatch(s, /₹|Rs\.?\s?\d|AED|\$\s?\d|INR|\d+\s?%|discount|free of charge|guarantee/i, x.key);
  }
});
t('country-aware: festivals per country', () => {
  const k = (cc) => T.forCountry(cc).map((x) => x.key);
  assert.ok(k('IN').includes('holi') && k('IN').includes('diwali') && !k('IN').includes('uae_national_day'));
  assert.ok(k('AE').includes('uae_national_day') && k('AE').includes('eid') && k('AE').includes('ramadan') && !k('AE').includes('holi'));
  assert.ok(!k('US').includes('holi') && !k('US').includes('uae_national_day') && k('US').includes('christmas'));
  assert.match(T.sample('AE').phone, /^\+971 /); assert.match(T.sample('US').phone, /^\+1 /); assert.equal(T.sample('IN').client_name, 'Test client');
});
t('auto-capable templates only use what the server greeting job fills', () => {
  const auto = T.LIBRARY.filter((x) => x.auto); assert.equal(auto.length, 14);
  for (const x of auto) assert.ok(T.serverSafe(x), x.key);
  assert.equal(T.toServer('{{client_name}} {{studio_name}}'), '{{name}} {{studio}}');
});
t('0105 seed text equals the library (server form), fill-only', () => {
  const sql = read('supabase/migrations/0105_checkout_shortage_nurture.sql');
  for (const x of T.LIBRARY.filter((y) => y.auto)) {
    assert.ok(sql.includes('($t$' + x.auto + '$t$, $t$' + T.toServer(x.subject) + '$t$, $t$' + T.toServer(x.body) + '$t$)'), x.key);
  }
  assert.match(sql, /on conflict \(org_id, occasion_type\) do nothing;/);
  assert.doesNotMatch(sql, /update public\.nurture_templates/);
});
t('upcoming birthdays / anniversaries in the next 30 days (year roll-over, Feb 29)', () => {
  const rows = [{ id: 1, name: 'A', birthday: '1990-12-30' }, { id: 2, name: 'B', anniversary: '2016-01-05' }, { id: 3, name: 'C', birthday: '1985-03-01' },
    { id: 4, name: 'D', anniversary: '2020-02-29' }];
  const u = T.upcoming(rows, '2026-12-20', 30);
  assert.deepEqual(u.map((x) => [x.name, x.kind, x.date, x.inDays]), [['A', 'birthday', '2026-12-30', 10], ['B', 'anniversary', '2027-01-05', 16]]);
  assert.equal(u[1].years, 11);
  assert.equal(T.nextOccurrence('2020-02-29', '2027-02-01').date, '2027-02-28');
});
t('nurture page: library card, preview with test data, self-only WhatsApp test, never auto-sends', () => {
  const h = read('public/nurture.html');
  assert.match(h, /<script src="nurture-templates\.js\?v=1"><\/script>/);
  assert.match(h, /id="libCard"/); assert.match(h, /Copy test message/); assert.match(h, /WhatsApp a test to me/);
  assert.match(h, /BPStore\.waNumber\(ME&&\(ME\.whatsapp\|\|ME\.phone\)\)/, 'test goes to the signed-in user only');
  assert.doesNotMatch(h.slice(h.indexOf('message library (0105)')), /nurture\.greet\(|runAuto\(/);
  assert.match(h, /value="corporate_annual_day"/); assert.match(h, /value="client_anniversary"/);
});
t('leads hold optional birthday / anniversary (sent only when set)', () => {
  const l = read('public/leads.html');
  assert.match(l, /id="f_bday" type="date"/); assert.match(l, /id="f_anniv" type="date"/);
  assert.match(l, /if\(bd \|\| \(cur&&cur\.birthday\)\) patch\.birthday=bd;/);
});

let pass = 0, fail = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + e.message); } }
console.log(`\nnurture-templates: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
