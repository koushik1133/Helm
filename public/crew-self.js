/* crew-self.js - r23 (0265): the crew member's own side of the crew link (work.html).
   Three cards, each shown only when the studio switched it on (Settings -> Crew) and the database has 0265:
     #crewCheck  - event-day Check in / Check out (server time; the phone's location only when the studio asks for it,
                   and then only the distance to the venue is saved)
     #crewShifts - open shifts of the studio this person may take (one tap; first come or "needs approval")
     #crewAvail  - my availability: tap a day to mark it off / free (today .. 60 days shown)
   Every call is the work-link token (the same one the page already uses); nothing is kept in the browser.
   DOM API only (no HTML strings). India first: dd/mm/yyyy, the studio's currency in en-IN. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var doc = document, S = function () { return global.BPStore; };
  var LINK = null, token = null, home = null, busy = false, timer = null;

  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function errText(e) {
    var B = global.BPUI; try { if (B && B.friendlyError) return B.friendlyError(e, { action: "save that" }); } catch (x) {}
    return (e && e.message) ? String(e.message).slice(0, 240) : "Something went wrong - try again.";
  }
  function ymd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : null; }
  function addDays(s, n) { var d = ymd(s); if (!d) return ""; d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function fmtDay(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : ""; }
  function weekday(s) { var d = ymd(s); try { return d ? d.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }) : ""; } catch (e) { return ""; } }
  function money(n, cur) {
    var v = Number(n); if (!isFinite(v)) return "";
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", maximumFractionDigits: 0 }).format(v); }
    catch (e) { return (cur === "INR" || !cur ? "₹" : cur + " ") + Math.round(v).toLocaleString("en-IN"); }
  }
  function linkFor(tok) {
    if (!tok) return null;
    if (LINK && LINK.studio) return "/" + encodeURIComponent(LINK.studio) + "/work/" + encodeURIComponent(tok);
    return "/work.html?token=" + encodeURIComponent(tok);
  }
  function note(host, text, kind) {
    var old = host.querySelector(".cs-msg"); if (old) old.parentNode.removeChild(old);
    if (!text) return;
    host.appendChild(h("p", { cls: "cs-msg " + (kind || "err"), role: kind === "ok" ? "status" : "alert", text: text }));
  }

  // ---------------- check in / out ----------------
  function where() {
    return new Promise(function (res) {
      if (!navigator.geolocation) { res(null); return; }
      var done = false, fin = function (v) { if (!done) { done = true; res(v); } };
      try {
        navigator.geolocation.getCurrentPosition(function (p) { fin({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
          function () { fin(null); }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
      } catch (e) { fin(null); }
      setTimeout(function () { fin(null); }, 14000);
    });
  }
  function renderCheck() {
    var box = doc.getElementById("crewCheck"); if (!box) return;
    var ci = home && home.checkin;
    if (!ci || !home.settings || home.settings.selfCheckin === false || ci.event_live === false) { box.hidden = true; clear(box); return; }
    clear(box); box.hidden = false;
    box.appendChild(h("div", { cls: "cat", text: "📍 Event-day check-in" }));
    var card = h("div", { cls: "task cs-check" });
    box.appendChild(card);
    if (ci.check_in && ci.check_out) {
      card.appendChild(h("div", { cls: "tt", text: "Thank you - your day is recorded" }));
      card.appendChild(h("p", { cls: "rsl", text: "Checked in " + ci.check_in + " · checked out " + ci.check_out }));
      return;
    }
    if (ci.check_in) {
      card.appendChild(h("div", { cls: "tt", text: "You checked in at " + ci.check_in }));
      if (ci.late_min > 0) card.appendChild(h("p", { cls: "rsl", text: ci.late_min + " min after the start time" }));
      var out = h("button", { type: "button", cls: "btn primary cs-big", text: "Check out" });
      out.addEventListener("click", function () { doCheck("out", out, card); });
      card.appendChild(h("div", { cls: "acts" }, [out]));
      return;
    }
    if (!ci.today_ok) {
      var days = (ci.days || []).map(fmtDay).filter(Boolean);
      card.appendChild(h("div", { cls: "tt", text: "Check-in opens on the event day" }));
      if (days.length) card.appendChild(h("p", { cls: "rsl", text: "Your day" + (days.length > 1 ? "s" : "") + ": " + days.join(", ") }));
      return;
    }
    card.appendChild(h("div", { cls: "tt", text: "Reached the venue? Check in" }));
    var bits = [];
    if (ci.expected_start) bits.push("Start time " + ci.expected_start);
    if (ci.opens_at) bits.push("opens " + ci.opens_at);
    if (ci.needs_location) bits.push("your phone's location is checked against the venue (only the distance is saved)");
    if (bits.length) card.appendChild(h("p", { cls: "rsl", text: bits.join(" · ") }));
    var go = h("button", { type: "button", cls: "btn primary cs-big", text: "Check in now" });
    go.addEventListener("click", function () { doCheck("in", go, card); });
    card.appendChild(h("div", { cls: "acts" }, [go]));
  }
  async function doCheck(action, btn, card) {
    if (busy) return; busy = true; btn.disabled = true; var label = btn.textContent;
    note(card, "");
    try {
      var loc = null;
      if (home.checkin && home.checkin.needs_location) { btn.textContent = "Finding your location…"; loc = await where(); }
      btn.textContent = action === "in" ? "Checking in…" : "Checking out…";
      var r = await S().ops.shifts.check(token, action, loc);
      try { global.BPUI.toast(action === "in" ? ("Checked in at " + (r && r.check_in || "now") + (r && r.late ? " - the office knows you are late" : "")) : ("Checked out at " + (r && r.check_out || "now")), { type: "ok" }); } catch (e) {}
      await load(true);
    } catch (e) {
      btn.disabled = false; btn.textContent = label; note(card, errText(e));
    } finally { busy = false; }
  }

  // ---------------- open shifts ----------------
  function shiftWhen(s) {
    var t = s.start ? (s.start + (s.end ? "–" + s.end : "")) : "";
    return weekday(s.date) + " " + fmtDay(s.date) + (t ? " · " + t : "");
  }
  function renderShifts() {
    var box = doc.getElementById("crewShifts"); if (!box) return;
    var list = (home && home.shifts) || [];
    if (!home || !home.settings || home.settings.openShifts === false || !list.length) { box.hidden = true; clear(box); return; }
    clear(box); box.hidden = false;
    box.appendChild(h("div", { cls: "cat", text: "🙋 Open shifts you can take" }));
    list.forEach(function (s) {
      var card = h("div", { cls: "task cs-shift", "data-id": s.id });
      var st = s.my_status, pill = null;
      if (st === "approved") pill = h("span", { cls: "st accepted", text: "You're on it" });
      else if (st === "pending") pill = h("span", { cls: "st assigned", text: "Waiting for the office" });
      else if (st === "declined") pill = h("span", { cls: "st rejected", text: "Not given" });
      else if (s.status === "filled") pill = h("span", { cls: "st completed", text: "Full" });
      if (pill) card.appendChild(pill);
      card.appendChild(h("div", { cls: "tt", text: s.title }));
      card.appendChild(h("p", { cls: "rsl", text: shiftWhen(s) }));
      card.appendChild(h("p", { cls: "rsl", text: [s.event_title, s.venue ? "📍 " + s.venue : null].filter(Boolean).join(" · ") }));
      var facts = [];
      if (s.wage != null) facts.push(money(s.wage, home.currency) + (s.basis === "hour" ? " / hour" : " / day"));
      facts.push((Number(s.filled) || 0) + " of " + (Number(s.needed) || 1) + " taken");
      facts.push(s.mode === "approval" ? "the office picks" : "first come, first served");
      var f = h("p", { cls: "rsl cs-facts", text: facts.join(" · ") }); if (s.wage != null) f.setAttribute("data-money", "");
      card.appendChild(f);
      if (s.note) card.appendChild(h("p", { cls: "rsl", text: s.note }));
      if (st === "declined" && s.my_reason) card.appendChild(h("p", { cls: "rsl", text: "Reason: " + s.my_reason }));
      var acts = h("div", { cls: "acts" });
      if (st === "approved") {
        var l = linkFor(s.my_link);
        if (l) acts.appendChild(h("a", { cls: "btn", href: l, text: "Open that event's tasks" }));
      } else if (st === "pending") {
        var w = h("button", { type: "button", cls: "btn no", text: "Withdraw" });
        w.addEventListener("click", function () { act(w, card, function () { return S().ops.shifts.withdraw(token, s.id); }, "Withdrawn."); });
        acts.appendChild(w);
      } else if (st !== "declined" && s.status === "open") {
        if (s.unavailable) acts.appendChild(h("p", { cls: "rsl", text: "You marked this day unavailable - change it below to take the shift." }));
        else if (s.on_event && !st) acts.appendChild(h("p", { cls: "rsl", text: "You already work at this event." }));
        else {
          var c = h("button", { type: "button", cls: "btn ok", text: s.mode === "approval" ? "Ask for this shift" : "Take this shift" });
          c.addEventListener("click", function () {
            act(c, card, function () { return S().ops.shifts.claim(token, s.id); },
              s.mode === "approval" ? "Asked - the office will confirm." : "It's yours - it's now in your tasks.");
          });
          acts.appendChild(c);
        }
      }
      if (acts.firstChild) card.appendChild(acts);
      box.appendChild(card);
    });
  }
  async function act(btn, card, fn, okText) {
    if (busy) return; busy = true; btn.disabled = true; note(card, "");
    try { await fn(); try { global.BPUI.toast(okText, { type: "ok" }); } catch (e) {} await load(true);
      var rb = doc.getElementById("refreshBtn"); if (rb && !rb.disabled) rb.click(); }   // a shift on this event shows in the task list at once
    catch (e) { btn.disabled = false; note(card, errText(e)); }
    finally { busy = false; }
  }

  // ---------------- my availability ----------------
  function renderAvail() {
    var box = doc.getElementById("crewAvail"); if (!box) return;
    if (!home || !home.crew || !home.settings || home.settings.availability === false) { box.hidden = true; clear(box); return; }
    clear(box); box.hidden = false;
    var off = {}, work = {};
    (home.availability || []).forEach(function (a) { if (a && a.status === "unavailable") off[String(a.day).slice(0, 10)] = a; });
    (home.busy || []).forEach(function (d) { work[String(d).slice(0, 10)] = true; });
    box.appendChild(h("div", { cls: "cat", text: "📅 My availability" }));
    var card = h("div", { cls: "task cs-avail" });
    card.appendChild(h("p", { cls: "rsl", text: "Tap a day you can't work. Tap again when you're free. The office sees it before giving out work." }));
    var legend = h("p", { cls: "rsl cs-legend" }, [h("span", { cls: "cs-key off" }), " can't work  ", h("span", { cls: "cs-key work" }), " working"]);
    card.appendChild(legend);
    var grid = h("div", { cls: "cs-days", role: "group", "aria-label": "Next 60 days" });
    var today = String(home.today || "").slice(0, 10), month = "";
    for (var i = 0; i < 60; i++) {
      var d = addDays(today, i); if (!d) break;
      var mlabel = (function () { var x = ymd(d); try { return x.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }); } catch (e) { return d.slice(0, 7); } })();
      if (mlabel !== month) {
        month = mlabel; grid.appendChild(h("div", { cls: "cs-month", text: mlabel }));
        var lead = (ymd(d).getUTCDay() + 6) % 7;   // Monday-first columns: blank cells before the first day shown
        for (var k = 0; k < lead; k++) grid.appendChild(h("span", { cls: "cs-pad", "aria-hidden": "true" }));
      }
      var isOff = !!off[d], isWork = !!work[d];
      var b = h("button", { type: "button", cls: "cs-day" + (isOff ? " off" : "") + (isWork ? " work" : ""), "data-day": d,
        "aria-pressed": isOff ? "true" : "false",
        "aria-label": weekday(d) + " " + fmtDay(d) + (isOff ? ", marked can't work" : ", free") + (isWork ? ", you are working" : "")
          + (isOff && off[d].by_office ? ", set by the office" : "") }, [
        h("span", { cls: "w", text: weekday(d) }), h("b", { text: String(+d.slice(8, 10)) })]);
      b.addEventListener("click", (function (day, wasOff, isW, btn) { return function () { toggleDay(day, wasOff, isW, btn, card); }; })(d, isOff, isWork, b));
      grid.appendChild(b);
    }
    card.appendChild(grid);
    box.appendChild(card);
  }
  async function toggleDay(day, wasOff, isWork, btn, card) {
    if (busy) return;
    var want = wasOff ? "available" : "unavailable", reason = null;
    if (!wasOff) {
      var B = global.BPUI;
      if (B && B.prompt) {
        reason = await B.prompt((isWork ? "You are already working on " + fmtDay(day) + " - the office will be told. " : "") + "Reason (optional, only the office sees it):",
          { title: "Can't work on " + fmtDay(day) + "?", label: "Reason", okLabel: "Mark as can't work", required: false });
        if (reason === null) return;
      }
    }
    busy = true; btn.disabled = true; note(card, "");
    try {
      var r = await S().ops.shifts.setAvailability(token, day, want, reason);
      try { global.BPUI.toast(want === "unavailable" ? ("Marked " + fmtDay(day) + " as can't work" + (r && r.booked_that_day ? " - the office has been told" : "")) : (fmtDay(day) + " is free again"), { type: "ok" }); } catch (e) {}
      await load(true);
    } catch (e) { btn.disabled = false; note(card, errText(e)); }
    finally { busy = false; }
  }

  // ---------------- load ----------------
  function hideAll() { ["crewCheck", "crewShifts", "crewAvail"].forEach(function (id) { var b = doc.getElementById(id); if (b) { b.hidden = true; clear(b); } }); }
  async function load(force) {
    var B = S(); if (!B || !B.ops || !B.ops.shifts || !token) return;
    if (busy && !force) return;
    try {
      await B.init();
      home = await B.ops.shifts.home(token);
      if (!home || !home.crew) { hideAll(); return; }
      renderCheck(); renderShifts(); renderAvail();
    } catch (e) {
      // older database (no 0265) / expired link / offline: the page's own task list handles the message
      if (!home) hideAll();
    }
  }
  function start() {
    var B = S(); if (!B || !B.links) return;
    try { LINK = B.links.parse("work"); } catch (e) { LINK = null; }
    token = LINK ? LINK.ref : new URLSearchParams(location.search).get("token");
    if (!token) return;
    load(false);
    if (!timer) timer = setInterval(function () { if (doc.visibilityState === "visible" && navigator.onLine !== false) load(false); }, 90000);
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
  global.HelmCrewSelf = { reload: function () { return load(true); } };
})(window);
