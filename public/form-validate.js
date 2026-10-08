/* =========================================================================
   HelmValidate — shared inline form validation (owner rules, Oct 2026).

   • Errors appear UNDER the field on blur — never while someone is first typing.
     Once a field has been left (or a submit was tried) it re-checks live, so the
     message disappears as soon as it is fixed.
   • States: default · focus · error (red border + icon + text) · success (green check).
   • Values are trimmed, inner spaces collapsed and any HTML stripped; e-mails are
     lower-cased. Names: letters, spaces, hyphens and apostrophes, max 50.
   • Required fields show " *"; optional ones "(optional)" (call markLabel).
   • Messages are polite and specific. Phones use HelmPhone (phone-input.js).

   HelmValidate.bind(input, {rule:"name"|"email"|"phone"|"text", label, required,
     mobile, max, msgEl, onChange}) → {check(force), reset(), clean()}
   HelmValidate.checkAll([binding…]) → first failing binding (focused) or null.
   Pure rule functions (HelmValidate.rules.*) work in Node for unit tests.
   DOM via createElement + textContent only. CSS lives in theme.css (.fv-*).
   ========================================================================= */
(function (global) {
  "use strict";

  function stripHtml(v) {
    return String(v == null ? "" : v).replace(/<[^>]*>/g, "").replace(/[<>]/g, "");
  }
  function clean(v) { return stripHtml(v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(); }

  var NAME_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M} '’-]*[\p{L}\p{M}])?$/u;
  var EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,}$/;

  function lc(label) { return String(label || "this field").replace(/^./, function (c) { return c.toLowerCase(); }); }

  var rules = {
    // → {ok, value, error}
    name: function (v, o) {
      o = o || {}; var s = clean(v).replace(/’/g, "'");
      if (!s) return o.required ? { ok: false, error: "Please enter " + (o.article === false ? "" : "your ") + lc(o.label || "name") + "." } : { ok: true, value: "" };
      var max = o.max || 50;
      if ([...s].length > max) return { ok: false, error: "Please keep " + lc(o.label || "the name") + " to " + max + " characters or fewer." };
      if (!NAME_RE.test(s)) return { ok: false, error: "Names can use letters, spaces, hyphens (-) and apostrophes (') only." };
      if (/[-']{2,}|\s[-']|[-']\s/.test(s)) return { ok: false, error: "That doesn't look like a name — check the hyphens and apostrophes." };
      return { ok: true, value: s };
    },
    email: function (v, o) {
      o = o || {}; var s = clean(v).toLowerCase();
      if (!s) return o.required ? { ok: false, error: "Please enter your e-mail address." } : { ok: true, value: "" };
      if (s.length > 254 || !EMAIL_RE.test(s) || s.split("@")[0].length > 64 || /\.\./.test(s))
        return { ok: false, error: "Please enter an e-mail address like name@example.com." };
      return { ok: true, value: s };
    },
    text: function (v, o) {
      o = o || {}; var s = clean(v);
      if (!s) return o.required ? { ok: false, error: "Please enter " + lc(o.label) + "." } : { ok: true, value: "" };
      var max = o.max || 80;
      if ([...s].length > max) return { ok: false, error: "Please keep " + lc(o.label) + " to " + max + " characters or fewer." };
      return { ok: true, value: s };
    },
    phone: function (v, o) {
      o = o || {};
      var HP = global.HelmPhone;
      if (!HP) { var d = String(v || "").replace(/\D/g, ""); return !d ? (o.required ? { ok: false, error: "Please enter a phone number." } : { ok: true, value: "" }) : (d.length >= 7 && d.length <= 15 ? { ok: true, value: "+" + d } : { ok: false, error: "Phone numbers have 7–15 digits including the country code." }); }
      var r = (o.phone && o.phone.validate) ? o.phone.validate({ mobile: !!o.mobile, required: !!o.required })
        : HP.validate(v, { mobile: !!o.mobile, required: !!o.required, country: o.country });
      if (!r.ok && r.empty && o.required) return { ok: false, error: o.requiredMsg || ("Please enter " + (o.label ? "your " + lc(o.label) : "a phone number") + ".") };
      return r.ok ? { ok: true, value: r.e164 || "" } : { ok: false, error: r.error };
    },
  };

  var api = { rules: rules, clean: clean, stripHtml: stripHtml };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") { global.HelmValidate = api; return; }

  var doc = document, n = 0;
  function el(tag, cls, text) { var x = doc.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
  function labelOf(input) {
    if (input.id) { var l = doc.querySelector('label[for="' + (global.CSS && CSS.escape ? CSS.escape(input.id) : input.id) + '"]'); if (l) return l; }
    return input.closest ? input.closest("label") : null;
  }
  // " *" for required, " (optional)" otherwise — idempotent
  function markLabel(input, required) {
    var lab = labelOf(input); if (!lab) return;
    var old = lab.querySelector(".req-star, .fv-opt"); if (old) old.remove();
    if (lab.textContent.indexOf("*") >= 0 && required) return;
    var s = required ? el("span", "req-star", " *") : el("span", "fv-opt", " (optional)");
    if (required) s.setAttribute("aria-hidden", "true");
    lab.appendChild(s);
    if (required) input.setAttribute("aria-required", "true");
  }

  function bind(input, opts) {
    var o = opts || {};
    if (!input) return null;
    if (input._fv) return input._fv;
    var rule = rules[o.rule] || rules.text;
    var box = o.box || (input.helmPhone ? input.helmPhone.wrap : input);
    var touched = false;
    var msg = o.msgEl;
    if (!msg) {
      msg = el("p", "fv-msg"); msg.id = (input.id || "fv" + (++n)) + "_fv";
      var after = box; after.parentNode.insertBefore(msg, after.nextSibling);
    }
    msg.classList.add("fv-msg"); if (!msg.id) msg.id = "fv" + (++n) + "_m";
    msg.setAttribute("aria-live", "polite");
    var desc = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
    if (desc.indexOf(msg.id) < 0) { desc.push(msg.id); input.setAttribute("aria-describedby", desc.join(" ")); }
    if (typeof o.required === "boolean") markLabel(input, o.required);

    function req() { return typeof o.required === "function" ? !!o.required() : !!o.required; }
    function setState(state, text) {
      box.classList.toggle("fv-error", state === "error");
      box.classList.toggle("fv-ok", state === "ok");
      if (state === "error") input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
      while (msg.firstChild) msg.removeChild(msg.firstChild);
      if (state === "error" && text) { var ic = el("span", "fv-ic", "!"); ic.setAttribute("aria-hidden", "true"); msg.appendChild(ic); msg.appendChild(doc.createTextNode(text)); }
      msg.hidden = state !== "error";
    }
    function run() {
      return rule(input.value, { label: o.label, required: req(), mobile: o.mobile, max: o.max, phone: input.helmPhone, requiredMsg: o.requiredMsg, article: o.article });
    }
    function check(force) {
      if (force) touched = true;
      var r = run();
      if (!touched) { setState("none"); return r; }
      if (!r.ok) setState("error", r.error);
      else setState(r.value ? "ok" : "none");
      return r;
    }
    // normalise what's in the box (trim / lower-case / strip HTML) — never for phones (HelmPhone formats itself)
    function tidy() {
      if (o.rule === "phone" || input.helmPhone) return;
      var r = run(); if (r.ok && r.value !== undefined && input.value !== r.value) input.value = r.value;
    }
    input.addEventListener("blur", function () {
      // the country list lives inside the phone wrapper: don't flag the field while it's in use
      setTimeout(function () {
        if (input.helmPhone && input.helmPhone.wrap.contains(doc.activeElement)) return;
        if (!touched && !String(input.value || "").trim() && !o.validateEmptyOnBlur) return;   // tabbing past an empty field isn't an error yet
        touched = true; tidy(); check(); if (o.onChange) o.onChange();
      }, 0);
    });
    input.addEventListener("input", function () { if (touched) check(); if (o.onChange) o.onChange(); });
    input.addEventListener("change", function () { if (touched) check(); });
    var b = { input: input, box: box, msg: msg, check: check, reset: function () { touched = false; setState("none"); },
      value: function () { var r = run(); return r.ok ? r.value : null; },
      setError: function (t) { touched = true; setState(t ? "error" : "none", t); }, focus: function () { try { input.focus(); } catch (e) {} } };
    input._fv = b;
    setState("none");
    return b;
  }
  function checkAll(list) {
    var first = null;
    (list || []).forEach(function (b) { if (!b) return; var r = b.check(true); if (!r.ok && !first) first = b; });
    if (first) first.focus();
    return first;
  }
  api.bind = bind; api.checkAll = checkAll; api.markLabel = markLabel;
  global.HelmValidate = api;
})(typeof window !== "undefined" ? window : globalThis);
