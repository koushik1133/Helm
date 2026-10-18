// auth-confirm (0205): every auth e-mail link opens on www.helm.events/auth/confirm (never the Supabase
// project URL). Pure parser: only the six e-mail types, a token-hash shape, and `next` only as a
// same-origin path (no open redirect). Page: external scripts only, token stripped from the address
// bar, never swaps a signed-in account without asking, keeps a sign-up session only in the browser
// that started it.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../public/auth-confirm-core.js");
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };
const O = "https://www.helm.events", H = "f".repeat(56), INV = "a1".repeat(24);
const q = (type, next, hash = H) => "?token_hash=" + hash + "&type=" + type + (next === undefined ? "" : "&next=" + next);

t("only the six e-mail link types", () => {
  for (const ty of ["invite", "magiclink", "recovery", "signup", "email", "email_change"]) assert.equal(C.parse(q(ty), O).ok, true, ty);
  for (const ty of ["", "sso", "phone_change", "INVITE'", "recovery%00"]) assert.equal(C.parse(q(ty), O).ok, false, ty);
  assert.equal(C.parse(q("Invite"), O).type, "invite", "case-insensitive");
});
t("token hash shape enforced", () => {
  assert.equal(C.parse(q("invite", undefined, "pkce_" + H), O).ok, true);
  for (const h of ["", "short", "a b c d e f g h", "<script>xxxxxxxx", "x".repeat(300)]) assert.equal(C.parse(q("invite", undefined, encodeURIComponent(h)), O).ok, false, h);
});
t("next: same-origin paths kept (encoded or raw {{ .RedirectTo }})", () => {
  assert.equal(C.parse(q("invite", encodeURIComponent("/login?invite=" + INV)), O).next, "/login?invite=" + INV);
  assert.equal(C.parse(q("invite", O + "/login?invite=" + INV), O).next, "/login?invite=" + INV, "raw absolute same origin");
  assert.equal(C.parse(q("email", O + "/login.html?next=quotes&invite=" + INV), O).next, "/login.html?next=quotes&invite=" + INV, "raw & kept: next is last");
  assert.equal(C.parse(q("email", encodeURIComponent(O + "/login.html?next=quotes&invite=" + INV)), O).next, "/login.html?next=quotes&invite=" + INV);
  assert.equal(C.parse(q("invite", O + "/login?invite=" + INV), O).invite, INV);
  assert.equal(C.parse(q("email", O + "/login.html?next=q&invite=" + INV), O).invite, INV);
});
t("next: open redirects rejected (falls back to the sign-in page)", () => {
  for (const bad of ["https://evil.example/login", "http://www.helm.events/login", "https://www.helm.events.evil.example/x", "//evil.example/x",
    "%2F%2Fevil.example", "/\\evil.example", "%2F%5Cevil.example", "javascript:alert(1)", "JaVaScRiPt%3Aalert(1)", "data:text/html,x",
    "evil.example", "/auth/confirm?token_hash=x&type=invite", "%2Fauth-confirm", "/login%0d%0aSet-Cookie:x", ""]) {
    const p = C.parse(q("invite", bad), O);
    assert.equal(p.ok, true); assert.equal(p.next, "/login", bad);
  }
  assert.equal(C.parse(q("magiclink", O), O).next, "/login", "bare Site URL → default");
  assert.equal(C.safePath("https://evil.example/x", O), null);
  assert.equal(C.safePath("/dashboard#x", O), "/dashboard");
});
t("recovery always lands on the reset page", () => {
  assert.equal(C.parse(q("recovery", encodeURIComponent("/dashboard")), O).next, "/reset-password?via=confirm");
  assert.equal(C.parse(q("recovery", "https://evil.example"), O).next, "/reset-password?via=confirm");
});
t("invite token only from /login?invite=<hex>", () => {
  assert.equal(C.inviteOf("/login?invite=" + INV), INV);
  assert.equal(C.inviteOf("/login?invite=nothex!"), null);
  assert.equal(C.inviteOf("/dashboard?invite=" + INV), null);
  assert.equal(C.withParam("/login?invite=" + INV, "error_code", "otp_expired"), "/login?invite=" + INV + "&error_code=otp_expired");
  assert.equal(C.withParam("/reset-password", "error_code", "x y"), "/reset-password?error_code=x%20y");
});
t("page: external scripts only, no-referrer, served at /auth/confirm (no-store, private)", () => {
  const html = r("public/auth-confirm.html");
  assert.ok(!/<script(?![^>]*src)[^>]*>/.test(html), "no inline script");
  assert.match(html, /<meta name="referrer" content="no-referrer">/);
  assert.match(html, /<script src="\/auth-confirm-core\.js\?v=\d+"><\/script>\s*<script src="\/auth-confirm\.js\?v=\d+"><\/script>/);
  assert.match(html, /<script src="\/store-api\.js\?v=\d+"><\/script>/, "absolute paths (the page lives under /auth/)");
  const v = JSON.parse(r("vercel.json"));
  assert.ok(v.rewrites.some((x) => x.source === "/auth/confirm" && x.destination === "/auth-confirm"));
  const h = v.headers.find((x) => x.source === "/auth/confirm");
  assert.ok(h && h.headers.some((x) => x.key === "Referrer-Policy" && x.value === "no-referrer") && h.headers.some((x) => x.key === "Cache-Control" && x.value === "no-store, private"));
  assert.match(r("server.js"), /if \(rel === '\/auth\/confirm'\) return serveFile\(res, req, path\.join\(PUBLIC_DIR, 'auth-confirm\.html'\)\)/);
});
t("handler: token out of the address bar, no silent account swap, sign-up session only where it started", () => {
  const js = r("public/auth-confirm.js");
  assert.match(js, /history\.replaceState\(null, "", location\.pathname\)/);
  const i = js.indexOf("if (cur) {"), j = js.indexOf("verify();", i);
  assert.ok(i > 0 && js.slice(i, j).includes('addEventListener("click"'), "signed in: verify only after 'Sign out and continue'");
  assert.match(js, /BPStore\.auth\.signupStartedHere\(user\.email\)\) \{ go\(link\.next\); return; \}/);
  assert.match(js, /markInviteLinkSession\(need\)/);
  assert.match(js, /a sign-in link with no invitation behind it[\s\S]{0,120}signOut\(\)/);
  assert.match(js, /go\(C\.withParam\(link\.next, "error_code", expired \? "otp_expired" : "link_failed"\)\)/);
  const api = r("public/store-api.js");
  assert.match(api, /supa\.auth\.verifyOtp\(\{ token_hash: String\(tokenHash \|\| ""\), type: type === "signup" \? "email" : type \}\)/);
  assert.match(api, /localStorage\.setItem\(SIGNUP_MARK_KEY/);
  assert.match(r("public/reset-password.js"), /qp\.get\("via"\) === "confirm"/);
});
t("e-mails never show the Supabase project URL", () => {
  for (const f of ["confirm-signup", "invite-user", "magic-link", "reset-password", "change-email"]) {
    const h = r("docs/ops/email-templates/" + f + ".html");
    assert.ok(!h.includes("ConfirmationURL") && !/supabase\.co/.test(h), f);
    assert.ok(h.includes("{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type="), f);
  }
  const fn = r("supabase/functions/invite-signup/index.ts");
  assert.match(fn, /\/auth\/confirm\?token_hash=\$\{encodeURIComponent\(hashedToken\)\}&type=\$\{type\}&next=\$\{encodeURIComponent\(next\)\}/);
  assert.ok(!/action_link/.test(fn.replace(/\/\/.*$/gm, "")), "the Supabase action_link is never mailed");
});
t("Outlook-safe button: VML + table cell with a real <a href>, plain URL line after", () => {
  const lay = r("supabase/functions/_shared/email-layout.mjs");
  assert.match(lay, /<!--\[if mso\]><v:roundrect[^>]*href="\$\{href\}"/);
  assert.match(lay, /<td align="center" bgcolor="\$\{C\.brand\}"[^>]*><a href="\$\{href\}" target="_blank"/);
  assert.ok(!/<!--\[if !mso\]>/.test(lay.slice(lay.indexOf("export function button"), lay.indexOf("export const fallback")).replace(/^\s*\/\/.*$/gm, "")), "no !mso wrapper");
  const inv = r("docs/ops/email-templates/invite-user.html");
  assert.match(inv, /Button not working\? Copy and paste this link/);
});
console.log(`auth-confirm: ${n} checks passed`);
