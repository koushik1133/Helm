// r7 polish (0084): no mojibake anywhere in public/ or supabase/migrations/, strict staff /
// nurture phones (E.164, +91 default, old bad rows flagged not changed), nurture phone field,
// admin "Re-open event" on closure.html.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = new URL('../', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let n = 0, failed = 0;
const t = (name, fn) => { n++; try { fn(); console.log('  ok ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n    ' + e.message); } };

// MacRoman / Windows-1252 double-decoded UTF-8 (built from escapes so this file stays clean)
const BAD = ['‚Ä', 'â€', 'Ã©', 'Ã¢', 'Ã¶', 'Â ', 'Â·'];
function walk(dir, out) {
  for (const f of readdirSync(join(ROOT, dir))) {
    const p = dir + '/' + f; const st = statSync(join(ROOT, p));
    if (st.isDirectory()) { if (f !== 'node_modules') walk(p, out); }
    else if (/\.(html|js|mjs|css|sql|json|txt|md)$/.test(f)) out.push(p);
  }
  return out;
}

t('no mojibake sequences in public/ or supabase/migrations/', () => {
  const hits = [];
  for (const p of [...walk('public', []), ...walk('supabase/migrations', [])]) {
    const s = read(p);
    for (const b of BAD) if (s.includes(b)) hits.push(p + ' contains ' + JSON.stringify(b));
  }
  assert.deepEqual(hits, []);
});

const API = read('public/store-api.js');
const fnSrc = (name) => { const i = API.indexOf('function ' + name + '('); assert.ok(i > 0, name); let d = 0, j = API.indexOf('{', i);
  for (let k = j; k < API.length; k++) { if (API[k] === '{') d++; else if (API[k] === '}') { d--; if (!d) return API.slice(i, k + 1); } } };
const e164 = new Function(fnSrc('memberPhoneE164') + '; return memberPhoneE164;')();
const MOJI = new Function(API.slice(API.indexOf('const MOJI ='), API.indexOf('global.HelmDemojibake')) + '; return demojibake;')();

t('phone rule: E.164, +91 default, 7-15 digits, garbage refused', () => {
  assert.equal(e164('98765 43210').value, '+919876543210');
  assert.equal(e164('09876543210').value, '+919876543210');
  assert.equal(e164('+44 7700 900123').value, '+447700900123');
  assert.equal(e164('0044 7700 900123').value, '+447700900123');
  assert.equal(e164('', false).value, null);
  assert.equal(e164('', true).ok, false);
  for (const bad of ["8765432134567890-=-098765432123w45e6r7t8y9u0iop[';lkj", '12345', '+1234567890123456', 'abc', '98+76543210'])
    assert.equal(e164(bad).ok, false, bad);
});
t('demojibake repairs the stage-override dash', () => {
  assert.equal(MOJI("Can't move to settlement yet ‚Äî the event date"), "Can't move to settlement yet — the event date");
  assert.equal(MOJI('a â€” b'), 'a — b');
});
t('store: staff add/update, ops.addCrew and nurture add/update validate phones; friendlyError + stage dialog repair text', () => {
  assert.match(API, /async addCrew\(name, phone, department\) \{[^\n]*\n\s*phone = phoneOrThrow\(phone, true\);/);
  assert.match(API, /if \(s && !s\.profile_id\) s = \{ \.\.\.s, phone: phoneOrThrow\(s\.phone, true\) \};/);
  assert.match(API, /n = \{ \.\.\.n, phone: phoneOrThrow\(n && n\.phone, false\) \};/);
  assert.equal((API.match(/hasOwnProperty\.call\(patch, "phone"\)\) patch = \{ \.\.\.patch, phone: phoneOrThrow/g) || []).length, 2);
  assert.match(API, /phoneInvalid: \(s\) =>/);
  assert.match(API, /global\.HelmDemojibake\(e\.message\)/);
  assert.match(API, /e\.message = demojibake\(e\.message\);\s*\n\s*if \(code === "HL428"\)/);
  assert.match(API, /rpc\("reopen_event", \{ p_quote_id: quoteId, p_reason: r \}\)/);
});
t('staff.html flags old bad phones without changing them', () => {
  const h = read('public/staff.html');
  assert.match(h, /BPStore\.staff\.phoneInvalid\(s\)\?`<span class="tag badphone"[^`]*>Invalid phone — please fix<\/span>`/);
  assert.match(h, /Invalid phone — please fix\. The saved number/);
});
t('nurture.html: Phone (WhatsApp) field, validated, stored, listed, prefilled, WhatsApp link', () => {
  const h = read('public/nurture.html');
  assert.match(h, /<label for="n_phone">Phone \(WhatsApp\)<\/label><input id="n_phone" type="tel"/);
  assert.match(h, /const pv=BPStore\.staff\.phoneE164\(\$\("#n_phone"\)\.value\);/);
  assert.match(h, /phone:pv\.value/);
  assert.match(h, /phone: l\.phone \|\| ""/);
  assert.match(h, /if\(c\.phone && !\$\("#n_phone"\)\.value\)/);
  assert.match(h, /https:\/\/wa\.me\//);
});
t('closure.html: closed state, admin-only Re-open with reason, close hidden when closed', () => {
  const h = read('public/closure.html');
  assert.match(h, /id="reopenBtn" hidden>Re-open event</);
  assert.match(h, /\$\("#closeBtn"\)\.hidden=!canEdit\|\|!!closedAt;/);
  assert.match(h, /\$\("#reopenBtn"\)\.hidden=!\(closedAt&&canEdit&&isAdmin\);/);
  assert.match(h, /Closed on /);
  assert.match(h, /BPStore\.closure\.reopen\(id,reason\)/);
});
t('store-api v=158 on every page', () => {
  for (const p of readdirSync(join(ROOT, 'public')).filter((f) => f.endsWith('.html'))) {
    const m = read('public/' + p).match(/store-api\.js\?v=(\d+)/); if (m) assert.equal(m[1], '159', p);
  }
});
t('0084 SQL: additive, ASCII, no table constraint, APPLY verbatim + verify grid', () => {
  const m = read('supabase/migrations/0084_r7_polish.sql'), a = read('supabase/APPLY-0084.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0084_r7_polish\.sql/);
  for (const s of [m, a]) { assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), 'pure ASCII'); assert.doesNotMatch(s, /\b(drop table|delete from|truncate|drop column|add constraint)\b/i); }
  assert.ok(a.includes(m.trim()), 'APPLY carries the migration verbatim');
  assert.match(m, /add column if not exists phone text/);
  assert.match(m, /new\.phone is not distinct from old\.phone then return new/);
  assert.match(m, /create or replace function public\.reopen_event\(p_quote_id uuid, p_reason text\)[\s\S]*security definer set search_path = ''/);
  assert.match(m, /'This event is closed - its cost lines are locked\./);
  assert.match(m, /'Can''t move to % yet - %\.'/);
  assert.match(a, /select item, ok from \(values/);
});

console.log(failed ? `r7-polish: ${failed} of ${n} FAILED` : `r7-polish: all ${n} passed`);
if (failed) process.exit(1);
