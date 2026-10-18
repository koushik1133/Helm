/* =========================================================================
   HelmCCInputs - Control Center field rules (Oct 2026 input sweep A).
   Sections: General (business e-mail, phone, tax ID / GSTIN, accent colour, logo URL,
   client link name), Hide amounts (privacy PIN), Client links & packages (day counts),
   Users & invites (e-mail, role, self / member / duplicate-invite checks).

   - Pure rule functions -> {ok, value, error}. They trim, drop zero-width characters
     that come with copy-paste, and normalise (lower-case e-mail, upper-case GSTIN,
     "#"-prefixed 6-digit colour). They never throw and work in Node (unit tests).
   - The message goes UNDER the field through the shared HelmValidate binder
     (form-validate.js): shown on blur, re-checked live once shown, red border +
     aria-invalid. A failed save never clears what the person typed.
   - bind*() helpers register the rules with HelmValidate and return its bindings.
   No innerHTML: DOM through HelmValidate (createElement + textContent).
   ========================================================================= */
(function (global) {
  "use strict";

  var HV = global.HelmValidate;
  if (!HV && typeof module !== "undefined" && typeof require === "function") { try { HV = require("./form-validate.js"); } catch (e) { HV = null; } }

  // zero-width / BOM / NBSP that ride along with copy-paste
  function unpaste(v) { return String(v == null ? "" : v).replace(/[​-‍⁠﻿]/g, "").replace(/ /g, " "); }
  function trim(v) { return unpaste(v).trim(); }
  function len(s) { return Array.from(String(s)).length; }
  function ok(v) { return { ok: true, value: v }; }
  function bad(e, v) { return v === undefined ? { ok: false, error: e } : { ok: false, error: e, value: v }; }
  var EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

  /* ---- e-mail ------------------------------------------------------------ */
  // "Name <a@b.com>", "mailto:a@b.com", trailing dots/commas from a pasted sentence are tidied;
  // spaces INSIDE the address are an error (we never guess which half the person meant).
  var EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;
  function email(v, o) {
    o = o || {};
    var s = trim(v);
    var ang = /<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(s); if (ang) s = ang[1];
    s = s.replace(/^mailto:/i, "").replace(/[.,;:]+$/, "").trim().toLowerCase();
    if (!s) return o.required ? bad("Please enter " + (o.who || "an") + " e-mail address.") : ok("");
    if (/\s/.test(s)) return bad("E-mail addresses can't contain spaces — check what was pasted.");
    if (EMOJI.test(s)) return bad("E-mail addresses can't contain emoji.");
    if (s.length > 254) return bad("That e-mail address is too long (254 characters at most).");
    if ((s.match(/@/g) || []).length !== 1) return bad("An e-mail address has exactly one @, like name@studio.com.");
    var local = s.split("@")[0];
    if (local.length > 64 || /\.\./.test(s) || /^\.|\.@/.test(s) || !EMAIL_RE.test(s)) return bad("Please enter an e-mail address like name@studio.com.");
    return ok(s);
  }

  /* ---- tax ID (GSTIN for India; others via BPStore.tax) ------------------- */
  function taxApi() { var B = global.BPStore; return B && B.tax && B.tax.validateId ? B.tax : null; }
  function gstin(v) {
    var s = trim(v).toUpperCase().replace(/[\s-]+/g, "");
    if (!s) return ok("");
    if (EMOJI.test(s) || !/^[0-9A-Z]+$/.test(s)) return bad("A GSTIN has only letters and numbers.", s);
    if (s.length !== 15) return bad("A GSTIN has exactly 15 characters — this one has " + s.length + ". Example: 36ABCDE1234F1Z5.", s);
    var st = s.slice(0, 2);
    if (!/^\d\d$/.test(st)) return bad("A GSTIN starts with the 2-digit state code, e.g. 36 for Telangana.", s);
    var sn = Number(st);
    if (!((sn >= 1 && sn <= 38) || sn === 97 || sn === 99)) return bad("The first 2 digits (" + st + ") aren't a state code — they run from 01 to 38.", s);
    if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(s.slice(2, 12))) return bad("Characters 3-12 of a GSTIN are the PAN (5 letters, 4 digits, 1 letter), e.g. ABCDE1234F.", s);
    if (s.charAt(13) !== "Z") return bad("The 14th character of a GSTIN is always Z.", s);
    if (!/^[1-9A-Z]$/.test(s.charAt(12))) return bad("The 13th character of a GSTIN is 1-9 or a letter.", s);
    return ok(s);
  }
  function taxId(v, cc) {
    cc = String(cc || "IN").toUpperCase();
    if (cc === "IN") return gstin(v);
    var s = trim(v).toUpperCase().replace(/\s+/g, "");
    if (!s) return ok("");
    if (EMOJI.test(s)) return bad("A tax ID can't contain emoji.", s);
    if (s.length > 30) return bad("That tax ID is too long (30 characters at most).", s);
    var T = taxApi();
    if (T) { var r = T.validateId(cc, s); return r.ok ? ok(r.value) : bad(r.error, s); }
    return /^[A-Z0-9 ./-]{3,30}$/.test(s) ? ok(s) : bad("Enter a valid tax ID (or leave it blank).", s);
  }

  /* ---- accent colour ------------------------------------------------------ */
  function accent(v) {
    var s = trim(v).replace(/\s+/g, "").toLowerCase();
    if (!s) return ok("");
    if (s.charAt(0) !== "#" && /^[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) s = "#" + s;
    if (/^#[0-9a-f]{8}$/.test(s) || /^#[0-9a-f]{4}$/.test(s)) return bad("Transparent colours aren't supported — use 6 digits, like #6d28d9.");
    if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) {
      if (/^[a-z]+$/.test(s)) return bad("Use a hex colour code like #6d28d9 — colour names aren't supported.");
      return bad("Accent colour must be a hex code: # and 6 characters 0-9 / a-f, like #6d28d9.");
    }
    if (s.length === 4) s = "#" + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2) + s.charAt(3) + s.charAt(3);
    return ok(s);
  }

  /* ---- logo URL (https only, same rule as onboarding + the booklet) ------- */
  var LOGO_MAX = 500;
  function logo(v) {
    var s = trim(v);
    if (!s) return ok("");
    if (/\s/.test(s)) return bad("A link can't contain spaces — copy the image address again.");
    if (s.length > LOGO_MAX) return bad("That link is too long (" + LOGO_MAX + " characters at most) — use a shorter image address.");
    if (/^http:\/\//i.test(s)) return bad("Use a secure link that starts with https:// (http:// images are blocked on quotes).");
    if (/^(javascript|data|file|vbscript|blob):/i.test(s)) return bad("Only https:// web links to an image are allowed.");
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      if (/^\/\//.test(s)) s = "https:" + s;
      else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s)) s = "https://" + s;
      else return bad("Paste the full image link, starting with https://");
    }
    var u; try { u = new URL(s); } catch (e) { return bad("That isn't a valid link — it should look like https://studio.com/logo.png."); }
    if (u.protocol !== "https:") return bad("Only https:// web links to an image are allowed.");
    if (u.username || u.password) return bad("Remove the user name / password from the link.");
    if (!u.hostname || u.hostname.indexOf(".") <= 0) return bad("That link is missing the website name, e.g. https://studio.com/logo.png.");
    if (/["'<>`]/.test(s)) return bad("That link contains characters that aren't allowed (quotes or < >).");
    return ok(s);
  }

  /* ---- client link name (slug) ------------------------------------------- */
  // live: type "Aurora Events!" -> "aurora-events-"; accents dropped (café -> cafe), runs of dashes collapsed
  function slugLive(v) {
    var s = unpaste(v).normalize ? unpaste(v).normalize("NFKD").replace(/[̀-ͯ]/g, "") : unpaste(v);
    return s.toLowerCase().replace(/^\s+/, "").replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+/, "");   // never cut here: the rule says when it is too long
  }
  function slug(v) {
    var raw = trim(v);
    var s = raw.toLowerCase();
    if (!s) return bad("Enter a link name — 3 to 40 lowercase letters, numbers or dashes.");
    if (/[^a-z0-9-]/.test(s)) return bad("Use only lowercase letters (a-z), numbers and dashes — no spaces, dots or emoji.");
    if (len(s) < 3) return bad("A link name needs at least 3 characters.");
    if (len(s) > 40) return bad("Keep the link name to 40 characters or fewer.");
    if (/^-|-$/.test(s)) return bad("A link name can't start or end with a dash.");
    if (/--/.test(s)) return bad("Use single dashes only (no \"--\").");
    return ok(s);
  }

  /* ---- privacy PIN (the server stores exactly 4 digits - 0157) ------------ */
  function pin(v, o) {
    o = o || {};
    var s = trim(v).replace(/\s+/g, "");
    if (!s) return bad(o.emptyMsg || "Enter the 4-digit PIN.");
    if (!/^\d+$/.test(s)) return bad("The PIN is digits only (0-9).");
    if (s.length !== 4) return bad("The PIN is exactly 4 digits — this has " + s.length + ".");
    return ok(s);
  }
  // all three boxes -> {cur, next, again} error text per field ("" = fine)
  function pinForm(cur, next, again) {
    var out = { cur: "", next: "", again: "" };
    var a = pin(cur, { emptyMsg: "Enter the current PIN (0000 if it was never changed)." }); if (!a.ok) out.cur = a.error;
    var b = pin(next, { emptyMsg: "Choose a new 4-digit PIN." }); if (!b.ok) out.next = b.error;
    var c = trim(again).replace(/\s+/g, "");
    if (!c) out.again = "Type the new PIN again to confirm it.";
    else if (b.ok && c !== b.value) out.again = "The two new PINs don't match.";
    if (!out.cur && !out.next && a.value === b.value) out.next = "The new PIN is the same as the current one.";
    return out;
  }

  /* ---- whole-number day counts (link auto-expire 1-365, package lock 0-90) - */
  function days(v, o) {
    o = o || {}; var min = o.min == null ? 1 : o.min, max = o.max == null ? 365 : o.max;
    var range = "from " + min + " to " + max;
    var s = trim(v).replace(/\s+/g, "");
    if (o.badInput) return bad("Enter digits only, e.g. 10.");
    if (!s) return bad("Enter a whole number of days " + range + ".");
    if (/^-/.test(s)) return bad("Days can't be negative — enter a whole number " + range + ".");
    if (/^\+?\d*[.,]\d*$/.test(s) && /\d/.test(s)) return bad("Use a whole number of days (no decimals), " + range + ".");
    if (!/^\+?\d+$/.test(s)) return bad("Enter digits only, e.g. 10 (whole number " + range + ").");
    var n = Number(s.replace(/^\+/, ""));
    if (n < min) return bad(min === 1 ? "The shortest is 1 day (enter 1 to " + max + ")." : "The lowest is " + min + " (enter " + min + " to " + max + ").");
    if (n > max) return bad("The longest is " + max + " days (enter " + min + " to " + max + ").");
    return ok(n);   // "010" -> 10
  }

  /* ---- role -------------------------------------------------------------- */
  function role(v, roles) {
    var s = trim(v);
    if (!s) return bad("Choose a role.");
    if (Array.isArray(roles) && roles.length && roles.indexOf(s) < 0) return bad("Pick a role from the list.");
    return ok(s);
  }

  /* ---- team e-mail (add user / invite) ----------------------------------- */
  // ctx: {self, members:[email], pending:[{email, role}], role, invite:true|false}
  function teamEmail(v, ctx) {
    ctx = ctx || {};
    var r = email(v, { required: true, who: "their" }); if (!r.ok) return r;
    var e = r.value;
    if (ctx.self && e === String(ctx.self).trim().toLowerCase()) return bad("That's your own e-mail — you're already in this studio.");
    var mem = (ctx.members || []).some(function (m) { return String(m || "").trim().toLowerCase() === e; });
    if (mem) return bad(e + " is already a member of your studio — change their role in the list above instead.");
    if (ctx.invite) {
      var p = (ctx.pending || []).filter(function (x) { return x && String(x.email || "").trim().toLowerCase() === e; })[0];
      if (p && (!ctx.role || p.role === ctx.role)) return bad("An invite to " + e + " is already pending — use Resend email or Copy link in Pending invites below.");
    }
    return ok(e);
  }

  var api = { unpaste: unpaste, email: email, gstin: gstin, taxId: taxId, accent: accent, logo: logo, slug: slug, slugLive: slugLive,
    pin: pin, pinForm: pinForm, days: days, role: role, teamEmail: teamEmail, LOGO_MAX: LOGO_MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.HelmCCInputs = api;
  if (typeof document === "undefined" || !HV || !HV.bind) return;

  /* ---- DOM: register as HelmValidate rules and bind ---------------------- */
  // ctx getters are read at check time, so a country / team list loaded later is used.
  var ctx = { country: function () { return "IN"; }, self: function () { return ""; }, members: function () { return []; }, pending: function () { return []; }, roleOf: {} };
  function adapt(fn) { return function (v) { var r = fn(v); return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error }; }; }
  HV.rules.cc_email = adapt(function (v) { return email(v); });
  HV.rules.cc_tax = adapt(function (v) { return taxId(v, ctx.country()); });
  HV.rules.cc_accent = adapt(accent);
  HV.rules.cc_logo = adapt(logo);
  HV.rules.cc_slug = adapt(slug);
  HV.rules.cc_phone = function (v, o) {   // business phone: any number type, optional
    if (o && o.phone && o.phone.validate) { var r = o.phone.validate({ mobile: false, required: false }); return r.ok ? { ok: true, value: r.e164 || "" } : { ok: false, error: r.error }; }
    var s = trim(v); if (!s) return { ok: true, value: "" };
    var B = global.BPStore, x = B && B.validate && B.validate.phone ? B.validate.phone(s) : { ok: /^\+?\d{7,15}$/.test(s.replace(/[\s\-().]/g, "")), value: s };
    return x.ok ? { ok: true, value: s } : { ok: false, error: x.error || "Enter a valid phone number (7-15 digits, optional leading +)." };
  };
  function teamRule(key, invite) {
    HV.rules[key] = function (v) {
      var roleSel = document.getElementById(invite ? "inv_role" : "um_role");
      var r = teamEmail(v, { self: ctx.self(), members: ctx.members(), pending: ctx.pending(), role: roleSel ? roleSel.value : "", invite: invite });
      return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
    };
  }
  teamRule("cc_member_email", false); teamRule("cc_invite_email", true);

  function $(id) { return document.getElementById(id); }
  function b(id, rule, extra) { var el = $(id); if (!el) return null; return HV.bind(el, Object.assign({ rule: rule }, extra || {})); }
  // message slot for inputs that sit in a one-line form row: a <p> right after the row
  function slotAfter(row, id) { var p = $(id); if (p) return p; p = document.createElement("p"); p.id = id; p.hidden = true; row.parentNode.insertBefore(p, row.nextSibling); return p; }

  var gen = null;
  function bindGeneral(opts) {
    if (opts && opts.country) ctx.country = opts.country;
    if (gen) return gen;
    gen = { email: b("o_email", "cc_email"), phone: b("o_phone", "cc_phone"), logo: b("o_logo", "cc_logo"),
      accent: b("o_accent", "cc_accent"), tax: b("o_gst", "cc_tax"), slug: b("o_slug", "cc_slug", { required: function () { return true; } }) };
    return gen;
  }
  var team = null;
  function bindTeam(opts) {
    opts = opts || {};
    if (opts.self) ctx.self = opts.self; if (opts.members) ctx.members = opts.members; if (opts.pending) ctx.pending = opts.pending;
    if (team) return team;
    var um = $("um_add"), inv = $("inv_add");
    team = {
      member: um ? b("um_email", "cc_member_email", { required: function () { return true; }, msgEl: slotAfter(um, "um_email_fv") }) : null,
      invite: inv ? b("inv_email", "cc_invite_email", { required: function () { return true; }, msgEl: slotAfter(inv, "inv_email_fv") }) : null,
    };
    // the duplicate-invite answer depends on the role picked: re-check when it changes
    var ir = $("inv_role"); if (ir && team.invite) ir.addEventListener("change", function () { if (team.invite.input.value) team.invite.check(); });
    return team;
  }
  // checks the given bindings, focuses the first bad one -> null when all fine
  function first(list) { return HV.checkAll((list || []).filter(Boolean)); }
  api.bindGeneral = bindGeneral; api.bindTeam = bindTeam; api.first = first; api.slotAfter = slotAfter;
})(typeof window !== "undefined" ? window : globalThis);
