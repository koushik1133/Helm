// r23 (SQL 0257, owner decisions): the studio NAME and LINK are set once at sign-up and can't be changed by anyone in
// the studio; only Helm HQ (two-step, reason) changes them; look-alike / Helm-word links are never handed out.
// Static + VM checks of every app path that used to write the name / link, the HQ form, the e-mail, and the SQL shape.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const API = read('public/store-api.js'), CTL = read('public/control.html'), TD = read('public/trial-demo.js'), LOGIN = read('public/login.html');
const SF = read('public/signup-flow.js'), OBW = read('public/onboarding-wizard.js'), OBJ = read('public/onboarding.js'), HQ = read('public/hq.js');
const SQL = read('supabase/migrations/0257_studio_name_link.sql'), APPLY = read('supabase/APPLY-0257.sql');
const MAN = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh'), PKG = read('package.json');
const DOC = read('docs/security/STUDIO-URL-SECURITY.md');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const constSrc = (src, name) => { const at = src.indexOf(`const ${name} =`); assert.ok(at >= 0, name); return src.slice(at, src.indexOf(';\n', at) + 1); };

await t('Settings: studio name read-only with a lock + support note; the link is shown, never edited', () => {
  assert.match(CTL, /<input id="o_name" maxlength="120" autocomplete="organization" placeholder="e\.g\. Aurora Events" readonly aria-readonly="true" aria-describedby="o_name_lock">/);
  assert.match(CTL, /id="o_name_lock">Set when the studio was created\. Contact Helm support to change it\.<\/p>/);
  assert.match(CTL, /<h3 class="s-58d955e">Studio link <svg class="lock-ico"/);
  assert.match(CTL, /id="slugLock">Set when the studio was created\. Contact Helm support to change it\.<\/p>/);
  assert.doesNotMatch(CTL, /id="o_slug"|o_slug_save|links\.rename|set_studio_link_name/, 'no link editor left');
});

await t('Settings: the General save never sends the studio name', () => {
  const save = CTL.slice(CTL.indexOf('$("#o_save").addEventListener("click"'));
  assert.match(save, /const patch=\{ business_email:/);
  assert.doesNotMatch(save.slice(0, save.indexOf('BPStore.org.save(patch)')), /name:ccv\(|patch\.name=/);
  assert.match(save, /HelmCCInputs\.first\(\[G\.email,G\.phone,G\.logo,G\.accent,G\.currency,G\.tz,G\.tax\]\)/);
});

await t('onboarding: studio step shows the name read-only and never sends it', () => {
  assert.match(OBW, /return \{ business_email: d\.email \|\| null,/);
  assert.doesNotMatch(fnSrc(OBW, 'studioPatch'), /name:/);
  assert.match(OBJ, /ro: 1, hint: "Set when the studio was created\. Contact Helm support to change it\."/);
  assert.match(OBJ, /\$\{o\.ro \? ' readonly aria-readonly="true"' : ""\}/);
});

await t('trial welcome: name shown read-only, the studio\'s own name is sent (the server refuses any other)', () => {
  assert.match(TD, /const fn = field\("tdw_name", "Studio name", "text", t\.name \|\| "", "Set when the studio was created\. Contact Helm support to change it\."\);/);
  assert.match(TD, /fn\.input\.readOnly = true;/);
  assert.match(TD, /const name = String\(t\.name \|\| ""\)\.trim\(\), city = fc\.input\.value\.trim\(\)/);
  assert.doesNotMatch(TD, /Give it your name/);
});

await t('sign-up: no Google-name pre-fill; the studio step says the name + link can\'t be changed later', () => {
  assert.doesNotMatch(fnSrc(LOGIN, 'showOnboarding'), /meta\.full_name/);
  assert.match(LOGIN, /<span id="ob_lock">This name and your link <span id="ob_slug2">helm\.events\/studio<\/span> can't be changed later &mdash; please use your business name\.<\/span>/);
  assert.match(SF, /var paint = function \(t\) \{ out\.textContent = t; var o2 = \$\("#ob_slug2"\); if \(o2\) o2\.textContent = t; \};/);
});

await t('store-api: no app rename; bell + audit wording for Helm changes', () => {
  assert.doesNotMatch(API, /rpc\("set_studio_link_name"/);
  assert.match(API, /studio_identity_changed: \["🏷️", String\(d\.label \|\| "Helm support changed your studio name or link"\)\]/);
  const ctx = {};
  vm.runInNewContext([constSrc(API, 'AUDIT_AREA_LABELS'), constSrc(API, 'AUDIT_CLIENT_ACTIONS'),
    ...['auditHuman', 'auditAreaLabel', 'auditActionLabel', 'auditEventText', 'auditDescribe'].map((f) => fnSrc(API, f)),
    'globalThis.X={auditActionLabel,auditDescribe};'].join('\n'), ctx);
  assert.equal(ctx.X.auditActionLabel('studio.link_renamed'), 'Link changed');
  assert.equal(ctx.X.auditDescribe({ action: 'studio.link_renamed', changed: { from: 's-koushik', to: 'sparkle-events' } }), 'Studio link changed from s-koushik to sparkle-events (old links keep working)');
});

await t('HQ: "Change studio name / link" - live check, reason, confirm old -> new, server call', () => {
  const f = fnSrc(HQ, 'identityBox');
  assert.match(f, /call\("hq_studio_link_check", \{ p_org: org, p_slug: v \}\)/);
  assert.match(f, /if \(r\.length < 10\) \{ showErr\(\{ message: "Give a reason of at least 10 characters\." \}\)/);
  assert.match(f, /"Link: helm\.events\/" \+ \(d\.slug \|\| "-"\) \+ " -> helm\.events\/" \+ l \+ " \(old links keep working\)"/);
  assert.match(f, /call\("hq_set_studio_identity", \{ p_org: org, p_name: /);
  assert.match(HQ, /wrap\.appendChild\(identityBox\(org, d\)\);/);
});

await t('e-mail to the studio admins (comms-dispatch helm-notices)', async () => {
  const m = await import(new URL('../supabase/functions/comms-dispatch/helm-notices.mjs', import.meta.url));
  assert.ok(m.NOTICE_KINDS.includes('studio_identity') && m.NOTICE_TX_REASON.studio_identity);
  const e = m.helmNoticeEmail('studio_identity', { name_from: 'S Koushik', name_to: 'Sparkle Events', link_from: 's-koushik', link_to: 'sparkle-events' }, 'https://www.helm.events');
  assert.equal(e.subject, 'Helm support changed your studio name and link');
  assert.match(e.text, /Studio link: helm\.events\/s-koushik -> helm\.events\/sparkle-events/);
  assert.match(e.text, /keep working/);
  assert.equal(m.helmNoticeEmail('studio_identity', { name_to: 'X', link_to: 'Bad Link' }, ''), null, 'bad data -> skipped');
  assert.equal(m.helmNoticeEmail('studio_identity', { name_from: 'A', name_to: 'A', link_from: 'a-b', link_to: 'a-b' }, ''), null, 'nothing changed -> skipped');
});

await t('SQL 0257: lock by JWT role, HQ-only path (aal2 + reason + flag), look-alikes, audit, no drops / deletes', () => {
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bdrop\s+table\b|\bdelete\s+from\b|\btruncate\b|\bdrop\s+function\b|\bdrop\s+policy\b|\bdrop\s+column\b/i);
  assert.match(code, /declare v_role text := coalesce\(auth\.jwt\(\) ->> 'role', ''\);/);
  assert.match(code, /if v_role not in \('authenticated', 'anon'\) then return new; end if;/);
  assert.match(code, /create trigger aa_r23_org_identity_lock before update of name, public_slug on public\.organizations/);
  assert.match(code, /if v_me is null or not public\.is_platform_admin\(\) or v_aal <> 'aal2' then/);
  assert.match(code, /perform set_config\('helm\.r23_identity', txid_current\(\)::text \|\| ':' \|\| p_org::text, true\);/);
  assert.match(code, /perform public\._hq_wgate\('hq\.studio\.identity'/);
  assert.match(code, /create or replace function public\.studio_slug_free\(p_slug text, p_org uuid\)/);
  assert.match(code, /execute 'revoke all on function public\.set_studio_link_name\(text\) from authenticated'/);
  assert.doesNotMatch(code, /function public\.set_studio_identity|function public\.studio_link_name_check/);
  assert.ok(/^[\x00-\x7f]*$/.test(SQL), 'ASCII only');
});

await t('APPLY-0257 + MANIFEST + run-all + npm test + owner doc', () => {
  assert.match(APPLY, /^-- APPLY-0257\.sql/); assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /\ncommit;\n/);
  assert.ok(APPLY.includes(SQL.trim()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /select item, ok from \(values/);
  assert.ok(/^[\x00-\x7f]*$/.test(APPLY), 'ASCII only');
  assert.match(MAN, /\nforward  supabase\/migrations\/0257_studio_name_link\.sql\n/);
  assert.match(RUNALL, /run "r23-studio-name-0257" "R23-STUDIO-NAME-0257: ALL PASS \\\(41\/41\\\)"/);
  assert.match(PKG, /node test\/r23-studio-name\.test\.mjs/);
  assert.ok(existsSync(new URL('../docs/security/STUDIO-URL-SECURITY.md', import.meta.url)));
  assert.match(DOC, /impersonat/i); assert.match(DOC, /look-alike/i);
});

console.log(`r23-studio-name: ${n} passed`);
