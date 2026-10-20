/* payment-schedule-settings.js - Control Center "Payment schedules" card (r23, 0264).
   - Add the default schedule automatically when a client approves (default on), overdue bell (default on),
     the default schedule (built-in 30/50/20, 50/50, 100% upfront, or the studio's own),
   - how clients pay (UPI ID + a short payment note, shown on the client page and in every reminder),
   - the studio's own schedules: add / change / archive (never deleted), with a live example on Rs 1,00,000.
   Reads / writes ONLY through BPStore.paySchedule (payment_schedule_settings_get / _set / template_save / _archive;
   the server re-checks Control Center EDIT and every rule). Shown to anyone the server answers (Control Center or
   Finance view); read-only unless can_edit. Hidden when the server is older than 0264. DOM API only. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var started = false, tries = 0, S = null, editing = null;
  var wantFocus = (function () { try { return /^#payment-schedules?$/i.test(global.location && global.location.hash || ""); } catch (e) { return false; } })();
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function PS() { return global.HelmPaySchedule; }
  function say(t, kind) { var m = $("pst_msg"); if (m) { m.textContent = t || ""; m.dataset.kind = kind || ""; } }
  function errText(e) {
    var s = String((e && (e.message || e.code)) || "");
    if (/not authori[sz]ed|42501/i.test(s)) return "Only a studio admin (or someone allowed to edit Control Center) can change payment schedules.";
    return s || "Couldn't save - please try again.";
  }
  function money(n) { var B = global.BPStore; try { if (B && B.studioMoney) return B.studioMoney(n); } catch (e) {} return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN"); }
  function dueText(l) {
    var d = Number(l.offset_days) || 0;
    if (l.anchor === "event") return d === 0 ? "on the event day" : d < 0 ? (-d) + (d === -1 ? " day" : " days") + " before the event" : d + (d === 1 ? " day" : " days") + " after the event";
    return d === 0 ? "on approval" : d + (d === 1 ? " day" : " days") + " after approval";
  }
  function amtText(l) { return l.kind === "balance" ? "the balance" : l.kind === "fixed" ? money(l.value) : (Number(l.value) || 0) + "%"; }
  function summary(lines) { return (lines || []).map(function (l) { return amtText(l) + " " + dueText(l); }).join(" · "); }
  function allTemplates() { return (S.builtins || []).concat(S.templates || []); }
  function remText(r) {
    if (!r) return "";
    var line = PS() ? PS().reminderLine({ enabled: r.enabled, before_days: r.before_days, on_due: r.on_due, every_days: r.every_days, max_overdue: r.max_overdue }, false) : "";
    return line + " Change the timing and the message in Reminders & client messages.";
  }

  function paintDefault() {
    var sel = $("pst_default"); while (sel.firstChild) sel.removeChild(sel.firstChild);
    allTemplates().forEach(function (t) {
      var o = el("option", "", t.name + (t.builtin ? " (built in)" : "")); o.value = t.key; if (t.key === S.default_template) o.selected = true; sel.appendChild(o);
    });
  }
  function paintList() {
    var box = $("pst_list"); while (box.firstChild) box.removeChild(box.firstChild);
    allTemplates().forEach(function (t) {
      var it = el("div", "pst-item"); it.appendChild(el("b", "", t.name));
      if (t.key === S.default_template) it.appendChild(el("span", "psch-chip psch-chip-paid", "Default"));
      it.appendChild(el("span", "pst-sum", summary(t.lines)));
      if (S.can_edit && !t.builtin) {
        var acts = el("span", "pst-acts"), ed = el("button", "btn", "Edit"), ar = el("button", "btn", "Archive");
        ed.type = "button"; ar.type = "button";
        ed.setAttribute("aria-label", "Edit " + t.name); ar.setAttribute("aria-label", "Archive " + t.name);
        ed.addEventListener("click", function () { openEditor(t); });
        ar.addEventListener("click", function () { archive(t, ar); });
        acts.appendChild(ed); acts.appendChild(ar); it.appendChild(acts);
      } else if (S.can_edit && t.builtin) {
        var cp = el("button", "btn", "Copy & change"); cp.type = "button"; cp.setAttribute("aria-label", "Copy " + t.name + " to a new schedule");
        cp.addEventListener("click", function () { openEditor({ name: t.name + " (copy)", lines: t.lines }); });
        var a2 = el("span", "pst-acts"); a2.appendChild(cp); it.appendChild(a2);
      }
      box.appendChild(it);
    });
  }
  function paint() {
    $("pst_upi").value = S.upi_id || ""; $("pst_note").value = S.pay_note || "";
    $("pst_rem").textContent = remText(S.reminders);
    ["pst_default", "pst_upi", "pst_note"].forEach(function (id) { $(id).disabled = !S.can_edit; });
    $("pst_ro").hidden = !!S.can_edit; $("pst_save").hidden = !S.can_edit; $("pst_new").hidden = !S.can_edit;
    paintDefault(); paintList();
  }

  // ---- editor ----------------------------------------------------------------------------------------------------
  function lineRow(l, i) {
    var row = el("div", "pst-line"), uid = "pst_l" + i + "_";
    function fld(cls, label, input) { var f = el("div", "fld " + (cls || "")), lb = el("label", "", label); input.id = uid + label.replace(/\W+/g, "").toLowerCase(); lb.htmlFor = input.id; f.appendChild(lb); f.appendChild(input); row.appendChild(f); return input; }
    var name = el("input"); name.maxLength = 80; name.value = l.label || ""; name.dataset.k = "label"; fld("pst-name", "Payment name", name);
    var kind = el("select"); [["percent", "% of total"], ["fixed", "Fixed amount"], ["balance", "Balance (what's left)"]].forEach(function (o) { var x = el("option", "", o[1]); x.value = o[0]; if ((l.kind || "percent") === o[0]) x.selected = true; kind.appendChild(x); });
    kind.dataset.k = "kind"; fld("", "Amount type", kind);
    var val = el("input"); val.type = "number"; val.min = "0"; val.step = "0.01"; val.inputMode = "decimal"; val.value = l.value == null ? "" : String(l.value); val.dataset.k = "value"; fld("", "Value", val);
    function syncVal() { val.disabled = kind.value === "balance"; if (val.disabled) val.value = ""; }
    kind.addEventListener("change", syncVal); syncVal();
    var anc = el("select"); [["approval", "Days after approval"], ["event_before", "Days before the event"], ["event_after", "Days after the event"]].forEach(function (o) {
      var x = el("option", "", o[1]); x.value = o[0]; anc.appendChild(x); });
    var off = Number(l.offset_days) || 0;
    anc.value = l.anchor === "event" ? (off < 0 ? "event_before" : "event_after") : "approval"; anc.dataset.k = "anchor"; fld("", "Due", anc);
    var days = el("input"); days.type = "number"; days.min = "0"; days.max = "365"; days.inputMode = "numeric"; days.value = String(Math.abs(off)); days.dataset.k = "days"; fld("", "Days", days);
    var rm = el("button", "btn", "✕"); rm.type = "button"; rm.setAttribute("aria-label", "Remove payment " + (i + 1));
    rm.addEventListener("click", function () { var p = row.parentNode; if (p && p.children.length > 1) { p.removeChild(row); preview(); } });
    row.appendChild(rm);
    row.addEventListener("input", preview); row.addEventListener("change", preview);
    return row;
  }
  function readLines() {
    return Array.prototype.map.call($("pst_lines").children, function (row) {
      var g = function (k) { var x = row.querySelector("[data-k='" + k + "']"); return x ? x.value : ""; };
      var a = g("anchor"), d = Math.abs(parseInt(g("days"), 10) || 0);
      return { label: g("label").trim(), kind: g("kind"), value: g("kind") === "balance" ? null : g("value"),
        anchor: a === "approval" ? "approval" : "event", offset_days: a === "event_before" ? -d : d };
    });
  }
  function preview() {
    var box = $("pst_prev"), err = $("pst_ederr"); if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var c = PS().cleanLines(readLines()); err.textContent = c.ok ? "" : c.error;
    if (!c.ok) return;
    var today = (global.BPStore && global.BPStore.todayLocal) ? global.BPStore.todayLocal() : new Date().toISOString().slice(0, 10);
    var ev = PS().addDays(today, 60);
    box.appendChild(el("p", "mnote", "Example: a ₹1,00,000 quote approved today for an event in 60 days"));
    PS().compute(c.lines, 100000, today, ev).forEach(function (r) {
      var d = el("div"); d.appendChild(el("span", "", r.label + " - " + (r.due_date && global.BPStore && global.BPStore.fmtDateIN ? global.BPStore.fmtDateIN(r.due_date) : (r.due_date || "")))); d.appendChild(el("b", "", money(r.amount))); box.appendChild(d);
    });
  }
  function openEditor(t) {
    editing = t && t.id ? t.id : null;
    var ed = $("pst_ed"); while (ed.firstChild) ed.removeChild(ed.firstChild); ed.hidden = false;
    ed.appendChild(el("h4", "", editing ? "Change schedule" : "New schedule"));
    var nf = el("div", "fld"), nl = el("label", "", "Schedule name"), ni = el("input"); ni.id = "pst_name"; ni.maxLength = 80; ni.value = (t && t.name) || ""; nl.htmlFor = "pst_name";
    nf.appendChild(nl); nf.appendChild(ni); ed.appendChild(nf);
    var lines = el("div", "pst-lines"); lines.id = "pst_lines"; ed.appendChild(lines);
    var src = (t && t.lines && t.lines.length) ? t.lines : [{ label: "Advance", kind: "percent", value: 50, anchor: "approval", offset_days: 0 }, { label: "Balance", kind: "balance", anchor: "event", offset_days: -7 }];
    src.forEach(function (l, i) { lines.appendChild(lineRow(l, i)); });
    var add = el("button", "btn", "+ Add a payment"); add.type = "button";
    add.addEventListener("click", function () { if (lines.children.length >= 10) return; lines.appendChild(lineRow({ label: "", kind: "percent", value: "", anchor: "event", offset_days: 0 }, lines.children.length + Date.now() % 1000)); preview(); });
    ed.appendChild(add);
    var er = el("p", "pst-err"); er.id = "pst_ederr"; er.setAttribute("role", "alert"); ed.appendChild(er);
    var pv = el("div", "pst-prev"); pv.id = "pst_prev"; pv.setAttribute("aria-live", "polite"); ed.appendChild(pv);
    var foot = el("div", "pst-foot"), cancel = el("button", "btn", "Cancel"), save = el("button", "btn primary", editing ? "Save schedule" : "Add schedule");
    cancel.type = "button"; save.type = "button";
    cancel.addEventListener("click", function () { ed.hidden = true; editing = null; });
    save.addEventListener("click", function () { saveTemplate(save); });
    foot.appendChild(cancel); foot.appendChild(save); ed.appendChild(foot);
    preview();
    try { ni.focus(); } catch (e) {}
  }
  async function saveTemplate(btn) {
    var name = $("pst_name").value.trim();
    if (!name) { $("pst_ederr").textContent = "Give the schedule a name."; $("pst_name").focus(); return; }
    var c = PS().cleanLines(readLines()); if (!c.ok) { $("pst_ederr").textContent = c.error; return; }
    btn.disabled = true;
    try {
      await global.BPStore.paySchedule.saveTemplate(editing, name, c.lines);
      S = await global.BPStore.paySchedule.settings(); paint(); $("pst_ed").hidden = true; editing = null;
      say("Schedule saved.", "ok");
    } catch (e) { $("pst_ederr").textContent = errText(e); }
    finally { btn.disabled = false; }
  }
  async function archive(t, btn) {
    var U = global.BPUI;
    if (U && U.confirm && !(await U.confirm("Archive the schedule “" + t.name + "”? Events that already use it keep their payments.", { title: "Archive schedule?", okLabel: "Archive" }))) return;
    btn.disabled = true;
    try { await global.BPStore.paySchedule.archiveTemplate(t.id); S = await global.BPStore.paySchedule.settings(); paint(); say("Schedule archived.", "ok"); }
    catch (e) { say(errText(e), "err"); }
    finally { btn.disabled = false; }
  }
  async function save() {
    var b = $("pst_save"); b.disabled = true; say("Saving…", "info");
    try {
      S = await global.BPStore.paySchedule.saveSettings({   // r25 (0274): auto-apply + overdue bell are switched in Automations only
        default_template: $("pst_default").value, upi_id: $("pst_upi").value.trim() || null, pay_note: $("pst_note").value.trim() || null });
      paint(); say("Saved.", "ok");
    } catch (e) { say(errText(e), "err"); }
    finally { b.disabled = false; }
  }
  async function init() {
    if (started) return;
    var card = $("pstCard"); if (!card) return;
    var B = global.BPStore;
    if (!B || !B.paySchedule || !PS() || !B.auth || !B.auth.user || !B.auth.user()) { if (++tries < 30) setTimeout(init, 1000); return; }
    started = true;
    try { S = await B.paySchedule.settings(); } catch (e) { S = null; }
    if (!S) return;
    paint(); card.hidden = false;
    $("pst_save").addEventListener("click", save);
    $("pst_new").addEventListener("click", function () { openEditor(null); });
    if (wantFocus) setTimeout(function () { try { card.scrollIntoView({ block: "start" }); } catch (e) {} }, 300);
  }
  global.HelmPayScheduleSettings = { init: init, summary: summary, dueText: dueText };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 400); });
  else setTimeout(init, 400);
})(typeof window !== "undefined" ? window : globalThis);
