/* crew-schedule.js - crew schedule calendar (0161), Apple Calendar style.
 * Day / Week / Month switch, Today, < > arrows. Month = grid with event chips (dots + agenda on phones).
 * Week / Day = time grid (hours down the side, blocks placed by shift start-end, all-day row for
 * events without a shift time, red current-time line). Week becomes a 3-day view on phones.
 * Click an event -> popover (event, time, venue, status, role, work status, link).
 * Crew: "My schedule" (own rows only - enforced by the RPC). Staff / calendar viewers (not crew):
 * "Team schedule" - pick one crew member (their month / week / day + task status + shift times),
 * or "All crew" (week = people x days grid; month / day = events with their crew).
 * Data: BPStore.ops.crew.schedule(from, to, staffId) -> crew_schedule RPC (schedule fields only,
 * never money or client contact). Event status (confirmed / tentative) and lead dates come from the
 * page via opts.statusFor / opts.extra. All markup goes through esc(). */
(function () {
  "use strict";
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var iso = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  var parse = function (s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  var addDays = function (d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
  var monday = function (d) { var w = (d.getDay() + 6) % 7; return addDays(d, -w); };
  var hm = function (ts) { var d = new Date(ts); return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false }); };
  var DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var HOUR = 48;                                                      // px per hour in the time grid
  var VIEWS = ["day", "week", "month"];

  // the day a row belongs to: its shift start (local time), else the event date
  function dayOf(r) { if (r.planned_start) { var d = new Date(r.planned_start); if (!isNaN(d.getTime())) return iso(d); } return r.event_date ? String(r.event_date).slice(0, 10) : null; }
  // "18:00-23:00", "18:00" (no end), or the event's own time, or "" (all day)
  function timeOf(r) {
    if (r.planned_start) { var s = hm(r.planned_start), e = r.planned_end ? hm(r.planned_end) : ""; return e && e !== s ? s + "–" + e : s; }
    return r.event_time ? String(r.event_time) : "";
  }
  // assigned task status -> plain words
  function workOf(s) {
    s = String(s || "").toLowerCase();
    if (s === "done" || s === "completed" || s === "complete") return { k: "done", l: "Done" };
    if (s === "in_progress" || s === "doing" || s === "started") return { k: "prog", l: "In progress" };
    if (s === "blocked") return { k: "blocked", l: "Blocked" };
    return { k: "todo", l: "Not started" };
  }
  // block key: per person + event + day (or per event + day when byEvent, crew listed inside;
  // perShift: one block per shift so a person's time grid shows each shift at its own time)
  function group(rows, byEvent, perShift) {
    var by = {}, out = [];
    (rows || []).forEach(function (r) {
      var day = dayOf(r); if (!day) return;
      var k = (byEvent ? "" : r.crew_id + "|") + r.quote_id + "|" + day + (perShift && r.planned_start ? "|" + (r.task_id || r.task_title || "") + "|" + r.planned_start : "");
      if (!by[k]) { by[k] = { key: k, day: day, crew_id: r.crew_id, crew_name: r.crew_name || "", crew_role: r.crew_role || "", quote_id: r.quote_id,
        code: r.event_code || "", title: r.event_title || "", venue: r.venue_name || "", event_time: r.event_time || "", shifts: [], crew: [], start: null, end: null }; out.push(by[k]); }
      var b = by[k]; b.shifts.push({ title: r.task_title || "", category: r.category || "", status: r.status || "", time: timeOf(r), crew: r.crew_name || "" });
      if (r.crew_name && b.crew.indexOf(r.crew_name) < 0) b.crew.push(r.crew_name);
      var st = r.planned_start ? new Date(r.planned_start).getTime() : null, en = r.planned_end ? new Date(r.planned_end).getTime() : null;
      if (st != null && isFinite(st)) { if (b.start == null || st < b.start) b.start = st; var e2 = en != null && isFinite(en) && en > st ? en : st + 36e5; if (b.end == null || e2 > b.end) b.end = e2; }
    });
    out.forEach(function (b) {
      var t = b.shifts.map(function (s) { return s.time; }).filter(Boolean);
      b.time = b.start != null ? hm(b.start) + (b.end ? "–" + hm(b.end) : "") : t.length ? t[0] : "";
    });
    out.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : ((a.start == null ? Infinity : a.start) - (b.start == null ? Infinity : b.start) || 0) || a.crew_name.localeCompare(b.crew_name); });
    return out;
  }
  // overlap layout for one day's timed blocks: each gets col + cols
  function lanes(list) {
    var ord = list.slice().sort(function (a, b) { return a.start - b.start || b.end - a.end; }), cl = [], ends = [], gEnd = -Infinity;
    function flush() { cl.forEach(function (b) { b._cols = ends.length; }); cl = []; ends = []; }
    ord.forEach(function (b) {
      if (b.start >= gEnd) { flush(); gEnd = -Infinity; }
      var c = 0; while (c < ends.length && ends[c] > b.start) c++;
      ends[c] = b.end; b._col = c; cl.push(b); if (b.end > gEnd) gEnd = b.end;
    });
    flush(); return ord;
  }

  function mount(root, opts) {
    opts = opts || {};
    var team = !!opts.team, people = (opts.people || []).slice();
    var linkFor = opts.linkFor || function (b) { return "runsheet.html?id=" + encodeURIComponent(b.quote_id); };
    var statusFor = opts.statusFor || function () { return ""; };
    var extra = opts.extra || function () { return []; };
    var st = { view: VIEWS.indexOf(opts.view) >= 0 ? opts.view : "week", staff: opts.staff || "", anchor: new Date(), rows: [] };
    var seq = 0, pop = null, lastFocus = null;
    var narrow = function () { try { return !!(window.matchMedia && window.matchMedia("(max-width: 600px)").matches); } catch (e) { return false; } };
    var allCrew = function () { return team && !st.staff; };

    root.hidden = false;
    root.innerHTML =
      '<div class="cs-head"><div class="cs-titles"><h2 id="schedTitle">' + (team ? "Team schedule" : "My schedule") + '</h2><div class="cs-range" id="csRange" aria-live="polite"></div></div>' +
      '<div class="cs-tools">' +
      (team ? '<label class="cs-pick"><span class="cs-sr">Crew member</span><select id="csStaff" aria-label="Crew member"><option value="">All crew</option></select></label>' : "") +
      '<div class="cs-seg" role="group" aria-label="View"><button type="button" data-v="day">Day</button><button type="button" data-v="week">Week</button><button type="button" data-v="month">Month</button></div>' +
      '<div class="cs-nav"><button type="button" class="cs-arrow" data-n="-1" aria-label="Previous">‹</button><button type="button" class="cs-todaybtn" data-n="0">Today</button><button type="button" class="cs-arrow" data-n="1" aria-label="Next">›</button></div>' +
      '</div></div><div class="cs-legend" aria-hidden="true"><span class="cs-lg cs-s-confirmed">Confirmed</span><span class="cs-lg cs-s-tentative">Tentative</span>' + (team ? '<span class="cs-lg cs-s-lead">Lead</span>' : "") + '</div>' +
      '<div class="cs-body" id="csBody"></div>';
    var $ = function (s) { return root.querySelector(s); };

    function fillPeople() {
      var sel = $("#csStaff"); if (!sel) return;
      var seen = {}; people = people.filter(function (p) { if (!p || !p.id || seen[p.id]) return false; seen[p.id] = 1; return true; })
        .sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || "")); });
      sel.innerHTML = '<option value="">All crew</option>' + people.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name || "Unnamed") + "</option>"; }).join("");
      sel.value = st.staff && seen[st.staff] ? st.staff : "";
      if (st.staff && !seen[st.staff]) { sel.insertAdjacentHTML("beforeend", '<option value="' + esc(st.staff) + '">Selected person</option>'); sel.value = st.staff; }
    }
    function span() { return st.view === "day" ? 1 : st.view === "week" ? (narrow() && !allCrew() ? 3 : 7) : 0; }
    function range() {
      var a = st.anchor, n = span();
      if (st.view === "day") { var d = addDays(a, 0); return { from: d, to: d }; }
      if (st.view === "week") { var s = n === 3 ? addDays(a, 0) : monday(a); return { from: s, to: addDays(s, n - 1) }; }
      var first = new Date(a.getFullYear(), a.getMonth(), 1), last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
      return { from: monday(first), to: addDays(monday(last), 6), first: first, last: last };
    }
    function label(rg) {
      if (st.view === "month") return rg.first.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      if (st.view === "day") return rg.from.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      var o = { day: "numeric", month: "short" }; return rg.from.toLocaleDateString("en-IN", o) + " – " + rg.to.toLocaleDateString("en-IN", Object.assign({ year: "numeric" }, o));
    }
    function days(rg) { var a = [], d = rg.from; while (d <= rg.to) { a.push(d); d = addDays(d, 1); } return a; }
    function sKind(b) { if (b.lead) return "lead"; return String(statusFor(b.quote_id) || "").toLowerCase() === "confirmed" ? "confirmed" : "tentative"; }
    function sLabel(k) { return k === "confirmed" ? "Confirmed" : k === "lead" ? "Lead" : "Tentative"; }
    function blocks() {
      var out = group(st.rows, allCrew(), !allCrew() && st.view !== "month");
      if (allCrew()) (extra() || []).forEach(function (l, i) { if (l && l.day) out.push({ key: "lead|" + i, day: l.day, lead: true, title: l.title || "Lead", code: "", venue: l.venue || "", shifts: [], crew: [], start: null, end: null, time: "", href: l.href || "leads.html" }); });
      return out;
    }
    var idx = {};
    function chip(b, cls) {
      idx[b.key] = b; var k = sKind(b);
      return '<button type="button" class="cs-ev cs-s-' + k + (cls ? " " + cls : "") + '" data-ev="' + esc(b.key) + '" aria-haspopup="dialog" aria-label="' + esc((b.title || b.code || "Event") + ", " + (b.time || "all day") + ", " + sLabel(k)) + '">' +
        (b.time && cls !== "cs-allday" ? '<span class="cs-time">' + esc(cls === "cs-mchip" && b.start != null ? hm(b.start) : b.time) + "</span>" : "") +
        '<span class="cs-ttl">' + esc(b.title || b.code || "Event") + "</span>" +
        (cls === "cs-blk" && b.venue ? '<span class="cs-venue">' + esc(b.venue) + "</span>" : "") + "</button>";
    }

    /* ---- popover ---- */
    function closePop() { if (pop) { pop.remove(); pop = null; if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {} } }
    function openPop(btn) {
      var b = idx[btn.getAttribute("data-ev")]; if (!b) return; closePop(); lastFocus = btn;
      var k = sKind(b), d = parse(b.day);
      var rows = [["When", (d ? d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }) : "") + " · " + (b.time || (b.event_time ? b.event_time : "All day"))]];
      if (b.venue) rows.push(["Venue", b.venue]);
      rows.push(["Status", sLabel(k)]);
      if (!allCrew() && b.crew_role) rows.push(["Role", b.crew_role]);
      if (allCrew() && b.crew.length) rows.push(["Crew", b.crew.join(", ")]);
      var sh = b.shifts.map(function (s) { var w = workOf(s.status);
        return '<li><span class="cs-wk cs-w-' + w.k + '">' + esc(w.l) + "</span> " + esc(s.title || s.category || "Shift") + (s.time ? ' <span class="cs-t">' + esc(s.time) + "</span>" : "") + (allCrew() && s.crew ? ' <span class="cs-t">· ' + esc(s.crew) + "</span>" : "") + "</li>"; }).join("");
      pop = document.createElement("div"); pop.className = "cs-pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", b.title || "Event");
      pop.innerHTML = '<div class="cs-pop-h cs-s-' + esc(k) + '"><b>' + esc(b.title || b.code || "Event") + "</b>" + (b.code ? '<span class="cs-code">' + esc(b.code) + "</span>" : "") +
        '<button type="button" class="cs-x" aria-label="Close">×</button></div><dl>' + rows.map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("") + "</dl>" +
        (sh ? '<div class="cs-pop-s">' + (allCrew() ? "Shifts" : "Work") + "</div><ul>" + sh + "</ul>" : "") +
        '<a class="cs-open" href="' + esc(b.lead ? b.href : linkFor(b)) + '">' + (b.lead ? "Open leads" : "Open event") + " ›</a>";
      root.appendChild(pop);
      if (!narrow()) {
        var rr = root.getBoundingClientRect(), br = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
        var x = br.right - rr.left + 8; if (x + pw > rr.width) x = br.left - rr.left - pw - 8; if (x < 8) x = Math.max(8, Math.min(rr.width - pw - 8, br.left - rr.left));
        var y = br.top - rr.top; if (br.top + ph > window.innerHeight - 8) y = Math.max(8, y - (br.top + ph - window.innerHeight + 16));
        pop.style.left = x + "px"; pop.style.top = Math.max(0, y) + "px";
      } else pop.classList.add("cs-sheet");
      pop.querySelector(".cs-x").addEventListener("click", closePop);
      pop.querySelector(".cs-x").focus();
    }
    root.addEventListener("click", function (e) {
      var t = e.target.closest ? e.target.closest("[data-ev]") : null;
      if (t && root.contains(t)) { e.stopPropagation(); openPop(t); return; }
      var dc = e.target.closest ? e.target.closest("[data-day]") : null;
      if (dc && st.view === "month" && !narrow()) { st.anchor = parse(dc.getAttribute("data-day")); st.view = "day"; load(); return; }
      if (dc && st.view === "month" && narrow()) { st.sel = dc.getAttribute("data-day"); render(); return; }
      if (pop && !pop.contains(e.target)) closePop();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && pop) closePop(); });
    document.addEventListener("click", function (e) { if (pop && !root.contains(e.target)) closePop(); });

    /* ---- views ---- */
    function teamGrid(rg, all, today) {
      var ds = days(rg), ppl = people.slice(), have = {}, byDay = {};
      var list = group(st.rows, false); list.forEach(function (b) { idx[b.key] = b; (byDay[b.day] = byDay[b.day] || []).push(b); });
      ppl.forEach(function (p) { have[p.id] = 1; });
      list.forEach(function (b) { if (!have[b.crew_id]) { have[b.crew_id] = 1; ppl.push({ id: b.crew_id, name: b.crew_name }); } });
      if (!ppl.length) return '<p class="cs-empty">No crew yet. Add people on the Staff page and assign them to event tasks.</p>';
      var busy = {}, inWk = {}; ds.forEach(function (d) { inWk[iso(d)] = 1; }); list.forEach(function (b) { if (inWk[b.day]) busy[b.crew_id] = 1; });
      ppl.sort(function (a, b) { return (busy[b.id] ? 1 : 0) - (busy[a.id] ? 1 : 0) || String(a.name || "").localeCompare(String(b.name || "")); });
      return '<div class="cs-gridwrap"><table class="cs-grid"><thead><tr><th scope="col" class="cs-who">Crew</th>' +
        ds.map(function (d) { return '<th scope="col" class="' + (iso(d) === today ? "cs-today" : "") + '">' + DOW[(d.getDay() + 6) % 7] + " <b>" + d.getDate() + "</b></th>"; }).join("") +
        "</tr></thead><tbody>" + ppl.map(function (p) {
          return '<tr><th scope="row" class="cs-who"><a href="calendar.html?staff=' + encodeURIComponent(p.id) + '#schedule" data-pick="' + esc(p.id) + '">' + esc(p.name || "Unnamed") + "</a></th>" +
            ds.map(function (d) { var k = iso(d), here = (byDay[k] || []).filter(function (b) { return b.crew_id === p.id; });
              return '<td class="' + (k === today ? "cs-today" : "") + '">' + here.map(function (b) { return chip(b, ""); }).join("") + "</td>"; }).join("") + "</tr>";
        }).join("") + "</tbody></table></div>";
    }
    function timeGrid(rg, all, today) {
      var ds = days(rg), byDay = {}, minH = 24;
      all.forEach(function (b) { (byDay[b.day] = byDay[b.day] || []).push(b); if (b.start != null) { var h = new Date(b.start).getHours(); if (h < minH) minH = h; } });
      var cols = "grid-template-columns:52px repeat(" + ds.length + ",minmax(0,1fr))";
      var head = '<div class="cs-tg-head" data-st="' + cols + '"><span></span>' + ds.map(function (d) { var k = iso(d);
        return '<span class="cs-tg-dh' + (k === today ? " cs-today" : "") + '">' + DOW[(d.getDay() + 6) % 7] + ' <b>' + d.getDate() + "</b></span>"; }).join("") + "</div>";
      var allday = '<div class="cs-tg-all" data-st="' + cols + '"><span class="cs-tg-lbl">all-day</span>' + ds.map(function (d) {
        var l = (byDay[iso(d)] || []).filter(function (b) { return b.start == null; });
        return "<div>" + l.map(function (b) { return chip(b, "cs-allday"); }).join("") + "</div>"; }).join("") + "</div>";
      var hours = ""; for (var h = 0; h < 24; h++) hours += '<span class="cs-hr" data-st="top:' + h * HOUR + 'px">' + (h ? pad(h) + ":00" : "") + "</span>";
      var now = new Date(), nowTop = (now.getHours() + now.getMinutes() / 60) * HOUR;
      var colsHtml = ds.map(function (d) {
        var k = iso(d), d0 = d.getTime(), d1 = addDays(d, 1).getTime();
        var timed = lanes((byDay[k] || []).filter(function (b) { return b.start != null; }));
        return '<div class="cs-tg-col' + (k === today ? " cs-today" : "") + '">' + timed.map(function (b) {
          var s = Math.max(b.start, d0), e = Math.min(Math.max(b.end, s + 18e5), d1);
          var top = (s - d0) / 36e5 * HOUR, ht = Math.max(22, (e - s) / 36e5 * HOUR - 2), w = 100 / (b._cols || 1);
          return '<div class="cs-tg-pos" data-st="top:' + top.toFixed(1) + "px;height:" + ht.toFixed(1) + "px;left:" + (b._col * w).toFixed(2) + "%;width:" + w.toFixed(2) + '%">' + chip(b, "cs-blk") + "</div>";
        }).join("") + (k === today ? '<div class="cs-now" data-st="top:' + nowTop.toFixed(1) + 'px" aria-hidden="true"></div>' : "") + "</div>";
      }).join("");
      var scrollTo = Math.max(0, (minH < 24 ? Math.min(minH, 8) : 8) - 1) * HOUR;
      return '<div class="cs-tg cs-tg-' + ds.length + '">' + head + allday + '<div class="cs-tg-scroll" data-scroll="' + scrollTo + '"><div class="cs-tg-body" data-st="' + cols + ";height:" + 24 * HOUR + 'px"><div class="cs-tg-hours">' + hours + "</div>" + colsHtml + "</div></div></div>" +
        (all.length ? "" : '<p class="cs-empty">' + (team && !st.staff ? "Nothing scheduled." : "No shifts in this period. New assignments will show here.") + "</p>");
    }
    function monthGrid(rg, all, today) {
      var mo = rg.first.getMonth(), byDay = {}, nar = narrow();
      all.forEach(function (b) { (byDay[b.day] = byDay[b.day] || []).push(b); });
      var max = nar ? 0 : 3;
      var html = '<div class="cs-month"><div class="cs-dow">' + DOW.map(function (x) { return "<span>" + x + "</span>"; }).join("") + '</div><div class="cs-cells">' +
        days(rg).map(function (d) {
          var k = iso(d), list = byDay[k] || [];
          var dots = nar ? '<span class="cs-dots">' + list.slice(0, 3).map(function (b) { return '<i class="cs-s-' + sKind(b) + '"></i>'; }).join("") + "</span>" : "";
          return '<div class="cs-cell' + (d.getMonth() !== mo ? " cs-out" : "") + (k === today ? " cs-today" : "") + (list.length ? " cs-has" : "") + (st.sel === k ? " cs-sel" : "") + '" data-day="' + k + '" role="button" tabindex="0" aria-label="' + esc(d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" }) + (list.length ? ", " + list.length + " events" : "")) + '"><span class="cs-num">' + d.getDate() + "</span>" + dots +
            list.slice(0, max).map(function (b) { return chip(b, "cs-mchip"); }).join("") + (!nar && list.length > max ? '<span class="cs-more">+' + (list.length - max) + " more</span>" : "") + "</div>";
        }).join("") + "</div></div>";
      var inMo = all.filter(function (b) { var d = parse(b.day); return d && d.getMonth() === mo && (!nar || !st.sel || b.day === st.sel); });
      if (nar) html += '<div class="cs-agenda"><h3>' + (st.sel ? esc(parse(st.sel).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })) : "This month") + "</h3>" +
        (inMo.length ? inMo.map(function (b) { var d = parse(b.day); return '<div class="cs-arow"><span class="cs-adate">' + esc(d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" })) + "</span>" + chip(b, "cs-achip") + "</div>"; }).join("") : '<p class="cs-empty">Nothing scheduled.</p>') + "</div>";
      else if (!all.length) html += '<p class="cs-empty">No shifts this month.</p>';
      return html;
    }
    function render() {
      closePop(); idx = {};
      var rg = range(), today = iso(new Date()), body = $("#csBody"), all = blocks();
      $("#csRange").textContent = label(rg);
      root.querySelectorAll("[data-v]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === st.view)); });
      root.setAttribute("data-view", st.view);
      if (allCrew() && st.view === "week") body.innerHTML = teamGrid(rg, all, today);
      else if (st.view === "month") body.innerHTML = monthGrid(rg, all, today);
      else body.innerHTML = timeGrid(rg, all, today);
      // CSP-safe: positions travel as data-st and are applied through CSSOM (no inline style attributes)
      body.querySelectorAll("[data-st]").forEach(function (n) { n.style.cssText += ";" + n.getAttribute("data-st"); n.removeAttribute("data-st"); });
      var sc = body.querySelector("[data-scroll]"); if (sc) sc.scrollTop = +sc.getAttribute("data-scroll");
      body.querySelectorAll("[data-pick]").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); st.staff = a.dataset.pick; var s = $("#csStaff"); if (s) s.value = st.staff; load(); }); });
      body.querySelectorAll(".cs-cell[data-day]").forEach(function (c) { c.addEventListener("keydown", function (e) { if ((e.key === "Enter" || e.key === " ") && e.target === c) { e.preventDefault(); c.click(); } }); });
    }
    function load() {
      var rg = range(), my = ++seq;
      $("#csBody").innerHTML = '<p class="cs-empty"><span class="bpui-loading"><i class="bpui-spin2" aria-hidden="true"></i>Loading…</span></p>';
      $("#csRange").textContent = label(rg);
      // pad a day each side: a late shift can fall on the neighbouring UTC date
      return BPStore.ops.crew.schedule(iso(addDays(rg.from, -1)), iso(addDays(rg.to, 1)), st.staff || null).then(function (rows) {
        if (my !== seq) return; st.rows = rows || []; st.loaded = true; render();
      }).catch(function (e) {
        if (my !== seq) return;
        if (window.BPUI && BPUI.loadError) BPUI.loadError($("#csBody"), e, load, { what: "the schedule" });
        else $("#csBody").innerHTML = '<p class="cs-empty">Could not load the schedule.</p>';
      });
    }
    root.querySelectorAll("[data-v]").forEach(function (b) { b.addEventListener("click", function () { st.view = b.dataset.v; st.sel = null; load(); }); });
    root.querySelectorAll("[data-n]").forEach(function (b) { b.addEventListener("click", function () {
      var n = +b.dataset.n; st.sel = null;
      if (!n) st.anchor = new Date();
      else if (st.view === "month") st.anchor = new Date(st.anchor.getFullYear(), st.anchor.getMonth() + n, 1);
      else st.anchor = addDays(st.anchor, span() * n);
      load(); }); });
    var sel = $("#csStaff"); if (sel) sel.addEventListener("change", function () { st.staff = sel.value; load(); });
    fillPeople();
    return { reload: load, refresh: function () { if (st.loaded) render(); }, setPeople: function (p) { people = (p || []).slice(); fillPeople(); render(); }, state: st, ready: load() };
  }
  window.HelmCrewSchedule = { mount: mount, _group: group, _timeOf: timeOf, _dayOf: dayOf, _workOf: workOf, _lanes: lanes };
})();
