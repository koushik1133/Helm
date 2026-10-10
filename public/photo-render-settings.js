/* photo-render-settings.js - Control Center card (0095): photo renders on / off, photos per month,
   render requests per hour, this month's usage + cost estimate. Reads / writes ONLY through
   BPStore.photoRender.settings / setSettings (photo_render_settings_get / _set; Control Center EDIT).
   DOM API only. Hidden for people who can't manage it and on servers older than 0095. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var $ = function (id) { return document.getElementById(id); };
  var started = false, tries = 0;

  function paint(s) {
    $("pr_on").checked = s.enabled !== false;
    $("pr_quota").value = String(s.monthly_quota != null ? s.monthly_quota : 60);
    $("pr_hourly").value = String(s.hourly_limit != null ? s.hourly_limit : 20);
    $("pr_status").textContent = "This month: " + (s.used_this_month || 0) + " photos made, about US$" +
      Number(s.cost_this_month_usd || 0).toFixed(2) + " (estimate). If photos aren’t available in the builder yet, contact Helm support to switch them on.";
  }
  async function save() {
    var q = Number($("pr_quota").value), h = Number($("pr_hourly").value), m = $("pr_msg");
    if (!Number.isInteger(q) || q < 0 || q > 10000) { m.textContent = "Photos per month must be a whole number from 0 to 10000."; return; }
    if (!Number.isInteger(h) || h < 1 || h > 500) { m.textContent = "Requests per hour must be a whole number from 1 to 500."; return; }
    var b = $("pr_save"); b.disabled = true; m.textContent = "Saving…";
    try { paint(await global.BPStore.photoRender.setSettings($("pr_on").checked, q, h) || {}); m.textContent = "Saved."; }
    catch (e) { m.textContent = (e && e.code === "42501") ? "You don't have permission to change these settings." : "Couldn't save — please try again."; }
    finally { b.disabled = false; }
  }
  async function init() {
    if (started) return;
    var card = $("prCard"); if (!card) return;
    var B = global.BPStore;
    if (!B || !B.photoRender || !B.auth || !B.auth.user || !B.auth.user()) { if (++tries < 30) setTimeout(init, 1000); return; }
    started = true;
    var s = null;
    try { s = await B.photoRender.settings(); } catch (e) { s = null; }
    if (!s || !s.can_manage) return;               // older server / not a manager: keep hidden
    card.hidden = false; paint(s);
    $("pr_save").addEventListener("click", save);
  }
  global.HelmPhotoRenderSettings = { init: init };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 500); });
  else setTimeout(init, 500);
})(typeof window !== "undefined" ? window : globalThis);
