// Round 21 - reserved e-mail domains (0248). Owner: "Someone signed up as anil@helm.events. We don't want ANYONE
// signing up with helm.events."
//  1. shared rule (edge functions): helm.events / helm.com + sub-domains, case / spaces / trailing dot, no false hits
//  2. store-api.js: the same rule (parity), wired into sign-up, change e-mail, invite, temp-password user, direct
//     invite sign-up, the OAuth / link return ("reserved_domain") and friendlyError
//  3. login.html: early inline message in sign-up mode only (staff still sign in), reserved_domain link error
//  4. edge functions: invite-signup + invite-mailer ask the database first, never create a reserved login
//  5. migration 0248 / APPLY-0248: hook shape + grants, backstop triggers, HQ functions audited, additive only
//  6. HQ "Staff access" tab
// The behaviour in the database is proven by tests/db/r21-reserved-domain-0248.sql (42 checks).
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { RESERVED_EMAIL_DOMAINS, RESERVED_EMAIL_MESSAGE, normEmail, reservedDomainOf, isReservedEmail } from "../supabase/functions/_shared/reserved-email.mjs";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + " missing");
  let i = src.indexOf("{", src.indexOf(")", at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + " unterminated");
};
const SA = r("public/store-api.js"), LOGIN = r("public/login.html"), HQH = r("public/hq.html"), HQJ = r("public/hq.js");
const IS = r("supabase/functions/invite-signup/index.ts"), IM = r("supabase/functions/invite-mailer/index.ts");
const MIG = r("supabase/migrations/0248_reserved_email_domains.sql"), APPLY = r("supabase/APPLY-0248.sql");
const MAN = r("supabase/migrations/MANIFEST"), DIS = r("supabase/R21-RESERVED-DOMAIN-DISABLE.sql"), REP = r("supabase/R21-RESERVED-DOMAIN-REPORT.sql");

const BLOCK = ["anil@helm.events", "ANIL@HELM.EVENTS", "  anil@Helm.Events.  ", "x@team.helm.events", "a@helm.com", "a@mail.helm.com",
  "admin+x@helm.events", '"a@gmail.com"@helm.events', "anil@helm.events.."];
const PASS = ["anil@gmail.com", "owner@studio.in", "anil@helm.events.example.com", "anil@nothelm.events", "anil@helm.eventsx",
  "helm.events@gmail.com", "a@helmevents.com", "", null, "no-at-sign", "@helm.events"];

await t("1a shared rule: reserved domains + sub-domains + case/space/trailing-dot tricks are caught", () => {
  assert.deepEqual([...RESERVED_EMAIL_DOMAINS], ["helm.events", "helm.com"]);
  for (const e of BLOCK) assert.ok(reservedDomainOf(e), "should block " + e);
  for (const e of PASS) assert.equal(reservedDomainOf(e), "", "should pass " + e);
  assert.equal(normEmail(" Anil@HELM.events. "), "anil@helm.events");
  assert.equal(RESERVED_EMAIL_MESSAGE, "Addresses on helm.events are reserved for the Helm team. Please use your own e-mail address.");
});
await t("1b shared rule: the database answer wins; any error falls back to the static list (fails closed)", async () => {
  const db = (data, error) => ({ rpc: async (fn, args) => { assert.equal(fn, "email_is_reserved"); assert.equal(args.p_email, "staff@helm.events"); return { data, error }; } });
  assert.equal(await isReservedEmail(db(false, null), " Staff@helm.events "), false);        // allowlisted staff
  assert.equal(await isReservedEmail(db(true, null), "staff@helm.events"), true);
  assert.equal(await isReservedEmail(db(null, { message: "function does not exist" }), "staff@helm.events"), true);
  assert.equal(await isReservedEmail({ rpc: async () => { throw new Error("network"); } }, "x@helm.com"), true);
  assert.equal(await isReservedEmail(null, "x@gmail.com"), false);
  assert.equal(await isReservedEmail({ rpc: async () => ({ data: true, error: null }) }, "look@helm-events.com"), true);   // HQ look-alike
});

await t("2a store-api: same rule as the shared module (parity)", () => {
  const ctx = {}; vm.runInNewContext('const RESERVED_EMAIL_DOMAINS = ["helm.events", "helm.com"];\n' + fnSrc(SA, "reservedEmailDomain") + "\nglobalThis.f = reservedEmailDomain;", ctx);
  for (const e of BLOCK.concat(PASS)) assert.equal(ctx.f(e), reservedDomainOf(e), String(e));
  assert.ok(SA.includes('const RESERVED_EMAIL_MESSAGE = "' + RESERVED_EMAIL_MESSAGE + '"'));
  assert.ok(/const BPStore = \{\s*reservedEmailDomain, RESERVED_EMAIL_MESSAGE,/.test(SA), "exported on BPStore");
});
await t("2b store-api: every way to make or rename a login checks first", () => {
  const signUp = SA.slice(SA.indexOf("async signUp(email, password, opts)"), SA.indexOf("async signInWithGoogle("));
  assert.ok(signUp.indexOf("reservedEmailDomain(email)") > 0 && signUp.indexOf("reservedEmailDomain(email)") < signUp.indexOf("supa.auth.signUp("), "before signUp");
  assert.ok(signUp.includes("if (isReservedRefusal(error)) throw reservedEmailError();"), "server refusal mapped");
  const ce = SA.slice(SA.indexOf("async changeEmail(newEmail)"), SA.indexOf("async passwordChangeRequired()"));
  assert.ok(ce.indexOf("reservedEmailDomain(em)") < ce.indexOf("supa.auth.updateUser("), "change e-mail");
  const tmp = SA.slice(SA.indexOf("async createUserTemp(email, role)"), SA.indexOf("async setRole(id, role)"));
  assert.ok(tmp.indexOf("reservedEmailDomain(email)") < tmp.indexOf("admin_create_user_temp"), "temp-password user");
  assert.ok(/create: \(email, role\) => \(reservedEmailDomain\(email\) \? Promise\.reject\(reservedEmailError\(\)\)/.test(SA), "invitation");
  const sd = SA.slice(SA.indexOf("async signupDirect(token, email, password, fullName)"), SA.indexOf("async openForEmail("));
  assert.ok(sd.indexOf("reservedEmailDomain(email)") < sd.indexOf("fetch("), "direct invite sign-up");
});
await t("2c store-api: a Google / link sign-up refused by the hook comes back as the fixed code reserved_domain", () => {
  const i = SA.indexOf('urlAuthError = qs.get("error_code") || qs.get("error") || "";');
  const blk = SA.slice(i, i + 600);
  assert.ok(/reserved for the helm team\/i\.test\(String\(qs\.get\("error_description"\)/.test(blk) && blk.includes('urlAuthError = "reserved_domain"'));
});
await t("2d friendlyError shows the reserved message (client check or server refusal)", () => {
  const fe = fnSrc(SA, "friendlyError");
  assert.ok(fe.includes('e.code === "reserved_domain" || /reserved for the helm team/i.test(errMsg(e) || "")'));
  assert.ok(fe.includes("global.BPStore.RESERVED_EMAIL_MESSAGE"), "message from BPStore (other IIFE)");
});

await t("3 login.html: inline message only in sign-up mode; link error + direct invite + submit catch show it", () => {
  const ep = fnSrc(LOGIN, "emailProblem");
  assert.ok(ep.includes('mode==="signup" && window.BPStore && BPStore.reservedEmailDomain && BPStore.reservedEmailDomain(e) && !HQ_PRE[e]) return BPStore.RESERVED_EMAIL_MESSAGE'));   // r27: pre-authorised HQ staff pass
  assert.ok(LOGIN.includes('if(le==="reserved_domain"){'));
  assert.ok(LOGIN.includes("bad_email|reserved_domain)$/.test(x.code"));
  assert.ok(LOGIN.includes('err.code==="captcha_failed"||err.code==="reserved_domain"'));
});

await t("4 edge functions: database first, then the static list; never create a reserved login", () => {
  assert.ok(IS.includes('import { isReservedEmail, RESERVED_EMAIL_MESSAGE } from "../_shared/reserved-email.mjs";'));
  const main = IS.slice(IS.indexOf('const bound = String(inv.email ?? "").trim().toLowerCase();'));
  const chk = main.indexOf("if (await isReservedEmail(admin, bound)) return json({ error: RESERVED_EMAIL_MESSAGE, code: \"reserved_domain\" }, 403);");
  assert.ok(chk > 0 && chk < main.indexOf("if (resend) {") && chk < main.indexOf("admin.auth.admin.createUser("), "before resend + createUser");
  assert.ok(main.indexOf("if (peek) {") < chk, "peek still answers (the page can show the locked address)");
  const be = IS.slice(IS.indexOf("async function byEmail("), IS.indexOf("Deno.serve("));
  const bi = be.indexOf("isReservedEmail(admin, email)");
  assert.ok(bi > 0 && bi < be.indexOf("inviteUserByEmail("), "byEmail (lookup / send) before any invite");
  const sv = IM.slice(IM.indexOf("async function sendViaSupabaseAuth("), IM.indexOf("async function sendBranded("));
  assert.ok(sv.indexOf('if (await isReservedEmail(admin, to)) return "skipped";') < sv.indexOf("inviteUserByEmail("));
});

await t("5a migration 0248: hook + backstops + HQ, additive only, in MANIFEST", () => {
  assert.ok(MAN.includes("forward  supabase/migrations/0248_reserved_email_domains.sql"));
  assert.ok(/create or replace function public\.hook_before_user_created\(event jsonb\)\s*returns jsonb/.test(MIG));
  assert.ok(MIG.includes("jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', public._r248_message(v_email)))"));
  assert.ok(MIG.includes("grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin"));
  for (const role of ["anon", "authenticated", "service_role"]) assert.ok(MIG.includes(`revoke all on function public.hook_before_user_created(jsonb) from ${role}`), role);
  assert.ok(MIG.includes("create trigger a248_reserved_email_guard before insert or update of email, email_change on auth.users"));
  assert.ok(MIG.includes("create trigger a248_reserved_email_guard before insert or update of email on public.invitations"));
  for (const f of ["hq_staff_allow_add", "hq_staff_allow_remove", "hq_reserved_domain_add", "hq_reserved_domain_remove"])
    assert.ok(new RegExp(`function public\\.${f}\\([^)]*\\)[\\s\\S]{0,400}perform public\\._hq_wgate\\(`).test(MIG), f + " audited write gate");
  assert.ok(/perform public\._hq_gate\('hq_staff_access'\)/.test(MIG));
  assert.ok(!/\b(delete\s+from|drop\s+table|truncate|drop\s+function|alter\s+table\s+\S+\s+drop)\b/i.test(MIG.replace(/^\s*--.*$/gm, "")), "no destructive statement");
  assert.ok(/on conflict \(domain\) do nothing/.test(MIG) && /on conflict \(email\) do nothing/.test(MIG), "seeds idempotent");
  assert.ok(!/[^\x00-\x7F]/.test(MIG) && !/[^\x00-\x7F]/.test(APPLY) && !/[^\x00-\x7F]/.test(DIS) && !/[^\x00-\x7F]/.test(REP), "ASCII only");
});
await t("5b APPLY-0248 = begin + the migration body + commit + VERIFY; owner steps name the Dashboard switch", () => {
  const body = MIG.split("-- VERIFY (read-only): every row must say ok = true\n")[0].trimEnd();
  assert.ok(APPLY.includes("begin;\n" + body + "\n\nnotify pgrst, 'reload schema';\ncommit;"), "APPLY body matches the migration");
  assert.ok(APPLY.includes("-- VERIFY (every row must say ok = true)"));
  assert.ok(APPLY.includes('Authentication -> Hooks') && APPLY.includes('"Before User Created"') && APPLY.includes('"hook_before_user_created"'));
});
await t("5c owner scripts: report is read-only; disable is explicit-list, protected, reversible, no delete", () => {
  assert.ok(!/\b(update|insert|delete|alter|drop|truncate)\b/i.test(REP.replace(/^\s*--.*$/gm, "").replace(/raise exception '[^']*'/g, "")), "report read-only");
  assert.ok(DIS.includes("v_targets text[] := array["));
  assert.ok(DIS.includes("'admin@helm.events', 'security@helm.events') then raise exception 'STOP: % is protected'"));
  assert.ok(DIS.includes("is an HQ operator") && DIS.includes("is on the staff allowlist"));
  assert.ok(DIS.includes("banned_until = timestamptz ''2999-12-31 00:00:00+00''") && DIS.includes("banned_until is null"));
  assert.ok(DIS.includes("-- UNDO") && !/\bdelete\s+from\b/i.test(DIS));
});

await t("6 HQ Staff access tab: operators-only RPCs, add / remove / reserve, existing logins read-only", () => {
  assert.ok(HQH.includes('id="tab-staff"') && HQH.includes('id="pane-staff" hidden'));
  for (const id of ["stAllow", "stEmail", "btnStAdd", "stDomains", "stDomain", "btnStDom", "tStAcc"]) assert.ok(HQH.includes(`id="${id}"`), id);
  assert.ok(HQJ.includes('"activity", "staff"]'));
  for (const fn of ["hq_staff_access", "hq_staff_allow_add", "hq_staff_allow_remove", "hq_reserved_domain_add", "hq_reserved_domain_remove"])
    assert.ok(HQJ.includes(`call("${fn}"`), fn);
  assert.ok(!/innerHTML/.test(fnSrc(HQJ, "loadStaff")), "textContent / createElement only");
});

console.log(`r21-reserved-domain: ${n} checks passed`);
