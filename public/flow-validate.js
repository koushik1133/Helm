/* =========================================================================
   HELM - quote flow field rules (owner report, Oct 2026).
   One place for every input rule on flow.html (steps 1-8), pure so Node tests
   can run it: window.HelmFlowValidate / require().

   Each section validator takes plain values keyed by the input id and returns
   { errors: {id: msg}, warnings: {id: msg}, ok }. Errors block that section's
   save; warnings never do (they stay visible beside the field).
   paint(doc, result, shown) puts the messages UNDER the fields (createElement +
   textContent only, no innerHTML). `shown` = ids the user has left / tried to
   save, so a field is never flagged red before the user reached it.
   ========================================================================= */
(function (root) {
  "use strict";

  var DAY = /^\d{4}-\d{2}-\d{2}$/;
  var EMOJI = /\p{Extended_Pictographic}/u;
  var LETTER = /\p{L}/u;
  var EMAIL = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
  var GUESTS_MAX = 100000, BUDGET_MAX = 1e11, MONEY_MAX = 1e10, HALL_MIN = 20, HALL_MAX = 2000;

  function str(v) { return v == null ? "" : String(v); }
  function clean(v) { return str(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(); }
  function len(s) { return Array.from(s).length; }
  // comparison key: case, spacing, accents ("Décor" = "decor") and "&" vs "and" don't matter
  function norm(v) { return clean(v).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

  // ---- dates in the studio's own time zone (India -> Asia/Kolkata) ----
  var TZ = { IN: "Asia/Kolkata", AE: "Asia/Dubai" };
  function tzFor(country) { return TZ[String(country || "IN").toUpperCase()] || null; }
  function todayIn(tz, now) {
    var d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    try {
      if (tz) {
        var p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
        var g = function (t) { for (var i = 0; i < p.length; i++) if (p[i].type === t) return p[i].value; return ""; };
        return g("year") + "-" + g("month") + "-" + g("day");
      }
    } catch (e) { /* unknown zone: local day */ }
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function addYears(iso, n) { var y = +iso.slice(0, 4) + n; return y + iso.slice(4); }
  function realDay(v) {
    if (!DAY.test(v)) return false;
    var y = +v.slice(0, 4), m = +v.slice(5, 7), d = +v.slice(8, 10);
    var x = new Date(Date.UTC(y, m - 1, d));
    return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
  }
  function prettyDay(v) {
    if (!realDay(v)) return v;
    var M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return +v.slice(8, 10) + " " + M[+v.slice(5, 7) - 1] + " " + v.slice(0, 4);
  }

  // ---- generic text: {label, required, min, max, letters, noEmoji} -> {ok, value, error}
  function text(v, o) {
    o = o || {}; var s = clean(v), L = o.label || "This field";
    if (!s) return o.required ? { ok: false, error: o.requiredMsg || (L + " is required.") } : { ok: true, value: "" };
    if (/[<>]/.test(s)) return { ok: false, error: L + " can't contain < or >." };
    if (o.noEmoji && EMOJI.test(s)) return { ok: false, error: L + " can't contain emoji or symbols." };
    if (o.min && len(s) < o.min) return { ok: false, error: L + " needs at least " + o.min + " characters." };
    if (o.max && len(s) > o.max) return { ok: false, error: L + " can be at most " + o.max + " characters (now " + len(s) + ")." };
    if (o.letters && !LETTER.test(s)) return { ok: false, error: L + " must contain letters, not just numbers or punctuation." };
    return { ok: true, value: s };
  }
  // free text (notes): only a length cap; the raw text (line breaks) is kept
  function notes(v, o) {
    o = o || {}; var s = str(v).trim();
    if (o.max && len(s) > o.max) return { ok: false, error: (o.label || "Notes") + " can be at most " + o.max + " characters (now " + len(s) + ")." };
    return { ok: true, value: s };
  }
  function clientName(v) { return text(v, { label: "Client name", required: true, requiredMsg: "Client name is required.", min: 2, max: 80, letters: true, noEmoji: true }); }
  function eventType(v) { return text(v, { label: "Event type", required: true, requiredMsg: "Pick or type the event type.", max: 60, letters: true, noEmoji: true }); }
  // o.required (r19: the client e-mail is required in step 1, like name and phone)
  function email(v, o) {
    var s = clean(v); if (!s) return o && o.required ? { ok: false, error: "Email is required." } : { ok: true, value: "" };
    if (len(s) > 254 || !EMAIL.test(s) || s.split("@")[0].length > 64 || /\.\./.test(s)) return { ok: false, error: "Enter an email like name@example.com." };
    return { ok: true, value: s };
  }

  // ---- numbers: plain digits only (no e-notation / letters); integer counts or 2-dp money
  function num(raw, o) {
    o = o || {}; var L = o.label || "Value";
    var s = str(raw).trim().replace(/[,\s]/g, "");
    if (!s) return o.required ? { ok: false, error: L + " is required." } : { ok: true, value: null };
    if (/^-/.test(s)) return { ok: false, error: L + " can't be negative." };
    if (o.integer && /^\+?\d+\.\d*$/.test(s)) return { ok: false, error: L + " must be a whole number (no decimals)." };
    if (!/^\+?\d+(\.\d+)?$/.test(s)) return { ok: false, error: L + " must be a number." };
    var n = Number(s);
    if (!isFinite(n)) return { ok: false, error: L + " must be a number." };
    if (o.dp != null && /\.\d+$/.test(s) && s.split(".")[1].length > o.dp) return { ok: false, error: L + " can have at most " + o.dp + " decimal places." };
    if (o.min != null && n < o.min) return { ok: false, error: L + " must be at least " + fmt(o.min) + "." };
    if (o.max != null && n > o.max) return { ok: false, error: L + " can be at most " + fmt(o.max) + "." };
    return { ok: true, value: n };
  }
  function count(raw, o) { o = o || {}; return num(raw, { label: o.label, required: o.required, integer: true, min: o.min == null ? 0 : o.min, max: o.max == null ? GUESTS_MAX : o.max }); }
  function money(raw, o) { o = o || {}; return num(raw, { label: o.label || "Amount", required: o.required, dp: 2, min: 0, max: o.max == null ? MONEY_MAX : o.max }); }
  function guests(raw) { return count(raw, { label: "Guests", min: 1, max: GUESTS_MAX }); }

  // ---- Indian money: "2,00,00,000", "₹ 2 crore", "20 lakh", "1.5cr", "50k" -> number
  function parseAmount(raw) {
    var s = str(raw).trim().toLowerCase().replace(/₹|rs\.?|inr|\/-/g, "").replace(/,/g, "").replace(/\s+/g, " ").trim();
    if (!s) return { ok: true, value: null };
    var m = /^(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|l|thousand|k)?$/.exec(s);
    if (!m) return { ok: false };
    var mul = !m[2] ? 1 : /^c/.test(m[2]) ? 1e7 : /^l/.test(m[2]) ? 1e5 : 1e3;
    if (mul === 1 && /\.\d{3,}$/.test(m[1])) return { ok: false };
    return { ok: true, value: Math.round(Number(m[1]) * mul * 100) / 100 };
  }
  function fmt(n) { n = Number(n); if (!isFinite(n)) return ""; return n.toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
  function words(n) {
    n = Number(n); if (!(n > 0)) return "";
    var r = function (x) { return String(Math.round(x * 100) / 100); };
    if (n >= 1e7) return r(n / 1e7) + " crore";
    if (n >= 1e5) return r(n / 1e5) + " lakh";
    return "";
  }
  function budget(raw) {
    if (/^\s*-/.test(str(raw))) return { ok: false, error: "Budget can't be negative." };
    var p = parseAmount(raw);
    if (!p.ok) return { ok: false, error: "Budget must be an amount like 5,00,000 or 2 crore." };
    if (p.value == null) return { ok: true, value: null };
    if (p.value > BUDGET_MAX) return { ok: false, error: "Budget can be at most ₹" + fmt(BUDGET_MAX) + "." };
    return { ok: true, value: p.value };
  }
  // non-blocking sanity check on the per-guest budget
  function budgetWarning(b, g) {
    b = Number(b); g = Number(g);
    if (!(b > 0)) return "";
    if (b < 1000) return "Budget is only ₹" + fmt(b) + " — did you mean lakh or crore?";
    if (!(g > 0)) return "";
    var pg = b / g;
    if (pg < 100) return "That's about ₹" + fmt(Math.round(pg)) + " per guest — check the budget or the guest count.";
    if (pg > 500000) return "That's about ₹" + fmt(Math.round(pg)) + " per guest — check the budget or the guest count.";
    return "";
  }

  // ---- event date: required, not in the past (studio day), within 5 years.
  // `original` = the date already saved on the quote: an old / closed / sample event keeps its date.
  function eventDate(v, o) {
    o = o || {}; var s = str(v).trim(), today = o.today || todayIn(null);
    if (!s) return { ok: false, error: o.rejected === "past" ? "Event date can't be in the past." : o.rejected ? "Pick an event date within the next 5 years." : "Pick the event date." };
    if (!realDay(s)) return { ok: false, error: "Enter a real date (DD-MM-YYYY)." };
    if (o.original && s === String(o.original).slice(0, 10)) return { ok: true, value: s };
    if (s < today) return { ok: false, error: "Event date can't be in the past." };
    if (s > addYears(today, 5)) return { ok: false, error: "Event date can be at most 5 years ahead (" + prettyDay(addYears(today, 5)) + ")." };
    return { ok: true, value: s };
  }
  // discovery meeting: today - 2 years .. today + 1 year; after the event date only warns
  function meetingDate(v, o) {
    o = o || {}; var s = str(v).trim(), today = o.today || todayIn(null);
    if (!s) return { ok: true, value: "" };
    if (!realDay(s)) return { ok: false, error: "Enter a real date (DD-MM-YYYY)." };
    if (o.original && s === String(o.original).slice(0, 10)) return { ok: true, value: s };
    if (s < addYears(today, -2) || s > addYears(today, 1)) return { ok: false, error: "Meeting date must be between " + prettyDay(addYears(today, -2)) + " and " + prettyDay(addYears(today, 1)) + "." };
    return { ok: true, value: s };
  }

  function put(res, id, r) { if (r && !r.ok) res.errors[id] = r.error; return r; }
  function done(res) { res.ok = Object.keys(res.errors).length === 0; return res; }
  function blank() { return { errors: {}, warnings: {}, ok: true }; }

  // ---- step 1 Client & event. ctx: {today, originalDate, rejectedDate, phone(v) -> {ok,error}}
  function client(v, ctx) {
    ctx = ctx || {}; var r = blank();
    put(r, "c_name", clientName(v.c_name));
    put(r, "c_company", text(v.c_company, { label: "Company", max: 80 }));
    put(r, "c_email", email(v.c_email, { required: true }));
    var ph = str(v.c_phone).trim();
    if (!ph) r.errors.c_phone = "Phone is required.";
    else if (ctx.phone) { var p = ctx.phone(ph); if (p && !p.ok) r.errors.c_phone = p.error || "Enter a valid phone number."; }
    put(r, "c_type", eventType(v.c_type));
    put(r, "c_date", eventDate(v.c_date, { today: ctx.today, original: ctx.originalDate, rejected: ctx.rejectedDate }));
    put(r, "c_city", text(v.c_city, { label: "City", max: 60, letters: true, noEmoji: true }));
    var g = put(r, "c_guests", guests(v.c_guests));
    var b = put(r, "d_bmax", budget(v.d_bmax));
    if (b.ok && g.ok) { var w = budgetWarning(b.value, g.value); if (w) r.warnings.d_bmax = w; }
    return done(r);
  }
  // ---- step 2 Discovery
  function discovery(v, ctx) {
    ctx = ctx || {}; var r = blank();
    var m = put(r, "d_date", meetingDate(v.d_date, { today: ctx.today, original: ctx.originalMeet }));
    if (m.ok && m.value && ctx.eventDate && DAY.test(ctx.eventDate) && m.value > ctx.eventDate) r.warnings.d_date = "The meeting is after the event date (" + prettyDay(ctx.eventDate) + ") — check it.";
    if (v.d_mode && ["in_person", "call", "video"].indexOf(v.d_mode) < 0) r.errors.d_mode = "Pick how you met.";
    put(r, "d_att", text(v.d_att, { label: "Who attended", max: 200 }));
    put(r, "d_notes", notes(v.d_notes, { label: "Notes", max: 4000 }));
    return done(r);
  }
  // ---- step 3 Requirements: one new requirement against the current list
  function requirement(title, list, note) {
    var r = blank();
    var t = text(title, { label: "Requirement", required: true, requiredMsg: "Type or pick a requirement first.", min: 2, max: 80, letters: true, noEmoji: true });
    if (!t.ok) r.errors.rq_title = t.error;
    else {
      var k = norm(t.value);
      var dup = (list || []).filter(function (x) { return norm(x && (x.service || x.title || x)) === k; })[0];
      if (dup) r.errors.rq_title = "“" + clean(dup.service || dup.title || dup) + "” is already in the list.";
      r.value = t.value;
    }
    var n = text(note, { label: "Note", max: 200 });
    if (!n.ok) r.errors.rq_note = n.error; else r.note = n.value;
    return done(r);
  }
  // ---- step 4 Venue
  function venue(v) {
    var r = blank();
    put(r, "v_name", text(v.v_name, { label: "Venue name", max: 120, letters: true }));
    put(r, "v_contact", text(v.v_contact, { label: "Venue contact", max: 120 }));
    put(r, "v_addr", text(v.v_addr, { label: "Address", max: 300 }));
    put(r, "v_access", notes(v.v_access, { label: "Access notes", max: 2000 }));
    return done(r);
  }
  // ---- step 5 Menu notes
  function menu(v) { var r = blank(); put(r, "p_menu", notes(v.p_menu, { label: "Menu notes", max: 4000 })); return done(r); }
  // ---- step 6 Proposal: scope lines, no repeats
  function scopeLines(raw) { return str(raw).split("\n").map(clean).filter(Boolean); }
  function proposal(v) {
    var r = blank();
    put(r, "pr_concept", text(v.pr_concept, { label: "Concept", max: 80, noEmoji: true }));
    put(r, "pr_theme", text(v.pr_theme, { label: "Theme", max: 80, noEmoji: true }));
    var lines = scopeLines(v.pr_scope), seen = {}, rep = "";
    lines.forEach(function (l) { var k = norm(l); if (seen[k] && !rep) rep = l; seen[k] = 1; });
    if (lines.length > 50) r.errors.pr_scope = "Keep the scope to 50 lines or fewer (now " + lines.length + ").";
    else if (lines.some(function (l) { return len(l) > 200; })) r.errors.pr_scope = "Each scope line can be at most 200 characters.";
    else if (rep) r.errors.pr_scope = "“" + rep + "” is listed twice.";
    return done(r);
  }
  // ---- step 7 Layout: hall size, both or neither
  function layout(v) {
    var r = blank();
    var a = put(r, "g_len", num(v.g_len, { label: "Hall length", dp: 1, min: HALL_MIN, max: HALL_MAX }));
    var b = put(r, "g_wid", num(v.g_wid, { label: "Hall breadth", dp: 1, min: HALL_MIN, max: HALL_MAX }));
    if (a.ok && b.ok && (a.value == null) !== (b.value == null)) r.errors[a.value == null ? "g_len" : "g_wid"] = "Enter both the hall length and breadth (or leave both empty).";
    return done(r);
  }
  // ---- step 8 Quotation quantities / amounts (discount has its own checks on the page)
  function quote(v, ctx) {
    ctx = ctx || {}; var r = blank();
    put(r, "q_chairs", count(v.q_chairs, { label: "Chairs", min: 1 }));
    put(r, "q_guests", count(v.q_guests, { label: "Plates", min: 0 }));
    put(r, "q_other", money(v.q_other, { label: "Décor / setup" }));
    put(r, "q_coupon", text(v.q_coupon, { label: "Coupon code", max: 40 }));
    if (ctx.pkgNoPrice) r.errors.q_platePrice = "“" + ctx.pkgNoPrice + "” has no price set — set it in Control Center › Menus.";
    return done(r);
  }

  // ---- has the section any content of its own? (empty -> "Not started")
  function filled(v, ids) { return ids.some(function (k) { return clean(v[k]) !== ""; }); }
  var CONTENT = {
    client: ["c_name", "c_company", "c_email", "c_phone", "c_type", "c_date", "c_city", "c_guests", "d_bmax"],
    discovery: ["d_date", "d_mode", "d_att", "d_notes"],
    venue: ["v_name", "v_contact", "v_addr", "v_access", "v_setting"],
    menu: ["p_menu"],
    proposal: ["pr_concept", "pr_theme", "pr_scope"],
  };
  function hasContent(section, v) { return !!CONTENT[section] && filled(v || {}, CONTENT[section]); }

  // ---- DOM: messages under the fields --------------------------------------------
  function anchorOf(el) { return (el.closest && (el.closest(".bpui-tel") || el.closest(".hp-wrap"))) || el; }
  function setMsg(doc, id, msg, kind) {
    var el = doc.getElementById(id); if (!el) return;
    var mid = id + "_fv", m = doc.getElementById(mid);
    var desc = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(function (x) { return x && x !== mid; });
    if (!msg) {
      if (m) m.remove();
      if (kind !== "keep") el.removeAttribute("aria-invalid");
      if (desc.length) el.setAttribute("aria-describedby", desc.join(" ")); else el.removeAttribute("aria-describedby");
      return;
    }
    if (!m) { m = doc.createElement("span"); m.id = mid; var a = anchorOf(el); a.parentNode.insertBefore(m, a.nextSibling); }
    m.className = "fv-msg" + (kind === "warn" ? " fv-warn" : "");
    if (kind === "warn") { m.setAttribute("role", "status"); el.removeAttribute("aria-invalid"); }
    else { m.setAttribute("role", "alert"); el.setAttribute("aria-invalid", "true"); }
    if (m.textContent !== msg) m.textContent = msg;
    desc.push(mid); el.setAttribute("aria-describedby", desc.join(" "));
  }
  // ids: every id this validator owns (cleared when fine); shown: Set of ids allowed to show an error
  function paint(doc, res, ids, shown) {
    (ids || []).forEach(function (id) {
      var e = res.errors[id], w = res.warnings[id];
      if (e && (!shown || shown === true || shown.has(id))) setMsg(doc, id, e, "err");
      else if (w) setMsg(doc, id, w, "warn");
      else setMsg(doc, id, "");
    });
  }
  function first(res, order) {
    var ks = order ? order.filter(function (k) { return res.errors[k]; }) : Object.keys(res.errors);
    return ks.length ? { id: ks[0], msg: res.errors[ks[0]] } : null;
  }

  var api = {
    GUESTS_MAX: GUESTS_MAX, BUDGET_MAX: BUDGET_MAX, HALL_MIN: HALL_MIN, HALL_MAX: HALL_MAX, CONTENT: CONTENT,
    clean: clean, norm: norm, tzFor: tzFor, todayIn: todayIn, addYears: addYears, realDay: realDay, prettyDay: prettyDay,
    text: text, notes: notes, clientName: clientName, eventType: eventType, email: email, num: num, count: count, money: money, guests: guests,
    parseAmount: parseAmount, fmt: fmt, words: words, budget: budget, budgetWarning: budgetWarning, eventDate: eventDate, meetingDate: meetingDate,
    client: client, discovery: discovery, requirement: requirement, venue: venue, menu: menu, proposal: proposal, scopeLines: scopeLines,
    layout: layout, quote: quote, hasContent: hasContent, setMsg: setMsg, paint: paint, first: first,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelmFlowValidate = api;
})(typeof window !== "undefined" ? window : globalThis);
