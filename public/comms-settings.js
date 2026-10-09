/* comms-settings.js — Control Center card (0078): automatic payment reminders, client
   follow-ups, low-stock bell warnings and WhatsApp forwarding. Reads / writes ONLY through
   BPStore.comms (comms_settings_get / comms_settings_set — studio admins). Builds every
   element with the DOM API (never from HTML strings). Hidden when the server is older than 0078. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var $ = function (id) { return document.getElementById(id); };
  var started = false, S = null;

  function num(id, lo, hi, dflt) {
    var raw = String($(id).value == null ? "" : $(id).value).trim();
    if (raw === "") return { ok: false, v: dflt };   // blank must not silently save as 0
    var v = Number(raw);
    if (!Number.isInteger(v) || v < lo || v > hi) return { ok: false, v: dflt };
    return { ok: true, v: v };
  }
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
    var roles = (S.roles || []).filter(function (r) { return r !== "client"; });
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
    $("cm_pay_on").checked = !!S.pay_enabled;
    var pc = S.pay_channels || [], fc = S.fu_channels || [];
    $("cm_pay_email").checked = pc.indexOf("email") !== -1; $("cm_pay_wa").checked = pc.indexOf("whatsapp") !== -1;
    $("cm_pay_before").value = S.pay_before_days; $("cm_pay_every").value = S.pay_every_days; $("cm_pay_max").value = S.pay_max_overdue;
    $("cm_pay_due").checked = !!S.pay_on_due;
    $("cm_pay_tpl").value = S.pay_template || "";
    $("cm_fu_on").checked = !!S.fu_enabled;
    $("cm_fu_email").checked = fc.indexOf("email") !== -1; $("cm_fu_wa").checked = fc.indexOf("whatsapp") !== -1;
    $("cm_fu_delay").value = S.fu_delay_days; $("cm_fu_max").value = S.fu_max;
    $("cm_fu_tpl").value = S.fu_template || "";
    $("cm_low_on").checked = S.low_stock_enabled !== false;
    $("cm_wa_num").value = S.studio_whatsapp || "";
    $("cm_wa_on").checked = !!S.wa_forward_enabled;
    rolesTable(); preview();
    setMsg(S.pending ? S.pending + " message" + (S.pending === 1 ? "" : "s") + " waiting to be sent." : "");
  }

  function collect() {
    var bad = null, n = function (id, lo, hi, d, name) { var r = num(id, lo, hi, d); if (!r.ok && !bad) bad = name + " must be a whole number from " + lo + " to " + hi + "."; return r.v; };
    var roles = {};
    Array.prototype.slice.call(document.querySelectorAll("#cm_roles input[type=checkbox]")).forEach(function (cb) {
      if (!roles[cb.dataset.role]) roles[cb.dataset.role] = [];
      if (cb.checked) roles[cb.dataset.role].push(cb.dataset.type);
    });
    var patch = {
      pay_enabled: $("cm_pay_on").checked, pay_channels: chans("cm_pay_email", "cm_pay_wa"),
      pay_before_days: n("cm_pay_before", 0, 30, 3, "Days before the due date"), pay_on_due: $("cm_pay_due").checked,
      pay_every_days: n("cm_pay_every", 1, 30, 3, "Every N days overdue"), pay_max_overdue: n("cm_pay_max", 0, 10, 3, "Max overdue reminders"),
      pay_template: $("cm_pay_tpl").value.trim() || null,
      fu_enabled: $("cm_fu_on").checked, fu_channels: chans("cm_fu_email", "cm_fu_wa"),
      fu_delay_days: n("cm_fu_delay", 1, 30, 3, "Days after opening"), fu_max: n("cm_fu_max", 1, 5, 2, "Max follow-ups"),
      fu_template: $("cm_fu_tpl").value.trim() || null,
      low_stock_enabled: $("cm_low_on").checked,
      wa_forward_enabled: $("cm_wa_on").checked, wa_forward_roles: roles,
      studio_whatsapp: $("cm_wa_num").value.trim() || null,
    };
    [["pay_template", "Payment reminder message"], ["fu_template", "Follow-up message"]].forEach(function (p) {
      if (!bad && patch[p[0]] && /[<>]/.test(patch[p[0]])) bad = p[1] + " can't contain < or >.";
    });
    if (!bad && patch.pay_enabled && !patch.pay_channels.length) bad = "Pick at least one channel for payment reminders.";
    if (!bad && patch.fu_enabled && !patch.fu_channels.length) bad = "Pick at least one channel for follow-ups.";
    if (!bad && patch.studio_whatsapp) {
      var wd = patch.studio_whatsapp.replace(/\D/g, "");
      if (!/^\+?[0-9\s().-]+$/.test(patch.studio_whatsapp) || wd.length < 8 || wd.length > 15) bad = "Enter the studio WhatsApp number with country code, e.g. +91 98765 43210.";
    }
    if (!bad && patch.wa_forward_enabled && !patch.studio_whatsapp) bad = "Add the studio WhatsApp number before switching forwarding on.";
    return { patch: patch, bad: bad };
  }

  async function save() {
    var c = collect(); setErr("");
    if (c.bad) { setErr(c.bad); return; }
    var btn = $("cm_save"); btn.disabled = true; setMsg("Saving…");
    try {
      var r = await global.BPStore.comms.set(c.patch);
      S = Object.assign({}, S, r || {}); paint(); setMsg("Saved.", "ok");
    } catch (e) {
      setMsg(""); setErr((e && e.message) ? "Couldn't save: " + e.message : "Couldn't save — try again.");
    } finally { btn.disabled = false; }
  }

  async function init() {
    if (started) return; started = true;
    var card = $("commsCard"); if (!card || !global.BPStore || !global.BPStore.comms) return;
    try { S = await global.BPStore.comms.get(); } catch (e) { S = null; }
    if (!S) return;                                // server older than 0078 / not allowed: keep hidden
    card.hidden = false; paint();
    ["cm_pay_tpl", "cm_fu_tpl"].forEach(function (id) { $(id).addEventListener("input", preview); });
    $("cm_save").addEventListener("click", save);
  }

  global.HelmCommsSettings = { init: init };
})(typeof window !== "undefined" ? window : globalThis);
