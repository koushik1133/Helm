/* stage-machine-settings.js - Settings "Event stages" card (r23, 0263). Stage rules (warn = default / enforce)
   and whether the stage history shows on the event page + quote flow. Reads / writes ONLY through
   BPStore.stages.settings / setSettings (stage_machine_settings / set_stage_machine_settings - the server re-checks
   studio admin + Settings edit). Hidden on a database without 0263. DOM via textContent only.
   model() is pure and unit-tested. */
(function (global) {
  "use strict";
  var started = false, tries = 0;
  // server answer -> what the card shows
  function model(d) {
    d = d || {};
    var hq = d.hq_guard_mode || "warn";
    var note = hq === "enforce" ? "Helm HQ enforces stage rules for every studio right now."
      : hq === "off" ? "Helm HQ has paused the stage checks for every studio right now (moves are still recorded)."
      : d.tracking === false ? "Stage tracking is paused by Helm HQ right now." : "";
    var n = Number(d.warnings_30d) || 0;
    return { mode: d.guard_mode === "enforce" ? "enforce" : "warn", history: d.show_history !== false, canEdit: !!d.can_edit,
      stats: (n === 0 ? "No out-of-order moves in the last 30 days." : n + " out-of-order move" + (n === 1 ? "" : "s") + " logged in the last 30 days.") + (note ? " " + note : "") };
  }
  function $(id) { return document.getElementById(id); }
  function say(t, k) { var m = $("sm_msg"); if (!m) return; m.className = t ? "msg " + (k || "ok") : ""; m.textContent = t || ""; }
  function paint(d) {
    var m = model(d);
    $("sm_mode").value = m.mode; $("sm_hist").checked = m.history;
    $("sm_mode").disabled = $("sm_hist").disabled = !m.canEdit;
    $("sm_ro").hidden = m.canEdit; $("sm_actions").hidden = !m.canEdit; $("sm_stats").textContent = m.stats;
  }
  async function save() {
    var b = $("sm_save"); b.disabled = true; say("Saving…", "info");
    try {
      var mode = $("sm_mode").value === "enforce" ? "enforce" : "warn";
      if (mode === "enforce" && !global.confirm("Enforce stage rules? A team member's out-of-order stage move will be refused (client links, payments and automatic jobs are never blocked).")) { say(""); return; }
      paint(await global.BPStore.stages.setSettings(mode, $("sm_hist").checked)); say("Saved.", "ok");
    } catch (e) { say(/42501|admin/i.test(String(e && (e.message || e.code))) ? "Only a studio admin can change the stage settings." : "Couldn't save: " + ((e && e.message) || "please try again."), "err"); }
    finally { b.disabled = false; }
  }
  async function init() {
    if (started) return;
    var card = $("smCard"); if (!card) return;
    var B = global.BPStore;
    if (!B || !B.stages || !B.auth || !B.auth.user || !B.auth.user()) { if (++tries < 30) setTimeout(init, 1000); return; }
    started = true;
    var d = null; try { d = await B.stages.settings(); } catch (e) { d = null; }
    if (!d) return;
    paint(d); card.hidden = false;
    $("sm_save").addEventListener("click", save);
  }
  global.HelmStageMachineSettings = { init: init, model: model };
  if (typeof module !== "undefined" && module.exports) module.exports = global.HelmStageMachineSettings;
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 400); });
  else setTimeout(init, 400);
})(typeof window !== "undefined" ? window : globalThis);
