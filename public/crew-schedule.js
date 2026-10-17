/* crew-schedule.js - crew schedule calendar (0161).
 * Crew: "My schedule" in Week / Month views (their own events + shifts).
 * Staff / calendar viewers (not crew): "Team schedule" - pick one crew member, or "All crew" as a
 * week grid (rows = people, columns = days) with event blocks.
 * Data: BPStore.ops.crew.schedule(from, to, staffId) -> crew_schedule RPC (schedule fields only,
 * never money or client contact). Renders with textContent-safe esc() only. */
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

  // the day a row belongs to: its shift start (local time), else the event date
  function dayOf(r) { if (r.planned_start) { var d = new Date(r.planned_start); if (!isNaN(d.getTime())) return iso(d); } return r.event_date ? String(r.event_date).slice(0, 10) : null; }
  // "18:00-23:00", "18:00" (no end), or the event's own time, or "" (all day)
  function timeOf(r) {
    if (r.planned_start) { var s = hm(r.planned_start), e = r.planned_end ? hm(r.planned_end) : ""; return e && e !== s ? s + "–" + e : s; }
    return r.event_time ? String(r.event_time) : "";
  }
  // one block per person + event + day; its shifts listed inside
  function group(rows) {
    var by = {}, out = [];
    (rows || []).forEach(function (r) {
      var day = dayOf(r); if (!day) return;
      var k = r.crew_id + "|" + r.quote_id + "|" + day;
      if (!by[k]) { by[k] = { key: k, day: day, crew_id: r.crew_id, crew_name: r.crew_name || "", crew_role: r.crew_role || "", quote_id: r.quote_id,
        code: r.event_code || "", title: r.event_title || "", venue: r.venue_name || "", shifts: [], start: null }; out.push(by[k]); }
      var b = by[k]; b.shifts.push({ title: r.task_title || "", category: r.category || "", status: r.status || "", time: timeOf(r) });
      var st = r.planned_start ? new Date(r.planned_start).getTime() : null;
      if (st != null && (b.start == null || st < b.start)) b.start = st;
    });
    out.forEach(function (b) {
      var t = b.shifts.map(function (s) { return s.time; }).filter(Boolean);
      b.time = t.length ? t[0] + (t.length > 1 ? " +" + (t.length - 1) : "") : "";
    });
    out.sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : ((a.start == null ? Infinity : a.start) - (b.start == null ? Infinity : b.start) || 0) || a.crew_name.localeCompare(b.crew_name); });
    return out;
  }

  function mount(root, opts) {
    opts = opts || {};
    var team = !!opts.team, people = (opts.people || []).slice();
    var linkFor = opts.linkFor || function (b) { return "runsheet.html?id=" + encodeURIComponent(b.quote_id); };
    var st = { view: opts.view === "month" ? "month" : "week", staff: opts.staff || "", anchor: new Date(), rows: [] };
    var seq = 0;

    root.hidden = false;
    root.innerHTML =
      '<div class="cs-head"><h2 id="schedTitle">' + (team ? "Team schedule" : "My schedule") + '</h2>' +
      '<div class="cs-tools">' +
      (team ? '<label class="cs-pick"><span class="cs-sr">Crew member</span><select id="csStaff" aria-label="Crew member"><option value="">All crew</option></select></label>' : "") +
      '<div class="cs-seg" role="group" aria-label="View"><button type="button" data-v="week">Week</button><button type="button" data-v="month">Month</button></div>' +
      '<div class="cs-nav"><button type="button" data-n="-1" aria-label="Previous">‹</button><button type="button" data-n="0">Today</button><button type="button" data-n="1" aria-label="Next">›</button></div>' +
      '</div></div><div class="cs-range" id="csRange" aria-live="polite"></div><div class="cs-body" id="csBody"></div>';
    var $ = function (s) { return root.querySelector(s); };

    function fillPeople() {
      var sel = $("#csStaff"); if (!sel) return;
      var seen = {}; people = people.filter(function (p) { if (!p || !p.id || seen[p.id]) return false; seen[p.id] = 1; return true; })
        .sort(function (a, b) { return String(a.name || "").localeCompare(String(b.name || "")); });
      sel.innerHTML = '<option value="">All crew</option>' + people.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name || "Unnamed") + "</option>"; }).join("");
      sel.value = st.staff && seen[st.staff] ? st.staff : "";
      if (st.staff && !seen[st.staff]) { sel.insertAdjacentHTML("beforeend", '<option value="' + esc(st.staff) + '">Selected person</option>'); sel.value = st.staff; }
    }
    function range() {
      if (st.view === "week") { var s = monday(st.anchor); return { from: s, to: addDays(s, 6) }; }
      var first = new Date(st.anchor.getFullYear(), st.anchor.getMonth(), 1), last = new Date(st.anchor.getFullYear(), st.anchor.getMonth() + 1, 0);
      return { from: monday(first), to: addDays(monday(last), 6), first: first, last: last };
    }
    function label(rg) {
      if (st.view === "month") return rg.first.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      var o = { day: "numeric", month: "short" }; return rg.from.toLocaleDateString("en-IN", o) + " – " + rg.to.toLocaleDateString("en-IN", Object.assign({ year: "numeric" }, o));
    }
    function block(b, compact) {
      var shifts = b.shifts.map(function (s) { return (s.time ? '<span class="cs-t">' + esc(s.time) + "</span> " : "") + esc(s.title || s.category || "Shift"); }).join("<br>");
      return '<a class="cs-ev" href="' + esc(linkFor(b)) + '" title="' + esc((b.code ? b.code + " " : "") + b.title) + '">' +
        '<span class="cs-time">' + esc(b.time || "All day") + "</span>" +
        '<span class="cs-ttl">' + esc(b.title || b.code || "Event") + "</span>" +
        (compact ? "" : (b.venue ? '<span class="cs-venue">📍 ' + esc(b.venue) + "</span>" : "") +
          ((team && !st.staff) ? "" : (b.crew_role ? '<span class="cs-role">' + esc(b.crew_role) + "</span>" : "")) +
          '<span class="cs-shift">' + shifts + "</span>") + "</a>";
    }
    function days(rg) { var a = [], d = rg.from; while (d <= rg.to) { a.push(d); d = addDays(d, 1); } return a; }
    function render() {
      var rg = range(), today = iso(new Date()), blocks = group(st.rows), body = $("#csBody");
      $("#csRange").textContent = label(rg);
      root.querySelectorAll("[data-v]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === st.view)); });
      var byDay = {}; blocks.forEach(function (b) { (byDay[b.day] = byDay[b.day] || []).push(b); });
      if (team && !st.staff && st.view === "week") {
        // team grid: rows = people, columns = days
        var ds = days(rg), ppl = people.slice(), have = {};
        ppl.forEach(function (p) { have[p.id] = 1; });
        blocks.forEach(function (b) { if (!have[b.crew_id]) { have[b.crew_id] = 1; ppl.push({ id: b.crew_id, name: b.crew_name }); } });
        if (!ppl.length) { body.innerHTML = '<p class="cs-empty">No crew yet. Add people on the Staff page and assign them to event tasks.</p>'; return; }
        var busy = {}, inWk = {}; ds.forEach(function (d) { inWk[iso(d)] = 1; }); blocks.forEach(function (b) { if (inWk[b.day]) busy[b.crew_id] = 1; });
        ppl.sort(function (a, b) { return (busy[b.id] ? 1 : 0) - (busy[a.id] ? 1 : 0) || String(a.name || "").localeCompare(String(b.name || "")); });
        body.innerHTML = '<div class="cs-gridwrap"><table class="cs-grid"><thead><tr><th scope="col" class="cs-who">Crew</th>' +
          ds.map(function (d, i) { return '<th scope="col" class="' + (iso(d) === today ? "cs-today" : "") + '">' + DOW[i] + " <b>" + d.getDate() + "</b></th>"; }).join("") +
          "</tr></thead><tbody>" + ppl.map(function (p) {
            return '<tr><th scope="row" class="cs-who"><a href="calendar.html?staff=' + encodeURIComponent(p.id) + '#schedule" data-pick="' + esc(p.id) + '">' + esc(p.name || "Unnamed") + "</a></th>" +
              ds.map(function (d) { var k = iso(d), here = (byDay[k] || []).filter(function (b) { return b.crew_id === p.id; });
                return '<td class="' + (k === today ? "cs-today" : "") + '">' + here.map(function (b) { return block(b, true); }).join("") + "</td>"; }).join("") + "</tr>";
          }).join("") + "</tbody></table></div>";
        body.querySelectorAll("[data-pick]").forEach(function (a) { a.addEventListener("click", function (e) { e.preventDefault(); st.staff = a.dataset.pick; var s = $("#csStaff"); if (s) s.value = st.staff; load(); }); });
        return;
      }
      if (st.view === "week") {
        body.innerHTML = '<div class="cs-week">' + days(rg).map(function (d, i) {
          var k = iso(d), list = byDay[k] || [];
          return '<section class="cs-day' + (k === today ? " cs-today" : "") + (list.length ? "" : " cs-free") + '"><h3>' + DOW[i] + " <b>" + d.getDate() + "</b></h3>" +
            (list.length ? list.map(function (b) { return block(b, false); }).join("") : '<p class="cs-none">Free</p>') + "</section>";
        }).join("") + "</div>" + (blocks.length ? "" : '<p class="cs-empty">' + (team ? "No shifts this week." : "No shifts this week. New assignments will show here.") + "</p>");
        return;
      }
      var mo = rg.first.getMonth();
      body.innerHTML = '<div class="cs-month"><div class="cs-dow">' + DOW.map(function (x) { return "<span>" + x + "</span>"; }).join("") + "</div><div class=\"cs-cells\">" +
        days(rg).map(function (d) {
          var k = iso(d), list = byDay[k] || [];
          return '<div class="cs-cell' + (d.getMonth() !== mo ? " cs-out" : "") + (k === today ? " cs-today" : "") + (list.length ? " cs-has" : "") + '"><span class="cs-num">' + d.getDate() + "</span>" +
            list.slice(0, 3).map(function (b) { return block(b, true); }).join("") + (list.length > 3 ? '<span class="cs-more">+' + (list.length - 3) + " more</span>" : "") + "</div>";
        }).join("") + "</div></div>" +
        (blocks.length ? '<div class="cs-agenda"><h3>This month</h3>' + blocks.filter(function (b) { var d = parse(b.day); return d && d.getMonth() === mo; }).map(function (b) {
          var d = parse(b.day); return '<div class="cs-arow"><span class="cs-adate">' + esc(d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })) + "</span>" + block(b, false) + "</div>"; }).join("") + "</div>"
          : '<p class="cs-empty">No shifts this month.</p>');
    }
    function load() {
      var rg = range(), my = ++seq;
      $("#csBody").innerHTML = '<p class="cs-empty"><span class="bpui-loading"><i class="bpui-spin2" aria-hidden="true"></i>Loading…</span></p>';
      $("#csRange").textContent = label(rg);
      // pad a day each side: a late shift can fall on the neighbouring UTC date
      return BPStore.ops.crew.schedule(iso(addDays(rg.from, -1)), iso(addDays(rg.to, 1)), st.staff || null).then(function (rows) {
        if (my !== seq) return; st.rows = rows || []; render();
      }).catch(function (e) {
        if (my !== seq) return;
        if (window.BPUI && BPUI.loadError) BPUI.loadError($("#csBody"), e, load, { what: "the schedule" });
        else $("#csBody").innerHTML = '<p class="cs-empty">Could not load the schedule.</p>';
      });
    }
    root.querySelectorAll("[data-v]").forEach(function (b) { b.addEventListener("click", function () { st.view = b.dataset.v; load(); }); });
    root.querySelectorAll("[data-n]").forEach(function (b) { b.addEventListener("click", function () {
      var n = +b.dataset.n; if (!n) st.anchor = new Date();
      else if (st.view === "week") st.anchor = addDays(st.anchor, 7 * n);
      else st.anchor = new Date(st.anchor.getFullYear(), st.anchor.getMonth() + n, 1);
      load(); }); });
    var sel = $("#csStaff"); if (sel) sel.addEventListener("change", function () { st.staff = sel.value; load(); });
    fillPeople();
    return { reload: load, setPeople: function (p) { people = (p || []).slice(); fillPeople(); render(); }, state: st, ready: load() };
  }
  window.HelmCrewSchedule = { mount: mount, _group: group, _timeOf: timeOf, _dayOf: dayOf };
})();
