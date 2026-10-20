/* comms-settings.js — Control Center card (0078): automatic payment reminders, client
   follow-ups, low-stock bell warnings and WhatsApp forwarding. Reads / writes ONLY through
   BPStore.comms (comms_settings_get / comms_settings_set — studio admins). Builds every
   element with the DOM API (never from HTML strings). Hidden when the server is older than 0078. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var $ = function (id) { return document.getElementById(id); };
  var started = false, S = null;

  function chans(emailId, waId) {
    var a = []; if ($(emailId).checked) a.push("email"); if ($(waId).checked) a.push("whatsapp"); return a;
  }
  function setMsg(t, kind) { var m = $("cm_msg"); if (m) { m.textContent = t || ""; m.dataset.kind = kind || ""; } }
  function setErr(t) {
    var box = $("cm_err"); if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (t) { var p = document.createElement("p"); p.className = "cmerr"; p.setAttribute("role", "alert"); p.textContent = t; box.appendChild(p); }
  }

  function preview() {
    var C = global.BPStore.comms, s = C.sample;
    $("cm_pay_prev").textContent = "Preview: " + C.render($("cm_pay_tpl").value.trim() || (S && S.default_pay_template) || "", s);
    $("cm_fu_prev").textContent = "Preview: " + C.render($("cm_fu_tpl").value.trim() || (S && S.default_fu_template) || "", s);
  }

  function rolesTable() {
    var t = $("cm_roles"); if (!t || !S) return;
    Array.prototype.slice.call(t.querySelectorAll("thead,tbody")).forEach(function (n) { t.removeChild(n); });
    var roles = (S.roles || []).filter(function (r) { return r !== "client" && r !== "worker"; });
    var map = (S.wa_forward_roles && typeof S.wa_forward_roles === "object") ? S.wa_forward_roles : {};
    var lbl = (global.BPStore.auth && global.BPStore.auth.admin && global.BPStore.auth.admin.roleLabel) || function (r) { return r; };
    var thead = document.createElement("thead"), hr = document.createElement("tr");
    var th0 = document.createElement("th"); th0.className = "nlbl"; th0.scope = "col"; th0.textContent = "Notification"; hr.appendChild(th0);
    roles.forEach(function (r) { var th = document.createElement("th"); th.scope = "col"; th.textContent = lbl(r); hr.appendChild(th); });
    thead.appendChild(hr); t.appendChild(thead);
    var tb = document.createElement("tbody");
    (S.types || []).forEach(function (ty) {
      var tr = document.createElement("tr");
      var th = document.createElement("th"); th.className = "nlbl"; th.scope = "row"; th.textContent = ty.label || ty.type; tr.appendChild(th);
      roles.forEach(function (r) {
        var td = document.createElement("td"), cb = document.createElement("input");
        cb.type = "checkbox"; cb.dataset.role = r; cb.dataset.type = ty.type;
        cb.setAttribute("aria-label", (ty.label || ty.type) + " on WhatsApp for " + lbl(r));
        cb.checked = Array.isArray(map[r]) && map[r].indexOf(ty.type) !== -1;
        td.appendChild(cb); tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    t.appendChild(tb);
  }

  function paint() {
    var pc = S.pay_channels || [], fc = S.fu_channels || [];
    $("cm_pay_email").checked = pc.indexOf("email") !== -1; $("cm_pay_wa").checked = pc.indexOf("whatsapp") !== -1;
    $("cm_pay_before").value = S.pay_before_days; $("cm_pay_every").value = S.pay_every_days; $("cm_pay_max").value = S.pay_max_overdue;
    $("cm_pay_due").checked = !!S.pay_on_due;
    $("cm_pay_tpl").value = S.pay_template || "";
    $("cm_fu_email").checked = fc.indexOf("email") !== -1; $("cm_fu_wa").checked = fc.indexOf("whatsapp") !== -1;
    $("cm_fu_delay").value = S.fu_delay_days; $("cm_fu_max").value = S.fu_max;
    $("cm_fu_tpl").value = S.fu_template || "";
    $("cm_wa_num").value = S.studio_whatsapp || "";
    rolesTable(); preview();
    setMsg(S.pending ? S.pending + " message" + (S.pending === 1 ? "" : "s") + " waiting to be sent." : "");
  }

  // [input id, label, min, max, saved key]. Ranges are checked here with a message under the field
  // (the HTML carries no min/max/step, so the global number hardener never silently clamps 45 -> 30
  // or turns a pasted "2.5" into 25).
  var NUMS = [["cm_pay_before", "Days before the due date", 0, 30, "pay_before_days"],
    ["cm_pay_every", "Every N days overdue", 1, 30, "pay_every_days"],
    ["cm_pay_max", "Max overdue reminders", 0, 10, "pay_max_overdue"],
    ["cm_fu_delay", "Days after opening", 1, 30, "fu_delay_days"],
    ["cm_fu_max", "Max follow-ups", 1, 5, "fu_max"]];
  var PH = { cm_pay_tpl: ["client", "studio", "event", "label", "amount", "due", "status"], cm_fu_tpl: ["client", "studio", "event"] };
  function F() { return global.HelmCCFields; }
  function grp(id) { var x = $(id); return x && x.closest ? x.closest(".cmchans") : null; }
  // whole number lo..hi; "" / decimals / negative / out of range -> {ok:false, msg}. Leading zeros are fine.
  function whole(raw, lo, hi, label) {
    if (F()) { var r = F().number(raw, { label: label, required: true, integer: true, min: lo, max: hi }); return r.ok ? { ok: true, v: r.value } : { ok: false, msg: r.error }; }
    var x = String(raw == null ? "" : raw).trim(), v = Number(x);
    return x !== "" && /^\d+$/.test(x) && v >= lo && v <= hi ? { ok: true, v: v } : { ok: false, msg: label + " must be a whole number from " + lo + " to " + hi + "." };
  }
  // -> {patch, errs:[[elementId, message, anchorEl?]]}. Every problem is listed (not just the first).
  function collect() {
    var errs = [], patch = {};
    NUMS.forEach(function (d) {
      var r = whole($(d[0]).value, d[2], d[3], d[1]);
      if (r.ok) patch[d[4]] = r.v; else errs.push([d[0], r.msg]);
    });
    var roles = {};
    Array.prototype.slice.call(document.querySelectorAll("#cm_roles input[type=checkbox]")).forEach(function (cb) {
      if (!roles[cb.dataset.role]) roles[cb.dataset.role] = [];
      if (cb.checked) roles[cb.dataset.role].push(cb.dataset.type);
    });
    Object.assign(patch, {
      // r25 (0274): on / off for payment reminders, follow-ups, low stock and WhatsApp copies is switched ONLY in
      // Control Center -> Automations (one place) - this card saves the details and never sends those switches
      pay_channels: chans("cm_pay_email", "cm_pay_wa"), pay_on_due: $("cm_pay_due").checked,
      pay_template: $("cm_pay_tpl").value.trim() || null,
      fu_channels: chans("cm_fu_email", "cm_fu_wa"),
      fu_template: $("cm_fu_tpl").value.trim() || null,
      wa_forward_roles: roles,
      studio_whatsapp: $("cm_wa_num").value.trim() || null,
    });
    [["pay_template", "cm_pay_tpl", "The payment reminder message"], ["fu_template", "cm_fu_tpl", "The follow-up message"]].forEach(function (p) {
      var t = patch[p[0]]; if (!t) return;
      if (/[<>]/.test(t)) { errs.push([p[1], p[2] + " can't contain < or >."]); return; }
      var bad = F() ? F().templatePlaceholders(t, PH[p[1]]) : [];
      if (bad.length) errs.push([p[1], "Helm won't fill in " + bad.join(" ") + " - the client would see it as typed. Use " + PH[p[1]].map(function (k) { return "{" + k + "}"; }).join(" ") + " (lower case, no spaces)."]);
    });
    if (S && S.pay_enabled && !patch.pay_channels.length) errs.push(["cm_pay_email", "Pick at least one channel (E-mail or WhatsApp) for payment reminders.", grp("cm_pay_email")]);
    if (S && S.fu_enabled && !patch.fu_channels.length) errs.push(["cm_fu_email", "Pick at least one channel (E-mail or WhatsApp) for follow-ups.", grp("cm_fu_email")]);
    if (patch.studio_whatsapp) {
      var wd = patch.studio_whatsapp.replace(/\D/g, "");
      if (!/^\+?[0-9\s().-]+$/.test(patch.studio_whatsapp) || wd.length < 8 || wd.length > 15) errs.push(["cm_wa_num", "Enter the studio WhatsApp number with country code, e.g. +91 98765 43210."]);
    } else if (S && S.wa_forward_enabled) errs.push(["cm_wa_num", "WhatsApp copies are switched on (Automations) - keep a studio WhatsApp number, or switch them off there first."]);
    return { patch: patch, errs: errs };
  }

  function fieldErrs(list) {
    var card = $("commsCard");
    if (F()) { F().clearErrors(card); Array.prototype.forEach.call(card.querySelectorAll(".cm-ferr-grp"), function (g) { g.classList.remove("cm-ferr-grp"); }); }
    if (!list.length) return true;
    if (!F()) { setErr(list.map(function (x) { return x[1]; }).join(" ")); var f0 = $(list[0][0]); if (f0 && f0.focus) f0.focus(); return false; }
    list.forEach(function (x) { if (x[2]) x[2].classList.add("cm-ferr-grp"); });
    F().showErrors(list.map(function (x) { return [$(x[0]), x[1], x[2]]; }));
    setErr(list.length > 1 ? "Please fix the " + list.length + " highlighted fields." : "");
    return false;
  }

  var saving = false;
  async function save() {
    if (saving) return;                              // no double submit (Enter + click, or a slow network)
    var c = collect(); setErr("");
    if (!fieldErrs(c.errs)) { setMsg(""); return; }  // values stay as typed
    var btn = $("cm_save"); saving = true; btn.disabled = true; setMsg("Saving…");
    try {
      var r = await global.BPStore.comms.set(c.patch);
      S = Object.assign({}, S, r || {}); paint(); setMsg("Saved.", "ok");
    } catch (e) {
      setMsg(""); setErr((e && e.message) ? "Couldn't save: " + e.message : "Couldn't save — try again.");
    } finally { saving = false; btn.disabled = false; }
  }

  async function init() {
    if (started) return; started = true;
    var card = $("commsCard"); if (!card || !global.BPStore || !global.BPStore.comms) return;
    try { S = await global.BPStore.comms.get(); } catch (e) { S = null; }
    if (!S) return;                                // server older than 0078 / not allowed: keep hidden
    card.hidden = false; paint();
    ["cm_pay_tpl", "cm_fu_tpl"].forEach(function (id) { $(id).addEventListener("input", preview); });
    $("cm_save").addEventListener("click", save);
    ["cm_pay_email", "cm_pay_wa", "cm_fu_email", "cm_fu_wa"].forEach(function (id) { $(id).addEventListener("change", function () {
      var g = $(id).closest(".cmchans"); if (g) g.classList.remove("cm-ferr-grp");
      var first = $(id.indexOf("pay") > 0 ? "cm_pay_email" : "cm_fu_email"); if (F() && first) F().fieldError(first, ""); }); });
  }

  global.HelmCommsSettings = { init: init };
})(typeof window !== "undefined" ? window : globalThis);
