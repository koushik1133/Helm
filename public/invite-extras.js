/* invite-extras.js — R34: shared by the Invitation Studio and the public invitation page (so the live preview and the
 * published site agree), all plain data + pure functions (no DOM, no network):
 *   THEMES / KEYS     the 11 invitation themes (phase87's 5 + r34's 6). The database CHECK (0284) has the same keys.
 *   settings(data)    the per-site switches with the defaults an EXISTING site keeps (missing = today's behaviour):
 *                       rsvpForm     false  (optional: the studio turns the RSVP form on)
 *                       rsvpContact  true   -> "RSVP on WhatsApp" + "Call" (the default for new sites too)
 *                       addressMode  "full" | "after_rsvp" (venue + city until the guest replies)
 *                       helmBrand    true   ("Made with Helm Studios" in the footer; data.hideHelmBrand hides it)
 *   cityOf(address)   the last part of "Street, area, City" (a suggestion for the City field)
 *   LIMITS            the same limits the server checks (public_invite_rsvp)
 *   formProblem(f)    a guest's form -> "" or a short message (the server checks again; this only saves a round trip)
 *   csvCell / toCsv   CSV for the studio's "Download replies": every cell quoted; a cell that starts with = + - @ (also
 *                     after spaces) or a tab / CR gets a leading ' so a spreadsheet never runs it as a formula. */
(function (global) {
  "use strict";
  var THEMES = [
    { k: "eternal",   n: "Eternal",     d: "Elegant · wedding" },
    { k: "promise",   n: "Promise",     d: "Romantic · engagement" },
    { k: "confetti",  n: "Confetti",    d: "Festive · birthday" },
    { k: "summit",    n: "Summit",      d: "Professional · corporate" },
    { k: "soiree",    n: "Soirée",      d: "Modern · any event" },
    { k: "shubh",     n: "Shubh Vivah", d: "Regal · Indian wedding" },
    { k: "mehndi",    n: "Mehndi",      d: "Vibrant · sangeet / mehendi" },
    { k: "solitaire", n: "Solitaire",   d: "Graceful · engagement" },
    { k: "jubilee",   n: "Jubilee",     d: "Joyful · birthday" },
    { k: "gala",      n: "Gala Noir",   d: "Black-tie · corporate gala" },
    { k: "linen",     n: "Linen",       d: "Minimal · modern" }
  ];
  var KEYS = THEMES.map(function (t) { return t.k; });
  var LIMITS = { name: 80, message: 500, guestsMax: 20 };

  function settings(d) {
    d = (d && typeof d === "object") ? d : {};
    return {
      rsvpForm: d.rsvpForm === true,
      rsvpContact: d.rsvpContact !== false,
      addressMode: d.addressMode === "after_rsvp" ? "after_rsvp" : "full",
      helmBrand: d.hideHelmBrand !== true
    };
  }
  function cityOf(address) {
    var parts = String(address == null ? "" : address).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length < 2) return "";
    var last = parts[parts.length - 1].replace(/\b\d{5,6}\b/g, "").replace(/\s+-\s*$/, "").trim();   // "Hyderabad 500032" -> "Hyderabad"
    return (last || parts[parts.length - 2] || "").slice(0, 60);
  }
  function formProblem(f) {
    f = f || {};
    var name = String(f.name == null ? "" : f.name).trim(), msg = String(f.message == null ? "" : f.message);
    if (!name) return "Please write your name.";
    if (name.length > LIMITS.name) return "Please keep your name under " + LIMITS.name + " characters.";
    if (msg.length > LIMITS.message) return "Please keep the message under " + LIMITS.message + " characters.";
    if (/[<>]/.test(name) || /[<>]/.test(msg)) return "Please leave out the < and > characters.";
    if (["yes", "no", "maybe"].indexOf(f.attending) < 0) return "Please choose Yes, No or Maybe.";
    if (f.attending !== "no") { var n = Number(f.guests); if (!(n >= 1 && n <= LIMITS.guestsMax && Math.floor(n) === n)) return "Please choose how many are coming (1 to " + LIMITS.guestsMax + ")."; }
    return "";
  }
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s)) s = "'" + s;          // spreadsheet formula injection guard
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function toCsv(rows) { return (rows || []).map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n"; }

  global.HelmInviteX = Object.freeze({
    THEMES: THEMES, KEYS: KEYS, LIMITS: LIMITS,
    has: function (k) { return KEYS.indexOf(k) >= 0; },
    settings: settings, cityOf: cityOf, formProblem: formProblem, csvCell: csvCell, toCsv: toCsv
  });
})(typeof window !== "undefined" ? window : globalThis);
