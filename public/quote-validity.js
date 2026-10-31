/* quote-validity.js - r23 (0262) quote "Valid until" (PandaDoc / Proposify / Zoho model).
   One module, four places:
     * client pages (approve.html, booklet.html): mountClient(el, kind, token, opts) - "This quote is valid until
       dd/mm/yyyy"; after expiry "This quote has expired - ask <studio> for an updated one" + "Request a new quote".
       opts.onState(state) lets the page hide its Approve form while the server lock is on (the SERVER refuses the
       approval anyway - verify_and_consent, 0262).
     * staff (flow.html step 9, event.html): any element with [data-qv-staff] (quote id from data-quote-id, else
       ?id= / ?quote=) - "Valid until dd/mm/yyyy - expires in N days" + "Extend +N days" (one click) + "Change date"
       (when the studio allows custom dates; admins always; typed / shown as dd/mm/yyyy) + a short history.
       r61 (0302): after Extend / Save date an "Undo" button (10 s, also in the toast) puts the previous date back through
       quote_validity_undo (logged as "Undone" in the history, never erased); a heads-up when the approval link itself
       stops before the valid-until date. Hidden for an approved / cancelled
       quote, when the feature is off, or before 0262.
     * Quotes list: pill(entry) -> { cls, text, title } for the "Expires in N days" pill (quotes.html renders it).
     * Settings (#qvCard): the studio settings + "Apply to open quotes" (admin, dry run first).
   Reads / writes ONLY through BPStore.quoteValidity (the server re-checks every permission and range).
   DOM via textContent / createElement only (no HTML strings). The pure helpers are unit-tested. */
(function (global) {
  "use strict";
  var DEFAULT_DAYS = 14;

  // ---- pure helpers -------------------------------------------------------------------------------------------
  // "2026-10-23" -> "23/10/2026" (dd/mm/yyyy, India); anything else -> ""
  function fmtDMY(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    return m ? m[3] + "/" + m[2] + "/" + m[1] : "";
  }
  function plural(n, one, many) { return n === 1 ? one : many; }
  // relative words for a days_left number
  function relText(days) {
    var d = Number(days);
    if (!isFinite(d)) return "";
    if (d > 1) return "Expires in " + d + " days";
    if (d === 1) return "Expires tomorrow";
    if (d === 0) return "Expires today";
    if (d === -1) return "Expired yesterday";
    return "Expired " + Math.abs(d) + " days ago";
  }
  // the Quotes-list pill for one quote_validity_list entry -> { cls, text, title } or null (nothing to show)
  function pill(e, soonDays) {
    if (!e || (e.state !== "valid" && e.state !== "expired")) return null;
    var d = Number(e.days_left), soon = isFinite(Number(soonDays)) ? Number(soonDays) : 3;
    var label = e.valid_until_label || fmtDMY(e.valid_until);
    if (e.state === "expired" || d < 0) return { cls: "hs-overdue", tone: "bad", text: relText(d < 0 ? d : -1),
      title: "Valid until " + label + (e.locked ? " - the client can't approve it until you extend it" : "") };
    return { cls: d <= soon ? "qv-due" : "hs-draft", tone: d <= soon ? "due" : "muted", text: relText(d), title: "Valid until " + label };
  }
  // what the CLIENT sees for a public_quote_validity answer -> { show, tone, lead, text, canRequest, requested }
  function clientView(s) {
    if (!s || (s.state !== "valid" && s.state !== "expired")) return { show: false };
    var studio = String(s.studio || "your event planner").slice(0, 80);
    var label = s.valid_until_label || fmtDMY(s.valid_until);
    if (s.state === "valid") {
      var d = Number(s.days_left);
      return { show: true, tone: d <= 3 ? "due" : "ok", lead: "This quote is valid until " + label + ".",
               text: d === 0 ? "Today is the last day to approve it." : d === 1 ? "One day left to approve it." : d <= 3 ? d + " days left to approve it." : "",
               canRequest: false };
    }
    return { show: true, tone: "bad", lead: "This quote has expired - ask " + studio + " for an updated one.",
             text: "It was valid until " + label + "." + (s.locked ? " It can't be approved any more." : ""),
             canRequest: !s.requested, requested: !!s.requested, studio: studio };
  }
  // "3, 1" / "1 3 7" -> { ok, value:[7,3,1], error } (whole days 0..60, at most 5, largest first)
  function parseReminderDays(raw) {
    var t = String(raw == null ? "" : raw).trim();
    if (t === "") return { ok: true, value: [], error: "" };
    var parts = t.split(/[\s,;]+/).filter(Boolean), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!/^\d{1,2}$/.test(parts[i])) return { ok: false, value: null, error: "Use whole days from 0 to 60, e.g. 3, 1." };
      var n = Number(parts[i]);
      if (n > 60) return { ok: false, value: null, error: "Reminder days go up to 60." };
      if (out.indexOf(n) < 0) out.push(n);
    }
    if (out.length > 5) return { ok: false, value: null, error: "Pick up to 5 reminder days." };
    out.sort(function (a, b) { return b - a; });
    return { ok: true, value: out, error: "" };
  }
  function validateDays(raw) {
    var t = String(raw == null ? "" : raw).trim();
    if (!/^\d{1,3}$/.test(t)) return { ok: false, value: null, error: "Enter the number of days, from 1 to 365." };
    var n = Number(t);
    if (n < 1 || n > 365) return { ok: false, value: null, error: "Quotes stay valid for 1 to 365 days." };
    return { ok: true, value: n, error: "" };
  }
  // r61: "23/12/2026" (also 23-12-2026 / 23.12.2026 / 1/2/2027) -> "2026-12-23"; anything else (or a date that does not
  // exist, e.g. 31/02) -> ""
  function parseDMY(raw) {
    var m = /^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\s*$/.exec(String(raw == null ? "" : raw));
    if (!m) return "";
    var d = +m[1], mo = +m[2], y = +m[3], t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return "";
    return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }
  var UNDO_MS = 10000;   // r61: how long the Undo button stays after Extend / Save date (the server allows 10 minutes)
  // r61: the server's undo offer (quote_validity_get / extend / set answer, 0302) -> { logId, label } or null
  function undoOffer(d) {
    var u = d && d.undo;
    if (!u || typeof u !== "object" || !/^[0-9a-f-]{36}$/i.test(String(u.log_id || ""))) return null;
    return { logId: String(u.log_id), label: String(u.back_to_label || fmtDMY(u.back_to) || "") };
  }
  // r61: the approval link itself stops before the valid-until date -> "dd/mm/yyyy" (the last day it opens), else ""
  function linkWarn(d) {
    if (!d || d.state !== "valid" || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.link_until || "")) || !d.valid_until) return "";
    return String(d.link_until) < String(d.valid_until) ? (d.link_until_label || fmtDMY(d.link_until)) : "";
  }
  function addDaysISO(iso, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); if (!m) return "";
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  }
  function errText(e, what) {
    var s = String((e && (e.message || e.code)) || "");
    if (e && e.code === "quote_validity_missing") return e.message;
    if (/42501|not authori[sz]ed/i.test(s) && !/admins|Only/.test(s)) return "Your role can't change this.";
    return (s || ("Couldn't " + (what || "save") + " - please try again.")).slice(0, 300);
  }

  // ---- tiny DOM helpers (text only) ---------------------------------------------------------------------------
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k]; if (v == null || v === false) return;
      if (k === "text") e.textContent = String(v);
      else if (k === "cls") e.className = v;
      else if (k === "on") Object.keys(v).forEach(function (ev) { e.addEventListener(ev, v[ev]); });
      else e.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function store() { return global.BPStore && global.BPStore.quoteValidity ? global.BPStore.quoteValidity : null; }
  function toast(msg, type) { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(msg, { type: type || "ok" }); } catch (e) {} }

  // ---- client pages ---------------------------------------------------------------------------------------------
  var clientCur = null;
  async function mountClient(el, kind, token, opts) {
    opts = opts || {}; var S = store();
    if (!el || !S || !token) return null;
    clientCur = { el: el, kind: kind, token: token, opts: opts };
    var s = null; try { s = await S.publicState(kind, token); } catch (e) { s = null; }
    paintClient(el, s, kind, token, opts);
    if (typeof opts.onState === "function") { try { opts.onState(s || null); } catch (e) {} }
    return s;
  }
  function refreshClient() { if (clientCur) return mountClient(clientCur.el, clientCur.kind, clientCur.token, clientCur.opts); return Promise.resolve(null); }
  function paintClient(el, s, kind, token, opts) {
    var v = clientView(s); clear(el);
    if (!v.show) { el.hidden = true; return; }
    el.className = "qv-banner qv-" + v.tone;
    el.setAttribute("role", "status");
    el.appendChild(h("p", { cls: "qv-lead", text: v.lead }));
    if (v.text) el.appendChild(h("p", { cls: "qv-sub", text: v.text }));
    if (s.state === "expired") {
      var msg = h("p", { cls: "qv-sub qv-done", "aria-live": "polite", text: v.requested ? "Thanks - " + (s.studio || "your planner") + " has been asked to send you an updated quote." : "" });
      if (v.canRequest) {
        var b = h("button", { type: "button", cls: "btn primary qv-req", text: "Request a new quote" });
        b.addEventListener("click", async function () {
          var S = store(); if (!S) return;
          b.disabled = true; b.textContent = "Sending…";
          try {
            var r = await S.requestNew(kind, token, null);
            if (r && r.status === "unavailable") { b.disabled = false; b.textContent = "Request a new quote"; msg.textContent = "Couldn't send the request - please contact your planner directly."; return; }
            msg.textContent = "Thanks - " + ((r && r.studio) || s.studio || "your planner") + " has been asked to send you an updated quote.";
            b.remove();
          } catch (e) {
            b.disabled = false; b.textContent = "Request a new quote";
            msg.textContent = /HL429|too many/i.test(String((e && (e.code || e.message)) || "")) ? "Already sent - please try again later." : "Couldn't send the request - please try again or contact your planner.";
          }
        });
        el.appendChild(b);
      }
      el.appendChild(msg);
    }
    el.hidden = false;
  }

  // ---- staff widget ------------------------------------------------------------------------------------------------
  function quoteIdFrom(el) {
    var id = el.getAttribute("data-quote-id");
    if (!id) { try { var p = new URLSearchParams(global.location.search); id = p.get("id") || p.get("quote") || ""; } catch (e) { id = ""; } }
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
  }
  async function mountStaff(el, quoteId) {
    var S = store(); if (!el || !S) return null;
    var id = quoteId || quoteIdFrom(el); if (!id) { el.hidden = true; return null; }
    el.setAttribute("data-quote-id", id);
    var d = null; try { d = await S.get(id); } catch (e) { d = null; }
    paintStaff(el, id, d);
    try { if (!el.hidden && global.location && global.location.hash === "#" + el.id) el.scrollIntoView({ block: "center" }); } catch (e) {}
    return d;
  }
  function paintStaff(el, id, d, justDone) {
    clear(el);
    if (el.__qvUndoTimer) { clearInterval(el.__qvUndoTimer); el.__qvUndoTimer = null; }
    if (!d || !(d.state === "valid" || d.state === "expired" || (d.state === "none" && d.can_edit))) { el.hidden = true; return; }
    var days = Number(d.default_days) || DEFAULT_DAYS;
    el.className = "qv-staff qv-" + (d.state === "expired" ? "bad" : d.state === "valid" && Number(d.days_left) <= 3 ? "due" : "ok");
    if (!el.id) el.id = "quote-validity";
    var line = h("p", { cls: "qv-line" });
    if (d.state === "none") {
      line.appendChild(h("b", { text: "No valid-until date" }));
      line.appendChild(document.createTextNode(" - this quote was created before quote validity was switched on, so it never expires."));
    } else {
      line.appendChild(h("span", { cls: "qv-k", text: "Valid until " }));
      line.appendChild(h("b", { text: d.valid_until_label || fmtDMY(d.valid_until) }));
      line.appendChild(document.createTextNode(" · " + relText(d.days_left)));
      if (d.state === "expired") line.appendChild(document.createTextNode(d.locked ? " - the client can't approve it until you extend it." : " - the client can still approve it (the lock is off in Settings)."));
    }
    el.appendChild(line);
    var lw = linkWarn(d);
    if (lw) el.appendChild(h("p", { cls: "qv-warn", text: "Heads-up: the client's approval link itself only opens until " + lw + " - before this date." }));
    var msg = h("p", { cls: "qv-msg", role: "status", "aria-live": "polite" });
    // r61: one change at a time; after Extend / Save date the answer carries the server's undo offer
    function changed(r, what) {
      paintStaff(el, id, r, true);
      var u = undoOffer(r), label = r && r.valid_until_label ? r.valid_until_label : "updated";
      if (!u) { toast("Valid until " + label + ".", "ok"); return; }
      var tt = null;
      try { if (global.BPUI && global.BPUI.toast) tt = global.BPUI.toast(what + " - valid until " + label + ".", { type: "ok", timeout: UNDO_MS,
        action: { label: "Undo", onClick: function () { undo(u); } } }); } catch (e) {}
      el.__qvToast = tt;
    }
    async function undo(u) {
      if (el.__qvBusy) return; el.__qvBusy = true;
      try { if (el.__qvToast && el.__qvToast.close) el.__qvToast.close(); } catch (e) {}
      var b = el.querySelector(".qv-undo"); if (b) { b.disabled = true; b.textContent = "Undoing…"; }
      try {
        var r = await store().undo(id, u.logId);
        paintStaff(el, id, r); toast("Undone - valid until " + (r && r.valid_until_label ? r.valid_until_label : u.label) + " again.", "ok");
      } catch (e) {
        if (b) { b.disabled = false; b.textContent = "Undo"; }
        var m = el.querySelector(".qv-msg"); if (m) m.textContent = errText(e, "undo it");
      } finally { el.__qvBusy = false; }
    }
    if (d.can_edit) {
      var row = h("div", { cls: "qv-actions" });
      var ext = h("button", { type: "button", cls: "btn sm", text: d.state === "none" ? "Set valid until (+" + days + " days)" : "Extend +" + days + " days" });
      ext.addEventListener("click", async function () {
        if (el.__qvBusy) return; el.__qvBusy = true; ext.disabled = true;
        try { var r = await store().extend(id); el.__qvBusy = false; changed(r, "Extended"); }
        catch (e) { el.__qvBusy = false; ext.disabled = false; msg.textContent = errText(e, "extend it"); }
      });
      row.appendChild(ext);
      if (d.can_override) {
        // r61: the date is typed / shown as dd/mm/yyyy (India) like the label above - a native date box shows the
        // browser's own order (12/23/2026 on a US-English browser). The calendar button still opens the native picker.
        var dmyId = "qv_dmy_" + String(id).slice(0, 8);
        var lbl = h("label", { cls: "qv-date-lbl", "for": dmyId, text: "Change date" });
        var wrap = h("span", { cls: "qv-date" });
        var inp = h("input", { type: "text", id: dmyId, cls: "qv-dmy", inputmode: "numeric", autocomplete: "off", maxlength: "10",
          placeholder: "dd/mm/yyyy", "aria-label": "New valid-until date (dd/mm/yyyy)", spellcheck: "false" });
        var nat = h("input", { type: "date", cls: "qv-native", tabindex: "-1", "aria-hidden": "true", "data-native-picker": "", min: d.today || "", max: d.today ? addDaysISO(d.today, 365) : "" });
        var cal = h("button", { type: "button", cls: "qv-cal", "aria-label": "Pick the date from a calendar", title: "Pick from a calendar" });
        cal.appendChild(h("span", { cls: "qv-cal-ic", "aria-hidden": "true" }));
        if (d.valid_until && d.valid_until >= (d.today || "")) { inp.value = fmtDMY(d.valid_until); nat.value = d.valid_until; }
        nat.addEventListener("change", function () { if (nat.value) { inp.value = fmtDMY(nat.value); msg.textContent = ""; } });
        inp.addEventListener("input", function () { var v = parseDMY(inp.value); if (v) nat.value = v; inp.removeAttribute("aria-invalid"); });
        cal.addEventListener("click", function () {
          var v = parseDMY(inp.value); if (v) nat.value = v;
          try { if (typeof nat.showPicker === "function") { nat.showPicker(); return; } } catch (e) {}
          nat.classList.add("qv-native-open"); try { nat.focus(); nat.click(); } catch (e) {}
        });
        nat.addEventListener("blur", function () { nat.classList.remove("qv-native-open"); });
        wrap.appendChild(inp); wrap.appendChild(cal); wrap.appendChild(nat);
        var save = h("button", { type: "button", cls: "btn sm", text: "Save date" });
        save.addEventListener("click", async function () {
          var v = parseDMY(inp.value);
          if (!v) { msg.textContent = String(inp.value || "").trim() ? "Type the date as dd/mm/yyyy, e.g. " + (fmtDMY(d.today ? addDaysISO(d.today, days) : "") || "23/12/2026") + "." : "Pick a date first."; inp.setAttribute("aria-invalid", "true"); inp.focus(); return; }
          if (d.today && (v < d.today || v > addDaysISO(d.today, 365))) { msg.textContent = "Pick a date from today (" + fmtDMY(d.today) + ") to one year ahead."; inp.setAttribute("aria-invalid", "true"); inp.focus(); return; }
          if (el.__qvBusy) return; el.__qvBusy = true; save.disabled = true;
          try { var r = await store().setDate(id, v, null); el.__qvBusy = false; changed(r, "Date saved"); }
          catch (e) { el.__qvBusy = false; save.disabled = false; msg.textContent = errText(e, "save the date"); }
        });
        inp.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { ev.preventDefault(); save.click(); } });
        row.appendChild(lbl); row.appendChild(wrap); row.appendChild(save);
      }
      // r61: Undo for 10 seconds right after Extend / Save date (the same server path, logged in History)
      var uo = justDone ? undoOffer(d) : null;
      if (uo) {
        var ub = h("button", { type: "button", cls: "btn sm qv-undo", text: "Undo", title: "Back to " + uo.label });
        var left = Math.round(UNDO_MS / 1000), cnt = h("span", { cls: "qv-undo-left", "aria-hidden": "true", text: left + " s" });
        ub.addEventListener("click", function () { undo(uo); });
        var ubox = h("span", { cls: "qv-undo-box" }, [ub, cnt]);
        row.appendChild(ubox);
        el.__qvUndoTimer = setInterval(function () {
          left -= 1;
          if (left <= 0 || !ubox.isConnected) { clearInterval(el.__qvUndoTimer); el.__qvUndoTimer = null; if (ubox.parentNode && !el.__qvBusy) ubox.parentNode.removeChild(ubox); return; }
          cnt.textContent = left + " s";
        }, 1000);
      }
      el.appendChild(row);
    }
    el.appendChild(msg);
    if (Array.isArray(d.log) && d.log.length) {
      var det = h("details", { cls: "qv-log" }, [h("summary", { text: "History" })]);
      var ul = h("ul");
      var WORD = { auto: "Set automatically", set: "Date changed", extended: "Extended", bulk: "Applied to open quotes", renew_request: "Client asked for an updated quote",
                   reminder_studio: "Reminder to the studio", reminder_client: "Reminder e-mail queued for the client", expired_studio: "Expired", approve_refused: "Client tried to approve after expiry", undo: "Undone" };
      d.log.forEach(function (x) {
        var when = ""; try { when = global.BPStore && global.BPStore.fmtDateTime ? global.BPStore.fmtDateTime(x.at) : String(x.at || "").slice(0, 10); } catch (e) { when = ""; }
        var txt = (WORD[x.action] || x.action) + (x.new ? " - valid until " + x.new : "") + (x.who ? " - " + x.who : "") + (when ? " (" + when + ")" : "");
        ul.appendChild(h("li", { text: txt }));
      });
      det.appendChild(ul); el.appendChild(det);
    }
    el.hidden = false;
  }

  // ---- Settings ---------------------------------------------------------------------------------------------
  async function mountSettings(card) {
    var S = store(); if (!card || !S) return;
    var d = null; try { d = await S.settings(); } catch (e) { d = null; }
    if (!d) return;
    var $ = function (id) { return document.getElementById(id); };
    function paint(x) {
      d = x; var ro = !x.can_edit;
      $("qv_on").checked = !!x.enabled; $("qv_days").value = String(x.default_days || DEFAULT_DAYS);
      $("qv_rem").value = (Array.isArray(x.reminder_days) ? x.reminder_days : []).join(", ");
      $("qv_lock").checked = !!x.auto_lock; $("qv_over").checked = !!x.allow_override;
      ["qv_on", "qv_days", "qv_rem", "qv_lock", "qv_over", "qv_save"].forEach(function (k) { $(k).disabled = ro; });
      $("qv_ro").hidden = !ro;
      var ap = $("qv_apply_row"); ap.hidden = !(x.is_admin && x.can_edit && x.enabled);
      $("qv_apply_note").textContent = Number(x.open_without_date) > 0
        ? Number(x.open_without_date) + " open " + plural(Number(x.open_without_date), "quote has", "quotes have") + " no valid-until date (created before this was switched on). They never expire unless you apply the default to them."
        : "Every open quote already has a valid-until date.";
      $("qv_apply").disabled = !(Number(x.open_without_date) > 0);
    }
    function say(t, kind) { var m = $("qv_msg"); m.className = t ? "msg " + (kind || "ok") : ""; m.textContent = t || ""; }
    paint(d); card.hidden = false;
    $("qv_save").addEventListener("click", async function () {
      var dv = validateDays($("qv_days").value), rv = parseReminderDays($("qv_rem").value);
      if (!dv.ok) { say(dv.error, "err"); $("qv_days").focus(); return; }
      if (!rv.ok) { say(rv.error, "err"); $("qv_rem").focus(); return; }
      var b = $("qv_save"); b.disabled = true; say("Saving…", "info");
      try {
        var r = await S.saveSettings({ enabled: $("qv_on").checked, default_days: dv.value, reminder_days: rv.value, auto_lock: $("qv_lock").checked,
          allow_override: $("qv_over").checked });   // r25 (0274): the two reminders are switched in Automations only
        paint(r || d); say("Saved. New quotes are valid for " + (r ? r.default_days : dv.value) + " days.", "ok");
      } catch (e) { say(errText(e, "save the settings"), "err"); }
      finally { b.disabled = !d.can_edit; }
    });
    $("qv_apply").addEventListener("click", async function () {
      var b = $("qv_apply"); b.disabled = true;
      try {
        var dry = await S.applyOpen(false);
        var n = Number(dry && dry.count) || 0;
        if (!n) { say("Every open quote already has a valid-until date.", "info"); return; }
        var ok = true;
        if (global.BPUI && global.BPUI.confirm) ok = await global.BPUI.confirm("Give " + n + " open " + plural(n, "quote", "quotes") + " a valid-until date of " + (dry.valid_until_label || "") + "? Quotes that already have a date, approved and cancelled quotes, and quotes for past events are not changed.", { title: "Apply to open quotes", okLabel: "Apply to " + n });
        else ok = global.confirm ? global.confirm("Apply a valid-until date to " + n + " open quotes?") : false;
        if (!ok) return;
        var r = await S.applyOpen(true);
        say("Done - " + (Number(r && r.count) || n) + " " + plural(n, "quote is", "quotes are") + " now valid until " + ((r && r.valid_until_label) || "") + ".", "ok");
        try { paint(await S.settings() || d); } catch (e) {}
      } catch (e) { say(errText(e, "apply the date"), "err"); }
      finally { b.disabled = !(Number(d.open_without_date) > 0); }
    });
  }

  function autoInit() {
    if (typeof document === "undefined") return;
    var tries = 0;
    (function go() {
      var S = store();
      if (!S || !global.BPStore.auth || (global.BPStore.auth.user && !global.BPStore.auth.user())) { if (++tries < 30) return void setTimeout(go, 700); }
      if (!S) return;
      var card = document.getElementById("qvCard"); if (card && !card.__qv) { card.__qv = 1; mountSettings(card); }
      Array.prototype.forEach.call(document.querySelectorAll("[data-qv-staff]"), function (el) { if (!el.__qv) { el.__qv = 1; mountStaff(el); } });
    })();
  }

  // re-read every staff line on the page (e.g. after the approval link was sent - an automatic date moves)
  function refreshStaff() {
    if (typeof document === "undefined") return;
    Array.prototype.forEach.call(document.querySelectorAll("[data-qv-staff]"), function (el) { el.__qv = 1; mountStaff(el); });
  }

  var API = { refreshStaff: refreshStaff, fmtDMY: fmtDMY, relText: relText, pill: pill, clientView: clientView, parseReminderDays: parseReminderDays,
              validateDays: validateDays, addDaysISO: addDaysISO, parseDMY: parseDMY, undoOffer: undoOffer, linkWarn: linkWarn, UNDO_MS: UNDO_MS, mountClient: mountClient, refreshClient: refreshClient,
              mountStaff: mountStaff, mountSettings: mountSettings, DEFAULT_DAYS: DEFAULT_DAYS };
  global.HelmQuoteValidity = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(autoInit, 300); });
  else setTimeout(autoInit, 300);
})(typeof window !== "undefined" ? window : globalThis);
