/* settings-search-core.js - the matching brain of Settings search.
 * Pure functions, no DOM: works in the browser (window.HelmSettingsSearch) and in Node tests.
 * "Smart" means, per word the user types:
 *   exact word > start of a word > inside a word > a synonym ("hide money" finds "Hide amounts",
 *   "gst" finds "tax", "staff invite" finds "Invite by email link") > a typo (1 wrong letter in
 *   4-6 letter words, 2 in longer ones: "whatsap", "notifcations", "pasword").
 * Every word must match something (AND); the best entries come first. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HelmSettingsSearch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* words that mean the same thing when looking for a setting (all lower case, normalised) */
  var GROUPS = [
    ["pin", "passcode", "unlock", "privacy"],
    ["hide", "mask", "blur", "conceal", "privacy", "eye", "present", "presenting"],
    ["money", "amount", "amounts", "price", "prices", "pricing", "rate", "rates", "cost", "costs", "fee", "fees", "rupee", "rupees", "inr", "aed", "dirham", "currency"],
    ["gst", "gstin", "tax", "taxes", "vat", "cgst", "sgst", "igst", "trn"],
    ["staff", "team", "user", "users", "member", "members", "people", "employee", "employees", "teammate", "teammates", "colleague"],
    ["crew", "staff", "worker", "workers"],
    ["invite", "invites", "invitation", "join", "onboard", "add"],
    ["whatsapp", "wa", "message", "messages", "sms", "text", "texts"],
    ["email", "mail", "smtp", "sender", "inbox"],
    ["role", "roles", "access", "permission", "permissions", "rbac", "matrix", "rights"],
    ["notification", "notifications", "alert", "alerts", "bell", "notify"],
    ["reminder", "reminders", "followup", "nudge"],
    ["twostep", "2fa", "mfa", "otp", "authenticator", "totp", "verification", "security"],
    ["password", "passwd", "signin", "login", "credentials"],
    ["link", "links", "url", "expire", "expiry", "expiration"],
    ["menu", "menus", "dish", "dishes", "food", "catering", "plate", "plates", "package", "packages"],
    ["chair", "chairs", "seat", "seats", "seating"],
    ["venue", "venues", "hall", "halls", "space", "spaces"],
    ["layout", "layouts", "floor", "template", "templates", "generator"],
    ["subscription", "billing", "invoice", "invoices", "payment", "payments", "pay", "upgrade"],
    ["studio", "business", "company", "organization", "account", "general"],
    ["logo", "brand", "branding", "colour", "color", "accent", "theme"],
    ["export", "download", "archive", "backup", "gdpr", "dpdp", "portability"],
    ["import", "excel", "xlsx", "csv", "spreadsheet"],
    ["coupon", "coupons", "discount", "discounts", "promo", "voucher", "offer"],
    ["render", "renders", "photo", "photos", "image", "images", "picture", "pictures"],
    ["profile", "name", "avatar", "mobile", "phone"],
    ["integration", "integrations", "connect", "webhook", "api", "gateway", "razorpay"],
    ["audit", "log", "history", "activity"],
    ["report", "reports", "insight", "insights", "analytics"],
    ["field", "fields", "custom", "extra"],
    ["capacity", "limit", "limits", "maximum", "max"],
    ["timezone", "time", "zone", "country", "region", "location"]
  ];
  var SYN = Object.create(null);
  GROUPS.forEach(function (g) {
    g.forEach(function (w) { var s = SYN[w] || (SYN[w] = []); g.forEach(function (x) { if (x !== w && s.indexOf(x) < 0) s.push(x); }); });
  });
  var SYN_WORDS = Object.keys(SYN);
  var STOP = { the: 1, a: 1, an: 1, of: 1, to: 1, for: 1, and: 1, my: 1, me: 1, how: 1, do: 1, i: 1, where: 1, is: 1, set: 1, change: 1, edit: 1, settings: 1, setting: 1, page: 1, in: 1, on: 1, with: 1 };

  /* lower case, no accents, phrases joined ("two-step" -> "twostep", "e-mail" -> "email") */
  function normalize(s) {
    s = String(s == null ? "" : s).toLowerCase();
    try { s = s.normalize("NFKD").replace(/[̀-ͯ]/g, ""); } catch (e) {}
    return s.replace(/&/g, " and ")
      .replace(/\btwo[\s-]*(?:step|factor)\b/g, "twostep").replace(/\b2[\s-]*(?:fa|step|factor)\b/g, "2fa")
      .replace(/\be[\s-]+mail/g, "email").replace(/\bwhats[\s-]+app\b/g, "whatsapp").replace(/\bsign[\s-]*in\b/g, "signin").replace(/\blog[\s-]*in\b/g, "login")
      .replace(/\bfollow[\s-]*ups?\b/g, "followup").replace(/\bpin[\s-]*code\b/g, "pincode")
      .replace(/[^a-z0-9؀-ۿऀ-ॿ]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function tokens(s) { var n = normalize(s); return n ? n.split(" ") : []; }
  function queryTokens(q) {
    var t = tokens(q), keep = t.filter(function (w) { return !STOP[w]; });
    return keep.length ? keep : t;
  }

  /* optimal-string-alignment distance (a swap of two letters counts as one typo), capped */
  function distance(a, b, max) {
    if (a === b) return 0;
    var la = a.length, lb = b.length; if (Math.abs(la - lb) > max) return max + 1;
    var prev2 = null, prev = new Array(lb + 1), cur, i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur = new Array(lb + 1); cur[0] = i; var rowMin = cur[0];
      for (j = 1; j <= lb; j++) {
        var c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (prev2 && i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev; prev = cur;
    }
    return prev[lb];
  }
  function typos(len) { return len >= 7 ? 2 : len >= 4 ? 1 : 0; }

  /* synonyms of a typed word, also when the word itself has a typo ("whatsap" -> whatsapp group).
     fix = known words the typed word is a typo / start of; syn = words that mean the same thing */
  var synCache = Object.create(null);
  function synonyms(t) {
    if (synCache[t]) return synCache[t];
    var fix = [], syn = [];
    function add(w, direct) {
      if (!direct && w !== t && fix.indexOf(w) < 0) fix.push(w);
      (SYN[w] || []).forEach(function (x) { if (x !== t && syn.indexOf(x) < 0) syn.push(x); });
    }
    if (SYN[t]) add(t, true);
    else {
      var k = typos(t.length);
      SYN_WORDS.forEach(function (w) {
        if ((t.length >= 3 && w.indexOf(t) === 0 && w.length - t.length <= 4) || (k && distance(t, w, k) <= k)) add(w, false);
      });
    }
    return (synCache[t] = { fix: fix, syn: syn });
  }

  /* how well one typed word matches a list of words: 0 (no) .. 1 (exact) */
  function wordScore(t, words) {
    var best = 0, i, w, k = typos(t.length), sy = null;
    for (i = 0; i < words.length; i++) {
      w = words[i];
      if (w === t) return 1;
      if (t.length >= 2 && w.indexOf(t) === 0) best = Math.max(best, 0.86);
      else if (t.length >= 3 && w.indexOf(t) > 0) best = Math.max(best, 0.62);
      else if (t.length >= 3 && t.indexOf(w) === 0 && w.length >= 3 && t.length - w.length <= 2) best = Math.max(best, 0.58);   /* "invites" vs "invite" */
    }
    if (best >= 0.86) return best;
    sy = synonyms(t);
    for (i = 0; i < words.length; i++) {
      w = words[i];
      if (sy.fix.indexOf(w) >= 0) best = Math.max(best, 0.8);          /* a typo of a known word */
      else if (sy.syn.indexOf(w) >= 0) best = Math.max(best, sy.fix.length ? 0.66 : 0.74);
      else if (k && best < 0.55) {
        if (distance(t, w, k) <= k) best = Math.max(best, 0.7);
        else if (w.length > t.length && distance(t, w.slice(0, t.length), k) <= k) best = Math.max(best, 0.5);   /* typo in a word still being typed */
      }
    }
    return best;
  }

  /* entry: {text, context?, keywords?}. text = what the result says; context = section / card title;
     keywords = extra words (synonyms, descriptions). Returns 0 when any typed word matches nothing. */
  function score(query, entry) {
    var q = queryTokens(query); if (!q.length || !entry) return 0;
    var tw = tokens(entry.text), cw = tokens(entry.context), kw = tokens(entry.keywords);
    var total = 0;
    for (var i = 0; i < q.length; i++) {
      var s = Math.max(wordScore(q[i], tw), 0.7 * wordScore(q[i], cw), 0.6 * wordScore(q[i], kw));
      if (s <= 0) return 0;
      total += s;
    }
    total = total / q.length;
    var nq = normalize(query), nt = " " + normalize(entry.text) + " ";
    if (nq && nt.indexOf(" " + nq + " ") === 0) total += 0.3; else if (nq && nt.indexOf(" " + nq + " ") > 0) total += 0.15;
    if (entry.boost) total += entry.boost;
    return Math.round(total * 1000) / 1000;
  }
  /* best first; ties keep the original order. Each result gets ._score */
  function rank(query, entries, limit) {
    var out = [];
    (entries || []).forEach(function (e, i) { var s = score(query, e); if (s > 0) out.push({ e: e, s: s, i: i }); });
    out.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
    return out.slice(0, limit || 25).map(function (x) { x.e._score = x.s; return x.e; });
  }
  /* [start, end) ranges in `text` to mark for this query (whole words that matched) */
  function ranges(text, query) {
    var q = queryTokens(query), out = [], re = /[A-Za-z0-9À-ɏ؀-ۿऀ-ॿ]+/g, m;
    if (!q.length) return out;
    while ((m = re.exec(String(text || "")))) {
      var w = normalize(m[0]); if (!w) continue;
      for (var i = 0; i < q.length; i++) { if (wordScore(q[i], [w]) >= 0.5) { out.push([m.index, m.index + m[0].length]); break; } }
    }
    return out;
  }
  return { normalize: normalize, tokens: tokens, queryTokens: queryTokens, distance: distance, synonyms: synonyms,
           wordScore: wordScore, score: score, rank: rank, ranges: ranges, GROUPS: GROUPS };
});
