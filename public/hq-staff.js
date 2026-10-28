/* hq-staff.js - r27 (0277): the pure model behind Helm HQ staff roles. No DOM, no network (unit-tested).
   The DATABASE decides (every hq_* function checks the caller's role through _hq_gate / _hq_wgate); this file only
   mirrors the same matrix so the page can hide what a role can't use and explain each role in plain words. */
(function (root) {
  "use strict";
  // the same matrix as public._hq27_role_perms (supabase/migrations/0277_hq_staff_roles.sql)
  var ROLE_PERMS = {
    owner: ["*"],
    admin: ["self", "overview.read", "studios.read", "studios.edit", "studios.suspend", "billing.read", "billing.write", "plans.read",
            "inbox.read", "inbox.write", "people.read", "security.read", "security.write", "staff.read", "settings.read", "settings.write"],
    sales: ["self", "overview.read", "studios.read", "plans.read", "inbox.read", "inbox.write"],
    security: ["self", "overview.read", "studios.read", "studios.suspend", "people.read", "security.read", "security.write", "staff.read", "staff.suspend"],
    support: ["self", "overview.read", "studios.read", "inbox.read", "inbox.write", "people.read"],
    viewer: ["self", "overview.read"]
  };
  var ROLES = [
    { key: "owner", label: "Owner", blurb: "Everything, including adding people to HQ and changing roles." },
    { key: "admin", label: "Admin", blurb: "Everything except managing the HQ team." },
    { key: "sales", label: "Sales", blurb: "Studios (look only), requests and enquiries, plans. No billing changes." },
    { key: "security", label: "Security", blurb: "Activity log, security notices, people and two-step resets, pausing studios and HQ people." },
    { key: "support", label: "Support", blurb: "Studios (look only), requests, people (look only)." },
    { key: "viewer", label: "Viewer", blurb: "The Overview page only." }
  ];
  // which permission opens which HQ page
  var TAB_PERM = { overview: "overview.read", studios: "studios.read", requests: "inbox.read", billing: "billing.read", plans: "plans.read",
    people: "people.read", activity: "security.read", staff: "staff.read", settings: "settings.read", privacy: "self" };   // r28: Data & privacy (every HQ person)   // r28: Settings (invoice, checkout, data handling)
  // the rows of "What each role can do" (plain words)
  var MATRIX = [
    ["Overview numbers", "overview.read"], ["See studios", "studios.read"], ["Change a studio's name, details, trial", "studios.edit"],
    ["Pause / restart a studio", "studios.suspend"], ["See billing", "billing.read"], ["Record payments, activate plans, prices", "billing.write"],
    ["See plans", "plans.read"], ["Read requests and enquiries", "inbox.read"], ["Answer requests (status, notes)", "inbox.write"],
    ["See people", "people.read"], ["Activity log + security notices", "security.read"], ["Reset two-step, Helm e-mail addresses", "security.write"],
    ["See the HQ team", "staff.read"], ["Pause an HQ person / sign them out", "staff.suspend"], ["Add people, change roles", "staff.manage"],
    ["HQ settings (alerts, stages)", "settings.write"]
  ];
  function arr(v) { return Array.isArray(v) ? v : []; }
  function can(perms, p) { perms = arr(perms); return perms.indexOf("*") >= 0 || perms.indexOf(p) >= 0; }
  function roleLabel(k) { for (var i = 0; i < ROLES.length; i++) if (ROLES[i].key === k) return ROLES[i].label; return String(k || ""); }
  function allowedTabs(perms) { return Object.keys(TAB_PERM).filter(function (t) { return can(perms, TAB_PERM[t]); }); }
  // what kind of refusal the database sent (0277 messages carry a fixed tag)
  function errKind(e) {
    var m = String((e && e.message) || "");
    if (/HQ_REAUTH/.test(m)) return "reauth";
    if (/HQ_SESSION_IDLE/.test(m)) return "idle";
    if (/HQ_SESSION_EXPIRED/.test(m)) return "expired";
    if (/HQ_SESSION_ENDED/.test(m)) return "ended";
    if (/HQ_ROLE/.test(m)) return "role";
    if (/HQ_IP/.test(m)) return "ip";
    return null;
  }
  function friendly(kind, roleText) {
    return {
      role: "Your HQ role" + (roleText ? " (" + roleText + ")" : "") + " can't do this. Ask the HQ owner if you need it.",
      ip: "Helm HQ can't be used from this network. Ask the HQ owner.",
      idle: "You were signed out of Helm HQ after a while without use. Sign in again.",
      expired: "Helm HQ sign-ins last a limited time. Sign in again.",
      ended: "This sign-in was ended (signed out everywhere, or your access changed). Sign in again.",
      reauth: "Enter a fresh two-step code to confirm this change."
    }[kind] || "";
  }
  // "Chrome on Mac" from a browser's user-agent text (look only)
  function deviceName(ua) {
    ua = String(ua || "");
    if (!ua) return "Unknown device";
    var b = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    var o = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac"
      : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    return o ? b + " on " + o : b;
  }
  var STATUS = { active: ["Active", "ok"], invited: ["Invited", "warn"], suspended: ["Paused", "bad"], removed: ["Removed", ""] };
  function statusOf(s) { return STATUS[s] || [String(s || "-"), ""]; }
  var EVENT_WORDS = { invited: "added to HQ", role_changed: "role changed", suspended: "paused", restored: "access given back",
    removed: "removed from HQ", signed_out: "signed out everywhere", activated: "first sign-in to HQ", settings: "sign-in rules changed" };
  // initials for the round avatar ("sales@helm.events" -> "S", "Priya Rao" -> "PR")
  function initials(name, email) {
    var n = String(name || "").trim();
    if (n) { var p = n.split(/\s+/); return (p[0].charAt(0) + (p.length > 1 ? p[p.length - 1].charAt(0) : "")).toUpperCase(); }
    return String(email || "?").charAt(0).toUpperCase();
  }
  // one IP / range per line -> clean list (the database validates again)
  function ipList(text) {
    return String(text || "").split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(function (s) { return /^[0-9a-fA-F:.\/]{2,49}$/.test(s); }).slice(0, 50);
  }
  var api = { ROLE_PERMS: ROLE_PERMS, ROLES: ROLES, TAB_PERM: TAB_PERM, MATRIX: MATRIX, can: can, roleLabel: roleLabel, allowedTabs: allowedTabs,
    errKind: errKind, friendly: friendly, deviceName: deviceName, statusOf: statusOf, EVENT_WORDS: EVENT_WORDS, initials: initials, ipList: ipList };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmHqStaff = api;
})(typeof window !== "undefined" ? window : this);
