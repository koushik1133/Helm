/* target-margin-settings.js - Settings "Target margin" card (r21, 0242). ONE studio-wide target margin %
   that the Insights "Benchmarks" card uses to colour events green / amber / red (was saved per device).
   Reads / writes ONLY through BPStore.insights.targetMargin / setTargetMargin (get_studio_target_margin /
   set_studio_target_margin - the server re-checks Settings EDIT and the 0 to 90 range). Shown to anyone the
   server answers (Insights or Settings view); read-only unless can_edit. Hidden when the server is older
   than 0242. DOM via textContent only (no HTML strings). validate() is pure and unit-tested. */
(function (global) {
  "use strict";
  var DEFAULT = 30, MIN = 0, MAX = 90;
  var started = false, tries = 0, saved = null, canEdit = false;
  var wantFocus = (function () { try { return /^#target-margin$/i.test(global.location && global.location.hash || ""); } catch (e) { return false; } })();
  // pure: raw text from the box -> { ok, value, error }
  function validate(raw) {
    var t = String(raw == null ? "" : raw).trim().replace(/%$/, "").trim();
    if (t === "") return { ok: false, value: null, error: "Enter a target margin from 0 to 90." };
    if (!/^\d{1,2}(\.\d+)?$/.test(t)) return { ok: false, value: null, error: "Use a number from 0 to 90, e.g. 30 or 27.5." };
    var n = Number(t);
    if (!isFinite(n) || n < MIN || n > MAX) return { ok: false, value: null, error: "The target margin must be from 0 to 90." };
    return { ok: true, value: Math.round(n * 10) / 10, error: "" };
  }
  function $(id) { return document.getElementById(id); }
  function say(text, kind) { var m = $("tm_msg"); if (!m) return; m.className = text ? "msg " + (kind || "ok") : ""; m.textContent = text || ""; }
  function fieldErr(text) {
    var i = $("tm_pct"), m = $("tm_err"); if (!i || !m) return;
    m.textContent = text || ""; m.hidden = !text;
    if (text) i.setAttribute("aria-invalid", "true"); else i.removeAttribute("aria-invalid");
    i.classList.toggle("fv-error", !!text);
  }
  function errText(e) {
    var s = String((e && (e.message || e.code)) || "");
    if (/not authori[sz]ed|42501|Only a studio admin/i.test(s)) return "Only a studio admin (or someone allowed to edit Settings) can change the target margin.";
    if (e && e.code === "target_margin_missing") return e.message;
    if (/0 to 90|22023/.test(s)) return "The target margin must be from 0 to 90.";
    return "Couldn't save the target margin: " + (s || "please try again.");
  }
  function paint(d) {
    var i = $("tm_pct"); canEdit = !!(d && d.can_edit);
    saved = d && d.target_margin_pct != null ? Number(d.target_margin_pct) : null;
    i.value = String(saved != null ? saved : DEFAULT); i.disabled = !canEdit;
    $("tm_ro").hidden = canEdit; $("tm_actions").hidden = !canEdit;
    if (saved == null) say("Not set yet: Insights uses the " + DEFAULT + "% default.", "info");
  }
  async function save() {
    if (!canEdit) return;
    var v = validate($("tm_pct").value); fieldErr(v.error);
    if (!v.ok) { $("tm_pct").focus(); return; }
    var b = $("tm_save"); b.disabled = true; say("Saving…", "info");
    try {
      var d = await global.BPStore.insights.setTargetMargin(v.value);
      paint(d || { target_margin_pct: v.value, can_edit: true });
      say("Saved. Insights benchmarks use a " + (saved != null ? saved : v.value) + "% target for everyone in the studio.", "ok");
    } catch (e) { say(errText(e), "err"); }
    finally { b.disabled = false; }
  }
  async function init() {
    if (started) return;
    var card = $("tmCard"); if (!card) return;
    var B = global.BPStore;
    if (!B || !B.insights || !B.insights.targetMargin || !B.auth || !B.auth.user || !B.auth.user()) { if (++tries < 30) setTimeout(init, 1000); return; }
    started = true;
    var d = null;
    try { d = await B.insights.targetMargin(); } catch (e) { d = null; }   // not allowed / older server: card stays hidden
    if (!d) return;
    paint(d); card.hidden = false;
    var i = $("tm_pct");
    i.addEventListener("input", function () { if (i.getAttribute("aria-invalid") === "true") fieldErr(validate(i.value).error); });
    i.addEventListener("blur", function () { if (i.value !== "") fieldErr(validate(i.value).error); });
    i.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); $("tm_save").click(); } });
    $("tm_save").addEventListener("click", save);
    if (wantFocus) setTimeout(function () { try { card.scrollIntoView({ block: "center" }); if (canEdit) i.focus({ preventScroll: true }); } catch (e) {} }, 300);
  }
  global.HelmTargetMarginSettings = { init: init, validate: validate, DEFAULT: DEFAULT };
  if (typeof module !== "undefined" && module.exports) module.exports = global.HelmTargetMarginSettings;
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 400); });
  else setTimeout(init, 400);
})(typeof window !== "undefined" ? window : globalThis);
