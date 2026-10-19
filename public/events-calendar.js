/* events-calendar.js - "Events" view of the Calendar page (cal-events-1018): WHICH EVENT IS ON WHEN.
 * Month / Week / Day of every dated event (confirmed, tentative = still a quote, open leads with a date),
 * colour-coded by status with a legend that doubles as a filter, plus an event-type filter.
 * Month: up to 3 chips per day + "+N more" (opens that day), today ringed, a conflict badge on clash days.
 * Week: 7 day columns of event cards. Day: full cards. Phones (<= 600px): an agenda list by day.
 * Multi-day: an item with `end` (YYYY-MM-DD after `date`) shows on every day it covers (capped at 31).
 * Hover / focus on a chip shows a small card (status, when, venue, guests, type, code). Click opens the event.
 * Keyboard: the day numbers of the month grid are one tab stop (roving tabindex): arrows move a day / a week,
 * Home / End = start / end of the week, Enter opens that day. Escape closes the hover card.
 * Data comes from the page (opts.items: [{key, kind, date, end, title, code, time, venue, guests, type, href,
 * sample, clash}]); dates are calendar days ("YYYY-MM-DD") and never shifted by a timezone; "today" is the
 * STUDIO's today (opts.today). Every string goes through esc() / textContent; no inline style attributes. */
(function () {
  "use strict";
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
  // calendar-day arithmetic in UTC (no DST / zone drift)
  var toD = function (s) { var m = ISO.exec(String(s || "").slice(0, 10)); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
  var toS = function (d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); };
  var add = function (s, n) { var d = toD(s); d.setUTCDate(d.getUTCDate() + n); return toS(d); };
  var dow = function (s) { return (toD(s).getUTCDay() + 6) % 7; };                       // 0 = Monday
  var monday = function (s) { return add(s, -dow(s)); };
  var first = function (s) { return s.slice(0, 8) + "01"; };
  var lastOf = function (s) { var d = toD(first(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return toS(d); };
  var addMonths = function (s, n) { var d = toD(first(s)); d.setUTCMonth(d.getUTCMonth() + n); return toS(d); };
  var KINDS = ["confirmed", "tentative", "lead"];
  var KLABEL = { confirmed: "Confirmed", tentative: "Tentative", lead: "Lead" };
  var KHINT = { confirmed: "booked", tentative: "still a quote", lead: "enquiry, no quote yet" };
  var VIEWS = ["month", "week", "day"];
  var MAXSPAN = 31;
  var hhmm = function (t) { var m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); return m ? pad(+m[1]) + ":" + m[2] : ""; };
  var numLoc = function () { try { var B = window.BPStore; return B && B.studioLocale ? B.studioLocale() : undefined; } catch (e) { return undefined; } };
  var guestsTxt = function (g) { var n = Math.round(Number(g)); return n > 0 ? n.toLocaleString(numLoc()) + (n === 1 ? " guest" : " guests") : ""; };

  // expand items to day rows: { day, it, n (1-based day of the run), of (days in the run) }
  function expand(items) {
    var out = [];
    (items || []).forEach(function (it) {
      if (!it || !toD(it.date)) return;
      var d0 = String(it.date).slice(0, 10), d1 = it.end && toD(it.end) && String(it.end).slice(0, 10) > d0 ? String(it.end).slice(0, 10) : d0;
      var of = Math.min(MAXSPAN, Math.round((toD(d1) - toD(d0)) / 864e5) + 1);
      for (var i = 0; i < of; i++) out.push({ day: add(d0, i), it: it, n: i + 1, of: of });
    });
    return out;
  }
  var KORD = { confirmed: 0, tentative: 1, lead: 2 };
  function sortDay(a, b) {
    var ta = hhmm(a.it.time) || "99", tb = hhmm(b.it.time) || "99";
    return (ta < tb ? -1 : ta > tb ? 1 : 0) || (KORD[a.it.kind] - KORD[b.it.kind]) || String(a.it.title || "").localeCompare(String(b.it.title || ""));
  }

  function mount(root, opts) {
    opts = opts || {};
    var itemsFn = opts.items || function () { return []; };
    var todayFn = opts.today || function () { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
    var fmt = opts.fmt || function (s, o) { var d = toD(s); return d ? d.toLocaleDateString(undefined, Object.assign({ timeZone: "UTC" }, o)) : ""; };
    var kinds = (opts.kinds || KINDS).filter(function (k) { return KINDS.indexOf(k) >= 0; });
    var st = { view: VIEWS.indexOf(opts.view) >= 0 ? opts.view : "month", anchor: todayFn(), show: {}, type: "", focusDay: null };
    kinds.forEach(function (k) { st.show[k] = true; });
    var narrow = function () { try { return !!(window.matchMedia && window.matchMedia("(max-width: 600px)").matches); } catch (e) { return false; } };
    var idx = {}, tip = null, tipFor = null;

    root.innerHTML =
      '<div class="evc-head"><div class="evc-titles"><h2 id="evcTitle">Events calendar</h2><div class="evc-range" id="evcRange" aria-live="polite"></div></div>' +
      '<div class="evc-tools">' +
      '<div class="evc-seg" role="group" aria-label="Calendar range">' + VIEWS.map(function (v) { return '<button type="button" data-v="' + v + '">' + v.charAt(0).toUpperCase() + v.slice(1) + "</button>"; }).join("") + "</div>" +
      '<div class="evc-nav"><button type="button" class="evc-arrow" data-n="-1" aria-label="Previous">‹</button><button type="button" class="evc-todaybtn" data-n="0">Today</button><button type="button" class="evc-arrow" data-n="1" aria-label="Next">›</button></div>' +
      "</div></div>" +
      '<div class="evc-filters"><div class="evc-legend" role="group" aria-label="Show events by status">' +
      kinds.map(function (k) { return '<button type="button" class="evc-lg evc-k-' + k + '" data-k="' + k + '" aria-pressed="true" title="' + esc(KLABEL[k] + ": " + KHINT[k] + " (click to show / hide)") + '"><i aria-hidden="true"></i>' + KLABEL[k] + ' <span class="evc-cnt" data-cnt="' + k + '"></span></button>'; }).join("") +
      '<span class="evc-lg-clash" title="A staff, stock, partner or venue clash on this day"><b aria-hidden="true">!</b>Clash</span><span class="evc-lg-sample" hidden><span class="evc-sample">Sample</span>trial sample event</span></div>' +
      '<label class="evc-type"><span class="evc-sr">Event type</span><select id="evcType" aria-label="Event type"><option value="">All event types</option></select></label></div>' +
      '<div class="evc-body" id="evcBody"></div>';
    var $ = function (s) { return root.querySelector(s); };

    /* ---- data in the visible range ---- */
    function range() {
      var a = st.anchor;
      if (st.view === "day") return { from: a, to: a };
      if (st.view === "week") { var m = monday(a); return { from: m, to: add(m, 6) }; }
      var f = first(a), l = lastOf(a);
      return { from: monday(f), to: add(monday(l), 6), first: f, last: l };
    }
    function label(rg) {
      if (st.view === "month") return fmt(rg.first, { month: "long", year: "numeric" });
      if (st.view === "day") return fmt(rg.from, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      return fmt(rg.from, { day: "numeric", month: "short" }) + " – " + fmt(rg.to, { day: "numeric", month: "short", year: "numeric" });
    }
    function visible(it) { return !!st.show[it.kind] && (!st.type || String(it.type || "").toLowerCase() === st.type); }
    function byDay(rows) { var m = {}; rows.forEach(function (r) { (m[r.day] = m[r.day] || []).push(r); }); Object.keys(m).forEach(function (k) { m[k].sort(sortDay); }); return m; }
    function clashDays() { var c = opts.conflicts ? opts.conflicts() : null; return c && typeof c === "object" ? c : {}; }

    /* ---- pieces ---- */
    function aria(r) {
      var it = r.it;
      return [it.title || it.code || "Event", KLABEL[it.kind], it.sample ? "sample" : "", hhmm(it.time), it.venue, guestsTxt(it.guests),
        r.of > 1 ? "day " + r.n + " of " + r.of : "", it.clash ? "has a clash" : ""].filter(Boolean).join(", ");
    }
    function chip(r, cls) {
      var it = r.it, k = "c" + Object.keys(idx).length; idx[k] = r;
      var t = hhmm(it.time);
      return '<a class="evc-chip evc-k-' + esc(it.kind) + (cls ? " " + cls : "") + (r.n > 1 ? " evc-cont" : "") + (r.n < r.of ? " evc-runs" : "") + '" href="' + esc(it.href || "#") + '" data-tip="' + k + '" aria-label="' + esc(aria(r)) + '">' +
        (t && r.n === 1 ? '<span class="evc-ct">' + esc(t) + "</span>" : "") +
        '<span class="evc-cn">' + esc(it.title || it.code || "Event") + "</span>" +
        (it.sample ? '<span class="evc-sample">Sample</span>' : "") + (it.clash ? '<b class="evc-cx" aria-hidden="true" title="Clash">!</b>' : "") + "</a>";
    }
    function card(r) {
      var it = r.it, k = "c" + Object.keys(idx).length; idx[k] = r;
      var meta = [it.venue, guestsTxt(it.guests), it.type].filter(Boolean);
      return '<a class="evc-card evc-k-' + esc(it.kind) + '" href="' + esc(it.href || "#") + '" data-tip="' + k + '" aria-label="' + esc(aria(r)) + '">' +
        '<span class="evc-cbar" aria-hidden="true"></span><span class="evc-cbody">' +
        '<span class="evc-ctop">' + (hhmm(it.time) ? '<span class="evc-ct">' + esc(hhmm(it.time)) + "</span>" : '<span class="evc-ct evc-allday">All day</span>') +
        '<span class="evc-pill evc-k-' + esc(it.kind) + '">' + KLABEL[it.kind] + "</span>" + (it.sample ? '<span class="evc-sample">Sample</span>' : "") + (it.clash ? '<span class="evc-clashpill">Clash</span>' : "") + "</span>" +
        '<span class="evc-cn">' + esc(it.title || it.code || "Event") + (r.of > 1 ? ' <span class="evc-run">day ' + r.n + " of " + r.of + "</span>" : "") + "</span>" +
        (meta.length ? '<span class="evc-meta">' + esc(meta.join(" · ")) + "</span>" : "") +
        (it.code ? '<span class="evc-code">' + esc(it.code) + "</span>" : "") + "</span></a>";
    }
    function clashBadge(day, n) {
      if (!n) return "";
      return '<a class="evc-clash" href="#conflictsH" aria-label="' + esc(n + (n === 1 ? " conflict" : " conflicts") + " on " + fmt(day, { day: "numeric", month: "long" }) + " — see Conflicts") + '"><b aria-hidden="true">!</b>' + n + "</a>";
    }
    function dayLabel(day, list) {
      return fmt(day, { weekday: "long", day: "numeric", month: "long" }) + (day === todayFn() ? " (today)" : "") + ", " + (list.length ? list.length + (list.length === 1 ? " event" : " events") : "no events");
    }

    /* ---- views ---- */
    function monthView(rg, m, today, cx) {
      var max = 3, focus = st.focusDay && st.focusDay >= rg.first && st.focusDay <= rg.last ? st.focusDay : (today >= rg.first && today <= rg.last ? today : rg.first);
      var head = '<div class="evc-dow" aria-hidden="true">' + [0, 1, 2, 3, 4, 5, 6].map(function (i) { return "<span>" + esc(fmt(add("2024-01-01", i), { weekday: "short" })) + "</span>"; }).join("") + "</div>";
      var cells = "", d = rg.from;
      while (d <= rg.to) {
        var list = m[d] || [], out = d < rg.first || d > rg.last;
        cells += '<div class="evc-cell' + (out ? " evc-out" : "") + (d === today ? " evc-today" : "") + (d < today ? " evc-past" : "") + (list.length ? " evc-has" : "") + (cx[d] ? " evc-hasclash" : "") + '">' +
          '<div class="evc-ch"><button type="button" class="evc-num" data-day="' + d + '" tabindex="' + (d === focus ? "0" : "-1") + '"' + (d === today ? ' aria-current="date"' : "") + ' aria-label="' + esc(dayLabel(d, list) + ". Open day") + '">' + toD(d).getUTCDate() + "</button>" + clashBadge(d, cx[d]) + "</div>" +
          list.slice(0, max).map(function (r) { return chip(r, ""); }).join("") +
          (list.length > max ? '<button type="button" class="evc-more" data-day="' + d + '" aria-label="' + esc("Show all " + list.length + " events on " + fmt(d, { day: "numeric", month: "long" })) + '">+' + (list.length - max) + " more</button>" : "") + "</div>";
        d = add(d, 1);
      }
      return '<div class="evc-month">' + head + '<div class="evc-cells">' + cells + "</div></div>";
    }
    function weekView(rg, m, today, cx) {
      var d = rg.from, cols = "";
      while (d <= rg.to) {
        var list = m[d] || [];
        cols += '<section class="evc-wcol' + (d === today ? " evc-today" : "") + (d < today ? " evc-past" : "") + '" aria-label="' + esc(dayLabel(d, list)) + '">' +
          '<div class="evc-wh"><button type="button" class="evc-wday" data-day="' + d + '"' + (d === today ? ' aria-current="date"' : "") + ' aria-label="' + esc("Open " + fmt(d, { weekday: "long", day: "numeric", month: "long" })) + '"><small>' + esc(fmt(d, { weekday: "short" })) + "</small><b>" + toD(d).getUTCDate() + "</b></button>" + clashBadge(d, cx[d]) + "</div>" +
          (list.length ? list.map(card).join("") : '<p class="evc-free">Free</p>') + "</section>";
        d = add(d, 1);
      }
      return '<div class="evc-week">' + cols + "</div>";
    }
    function dayView(rg, m, today, cx) {
      var d = rg.from, list = m[d] || [];
      return '<div class="evc-day">' + (cx[d] ? '<p class="evc-daywarn">' + clashBadge(d, cx[d]) + " " + (cx[d] === 1 ? "There is a clash on this day." : "There are " + cx[d] + " clashes on this day.") + ' <a href="#conflictsH">See conflicts</a></p>' : "") +
        (list.length ? list.map(card).join("") : '<p class="evc-empty">Nothing on this day.' + (d >= today ? " It is free." : "") + "</p>") + "</div>";
    }
    // phones: one list of days (month = days that have events, week = all 7, day = that day)
    function agendaView(rg, m, today, cx) {
      var days = [], d = st.view === "month" ? rg.first : rg.from, end = st.view === "month" ? rg.last : rg.to;
      while (d <= end) { if (st.view !== "month" || (m[d] || []).length || cx[d] || d === today) days.push(d); d = add(d, 1); }
      var html = days.map(function (x) {
        var list = m[x] || [];
        return '<section class="evc-aday' + (x === today ? " evc-today" : "") + (x < today ? " evc-past" : "") + '" aria-label="' + esc(dayLabel(x, list)) + '">' +
          '<h3 class="evc-ah"><button type="button" class="evc-aday-btn" data-day="' + x + '"' + (x === today ? ' aria-current="date"' : "") + '><b>' + toD(x).getUTCDate() + "</b><span>" + esc(fmt(x, { weekday: "long" })) + (x === today ? " · Today" : "") + "</span><small>" + esc(fmt(x, { month: "short" })) + "</small></button>" + clashBadge(x, cx[x]) + "</h3>" +
          (list.length ? list.map(card).join("") : '<p class="evc-free">' + (x === today ? "Nothing today" : "Free") + "</p>") + "</section>";
      }).join("");
      var any = days.some(function (x) { return (m[x] || []).length; });
      return '<div class="evc-agenda">' + html + (any ? "" : '<p class="evc-empty">' + (st.view === "month" ? "No events this month." : "No events in this period.") + "</p>") + "</div>";
    }

    function viewMarkup(rg, m, today, cx) { return narrow() ? agendaView(rg, m, today, cx) : st.view === "month" ? monthView(rg, m, today, cx) : st.view === "week" ? weekView(rg, m, today, cx) : dayView(rg, m, today, cx); }

    /* ---- hover / focus card ---- */
    function hideTip() { if (tip) { tip.hidden = true; tipFor = null; } }
    function showTip(a) {
      var r = idx[a.getAttribute("data-tip")]; if (!r || narrow()) return;
      if (!tip) { tip = document.createElement("div"); tip.className = "evc-tip"; tip.setAttribute("role", "tooltip"); tip.id = "evcTip"; document.body.appendChild(tip); }
      var it = r.it; tipFor = a; tip.replaceChildren();
      var h = document.createElement("div"); h.className = "evc-tip-h evc-k-" + it.kind;
      var b = document.createElement("b"); b.textContent = it.title || it.code || "Event"; h.appendChild(b); tip.appendChild(h);
      var line = function (k, v) { if (!v) return; var p = document.createElement("div"); p.className = "evc-tip-r"; var s = document.createElement("span"); s.textContent = k; var t = document.createElement("span"); t.textContent = v; p.appendChild(s); p.appendChild(t); tip.appendChild(p); };
      line("Status", KLABEL[it.kind] + (it.sample ? " · Sample" : ""));
      line("When", fmt(r.day, { weekday: "short", day: "numeric", month: "short" }) + " · " + (hhmm(it.time) || "All day") + (r.of > 1 ? " · day " + r.n + " of " + r.of : ""));
      line("Venue", it.venue); line("Guests", Math.round(Number(it.guests)) > 0 ? Math.round(Number(it.guests)).toLocaleString(numLoc()) : ""); line("Type", it.type); line("Code", it.code);
      if (it.clash) line("Clash", "Staff, stock, partner or venue clash - see Conflicts");
      tip.hidden = false;
      var br = a.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      var x = Math.min(Math.max(8, br.left), vw - tw - 8), y = br.bottom + 6; if (y + th > vh - 8) y = Math.max(8, br.top - th - 6);
      tip.style.left = Math.round(x) + "px"; tip.style.top = Math.round(y) + "px";
    }

    /* ---- render ---- */
    var notifiedType = "";
    function render() {
      hideTip(); idx = {};
      var rg = range(), today = todayFn(), all = expand(itemsFn() || []);
      // counts per status in the visible range (before the status filter, after the type filter)
      var inRg = all.filter(function (r) { return r.day >= (st.view === "month" ? rg.first : rg.from) && r.day <= (st.view === "month" ? rg.last : rg.to) && r.n === 1; });
      kinds.forEach(function (k) { var c = $('[data-cnt="' + k + '"]'); if (c) c.textContent = String(inRg.filter(function (r) { return r.it.kind === k && (!st.type || String(r.it.type || "").toLowerCase() === st.type); }).length); });
      var sample = $(".evc-lg-sample"); if (sample) sample.hidden = !all.some(function (r) { return r.it.sample; });
      // event types present (any date) for the filter
      var sel = $("#evcType"), types = {}; all.forEach(function (r) { var t = String(r.it.type || "").trim(); if (t) types[t.toLowerCase()] = types[t.toLowerCase()] || t; });
      var keys = Object.keys(types).sort();
      if (sel) { var typeOptions = '<option value="">All event types</option>' + keys.map(function (k) { return '<option value="' + esc(k) + '">' + esc(types[k]) + "</option>"; }).join(""), want = typeOptions;
        if (sel.getAttribute("data-opts") !== want) { sel.innerHTML = typeOptions; sel.setAttribute("data-opts", want); }
        if (st.type && !types[st.type]) st.type = ""; sel.value = st.type; sel.parentNode.hidden = keys.length < 2 && !st.type; }
      var m = byDay(all.filter(function (r) { return visible(r.it); })), cx = clashDays();
      $("#evcRange").textContent = label(rg);
      root.querySelectorAll("[data-v]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-v") === st.view)); });
      root.setAttribute("data-view", st.view);
      var body = $("#evcBody");
      body.innerHTML = viewMarkup(rg, m, today, cx);
      if (!all.length) body.insertAdjacentHTML("beforeend", '<p class="evc-empty evc-none">No dated events yet. Events show here once a quote has an event date.</p>');
      // R20: tell the page when the event-type filter changes (picked, or reset because that type is gone), so the
      // "Upcoming events & commitments" list below follows the same filter
      if (opts.onType && st.type !== notifiedType) { notifiedType = st.type; try { opts.onType(st.type); } catch (e) {} }
    }
    // persist = the person picked Month / Week / Day (remembered); opening one day from the grid is not a preference
    function go(view, anchor, persist) {
      if (view && VIEWS.indexOf(view) >= 0 && view !== st.view) { st.view = view; if (persist && opts.onView) try { opts.onView(view); } catch (e) {} }
      if (anchor) st.anchor = anchor;
      render();
    }
    function openDay(day) { st.focusDay = day; go("day", day); var h = $("#evcRange"); if (h && h.focus) { h.setAttribute("tabindex", "-1"); try { h.focus({ preventScroll: true }); } catch (e) {} } }

    /* ---- events ---- */
    root.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target : null; if (!t) return;
      var v = t.closest("[data-v]"); if (v && root.contains(v)) { var to = v.getAttribute("data-v"); if (to !== st.view) { if (st.view === "month" && to !== "month") { var td = todayFn(); st.anchor = td.slice(0, 7) === st.anchor.slice(0, 7) ? td : (st.focusDay && st.focusDay.slice(0, 7) === st.anchor.slice(0, 7) ? st.focusDay : first(st.anchor)); } go(to, null, true); } return; }
      var n = t.closest("[data-n]"); if (n && root.contains(n)) { var k = +n.getAttribute("data-n");
        st.focusDay = null;
        if (!k) st.anchor = todayFn(); else if (st.view === "month") st.anchor = addMonths(st.anchor, k); else st.anchor = add(st.anchor, (st.view === "week" ? 7 : 1) * k);
        render(); return; }
      var lg = t.closest("[data-k]"); if (lg && root.contains(lg)) { var kk = lg.getAttribute("data-k"); st.show[kk] = !st.show[kk]; lg.setAttribute("aria-pressed", String(!!st.show[kk])); render(); var again = root.querySelector('[data-k="' + kk + '"]'); if (again) again.focus(); return; }
      var dd = t.closest("[data-day]"); if (dd && root.contains(dd)) { openDay(dd.getAttribute("data-day")); return; }
    });
    var typeSel = $("#evcType"); if (typeSel) typeSel.addEventListener("change", function () { st.type = typeSel.value; render(); });
    root.addEventListener("keydown", function (e) {
      var b = e.target && e.target.classList && e.target.classList.contains("evc-num") ? e.target : null; if (!b) return;
      var mv = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key], day = b.getAttribute("data-day");
      if (e.key === "Home") mv = -dow(day); else if (e.key === "End") mv = 6 - dow(day);
      if (mv == null) return;
      e.preventDefault();
      var to = add(day, mv), rg = range();
      st.focusDay = to;
      if (to < rg.first || to > rg.last) { st.anchor = to; render(); }
      root.querySelectorAll(".evc-num").forEach(function (x) { x.setAttribute("tabindex", x.getAttribute("data-day") === to ? "0" : "-1"); });
      var nb = root.querySelector('.evc-num[data-day="' + to + '"]'); if (nb) nb.focus();
    });
    root.addEventListener("mouseover", function (e) { var a = e.target.closest ? e.target.closest("[data-tip]") : null; if (a && a !== tipFor && root.contains(a)) showTip(a); });
    root.addEventListener("mouseout", function (e) { var a = e.target.closest ? e.target.closest("[data-tip]") : null; if (a && (!e.relatedTarget || !a.contains(e.relatedTarget))) hideTip(); });
    root.addEventListener("focusin", function (e) { var a = e.target.closest ? e.target.closest("[data-tip]") : null; if (a) { showTip(a); a.setAttribute("aria-describedby", "evcTip"); } });
    root.addEventListener("focusout", function (e) { var a = e.target.closest ? e.target.closest("[data-tip]") : null; if (a) { hideTip(); a.removeAttribute("aria-describedby"); } });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && tip && !tip.hidden) hideTip(); });
    window.addEventListener("scroll", hideTip, true);
    var lastNarrow = narrow(); window.addEventListener("resize", function () { var n = narrow(); if (n !== lastNarrow) { lastNarrow = n; render(); } });

    render();
    return { refresh: render, go: go, state: st };
  }
  window.HelmEventsCalendar = { mount: mount, _expand: expand, _add: add, _monday: monday, _lastOf: lastOf, _addMonths: addMonths };
})();
