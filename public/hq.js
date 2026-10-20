/* hq.js — Helm HQ, the private platform-owner dashboard (migrations 0029 + 0045).
   Not linked from anywhere. Signed out → sign-in page. Signed in but not a
   platform operator → an ordinary "page not found" (the route never confirms it
   exists). The real control is in the database: every hq_* RPC is SECURITY
   DEFINER and refuses (42501) anyone not in public.platform_admins; every HQ
   write also needs a two-step (aal2) session and is audit-logged.
   0045: HQ shows NO studio business data — only studios, their people and what
   each studio paid Helm (subscription billing).
   External file — no inline script, so the hash-based CSP needs no change.
   All values are written with textContent / createElement (never parsed as HTML). */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var PAGE = 25, sOff = 0, uOff = 0, sTimer = null, uTimer = null, plans = [], lastBilling = null;

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
  function money(v, cur) {
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", maximumFractionDigits: 2 }).format(num(v)); }
    catch (e) { return (cur || "INR") + " " + num(v).toFixed(2); }
  }
  function moneyList(list) {
    list = Array.isArray(list) ? list : [];
    return list.length ? list.map(function (m) { return money(m.amount, m.currency); }).join(" + ") : money(0);
  }
  // a bare day ("2026-10-26") is shown as that day (new Date("YYYY-MM-DD") is UTC midnight: the day before west of UTC)
  function date(v) {
    if (!v) return "—"; var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
    var d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : new Date(v);
    return isNaN(d) ? "—" : d.toLocaleDateString("en-IN", m ? { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short", year: "numeric" });
  }
  // L9 (live QA): a studio's trial end is the STUDIO's calendar day of the exact end moment (hq_trial_info 0223 sends
  // the studio's timezone; trial studios are India by default) - the same day the studio sees, never the UTC day or
  // the operator's browser day. An end at exactly midnight belongs to the day before.
  function trialDay(v, tz) {
    if (!v) return "—";
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v).trim())) return date(v);
    var ms = Date.parse(v); if (!isFinite(ms)) return "—";
    var zones = [tz || "Asia/Kolkata", "Asia/Kolkata"];
    for (var i = 0; i < zones.length; i++) {
      try { return new Date(ms - 1).toLocaleDateString("en-IN", { timeZone: zones[i], day: "numeric", month: "short", year: "numeric" }); } catch (e) {}
    }
    return date(v);
  }
  function ago(v) {
    if (!v) return "never"; var d = (Date.now() - new Date(v).getTime()) / 864e5;
    if (!isFinite(d)) return "—"; if (d < 1) return "today"; if (d < 2) return "yesterday"; return Math.floor(d) + " days ago";
  }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function notFound() {
    document.title = "Page not found — Helm";
    $("#vLoading").hidden = true; $("#vApp").hidden = true; $("#vNotFound").hidden = false;
  }
  function showErr(e) { var b = $("#err"); b.textContent = "Couldn’t complete that: " + ((e && e.message) || "unknown error"); b.hidden = false; }
  function okMsg(t) { var b = $("#ok"); b.textContent = t; b.hidden = false; setTimeout(function () { b.hidden = true; }, 4000); }
  function call(fn, args) { return BPStore.hq(fn, args); }
  function statusPill(s) {
    var tone = { active: "ok", trial: "", past_due: "warn", suspended: "bad", cancelled: "", none: "" }[s || "none"];
    var words = { active: "Paying", trial: "Trial", past_due: "Past due", suspended: "Suspended", cancelled: "Cancelled", none: "No plan" };
    return el("span", { cls: "pill " + (tone || ""), text: words[s || "none"] || String(s).replace("_", " ") });
  }
  function ask(text, def) { var r = window.prompt(text, def || ""); return r == null ? null : String(r).trim(); }
  function openInvoice(fn, id) {
    call(fn, { p_payment_id: id }).then(function (data) {
      if (window.HelmInvoice && typeof window.HelmInvoice.open === "function") window.HelmInvoice.open(data);
      else showErr(new Error("Invoice viewer not loaded"));
    }).catch(showErr);
  }

  /* ---------------- tabs ---------------- */
  var TABS = ["overview", "studios", "billing", "requests", "plans", "people", "activity", "staff"];
  var TITLES = { overview: "Overview", studios: "Studios", billing: "Billing", requests: "Requests", plans: "Plans & prices",
    people: "People", activity: "Activity log", staff: "Staff access" };
  function showTab(name) {
    TABS.forEach(function (t) {
      var p = $("#pane-" + t), b = $("#tab-" + t);
      if (p) p.hidden = t !== name;
      if (b) b.setAttribute("aria-pressed", t === name ? "true" : "false");
    });
    var h = $("#pageTitle"); if (h) h.textContent = TITLES[name] || "Helm HQ";
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  /* ---------------- r25: small inline-SVG charts (no library; textContent / attributes only) ---------------- */
  var SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs, kids) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (k === "text") e.textContent = attrs[k]; else e.setAttribute(k, String(attrs[k])); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  // pure: a "nice" top for an axis (1, 2, 2.5, 5 x 10^n) - exported for tests
  function niceMax(v) {
    v = Number(v); if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  // pure: short rupees for an axis / tile (₹950, ₹12.5K, ₹3.2L, ₹1.1Cr)
  function shortInr(v) {
    var n = num(v), a = Math.abs(n), s = n < 0 ? "-" : "";
    if (a >= 1e7) return s + "₹" + (a / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, "") + "Cr";
    if (a >= 1e5) return s + "₹" + (a / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, "") + "L";
    if (a >= 1e3) return s + "₹" + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
    return s + "₹" + Math.round(a);
  }
  function monthLabel(ym) { var m = /^(\d{4})-(\d{2})/.exec(String(ym || "")); return m ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m[2] - 1] : ""; }
  function weekLabel(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); return m ? (+m[3]) + " " + monthLabel(m[1] + "-" + m[2]) : ""; }
  function emptyChart(box, text) { clear(box).appendChild(svg("svg", { viewBox: "0 0 600 170", role: "img", "aria-label": text }, [svg("text", { x: 300, y: 90, "text-anchor": "middle", "class": "empty-c", text: text })])); }
  // bar chart: rows [{label, value}]
  function barChart(box, rows, fmt, label) {
    rows = rows || []; fmt = fmt || int;
    var W = 600, H = 170, L = 34, B = 22, T = 14, max = niceMax(Math.max.apply(null, rows.map(function (r) { return num(r.value); }).concat([0])));
    if (!rows.length) { emptyChart(box, "No data yet"); return; }
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label || "" });
    [0, 0.5, 1].forEach(function (f) { var y = T + (H - T - B) * (1 - f);
      g.appendChild(svg("line", { x1: L, x2: W, y1: y, y2: y, "class": "grid-l" }));
      g.appendChild(svg("text", { x: L - 6, y: y + 3, "text-anchor": "end", "class": "ax", text: fmt(max * f) })); });
    var step = (W - L) / rows.length, bw = Math.max(6, Math.min(34, step * 0.62));
    rows.forEach(function (r, i) {
      var v = num(r.value), h = (H - T - B) * (v / max), x = L + step * i + (step - bw) / 2, y = H - B - h;
      var b = svg("rect", { x: x.toFixed(1), y: y.toFixed(1), width: bw.toFixed(1), height: Math.max(v > 0 ? 2 : 0, h).toFixed(1), rx: 3, "class": "cbar" });
      b.appendChild(svg("title", { text: r.label + ": " + fmt(v) })); g.appendChild(b);
      if (v > 0) g.appendChild(svg("text", { x: (x + bw / 2).toFixed(1), y: (y - 4).toFixed(1), "text-anchor": "middle", "class": "vl", text: fmt(v) }));
      if (rows.length <= 12 && (i % (rows.length > 8 ? 2 : 1) === 0 || i === rows.length - 1))
        g.appendChild(svg("text", { x: (x + bw / 2).toFixed(1), y: H - 6, "text-anchor": "middle", "class": "ax", text: r.label }));
    });
    clear(box).appendChild(g);
  }
  // line chart: rows [{label, a, b}] - a = solid line + area, b = dashed line
  function lineChart(box, rows, fmt, label) {
    rows = rows || []; fmt = fmt || int;
    if (!rows.length) { emptyChart(box, "No data yet"); return; }
    var W = 600, H = 170, L = 44, B = 22, T = 14;
    var max = niceMax(Math.max.apply(null, rows.map(function (r) { return Math.max(num(r.a), num(r.b)); }).concat([0])));
    var X = function (i) { return L + (rows.length === 1 ? (W - L) / 2 : (W - L - 10) * i / (rows.length - 1)); };
    var Y = function (v) { return T + (H - T - B) * (1 - num(v) / max); };
    var g = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label || "" });
    [0, 0.5, 1].forEach(function (f) { var y = T + (H - T - B) * (1 - f);
      g.appendChild(svg("line", { x1: L, x2: W, y1: y, y2: y, "class": "grid-l" }));
      g.appendChild(svg("text", { x: L - 6, y: y + 3, "text-anchor": "end", "class": "ax", text: fmt(max * f) })); });
    var pa = rows.map(function (r, i) { return X(i).toFixed(1) + "," + Y(r.a).toFixed(1); });
    var pb = rows.map(function (r, i) { return X(i).toFixed(1) + "," + Y(r.b).toFixed(1); });
    g.appendChild(svg("polygon", { points: X(0).toFixed(1) + "," + (H - B) + " " + pa.join(" ") + " " + X(rows.length - 1).toFixed(1) + "," + (H - B), "class": "ar-u" }));
    g.appendChild(svg("polyline", { points: pb.join(" "), "class": "ln-s" }));
    g.appendChild(svg("polyline", { points: pa.join(" "), "class": "ln-u" }));
    rows.forEach(function (r, i) {
      var d = svg("circle", { cx: X(i).toFixed(1), cy: Y(r.a).toFixed(1), r: 3.2, "class": "dot" });
      d.appendChild(svg("title", { text: r.label + ": MRR " + fmt(r.a) + " · received " + fmt(r.b) })); g.appendChild(d);
      if (i % 2 === (rows.length - 1) % 2) g.appendChild(svg("text", { x: X(i).toFixed(1), y: H - 6, "text-anchor": "middle", "class": "ax", text: r.label }));
    });
    clear(box).appendChild(g);
  }
  // donut: rows [{label, value}]
  function donut(box, rows, centre, sub) {
    rows = (rows || []).filter(function (r) { return num(r.value) > 0; });
    var total = rows.reduce(function (s, r) { return s + num(r.value); }, 0), R = 52, C = 2 * Math.PI * R, off = 0;
    var g = svg("svg", { viewBox: "0 0 150 150", role: "img", "aria-label": "Plan mix" });
    g.appendChild(svg("circle", { cx: 75, cy: 75, r: R, fill: "none", "stroke-width": 18, "class": "dbg" }));
    rows.forEach(function (r, i) {
      var len = C * num(r.value) / total;
      var c = svg("circle", { cx: 75, cy: 75, r: R, fill: "none", "stroke-width": 18, "class": "d" + (i % 6 + 1), "stroke-dasharray": len.toFixed(2) + " " + (C - len).toFixed(2), "stroke-dashoffset": (-off).toFixed(2), transform: "rotate(-90 75 75)" });
      c.appendChild(svg("title", { text: r.label + ": " + int(r.value) })); g.appendChild(c); off += len;
    });
    g.appendChild(svg("text", { x: 75, y: 78, "text-anchor": "middle", "class": "ctr", text: centre }));
    g.appendChild(svg("text", { x: 75, y: 94, "text-anchor": "middle", "class": "ctr2", text: sub }));
    var lg = el("div", { cls: "legend" });
    rows.forEach(function (r, i) { lg.appendChild(el("div", { cls: "li" }, [el("i", { cls: "sw s" + (i % 6 + 1) }), el("span", { text: r.label }), el("b", { text: int(r.value) })])); });
    if (!rows.length) lg.appendChild(el("div", { cls: "empty", text: "No paying studios yet." }));
    clear(box).appendChild(g); box.appendChild(lg);
  }
  function funnel(box, steps) {
    clear(box); var top = Math.max(1, num(steps[0] && steps[0].value));
    steps.forEach(function (s) {
      var pct = Math.round(100 * num(s.value) / top);
      var bar = el("div", { cls: "bar" }), fill = el("i"); fill.style.width = Math.max(0, Math.min(100, pct)) + "%"; bar.appendChild(fill);
      box.appendChild(el("div", { cls: "fstep" }, [el("div", { cls: "fl" }, [el("span", { text: s.label }), el("b", { text: int(s.value) + (s.pct != null ? " · " + s.pct : "") })]), bar]));
    });
  }

  /* ---------------- overview ---------------- */
  function kpi(label, value, sub, tone, go) {
    var k = el(go ? "button" : "div", { cls: "kpi" + (tone ? " " + tone : "") }, [el("div", { cls: "l", text: label }), el("div", { cls: "v", text: value }), sub ? el("div", { cls: "s", text: sub }) : null]);
    if (go) { k.setAttribute("type", "button"); k.addEventListener("click", go); }
    return k;
  }
  function goTab(t, after) { return function () { showTab(t); if (after) after(); }; }
  function goStudios(status) { return function () { showTab("studios"); $("#fStatus").value = status || ""; loadStudios(0).catch(showErr); }; }
  function inrOf(list) { var t = 0; (Array.isArray(list) ? list : []).forEach(function (m) { if ((m.currency || "INR") === "INR") t += num(m.amount); }); return t; }
  function failedEmails(m) { return ((m && m.health && m.health.queues) || []).reduce(function (s, q) { return s + num(q.failed_7d); }, 0); }
  function openRequests(m) { var a = (m && m.attention) || {}; return num(a.new_plan_requests) + num(a.new_sales_enquiries) + num(a.new_suggestions); }
  function renderOverview(o, m) {
    o = o || {};
    var s = o.studios || {}, u = o.users || {}, b = o.billing || {}, bs = s.by_status || {};
    var k = clear($("#kpis"));
    if (m && m.studios) {
      var ms = m.studios, conv = m.conversion || {}, mrr = inrOf(b.mrr), nReq = openRequests(m), nFail = failedEmails(m);
      var growth = num(ms.new_30d) - num(ms.new_prev_30d);
      k.appendChild(kpi("Studios", int(ms.total), int(ms.active_30d) + " signed in within 30 days", "", goStudios("")));
      k.appendChild(kpi("Paying studios", int(ms.paying), int(ms.past_due) + " past due · " + int(ms.suspended) + " suspended", "good", goStudios("active")));
      k.appendChild(kpi("On free trial", int(ms.trial), int((m.attention || {}).trials_ending_count) + " end within 7 days", "", goStudios("trial")));
      k.appendChild(kpi("MRR", moneyList(b.mrr), "ARR " + money(mrr * 12) + " · from active plans"));
      k.appendChild(kpi("New studios (30 days)", int(ms.new_30d), (growth >= 0 ? "+" : "") + int(growth) + " vs the 30 days before"));
      k.appendChild(kpi("Trial → paid", conv.pct == null ? "—" : num(conv.pct) + "%", int(conv.converted) + " of " + int(conv.trials_ended) + " ended trials paid"));
      k.appendChild(kpi("Open requests", int(nReq), "plan requests, sales, suggestions", nReq > 0 ? "warn" : "", goTab("requests", loadRequestsTab)));
      k.appendChild(kpi("Failed e-mails (7 days)", int(nFail), "see System health", nFail > 0 ? "bad" : ""));
    } else {
      k.appendChild(kpi("Studios", int(s.total), "+" + int(s.new_7d) + " in 7d · +" + int(s.new_30d) + " in 30d"));
      k.appendChild(kpi("MRR", moneyList(b.mrr), "active + past-due plans"));
      k.appendChild(kpi("Paid this month", moneyList(b.paid_this_month), "Helm subscription payments"));
      k.appendChild(kpi("Past due", int(b.past_due_count), int(b.reminders_pending) + " reminders queued", num(b.past_due_count) > 0 ? "warn" : ""));
      k.appendChild(kpi("Suspended", int(b.suspended_count), "read-only studios", num(b.suspended_count) > 0 ? "bad" : ""));
      k.appendChild(kpi("Users", int(u.total), int(u.active_7d) + " active in 7 days"));
      if (o.auth_logins_7d != null) k.appendChild(kpi("Sign-ins", int(o.auth_logins_7d), "last 7 days"));
    }
    renderCharts(o, m);
    renderAttention(o, m);
    renderHealth(m);
    renderTop(m);
    var st = clear($("#byStatus"));
    ["trial", "active", "past_due", "suspended", "cancelled", "none"].forEach(function (key) {
      st.appendChild(el("li", null, [statusPill(key), el("span", { cls: "muted", text: int(bs[key] || 0) + " studios" })]));
    });
    var mf = clear($("#mfa"));
    if (o.mfa) {
      var pct = Math.max(0, Math.min(100, num(o.mfa.pct)));
      mf.appendChild(el("div", null, [el("strong", { text: pct + "%" }), " of users (" + int(o.mfa.users_with_mfa) + " / " + int(o.mfa.users_total) + ")"]));
      var bar = el("div", { cls: "bar" }); var fill = el("i"); fill.style.width = pct + "%"; bar.appendChild(fill); mf.appendChild(bar);
    } else mf.appendChild(el("div", { cls: "empty", text: "Not available on this database." }));
    var nb = $("#navReqCount"), nr = openRequests(m);
    if (nb) { nb.textContent = nr > 99 ? "99+" : String(nr); nb.hidden = !(nr > 0); }
  }
  function renderCharts(o, m) {
    var sw = (m && m.signups_weekly) || null;
    if (!sw) {   // database without 0272: daily signups of hq_overview, grouped by week
      var days = Array.isArray(o.signups_30d) ? o.signups_30d : [], wk = {};
      days.forEach(function (d) { var k2 = String(d.day).slice(0, 10), t = new Date(k2 + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7)); var key = t.toISOString().slice(0, 10); wk[key] = (wk[key] || 0) + num(d.studios); });
      sw = Object.keys(wk).sort().map(function (key) { return { week: key, studios: wk[key] }; });
    }
    var total = sw.reduce(function (a, r) { return a + num(r.studios); }, 0);
    $("#cSignSum").textContent = int(total) + " in " + sw.length + " weeks";
    barChart($("#cSign"), sw.map(function (r) { return { label: weekLabel(r.week), value: r.studios }; }), int, "New studios per week");
    var mm = (m && m.mrr_monthly) || [];
    if (mm.length) {
      var last = mm[mm.length - 1] || {};
      $("#cMrrSum").textContent = "this month " + shortInr(last.mrr);
      lineChart($("#cMrr"), mm.map(function (r) { return { label: monthLabel(r.month), a: r.mrr, b: r.collected }; }), shortInr, "MRR and money received per month");
    } else { $("#cMrrSum").textContent = ""; emptyChart($("#cMrr"), "Appears after SQL 0272 is applied"); }
    var mix = (m && m.plan_mix) || null;
    if (mix) { var paying = mix.reduce(function (a, r) { return a + num(r.studios); }, 0);
      donut($("#cMix"), mix.map(function (r) { return { label: r.plan, value: r.studios }; }), int(paying), "studios"); }
    else clear($("#cMix")).appendChild(el("div", { cls: "empty", text: "Appears after SQL 0272 is applied." }));
    var f = (m && m.funnel) || null;
    if (f) {
      var p = function (a, b2) { return num(b2) > 0 ? Math.round(100 * num(a) / num(b2)) + "%" : null; };
      funnel($("#cFun"), [{ label: "Signed up", value: f.signed_up }, { label: "Still on trial", value: f.on_trial, pct: p(f.on_trial, f.signed_up) },
        { label: "Added a teammate", value: f.added_team, pct: p(f.added_team, f.signed_up) }, { label: "Paid Helm", value: f.paid, pct: p(f.paid, f.signed_up) }]);
    } else clear($("#cFun")).appendChild(el("div", { cls: "empty", text: "Appears after SQL 0272 is applied." }));
  }
  function attRow(icon, tone, title, sub, go, btnText) {
    var li = el("li", null, [el("span", { cls: "ic " + tone, text: icon, "aria-hidden": "true" }), el("div", { cls: "tx" }, [el("b", { text: title }), el("span", { text: sub })])]);
    if (go) { var b = el("button", { cls: "btn sm", type: "button", text: btnText || "Open" }); b.addEventListener("click", go); li.appendChild(b); }
    return li;
  }
  function renderAttention(o, m) {
    var ul = clear($("#attList")), a = (m && m.attention) || {}, n = 0, add = function (li) { ul.appendChild(li); n++; };
    var open = function (id) { return function () { openStudio(id); }; };
    var reqs = [["new_plan_requests", "plan request", "plan requests", "plan"], ["new_sales_enquiries", "sales enquiry", "sales enquiries", "sales"],
      ["new_suggestions", "suggestion", "suggestions", "sugg"]];
    reqs.forEach(function (r) { var c = num(a[r[0]]); if (c > 0) add(attRow("✉", "warn", int(c) + " new " + (c === 1 ? r[1] : r[2]), "waiting for a reply",
      function () { showTab("requests"); reqTab(r[3]); loadRequestsTab(); }, "Reply")); });
    (a.past_due || []).forEach(function (x) { add(attRow("₹", "bad", (x.name || "Studio") + " — payment pending", "plan period ended " + date(x.period_end), open(x.org_id), "Open")); });
    (a.trials_ending || []).forEach(function (x) { add(attRow("⏳", "warn", (x.name || "Studio") + " — trial ends " + trialDay(x.ends_at), "talk to them before it ends", open(x.org_id), "Open")); });
    var nf = failedEmails(m); if (nf > 0) add(attRow("!", "bad", int(nf) + " e-mail" + (nf === 1 ? "" : "s") + " failed in 7 days", "see System health", null));
    (a.at_risk || []).forEach(function (x) { add(attRow("↓", "", (x.name || "Studio") + " — paying, quiet", "no sign-in " + (x.last_sign_in ? "since " + date(x.last_sign_in) : "yet"), open(x.org_id), "Open")); });
    if (!m) { var pd = num((o.billing || {}).past_due_count); if (pd) add(attRow("₹", "bad", int(pd) + " studio" + (pd === 1 ? "" : "s") + " past due", "see Billing", goTab("billing"))); }
    if (!n) ul.appendChild(attRow("✓", "ok", "All clear", "nothing needs you right now", null));
    $("#attCount").textContent = n ? int(n) + " item" + (n === 1 ? "" : "s") : "";
  }
  var QUEUE_OK_MIN = 60;   // a waiting e-mail older than this many minutes = the sender is probably not running
  function renderHealth(m) {
    var box = clear($("#health")), st = clear($("#healthState"));
    if (!m || !m.health) { box.appendChild(el("div", { cls: "empty", text: "Appears after SQL 0272 is applied." })); return; }
    var qs = m.health.queues || [], bad = 0;
    qs.forEach(function (q) {
      var oldMin = q.oldest_waiting ? (Date.now() - new Date(q.oldest_waiting).getTime()) / 6e4 : 0;
      var stuck = num(q.waiting) > 0 && oldMin > QUEUE_OK_MIN, failed = num(q.failed_7d) > 0;
      if (stuck || failed) bad++;
      box.appendChild(el("div", { cls: "hrow" }, [el("span", { text: q.label || q.name }), el("span", { cls: "nums" }, [
        el("span", { cls: "pill " + (stuck ? "warn" : ""), text: int(q.waiting) + " waiting" }),
        el("span", { cls: "pill " + (failed ? "bad" : ""), text: int(q.failed_7d) + " failed" }),
        el("span", { cls: "pill ok", text: int(q.sent_24h) + " sent today" })])]));
    });
    var c = m.health.cron || {};
    box.appendChild(el("h3", { cls: "muted", text: "Scheduled jobs" }));
    if (!c.readable) box.appendChild(el("div", { cls: "empty", text: "Job history isn’t readable on this database." }));
    else {
      var jobs = c.jobs || [], failedJobs = jobs.filter(function (j) { return num(j.failed_24h) > 0 || j.last_status === "failed"; });
      if (failedJobs.length) bad++;
      var lastRun = jobs.reduce(function (a, j) { return j.last_run && (!a || j.last_run > a) ? j.last_run : a; }, null);
      box.appendChild(el("div", { cls: "hrow" }, [el("span", { text: int(jobs.length) + " jobs · last run " + (lastRun ? ago2(lastRun) : "never") }),
        el("span", { cls: "pill " + (failedJobs.length ? "bad" : "ok"), text: failedJobs.length ? int(failedJobs.length) + " failing" : "all OK" })]));
      failedJobs.slice(0, 5).forEach(function (j) { box.appendChild(el("div", { cls: "hrow" }, [el("span", { cls: "m", text: j.name }), el("span", { cls: "pill bad", text: int(j.failed_24h) + " failed in 24 h" })])); });
    }
    st.appendChild(el("span", { cls: "pill " + (bad ? "warn" : "ok"), text: bad ? "Check" : "All good" }));
  }
  function ago2(v) { var mins = (Date.now() - new Date(v).getTime()) / 6e4; if (!isFinite(mins)) return "—"; if (mins < 1) return "just now"; if (mins < 60) return Math.round(mins) + " min ago"; if (mins < 1440) return Math.round(mins / 60) + " h ago"; return ago(v); }
  function renderTop(m) {
    var tb = clear($("#tTop")), rows = (m && m.top_usage) || [];
    rows.forEach(function (r) {
      var tr = el("tr", { cls: "click", tabindex: "0" }, [el("td", null, [el("strong", { text: r.name || "—" })]),
        el("td", null, [statusPill(r.status), r.plan ? " " + r.plan : ""]), el("td", { cls: "n", text: int(r.active_30d) }),
        el("td", { cls: "n", text: int(r.people) }), el("td", { text: ago(r.last_sign_in) })]);
      var go = function () { openStudio(r.org_id); };
      tr.addEventListener("click", go); tr.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
      tb.appendChild(tr);
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: m ? "No sign-ins in the last 30 days." : "Appears after SQL 0272 is applied." })]));
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
    var rows = await call("hq_studios", { p_search: $("#qStudios").value || null, p_status: $("#fStatus").value || null, p_limit: PAGE, p_offset: sOff });
    var tb = clear($("#tStudios")); rows = Array.isArray(rows) ? rows : [];
    rows.forEach(function (r) {
      var tr = el("tr", { cls: "click", tabindex: "0" }, [
        el("td", null, [el("strong", { text: r.name || "—" }), r.slug ? el("div", { cls: "muted", text: "helm.events/" + r.slug }) : null]),
        el("td", null, [r.primary_contact_name || r.owner_email || "—", el("div", { cls: "muted", text: [r.primary_contact_email, r.primary_contact_phone].filter(Boolean).join(" · ") })]),
        el("td", { text: [r.state, r.country].filter(Boolean).join(", ") || "—" }), el("td", { text: r.plan_name || "—" }), el("td", null, [statusPill(r.status)]),
        el("td", { text: date(r.current_period_end) }), el("td", { cls: "n", text: int(r.users_count) }),
        el("td", { cls: "n", text: money(r.total_paid) }), el("td", { text: ago(r.last_activity) })]);
      var open = function () { openStudio(r.org_id); };
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
      tb.appendChild(tr);
    });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "9", cls: "empty", text: "No studios match." })]));
    pager($("#pStudios"), sOff, rows.length ? num(rows[0].total_count) : 0, function (o) { loadStudios(o).catch(showErr); });
  }
  function field(label, input) { return el("label", { cls: "fld" }, [el("span", { text: label }), input]); }
  function paymentRows(tbody, list, withStudio, invoiceFn) {
    clear(tbody);
    (list || []).forEach(function (p) {
      var inv = el("button", { cls: "btn sm", type: "button", text: "Invoice" });
      inv.addEventListener("click", function () { openInvoice(invoiceFn || "hq_invoice", p.id); });
      var acts = el("td", null, [inv]);
      if (!p.voided) {
        var v = el("button", { cls: "btn sm danger", type: "button", text: "Void" });
        v.addEventListener("click", function () {
          var why = ask("Void payment " + (p.invoice_no || "") + " of " + money(p.amount, p.currency) + "? The row and invoice number are kept. Reason:");
          if (!why) return;
          call("hq_void_payment", { p_id: p.id, p_reason: why }).then(function () { okMsg("Payment voided."); refreshAfterWrite(p.org_id); }).catch(showErr);
        });
        acts.appendChild(v);
      }
      tbody.appendChild(el("tr", { cls: p.voided ? "void" : "" }, [
        el("td", { text: date(p.paid_on) }), withStudio ? el("td", { text: p.studio || "—" }) : null,
        el("td", { cls: "m", text: p.invoice_no || "—" }), el("td", { text: p.method || "—" }),
        el("td", { text: (p.period_start ? date(p.period_start) + " – " + date(p.period_end) : "—") }),
        el("td", { cls: "n", text: money(p.amount, p.currency) }),
        el("td", null, [p.voided ? el("span", { cls: "pill bad", text: "void" }) : el("span", { cls: "pill ok", text: "paid" })]), acts]));
    });
    if (!tbody.firstChild) tbody.appendChild(el("tr", null, [el("td", { colspan: withStudio ? "8" : "7", cls: "empty", text: "No payments." })]));
  }
  var openOrg = null;
  function refreshAfterWrite(org) {
    if (org && openOrg === org) loadDetail(org, curDTab).catch(showErr);
    loadStudios(sOff).catch(showErr); loadBilling().catch(showErr); loadOverview().catch(showErr);
  }

  /* ---------------- r25: studio drawer (Overview · Plan & billing · People · Name & link · Activity) ---------------- */
  var DTABS = ["overview", "plan", "people", "ident", "activity"], curDTab = "overview", lastFocus = null;
  function dTab(name) {
    curDTab = DTABS.indexOf(name) >= 0 ? name : "overview";
    DTABS.forEach(function (t) {
      var b = $("#dt-" + t), p = $("#dp-" + t);
      if (b) b.setAttribute("aria-selected", t === curDTab ? "true" : "false");
      if (p) p.hidden = t !== curDTab;
    });
    var body = $("#studioDetail"); if (body) body.scrollTop = 0;
  }
  function openDrawer() {
    var dr = $("#studioDrawer"); if (!dr.hidden) return;
    lastFocus = document.activeElement; dr.hidden = false; $("#studioScrim").hidden = false;
    try { $("#btnDClose").focus(); } catch (e) {}
  }
  function closeDrawer() {
    $("#studioDrawer").hidden = true; $("#studioScrim").hidden = true; openOrg = null;
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) {}
  }
  function openStudio(org, tab) { if (!org) return; loadDetail(org, tab || "overview").catch(showErr); }
  function fact(label, value) { return el("div", { cls: "fact" }, [el("div", { cls: "l", text: label }), el("div", { cls: "v", text: value })]); }
  function kvList(pairs) {
    var dl = el("dl", { cls: "kv" });
    pairs.filter(function (p) { return p[1] != null && String(p[1]).trim() !== ""; }).forEach(function (p) { dl.appendChild(el("dt", { text: p[0] })); dl.appendChild(el("dd", { text: String(p[1]) })); });
    if (!dl.firstChild) dl.appendChild(el("dd", { cls: "muted", text: "Not filled in yet." }));
    return dl;
  }
  async function loadDetail(org, tab) {
    var d = await call("hq_studio_detail", { p_org: org }); var box = clear($("#studioDetail"));
    if (!d) return; openOrg = org;
    var sub = d.subscription || {}, acc = d.account || {};
    $("#dName").textContent = d.name || "Studio";
    $("#dMeta").textContent = [d.slug ? "helm.events/" + d.slug : "", "joined " + date(d.created_at), int(d.users_count) + " people"].filter(Boolean).join(" · ");
    clear($("#dStatus")).appendChild(statusPill(sub.status || d.status));
    var panes = {};
    DTABS.forEach(function (t) { panes[t] = el("div", { cls: "dpane", id: "dp-" + t, role: "tabpanel", "aria-labelledby": "dt-" + t }); box.appendChild(panes[t]); });
    var lastIn = (d.members || []).reduce(function (a, m) { return m.last_sign_in_at && (!a || m.last_sign_in_at > a) ? m.last_sign_in_at : a; }, null);

    // ---- Overview: the key facts, contacts, the big buttons, business details
    var wrap = panes.overview;
    wrap.appendChild(el("div", { cls: "facts" }, [
      fact("Plan", sub.plan_name || "No plan"),
      fact(sub.status === "trial" ? "Trial ends" : "Period ends", sub.status === "trial" ? date(sub.trial_ends_at) : date(sub.current_period_end)),
      fact("Paid to Helm", money(d.total_paid)),
      fact("People", int(d.users_count)), fact("Last sign-in", ago(lastIn)), fact("Joined", date(d.created_at))]));
    var bName = el("button", { cls: "btn primary", type: "button", text: "Change studio name & link" });
    bName.addEventListener("click", function () { dTab("ident"); });
    var bPlan = el("button", { cls: "btn", type: "button", text: sub.status === "active" ? "Plan & payments" : "Activate plan" });
    bPlan.addEventListener("click", function () { dTab("plan"); });
    var bPeople = el("button", { cls: "btn", type: "button", text: "People & 2-step" });
    bPeople.addEventListener("click", function () { dTab("people"); });
    wrap.appendChild(el("div", { cls: "card" }, [el("h2", { text: "Quick actions" }), el("div", { cls: "bigact" }, [bName, bPlan, bPeople])]));
    wrap.appendChild(el("div", { cls: "card" }, [el("h2", { text: "Contact" }), kvList([
      ["Primary contact", acc.primary_contact_name], ["E-mail", acc.primary_contact_email || d.owner_email], ["Phone", acc.primary_contact_phone],
      ["Billing e-mail", acc.billing_contact_email], ["Place", [acc.city, acc.state, acc.country].filter(Boolean).join(", ")],
      ["Legal name", acc.legal_business_name], ["GSTIN", acc.gstin], ["Website", acc.website]])]));

    // account profile (business account data only)
    var more = el("details", { cls: "more" }, [el("summary", { text: "Edit business details" })]);
    var AF = [["legal_business_name", "Legal name"], ["gstin", "GSTIN"], ["country", "Country (ISO-2)"], ["state", "State"], ["city", "City"],
      ["billing_address", "Billing address"], ["website", "Website"], ["timezone", "Timezone"], ["primary_contact_name", "Primary contact"],
      ["primary_contact_email", "Primary e-mail"], ["primary_contact_phone", "Primary phone"], ["secondary_contact_name", "Secondary contact"],
      ["secondary_contact_email", "Secondary e-mail"], ["secondary_contact_phone", "Secondary phone"], ["billing_contact_email", "Billing e-mail"],
      ["team_size_band", "Team size (1, 2-5, 6-15, 16-50, 51+)"], ["signup_source", "Signup source"],
      ["business_type", "Business type"], ["is_business", "Business (true/false)"], ["tax_id_type", "Tax ID type"], ["tax_id", "Tax ID"], ["pan", "PAN (India)"],
      ["billing_currency", "Billing currency"], ["payment_mandate_ref", "Mandate reference"], ["referral_code", "Referral code"], ["referred_by", "Referred by"]];
    var inputs = {};
    var af = el("div", { cls: "form" });
    AF.forEach(function (f) { var i = el("input", { type: /_phone$/.test(f[0]) ? "tel" : (/_email$/.test(f[0]) ? "email" : "text") }); i.value = acc[f[0]] == null ? "" : String(acc[f[0]]); inputs[f[0]] = i; af.appendChild(field(f[1], i)); });
    var asave = el("button", { cls: "btn primary", type: "button", text: "Save business details" });
    asave.addEventListener("click", function () {
      var patch = {}; AF.forEach(function (f) { var v = String(inputs[f[0]].value || "").trim(); if (v !== (acc[f[0]] == null ? "" : String(acc[f[0]]))) patch[f[0]] = v; });
      call("hq_set_studio_account", { p_org: org, p_account: patch }).then(function () { okMsg("Business details saved."); refreshAfterWrite(org); }).catch(showErr);
    });
    af.appendChild(asave); more.appendChild(af); wrap.appendChild(more);

    // ---- Plan & billing: subscription, suspend, activate, free trial, payments
    wrap = panes.plan;
    var subCard = el("div", { cls: "card" }); wrap.appendChild(subCard);
    subCard.appendChild(el("h2", { text: "Subscription" }));
    subCard.appendChild(el("div", null, [statusPill(sub.status || d.status), " ", (sub.plan_name || "No plan"),
      sub.price_monthly != null ? " · " + money(sub.price_monthly, sub.currency) + "/month" : "",
      sub.current_period_end ? " · period ends " + date(sub.current_period_end) : "",
      // L9: replaced by the studio-zone day once hq_trial_info answers (loadTrialInfo)
      sub.trial_ends_at ? el("span", { id: "subTrialEnd", text: " · trial ends " + date(sub.trial_ends_at) }) : ""]));
    if (sub.status === "suspended") subCard.appendChild(el("div", { cls: "muted", text: "Suspended " + date(sub.suspended_at) + " — " + (sub.suspend_reason || "") }));
    var selPlan = el("select", { "aria-label": "Plan" }); selPlan.appendChild(el("option", { value: "", text: "(keep plan)" }));
    plans.filter(function (p) { return p.active; }).forEach(function (p) { selPlan.appendChild(el("option", { value: p.code, text: p.name + " · " + money(p.price_monthly, p.currency) })); });
    var selSt = el("select", { "aria-label": "Status" });
    [["", "(keep status)"], ["trial", "trial"], ["active", "active"], ["past_due", "past due"], ["cancelled", "cancelled"]].forEach(function (o) { selSt.appendChild(el("option", { value: o[0], text: o[1] })); });
    var ps = el("input", { type: "date" }), pe = el("input", { type: "date" }), te = el("input", { type: "date" });
    var save = el("button", { cls: "btn", type: "button", text: "Save subscription" });
    save.addEventListener("click", function () {
      save.disabled = true;
      call("hq_set_subscription", { p_org: org, p_plan_code: selPlan.value || null, p_status: selSt.value || null, p_trial_ends_at: te.value || null,
        p_period_start: ps.value || null, p_period_end: pe.value || null, p_notes: null })
        .then(function () { okMsg("Subscription saved."); refreshAfterWrite(org); }).catch(showErr).then(function () { save.disabled = false; });
    });
    var adv = el("details", { cls: "more" }, [el("summary", { text: "Change plan or status by hand" }),
      el("div", { cls: "form" }, [field("Plan", selPlan), field("Status", selSt), field("Period start", ps), field("Period end", pe), field("Trial ends", te), save])]);
    subCard.appendChild(adv);
    var sus = el("button", { cls: "btn " + (sub.status === "suspended" ? "primary" : "danger"), type: "button", text: sub.status === "suspended" ? "Reactivate studio" : "Suspend (read-only)…" });
    sus.addEventListener("click", function () {
      if (sub.status === "suspended") {
        if (!window.confirm("Reactivate " + (d.name || "this studio") + "? Members can create and change data again.")) return;
        call("hq_reactivate_studio", { p_org: org }).then(function () { okMsg("Studio reactivated."); refreshAfterWrite(org); }).catch(showErr);
      } else {
        var why = ask("Suspend " + (d.name || "this studio") + "? Members can still sign in, view and export, but cannot create, change or delete anything. No data is touched. Reason:");
        if (!why) return;
        call("hq_suspend_studio", { p_org: org, p_reason: why }).then(function () { okMsg("Studio suspended (read-only)."); refreshAfterWrite(org); }).catch(showErr);
      }
    });
    subCard.appendChild(el("div", { cls: "actions" }, [sus]));

    // r21 (0244): ONE step from trial (or ended trial) to a paying studio
    if (sub.status !== "suspended") wrap.appendChild(activateBox(org, d.name, sub));

    // 0186: free trial — one extension per studio (1–7 days, reason required)
    var trialCard = el("div", { cls: "card" }, [el("h2", { text: "Free trial" })]); wrap.appendChild(trialCard);
    var trialBox = el("div", { id: "trialExt" }); trialCard.appendChild(trialBox);
    loadTrialInfo(org, d.name, trialBox).catch(function () {
      clear(trialBox).appendChild(el("div", { cls: "muted", text: "Trial details appear after migration 0186 is applied." }));
    });

    // payments
    var payCard = el("div", { cls: "card" }, [el("h2", { text: "Payments to Helm" })]); wrap.appendChild(payCard);
    var pt = el("tbody"); paymentRows(pt, d.payments, false);
    payCard.appendChild(el("div", { cls: "scroll" }, [el("table", null, [el("thead", null, [el("tr", null, ["Paid on", "Invoice", "Method", "Period", "Amount", "Status", ""].map(function (h) { return el("th", { text: h }); }))]), pt])]));
    var rec = el("button", { cls: "btn", type: "button", text: "Record a payment for this studio" });
    rec.addEventListener("click", function () { closeDrawer(); showTab("billing"); $("#rOrg").value = org; $("#rOrgName").textContent = d.name || ""; });
    payCard.appendChild(el("div", { cls: "actions" }, [rec]));

    // ---- People (no phone, no client data)
    wrap = panes.people;
    var mt = el("tbody");
    (d.members || []).forEach(function (m) {
      mt.appendChild(el("tr", null, [el("td", { text: m.display_name || "—" }), el("td", { cls: "m", text: m.email || "—" }), el("td", { text: m.role || "—" }),
        el("td", null, [el("span", { cls: "pill " + (m.active ? "ok" : "bad"), text: m.active ? "active" : "inactive" })]),
        el("td", { text: ago(m.last_sign_in_at) }), el("td", null, mfaCell(m.email, m.mfa_enabled, function () { refreshAfterWrite(org); }))]));
    });
    if (!mt.firstChild) mt.appendChild(el("tr", null, [el("td", { colspan: "6", cls: "empty", text: "Nobody yet." })]));
    wrap.appendChild(el("div", { cls: "card" }, [el("h2", { text: "People" }),
      el("p", { cls: "hint", text: "Reset two-step only after you have confirmed who is asking (lost phone)." }),
      el("div", { cls: "scroll" }, [el("table", null, [el("thead", null, [el("tr", null, ["Name", "E-mail", "Role", "Status", "Last sign-in", "2-step"].map(function (h) { return el("th", { text: h }); }))]), mt])])]));

    // ---- Name & link: r23 (0257) studio name + link are fixed for the studio; only Helm HQ changes them (two-step,
    // reason, audited, studio admins told by bell + e-mail, the old link keeps working)
    wrap = panes.ident;
    wrap.appendChild(identityBox(org, d));

    // ---- Activity: numbers only + what HQ changed on this studio
    wrap = panes.activity;
    var actBox = el("div"); wrap.appendChild(actBox);
    loadUsage(org, actBox, d).catch(function () { clear(actBox).appendChild(el("div", { cls: "card" }, [el("div", { cls: "empty", text: "Activity appears after SQL 0272 is applied." })])); });

    dTab(tab || curDTab || "overview");
    openDrawer();
  }
  var ACTION_WORDS = { "hq.studio.suspend": "Suspended", "hq.studio.reactivate": "Reactivated", "hq.studio.identity": "Name / link changed",
    "hq.subscription.set": "Subscription changed", "hq.subscription.activate": "Plan activated", "hq.payment.record": "Payment recorded",
    "hq.payment.void": "Payment voided", "hq.trial.extend": "Trial extended", "hq.studio_account.set": "Business details saved", "hq.mfa.reset": "Two-step reset" };
  async function loadUsage(org, box, d) {
    var u = await call("hq_studio_usage", { p_org: org }); u = u && !Array.isArray(u) ? u : {};
    clear(box);
    box.appendChild(el("div", { cls: "facts" }, [fact("People", int(u.people)), fact("Signed in (7 days)", int(u.people_active_7d)),
      fact("Signed in (30 days)", int(u.people_active_30d)), fact("Last sign-in", ago(u.last_sign_in)),
      fact("Payments to Helm", int(u.payments_to_helm)), fact("Last payment", date(u.last_payment_on))]));
    var ul = el("ul", { cls: "list" });
    (u.hq_changes || []).forEach(function (x) {
      ul.appendChild(el("li", null, [el("span", { cls: "m", text: ACTION_WORDS[x.action] || String(x.action || "").replace(/^hq\./, "").replace(/[._]/g, " ") }),
        el("span", { cls: "muted", text: ist(x.at) + (x.actor_email ? " · " + x.actor_email : "") })]));
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "Helm HQ hasn’t changed anything on this studio." }));
    box.appendChild(el("div", { cls: "card" }, [el("h2", { text: "Changes made by Helm HQ" }), ul]));
    box.appendChild(el("p", { cls: "muted", text: "Helm HQ never sees a studio’s clients, quotes or prices — only these numbers." }));
  }

  /* ---------------- r23 (0257) "Change studio name / link" (Helm HQ only) ---------------- */
  function identityBox(org, d) {
    var box = el("div", { cls: "card hq-ident" });
    box.appendChild(el("h2", { text: "Change studio name & link" }));
    box.appendChild(el("div", { cls: "muted", text: "Studios can't change these themselves. Change them only when the studio asks (confirm who is asking). Old links keep working; the studio's admins get a bell notice and an e-mail." }));
    var nm = el("input", { type: "text", maxlength: "120", "aria-label": "Studio name" }); nm.value = d.name || "";
    var sl = el("input", { type: "text", maxlength: "40", spellcheck: "false", autocomplete: "off", "aria-label": "Studio link" }); sl.value = d.slug || "";
    var why = el("input", { type: "text", maxlength: "500", "aria-label": "Reason", placeholder: "Who asked, and how you confirmed it (10+ characters)" });
    var avail = el("div", { cls: "muted", "aria-live": "polite" });
    var seq = 0, tmr = null;
    var paint = function () {
      var v = String(sl.value || "").trim().toLowerCase(); var my = ++seq; clearTimeout(tmr);
      if (!v || v === d.slug) { avail.textContent = v ? "helm.events/" + v + " (current link)" : ""; return; }
      avail.textContent = "helm.events/" + v + " - checking...";
      tmr = setTimeout(function () {
        call("hq_studio_link_check", { p_org: org, p_slug: v }).then(function (r) {
          if (my !== seq || !r) return;
          avail.textContent = "helm.events/" + v + " - " + (r.ok ? (r.previous ? "available (an earlier link of this studio)" : "available")
            : r.reason === "taken" ? "used by another studio, or looks like one" : r.reason === "reserved" ? "reserved (a Helm word or look-alike)" : "3-40 lowercase letters, numbers or single dashes");
        }).catch(function () { if (my === seq) avail.textContent = ""; });
      }, 350);
    };
    sl.addEventListener("input", function () { var c = String(sl.value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-"); if (c !== sl.value) sl.value = c; paint(); });
    var go = el("button", { cls: "btn primary", type: "button", text: "Change studio name & link" });
    go.addEventListener("click", function () {
      var n = String(nm.value || "").trim(), l = String(sl.value || "").trim().toLowerCase().replace(/-+$/, ""), r = String(why.value || "").trim();
      if (n === (d.name || "") && l === (d.slug || "")) { showErr({ message: "Nothing to change." }); return; }
      if (r.length < 10) { showErr({ message: "Give a reason of at least 10 characters." }); why.focus(); return; }
      var lines = [];
      if (n !== (d.name || "")) lines.push("Name: " + (d.name || "-") + " -> " + n);
      if (l !== (d.slug || "")) lines.push("Link: helm.events/" + (d.slug || "-") + " -> helm.events/" + l + " (old links keep working)");
      if (!window.confirm("Change this studio?\n\n" + lines.join("\n") + "\n\nThe studio's admins are told by bell and e-mail.")) return;
      go.disabled = true;
      call("hq_set_studio_identity", { p_org: org, p_name: n !== (d.name || "") ? n : null, p_slug: l !== (d.slug || "") ? l : null, p_reason: r })
        .then(function () { okMsg("Studio name / link changed."); refreshAfterWrite(org); }).catch(showErr).then(function () { go.disabled = false; });
    });
    box.appendChild(el("div", { cls: "form" }, [field("Studio name", nm), field("Studio link (helm.events/...)", sl), el("label", { cls: "fld wide" }, [el("span", { text: "Reason" }), why]), go]));
    box.appendChild(avail);
    return box;
  }

  /* ---------------- r21 (0244) "Activate plan" ----------------
     Records the payment (numbered GST invoice), sets the plan ACTIVE with plan, billing and period and lifts the
     trial caps / read-only - one server step (hq_activate_plan), audit-logged. The studio admin is then asked
     once what happens to the sample data (keep / remove sample / start clean). */
  // pure: the last day of a period that starts on start (inclusive) - mirrors public._sub_period_end
  function periodEnd(start, interval) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(start || "")); if (!m) return "";
    var y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (interval === "yearly") y += 1; else mo += 1;
    var last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();   // Postgres date + interval clamps to the month end
    var e = new Date(Date.UTC(y, mo, Math.min(d, last)) - 864e5);
    return e.toISOString().slice(0, 10);
  }
  // pure: validated args for hq_activate_plan (exported for tests). The database checks the same.
  function activateArgs(org, plan, interval, amount, method, start, paidOn, ref) {
    var a = Number(amount), r = String(ref == null ? "" : ref).replace(/\s+/g, " ").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(org || ""))) throw new Error("Open a studio first");
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(String(plan || ""))) throw new Error("Choose the plan");
    if (interval !== "monthly" && interval !== "yearly") throw new Error("Choose monthly or yearly");
    if (!(a > 0) || a > 100000000) throw new Error("Amount (incl. tax) must be more than 0");
    if (["upi", "bank", "cash", "card", "other"].indexOf(method) < 0) throw new Error("Choose how they paid");
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("Period start must be a date");
    if (paidOn && !/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new Error("Paid on must be a date");
    if (r.length > 120) throw new Error("Reference: up to 120 characters");
    return { p_org: org, p_plan_code: plan, p_interval: interval, p_amount: Math.round(a * 100) / 100, p_method: method,
      p_period_start: start || null, p_paid_on: paidOn || null, p_reference: r || null, p_currency: "INR", p_fx_rate_to_inr: null };
  }
  function activateBox(org, name, sub) {
    var box = el("div", { id: "activatePlan", cls: "card" });
    box.appendChild(el("h2", { text: "Activate plan" }));
    box.appendChild(el("div", { cls: "muted", text: "When the studio has paid (UPI / bank transfer): records the payment with a GST invoice, makes the plan active for the period and lifts the trial limits and read-only - in one step. The studio admin then chooses what happens to the sample data." }));
    var selPlan = el("select", { "aria-label": "Plan to activate" });
    plans.filter(function (p) { return p.active; }).forEach(function (p) {
      var o = el("option", { value: p.code, text: p.name + " · " + money(p.price_monthly, p.currency) + "/month" });
      if (sub.plan_code === p.code || sub.plan_name === p.name) o.selected = true;
      selPlan.appendChild(o);
    });
    var selIv = el("select", { "aria-label": "Billing" });
    [["monthly", "Monthly"], ["yearly", "Yearly"]].forEach(function (o) { selIv.appendChild(el("option", { value: o[0], text: o[1] })); });
    var amt = el("input", { type: "number", min: "1", step: "0.01", "aria-label": "Amount paid incl. tax" });
    var meth = el("select", { "aria-label": "Paid by" });
    [["upi", "UPI"], ["bank", "Bank transfer"], ["card", "Card"], ["cash", "Cash"], ["other", "Other"]].forEach(function (o) { meth.appendChild(el("option", { value: o[0], text: o[1] })); });
    var today = iso(new Date());
    var start = el("input", { type: "date", "aria-label": "Period start" }); start.value = today;
    var paid = el("input", { type: "date", "aria-label": "Paid on" }); paid.value = today;
    var ref = el("input", { type: "text", maxlength: "120", placeholder: "UTR / reference", "aria-label": "Payment reference" });
    var endTxt = el("div", { cls: "muted" });
    var showEnd = function () { var e = periodEnd(start.value, selIv.value); endTxt.textContent = e ? "Plan period: " + date(start.value) + " – " + date(e) : ""; };
    selIv.addEventListener("change", showEnd); start.addEventListener("change", showEnd); showEnd();
    var go = el("button", { cls: "btn primary", type: "button", text: "Activate plan…" });
    if (!selPlan.options.length) { go.disabled = true; endTxt.textContent = "Add an active plan in Plans first."; }
    go.addEventListener("click", function () {
      var a; try { a = activateArgs(org, selPlan.value, selIv.value, amt.value, meth.value, start.value, paid.value, ref.value); } catch (e) { showErr(e); return; }
      var pe = periodEnd(a.p_period_start || today, a.p_interval);
      if (!window.confirm("Activate " + (selPlan.options[selPlan.selectedIndex] ? selPlan.options[selPlan.selectedIndex].text.split(" · ")[0] : a.p_plan_code) +
        " (" + a.p_interval + ") for " + (name || "this studio") + "?\n\nPayment " + money(a.p_amount) + " by " + a.p_method + (a.p_reference ? " (" + a.p_reference + ")" : "") +
        "\nPeriod " + date(a.p_period_start || today) + " – " + date(pe) + "\n\nThis records the payment with a GST invoice and makes the plan active now.")) return;
      go.disabled = true;
      call("hq_activate_plan", a).then(function (r) {
        var inv = r && r.payment && r.payment.invoice_no;
        okMsg((r && r.result === "replay" ? "Already activated with this payment" : "Plan activated") + (inv ? " — invoice " + inv : "") + ".");
        amt.value = ""; ref.value = ""; refreshAfterWrite(org);
      }).catch(showErr).then(function () { go.disabled = false; });
    });
    box.appendChild(el("div", { cls: "form" }, [field("Plan", selPlan), field("Billing", selIv), field("Amount paid (incl. tax)", amt),
      field("Paid by", meth), field("Paid on", paid), field("Period start", start), field("Reference (UTR)", ref), go]));
    box.appendChild(endTxt);
    return box;
  }

  /* ---------------- r25: Requests = one inbox with tabs; click a row to read it, reply by e-mail, mark it ---------------- */
  var RTABS = ["plan", "sales", "sugg", "alerts"];
  function reqTab(name) {
    RTABS.forEach(function (t) {
      var b = $("#rt-" + t), p = $("#rp-" + t);
      if (b) b.setAttribute("aria-selected", t === name ? "true" : "false");
      if (p) p.hidden = t !== name;
    });
  }
  var REQ_NEW = { plan: 0, sales: 0, sugg: 0 }, ALERT_TO = "";
  function paintReqCounts() {
    $("#rcPlan").textContent = int(REQ_NEW.plan); $("#rcSales").textContent = int(REQ_NEW.sales); $("#rcSugg").textContent = int(REQ_NEW.sugg);
    var k = clear($("#reqCards"));
    k.appendChild(kpi("New plan requests", int(REQ_NEW.plan), "from studios on a trial", REQ_NEW.plan ? "warn" : "", function () { reqTab("plan"); }));
    k.appendChild(kpi("New sales enquiries", int(REQ_NEW.sales), "from the Contact sales form", REQ_NEW.sales ? "warn" : "", function () { reqTab("sales"); }));
    k.appendChild(kpi("New suggestions", int(REQ_NEW.sugg), "from the app and the website", REQ_NEW.sugg ? "warn" : "", function () { reqTab("sugg"); }));
    k.appendChild(kpi("Alerts go to", ALERT_TO || "—", "change in E-mail alerts", "mail", function () { reqTab("alerts"); }));
    var nb = $("#navReqCount"), n = REQ_NEW.plan + REQ_NEW.sales + REQ_NEW.sugg;
    if (nb) { nb.textContent = n > 99 ? "99+" : String(n); nb.hidden = !(n > 0); }
  }
  // pure: a safe "Reply by email" link (only a plain address; subject + greeting encoded) - exported for tests
  function mailtoHref(email, subject, name) {
    var e = String(email || "").trim();
    if (!/^[^\s@<>",;:?&]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(e)) return null;
    var body = "Hi " + (String(name || "").trim().split(/\s+/)[0] || "there") + ",\n\n";
    return "mailto:" + e + "?subject=" + encodeURIComponent(subject || "Helm") + "&body=" + encodeURIComponent(body);
  }
  // click a row: a detail row opens under it (one at a time); build(td) fills it
  function rowWithDetail(tb, tr, cols, build) {
    tr.classList.add("click"); tr.setAttribute("tabindex", "0"); tr.setAttribute("aria-expanded", "false");
    var toggle = function (e) {
      if (e && e.target && e.target.closest && e.target.closest("button, a, select, input")) return;
      var next = tr.nextSibling, isOpen = next && next.classList && next.classList.contains("rowdetail");
      Array.prototype.slice.call(tb.querySelectorAll("tr.rowdetail")).forEach(function (r) { r.remove(); });
      Array.prototype.slice.call(tb.querySelectorAll("tr.open")).forEach(function (r) { r.classList.remove("open"); r.setAttribute("aria-expanded", "false"); });
      if (isOpen) return;
      var td = el("td", { colspan: String(cols) }), dr = el("tr", { cls: "rowdetail" }, [td]);
      build(td); tr.parentNode.insertBefore(dr, tr.nextSibling); tr.classList.add("open"); tr.setAttribute("aria-expanded", "true");
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", function (e) { if (e.key === "Enter") toggle(); });
    tb.appendChild(tr);
  }
  function noteBlock(x) {
    var ul = el("ul", { cls: "notes" });
    if (x.hq_note) ul.appendChild(el("li", null, [el("b", { text: "Note: " }), x.hq_note, x.handled_at ? el("span", { cls: "muted", text: " · " + ist(x.handled_at) }) : null]));
    else ul.appendChild(el("li", { cls: "muted", text: "No note yet." }));
    return ul;
  }
  function detailBox(td, pairs, message, reply, actions) {
    td.appendChild(kvList(pairs));
    td.appendChild(el("div", { cls: "msgbox", text: message || "(no message)" }));
    var acts = el("div", { cls: "actions" });
    if (reply) acts.appendChild(el("a", { cls: "btn primary", href: reply, rel: "noopener", text: "Reply by email" }));
    (actions || []).forEach(function (a) { if (a) acts.appendChild(a); });
    td.appendChild(acts);
  }
  function msgCell(text) { return el("td", { cls: "msg" }, [el("div", { cls: "clip", text: text || "—" })]); }

  /* ---------------- r21 (0244) plan requests ("Contact sales") ---------------- */
  var REQ_STATUS = { new: ["New", "warn"], contacted: ["Contacted", ""], won: ["Won", "ok"], lost: ["Lost", "bad"] };
  async function loadRequests() {
    var r = await call("hq_sales_requests", { p_status: $("#fReq").value || null }); r = r && !Array.isArray(r) ? r : {};
    var c = r.counts || {};
    REQ_NEW.plan = num(c.new); paintReqCounts();
    $("#reqCounts").textContent = ["new", "contacted", "won", "lost"].map(function (k) { return REQ_STATUS[k][0] + ": " + int(c[k] || 0); }).join(" · ");
    var tb = clear($("#tReq"));
    (Array.isArray(r.rows) ? r.rows : []).forEach(function (x) {
      var st = REQ_STATUS[x.status] || [x.status || "—", ""];
      var tr = el("tr", null, [
        el("td", { text: ist(x.created_at) }),
        el("td", null, [el("strong", { text: x.studio || x.studio_name || "—" }), el("div", { cls: "muted",
          text: [x.subscription_status ? "now: " + String(x.subscription_status).replace("_", " ") : "", x.source === "read_only_banner" ? "from read-only banner" : "from plan page"].filter(Boolean).join(" · ") })]),
        el("td", null, [x.contact_name || "—", el("div", { cls: "muted", text: [x.contact_email, x.contact_phone].filter(Boolean).join(" · ") })]),
        el("td", { text: (x.plan_name || x.plan_code || "—") + " · " + (x.billing_interval === "yearly" ? "Yearly" : "Monthly") }),
        msgCell(x.message),
        el("td", null, [el("span", { cls: "pill " + st[1], text: st[0] })])]);
      rowWithDetail(tb, tr, 6, function (td) {
        var acts = [];
        ["contacted", "won", "lost"].filter(function (k) { return k !== x.status; }).forEach(function (k) {
          var b = el("button", { cls: "btn", type: "button", text: "Mark " + REQ_STATUS[k][0].toLowerCase() });
          b.addEventListener("click", function () {
            var note = ask("Mark this request " + REQ_STATUS[k][0].toLowerCase() + ". Note (optional):", x.hq_note || "");
            if (note == null) return;
            call("hq_set_sales_request_status", { p_id: x.id, p_status: k, p_note: note || null })
              .then(function () { okMsg("Request marked " + REQ_STATUS[k][0].toLowerCase() + "."); loadRequests().catch(showErr); }).catch(showErr);
          });
          acts.push(b);
        });
        if (x.org_id) {
          var o = el("button", { cls: "btn", type: "button", text: "Open studio" });
          o.addEventListener("click", function () { openStudio(x.org_id, "plan"); });
          acts.push(o);
        }
        detailBox(td, [["Studio", x.studio || x.studio_name], ["Contact", x.contact_name], ["E-mail", x.contact_email], ["Phone", x.contact_phone],
          ["Plan", (x.plan_name || x.plan_code || "—") + " · " + (x.billing_interval === "yearly" ? "Yearly" : "Monthly")], ["Sent", ist(x.created_at)]],
          x.message, mailtoHref(x.contact_email, "Your Helm plan request", x.contact_name), acts);
        td.appendChild(noteBlock(x));
      });
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "6", cls: "empty", text: "No requests here." })]));
  }

  /* ---------------- r24 (0271) sales enquiries + suggestions + their e-mail settings ---------------- */
  var SE_STATUS = { new: ["New", "warn"], contacted: ["Contacted", ""], won: ["Won", "ok"], lost: ["Lost", "bad"] };
  var SG_STATUS = { new: ["New", "warn"], reviewed: ["Reviewed", ""], done: ["Done", "ok"] };
  var SE_PLAN = { starter: "Starter", studio: "Studio", enterprise: "Enterprise", not_sure: "Not sure yet" };
  var SE_TEAM = { "1": "Just me", "2-5": "2–5 people", "6-15": "6–15 people", "16-50": "16–50 people", "51+": "51+ people" };
  var SG_KIND = { idea: "Idea", problem: "Problem", other: "Other" };
  function ist(v) { return v ? new Date(v).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }) + " IST" : "—"; }
  // status buttons + "Note" for one row; fn = the HQ RPC, map = the statuses
  function rowActions(x, map, fn, reload) {
    var out = [];
    Object.keys(map).filter(function (k) { return k !== "new" && k !== x.status; }).forEach(function (k) {
      var b = el("button", { cls: "btn", type: "button", text: "Mark " + map[k][0].toLowerCase() });
      b.addEventListener("click", function () {
        call(fn, { p_id: x.id, p_status: k, p_note: null })
          .then(function () { okMsg("Marked " + map[k][0].toLowerCase() + "."); reload().catch(showErr); }).catch(showErr);
      });
      out.push(b);
    });
    var n = el("button", { cls: "btn", type: "button", text: x.hq_note ? "Edit note" : "Add note" });
    n.addEventListener("click", function () {
      var note = ask("Note (leave empty to remove it):", x.hq_note || "");
      if (note == null) return;
      call(fn, { p_id: x.id, p_status: null, p_note: note }).then(function () { okMsg("Note saved."); reload().catch(showErr); }).catch(showErr);
    });
    out.push(n);
    return out;
  }
  function statusCell(x, map) {
    var st = map[x.status] || [x.status || "—", ""];
    return el("td", null, [el("span", { cls: "pill " + st[1], text: st[0] }), x.hq_note ? el("div", { cls: "muted", text: "note added" }) : null]);
  }
  async function loadSales() {
    var r = await call("hq_sales_enquiries", { p_status: $("#fSe").value || null }); r = r && !Array.isArray(r) ? r : {};
    var c = r.counts || {};
    REQ_NEW.sales = num(c.new);
    $("#seCounts").textContent = Object.keys(SE_STATUS).map(function (k) { return SE_STATUS[k][0] + ": " + int(c[k] || 0); }).join(" · ");
    var s = r.settings || {};
    if (s.notify_email != null) { $("#seEmail").value = s.notify_email; $("#seAck").checked = !!s.auto_reply; $("#seOpen").checked = !!s.form_open; ALERT_TO = s.notify_email; }
    paintReqCounts();
    var tb = clear($("#tSe"));
    (Array.isArray(r.rows) ? r.rows : []).forEach(function (x) {
      var det = [SE_PLAN[x.plan] ? "Plan: " + SE_PLAN[x.plan] : "", SE_TEAM[x.team_size] ? "Team: " + SE_TEAM[x.team_size] : "", x.events_per_year ? "Events / year: " + x.events_per_year : ""].filter(Boolean);
      var tr = el("tr", null, [
        el("td", { text: ist(x.created_at) }),
        el("td", null, [el("strong", { text: x.company || "—" }), el("div", { cls: "muted", text: [x.city, x.source === "home" ? "from home page" : "from Contact sales"].filter(Boolean).join(" · ") })]),
        el("td", null, [x.name || "—", el("div", { cls: "muted", text: [x.email, x.phone].filter(Boolean).join(" · ") })]),
        el("td", { text: det.join(" · ") || "—" }),
        msgCell(x.message),
        statusCell(x, SE_STATUS)]);
      rowWithDetail(tb, tr, 6, function (td) {
        detailBox(td, [["Company", x.company], ["City", x.city], ["Name", x.name], ["E-mail", x.email], ["Phone", x.phone],
          ["Plan", SE_PLAN[x.plan]], ["Team", SE_TEAM[x.team_size]], ["Events / year", x.events_per_year], ["Sent", ist(x.created_at)]],
          x.message, mailtoHref(x.email, "Helm — your enquiry", x.name), rowActions(x, SE_STATUS, "hq_set_sales_enquiry", loadSales));
        td.appendChild(noteBlock(x));
      });
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "6", cls: "empty", text: "No sales enquiries here." })]));
  }
  async function loadSuggestions() {
    var r = await call("hq_suggestions", { p_status: $("#fSg").value || null }); r = r && !Array.isArray(r) ? r : {};
    var c = r.counts || {};
    REQ_NEW.sugg = num(c.new); paintReqCounts();
    $("#sgCounts").textContent = Object.keys(SG_STATUS).map(function (k) { return SG_STATUS[k][0] + ": " + int(c[k] || 0); }).join(" · ");
    var tb = clear($("#tSg"));
    (Array.isArray(r.rows) ? r.rows : []).forEach(function (x) {
      var who = x.who || (x.source === "app" ? "A Helm user" : "A visitor");
      var tr = el("tr", null, [
        el("td", { text: ist(x.created_at) }),
        el("td", null, [who, el("div", { cls: "muted", text: [x.studio, x.email, x.source === "app" ? "in the app" + (x.page ? " (" + x.page + ")" : "") : "website"].filter(Boolean).join(" · ") })]),
        el("td", { text: SG_KIND[x.category] || "—" }),
        msgCell(x.message),
        statusCell(x, SG_STATUS)]);
      rowWithDetail(tb, tr, 5, function (td) {
        detailBox(td, [["From", who], ["Studio", x.studio], ["E-mail", x.email], ["Kind", SG_KIND[x.category]],
          ["Where", x.source === "app" ? "in the app" + (x.page ? " (" + x.page + ")" : "") : "website"], ["Sent", ist(x.created_at)]],
          x.message, mailtoHref(x.email, "Thanks for your Helm suggestion", x.who), rowActions(x, SG_STATUS, "hq_set_suggestion", loadSuggestions));
        td.appendChild(noteBlock(x));
      });
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "No suggestions here." })]));
  }
  function saveSalesSettings() {
    var em = $("#seEmail").value.trim();
    if (!/^[^\s@<>",;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(em)) { showErr(new Error("Enter a valid e-mail address")); return; }
    call("hq_set_sales_enquiry_settings", { p_notify_email: em, p_auto_reply: $("#seAck").checked, p_form_open: $("#seOpen").checked })
      .then(function () { ALERT_TO = em; paintReqCounts(); okMsg("Saved. Alerts go to " + em + "."); }).catch(showErr);
  }
  function loadRequestsTab() { loadRequests().catch(showErr); loadSales().catch(showErr); loadSuggestions().catch(showErr); }

  /* ---------------- r25: search across studios + people (top bar) ---------------- */
  var gTimer = null, gSeq = 0;
  function closeSearch() { var r = $("#gResults"); if (r) { r.hidden = true; clear(r); } }
  function runSearch() {
    var q = String($("#gSearch").value || "").trim(), box = $("#gResults"), my = ++gSeq;
    if (q.length < 2) { closeSearch(); return; }
    Promise.all([call("hq_studios", { p_search: q, p_status: null, p_limit: 5, p_offset: 0 }).catch(function () { return []; }),
      call("hq_users", { p_search: q, p_limit: 5, p_offset: 0 }).catch(function () { return []; })]).then(function (r) {
      if (my !== gSeq) return;
      var st = Array.isArray(r[0]) ? r[0] : [], us = Array.isArray(r[1]) ? r[1] : [];
      clear(box);
      box.appendChild(el("h4", { text: "Studios" }));
      st.forEach(function (s) {
        var b = el("button", { type: "button" }, [el("span", null, [el("strong", { text: s.name || "—" }), s.slug ? el("span", { cls: "muted", text: "  helm.events/" + s.slug }) : null]), statusPill(s.status)]);
        b.addEventListener("click", function () { closeSearch(); openStudio(s.org_id); });
        box.appendChild(b);
      });
      if (!st.length) box.appendChild(el("div", { cls: "empty", text: "  No studio matches." }));
      box.appendChild(el("h4", { text: "People" }));
      us.forEach(function (u) {
        var b = el("button", { type: "button" }, [el("span", { cls: "m", text: u.email || "—" }), el("span", { cls: "muted", text: [u.studio, u.role].filter(Boolean).join(" · ") })]);
        b.addEventListener("click", function () { closeSearch(); showTab("people"); $("#qUsers").value = u.email || ""; loadUsers(0).catch(showErr); });
        box.appendChild(b);
      });
      if (!us.length) box.appendChild(el("div", { cls: "empty", text: "  Nobody matches." }));
      box.hidden = false;
    });
  }

  /* ---------------- 0186 free-trial extension ---------------- */
  // pure: validated args for hq_extend_trial (exported for tests). The database checks the same.
  function trialExtendArgs(org, days, reason) {
    var d = Number(days), r = String(reason == null ? "" : reason).replace(/\s+/g, " ").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(org || ""))) throw new Error("Open a studio first");
    if (!(d >= 1 && d <= 7) || Math.floor(d) !== d) throw new Error("An extension is 1 to 7 days");
    if (r.length < 5) throw new Error("Write the reason for the extension (at least 5 characters)");
    if (r.length > 500) throw new Error("The reason can be up to 500 characters");
    return { p_org: org, p_days: d, p_reason: r };
  }
  async function loadTrialInfo(org, name, box) {
    var t = await call("hq_trial_info", { p_org: org }); t = t && !Array.isArray(t) ? t : {};
    clear(box);
    var x = t.extension || null, ended = t.trial_ends_at && new Date(t.trial_ends_at).getTime() <= Date.now(), tz = t.timezone || null;
    var subEnd = document.getElementById("subTrialEnd");
    if (subEnd && t.trial_ends_at) subEnd.textContent = " · trial ends " + trialDay(t.trial_ends_at, tz);
    box.appendChild(el("div", null, [statusPill(t.status || "none"), " ",
      t.trial_ends_at ? (ended ? "trial ended " : "trial ends ") + trialDay(t.trial_ends_at, tz) : "no trial end date",
      t.locked ? " · read-only" : "", t.trial_mode ? " · " + (t.trial_mode === "demo" ? "sample data" : "own data") : ""]));
    if (x) {
      box.appendChild(el("div", { cls: "muted", text: "Extended once by " + int(x.days) + " day" + (num(x.days) === 1 ? "" : "s") +
        " on " + date(x.granted_at) + (x.granted_by_email ? " by " + x.granted_by_email : "") + " (" + trialDay(x.previous_ends_at, tz) + " → " + trialDay(x.new_ends_at, tz) + ")." }));
      box.appendChild(el("div", { cls: "muted", text: "Reason: " + (x.reason || "—") }));
      box.appendChild(el("div", { cls: "muted", text: "Only one extension is allowed per studio." }));
      return;
    }
    if (!t.can_extend) { box.appendChild(el("div", { cls: "muted", text: t.why_not || "This studio cannot get a trial extension." })); return; }
    var sel = el("select", { "aria-label": "Extra days" });
    for (var i = 1; i <= 7; i++) { var o = el("option", { value: String(i), text: i + " day" + (i === 1 ? "" : "s") }); if (i === 7) o.selected = true; sel.appendChild(o); }
    var why = el("input", { type: "text", maxlength: "500", placeholder: "Why? e.g. customer asked for more time to evaluate", "aria-label": "Reason for the extension" });
    var go = el("button", { cls: "btn primary", type: "button", text: "Extend trial…" });
    go.addEventListener("click", function () {
      var a; try { a = trialExtendArgs(org, sel.value, why.value); } catch (e) { showErr(e); return; }
      if (!window.confirm("Extend the free trial of " + (name || "this studio") + " by " + a.p_days + " day" + (a.p_days === 1 ? "" : "s") +
        "? This can be done only ONCE for this studio, and the reason is kept in the HQ log.")) return;
      go.disabled = true;
      call("hq_extend_trial", a).then(function (r) { okMsg("Trial extended" + (r && r.new_ends_at ? " to " + date(r.new_ends_at) : "") + "."); refreshAfterWrite(org); })
        .catch(showErr).then(function () { go.disabled = false; });
    });
    box.appendChild(el("div", { cls: "muted", text: "One-time extension (up to 7 days). It starts from the current trial end, or from today if the trial has already ended." }));
    box.appendChild(el("div", { cls: "form" }, [field("Extra days", sel), field("Reason (required)", why), go]));
  }

  /* ---------------- r22 (0253): lost phone -> Helm-assisted two-step reset ----------------
     The database decides (hq_mfa_reset): HQ operator signed in WITH two-step (aal2), never your own account, a reason,
     at most 10 a day, audited (HQ Activity) + kept in an append-only log. The person's authenticator is marked
     unverified (never deleted); at their next sign-in Helm asks them to set it up again. */
  function mfaCell(email, on, after) {
    var kids = [el("span", { cls: "pill " + (on ? "ok" : ""), text: on ? "on" : "off" })];
    var me = (BPStore.auth.user() && BPStore.auth.user().email) || "";
    if (on && email && String(email).toLowerCase() !== String(me).toLowerCase()) {
      var b = el("button", { cls: "btn sm danger", type: "button", text: "Reset", title: "Reset two-step for " + email + " (lost phone)" });
      b.addEventListener("click", function () { resetMfa(email, b, after); });
      kids.push(" "); kids.push(b);
    }
    return kids;
  }
  function resetMfa(email, btn, after) {
    if (!window.confirm("Reset two-step verification for " + email + "?\n\nOnly do this after you have confirmed who they are (for example a call to the number you already have, or an e-mail from this address). Their next sign-in needs only their password or Google, and Helm then asks them to set two-step up again.")) return;
    var why = ask("Reason (kept in the HQ log) - how did you confirm who they are?", "");
    if (why == null) return;
    if (why.length < 10) { showErr(new Error("Give a reason of at least 10 characters.")); return; }
    var again = ask("Type the person's e-mail address to confirm:", "");
    if (again == null) return;
    if (again.toLowerCase() !== String(email).toLowerCase()) { showErr(new Error("The e-mail address didn't match - nothing was reset.")); return; }
    btn.disabled = true;
    call("hq_mfa_reset", { p_email: email, p_reason: why }).then(function (r) {
      okMsg((r && r.message) || "Two-step reset."); if (after) after();
    }).catch(showErr).then(function () { btn.disabled = false; });
  }

  /* ---------------- people ---------------- */
  async function loadUsers(off) {
    uOff = off || 0;
    var rows = await call("hq_users", { p_search: $("#qUsers").value || null, p_limit: PAGE, p_offset: uOff });
    var tb = clear($("#tUsers")); rows = Array.isArray(rows) ? rows : [];
    rows.forEach(function (r) {
      tb.appendChild(el("tr", null, [el("td", { cls: "m", text: r.email || "—" }), el("td", { text: r.studio || "—" }), el("td", { text: r.role || "—" }),
        el("td", { text: date(r.created_at) }), el("td", { text: ago(r.last_sign_in_at) }),
        el("td", null, [el("span", { cls: "pill " + (r.email_confirmed ? "ok" : "warn"), text: r.email_confirmed ? "yes" : "no" })]),
        el("td", null, mfaCell(r.email, r.mfa_enabled, function () { loadUsers(uOff).catch(showErr); }))]));
    });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "7", cls: "empty", text: "No users match." })]));
    pager($("#pUsers"), uOff, rows.length ? num(rows[0].total_count) : 0, function (o) { loadUsers(o).catch(showErr); });
  }

  /* ---------------- billing ---------------- */
  async function loadBilling() {
    var r = await call("hq_billing", { p_from: $("#bFrom").value || null, p_to: $("#bTo").value || null });
    r = r && !Array.isArray(r) ? r : {}; lastBilling = r;
    var k = clear($("#bKpis"));
    k.appendChild(kpi("Collected", moneyList(r.collected), int(r.payments_count) + " payments · " + int(r.voided_count) + " void"));
    k.appendChild(kpi("MRR", moneyList(r.mrr), "active + past-due"));
    k.appendChild(kpi("Past due", int((r.past_due || []).length), "studios", (r.past_due || []).length ? "warn" : ""));
    paymentRows(clear($("#tPay")), r.payments, true);
    var pd = clear($("#pastDue"));
    (r.past_due || []).forEach(function (x) { pd.appendChild(el("li", null, [el("span", { text: x.name || "—" }), el("span", { cls: "muted", text: (x.plan_code || "") + " · ended " + date(x.current_period_end) + " · " + int(x.days_overdue) + " days" })])); });
    if (!pd.firstChild) pd.appendChild(el("li", { cls: "empty", text: "No studio is past due." }));
    var rm = clear($("#reminders"));
    (r.reminders || []).slice(0, 30).forEach(function (x) { rm.appendChild(el("li", null, [el("span", { text: (x.studio || "—") + " · " + String(x.kind || "").replace("_", " ") }), el("span", { cls: "muted", text: "period " + date(x.period_end) + " · " + (x.sent_at ? "sent " + date(x.sent_at) + " (" + (x.channel || "") + ")" : "queued") })])); });
    if (!rm.firstChild) rm.appendChild(el("li", { cls: "empty", text: "No reminders." }));
    var ux = await call("hq_unrealised_exports"); ux = Array.isArray(ux) ? ux : [];
    var ul = clear($("#unrealised"));
    ux.forEach(function (p) {
      var b = el("button", { cls: "btn sm", type: "button", text: "Mark realised" });
      b.addEventListener("click", function () {
        var ref = ask("FIRA / FIRC reference for " + (p.invoice_no || "") + ":"); if (!ref) return;
        var on = ask("Realised on (YYYY-MM-DD):", iso(new Date())); if (!on) return;
        call("hq_record_realisation", { p_id: p.id, p_fira_firc_ref: ref, p_realised_on: on }).then(function () { okMsg("Realisation recorded."); loadBilling().catch(showErr); }).catch(showErr);
      });
      ul.appendChild(el("li", null, [el("span", { text: (p.studio || "—") + " · " + (p.invoice_no || "") + " · " + money(p.amount, p.currency) }), el("span", { cls: "muted", text: (p.tax_regime || "") + " · " + date(p.paid_on) }), b]));
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "Every export payment is realised." }));
  }
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;           // spreadsheet formula injection guard
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportCsv() {
    var r = lastBilling || {}, rows = [["paid_on", "studio", "invoice_no", "amount", "currency", "net_amount", "gst_amount", "method", "reference", "period_start", "period_end", "status", "void_reason"]];
    (r.payments || []).forEach(function (p) {
      rows.push([p.paid_on, p.studio, p.invoice_no, p.amount, p.currency, p.net_amount, p.gst_amount, p.method, p.reference, p.period_start, p.period_end, p.voided ? "void" : "paid", p.void_reason]);
    });
    var csv = rows.map(function (x) { return x.map(csvCell).join(","); }).join("\r\n");
    var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    var a = el("a", { href: url, download: "helm-billing-" + (r.from || "") + "-to-" + (r.to || "") + ".csv" });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function recordPayment() {
    var org = $("#rOrg").value;
    if (!org) { showErr(new Error("Open a studio (Studios tab) and choose “Record a payment”, or paste its id.")); return; }
    var amt = Number($("#rAmount").value);
    if (!(amt > 0)) { showErr(new Error("Amount must be more than 0")); return; }
    var b = $("#btnRecord"); b.disabled = true;
    call("hq_record_payment", { p_org: org, p_amount: amt, p_paid_on: $("#rPaidOn").value || iso(new Date()), p_method: $("#rMethod").value,
      p_currency: ($("#rCur").value || "INR").toUpperCase(), p_fx_rate_to_inr: $("#rFx").value ? Number($("#rFx").value) : null, p_period_start: $("#rPs").value || null, p_period_end: $("#rPe").value || null, p_reference: $("#rRef").value || null })
      .then(function (p) { okMsg("Payment recorded" + (p && p.invoice_no ? " — invoice " + p.invoice_no : "") + "."); $("#rAmount").value = ""; $("#rRef").value = ""; refreshAfterWrite(org); })
      .catch(showErr).then(function () { b.disabled = false; });
  }
  async function loadSettings() {
    var s = await call("hq_billing_settings"); s = s && !Array.isArray(s) ? s : {};
    $("#sName").value = s.legal_name || ""; $("#sGstin").value = s.gstin || ""; $("#sAddr").value = s.address || "";
    $("#sState").value = s.seller_state || ""; $("#sCountry").value = s.seller_country || "IN";
    $("#sLut").value = s.lut_number || ""; $("#sLutFrom").value = s.lut_valid_from || ""; $("#sLutTo").value = s.lut_valid_to || "";
    $("#sRate").value = s.gst_rate != null ? s.gst_rate : 18; $("#sPrefix").value = s.invoice_prefix != null ? s.invoice_prefix : "HELM-";
    showCheckoutSettings(s);
  }
  /* ---------------- 0056 studio checkout switches ---------------- */
  function showCheckoutSettings(s) {
    var has = s && Object.prototype.hasOwnProperty.call(s, "allow_trial_bypass");
    $("#coLive").checked = !!(s && s.online_payments_live); $("#coBypass").checked = !!(s && s.allow_trial_bypass);
    $("#coTermsV").value = (s && s.terms_version) || "";
    ["#coLive", "#coBypass", "#coTermsV", "#btnCheckout"].forEach(function (q) { $(q).disabled = !has; });
    $("#coState").textContent = !has ? "Checkout settings appear after migration 0056 is applied."
      : "Online payment: " + (s.online_payments_live ? "LIVE" : "off (free trial)") + " · Testing bypass: " + (s.allow_trial_bypass ? "ON — turn off before launch" : "off");
  }
  // pure: validated args for hq_set_checkout_settings (exported for tests)
  function checkoutSettingsArgs(live, bypass, terms) {
    var t = String(terms == null ? "" : terms).trim();
    if (t && !/^[A-Za-z0-9._-]{1,32}$/.test(t)) throw new Error("Terms version: letters, numbers, . _ - only (up to 32)");
    return { p_allow_trial_bypass: !!bypass, p_online_payments_live: !!live, p_terms_version: t || null };
  }
  function saveCheckoutSettings() {
    var a; try { a = checkoutSettingsArgs($("#coLive").checked, $("#coBypass").checked, $("#coTermsV").value); } catch (e) { showErr(e); return; }
    if (a.p_online_payments_live && !window.confirm("Turn ON online payment? New studios will be asked to pay through Razorpay.")) { $("#coLive").checked = false; return; }
    var b = $("#btnCheckout"); b.disabled = true;
    call("hq_set_checkout_settings", a).then(function (s) { showCheckoutSettings(s); okMsg("Checkout settings saved."); })
      .catch(showErr).then(function () { b.disabled = false; });
  }
  function saveSettings() {
    call("hq_set_billing_settings", { p_legal_name: $("#sName").value, p_gstin: $("#sGstin").value || null, p_address: $("#sAddr").value || null,
      p_gst_rate: Number($("#sRate").value), p_invoice_prefix: $("#sPrefix").value })
      .then(function () { return call("hq_set_seller_tax", { p_seller_country: $("#sCountry").value || "IN", p_seller_state: $("#sState").value || null,
        p_lut_number: $("#sLut").value || null, p_lut_valid_from: $("#sLutFrom").value || null, p_lut_valid_to: $("#sLutTo").value || null }); }).then(function () { okMsg("Invoice settings saved — used for new payments."); }).catch(showErr);
  }

  /* ---------------- plans ---------------- */
  // r25 (0273): each plan's fixed USD price (studios outside India pay in USD) - {code: {monthly, yearly}}
  async function usdPrices() {
    var out = {};
    try { var r = await call("hq_plan_checkout"); (Array.isArray(r) ? r : []).forEach(function (p) {
      (Array.isArray(p.prices) ? p.prices : []).forEach(function (x) { if (x.currency === "USD") out[p.code] = { monthly: x.monthly, yearly: x.yearly }; }); }); }
    catch (e) {}
    return out;
  }
  // pure: validated args for hq_upsert_plan_price in USD, or null when both fields are empty (exported for tests)
  function usdPriceArgs(code, m, y) {
    var ms = String(m == null ? "" : m).trim(), ys = String(y == null ? "" : y).trim();
    if (!ms && !ys) return null;
    if (!ms) throw new Error("Enter the USD price per month (the yearly price is optional)");
    var mm = Number(ms), yy = ys ? Number(ys) : null;
    if (!isFinite(mm) || mm < 0 || (yy != null && (!isFinite(yy) || yy < 0))) throw new Error("USD prices must be 0 or more");
    return { p_plan_code: String(code || "").trim().toLowerCase(), p_currency: "USD", p_price_monthly: mm, p_price_yearly: yy };
  }
  async function loadPlans() {
    var r = await call("hq_plans"); plans = Array.isArray(r) ? r : [];
    var usd = await usdPrices();
    var tb = clear($("#tPlans"));
    plans.forEach(function (p) {
      var edit = el("button", { cls: "btn sm", type: "button", text: "Edit" }), u = usd[p.code] || {};
      edit.addEventListener("click", function () { $("#plCode").value = p.code; $("#plName").value = p.name; $("#plPrice").value = p.price_monthly; $("#plActive").checked = !!p.active;
        $("#plUsdM").value = u.monthly == null ? "" : u.monthly; $("#plUsdY").value = u.yearly == null ? "" : u.yearly; });
      tb.appendChild(el("tr", null, [el("td", { cls: "m", text: p.code }), el("td", { text: p.name }), el("td", { cls: "n", text: money(p.price_monthly, p.currency) }),
        el("td", { cls: "n", text: u.monthly == null ? "—" : money(u.monthly, "USD") }),
        el("td", null, [el("span", { cls: "pill " + (p.active ? "ok" : ""), text: p.active ? "active" : "hidden" })]), el("td", { cls: "n", text: int(p.studios) }), el("td", null, [edit])]));
    });
    var tr = await call("hq_tax_rules"); tr = Array.isArray(tr) ? tr : [];
    var tt = clear($("#tTax"));
    tr.forEach(function (x) { tt.appendChild(el("tr", null, [el("td", { text: x.country + (x.region ? " · " + x.region : "") }), el("td", { cls: "m", text: x.regime }),
      el("td", { cls: "n", text: num(x.rate) + "%" }), el("td", { text: date(x.effective_from) + " – " + (x.effective_to ? date(x.effective_to) : "open") }),
      el("td", null, [el("span", { cls: "pill " + (x.active ? "ok" : ""), text: x.active ? "active" : "off" })]), el("td", { text: x.invoice_note || "" })])); });
    if (!plans.length) tb.appendChild(el("tr", null, [el("td", { colspan: "7", cls: "empty", text: "No plans yet — add one below." })]));
    loadPlanCheckout().catch(showErr);
  }
  function saveTaxRule() {
    call("hq_upsert_tax_rule", { p_country: $("#txCountry").value, p_region: $("#txRegion").value || null, p_regime: $("#txRegime").value,
      p_rate: Number($("#txRate").value), p_invoice_note: $("#txNote").value || null, p_effective_from: $("#txFrom").value || null,
      p_effective_to: $("#txTo").value || null, p_active: $("#txActive").checked }).then(function () { okMsg("Tax rule saved."); loadPlans().catch(showErr); }).catch(showErr);
  }
  /* ---------------- 0056 per-plan checkout details ---------------- */
  var planCo = [];
  // pure: validated args for hq_set_plan_checkout (exported for tests)
  function planCheckoutArgs(code, cur, desc, featText, rzpM, rzpY) {
    var RZ = /^plan_[A-Za-z0-9]{6,40}$/;
    var feats = String(featText || "").split(/\r?\n/).map(function (x) { return x.replace(/\s+/g, " ").trim(); }).filter(Boolean);
    if (feats.length > 20) throw new Error("Up to 20 included items");
    feats.forEach(function (f) { if (f.length > 120) throw new Error("Each included item: up to 120 characters"); if (/[<>]/.test(f)) throw new Error("Remove < and > from included items"); });
    var d = String(desc || "").replace(/\s+/g, " ").trim();
    if (d.length > 300 || /[<>]/.test(d)) throw new Error("Description: up to 300 characters, no < or >");
    var m = String(rzpM || "").trim(), y = String(rzpY || "").trim();
    if (m && !RZ.test(m)) throw new Error("Monthly Razorpay plan id must look like plan_XXXXXXXXXXXX");
    if (y && !RZ.test(y)) throw new Error("Yearly Razorpay plan id must look like plan_XXXXXXXXXXXX");
    if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(String(code || ""))) throw new Error("Choose a plan");
    return { p_code: code, p_currency: /^[A-Z]{3}$/.test(cur) ? cur : "INR", p_description: d || null, p_features: feats,
      p_sort_order: null, p_razorpay_plan_id_monthly: m || null, p_razorpay_plan_id_yearly: y || null };
  }
  function fillPlanCoForm(p, cur) {
    var sel = clear($("#pcCur")), prices = Array.isArray(p.prices) ? p.prices : [];
    prices.forEach(function (x) { var o = el("option", { value: x.currency, text: x.currency }); if (x.currency === cur) o.selected = true; sel.appendChild(o); });
    if (!prices.length) sel.appendChild(el("option", { value: "INR", text: "INR (add a price first)" }));
    var pr = prices.filter(function (x) { return x.currency === sel.value; })[0] || {};
    $("#pcCode").value = p.code; $("#pcDesc").value = p.description || "";
    $("#pcFeat").value = (Array.isArray(p.features) ? p.features : []).join("\n");
    $("#pcRzpM").value = pr.razorpay_plan_id_monthly || ""; $("#pcRzpY").value = pr.razorpay_plan_id_yearly || "";
    $("#pcForm").hidden = false; $("#pcDesc").focus();
  }
  async function loadPlanCheckout() {
    var tb = clear($("#tPlanCo"));
    try { var r = await call("hq_plan_checkout"); planCo = Array.isArray(r) ? r : []; }
    catch (e) { planCo = []; tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "Checkout details appear after migration 0056 is applied." })])); return; }
    planCo.forEach(function (p) {
      var ids = (Array.isArray(p.prices) ? p.prices : []).map(function (x) {
        return x.currency + ": " + (x.razorpay_plan_id_monthly || "— monthly") + " / " + (x.razorpay_plan_id_yearly || "— yearly"); }).join("; ") || "no prices yet";
      var edit = el("button", { cls: "btn sm", type: "button", text: "Edit" });
      edit.addEventListener("click", function () { fillPlanCoForm(p, "INR"); });
      tb.appendChild(el("tr", null, [el("td", { text: p.name + " (" + p.code + ")" }), el("td", { text: p.description || "—" }),
        el("td", { cls: "n", text: int((p.features || []).length) + " items" }), el("td", { cls: "m", text: ids }), el("td", null, [edit])]));
    });
    if (!planCo.length) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "No plans yet — add one above." })]));
  }
  function savePlanCheckout() {
    var a; try { a = planCheckoutArgs($("#pcCode").value, $("#pcCur").value, $("#pcDesc").value, $("#pcFeat").value, $("#pcRzpM").value, $("#pcRzpY").value); }
    catch (e) { showErr(e); return; }
    var b = $("#btnPlanCo"); b.disabled = true;
    call("hq_set_plan_checkout", a).then(function () { okMsg("Checkout details saved."); loadPlanCheckout().catch(showErr); })
      .catch(showErr).then(function () { b.disabled = false; });
  }
  function savePlan() {
    var u; try { u = usdPriceArgs($("#plCode").value, $("#plUsdM").value, $("#plUsdY").value); } catch (e) { showErr(e); return; }
    call("hq_upsert_plan", { p_code: $("#plCode").value, p_name: $("#plName").value, p_price_monthly: Number($("#plPrice").value), p_currency: "INR", p_active: $("#plActive").checked })
      .then(function () { return u ? call("hq_upsert_plan_price", u) : null; })   // r25: the fixed USD price next to INR
      .then(function () { okMsg("Plan saved."); loadPlans().catch(showErr); }).catch(showErr);
  }

  /* ---------------- activity + operators ---------------- */
  async function loadAudit() {
    var r = await call("hq_audit", { p_from: $("#aFrom").value || null, p_to: $("#aTo").value || null }); r = r && !Array.isArray(r) ? r : {};
    var tb = clear($("#tAudit")), writesOnly = $("#aWrites").checked;
    (r.rows || []).filter(function (x) { return !writesOnly || x.action !== "hq.view"; }).slice(0, 500).forEach(function (x) {
      tb.appendChild(el("tr", null, [el("td", { text: x.at ? new Date(x.at).toLocaleString("en-IN") : "—" }), el("td", { cls: "m", text: x.actor_email || "system" }),
        el("td", { cls: "m", text: x.action || "" }), el("td", { text: (x.entity || "") + (x.entity_id ? " · " + x.entity_id : "") })]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "No HQ activity in this range." })]));
  }
  // 0054: cross-studio security feed (operators only; names, no e-mails)
  async function loadSecurity() {
    var r = await call("hq_security_alerts", { p_from: $("#aFrom").value || null, p_to: $("#aTo").value || null }); r = r && !Array.isArray(r) ? r : {};
    $("#secTotal").textContent = int(r.total) + " event" + (num(r.total) === 1 ? "" : "s");
    var tb = clear($("#tSec"));
    (r.by_studio || []).forEach(function (x) {
      tb.appendChild(el("tr", null, [el("td", { text: "🛡️ " + (x.label || x.type || "") }), el("td", { text: x.studio || "—" }),
        el("td", { cls: "n", text: int(x.count) }), el("td", { text: x.latest ? new Date(x.latest).toLocaleString("en-IN") : "—" })]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "No security events in this range." })]));
    var tl = clear($("#tSecLatest"));
    (r.latest || []).slice(0, 100).forEach(function (x) {
      var who = [x.actor_name ? "by " + x.actor_name : "", x.subject_name || ""].filter(Boolean).join(" · ");
      tl.appendChild(el("tr", null, [el("td", { text: x.at ? new Date(x.at).toLocaleString("en-IN") : "—" }), el("td", { text: x.label || x.type || "" }),
        el("td", { text: x.studio || "—" }), el("td", { text: who || "—" })]));
    });
    if (!tl.firstChild) tl.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "Nothing yet." })]));
  }
  async function loadOperators() {
    var r = await call("hq_operators"); r = Array.isArray(r) ? r : [];
    var ul = clear($("#operators"));
    r.forEach(function (o) {
      var right = el("span", { cls: "muted", text: (o.mfa_enabled ? "2-step on" : "2-step off") + " · " + ago(o.last_sign_in_at) + (o.is_me ? " · you" : "") });
      var li = el("li", null, [el("span", { cls: "m", text: o.email }), right]);
      if (!o.is_me) {
        var rm = el("button", { cls: "btn sm danger", type: "button", text: "Remove" });
        rm.addEventListener("click", function () {
          if (!window.confirm("Remove " + o.email + " from Helm HQ?")) return;
          call("hq_remove_operator", { p_email: o.email }).then(function () { okMsg("Operator removed."); loadOperators().catch(showErr); }).catch(showErr);
        });
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
  }
  function addOperator() {
    var e = String($("#opEmail").value || "").trim(); if (!e) return;
    if (!window.confirm("Give " + e + " full Helm HQ access? They must sign in with two-step verification.")) return;
    call("hq_add_operator", { p_email: e }).then(function () { $("#opEmail").value = ""; okMsg("Operator added."); loadOperators().catch(showErr); }).catch(showErr);
  }

  /* ---------------- staff access (0248): reserved e-mail domains + staff allowlist ---------------- */
  async function loadStaff() {
    var r = await call("hq_staff_access"); r = r && !Array.isArray(r) ? r : {};
    var doms = Array.isArray(r.domains) ? r.domains : [], allow = Array.isArray(r.allowlist) ? r.allowlist : [], acc = Array.isArray(r.accounts) ? r.accounts : [];
    var open = acc.filter(function (a) { return !a.allowlisted && !a.banned_until; }).length;
    $("#stState").textContent = "Reserved: " + (doms.map(function (d) { return d.domain; }).join(", ") || "none") + " · " + int(allow.length) + " allowlisted · "
      + int(acc.length) + " existing login" + (acc.length === 1 ? "" : "s") + " on these domains" + (open ? " (" + int(open) + " not staff — review below)" : "");
    var ul = clear($("#stAllow"));
    allow.forEach(function (a) {
      var right = el("span", { cls: "muted", text: (a.is_platform_admin ? "HQ operator · " : "") + (a.has_login ? "has a login" : "no login yet") + (a.note ? " · " + a.note : "") });
      var li = el("li", null, [el("span", { cls: "m", text: a.email }), right]);
      if (!a.is_platform_admin) {
        var rm = el("button", { cls: "btn sm danger", type: "button", text: "Remove" });
        rm.addEventListener("click", function () {
          if (!window.confirm("Remove " + a.email + " from the staff allowlist? New logins for it will be refused. An existing login is not deleted or signed out.")) return;
          call("hq_staff_allow_remove", { p_email: a.email }).then(function () { okMsg("Removed from the staff allowlist."); loadStaff().catch(showErr); }).catch(showErr);
        });
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "Nobody yet." }));
    var dl = clear($("#stDomains"));
    doms.forEach(function (d) {
      var li = el("li", null, [el("span", { cls: "m", text: d.domain + (d.include_subdomains ? " (+ sub-domains)" : "") }),
        el("span", { cls: "muted", text: d.builtin ? "Helm’s own domain" : (d.note || "added " + date(d.added_at)) })]);
      if (!d.builtin) {
        var rm = el("button", { cls: "btn sm danger", type: "button", text: "Remove" });
        rm.addEventListener("click", function () {
          if (!window.confirm("Stop reserving " + d.domain + "? People could sign up with it again.")) return;
          call("hq_reserved_domain_remove", { p_domain: d.domain }).then(function () { okMsg("Domain no longer reserved."); loadStaff().catch(showErr); }).catch(showErr);
        });
        li.appendChild(rm);
      }
      dl.appendChild(li);
    });
    var tb = clear($("#tStAcc"));
    acc.forEach(function (a) {
      var st = a.banned_until ? el("span", { cls: "pill", text: "sign-in off" })
        : a.allowlisted ? el("span", { cls: "pill ok", text: a.is_platform_admin ? "HQ operator" : "staff" })
        : el("span", { cls: "pill warn", text: "not staff — review" });
      tb.appendChild(el("tr", null, [el("td", { cls: "m", text: a.email || "" }), el("td", { text: a.studio ? a.studio + (a.role ? " · " + a.role : "") : "—" }),
        el("td", { text: date(a.created_at) }), el("td", { text: ago(a.last_sign_in_at) }), el("td", null, [st])]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "No logins on reserved domains." })]));
  }
  function addStaff() {
    var e = String($("#stEmail").value || "").trim().toLowerCase(); if (!e) return;
    call("hq_staff_allow_add", { p_email: e, p_note: String($("#stNote").value || "").trim() || null })
      .then(function () { $("#stEmail").value = ""; $("#stNote").value = ""; okMsg("Added to the staff allowlist — this address can now be given a login."); loadStaff().catch(showErr); }).catch(showErr);
  }
  function addDomain() {
    var d = String($("#stDomain").value || "").trim().toLowerCase(); if (!d) return;
    if (!window.confirm("Reserve " + d + " (and its sub-domains)? Nobody outside the staff allowlist will be able to sign up with it.")) return;
    call("hq_reserved_domain_add", { p_domain: d, p_note: String($("#stDomNote").value || "").trim() || null })
      .then(function () { $("#stDomain").value = ""; $("#stDomNote").value = ""; okMsg("Domain reserved."); loadStaff().catch(showErr); }).catch(showErr);
  }

  /* ---------------- r21 (0249): HQ two-step readiness ---------------- */
  async function loadMfaReadiness() {
    var M = window.HelmHqMfa; if (!M || !$("#mfaROps")) return;
    var r = null, ops = null;
    try { r = await call("hq_mfa_readiness"); }
    catch (e) { try { ops = await call("hq_operators"); } catch (e2) { ops = []; } }   // database without 0249
    var m = M.model(r, ops, undefined);
    var st = clear($("#mfaRState")); st.appendChild(el("span", { cls: "pill " + m.state.tone, text: m.state.text }));
    $("#mfaRHint").textContent = m.hint;
    var ul = clear($("#mfaROps"));
    m.lines.forEach(function (x) {
      ul.appendChild(el("li", null, [el("span", { cls: "m", text: x.email + (x.me ? " (you)" : "") }), el("span", { cls: "pill " + x.tone, text: x.label })]));
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "No HQ operators." }));
    var ad = $("#mfaRAdmins"); ad.textContent = m.admins || ""; ad.hidden = !m.admins;
    var b = $("#btnMfaEnroll"); b.hidden = !m.showEnroll || !(window.HelmAuthUI && window.HelmAuthUI.renderEnroll);
  }
  function startMfaEnroll() {
    var box = $("#mfaREnroll"), b = $("#btnMfaEnroll");
    if (!window.HelmAuthUI || !window.HelmAuthUI.renderEnroll) { showErr(new Error("Two-step set-up couldn't load. Reload the page and try again.")); return; }
    b.hidden = true; box.hidden = false;
    window.HelmAuthUI.renderEnroll(box, function () {
      okMsg("Two-step is on for your HQ account. Next time you sign in, Helm asks for the code from your app.");
      setTimeout(function () { box.hidden = true; clear(box); loadMfaReadiness().catch(showErr); }, 1200);
    });
  }

  // r25: hq_overview (always) + hq_metrics (0272; a database without it shows the older tiles and "appears after SQL 0272")
  async function loadOverview() {
    var r = await Promise.all([call("hq_overview"), call("hq_metrics").catch(function () { return null; })]);
    renderOverview(r[0] || {}, r[1] && !Array.isArray(r[1]) && r[1].studios ? r[1] : null);
  }
  async function loadAll() {
    $("#err").hidden = true;
    await Promise.all([loadOverview(), loadPlans(), loadStudios(0), loadUsers(0), loadBilling()]);
    loadMfaReadiness().catch(function () {});
  }

  // Who may see HQ, decided BEFORE any hq_* data is requested:
  //   signed out / a sign-in step pending (incl. the two-step code) → sign-in page
  //   not a platform operator                                         → ordinary 404
  //   operator without a verified authenticator, or session < aal2    → sign-in page,
  //     which forces set-up / the code (no skip); "unknown" fails closed the same way
  //   operator at aal2                                                → HQ
  // Authenticators are only looked at after is_platform_admin() said yes.
  async function gate() {
    if (!BPStore.auth.pendingUser()) return "login";
    if (BPStore.auth.pendingStep()) return "login";
    var step = BPStore.auth.mfa && BPStore.auth.mfa.operatorStep ? await BPStore.auth.mfa.operatorStep() : "unknown";
    if (step === "none") return "notfound";
    return step === "ok" ? "hq" : "login";
  }

  function on(id, ev, fn) { var n = $(id); if (n) n.addEventListener(ev, fn); }
  async function start() {
    try { await BPStore.init(); } catch (e) { notFound(); return; }
    if (!BPStore.auth.enabled()) { notFound(); return; }
    BPStore.auth.required();
    var g = "notfound";
    try { g = await gate(); } catch (e) { g = "notfound"; }
    if (g === "login") { location.replace("login.html"); return; }
    if (g !== "hq") { notFound(); return; }
    var today = new Date(), month = new Date(today.getFullYear(), today.getMonth(), 1), past = new Date(Date.now() - 30 * 864e5);
    $("#bFrom").value = iso(month); $("#bTo").value = iso(today); $("#aFrom").value = iso(past); $("#aTo").value = iso(today); $("#rPaidOn").value = iso(today);
    try { await loadAll(); }
    catch (e) { notFound(); return; }   // any failure on first load looks like a missing page — never reveal HQ exists
    document.title = "Helm HQ";
    $("#who").textContent = (BPStore.auth.user() && BPStore.auth.user().email) || "";
    $("#vLoading").hidden = true; $("#vApp").hidden = false;
    // r24 (0271): the e-mail alerts link straight to Requests (hq#requests)
    if (location.hash === "#requests") { showTab("requests"); reqTab("plan"); loadRequestsTab(); } else showTab("overview");

    TABS.forEach(function (t) { on("#tab-" + t, "click", function () {
      showTab(t);
      if (t === "activity") { loadAudit().catch(showErr); loadSecurity().catch(showErr); loadOperators().catch(showErr); }
      if (t === "billing") loadSettings().catch(showErr);
      if (t === "requests") loadRequestsTab();
      if (t === "staff") loadStaff().catch(showErr);
    }); });
    on("#btnRefresh", "click", function () { loadAll().catch(showErr); if (!$("#pane-requests").hidden) loadRequestsTab(); });
    // r25: studio drawer, Requests tabs, search
    on("#btnDClose", "click", closeDrawer);
    on("#studioScrim", "click", closeDrawer);
    DTABS.forEach(function (t) { on("#dt-" + t, "click", function () { dTab(t); }); });
    RTABS.forEach(function (t) { on("#rt-" + t, "click", function () { reqTab(t); }); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!$("#gResults").hidden) { closeSearch(); return; }
      if (!$("#studioDrawer").hidden) closeDrawer();
    });
    on("#gSearch", "input", function () { clearTimeout(gTimer); gTimer = setTimeout(runSearch, 250); });
    on("#gSearch", "focus", function () { if (String($("#gSearch").value || "").trim().length >= 2) runSearch(); });
    document.addEventListener("click", function (e) { if (e.target && e.target.closest && !e.target.closest(".gs")) closeSearch(); });
    on("#btnMfaEnroll", "click", startMfaEnroll);
    on("#btnOut", "click", function () { Promise.resolve(BPStore.auth.signOut && BPStore.auth.signOut()).finally(function () { location.replace("login.html"); }); });
    on("#btnBill", "click", function () { loadBilling().catch(showErr); });
    on("#btnCsv", "click", exportCsv);
    on("#btnRecord", "click", recordPayment);
    on("#btnReq", "click", function () { loadRequests().catch(showErr); });
    on("#fReq", "change", function () { loadRequests().catch(showErr); });
    on("#btnSe", "click", function () { loadSales().catch(showErr); });
    on("#fSe", "change", function () { loadSales().catch(showErr); });
    on("#btnSg", "click", function () { loadSuggestions().catch(showErr); });
    on("#fSg", "change", function () { loadSuggestions().catch(showErr); });
    on("#btnSeSet", "click", saveSalesSettings);
    on("#btnSettings", "click", saveSettings);
    on("#btnPlan", "click", savePlan);
    on("#btnCheckout", "click", saveCheckoutSettings);
    on("#btnPlanCo", "click", savePlanCheckout);
    on("#pcCur", "change", function () { var p = planCo.filter(function (x) { return x.code === $("#pcCode").value; })[0]; if (p) fillPlanCoForm(p, $("#pcCur").value); });
    on("#btnTax", "click", saveTaxRule);
    on("#btnAudit", "click", function () { loadAudit().catch(showErr); loadSecurity().catch(showErr); });
    on("#aWrites", "change", function () { loadAudit().catch(showErr); });
    on("#btnOp", "click", addOperator);
    on("#btnStAdd", "click", addStaff);
    on("#btnStDom", "click", addDomain);
    on("#btnRefreshBilling", "click", function () { call("hq_refresh_billing_status").then(function (r) { okMsg("Billing status refreshed: " + int(r && r.past_due_set) + " now past due, " + int(r && r.reminders_queued) + " reminders queued."); refreshAfterWrite(null); }).catch(showErr); });
    on("#fStatus", "change", function () { loadStudios(0).catch(showErr); });
    on("#qStudios", "input", function () { clearTimeout(sTimer); sTimer = setTimeout(function () { loadStudios(0).catch(showErr); }, 300); });
    on("#qUsers", "input", function () { clearTimeout(uTimer); uTimer = setTimeout(function () { loadUsers(0).catch(showErr); }, 300); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
