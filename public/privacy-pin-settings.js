/* privacy-pin-settings.js - Settings card (0157): the studio's "Hide amounts" privacy PIN.
   One PIN per studio, kept on the server as a bcrypt hash (never the plain PIN). Default 0000
   until an admin changes it. Reads / writes ONLY through BPStore.privacyPin (privacy_pin_status /
   privacy_pin_set / privacy_pin_reset). Only studio admins get the form; other roles see who can
   change it. DOM API only (no innerHTML, no inline styles or handlers). */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var $ = function (id) { return document.getElementById(id); };
  var started = false, tries = 0, status = null;

  // pure (unit-tested): validate the three boxes -> error text or ""
  function validate(cur, next, again) {
    if (!/^\d{4}$/.test(String(cur || ""))) return "Enter the current 4-digit PIN (0000 if it was never changed).";
    if (!/^\d{4}$/.test(String(next || ""))) return "The new PIN must be exactly 4 digits.";
    if (String(next) !== String(again || "")) return "The two new PINs don't match.";
    if (String(next) === String(cur)) return "The new PIN is the same as the current one.";
    return "";
  }
  // pure (unit-tested): the one-line state under the card title
  function stateText(s) {
    if (!s) return "This setting needs the studio database update (0157). Until then the PIN is 0000.";
    var who = s.can_change ? "" : " Only a studio admin can change it.";
    if (s.is_default) return "Current PIN: the default (0000). Change it so only your team can show amounts." + who;
    var when = "";
    try { if (s.updated_at) when = " on " + new Date(s.updated_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: (function () { try { var B = (typeof window !== "undefined" && window.BPStore) || null, z = B && B.studioTimezone ? B.studioTimezone() : ""; if (z) return z; } catch (e) {} return "Asia/Kolkata"; })() }); } catch (e) {}   // r37: studio zone
    return "A studio PIN is set" + when + "." + (s.can_change ? "" : " Ask your studio admin for it.") + who;
  }
  function errText(e, what) {
    var c = (e && e.code) || "", m = String((e && e.message) || "");
    if (c === "42501") return "Only a studio admin can " + what + " the privacy PIN.";
    if (c === "22023" && m) return m.charAt(0).toUpperCase() + m.slice(1) + ".";
    return "Couldn't " + what + " the PIN. Check your connection and try again.";
  }
  function say(text, kind) { var m = $("pp_msg"); if (!m) return; m.className = text ? "msg " + (kind || "info") : ""; m.textContent = text || ""; }
  function clearInputs() { ["pp_cur", "pp_new", "pp_new2"].forEach(function (id) { var i = $(id); if (i) i.value = ""; }); }
  function digitsOnly(e) { var t = e.target; var v = t.value.replace(/\D/g, "").slice(0, 4); if (v !== t.value) { t.value = v; fieldErr(t.id, "The PIN is digits only (0-9) — other characters were removed."); } else if (t.getAttribute("aria-invalid") === "true") recheck(t.id); }

  // input sweep A: each box shows its own message underneath (HelmCCInputs.pinForm when loaded)
  var FIELDS = { pp_cur: "cur", pp_new: "next", pp_new2: "again" };
  function perField(cur, next, again) {
    var CI = global.HelmCCInputs; if (CI && CI.pinForm) return CI.pinForm(cur, next, again);
    var e = validate(cur, next, again), out = { cur: "", next: "", again: "" };
    if (/current/.test(e) && !/same as/.test(e)) out.cur = e; else if (/match/.test(e)) out.again = e; else if (e) out.next = e;
    return out;
  }
  function fieldErr(id, text) {
    var i = $(id); if (!i) return;
    var mid = id + "_fv", m = $(mid);
    if (!m) { m = document.createElement("p"); m.id = mid; m.className = "fv-msg"; m.setAttribute("aria-live", "polite"); i.parentNode.insertBefore(m, i.nextSibling);
      var d = (i.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean); if (d.indexOf(mid) < 0) { d.push(mid); i.setAttribute("aria-describedby", d.join(" ")); } }
    m.textContent = text || ""; m.hidden = !text;
    if (text) i.setAttribute("aria-invalid", "true"); else i.removeAttribute("aria-invalid");
    if (i.classList) i.classList.toggle("fv-error", !!text);
  }
  function showErrs(errs) { var firstId = null; Object.keys(FIELDS).forEach(function (id) { var t = errs[FIELDS[id]] || ""; fieldErr(id, t); if (t && !firstId) firstId = id; }); return firstId; }
  // once a box shows a message, it is re-checked as the person types (and clears when fixed)
  function recheck(id) { var e = perField($("pp_cur").value, $("pp_new").value, $("pp_new2").value); var k = FIELDS[id]; fieldErr(id, e[k] || "");
    if (id === "pp_new" && $("pp_new2").getAttribute("aria-invalid") === "true") fieldErr("pp_new2", e.again || ""); }
  // a paste is checked BEFORE the 4-character limit cuts it: "123456" must not quietly become 1234
  function onPaste(e) {
    var t = e.target, txt = ""; try { txt = (e.clipboardData || global.clipboardData).getData("text") || ""; } catch (x) { return; }
    var d = String(txt).replace(/[\s\u200B-\u200D\uFEFF]/g, "");
    e.preventDefault(); if (!d) return;
    var v = String(t.value || ""), st = t.selectionStart, en = t.selectionEnd;
    var res = (st == null || en == null) ? d : v.slice(0, st) + d + v.slice(en);
    if (/^\d+$/.test(d) && (/^\d{4}$/.test(d) || /^\d{0,4}$/.test(res))) { t.value = /^\d{4}$/.test(d) ? d : res; t.dispatchEvent(new Event("input", { bubbles: true })); if (t.getAttribute("aria-invalid") !== "true") fieldErr(t.id, ""); return; }
    fieldErr(t.id, /\D/.test(d) ? "That paste has characters other than digits — the PIN is 4 digits (0-9)."
      : d.length > 4 ? "That paste has " + d.length + " digits — the PIN is exactly 4."
      : "Pasting " + d.length + " more digit" + (d.length === 1 ? "" : "s") + " would make " + res.length + " — the PIN is exactly 4. Clear the box and paste again.");
  }
  function clearErrs() { Object.keys(FIELDS).forEach(function (id) { fieldErr(id, ""); }); }

  function paint() {
    $("pp_state").textContent = stateText(status);
    $("pp_form").hidden = !(status && status.can_change);
  }
  async function refresh() {
    try { status = await global.BPStore.privacyPin.status(); } catch (e) { status = status || null; }
    paint();
  }
  async function save() {
    var b = $("pp_save"); if (b.disabled) return;   // already saving (Enter + click)
    var cur = $("pp_cur").value.trim(), next = $("pp_new").value.trim(), again = $("pp_new2").value.trim();
    var errs = perField(cur, next, again), firstId = showErrs(errs);
    if (firstId) { say("", ""); try { $(firstId).focus(); } catch (x) {} return; }
    var bad = validate(cur, next, again); if (bad) { say(bad, "err"); return; }
    b.disabled = true; say("Saving…", "info");
    try {
      var r = await global.BPStore.privacyPin.set(cur, next);
      if (r && r.ok) { clearInputs(); clearErrs(); say("Privacy PIN saved. Everyone in the studio now uses the new PIN to show amounts.", "ok"); await refresh(); }
      else if (r && r.locked_seconds > 0) say("Too many wrong PINs. Try again in " + r.locked_seconds + " seconds.", "err");
      else if (r && r.reason === "wrong_current") { say("", ""); $("pp_cur").value = ""; fieldErr("pp_cur", "The current PIN is wrong. " + (r.tries_left > 0 ? r.tries_left + (r.tries_left === 1 ? " try" : " tries") + " left." : "")); $("pp_cur").focus(); }
      else say("Couldn't save the PIN. Please try again.", "err");
    } catch (e) { say(errText(e, "change"), "err"); }
    finally { b.disabled = false; }
  }
  async function reset() {
    var ask = global.BPUI && global.BPUI.confirm
      ? global.BPUI.confirm("Put the studio's privacy PIN back to 0000? Everyone will use 0000 to show amounts until you choose a new PIN. You will be asked for a code from your two-step app.", { title: "Reset privacy PIN", okLabel: "Reset to 0000", danger: true })
      : Promise.resolve(global.confirm("Put the studio's privacy PIN back to 0000?"));
    if (!(await ask)) return;
    var b = $("pp_reset"); b.disabled = true; say("Resetting…", "info");
    try {
      var r = await global.BPStore.privacyPin.reset();
      if (r && r.ok) { clearInputs(); clearErrs(); say("Privacy PIN reset to 0000. Choose a new one above.", "ok"); await refresh(); }
      else if (r && r.reason === "sign_in_again") say("For safety, the PIN can only be reset within 15 minutes of signing in. Sign out, sign back in, then reset it here.", "warn");
      else say("Couldn't reset the PIN. Please try again.", "err");
    } catch (e) { say(errText(e, "reset"), "err"); }
    finally { b.disabled = false; }
  }
  async function init() {
    if (started) return;
    var card = $("privPinCard"); if (!card) return;
    var B = global.BPStore;
    if (!B || !B.privacyPin || !B.auth || !B.auth.user || !B.auth.user()) { if (++tries < 30) setTimeout(init, 1000); return; }
    started = true;
    try { status = await B.privacyPin.status(); } catch (e) { status = null; }
    card.hidden = false; paint();
    ["pp_cur", "pp_new", "pp_new2"].forEach(function (id) { var i = $(id); if (!i) return; i.addEventListener("input", digitsOnly); i.addEventListener("paste", onPaste);
      i.addEventListener("blur", function () { if (i.value) recheck(id); }); });
    $("pp_save").addEventListener("click", save);
    $("pp_reset").addEventListener("click", reset);
    $("pp_form").addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") { e.preventDefault(); $("pp_save").click(); } });   /* click: the page's unsaved-changes bar listens for it */
  }
  global.HelmPrivacyPinSettings = { init: init, validate: validate, perField: perField, stateText: stateText };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 400); });
  else setTimeout(init, 400);
})(typeof window !== "undefined" ? window : globalThis);
