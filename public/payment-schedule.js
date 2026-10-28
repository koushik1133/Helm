/* payment-schedule.js - r23 (0264) payment schedule card for staff pages (quote flow payment step, event workspace,
   Budget, Logistics -> Payments). Shows every payment of the event with Paid / Part paid / Due / Overdue, the
   automatic-reminder cadence, a "Pause automatic reminders" switch for this event, and - when the event has no
   schedule yet - "Add a payment schedule" from a template (preview first, then apply). Reads / writes ONLY through
   BPStore.paySchedule (payment_schedule_for_quote / _apply / _pause - the database checks Finance view / edit and the
   studio). Hidden when the server is older than 0264 or the role can't see money. Amounts carry data-money (masked by
   "Hide amounts"). DOM via createElement + textContent only. The pure helpers (compute, cleanLines, stateLabel,
   reminderLine) are unit-tested and mirror the SQL (_pst_compute / _pst_lines_clean). */
(function (global) {
  "use strict";
  var BUILTINS = [
    { key: "builtin:30-50-20", name: "30 / 50 / 20", lines: [
      { label: "Advance (30%)", kind: "percent", value: 30, anchor: "approval", offset_days: 0 },
      { label: "Second payment (50%)", kind: "percent", value: 50, anchor: "event", offset_days: -15 },
      { label: "Final balance (20%)", kind: "percent", value: 20, anchor: "event", offset_days: 0 }] },
    { key: "builtin:50-50", name: "50 / 50", lines: [
      { label: "Advance (50%)", kind: "percent", value: 50, anchor: "approval", offset_days: 0 },
      { label: "Balance (50%)", kind: "percent", value: 50, anchor: "event", offset_days: -7 }] },
    { key: "builtin:100-upfront", name: "100% upfront", lines: [
      { label: "Full payment (100%)", kind: "percent", value: 100, anchor: "approval", offset_days: 0 }] }
  ];

  // ---- pure helpers (no DOM) ---------------------------------------------------------------------------------------
  function addDays(iso, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "")); if (!m) return null;
    var t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * 86400000; return new Date(t).toISOString().slice(0, 10);
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  // same rules as public._pst_lines_clean: -> { ok, lines, error }
  function cleanLines(lines) {
    if (!Array.isArray(lines) || !lines.length) return { ok: false, error: "Add at least one payment to the schedule." };
    if (lines.length > 10) return { ok: false, error: "A schedule can have at most 10 payments." };
    var out = [], pct = 0, bal = 0, fixed = 0;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i] || {}, n = i + 1, label = String(l.label == null ? "" : l.label).trim();
      if (!label || label.length > 80 || /[<>\u0000-\u001f]/.test(label)) return { ok: false, error: "Payment " + n + ": enter a name of up to 80 characters (no < or >)." };
      var kind = l.kind || "percent";
      if (["percent", "fixed", "balance"].indexOf(kind) < 0) return { ok: false, error: "Payment " + n + ": choose percent, fixed amount or balance." };
      var val = null;
      if (kind !== "balance") {
        var raw = String(l.value == null ? "" : l.value).trim();
        if (!/^\d{1,10}(\.\d{1,2})?$/.test(raw)) return { ok: false, error: "Payment " + n + ": enter the amount as a number (up to 2 decimals)." };
        val = Number(raw);
        if (kind === "percent" && (val <= 0 || val > 100)) return { ok: false, error: "Payment " + n + ": the percentage must be more than 0 and at most 100." };
        if (kind === "fixed" && val <= 0) return { ok: false, error: "Payment " + n + ": the amount must be more than 0." };
      }
      var anchor = l.anchor || "approval";
      if (anchor !== "approval" && anchor !== "event") return { ok: false, error: "Payment " + n + ": the due date counts from the approval or from the event day." };
      var off = String(l.offset_days == null || l.offset_days === "" ? "0" : l.offset_days).trim();
      if (!/^-?\d{1,3}$/.test(off) || Math.abs(Number(off)) > 365) return { ok: false, error: "Payment " + n + ": days must be a whole number from -365 to 365." };
      off = Number(off);
      if (anchor === "approval" && off < 0) return { ok: false, error: "Payment " + n + ": a payment can't be due before the approval." };
      if (kind === "percent") pct += val; else if (kind === "fixed") fixed++; else bal++;
      out.push({ label: label, kind: kind, value: val, anchor: anchor, offset_days: off });
    }
    if (bal > 1) return { ok: false, error: 'Use at most one "Balance" payment.' };
    if (pct > 100.001) return { ok: false, error: "The percentages add up to more than 100%." };
    if (!bal && (fixed > 0 || Math.abs(pct - 100) > 0.001)) return { ok: false, error: 'The payments must add up to 100% - or add a "Balance" payment that takes whatever is left.' };
    return { ok: true, lines: out, error: "" };
  }
  // same arithmetic as public._pst_compute: [{seq,label,amount,due_date}] adding up to the total
  function compute(lines, total, fromIso, eventIso) {
    total = Number(total); if (!(total > 0) || !Array.isArray(lines)) return [];
    var rows = [], run = 0, balIdx = -1;
    lines.forEach(function (l, i) {
      var due = l.anchor === "event" ? (eventIso ? addDays(eventIso, Number(l.offset_days) || 0) : null) : (fromIso ? addDays(fromIso, Number(l.offset_days) || 0) : null);
      if (due && fromIso && due < fromIso) due = fromIso;
      var left = Math.max(total - run, 0), amt = null;
      if (l.kind === "fixed") amt = Math.min(round2(Number(l.value)), left);
      else if (l.kind === "percent") amt = Math.min(Math.round(total * Number(l.value) / 100), left);
      else balIdx = i;
      run += amt || 0;
      rows.push({ seq: i + 1, label: l.label, amount: amt, due_date: due });
    });
    if (!rows.length) return [];
    if (balIdx >= 0) rows[balIdx].amount = round2(Math.max(total - run, 0));
    else if (Math.abs(total - run) > 0) { var last = rows[rows.length - 1]; last.amount = round2(Math.max((last.amount || 0) + (total - run), 0)); }
    return rows.filter(function (r) { return (r.amount || 0) > 0; });
  }
  function stateLabel(state, days) {
    if (state === "paid") return "Paid";
    if (state === "part_paid") return "Part paid";
    if (state === "waived") return "Waived";
    if (state === "invoiced") return "Invoiced";
    if (state === "overdue") return days != null && days < 0 ? "Overdue " + (-days) + (days === -1 ? " day" : " days") : "Overdue";
    if (days === 0) return "Due today";
    if (days != null && days > 0 && days <= 7) return "Due in " + days + (days === 1 ? " day" : " days");
    return "Due";
  }
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  // "Automatic reminders: 3 days before, on the due day, 3 days after" | "... off" | "... paused for this event"
  function reminderLine(rem, paused) {
    if (!rem) return "";
    if (!rem.enabled) return "Automatic client reminders are off (Settings > Reminders & client messages).";
    if (paused) return "Automatic client reminders are paused for this event.";
    var parts = [];
    if (rem.before_days > 0) parts.push(plural(rem.before_days, "day") + " before");
    if (rem.on_due) parts.push("on the due day");
    if (rem.max_overdue > 0) parts.push(rem.max_overdue === 1 ? plural(rem.every_days, "day") + " after" : "every " + plural(rem.every_days, "day") + " after (up to " + rem.max_overdue + ")");
    var s = "Automatic client reminders: " + (parts.length ? parts.join(", ") : "none") + ".";
    if (rem.client_reachable === false) s += " Add the client's e-mail to send them.";
    return s;
  }

  // ---- DOM -----------------------------------------------------------------------------------------------------------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function money(n, cur) {
    var B = global.BPStore, v = Number(n) || 0;
    try { if (B && B.studioMoney) return B.studioMoney(v); } catch (e) {}
    return "₹" + Math.round(v).toLocaleString("en-IN");
  }
  function moneyEl(tag, cls, n, cur) { var e = el(tag, cls, money(n, cur)); e.setAttribute("data-money", ""); return e; }
  function fmtDate(iso) { var B = global.BPStore; return iso ? (B && B.fmtDateIN ? B.fmtDateIN(iso) : iso) : "-"; }
  function toast(t, kind) { var U = global.BPUI; if (U && U.toast) U.toast(t, { type: kind || "ok" }); }
  function errText(e) {
    var s = String((e && (e.message || e.code)) || "");
    if (/not authori[sz]ed|42501/i.test(s)) return "You don't have permission to change this event's payments.";
    return s || "Something went wrong - please try again.";
  }

  function mount(box, quoteId, opts) {
    opts = opts || {};
    if (!box || !quoteId) return null;
    var B = global.BPStore; if (!B || !B.paySchedule) return null;
    var state = { data: null, busy: false };
    function clear() { while (box.firstChild) box.removeChild(box.firstChild); }
    async function load() {
      var d = null;
      try { d = await B.paySchedule.forQuote(quoteId); } catch (e) { d = null; }
      state.data = d;
      if (!d) { box.hidden = true; clear(); return null; }
      paint(); box.hidden = false;
      if (typeof opts.onLoad === "function") { try { opts.onLoad(d); } catch (e) {} }
      return d;
    }
    function paint() {
      var d = state.data; clear();
      box.classList.add("psch");
      if (opts.compact) box.classList.add("psch-compact");
      var rows = Array.isArray(d.rows) ? d.rows : [];
      // controlsOnly (Logistics -> Payments has its own table): the template picker, the cadence line and the pause switch
      if (!opts.controlsOnly || !rows.length) {
        var head = el("div", "psch-head");
        head.appendChild(el(opts.heading || "h3", "psch-title", opts.controlsOnly ? "Add a payment schedule" : "Payment schedule"));
        if (d.applied && d.applied.template) head.appendChild(el("span", "psch-tag", d.applied.template + (d.applied.source === "auto" ? " (added on approval)" : "")));
        box.appendChild(head);
      }
      if (opts.controlsOnly && rows.length) {
        // nothing more: the page lists the payments itself
      } else if (!rows.length) {
        box.appendChild(el("p", "psch-empty", "No payment schedule yet." + (d.can_edit ? " Pick a template - the amounts are worked out from the quote total." : " It is added automatically when the client approves.")));
        if (d.can_edit) box.appendChild(applyForm(d));
      } else {
        var wrap = el("div", "psch-scroll"), t = el("table", "psch-table"), th = el("thead"), hr = el("tr");
        ["Payment", "Due", "Amount", "Paid", "Status"].forEach(function (h, i) { var c = el("th", i >= 2 && i <= 3 ? "num" : "", h); c.scope = "col"; hr.appendChild(c); });
        th.appendChild(hr); t.appendChild(th);
        var tb = el("tbody");
        rows.forEach(function (r) {
          var tr = el("tr", "psch-row psch-" + r.state);
          tr.appendChild(el("td", "psch-lbl", r.label || "Payment"));
          tr.appendChild(el("td", "psch-due", fmtDate(r.due_date)));
          tr.appendChild(moneyEl("td", "num", r.amount, d.currency));
          var pd = Number(r.paid) > 0 ? moneyEl("td", "num", r.paid, d.currency) : el("td", "num", "-");
          tr.appendChild(pd);
          var st = el("td"); var chip = el("span", "psch-chip psch-chip-" + r.state, stateLabel(r.state, r.days));
          st.appendChild(chip);
          if (r.state === "part_paid" || (r.state === "overdue" && Number(r.paid) > 0)) {
            var rem = el("span", "psch-rem"); rem.appendChild(document.createTextNode(" ")); rem.appendChild(moneyEl("span", "", r.remaining, d.currency));
            rem.appendChild(document.createTextNode(" left")); st.appendChild(rem);
          }
          tr.appendChild(st); tb.appendChild(tr);
        });
        t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
        var tot = el("div", "psch-tot");
        [["Total", d.total], ["Paid", d.paid], ["Outstanding", d.outstanding]].forEach(function (x) {
          var s = el("span"); s.appendChild(document.createTextNode(x[0] + ": ")); s.appendChild(moneyEl("b", "", x[1], d.currency)); tot.appendChild(s);
        });
        box.appendChild(tot);
      }
      var line = reminderLine(d.reminders, d.paused);
      var foot = el("div", "psch-foot");
      if (line) foot.appendChild(el("p", "psch-note", line));
      if (d.can_pause && rows.length && d.reminders && d.reminders.enabled) {
        var lab = el("label", "psch-pause"), cb = el("input"); cb.type = "checkbox"; cb.checked = !!d.paused;
        cb.id = "psch_pause_" + String(quoteId).replace(/[^A-Za-z0-9_-]/g, "");
        lab.htmlFor = cb.id; lab.appendChild(cb); lab.appendChild(document.createTextNode(" Pause automatic reminders for this event"));
        cb.addEventListener("change", async function () {
          if (state.busy) return; state.busy = true; cb.disabled = true;
          try { await B.paySchedule.pause(quoteId, cb.checked); toast(cb.checked ? "Automatic reminders paused for this event." : "Automatic reminders are back on for this event."); await load(); }
          catch (e) { cb.checked = !cb.checked; toast(errText(e), "err"); }
          finally { state.busy = false; cb.disabled = false; }
        });
        foot.appendChild(lab);
      }
      if (opts.manageLink !== false && !opts.controlsOnly && rows.length) {
        var a = el("a", "psch-link", d.can_edit ? "Change payments in Logistics" : "Open payments");
        a.href = "logistics.html?quote=" + encodeURIComponent(quoteId) + "#payments"; foot.appendChild(a);
      }
      box.appendChild(foot);
    }
    function applyForm(d) {
      var f = el("div", "psch-apply"), sel = el("select", "psch-sel"), id = "psch_tpl_" + String(quoteId).replace(/[^A-Za-z0-9_-]/g, "");
      sel.id = id;
      var lab = el("label", "psch-sel-lbl", "Template"); lab.htmlFor = id;
      (d.templates || []).forEach(function (t) { var o = el("option", "", t.name); o.value = t.key; if (t.key === d.default_template) o.selected = true; sel.appendChild(o); });
      var prev = el("div", "psch-prev"), go = el("button", "btn primary psch-go", "Add this schedule"); go.type = "button";
      async function preview() {
        while (prev.firstChild) prev.removeChild(prev.firstChild);
        try {
          var r = await B.paySchedule.apply(quoteId, sel.value, true);
          (r && r.schedule || []).forEach(function (x) {
            var row = el("div", "psch-prow"); row.appendChild(el("span", "", x.label)); row.appendChild(el("span", "psch-due", fmtDate(x.due_date)));
            row.appendChild(moneyEl("b", "", x.amount, d.currency)); prev.appendChild(row);
          });
        } catch (e) { prev.appendChild(el("p", "psch-err", errText(e))); }
      }
      sel.addEventListener("change", preview);
      go.addEventListener("click", async function () {
        if (state.busy) return; state.busy = true; go.disabled = true;
        try { await B.paySchedule.apply(quoteId, sel.value, false); toast("Payment schedule added."); await load(); if (typeof opts.onChange === "function") opts.onChange(); }
        catch (e) { toast(errText(e), "err"); }
        finally { state.busy = false; go.disabled = false; }
      });
      f.appendChild(lab); f.appendChild(sel); f.appendChild(go); f.appendChild(prev);
      setTimeout(preview, 0);
      return f;
    }
    load();
    return { reload: load, get data() { return state.data; } };
  }

  var api = { mount: mount, compute: compute, cleanLines: cleanLines, stateLabel: stateLabel, reminderLine: reminderLine, BUILTINS: BUILTINS, addDays: addDays };
  global.HelmPaySchedule = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
