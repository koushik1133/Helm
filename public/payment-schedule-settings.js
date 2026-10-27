/* payment-schedule-settings.js - Control Center "Payment schedules" card (r23, 0264).
   - Add the default schedule automatically when a client approves (default on), overdue bell (default on),
     the default schedule (built-in 30/50/20, 50/50, 100% upfront, or the studio's own),
   - how clients pay (UPI ID + a short payment note, shown on the client page and in every reminder),
   - r35 (0285): a change of the UPI ID / note needs a fresh two-step code (the store asks for it), waits 24 hours
     (clients keep the old details), every admin is told; "This wasn't us" / "Make it live now" / flagged accounts,
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
    if (e && e.cancelled) return "Not saved - this change needs your two-step code.";
    if (e && e.stepUp) return String(e.message || "");
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
  // ---- r35 (0285): the change waiting 24 hours + flagged accounts --------------------------------------------------
  function when(iso) {
    try { var d = new Date(iso); if (!isNaN(d)) return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); } catch (e) {}
    return String(iso || "");
  }
  function btn(label, cls, onClick) { var b = el("button", "btn" + (cls ? " " + cls : ""), label); b.type = "button"; b.addEventListener("click", function () { onClick(b); }); return b; }
  async function reload(msg, kind) { try { S = await global.BPStore.paySchedule.settings(); paint(); } catch (e) {} if (msg) say(msg, kind || "ok"); }
  async function notUs(p, b) {
    var U = global.BPUI, P = global.BPStore.paySchedule, mine = !!p.requested_by_me;
    var ask = mine ? "Withdraw your change? Clients keep the current payment details. Every admin is told."
      : "Cancel this change? Clients keep the current payment details, every admin is told, and " + p.requested_by + "'s account is flagged: it can't change sensitive settings until another admin clears the flag.";
    if (U && U.confirm && !(await U.confirm(ask, { title: mine ? "Withdraw change?" : "This wasn't us?", okLabel: mine ? "Withdraw" : "Cancel the change", danger: true }))) return;
    var signOut = false;
    if (!mine && U && U.confirm) signOut = await U.confirm("Also sign " + p.requested_by + " out on every device now? Recommended - whoever is using that account has to sign in again.", { title: "Sign out everywhere?", okLabel: "Sign out everywhere", cancelLabel: "Not now" });
    b.disabled = true;
    try {
      var res = await P.cancelChange(p.id, signOut);
      await reload(mine ? "Change withdrawn. Clients keep the current details." : "Change cancelled. Clients keep the current details and every admin was told.");
      // the server flags / signs out only when YOU confirmed with two-step; without it the cancel + alert still happened
      if (!mine && res && res.flagged === false) { if (U && U.alert) U.alert("Cancelled - clients keep the current details and every admin was told. " + p.requested_by + "'s account was NOT flagged or signed out: that needs two-step on your own account. Set it up (Account settings), then ask another admin to check the account.", { title: "Change cancelled" }); return; }
      if (!mine && U && U.alert) U.alert("Next steps: ask " + p.requested_by + " to reset their password (\u201cForgot password\u201d on the sign-in page) and to check their two-step set-up" + (signOut ? "." : ", and sign that account out everywhere (button below)."), { title: "Keep the studio safe" });
    } catch (e) { say(errText(e), "err"); b.disabled = false; }
  }
  async function approveNow(p, b) {
    var U = global.BPUI;
    if (U && U.confirm && !(await U.confirm("Show the new payment details to clients now instead of at " + when(p.effective_at) + "? Only do this if you checked them with " + p.requested_by + ".", { title: "Make it live now?", okLabel: "Make it live now" }))) return;
    b.disabled = true;
    try { await global.BPStore.paySchedule.approveNow(p.id); await reload("The new payment details are live. Every admin was told."); }
    catch (e) { say(errText(e), "err"); b.disabled = false; }
  }
  function paintPending() {
    var box = $("pst_pending"); if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var p = S && S.pending;
    box.hidden = !p; if (!p) return;
    box.appendChild(el("h4", "", "New payment details are waiting"));
    box.appendChild(el("p", "", "Changed by " + (p.requested_by_me ? "you" : p.requested_by) + " on " + when(p.requested_at) + ". Clients keep seeing the current details until " + when(p.effective_at) + ", then the new ones switch on by themselves."));
    var dl = el("dl");
    [["New UPI ID", p.new_upi], ["New payment note", p.new_note], ["Before", "UPI " + (p.old_upi_masked || "none") + ", note " + (p.old_note_masked || "none")]].forEach(function (r) {
      dl.appendChild(el("dt", "", r[0])); dl.appendChild(el("dd", "", r[1] == null || r[1] === "" ? "(none)" : String(r[1])));
    });
    box.appendChild(dl);
    if (p.masked) box.appendChild(el("p", "", "Only admins see the new details in full."));
    var acts = el("div", "pst-acts");
    if (p.can_cancel) acts.appendChild(btn(p.requested_by_me ? "Withdraw my change" : "This wasn't us", "danger", function (b) { notUs(p, b); }));
    if (p.can_approve) acts.appendChild(btn("Make it live now", "", function (b) { approveNow(p, b); }));
    if (acts.firstChild) box.appendChild(acts);
  }
  function paintFlags() {
    var box = $("pst_flags"); if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    var list = (S && S.flags) || [];
    box.hidden = !list.length; if (!list.length) return;
    box.appendChild(el("h4", "", "Flagged accounts"));
    box.appendChild(el("p", "", "A payment-details change by these accounts was cancelled as \u201cThis wasn't us\u201d. They can't change sensitive settings until another admin clears the flag. Ask the person to reset their password and check their two-step set-up first."));
    list.forEach(function (f) {
      var row = el("div", "pst-flag");
      row.appendChild(el("b", "", f.name + (f.is_me ? " (you)" : "")));
      row.appendChild(el("span", "mnote", "flagged " + when(f.flagged_at) + " by " + f.by));
      if (!f.is_me) {
        row.appendChild(btn("Sign out everywhere", "", async function (b) {
          b.disabled = true;
          try { await global.BPStore.paySchedule.signOutFlagged(f.user_id); say(f.name + " was signed out on every device.", "ok"); }
          catch (e) { say(errText(e), "err"); } finally { b.disabled = false; }
        }));
        row.appendChild(btn("Clear flag", "", async function (b) {
          var U = global.BPUI;
          if (U && U.confirm && !(await U.confirm("Clear the flag on " + f.name + "? Do this only after the password was reset and the account is safe again.", { title: "Clear flag?", okLabel: "Clear flag" }))) return;
          b.disabled = true;
          try { await global.BPStore.paySchedule.clearFlag(f.user_id); await reload("Flag cleared. Every admin was told."); }
          catch (e) { say(errText(e), "err"); b.disabled = false; }
        }));
      }
      box.appendChild(row);
    });
  }

  function paint() {
    $("pst_upi").value = S.upi_id || ""; $("pst_note").value = S.pay_note || "";
    $("pst_rem").textContent = remText(S.reminders);
    ["pst_default", "pst_upi", "pst_note"].forEach(function (id) { $(id).disabled = !S.can_edit; });
    $("pst_ro").hidden = !!S.can_edit; $("pst_save").hidden = !S.can_edit; $("pst_new").hidden = !S.can_edit;
    paintDefault(); paintList(); paintPending(); paintFlags();
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
      var before = S && S.pending ? S.pending.id : null;
      S = await global.BPStore.paySchedule.saveSettings({   // r25 (0274): auto-apply + overdue bell are switched in Automations only
        default_template: $("pst_default").value, upi_id: $("pst_upi").value.trim() || null, pay_note: $("pst_note").value.trim() || null });
      paint();
      // r35 (0285): a new change waits 24 hours (the fields keep showing what clients see now)
      if (S && S.pending && S.pending.id !== before) say("Saved. Every admin was told. Clients will see the new payment details from " + when(S.pending.effective_at) + ".", "ok");
      else say("Saved.", "ok");
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
