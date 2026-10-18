/* auth-confirm-core.js — pure helpers for /auth/confirm (0204). No DOM, no network: parse the e-mail
   link Helm (or the Supabase Auth templates in docs/ops/email-templates) sends, so every auth e-mail
   link is on https://www.helm.events instead of the Supabase project URL:
     /auth/confirm?token_hash=<hashed token>&type=<invite|signup|email|recovery|magiclink|email_change>&next=<where>
   `next` is LAST on purpose: a Supabase {{ .RedirectTo }} may carry its own "?a=b&c=d", so everything
   after "next=" is taken as the target. It must be a same-origin path (an absolute URL is accepted only
   when its origin is exactly this site's) - never another host, "//host", "/\host" or a scheme.
   Shared by auth-confirm.js (browser) and test/auth-confirm.test.mjs (node). */
(function (root) {
  "use strict";
  var TYPES = { invite: 1, magiclink: 1, recovery: 1, signup: 1, email: 1, email_change: 1 };
  var HASH_RE = /^[A-Za-z0-9_-]{8,256}$/;   // GoTrue hashed_token (hex) / pkce_<hex>
  var INVITE_RE = /^[0-9a-f]{16,128}$/i;
  var DEFAULTS = { invite: "/login", magiclink: "/login", signup: "/login", email: "/login", email_change: "/login", recovery: "/reset-password?via=confirm" };

  function dec(s) { try { return decodeURIComponent(String(s).replace(/\+/g, "%20")); } catch (e) { return null; } }

  // everything after the first "next=" parameter (it is always the last one), fragment dropped
  function rawNext(search) {
    var s = String(search || "").replace(/^\?/, "");
    var i = s.indexOf("next=");
    while (i > 0 && s.charAt(i - 1) !== "&") i = s.indexOf("next=", i + 5);
    if (i < 0) return "";
    return s.slice(i + 5).split("#")[0];
  }

  // a same-origin path ("/login?invite=…") or null. origin = location.origin of this page.
  function safePath(value, origin) {
    var v = String(value == null ? "" : value).trim();
    if (!v || v.length > 1000) return null;
    if (/[\u0000-\u001f\u007f\\]/.test(v)) return null;          // control chars / backslashes
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {                          // absolute: same origin only
      var u; try { u = new URL(v); } catch (e) { return null; }
      if (!origin || u.origin !== origin) return null;
      v = u.pathname + u.search;
    }
    if (v.charAt(0) !== "/" || v.charAt(1) === "/") return null;   // relative path only, never "//host"
    v = v.split("#")[0];
    if (/^\/auth(-|\/)confirm/i.test(v)) return null;              // no loop back here
    return v;
  }

  // the invite token of a "/login?invite=<hex>" target (or null)
  function inviteOf(path) {
    var m = /^\/login(?:\.html)?\?(.*)$/.exec(String(path || ""));
    if (!m) return null;
    var t = null;
    m[1].split("&").forEach(function (kv) { var p = kv.split("="); if (p[0] === "invite" && INVITE_RE.test(p[1] || "")) t = p[1].toLowerCase(); });
    return t;
  }

  // → { ok: true, tokenHash, type, next, invite } | { ok: false, reason }
  function parse(search, origin) {
    var q; try { q = new URLSearchParams(String(search || "")); } catch (e) { return { ok: false, reason: "bad_link" }; }
    var type = String(q.get("type") || "").toLowerCase();
    var tokenHash = String(q.get("token_hash") || "");
    if (!TYPES[type]) return { ok: false, reason: "bad_type" };
    if (!HASH_RE.test(tokenHash)) return { ok: false, reason: "bad_token" };
    var raw = rawNext(search), d = raw ? dec(raw) : "";
    var sp = d ? safePath(d, origin) : null;
    var next = (sp && sp !== "/") ? sp : DEFAULTS[type];          // an empty {{ .RedirectTo }} is the bare Site URL
    if (type === "recovery") next = DEFAULTS.recovery;            // a reset always goes to the reset page
    return { ok: true, tokenHash: tokenHash, type: type, next: next, invite: inviteOf(next) };
  }

  // add ?key=value to a same-origin path (error codes for the landing page)
  function withParam(path, key, value) {
    var p = String(path || "/login");
    return p + (p.indexOf("?") >= 0 ? "&" : "?") + encodeURIComponent(key) + "=" + encodeURIComponent(String(value));
  }

  var api = { TYPES: TYPES, parse: parse, safePath: safePath, rawNext: rawNext, inviteOf: inviteOf, withParam: withParam, DEFAULTS: DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmAuthConfirm = api;
})(typeof window !== "undefined" ? window : this);
