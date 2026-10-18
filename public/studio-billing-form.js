/* studio-billing-form.js - Control Center > General: billing-details form helpers.
 *
 * In plain words:
 *  - PIN / postal code: India takes digits only, at most 6 (numeric keypad on phones);
 *    the UAE P.O. box takes digits only (up to 6); other countries letters, digits,
 *    spaces and dashes (up to 10). Only what the person TYPES or PASTES is cleaned -
 *    a value already saved is never rewritten just by being shown.
 *  - State: India shows a dropdown of the 28 states + 8 union territories. A saved
 *    value that is not in the list stays selected as "(as saved)" so nothing is lost.
 *  - Errors are shown under the field itself (red border, message, focus + scroll),
 *    not at the top of the card.
 *  - The "still missing" list is recomputed from what is on screen / what was saved.
 * Pure helpers work in Node (tests); the DOM helpers use createElement/textContent only.
 */
(function (global) {
  "use strict";

  function code(cc) { var c = String(cc || "").trim().toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : "IN"; }

  // ---- PIN / postal code ---------------------------------------------------------------------
  function postalRule(cc) {
    cc = code(cc);
    if (cc === "IN") return { kind: "pin", maxlength: 6, inputmode: "numeric", pattern: "[1-9][0-9]{5}", placeholder: "6-digit PIN" };
    if (cc === "AE") return { kind: "pobox", maxlength: 6, inputmode: "numeric", pattern: "[0-9]{1,6}", placeholder: "P.O. box number (optional)" };
    return { kind: "postal", maxlength: 10, inputmode: "text", pattern: "", placeholder: "Postal code" };
  }
  // what a typed / pasted value becomes for that country
  function postalSanitize(cc, v) {
    var r = postalRule(cc), s = String(v == null ? "" : v);
    if (r.kind === "pin" || r.kind === "pobox") return s.replace(/\D+/g, "").slice(0, r.maxlength);
    return s.toUpperCase().replace(/[^A-Z0-9 -]+/g, "").replace(/^[ -]+/, "").slice(0, r.maxlength);
  }

  // ---- State dropdown (India) ----------------------------------------------------------------
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z]/g, ""); }
  // regions: [{name}] -> { options:[{value,label}], value } ; the saved value is always kept
  function stateChoice(regions, saved) {
    var list = (regions || []).map(function (r) { return { value: r.name, label: r.name }; });
    var v = String(saved == null ? "" : saved).trim(), pick = "";
    if (v) {
      for (var i = 0; i < list.length; i++) if (list[i].value === v) { pick = v; break; }
      if (!pick) for (var j = 0; j < list.length; j++) if (norm(list[j].value) === norm(v)) { pick = list[j].value; break; }
      if (!pick) { list.unshift({ value: v, label: v + " (as saved)" }); pick = v; }
    }
    return { options: [{ value: "", label: "Select state / union territory" }].concat(list), value: pick };
  }

  // ---- what is still missing ------------------------------------------------------------------
  // OB = HelmOnboarding; vals = billing form values. Labels of required fields still empty / invalid.
  function missingFromValues(OB, vals) {
    if (!OB) return [];
    var r = OB.validateBilling(vals || {});
    return OB.BILLING_FIELDS.filter(function (f) { return r.errors[f.key]; }).map(function (f) { return f.label; });
  }
  // the one message shown after a save (never a green "saved" next to a stale yellow "missing")
  function afterSaveMessage(missing) {
    if (!missing || !missing.length) return { kind: "ok", text: "Studio settings saved." };
    return { kind: "warn", text: "Studio settings saved. To show billing details on quotations and invoices, still fill in: " + missing.join(", ") + "." };
  }
  function promptText(missing) {
    return missing && missing.length ? "Please complete your studio's billing details so they appear on quotations and invoices. Missing: " + missing.join(", ") + "." : "";
  }

  var api = { postalRule: postalRule, postalSanitize: postalSanitize, stateChoice: stateChoice, missingFromValues: missingFromValues,
    afterSaveMessage: afterSaveMessage, promptText: promptText };

  if (typeof document !== "undefined") {
    // ---- inline field errors --------------------------------------------------------------------
    // the box that gets the red border: the phone widget wrapper (.hp) or the control itself
    var box = function (el) { return (el && el.closest && el.closest(".hp")) || el; };
    var errId = function (el) { return (el.id || "fld") + "_ferr"; };
    api.clearError = function (el) {
      if (!el) return; el.removeAttribute("aria-invalid"); var b = box(el); if (b) b.classList.remove("is-invalid");
      var e = document.getElementById(errId(el)); if (e) { e.textContent = ""; e.hidden = true; }
      var d = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(function (x) { return x && x !== errId(el); }).join(" ");
      if (d) el.setAttribute("aria-describedby", d); else el.removeAttribute("aria-describedby");
    };
    api.setError = function (el, msg) {
      if (!el) return; var b = box(el), id = errId(el), e = document.getElementById(id);
      if (!e) { e = document.createElement("div"); e.id = id; e.className = "ferr"; b.insertAdjacentElement("afterend", e); }
      e.textContent = String(msg || ""); e.hidden = false;
      el.setAttribute("aria-invalid", "true"); b.classList.add("is-invalid");
      var d = (el.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
      if (d.indexOf(id) < 0) d.push(id); el.setAttribute("aria-describedby", d.join(" "));
      if (!el.__ferrBound) { el.__ferrBound = true;
        var clr = function () { if (el.getAttribute("aria-invalid") === "true") api.clearError(el); };
        el.addEventListener("input", clr); el.addEventListener("change", clr); }
    };
    // errs: [{el, msg}] -> mark every field, focus + scroll the first one in page order
    api.showErrors = function (errs) {
      var list = (errs || []).filter(function (x) { return x && x.el; });
      list.forEach(function (x) { api.setError(x.el, x.msg); });
      list.sort(function (a, b) { return a.el === b.el ? 0 : (a.el.compareDocumentPosition(b.el) & 4) ? -1 : 1; });
      var first = list[0] && list[0].el;
      if (first) {
        try { box(first).scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { try { first.scrollIntoView(); } catch (e2) {} }
        try { first.focus({ preventScroll: true }); } catch (e) { try { first.focus(); } catch (e2) {} }
      }
      return list.length;
    };
    api.clearAll = function (root) {
      if (!root) return; root.querySelectorAll('[aria-invalid="true"]').forEach(function (el) { api.clearError(el); });
    };
    // PIN / postal input: clean what is typed or pasted for the current country
    api.bindPostal = function (el, getCountry) {
      if (!el || el.__postalBound) return; el.__postalBound = true;
      el.addEventListener("input", function () {
        var v = el.value, c = postalSanitize(getCountry(), v);
        if (c !== v) { el.value = c; try { el.setSelectionRange(c.length, c.length); } catch (e) {} }
      });
    };
    api.paintPostal = function (el, cc) {
      if (!el) return; var r = postalRule(cc);
      el.setAttribute("maxlength", String(r.maxlength)); el.setAttribute("inputmode", r.inputmode);
      if (r.pattern) el.setAttribute("pattern", r.pattern); else el.removeAttribute("pattern");
      el.setAttribute("placeholder", r.placeholder);
    };
    // India: the select is shown and mirrors into the (hidden) text input that everything reads
    api.paintState = function (input, select, label, regions, useSelect) {
      if (!input || !select) return;
      if (useSelect) {
        var ch = stateChoice(regions, input.value); select.textContent = "";
        ch.options.forEach(function (o) { var op = document.createElement("option"); op.value = o.value; op.textContent = o.label; select.appendChild(op); });
        select.value = ch.value; select.hidden = false; input.hidden = true;
        if (input.getAttribute("aria-invalid") === "true") api.clearError(input);
        if (label) label.htmlFor = select.id;
      } else {
        select.hidden = true; input.hidden = false; if (select.getAttribute("aria-invalid") === "true") api.clearError(select);
        if (label) label.htmlFor = input.id;
      }
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.HelmBillingForm = api;
})(typeof window !== "undefined" ? window : globalThis);
