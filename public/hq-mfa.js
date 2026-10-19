/* hq-mfa.js - r21 (0249): the pure model behind HQ -> Overview -> "HQ two-step readiness".
   Input: hq_mfa_readiness() (0249), or - on a database without 0249 - the older hq_operators() list plus the
   operator_mfa_required() switch (fallback). Output: what the card says. No DOM, no network (unit-tested). */
(function (root) {
  "use strict";
  function arr(v) { return Array.isArray(v) ? v : []; }
  // r = hq_mfa_readiness() | null; ops = hq_operators() rows (fallback); required = operator_mfa_required() (fallback)
  function model(r, ops, required) {
    var src = r && typeof r === "object" && Array.isArray(r.operators) ? "readiness" : "fallback";
    var rows = src === "readiness"
      ? arr(r.operators).map(function (o) { return { email: String(o.email || ""), login: o.has_login !== false, twoStep: !!o.has_2step, me: !!o.is_me }; })
      : arr(ops).map(function (o) { return { email: String(o.email || ""), login: !!o.last_sign_in_at || !!o.bound, twoStep: !!o.mfa_enabled, me: !!o.is_me }; });
    var on = src === "readiness" ? r.hq_require_mfa === true : required === true;
    var blocking = rows.filter(function (o) { return o.login && !o.twoStep; });
    var pending = rows.filter(function (o) { return !o.login; });
    var withIt = rows.filter(function (o) { return o.twoStep; });
    var me = rows.filter(function (o) { return o.me; })[0] || null;
    var safe = blocking.length === 0 && withIt.length > 0;
    var state = on ? { text: "Required", tone: "ok" } : safe ? { text: "Ready - not required yet", tone: "ok" } : { text: "Optional - not ready", tone: "warn" };
    var hint = on
      ? "Two-step is required for HQ. Every operator signs in with a code from their authenticator app."
      : safe
        ? "Every operator with a login has two-step. The owner can now require it (see the security steps document) - nobody will be locked out."
        : "Two-step is optional for HQ today. Before it can be required, every operator below marked \"needs set-up\" must set it up. The database refuses the switch until then, so nobody can be locked out.";
    var lines = rows.map(function (o) {
      return { email: o.email, me: o.me, label: o.twoStep ? "two-step on" : (o.login ? "needs set-up" : "never signed in (asked at first sign-in)"),
        tone: o.twoStep ? "ok" : (o.login ? "warn" : "") };
    });
    var admins = null;
    if (src === "readiness" && r.studio_admins && typeof r.studio_admins === "object") {
      var t = Math.max(0, Number(r.studio_admins.total) || 0), w = Math.max(0, Number(r.studio_admins.with_2step) || 0);
      admins = "Studio admins with two-step: " + w + " of " + t + ". When studio admins are required to use it (config.js mfaRequiredForAdmins), the others are asked to set it up at their next sign-in.";
    }
    return { source: src, on: on, safe: safe, state: state, hint: hint, lines: lines, admins: admins,
      blocking: blocking.length, pending: pending.length, showEnroll: !!(me && !me.twoStep) };
  }
  var api = { model: model };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmHqMfa = api;
})(typeof window !== "undefined" ? window : this);
