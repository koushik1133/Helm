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
  // r61: "30%" / "12.5%"
  function pctText(n) { var v = Math.round(Number(n) * 10) / 10; return (isFinite(v) ? v : 0) + "%"; }
  // r61: when a template payment is due, in words ("On approval", "15 days before the event", ...)
  function dueWhen(l) {
    var n = Number(l && l.offset_days) || 0, ev = l && l.anchor === "event";
    if (!ev) return n > 0 ? plural(n, "day") + " after approval" : "On approval";
    if (n === 0) return "On the event day";
    return n < 0 ? plural(-n, "day") + " before the event" : plural(n, "day") + " after the event";
  }
  function builtin(key) { for (var i = 0; i < BUILTINS.length; i++) if (BUILTINS[i].key === key) return BUILTINS[i]; return null; }
  // "Automatic reminders: 3 days before, on the due day, 3 days after" | "... off" | "... paused for this event"
  var TRIAL_SIM_REMIND = "Trial simulation - reminders are not sent to your client in the free trial.";
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
        // R112 (0321): Outstanding is the closure balance (invoice total - payments). When the quote total changed after
        // the schedule was made, say so - and Finance edit can re-split the open payments to the new total.
        if (d.mismatch) box.appendChild(mismatchNote(d));
      }
      var line = reminderLine(d.reminders, d.paused);
      // R114 (0323): a free trial is a simulation - reminders are recorded as skipped, never sent to the client
      try { if (line && window.HelmTrialLock && window.HelmTrialLock.isTrial && window.HelmTrialLock.isTrial()) line += " " + TRIAL_SIM_REMIND; } catch (e) {}
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
    function mismatchNote(d) {
      var w = el("div", "psch-mismatch"); w.setAttribute("role", "status");
      var p = el("p", "psch-soft"), t = el("span");
      t.appendChild(document.createTextNode("The quote total is now "));
      t.appendChild(moneyEl("b", "", d.total, d.currency));
      t.appendChild(document.createTextNode(", but these payments add up to "));
      t.appendChild(moneyEl("b", "", d.scheduled, d.currency));
      t.appendChild(document.createTextNode(" (the price changed after the schedule was made). Outstanding uses the quote total."));
      p.appendChild(t); w.appendChild(p);
      if (d.can_resync && B.paySchedule.resync) {
        var b = el("button", "btn psch-resync", "Re-split the open payments to the new total"); b.type = "button";
        b.addEventListener("click", async function () {
          if (state.busy) return; state.busy = true; b.disabled = true;
          try {
            var r = await B.paySchedule.resync(quoteId);
            toast(r && r.changed ? "Payment schedule updated to the new total." : (r && r.reason === "below_paid"
              ? "The new total is below what is already paid - record a refund or change the payments in Logistics." : "Nothing to change."), r && r.changed ? "ok" : "info");
            await load(); if (typeof opts.onChange === "function") opts.onChange();
          } catch (e) { toast(errText(e), "err"); }
          finally { state.busy = false; if (b.isConnected) b.disabled = false; }
        });
        w.appendChild(b);
      }
      return w;
    }
    // r61: template + "Add this schedule" on one aligned line, then the split (bar + one row per payment: percent, name,
    // when it is due, amount - or "-" until the quote is priced) and a soft note instead of the server's red error
    function applyForm(d) {
      var f = el("div", "psch-apply"), sel = el("select", "psch-sel"), id = "psch_tpl_" + String(quoteId).replace(/[^A-Za-z0-9_-]/g, "");
      sel.id = id;
      var fld = el("div", "psch-fld"), lab = el("label", "psch-sel-lbl", "Template"); lab.htmlFor = id;
      (d.templates || []).forEach(function (t) { var o = el("option", "", t.name); o.value = t.key; if (t.key === d.default_template) o.selected = true; sel.appendChild(o); });
      fld.appendChild(lab); fld.appendChild(sel);
      var go = el("button", "btn primary psch-go", "Add this schedule"); go.type = "button";
      var row = el("div", "psch-apply-row"); row.appendChild(fld); row.appendChild(go);
      var bar = el("div", "psch-bar"); bar.setAttribute("aria-hidden", "true");
      var prev = el("div", "psch-prev"); prev.setAttribute("role", "list"); prev.setAttribute("aria-label", "How the payments split");
      var note = el("p", "psch-soft"); note.hidden = true; note.setAttribute("role", "status");
      var priced = Number(d.total) > 0, seq = 0;
      function soft(t) { note.textContent = t || ""; note.hidden = !t; }
      function draw(rows) {
        while (prev.firstChild) prev.removeChild(prev.firstChild);
        while (bar.firstChild) bar.removeChild(bar.firstChild);
        rows.forEach(function (x) {
          var r = el("div", "psch-prow"); r.setAttribute("role", "listitem");
          r.appendChild(el("span", "psch-pct", x.pct != null ? pctText(x.pct) : "-"));
          var pl = el("span", "psch-pl"); pl.appendChild(el("b", "", x.label || "Payment")); if (x.when) pl.appendChild(el("span", "", x.when)); r.appendChild(pl);
          if (x.amount != null && priced) r.appendChild(moneyEl("span", "psch-amt", x.amount, d.currency));
          else { var a = el("span", "psch-amt is-blank", "-"); a.title = "Worked out once the quote is priced"; r.appendChild(a); }
          prev.appendChild(r);
          if (x.pct != null && x.pct > 0) bar.appendChild(el("span", "psch-w" + Math.min(100, Math.max(5, Math.round(x.pct / 5) * 5))));   // width class in 5% steps (no inline style - CSP)
        });
        bar.hidden = !bar.firstChild;
      }
      function fromTemplate(key) {
        var b = builtin(key); if (!b) return [];
        return b.lines.map(function (l) { return { label: l.label, pct: l.kind === "percent" ? Number(l.value) : null, when: dueWhen(l), amount: null }; });
      }
      async function preview() {
        var my = ++seq, key = sel.value, local = fromTemplate(key);
        if (!priced) {
          draw(local.length ? local : [{ label: "Payments from this template", when: "Amounts and dates are worked out once the quote is priced" }]);
          soft("Price the quote first (step 8) - the amounts are worked out from its total. You can still pick the template now.");
          go.disabled = true; return;
        }
        draw(local); soft(""); go.disabled = false;
        try {
          var r = await B.paySchedule.apply(quoteId, key, true);
          if (my !== seq) return;
          var tot = Number(d.total) || 0, rows = (r && r.schedule) || [];
          draw(rows.map(function (x, i) {
            var l = local[i], amt = Number(x.amount);
            return { label: x.label, amount: x.amount, pct: l && l.pct != null ? l.pct : (tot > 0 && isFinite(amt) ? Math.round(amt / tot * 1000) / 10 : null),
                     when: (x.due_date ? fmtDate(x.due_date) : "") + (l && l.when ? (x.due_date ? " · " : "") + l.when : "") };
          }));
        } catch (e) {
          if (my !== seq) return;
          var t = errText(e);
          if (/price the quote/i.test(t)) { priced = false; return preview(); }
          soft(t); go.disabled = true;
        }
      }
      sel.addEventListener("change", preview);
      go.addEventListener("click", async function () {
        if (state.busy || go.disabled) return; state.busy = true; go.disabled = true;
        try { await B.paySchedule.apply(quoteId, sel.value, false); toast("Payment schedule added."); await load(); if (typeof opts.onChange === "function") opts.onChange(); }
        catch (e) { var t = errText(e); if (/price the quote/i.test(t)) { priced = false; preview(); } else toast(t, "err"); }
        finally { state.busy = false; if (go.isConnected && note.hidden) go.disabled = false; }
      });
      f.appendChild(row); f.appendChild(bar); f.appendChild(prev); f.appendChild(note);
      setTimeout(preview, 0);
      return f;
    }
    load();
    return { reload: load, get data() { return state.data; } };
  }

  var api = { mount: mount, compute: compute, cleanLines: cleanLines, stateLabel: stateLabel, reminderLine: reminderLine, BUILTINS: BUILTINS, addDays: addDays,
              dueWhen: dueWhen, pctText: pctText };
  global.HelmPaySchedule = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
