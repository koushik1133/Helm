/* hq.js — Helm HQ, the private platform-owner dashboard (migration 0029).
   Not linked from anywhere. Signed out → sign-in page. Signed in but not a
   platform operator → an ordinary "page not found" (the route never confirms it
   exists). The real control is in the database: every hq_* RPC is SECURITY
   DEFINER and refuses (42501) anyone not in public.platform_admins.
   External file — no inline script, so the hash-based CSP needs no change.
   All values are written with textContent / createElement (never parsed as HTML). */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var PAGE = 25, sOff = 0, uOff = 0, sTimer = null, uTimer = null, currency = "INR";

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k]; else if (k === "cls") e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function int(v) { return num(v).toLocaleString("en-IN"); }
  function money(v) {
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency, maximumFractionDigits: 0 }).format(num(v)); }
    catch (e) { return "₹" + int(Math.round(num(v))); }
  }
  function date(v) { if (!v) return "—"; var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  function ago(v) {
    if (!v) return "never"; var d = (Date.now() - new Date(v).getTime()) / 864e5;
    if (!isFinite(d)) return "—"; if (d < 1) return "today"; if (d < 2) return "yesterday"; return Math.floor(d) + " days ago";
  }
  function bytes(b) { b = num(b); var u = ["B", "KB", "MB", "GB", "TB"], i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0) + " " + u[i]; }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function denied(e) { var c = (e && e.code) || ""; return c === "42501" || /not authorized|permission denied/i.test((e && e.message) || ""); }
  function notFound() {
    document.title = "Page not found — Helm";
    $("#vLoading").hidden = true; $("#vApp").hidden = true; $("#vNotFound").hidden = false;
  }
  function showErr(e) { var b = $("#err"); b.textContent = "Couldn’t load: " + ((e && e.message) || "unknown error"); b.hidden = false; }
  function call(fn, args) { return BPStore.hq(fn, args); }

  /* ---------------- overview ---------------- */
  function kpi(label, value, sub, tone) {
    return el("div", { cls: "kpi" + (tone ? " " + tone : "") }, [el("div", { cls: "l", text: label }), el("div", { cls: "v", text: value }), sub ? el("div", { cls: "s", text: sub }) : null]);
  }
  function renderOverview(o) {
    var s = o.studios || {}, u = o.users || {}, ev = o.events || {}, m = o.money || {};
    var k = clear($("#kpis"));
    k.appendChild(kpi("Studios", int(s.total), "+" + int(s.new_7d) + " in 7d · +" + int(s.new_30d) + " in 30d"));
    k.appendChild(kpi("Users", int(u.total), "+" + int(u.new_7d) + " in 7d · +" + int(u.new_30d) + " in 30d"));
    k.appendChild(kpi("Active users", int(u.active_7d), int(u.active_30d) + " in last 30 days"));
    k.appendChild(kpi("Events", int(ev.total), int(ev.this_month) + " created this month"));
    k.appendChild(kpi("Upcoming (30d)", int(ev.upcoming_30d), int(ev.confirmed) + " confirmed overall"));
    k.appendChild(kpi("Revenue booked", money(m.revenue_booked), "confirmed events"));
    k.appendChild(kpi("Received", money(m.received_all), money(m.received_30d) + " in last 30 days"));
    k.appendChild(kpi("Outstanding", money(m.outstanding), "booked minus received", num(m.outstanding) > 0 ? "warn" : ""));
    k.appendChild(kpi("Due in 14 days", money(m.due_14d_amount), int(m.due_14d_count) + " instalments"));
    k.appendChild(kpi("Overdue", money(m.overdue_amount), int(m.overdue_count) + " instalments", num(m.overdue_count) > 0 ? "bad" : ""));
    if (o.chat_messages_7d != null) k.appendChild(kpi("Chat messages", int(o.chat_messages_7d), "last 7 days"));
    if (o.auth_logins_7d != null) k.appendChild(kpi("Sign-ins", int(o.auth_logins_7d), "last 7 days"));

    renderChart(o.signups_30d || []);

    var top = clear($("#top"));
    (o.top_studios || []).slice(0, 8).forEach(function (t) {
      top.appendChild(el("li", null, [el("span", { text: t.name || "—" }), el("span", { cls: "muted", text: money(t.revenue) + " · " + int(t.events) + " ev" })]));
    });
    if (!top.firstChild) top.appendChild(el("li", { cls: "empty", text: "No studios yet." }));

    var ch = clear($("#churn"));
    (o.churn_risk || []).slice(0, 12).forEach(function (t) {
      ch.appendChild(el("li", null, [el("span", null, [t.name || "—", el("div", { cls: "muted", text: t.owner_email || "" })]), el("span", { cls: "muted", text: ago(t.last_activity) })]));
    });
    if (!ch.firstChild) ch.appendChild(el("li", { cls: "empty", text: "Every studio was active in the last 30 days." }));

    var mf = clear($("#mfa"));
    if (o.mfa) {
      var pct = Math.max(0, Math.min(100, num(o.mfa.pct)));
      mf.appendChild(el("div", { cls: "kpi-like" }, [el("strong", { text: pct + "%" }), " of users (" + int(o.mfa.users_with_mfa) + " / " + int(o.mfa.users_total) + ")"]));
      var bar = el("div", { cls: "bar" }); var fill = el("i"); fill.style.width = pct + "%"; bar.appendChild(fill); mf.appendChild(bar);
    } else mf.appendChild(el("div", { cls: "empty", text: "Not available on this database." }));

    var st = clear($("#storage"));
    (o.storage || []).forEach(function (b) {
      st.appendChild(el("li", null, [el("span", { text: b.bucket || "—" }), el("span", { cls: "muted", text: int(b.objects) + " files · " + bytes(b.bytes) })]));
    });
    if (!st.firstChild) st.appendChild(el("li", { cls: "empty", text: o.storage ? "No files stored." : "Not available." }));
  }

  // hand-drawn SVG line chart, no libraries
  function renderChart(series) {
    var NS = "http://www.w3.org/2000/svg", W = 600, H = 150, pl = 26, pr = 8, pt = 8, pb = 20;
    var box = clear($("#chart"));
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H); svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    var tu = 0, ts = 0, max = 1;
    series.forEach(function (d) { tu += num(d.users); ts += num(d.studios); max = Math.max(max, num(d.users), num(d.studios)); });
    svg.setAttribute("aria-label", "Sign-ups over the last 30 days: " + tu + " users, " + ts + " studios");
    function mk(tag, a) { var n = document.createElementNS(NS, tag); Object.keys(a).forEach(function (k) { n.setAttribute(k, a[k]); }); return n; }
    var n = Math.max(series.length - 1, 1);
    var x = function (i) { return pl + (W - pl - pr) * i / n; };
    var y = function (v) { return pt + (H - pt - pb) * (1 - v / max); };
    [0, 0.5, 1].forEach(function (f) {
      var yy = y(max * f);
      svg.appendChild(mk("line", { x1: pl, x2: W - pr, y1: yy, y2: yy, "class": "grid-l" }));
      var t = mk("text", { x: pl - 4, y: yy + 3, "text-anchor": "end", "class": "ax" }); t.textContent = String(Math.round(max * f)); svg.appendChild(t);
    });
    if (series.length) {
      var pu = series.map(function (d, i) { return x(i).toFixed(1) + "," + y(num(d.users)).toFixed(1); });
      var ps = series.map(function (d, i) { return x(i).toFixed(1) + "," + y(num(d.studios)).toFixed(1); });
      svg.appendChild(mk("polygon", { points: x(0) + "," + y(0) + " " + pu.join(" ") + " " + x(series.length - 1) + "," + y(0), "class": "ar-u" }));
      svg.appendChild(mk("polyline", { points: pu.join(" "), "class": "ln-u" }));
      svg.appendChild(mk("polyline", { points: ps.join(" "), "class": "ln-s" }));
      [0, Math.floor((series.length - 1) / 2), series.length - 1].forEach(function (i) {
        var t = mk("text", { x: x(i), y: H - 5, "text-anchor": i === 0 ? "start" : (i === series.length - 1 ? "end" : "middle"), "class": "ax" });
        t.textContent = date(series[i].day).replace(/ \d{4}$/, ""); svg.appendChild(t);
      });
    }
    box.appendChild(svg);
    box.appendChild(el("div", { cls: "muted", text: tu + " users · " + ts + " studios in 30 days" }));
  }

  /* ---------------- studios ---------------- */
  function pager(node, off, total, go) {
    clear(node);
    var from = total ? off + 1 : 0, to = Math.min(off + PAGE, total);
    node.appendChild(el("span", { text: from + "–" + to + " of " + total }));
    var prev = el("button", { cls: "btn", type: "button", text: "‹ Prev" }); prev.disabled = off <= 0;
    var next = el("button", { cls: "btn", type: "button", text: "Next ›" }); next.disabled = off + PAGE >= total;
    prev.addEventListener("click", function () { go(Math.max(0, off - PAGE)); });
    next.addEventListener("click", function () { go(off + PAGE); });
    node.appendChild(prev); node.appendChild(next);
  }
  async function loadStudios(off) {
    sOff = off || 0;
    var rows = await call("hq_studios", { p_search: $("#qStudios").value || null, p_limit: PAGE, p_offset: sOff });
    var tb = clear($("#tStudios")); rows = rows || [];
    rows.forEach(function (r) {
      var tr = el("tr", { cls: "click", tabindex: "0" }, [
        el("td", null, [el("strong", { text: r.name || "—" }), r.slug ? el("div", { cls: "muted", text: r.slug }) : null]),
        el("td", { text: r.owner_email || "—" }), el("td", null, [el("span", { cls: "pill", text: r.plan || "—" })]),
        el("td", { cls: "n", text: int(r.users_count) }), el("td", { cls: "n", text: int(r.events_count) }),
        el("td", { cls: "n", text: money(r.revenue) }), el("td", { cls: "n", text: money(r.paid) }),
        el("td", { text: ago(r.last_activity) }), el("td", { text: date(r.created_at) })]);
      var open = function () { loadDetail(r.org_id).catch(showErr); };
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
      tb.appendChild(tr);
    });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "9", cls: "empty", text: "No studios match." })]));
    pager($("#pStudios"), sOff, rows.length ? num(rows[0].total_count) : 0, function (o) { loadStudios(o).catch(showErr); });
  }
  async function loadDetail(org) {
    var d = await call("hq_studio_detail", { p_org: org }); var box = clear($("#studioDetail"));
    if (!d) return;
    var wrap = el("div", { cls: "detail" }, [el("h2", { text: d.name || "Studio" }),
      el("div", { cls: "muted", text: [d.location, d.currency, "created " + date(d.created_at)].filter(Boolean).join(" · ") })]);
    var ml = el("ul", { cls: "list" });
    (d.members || []).forEach(function (m) { ml.appendChild(el("li", null, [el("span", { text: m.email || "—" }), el("span", { cls: "muted", text: (m.role || "") + " · " + ago(m.last_sign_in_at) })])); });
    wrap.appendChild(el("h2", { text: "Members", style: "margin-top:10px" })); wrap.appendChild(ml);
    var el2 = el("ul", { cls: "list" });
    (d.recent_events || []).forEach(function (q) { el2.appendChild(el("li", null, [el("span", { text: (q.code || "") + " · " + (q.title || "") }), el("span", { cls: "muted", text: (q.status || "") + " · " + money(q.total) + " · " + date(q.event_date) })])); });
    if (!el2.firstChild) el2.appendChild(el("li", { cls: "empty", text: "No events." }));
    wrap.appendChild(el("h2", { text: "Recent events", style: "margin-top:10px" })); wrap.appendChild(el2);
    var cl = el("button", { cls: "btn", type: "button", text: "Close" }); cl.addEventListener("click", function () { clear(box); });
    wrap.appendChild(cl); box.appendChild(wrap); wrap.scrollIntoView({ block: "nearest" });
  }

  /* ---------------- users ---------------- */
  async function loadUsers(off) {
    uOff = off || 0;
    var rows = await call("hq_users", { p_search: $("#qUsers").value || null, p_limit: PAGE, p_offset: uOff });
    var tb = clear($("#tUsers")); rows = rows || [];
    rows.forEach(function (r) {
      tb.appendChild(el("tr", null, [el("td", { cls: "m", text: r.email || "—" }), el("td", { text: r.studio || "—" }), el("td", { text: r.role || "—" }),
        el("td", { text: date(r.created_at) }), el("td", { text: ago(r.last_sign_in_at) }),
        el("td", null, [el("span", { cls: "pill " + (r.email_confirmed ? "ok" : "warn"), text: r.email_confirmed ? "yes" : "no" })]),
        el("td", null, [el("span", { cls: "pill " + (r.mfa_enabled ? "ok" : ""), text: r.mfa_enabled ? "on" : "off" })])]));
    });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "7", cls: "empty", text: "No users match." })]));
    pager($("#pUsers"), uOff, rows.length ? num(rows[0].total_count) : 0, function (o) { loadUsers(o).catch(showErr); });
  }

  /* ---------------- payments ---------------- */
  async function loadPayments() {
    var r = await call("hq_payments", { p_from: $("#pFrom").value || null, p_to: $("#pTo").value || null }) || {};
    var tb = clear($("#tPay"));
    (r.payments || []).forEach(function (p) {
      var tone = p.simulated ? "warn" : (p.status === "paid" ? "ok" : "");
      tb.appendChild(el("tr", null, [el("td", { text: date(p.paid_at) }), el("td", { text: p.studio || "—" }), el("td", { cls: "m", text: p.event || "—" }),
        el("td", { text: p.method || "—" }), el("td", null, [el("span", { cls: "pill " + tone, text: p.simulated ? "test" : (p.status || "—") })]),
        el("td", { cls: "n", text: money(p.amount) })]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "6", cls: "empty", text: "No payments in this range." })]));
    var due = clear($("#due")), ms = r.milestones || [];
    var ul = el("ul", { cls: "list" });
    ms.slice(0, 20).forEach(function (m) {
      ul.appendChild(el("li", null, [el("span", null, [(m.studio || "—") + " · " + (m.event || ""), el("div", { cls: "muted", text: m.label || "" })]),
        el("span", { cls: "n" }, [money(m.amount), el("div", null, [el("span", { cls: "pill " + (m.overdue ? "bad" : "warn"), text: (m.overdue ? "overdue " : "due ") + date(m.due_date) })])])]));
    });
    if (!ms.length) ul.appendChild(el("li", { cls: "empty", text: "Nothing due in the next 14 days." }));
    due.appendChild(ul);
  }

  async function loadAll() {
    $("#err").hidden = true;
    var o = await call("hq_overview");
    renderOverview(o || {});
    await Promise.all([loadStudios(0), loadUsers(0), loadPayments()]);
  }

  async function start() {
    try { await BPStore.init(); } catch (e) { notFound(); return; }
    if (!BPStore.auth.enabled()) { notFound(); return; }
    BPStore.auth.required();
    if (!BPStore.auth.user()) {
      location.replace("login.html?next=hq"); return;
    }
    var today = new Date(), past = new Date(Date.now() - 30 * 864e5);
    $("#pFrom").value = iso(past); $("#pTo").value = iso(today);
    try { await loadAll(); }
    catch (e) { notFound(); return; }   // any failure on first load (refused, missing, offline) looks like a missing page — never reveal HQ exists
    document.title = "Helm HQ";
    $("#who").textContent = (BPStore.auth.user() && BPStore.auth.user().email) || "";
    $("#vLoading").hidden = true; $("#vApp").hidden = false;

    $("#btnRefresh").addEventListener("click", function () { loadAll().catch(showErr); });
    $("#btnOut").addEventListener("click", function () { Promise.resolve(BPStore.auth.signOut && BPStore.auth.signOut()).finally(function () { location.replace("login.html"); }); });
    $("#btnPay").addEventListener("click", function () { loadPayments().catch(showErr); });
    $("#qStudios").addEventListener("input", function () { clearTimeout(sTimer); sTimer = setTimeout(function () { loadStudios(0).catch(showErr); }, 300); });
    $("#qUsers").addEventListener("input", function () { clearTimeout(uTimer); uTimer = setTimeout(function () { loadUsers(0).catch(showErr); }, 300); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
