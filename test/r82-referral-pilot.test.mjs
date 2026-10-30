// r82 (0306): referral PILOT - one studio on while the global switch stays OFF. Static checks of the migration, the
// paste files, the UI wiring and the "You were referred by <studio>" banner (textContent only, strict CSP).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const mig = read("supabase/migrations/0306_r82_referral_pilot.sql");
const apply = read("supabase/APPLY-0306.sql"), enable = read("supabase/APPLY-0306-ENABLE-HELM-STUDIO.sql");
for (const [n, s] of [["0306", mig], ["APPLY-0306", apply], ["ENABLE", enable]]) assert.doesNotMatch(s, /[^\x00-\x7F]/, n + " is ASCII");
// additive + idempotent: a column with a default, no drop / delete / truncate
assert.match(mig, /add column if not exists pilot_org_ids uuid\[\] not null default '\{\}'::uuid\[\]/);
assert.doesNotMatch(mig, /\b(drop\s+(table|column|function)|delete\s+from|truncate)\b/i, "nothing dropped or deleted");
// old bodies kept once as __pre0306
for (const f of ["my_referral(text)", "_r29_code_problem(public.referral_codes)", "referral_attach(text,text,timestamptz,boolean,text)", "referral_lookup(text)"])
  assert.ok(mig.includes("'public." + f + "'"), "keeps " + f);
assert.match(mig, /__pre0306/);
// the gates: per studio for the page + codes, any-pilot for attach / look-up; partner codes need the switch
assert.match(mig, /if not public\._r29_on_for\(v_org\) then return jsonb_build_object\('program_on', false\)/);
assert.match(mig, /_r29_on_for\(case when c\.kind = 'studio' then c\.studio_id end\)/);
assert.match(mig, /if not public\._r29_any_on\(\) then return jsonb_build_object\('ok', false, 'reason', 'off'\)/);
assert.match(mig, /'referrer', case when c\.kind = 'studio' then/);
// the reward rules are not re-issued (hold / cap / qualify / tick untouched)
for (const f of ["_r29_on_payment", "_r29_qualify", "referral_tick", "_r29_attach(", "_r29_add_reward"])
  assert.ok(!new RegExp("create or replace function public\\." + f.replace("(", "\\(")).test(mig), f + " untouched");
// helpers internal only
assert.match(mig, /'public\._r29_pilot\(uuid\)', 'public\._r29_on_for\(uuid\)', 'public\._r29_any_on\(\)'/);
// paste files: transaction + STOP + VERIFY; enable finds by slug, exactly one, never touches program_on
assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /VERIFY/);
assert.ok(apply.includes(mig.trim().split("\n").slice(0, 5).join("\n")), "APPLY-0306 embeds the migration");
assert.match(enable, /^begin;$/m); assert.match(enable, /^commit;$/m);
assert.match(enable, /where slug = 'helm-studio'/);
assert.match(enable, /if n <> 1 then raise exception 'STOP/);
assert.doesNotMatch(enable, /set\s+program_on/i, "the global switch is never touched");
// MANIFEST + DB suite wired
assert.match(read("supabase/migrations/MANIFEST"), /^forward  supabase\/migrations\/0306_r82_referral_pilot\.sql$/m);
assert.match(read("scripts/db-test/run-all.sh"), /r82-referral-pilot-0306\.sql/);
// UI: banner names the referrer with textContent; pilot note; no inline script / style added
const sj = read("public/referral-signup.js");
assert.match(sj, /bT\.textContent = hit\.referrer \? "You were referred by " \+ hit\.referrer : "A Helm studio invited you"/);
assert.match(sj, /referrer: r\.kind === "partner" \? "" :/);
assert.doesNotMatch(sj, /innerHTML/);
const rh = read("public/refer.html"), rj = read("public/refer.js");
assert.match(rh, /id="rfPilot"[^>]*hidden/);
assert.match(rj, /if \(r\.pilot\)/);
assert.doesNotMatch(rh.replace(/<style id="bp-auth-gate">[^<]*<\/style>/, ""), /<style|style="|<script>(?!<\/script>)/, "no new inline style / script");
assert.match(rh, /refer\.js\?v=4/); assert.match(read("public/login.html"), /referral-signup\.js\?v=4/);
// share links only open the user's own app (no auto-send, no Helm-side message)
assert.match(rj, /"https:\/\/wa\.me\/\?text=" \+ encodeURIComponent\(msg\)/);
assert.match(rj, /"mailto:\?subject="/);
console.log("r82-referral-pilot: ok");
