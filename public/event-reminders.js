/* event-reminders.js - 0129 "event is coming up" reminders (client side).
   - Control Center: "Remind the team before each event: [7] days" (admins edit; others read-only).
   - Event page: "Upcoming in N days" banner for a confirmed event inside the window.
   - Dashboard: caches the studio window so shell-b-dash.js "Needs attention" can list events inside it.
   Reads/writes ONLY via BPStore.comms.reminderGet / reminderSet / reminderUpcoming. DOM API only. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var KEY = "helm_evr_days";
  function store() { return global.BPStore && global.BPStore.comms; }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function clampDays(v) { v = Number(v); return Number.isInteger(v) && v >= 1 && v <= 30 ? v : null; }
  function cacheDays(d) { try { if (clampDays(d)) localStorage.setItem(KEY, String(d)); } catch (e) {} }
  function days() { try { return clampDays(localStorage.getItem(KEY)) || 7; } catch (e) { return 7; } }
  // whole days from local "today" to a YYYY-MM-DD date (mirror of SQL _event_days_left)
  function daysUntil(ymd, now) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || "")); if (!m) return null;
    var t = now || new Date();
    return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
  }
  function chipText(n) { return n === 0 ? "Today" : n === 1 ? "Tomorrow" : "Upcoming in " + n + " days"; }

  function controlCard() {
    var anchor = document.getElementById("commsCard"); var S = store();
    if (!anchor || !S || !S.reminderGet || document.getElementById("evrCard")) return;
    S.reminderGet().then(function (r) {
      if (!r || document.getElementById("evrCard")) return;
      cacheDays(r.days);
      var card = el("div", "card"); card.id = "evrCard";
      card.appendChild(el("h3", null, "Event reminders"));
      card.appendChild(el("p", "mnote", "Helm reminds your whole team in the bell (and in the event's chat group, when it has one) before every confirmed event, and again the day before. Nothing is sent to clients."));
      var row = el("div", "evr-row");
      var lab = el("label", null, "Remind the team before each event: "); lab.setAttribute("for", "evr_days");
      var inp = el("input"); inp.type = "number"; inp.id = "evr_days"; inp.min = "1"; inp.max = "30"; inp.step = "1"; inp.value = String(r.days || 7);
      lab.appendChild(inp); lab.appendChild(document.createTextNode(" days")); row.appendChild(lab);
      var btn = el("button", "btn", "Save reminder"); btn.type = "button"; row.appendChild(btn);
      card.appendChild(row);
      var msg = el("p", "mnote evr-msg"); msg.setAttribute("role", "status"); card.appendChild(msg);
      if (!r.can_edit) { inp.disabled = true; btn.hidden = true; msg.textContent = "Only a studio admin can change this."; }
      btn.addEventListener("click", function () {
        var v = clampDays(String(inp.value).trim());
        if (!v) { msg.dataset.kind = "err"; msg.textContent = "Choose a whole number between 1 and 30."; return; }
        btn.disabled = true; msg.dataset.kind = ""; msg.textContent = "Saving...";
        S.reminderSet(v).then(function (o) {
          cacheDays((o && o.days) || v); msg.textContent = "Saved. The team will be reminded " + v + " day" + (v === 1 ? "" : "s") + " before each event.";
        }).catch(function (e) { msg.dataset.kind = "err"; msg.textContent = (e && e.message) || "Could not save."; })
          .then(function () { btn.disabled = false; });
      });
      anchor.parentNode.insertBefore(card, anchor);
    }).catch(function () {});
  }

  function eventBanner() {
    var mm = location.pathname.match(/\/events\/([^/]+)\/?$/);
    var id = new URLSearchParams(location.search).get("id") || (mm ? decodeURIComponent(mm[1]) : null); var S = store();
    var app = document.getElementById("app");
    if (!id || !app || !S || !S.reminderUpcoming) return;
    S.reminderUpcoming().then(function (r) {
      if (!r || !Array.isArray(r.items)) return;
      cacheDays(r.days);
      var it = r.items.filter(function (x) { return x && x.quote_id === id; })[0];
      if (!it || document.getElementById("evrBanner")) return;
      var n = Number(it.days_left);
      var b = el("div", "evr-banner" + (n <= 1 ? " evr-d1" : "")); b.id = "evrBanner"; b.setAttribute("role", "status");
      b.appendChild(el("span", "evr-chip", chipText(n)));
      b.appendChild(el("p", null, n <= 1 ? "Final check: staff, vendors, load-in and the checklist." : "Get ready: check the checklist, staff and vendors."));
      app.insertBefore(b, app.firstChild);
    }).catch(function () {});
  }

  function boot() {
    var p = (location.pathname.split("/").pop() || "").toLowerCase();
    var go = function () {
      if (/^(control|settings)(\.html)?$/.test(p) || document.getElementById("commsCard")) controlCard();
      else if (/^event(\.html)?$/.test(p) || /\/events\/[^/]+\/?$/.test(location.pathname)) eventBanner();
      else if (store() && store().reminderGet) store().reminderGet().then(function (r) { if (r) cacheDays(r.days); }).catch(function () {});
    };
    // wait for the store to sign in (pages call BPStore.init themselves)
    var tries = 0; (function wait() {
      var S = global.BPStore;
      if (S && S.auth && typeof S.auth.user === "function" && S.auth.user()) return go();
      if (++tries > 60) return;   // never signed in: show nothing
      setTimeout(wait, 500);
    })();
  }
  global.HelmEventReminders = { days: days, daysUntil: daysUntil, chipText: chipText };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})(typeof window !== "undefined" ? window : globalThis);
