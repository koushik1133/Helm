/* crew-shifts.js - r23 (0265): the office side of crew availability, open shifts and self check-in.
   Self-mounting cards (each only when its container is on the page, the page has shown its #app / main content,
   and the database has 0265; the server checks every right again):
     #shiftCard     (Operations)      post open shifts, see who claimed, approve / decline, close / re-open / cancel
     #crewTimesheet (Event day)       check-in / out times, hours, late + no-show? flags, office correction,
                                      the event's check-in location (for the optional location check)
     #crewAvailCard (Staff)           month grid: who can't work which day (+ who is working), tap to mark
     #crewCfgCard   (Settings)  the studio's crew settings
   DOM API only (no HTML strings). Amounts carry data-money (privacy mode masks them). dd/mm/yyyy, studio time zone. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var doc = document, S = function () { return global.BPStore; };

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
  function errText(e, action) {
    var B = global.BPUI; try { if (B && B.friendlyError) return B.friendlyError(e, { action: action || "save that" }); } catch (x) {}
    return (e && e.message) ? String(e.message).slice(0, 240) : "Something went wrong - try again.";
  }
  function toast(t, type) { try { global.BPUI.toast(t, { type: type || "ok" }); } catch (e) {} }
  function fmtDay(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : ""; }
  function ymd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : null; }
  function weekday(s) { var d = ymd(s); try { return d ? d.toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" }) : ""; } catch (e) { return ""; } }
  function money(n) { var B = S(); try { return B.studioMoney(Number(n)); } catch (e) { return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN"); } }
  function today() { var B = S(); try { return B.todayLocal(); } catch (e) { return new Date().toISOString().slice(0, 10); } }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  // a wall-clock time on a day in the STUDIO's time zone -> ISO instant (same method as Operations' schedule picker)
  function toInstant(day, hhmm) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || "")), t = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
    if (!d || !t) return null;
    var want = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]), x = want, B = S();
    try { for (var i = 0; i < 2; i++) { var c = B.studioClock(new Date(x)); if (!c) break; x = x - (Date.UTC(c.y, c.mo - 1, c.d, c.h, c.mi) - want); } } catch (e) {}
    return new Date(x).toISOString();
  }
  function addDays(s, n) { var d = ymd(s); if (!d) return ""; d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function pill(status, text) { return h("span", { cls: "cs-pill " + status, text: text }); }
  var SHIFT_LABEL = { open: "Open", filled: "Filled", closed: "Closed", cancelled: "Cancelled" };
  var CLAIM_LABEL = { pending: "Waiting", approved: "On the shift", declined: "Declined", withdrawn: "Withdrawn" };
  // "12.97, 77.59" | a Google Maps link (@12.97,77.59 / q=12.97,77.59 / !3d12.97!4d77.59) -> {lat, lng}
  function parseLatLng(v) {
    var s = String(v || ""), m = /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/.exec(s) || /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/.exec(s);
    if (!m) return null;
    var lat = Number(m[1]), lng = Number(m[2]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
  }
  function quoteId() {
    var q = null; try { q = global.HelmUrl && global.HelmUrl.value ? global.HelmUrl.value("quote") : null; } catch (e) {}
    var p = new URLSearchParams(location.search);
    return q || p.get("quote") || p.get("id") || "";
  }
  // run once the page has shown its app (the page checked sign-in + access first)
  function whenShown(id, fn) {
    var app = doc.getElementById(id);
    if (!app) { fn(); return; }
    if (!app.hidden) { fn(); return; }
    var mo = new MutationObserver(function () { if (!app.hidden) { mo.disconnect(); fn(); } });
    mo.observe(app, { attributes: true, attributeFilter: ["hidden"] });
  }
  function field(label, input, cls) { return h("label", { cls: cls || null }, [label, input]); }
  function msgLine(host) { var p = h("p", { cls: "cs-msg2", role: "status", "aria-live": "polite" }); host.appendChild(p); return p; }
  function say(p, text, kind) { if (!p) return; p.textContent = text || ""; p.className = "cs-msg2 " + (kind || ""); }

  // =====================================================================================================
  // Operations: open shifts
  // =====================================================================================================
  async function mountShifts(card) {
    var B = S(), q = quoteId(); if (!B || !B.ops || !B.ops.shifts || !q) return;
    var data = null;
    try { data = await B.ops.shifts.forEvent(q); } catch (e) { data = null; }
    if (!data || !data.settings || data.settings.openShifts === false) { card.hidden = true; return; }
    var ev = null; try { ev = await B.quotes.get(q); } catch (e) {}
    var depts = []; try { depts = await B.staff.departments(); } catch (e) {}
    render();

    function render() {
      clear(card); card.hidden = false; card.classList.add("cs-card");
      card.appendChild(h("h3", { text: "🙋 Open shifts" }));
      card.appendChild(h("p", { cls: "cs-sub", text: "Need more people? Post a shift - your crew see it on their crew link and take it with one tap"
        + (data.settings.notifyShifts ? " (a WhatsApp message is queued for each of them; it goes out once WhatsApp is switched on)." : ".")
        + " Taking a shift adds it to their tasks." }));
      if (data.can_edit) card.appendChild(form());
      var list = h("div", { cls: "cs-list" });
      (data.shifts || []).forEach(function (s) { list.appendChild(item(s)); });
      if (!(data.shifts || []).length) list.appendChild(h("p", { cls: "cs-note", text: "No open shifts for this event yet." }));
      card.appendChild(list);
    }
    async function reload() { try { data = await B.ops.shifts.forEvent(q); } catch (e) {} render(); }

    function form() {
      var wrap = h("div");
      var toggle = h("button", { type: "button", cls: "btn", "aria-expanded": "false", text: "＋ Post an open shift" });
      var f = h("form", { cls: "cs-form", hidden: true, novalidate: true });
      var title = h("input", { id: "cs_title", maxlength: "80", placeholder: "e.g. Waiter", required: true, autocomplete: "off" });
      var date = h("input", { id: "cs_date", type: "date", min: today(), value: (ev && ev.eventDate && ev.eventDate >= today()) ? ev.eventDate : today() });
      var start = h("input", { id: "cs_start", type: "time" }), end = h("input", { id: "cs_end", type: "time" });
      var wage = h("input", { id: "cs_wage", type: "number", min: "0", step: "1", inputmode: "numeric", placeholder: "e.g. 1000" });
      var basis = h("select", { id: "cs_basis" }, [h("option", { value: "day", text: "per day" }), h("option", { value: "hour", text: "per hour" })]);
      var needed = h("input", { id: "cs_needed", type: "number", min: "1", max: "100", step: "1", value: "1", inputmode: "numeric" });
      var dept = h("select", { id: "cs_dept" }, [h("option", { value: "", text: "Anyone on the Staff list" })].concat(
        (depts || []).map(function (d) { return h("option", { value: d, text: d + " team only" }); })));
      var mode = h("select", { id: "cs_mode" }, [h("option", { value: "first_come", text: "First come, first served" }), h("option", { value: "approval", text: "Needs my approval" })]);
      mode.value = data.settings.claimMode === "approval" ? "approval" : "first_come";
      var noteIn = h("input", { id: "cs_note", maxlength: "500", placeholder: "e.g. Black shirt, report at gate 2" });
      var go = h("button", { type: "submit", cls: "btn primary", text: "Post shift" });
      f.appendChild(field("Role", title)); f.appendChild(field("Date", date));
      f.appendChild(field("Start", start)); f.appendChild(field("End", end));
      f.appendChild(field("Wage (optional)", wage)); f.appendChild(field("Wage is", basis));
      f.appendChild(field("People needed", needed)); f.appendChild(field("Who can take it", dept));
      f.appendChild(field("How it's given", mode)); f.appendChild(field("Note for the crew", noteIn, "wide"));
      var row = h("div", { cls: "cs-row wide" }, [go]); f.appendChild(row);
      var m = msgLine(row);
      toggle.addEventListener("click", function () { f.hidden = !f.hidden; toggle.setAttribute("aria-expanded", String(!f.hidden)); if (!f.hidden) title.focus(); });
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var t = title.value.trim(), n = Math.trunc(Number(needed.value)), w = wage.value.trim();
        if (t.length < 2) { say(m, "Give the role (e.g. Waiter).", "err"); title.focus(); return; }
        if (!date.value || date.value < today()) { say(m, "Pick a date from today on.", "err"); date.focus(); return; }
        if (end.value && !start.value) { say(m, "Give a start time with the end time.", "err"); start.focus(); return; }
        if (!(n >= 1 && n <= 100)) { say(m, "People needed must be 1 to 100.", "err"); needed.focus(); return; }
        if (w !== "" && !(Number(w) >= 0)) { say(m, "Wage must be 0 or more.", "err"); wage.focus(); return; }
        global.BPUI.guard(go, async function () {
          try {
            var r = await B.ops.shifts.post(q, { title: t, date: date.value, start: start.value || null, end: end.value || null,
              wage: w === "" ? null : Number(w), basis: basis.value, needed: n, mode: mode.value, department: dept.value || null, note: noteIn.value.trim() || null });
            toast("Shift posted" + (r && r.notified ? " - " + r.notified + " people told" : "") + ".");
            await reload();
          } catch (err) { say(m, errText(err, "post the shift"), "err"); }
        }, { busyLabel: "Posting…" });
      });
      wrap.appendChild(toggle); wrap.appendChild(f);
      return wrap;
    }

    function item(s) {
      var box = h("div", { cls: "cs-item", "data-id": s.id });
      var taken = (s.claims || []).filter(function (c) { return c.status === "approved"; }).length;
      box.appendChild(h("div", { cls: "cs-row" }, [h("span", { cls: "cs-t", text: s.title }), pill(s.status, SHIFT_LABEL[s.status] || s.status)]));
      var when = weekday(s.date) + " " + fmtDay(s.date) + (s.start ? " · " + s.start + (s.end ? "–" + s.end : "") : "");
      var meta = [when, taken + " of " + s.needed + " taken", s.mode === "approval" ? "needs approval" : "first come",
        s.department ? s.department + " team only" : null, s.notified ? s.notified + " told" : null].filter(Boolean).join(" · ");
      box.appendChild(h("div", { cls: "cs-m", text: meta }));
      if (s.wage != null) box.appendChild(h("div", { cls: "cs-m", "data-money": "", text: "Wage " + money(s.wage) + (s.basis === "hour" ? " per hour" : " per day") }));
      if (s.note) box.appendChild(h("div", { cls: "cs-m", text: s.note }));
      var claims = h("div", { cls: "cs-claims" });
      (s.claims || []).forEach(function (c) {
        var row = h("div", { cls: "cs-claim" }, [h("b", { text: c.name || "Crew" }), pill(c.status, CLAIM_LABEL[c.status] || c.status),
          c.reason ? h("span", { cls: "cs-note", text: c.reason }) : null]);
        if (data.can_edit && c.status === "pending") {
          var ok = h("button", { type: "button", cls: "btn sm primary", text: "Approve", "aria-label": "Approve " + (c.name || "claim") });
          var no = h("button", { type: "button", cls: "btn sm", text: "Decline", "aria-label": "Decline " + (c.name || "claim") });
          ok.addEventListener("click", function () { global.BPUI.guard(ok, async function () {
            try { await B.ops.shifts.decide(c.id, true); toast((c.name || "They") + " is on the shift - a task was added."); await reload(); }
            catch (e) { toast(errText(e, "approve"), "err"); } }); });
          no.addEventListener("click", async function () {
            var why = await global.BPUI.prompt("Reason (shown to " + (c.name || "them") + " on their crew link, optional):", { title: "Decline this claim?", label: "Reason", okLabel: "Decline", required: false });
            if (why === null) return;
            global.BPUI.guard(no, async function () { try { await B.ops.shifts.decide(c.id, false, why); toast("Declined."); await reload(); } catch (e) { toast(errText(e, "decline"), "err"); } });
          });
          row.appendChild(ok); row.appendChild(no);
        }
        claims.appendChild(row);
      });
      if ((s.claims || []).length) box.appendChild(claims);
      if (data.can_edit) {
        var acts = h("div", { cls: "cs-actions" });
        var add = function (label, action, danger) {
          var b = h("button", { type: "button", cls: "btn sm", text: label });
          b.addEventListener("click", async function () {
            if (danger && !(await global.BPUI.confirm("Cancel the " + s.title + " shift? People waiting are told no; people already on it keep their task (remove it on Operations if needed).", { title: "Cancel shift?", okLabel: "Cancel shift", danger: true }))) return;
            global.BPUI.guard(b, async function () { try { await B.ops.shifts.setStatus(s.id, action); await reload(); } catch (e) { toast(errText(e, "change the shift"), "err"); } });
          });
          acts.appendChild(b);
        };
        if (s.status === "open") { add("Stop taking claims", "close"); add("Cancel shift", "cancel", true); }
        else if (s.status === "closed" || s.status === "filled") { if (taken < s.needed || s.status === "closed") add("Re-open", "reopen"); add("Cancel shift", "cancel", true); }
        if (acts.firstChild) box.appendChild(acts);
      }
      return box;
    }
  }

  // =====================================================================================================
  // Event day: check-in timesheet + check-in location
  // =====================================================================================================
  async function mountTimesheet(card) {
    var B = S(), q = quoteId(); if (!B || !B.ops || !B.ops.shifts || !q) return;
    var t = null, siteOpen = null;   // r24 ui: remembers whether the owner opened the check-in location box
    try { t = await B.ops.shifts.timesheet(q); } catch (e) { t = null; }
    if (!t) { card.hidden = true; return; }
    render();
    async function reload() { try { t = await B.ops.shifts.timesheet(q); } catch (e) {} render(); }
    function render() {
      clear(card); card.hidden = false; card.classList.add("cs-card");
      var st = t.settings || {};
      card.appendChild(h("h2", { text: "🕒 Crew check-in & hours" }));
      card.appendChild(h("p", { cls: "sub", text: st.selfCheckin === false
        ? "Self check-in is off (Settings → Crew & shifts). You can still enter times here."
        : "Crew check in and out on their own crew link; the time is the server's. Late = more than " + (st.lateGraceMin || 15)
          + " min after their start; \"no-show?\" = no check-in " + (st.noShowAfterMin || 60) + " min after it. Times feed the wages on Budget." }));
      var rows = t.rows || [];
      if (!rows.length) {
        // r24 ui: a plain empty state with the way forward
        var opsA = h("a", { href: "ops.html?quote=" + encodeURIComponent(q), cls: "cs-link", text: "Tasks & staff" });
        card.appendChild(h("p", { cls: "cs-empty" }, ["No crew on this event yet - assign people in ", opsA, "."]));
      }
      else {
        var tbl = h("table", { cls: "cs-table" });
        tbl.appendChild(h("thead", {}, [h("tr", {}, ["Name", "Start", "In", "Out", "Hours", "Status", ""].map(function (x) { return h("th", { scope: "col", text: x }); }))]));
        var tb = h("tbody"); tbl.appendChild(tb);
        rows.forEach(function (r) {
          var entries = (r.entries && r.entries.length) ? r.entries : [null];
          entries.forEach(function (e, i) {
            var tr = h("tr");
            tr.appendChild(h("td", { text: i === 0 ? (r.name || "Crew") + (r.department ? " · " + r.department : "") : "" }));
            tr.appendChild(h("td", { cls: "num", text: i === 0 ? (r.expected_start || "—") : "" }));
            tr.appendChild(h("td", { cls: "num", text: e ? (e["in"] || "") + (entries.length > 1 || (e.day && e.day !== t.event_date) ? " (" + fmtDay(e.day) + ")" : "") : "—" }));
            tr.appendChild(h("td", { cls: "num", text: e && e.out ? e.out : "—" }));
            tr.appendChild(h("td", { cls: "num", text: i === 0 && r.hours != null ? String(r.hours) + " h" : "" }));
            var stc = h("td");
            if (i === 0) {
              if (r.flag === "late") stc.appendChild(pill("late", "Late " + (r.late_min || 0) + " min"));
              else if (r.flag === "no_show_suspected") stc.appendChild(pill("no_show_suspected", "No-show?"));
              else if (r.flag === "no_show") stc.appendChild(pill("no_show", "No-show"));
              else if (e && e.out) stc.appendChild(pill("filled", "Done"));
              else if (e) stc.appendChild(pill("approved", "Checked in"));
              else if (r.roster === "arrived" || r.roster === "left") stc.appendChild(pill("approved", r.roster === "left" ? "Left" : "Arrived"));
              else stc.appendChild(pill("closed", "Not in yet"));
            }
            if (e && e.edited) stc.appendChild(h("div", { cls: "cs-note", text: "corrected" + (e.edit_note ? ": " + e.edit_note : "") + (e.orig_in ? " (crew: " + e.orig_in + (e.orig_out ? "–" + e.orig_out : "") + ")" : "") }));
            if (e && e.within === false) stc.appendChild(h("div", { cls: "cs-note", text: (e.distance_m || 0) + " m from the venue" }));
            tr.appendChild(stc);
            var ac = h("td");
            if (t.can_edit) {
              var b = h("button", { type: "button", cls: "btn sm", text: e ? "Edit" : "Enter times", "aria-label": (e ? "Edit times for " : "Enter times for ") + (r.name || "crew") });
              b.addEventListener("click", function () { editRow(tr, r, e); });
              ac.appendChild(b);
            }
            tr.appendChild(ac);
            tb.appendChild(tr);
          });
        });
        card.appendChild(h("div", { cls: "cs-tablewrap" }, [tbl]));
      }
      if (t.can_edit) card.appendChild(siteForm(rows.length));
    }
    function editRow(tr, r, e) {
      var next = tr.nextSibling; if (next && next.classList && next.classList.contains("cs-editrow")) { next.parentNode.removeChild(next); return; }
      var day = h("input", { type: "date", value: (e && e.day) || t.event_date || t.today, max: t.today, "aria-label": "Work day" });
      var tin = h("input", { type: "time", value: (e && e["in"]) || "", "aria-label": "In time" });
      var tout = h("input", { type: "time", value: (e && e.out) || "", "aria-label": "Out time" });
      var why = h("input", { maxlength: "300", placeholder: e && e.source === "crew" ? "Why you are changing it (required)" : "Note (optional)", "aria-label": "Reason" });
      var save = h("button", { type: "button", cls: "btn sm primary", text: "Save times" });
      var m = h("p", { cls: "cs-msg2", role: "status" });
      var cell = h("td", { colspan: "7" }, [h("div", { cls: "cs-edit" }, [field("Day", day), field("In", tin), field("Out", tout), field("Reason", why)]), h("div", { cls: "cs-row" }, [save, m])]);
      var row = h("tr", { cls: "cs-editrow" }, [cell]);
      tr.parentNode.insertBefore(row, tr.nextSibling); tin.focus();
      save.addEventListener("click", function () {
        if (!day.value || !tin.value) { say(m, "Give the day and the in time.", "err"); return; }
        var inAt = toInstant(day.value, tin.value), outAt = tout.value ? toInstant(tout.value < tin.value ? addDays(day.value, 1) : day.value, tout.value) : null;
        if (!inAt) { say(m, "Couldn't read that time.", "err"); return; }
        global.BPUI.guard(save, async function () {
          try { await B.ops.shifts.officeCheck(q, r.crew_id, day.value, inAt, outAt, why.value.trim() || null); toast("Times saved."); await reload(); }
          catch (err) { say(m, errText(err, "save the times"), "err"); }
        });
      });
    }
    // r24 ui: the check-in location is optional. While the location check is off, or nobody is on the event yet, it is a
    // small "Set check-in location (optional)" link that opens the box - it no longer dominates the card.
    function ccLink() { return h("a", { href: "control.html#crew", cls: "cs-link", text: "Settings → Crew & shifts" }); }
    function siteForm(nRows) {
      var st = t.settings || {}, site = t.site;
      var small = !st.geofence || !nRows;
      var wrap = h("details", { cls: "cs-site" + (small ? " cs-site-small" : "") });
      if (siteOpen === null ? !small : siteOpen) wrap.open = true;
      wrap.addEventListener("toggle", function () { siteOpen = wrap.open; });
      wrap.appendChild(h("summary", { text: site ? "📍 Check-in location: set (" + site.radius_m + " m) - change" : (small ? "📍 Set check-in location (optional)" : "📍 Check-in location") }));
      var box = h("div", { cls: "cs-item" });
      wrap.appendChild(box);
      box.appendChild(h("div", { cls: "cs-m" }, st.geofence
        ? [(site ? "Venue point " + site.lat + ", " + site.lng + " · " + site.radius_m + " m. " : "No venue point set. ") + "Location check is ON: crew must be within the radius to check in."]
        : [(site ? "Venue point " + site.lat + ", " + site.lng + " · " + site.radius_m + " m. " : "") + "Location check is off - turn on in ", ccLink(), ". The point is only used once it is on."]));
      var where = h("input", { placeholder: "Paste a Google Maps link or 12.9716, 77.5946", "aria-label": "Venue location", value: site ? site.lat + ", " + site.lng : "" });
      var rad = h("input", { type: "number", min: "50", max: "5000", step: "10", value: String((site && site.radius_m) || st.geofenceRadiusM || 300), "aria-label": "Radius in metres", inputmode: "numeric" });
      var here = h("button", { type: "button", cls: "btn sm", text: "Use my location" });
      var save = h("button", { type: "button", cls: "btn sm primary", text: "Save location" });
      var off = site ? h("button", { type: "button", cls: "btn sm", text: "Clear" }) : null;
      var m = h("p", { cls: "cs-msg2", role: "status" });
      box.appendChild(h("div", { cls: "cs-form" }, [field("Venue", where, "wide"), field("Radius (m)", rad)]));
      box.appendChild(h("div", { cls: "cs-row" }, [here, save, off, m]));
      here.addEventListener("click", function () {
        if (!navigator.geolocation) { say(m, "This browser can't share its location.", "err"); return; }
        say(m, "Finding your location…");
        navigator.geolocation.getCurrentPosition(function (p) { where.value = (Math.round(p.coords.latitude * 1e6) / 1e6) + ", " + (Math.round(p.coords.longitude * 1e6) / 1e6); say(m, "Got it - press Save location.", "ok"); },
          function () { say(m, "Location permission is needed (or paste a Maps link).", "err"); }, { enableHighAccuracy: true, timeout: 12000 });
      });
      save.addEventListener("click", function () {
        var p = parseLatLng(where.value), r = Math.trunc(Number(rad.value));
        if (!p) { say(m, "Paste a Google Maps link or latitude, longitude (e.g. 12.9716, 77.5946).", "err"); return; }
        if (!(r >= 50 && r <= 5000)) { say(m, "Radius must be 50 to 5000 metres.", "err"); return; }
        global.BPUI.guard(save, async function () { try { await B.ops.shifts.setSite(q, p.lat, p.lng, r); toast("Check-in location saved."); await reload(); } catch (e) { say(m, errText(e, "save the location"), "err"); } });
      });
      if (off) off.addEventListener("click", function () {
        global.BPUI.guard(off, async function () { try { await B.ops.shifts.setSite(q, null, null, Math.trunc(Number(rad.value)) || 300); toast("Location cleared."); await reload(); } catch (e) { say(m, errText(e, "clear the location"), "err"); } });
      });
      if (st.geofence) return wrap;
      // check off: while the box is closed, one quiet line says why it is optional (the open box says it itself)
      var offNote = h("p", { cls: "cs-note cs-offnote" }, ["Location check is off - turn on in ", ccLink(), "."]);
      offNote.hidden = wrap.open;
      wrap.addEventListener("toggle", function () { offNote.hidden = wrap.open; });
      return h("div", { cls: "cs-sitebar" }, [wrap, offNote]);
    }
  }

  // =====================================================================================================
  // Staff: availability month grid
  // =====================================================================================================
  async function mountAvailability(card) {
    var B = S(); if (!B || !B.ops || !B.ops.shifts || !B.auth) return;
    try { if (!(await B.auth.canView("staff"))) { card.hidden = true; return; } } catch (e) { card.hidden = true; return; }
    var canEdit = false; try { canEdit = await B.auth.canEditArea("staff"); } catch (e) {}
    var month = today().slice(0, 7);
    // r80: the Staff page fires this after a deactivate / reactivate / save, so the grid drops or adds the row now
    doc.addEventListener("helm:staff-changed", function () { draw().catch(function () {}); });
    await draw();
    async function draw() {
      var from = month + "-01", last = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate(), to = month + "-" + pad(last);
      var off = null, crew = [], work = {};
      try { off = await B.ops.shifts.availability(from, to, null); } catch (e) { off = null; }
      if (off === null) { card.hidden = true; return; }
      try { crew = await B.ops.listCrew(); } catch (e) { crew = []; }
      try { (await B.ops.crew.schedule(from, to) || []).forEach(function (r) { var k = r.crew_id + "|" + String(r.sched_date).slice(0, 10); (work[k] = work[k] || []).push(r.event_code); }); } catch (e) {}
      var offMap = {}; (off || []).forEach(function (a) { offMap[a.crew_id + "|" + String(a.day).slice(0, 10)] = a; });
      clear(card); card.hidden = false; card.classList.add("cs-card");
      card.appendChild(h("h3", { text: "📅 Availability" }));
      card.appendChild(h("p", { cls: "cs-sub", text: "Days your crew can't work (marked by them on their crew link, or by you here) and the days they already work. "
        + (canEdit ? "Tap a day to mark it can't work / free again." : "") }));
      var label = (function () { var d = ymd(from); try { return d.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }); } catch (e) { return month; } })();
      var prev = h("button", { type: "button", cls: "btn sm", "aria-label": "Previous month", text: "‹" });
      var next = h("button", { type: "button", cls: "btn sm", "aria-label": "Next month", text: "›" });
      prev.addEventListener("click", function () { var d = ymd(from); d.setUTCMonth(d.getUTCMonth() - 1); month = d.toISOString().slice(0, 7); draw(); });
      next.addEventListener("click", function () { var d = ymd(from); d.setUTCMonth(d.getUTCMonth() + 1); month = d.toISOString().slice(0, 7); draw(); });
      card.appendChild(h("div", { cls: "cs-row" }, [prev, h("b", { text: label, "aria-live": "polite" }), next,
        h("span", { cls: "cs-note" }, [h("span", { cls: "cs-key off" }), " can't work  ", h("span", { cls: "cs-key work" }), " working"])]));
      if (!crew.length) { card.appendChild(h("p", { cls: "cs-note", text: "No staff yet." })); return; }
      var tbl = h("table", { cls: "cs-grid" });
      var hr = h("tr", {}, [h("th", { cls: "nm", scope: "col", text: "Staff" })]);
      for (var d = 1; d <= last; d++) { var ds = month + "-" + pad(d), wd = weekday(ds); hr.appendChild(h("th", { scope: "col", cls: /Sat|Sun/.test(wd) ? "we" : null, title: wd + " " + fmtDay(ds), text: String(d) })); }
      tbl.appendChild(h("thead", {}, [hr]));
      var tb = h("tbody"); tbl.appendChild(tb);
      crew.slice(0, 200).forEach(function (c) {
        var tr = h("tr", {}, [h("td", { cls: "nm", title: c.name, text: c.name })]);
        for (var d = 1; d <= last; d++) {
          var ds = month + "-" + pad(d), k = c.id + "|" + ds, o = offMap[k], w = work[k];
          var lbl = c.name + ", " + weekday(ds) + " " + fmtDay(ds) + (o ? ", can't work" + (o.note ? " (" + o.note + ")" : "") + (o.source === "crew" ? ", marked by them" : "") : ", free") + (w ? ", working " + w.join(", ") : "");
          var b = h("button", { type: "button", cls: "cs-cell" + (o ? " off" : "") + (w ? " work" : ""), title: lbl, "aria-label": lbl, "aria-pressed": o ? "true" : "false", text: o ? "✕" : (w ? "•" : "") });
          if (!canEdit) b.disabled = true;
          else b.addEventListener("click", (function (crewId, day, wasOff, btn, name) { return async function () {
            var note = null;
            if (!wasOff) { note = await global.BPUI.prompt("Reason (optional):", { title: name + " can't work on " + fmtDay(day) + "?", label: "Reason", okLabel: "Mark can't work", required: false }); if (note === null) return; }
            btn.disabled = true;
            try { await B.ops.shifts.setCrewAvailability(crewId, day, wasOff ? "available" : "unavailable", note); await draw(); }
            catch (e) { btn.disabled = false; toast(errText(e, "change the day"), "err"); }
          }; })(c.id, ds, !!o, b, c.name));
          tr.appendChild(h("td", {}, [b]));
        }
        tb.appendChild(tr);
      });
      card.appendChild(h("div", { cls: "cs-tablewrap" }, [tbl]));
    }
  }

  // =====================================================================================================
  // Settings: crew settings
  // =====================================================================================================
  // r93: the radius box was empty when the saved settings carried no radius - show the DB default (300 m, migration 0265/0274)
  function radiusOrDefault(v) { var n = Number(v); return (v !== null && v !== undefined && v !== "" && isFinite(n) && n >= 50 && n <= 5000) ? Math.round(n) : 300; }
  async function mountSettings(card) {
    var B = S(); if (!B || !B.ops || !B.ops.shifts) return;
    var cfg = null; try { cfg = await B.ops.shifts.settings(); } catch (e) { cfg = null; }
    if (!cfg) { card.hidden = true; return; }
    clear(card); card.hidden = false; card.classList.add("cs-card");
    function chk(id, label, on) { var i = h("input", { type: "checkbox", id: id }); i.checked = !!on; return { input: i, el: h("label", { cls: "cs-chk", for: id }, [i, h("span", { text: label })]) }; }
    function num(id, v, min, max, step) { return h("input", { id: id, type: "number", min: String(min), max: String(max), step: String(step || 1), value: String(v), inputmode: "numeric" }); }
    card.appendChild(h("h3", { text: "Crew & shifts: availability, open shifts & check-in" }));
    card.appendChild(h("p", { cls: "mnote", text: "How your crew use their crew link: mark days they can't work, take open shifts, and check in / out on the event day. Check-in times become the actual wages on Budget." }));
    var av = chk("cc_av", "Crew can mark days they can't work (Operations warns before you assign them)", cfg.availability);
    var os = chk("cc_os", "Open shifts: post shifts that crew take from their crew link", cfg.openShifts);
    // r25 (0274): the WhatsApp message to crew about a new shift is switched on / off ONLY in Settings -> Automations
    var nt = { el: h("p", { cls: "mnote au-onoff", id: "cc_nt" }, ["WhatsApp to free crew when a shift is posted: ", h("b", { text: cfg.notifyShifts ? "on" : "off" }),
      " - switch it in ", h("a", { href: "#automations", text: "Automations → Open shift messages" }), "."]) };
    var mode = h("select", { id: "cc_mode" }, [h("option", { value: "first_come", text: "First come, first served" }), h("option", { value: "approval", text: "Needs approval" })]);
    mode.value = cfg.claimMode === "approval" ? "approval" : "first_come";
    var ci = chk("cc_ci", "Self check-in / check-out on the crew link on the event day", cfg.selfCheckin);
    var gf = chk("cc_gf", "Location check: crew must be near the venue to check in (only the distance is saved; set the venue point on the event-day page)", cfg.geofence);
    var rad = num("cc_rad", radiusOrDefault(cfg.geofenceRadiusM), 50, 5000, 10), grace = num("cc_grace", cfg.lateGraceMin, 0, 240), ns = num("cc_ns", cfg.noShowAfterMin, 15, 720);
    var pay = h("select", { id: "cc_pay" }, [h("option", { value: "day", text: "Per day (day rate x days checked in)" }), h("option", { value: "hours", text: "Per hour (hours checked in x day rate / day hours)" })]);
    pay.value = cfg.payBasis === "hours" ? "hours" : "day";
    var dh = num("cc_dh", cfg.dayHours, 1, 24, 0.5);
    var msg = h("p", { cls: "mnote", role: "status", "aria-live": "polite" });
    var save = h("button", { type: "button", cls: "btn", id: "cc_save", text: "Save crew settings" });
    card.appendChild(av.el); card.appendChild(os.el); card.appendChild(nt.el);
    card.appendChild(h("div", { cls: "cs-form" }, [field("New shifts are given", mode)]));
    card.appendChild(ci.el); card.appendChild(gf.el);
    card.appendChild(h("div", { cls: "cs-form" }, [field("Check-in radius (m)", rad), field("Late after (min past start)", grace), field("No-show? after (min)", ns)]));
    card.appendChild(h("div", { cls: "cs-form" }, [field("Actual wages from check-in", pay, "wide"), field("Hours in a working day", dh)]));
    card.appendChild(msg); card.appendChild(save);
    if (!cfg.can_edit) {
      Array.prototype.forEach.call(card.querySelectorAll("input,select,button"), function (x) { x.disabled = true; });
      msg.textContent = "Only people with Settings edit rights can change these settings."; return;
    }
    save.addEventListener("click", function () {
      var n = function (el, lo, hi) { var v = Number(el.value); return isFinite(v) && v >= lo && v <= hi ? v : null; };
      var patch = { availability: av.input.checked, openShifts: os.input.checked, claimMode: mode.value,
        selfCheckin: ci.input.checked, geofence: gf.input.checked, payBasis: pay.value };
      var r = n(rad, 50, 5000), g = n(grace, 0, 240), s = n(ns, 15, 720), d = n(dh, 1, 24);
      // r93: the radius only matters when Location check is on; when it is off an empty / odd value is skipped (the saved one is kept)
      if (r === null && gf.input.checked) { msg.textContent = "Please enter a check-in radius between 50 and 5000 metres (300 is a good start)."; rad.setAttribute("aria-invalid", "true"); rad.focus(); return; }
      rad.removeAttribute("aria-invalid");
      if (g === null) { msg.textContent = "Late after must be 0 to 240 minutes."; grace.focus(); return; }
      if (s === null) { msg.textContent = "No-show after must be 15 to 720 minutes."; ns.focus(); return; }
      if (d === null) { msg.textContent = "A working day must be 1 to 24 hours."; dh.focus(); return; }
      if (r !== null) patch.geofenceRadiusM = r; patch.lateGraceMin = g; patch.noShowAfterMin = s; patch.dayHours = d;
      global.BPUI.guard(save, async function () {
        try { await B.ops.shifts.saveSettings(patch); msg.textContent = "Saved."; toast("Crew settings saved."); }
        catch (e) { msg.textContent = errText(e, "save the crew settings"); }
      }, { busyLabel: "Saving…" });
    });
  }

  function start() {
    var B = S(); if (!B || !B.ops || !B.ops.shifts) return;
    var sc = doc.getElementById("shiftCard"), ts = doc.getElementById("crewTimesheet"), av = doc.getElementById("crewAvailCard"), cc = doc.getElementById("crewCfgCard");
    if (sc) whenShown("app", function () { mountShifts(sc).catch(function () { sc.hidden = true; }); });
    if (ts) whenShown("app", function () { mountTimesheet(ts).catch(function () { ts.hidden = true; }); });
    if (av) whenShown("grid", function () { B.init().then(function () { return mountAvailability(av); }).catch(function () { av.hidden = true; }); });
    if (cc) B.init().then(function () { return mountSettings(cc); }).catch(function () { cc.hidden = true; });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
  global.HelmCrewShifts = { parseLatLng: parseLatLng, toInstant: toInstant, radiusOrDefault: radiusOrDefault };
})(window);
