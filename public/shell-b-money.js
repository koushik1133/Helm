/* shell-b-money.js — the studio's money views (moved off the client-facing dashboard).
   window.HelmMoney.mount(host): renders the Business page into `host`.
   Read-only: never writes data. DOM APIs only (no innerHTML with data, no inline style attributes).
   Data: BPStore.dashboard.money(12) (0108 RPC, exact ledger numbers) with the same fallback the
   dashboard used when the RPC is missing (sums over the 500 most recently updated quotes).
   Every amount carries data-money so privacy mode (shell-b-privacy.js) masks it. */
(function () {
  "use strict";
  if (window.HelmMoney) return;

  var NS = "http://www.w3.org/2000/svg";
  var REDUCED = false; try { REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  var DAY = 864e5;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function sv(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, String(attrs[k])); if (parent) parent.appendChild(e); return e; }
  function icon(d) { var s = sv("svg", { viewBox: "0 0 24 24", "class": "bz-ic", "aria-hidden": "true" }); d.split("|").forEach(function (p) { sv("path", { d: p }, s); }); return s; }
  var IC = {
    chart: "M4 20V10|M10 20V4|M16 20v-7|M22 20H2", pipe: "M3 5h18|M6 12h12|M10 19h4", alert: "M12 3 2 20h20z|M12 10v4|M12 17h.01",
    cal: "M4 6h16v14H4z|M4 10h16|M8 3v4|M16 3v4", user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M4 21a8 8 0 0 1 16 0",
    arrow: "M5 12h14|M13 6l6 6-6 6", check: "M5 12l5 5 9-10"
  };
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function abs(h) { try { if (window.HelmUrl && HelmUrl.upgrade) h = HelmUrl.upgrade(h); } catch (e) {} return (typeof h === "string" && h && !/^([a-z]+:|\/|#)/i.test(h)) ? "/" + h : h; }
  function link(href, cls, text) { var a = el("a", cls, text); a.href = abs(href); return a; }
  function S() { return window.BPStore; }
  async function safe(fn, dflt) { try { var r = await fn(); return r == null ? dflt : r; } catch (e) { return dflt; } }
  function money(node) { node.setAttribute("data-money", ""); return node; }   /* privacy mode masks these */

  /* ---------- dates ---------- */
  function iso(d) { var m = d.getMonth() + 1, x = d.getDate(); return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (x < 10 ? "0" : "") + x; }
  function dOf(s) { var d = new Date(String(s || "").slice(0, 10) + "T00:00:00"); return isNaN(d) ? null : d; }
  function ym(d) { return d.getFullYear() * 12 + d.getMonth(); }
  /* LA-27: the ONE studio formatter (studio locale; a calendar day is formatted as its YYYY-MM-DD, never shifted) */
  function dfmt(d, f) { try { return S().fmtStudioDate(iso(d), { fmt: f }); } catch (e) { return d.toLocaleDateString(undefined, f); } }
  function fmtDay(s) { var d = dOf(s); return d ? dfmt(d, { weekday: "short", day: "numeric", month: "short" }) : ""; }

  /* ---------- money formatting (studio currency; INR uses lakh / crore) ---------- */
  var CUR = "INR";
  function full(n) {
    n = Math.round(Number(n) || 0);
    if (CUR === "INR") return "₹" + n.toLocaleString("en-IN");
    try { return new Intl.NumberFormat(CUR === "AED" ? "en-AE" : undefined, { style: "currency", currency: CUR, maximumFractionDigits: 0 }).format(n); } catch (e) { return CUR + " " + n.toLocaleString(); }
  }
  function compact(n) {
    n = Number(n) || 0; var a = Math.abs(n);
    if (CUR === "INR") {
      if (a >= 1e7) return "₹" + (n / 1e7).toFixed(2).replace(/\.?0+$/, "") + " Cr";
      if (a >= 1e5) return "₹" + (n / 1e5).toFixed(1).replace(/\.0$/, "") + " L";
      return full(n);
    }
    try { return new Intl.NumberFormat(CUR === "AED" ? "en-AE" : undefined, { style: "currency", currency: CUR, notation: "compact", maximumFractionDigits: 1 }).format(n); } catch (e) { return full(n); }
  }
  function num(n) { return Math.round(Number(n) || 0).toLocaleString(CUR === "INR" ? "en-IN" : undefined); }
  function qCur(q) { try { return S().quoteCurrency(q); } catch (e) { return "INR"; } }
  function qMoney(q) { try { return q.total ? S().quoteMoney(q.total, q) : ""; } catch (e) { return q.total ? full(q.total) : ""; } }
  function qMoneyN(n, q) { try { return n ? S().quoteMoney(n, q) : ""; } catch (e) { return n ? full(n) : ""; } }
  /* qts-1018: ONE status label (BPStore.quoteStatus): "Confirmed" only once the client approved / paid */
  function qLabel(q) { try { var B = S(); if (B && typeof B.quoteStatus === "function") return B.quoteStatus(q).label; } catch (e) {}
    return q.status === "confirmed" ? "Confirmed" : "Tentative"; }
  function qName(q) { try { var H = window.HelmEventName; if (H && H.displayName) { var x = H.displayName(q); if (x) return x; } } catch (e) {} var c = q.client || {}; return q.title || c.name || q.code || "Untitled"; }
  function evHref(id) { return "event.html?id=" + encodeURIComponent(id); }
  function mN(x) { var v = Number(x); return isFinite(v) ? v : 0; }

  /* ---------- small visual pieces ---------- */
  function countUp(node, target, fmt) {
    if (REDUCED || !isFinite(target) || target === 0 || !window.requestAnimationFrame) { node.textContent = fmt(target); return; }
    var t0 = null;
    function step(t) { if (t0 == null) t0 = t; var p = Math.min(1, (t - t0) / 600), e = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(target * e); if (p < 1) requestAnimationFrame(step); else node.textContent = fmt(target); }
    requestAnimationFrame(step);
  }
  function sparkline(points) {
    var s = sv("svg", { viewBox: "0 0 100 32", preserveAspectRatio: "none", "class": "bz-spark", "aria-hidden": "true" });
    if (!points || points.length < 2) return s;
    var mx = Math.max.apply(null, points), mn = Math.min.apply(null, points), rg = mx - mn || 1;
    var d = points.map(function (v, i) { return (i ? "L" : "M") + ((i / (points.length - 1)) * 100).toFixed(1) + " " + (29 - ((v - mn) / rg) * 26).toFixed(1); }).join(" ");
    sv("path", { d: d + " L100 32 L0 32 Z", "class": "bz-spark-fill" }, s);
    sv("path", { d: d, "class": "bz-spark-line", "vector-effect": "non-scaling-stroke" }, s);
    return s;
  }
  function meter(frac, kind) {
    var s = sv("svg", { viewBox: "0 0 100 6", preserveAspectRatio: "none", "class": "bz-meter", "aria-hidden": "true" });
    sv("rect", { x: 0, y: 0, width: 100, height: 6, rx: 3, "class": "bz-meter-bg" }, s);
    sv("rect", { x: 0, y: 0, width: Math.max(0, Math.min(1, frac || 0)) * 100, height: 6, rx: 3, "class": "bz-meter-fg" + (kind ? " bz-mf-" + kind : "") }, s);
    return s;
  }
  function card(title, ic, more) {
    var c = el("section", "bz-card"); c.setAttribute("aria-label", title);
    var h = el("div", "bz-head"); h.appendChild(icon(ic)); h.appendChild(el("h3", null, title));
    if (more) { var a = link(more[0], "bz-more", more[1]); a.appendChild(icon(IC.arrow)); h.appendChild(a); }
    c.appendChild(h); var b = el("div", "bz-body"); c.appendChild(b);
    for (var i = 0; i < 3; i++) b.appendChild(el("div", "bz-skel"));
    return c;
  }
  function body(c) { return clear(c.querySelector(".bz-body")); }
  function empty(b, text) { var e = el("div", "bz-empty"); e.appendChild(icon(IC.check)); e.appendChild(el("span", null, text)); b.appendChild(e); }
  function monthSeries(list, dateOf, valOf, n, now) {
    var cur = ym(now), out = []; for (var j = 0; j < n; j++) out.push(0);
    list.forEach(function (x) { var d = dOf(dateOf(x)); if (!d) return; var k = n - 1 - (cur - ym(d)); if (k >= 0 && k < n) out[k] += valOf(x); });
    return out;
  }
  function delta(curV, prevV) {
    if (!prevV) return el("span", "bz-delta bz-delta-na", "—");
    var p = Math.round(((curV - prevV) / Math.abs(prevV)) * 100), up = p >= 0;
    var d = el("span", "bz-delta " + (p === 0 ? "bz-delta-na" : up ? "bz-delta-up" : "bz-delta-dn"), (up ? "▲ " : "▼ ") + Math.abs(p) + "%");
    d.title = "vs last month"; return d;
  }
  function tile(t, o) {
    clear(t); t.classList.remove("bz-loading");
    var top = el("div", "bz-kpi-top"); top.appendChild(el("span", "bz-kpi-l", o.label)); if (o.delta) top.appendChild(o.delta); t.appendChild(top);
    var v = money(el("div", "bz-kpi-v")); t.appendChild(v);
    // QA1026 #11: an empty money tile stays data-money, so with amounts hidden it shows •••• like the rest
    if (o.value == null) { v.textContent = "—"; } else countUp(v, o.value, compact);
    var sub = el("div", "bz-kpi-sub" + (o.subKind ? " bz-t-" + o.subKind : ""), o.sub || ""); if (o.subMoney) money(sub); t.appendChild(sub);
    if (o.spark) t.appendChild(sparkline(o.spark));
    if (o.href) { var a = link(o.href, "bz-kpi-a"); a.setAttribute("aria-label", o.label + ": open"); t.appendChild(a); }
  }

  /* revenue bars (booked vs collected per month). `p` = class prefix ("bz-" on the Business page,
     "hd2-" on dashboard Demo 2) so each page styles it with its own scoped CSS. Returns the svg (data-money). */
  function revenueBars(booked, collected, now, p) {
    p = p || "bz-"; var N = booked.length;
      var W = 600, H = 200, PADL = 48, PADB = 22, mx = Math.max.apply(null, booked.concat(collected || [])) || 0;
      var nice = function (v) { if (v <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; };
      var top = nice(mx / 3) * 3;
      var s = money(sv("svg", { viewBox: "0 0 " + W + " " + H, "class": p + "bars", role: "img", "aria-label": "Booked" + (collected ? " and collected" : "") + " per month, last 12 months" }));
      for (var g = 0; g <= 3; g++) {
        var y = (H - PADB) - ((H - PADB - 8) * g / 3);
        sv("line", { x1: PADL, x2: W, y1: y, y2: y, "class": g ? p + "grid-l" : p + "base-l" }, s);
        var tx = sv("text", { x: PADL - 6, y: y + 4, "class": p + "axis", "text-anchor": "end" }, s); tx.textContent = g ? compact(top * g / 3) : "0";
      }
      var bw = (W - PADL) / N;
      booked.forEach(function (v, i) {
        var d = new Date(now.getFullYear(), now.getMonth() - (N - 1 - i), 1);
        var h = top ? (H - PADB - 8) * v / top : 0, x = PADL + i * bw + bw * 0.2, bwid = collected ? bw * 0.3 : bw * 0.6;
        var gEl = sv("g", { "class": p + "bar-g" }, s);
        sv("rect", { x: PADL + i * bw, y: 0, width: bw, height: H - PADB, "class": p + "bar-hit" }, gEl);
        sv("rect", { x: x, y: (H - PADB) - Math.max(v ? 2 : 0, h), width: bwid, height: Math.max(v ? 2 : 0, h), rx: 3, "class": p + "bar" + (i === N - 1 ? " " + p + "bar-now" : "") }, gEl);
        var cTxt = "";
        if (collected) { var c2 = collected[i], ch = top ? (H - PADB - 8) * c2 / top : 0;
          sv("rect", { x: x + bwid, y: (H - PADB) - Math.max(c2 ? 2 : 0, ch), width: bwid, height: Math.max(c2 ? 2 : 0, ch), rx: 3, "class": p + "bar-col" }, gEl);
          cTxt = " · collected " + full(c2); }
        var tt = sv("title", {}, gEl); tt.textContent = dfmt(d, { month: "long", year: "numeric" }) + ": booked " + full(v) + cTxt;
        var lb = sv("text", { x: PADL + i * bw + bw / 2, y: H - 6, "class": p + "axis", "text-anchor": "middle" }, s); lb.textContent = dfmt(d, { month: "short" }).slice(0, 3);
      });
    return s;
  }

  /* ================================================================== */
  async function mount(host) {
    if (!host || host.__bz) return; host.__bz = 1;
    var root = el("div", "bz"); clear(host).appendChild(root);
    var now = new Date(), today = iso(now), todayD = dOf(today);

    var head = el("header", "bz-hero");
    var hl = el("div"); hl.appendChild(el("p", "bz-eyebrow", "Finance overview"));
    hl.appendChild(el("h2", "bz-title", "Business"));
    var sum = el("p", "bz-sum", "Booked, collected and outstanding money for your studio. Keep this page off the screen when presenting to clients.");
    hl.appendChild(sum); head.appendChild(hl);
    var acts = el("div", "bz-acts");
    acts.appendChild(link("reports.html", "bz-btn", "Reports & exports"));
    acts.appendChild(link("insights.html", "bz-btn", "Insights"));
    head.appendChild(acts); root.appendChild(head);

    var kpis = el("div", "bz-kpis"); kpis.setAttribute("aria-label", "Key money numbers"); var tiles = [];
    for (var i = 0; i < 4; i++) { var t = el("div", "bz-kpi bz-loading"); t.appendChild(el("div", "bz-skel bz-skel-line")); t.appendChild(el("div", "bz-skel bz-skel-big")); kpis.appendChild(t); tiles.push(t); }
    root.appendChild(kpis);

    var grid = el("div", "bz-grid"), colM = el("div", "bz-col"), colS = el("div", "bz-col");
    grid.appendChild(colM); grid.appendChild(colS); root.appendChild(grid);
    var cRev = card("Revenue — booked vs collected", IC.chart), cOver = card("Overdue payments", IC.alert), cUp = card("Upcoming events", IC.cal, ["calendar.html", "Calendar"]);
    var cPipe = card("Pipeline", IC.pipe, ["quotes.html", "Quotes"]), cTop = card("Top clients by value", IC.user);
    colM.appendChild(cRev); colM.appendChild(cUp); colS.appendChild(cOver); colS.appendChild(cPipe); colS.appendChild(cTop);
    var note = el("p", "bz-note"); root.appendChild(note);

    /* ---- data ---- */
    for (var w = 0; w < 100 && !(S() && S().quotes); w++) await new Promise(function (r) { setTimeout(r, 100); });
    if (!S()) { clear(sum).appendChild(document.createTextNode("Data isn't available right now.")); return; }
    await safe(function () { return S().init(); });
    try { CUR = S().studioCurrency() || "INR"; } catch (e) {}
    var A = S().auth || {}, authOn = false; try { authOn = !!(A.enabled && A.enabled()); } catch (e) {}
    async function cv(a) { try { if (!authOn) return true; return !!(await A.canView(a)); } catch (e) { return false; } }
    var perms = await Promise.all([cv("quotes"), cv("leads")]), vQuotes = perms[0], vLeads = perms[1];
    var R = await Promise.all([
      vQuotes ? safe(function () { return S().quotes.page({ sort: "updated", limit: 500 }); }, null) : null,
      vQuotes ? safe(function () { return S().quotes.counts(); }, null) : null,
      vLeads ? safe(function () { return S().leads.list(); }, null) : null,
      S().dashboard && S().dashboard.money ? safe(function () { return S().dashboard.money(12); }, null) : null
    ]);
    var pageRes = R[0], rows = (pageRes && pageRes.rows) || [], counts = R[1], leads = R[2] || [];
    var M = R[3] && typeof R[3] === "object" && Array.isArray(R[3].months) ? R[3] : null;
    if (M && M.currency && String(M.currency).toUpperCase() !== CUR) M = null;   // never mix currencies
    var MP = M && M.pipeline ? M.pipeline : null, MT = (M && M.totals) || {}, MFIN = !!(M && M.finance && MT.outstanding != null);
    function mStage(k) { var x = MP && MP[k]; return x ? { n: mN(x.count), v: x.value == null ? null : mN(x.value) } : null; }
    var curRows = rows.filter(function (q) { return qCur(q) === CUR; }), otherCur = rows.length - curRows.length;
    var conf = curRows.filter(function (q) { return q.status === "confirmed"; });
    var paidBy = {}; ((M && M.upcoming) || []).forEach(function (u) { if (u && u.quote_id) paidBy[u.quote_id] = u; });

    /* ---- KPI tiles ---- */
    var N = 12;
    var booked = M ? M.months.slice(-N).map(function (m) { return mN(m.booked); })
      : monthSeries(conf, function (q) { return q.confirmedAt || q.eventDate || q.updatedAt; }, function (q) { return Number(q.total) || 0; }, N, now);
    while (booked.length < N) booked.unshift(0);
    var collected = MFIN ? M.months.slice(-N).map(function (m) { return mN(m.collected); }) : null;
    if (collected) while (collected.length < N) collected.unshift(0);
    var b0 = booked[N - 1], b1 = booked[N - 2];
    tile(tiles[0], { label: "Booked this month", value: vQuotes ? b0 : null, delta: vQuotes ? delta(b0, b1) : null,
      sub: vQuotes ? (b1 ? "Last month " + compact(b1) : "Confirmed events, by confirmation date") : "No access to quotes", subMoney: !!b1, spark: booked.slice(-7), href: "quotes.html" });
    if (collected) {
      var c0 = collected[N - 1], c1 = collected[N - 2];
      tile(tiles[1], { label: "Collected this month", value: c0, delta: delta(c0, c1), sub: c1 ? "Last month " + compact(c1) : "Payments recorded, by date received", subMoney: !!c1, spark: collected.slice(-7), href: "reports.html" });
      var od = (M.overdue || []).length;
      tile(tiles[2], { label: "Outstanding", value: mN(MT.outstanding), sub: od ? od + (od >= 10 ? "+" : "") + " payment" + (od === 1 ? "" : "s") + " overdue" : "Confirmed value not yet collected",
        subKind: od ? "bad" : null, spark: collected.slice(-7), href: "reports.html" });
    } else {
      tile(tiles[1], { label: "Collected this month", value: null, sub: M ? "Needs finance access" : "Not available yet — payments are tracked per event in Settlement", href: M ? null : "quotes.html" });
      tile(tiles[2], { label: "Outstanding", value: null, sub: "Open Settlement per event for balances", href: "quotes.html" });
    }
    var openRows = curRows.filter(function (q) { return q.status === "quote"; });
    var openV = openRows.reduce(function (s, q) { return s + (Number(q.total) || 0); }, 0), openN = counts && typeof counts.quote === "number" ? counts.quote : openRows.length;
    var mo = mStage("open"), ms = mStage("sent");
    if (mo && ms) { openN = mo.n + ms.n; if (mo.v != null && ms.v != null) openV = mo.v + ms.v; }
    tile(tiles[3], { label: "Open pipeline value", value: vQuotes ? openV : null, sub: vQuotes ? openN + (openN === 1 ? " open quote" : " open quotes") : "No access to quotes",
      spark: vQuotes ? monthSeries(curRows.filter(function (q) { return q.status === "quote"; }), function (q) { return q.createdAt; }, function (q) { return Number(q.total) || 0; }, 7, now) : null, href: "quotes.html" });

    /* ---- revenue chart ---- */
    (function () {
      var b = body(cRev);
      if (!vQuotes) { empty(b, "You don't have access to quotes."); return; }
      var tot = booked.reduce(function (s, v) { return s + v; }, 0), totC = collected ? collected.reduce(function (s, v) { return s + v; }, 0) : 0;
      var hd = el("div", "bz-rev-head"); var big = money(el("b", "bz-rev-total")); countUp(big, tot, compact); hd.appendChild(big);
      hd.appendChild(el("span", "bz-muted", "booked in the last 12 months"));
      if (collected) { var cc = el("span", "bz-muted"); cc.appendChild(document.createTextNode("· ")); cc.appendChild(money(el("span", null, compact(totC)))); cc.appendChild(document.createTextNode(" collected")); hd.appendChild(cc); }
      b.appendChild(hd);
      if (collected) {
        var lg = el("div", "bz-legend");
        [["bz-lg-b", "Booked"], ["bz-lg-c", "Collected"]].forEach(function (x) { var it = el("span", "bz-lg-i"); it.appendChild(el("i", x[0])); it.appendChild(document.createTextNode(x[1])); lg.appendChild(it); });
        b.appendChild(lg);
      }
      var s = revenueBars(booked, collected, now, "bz-");
      b.appendChild(s);
      var cap = M ? "Booked = confirmed event value (" + CUR + ") by confirmation month." + (collected ? " Collected = payments recorded, by date received." : "")
        : "Booked = confirmed quote value (" + CUR + ") by confirmation month. Collected payments need the payment ledger — see Settlement per event.";
      var oc = M ? (M.other_currencies || []).length : otherCur;
      if (oc) cap += M ? " Other currencies are not included." : " " + otherCur + " quote" + (otherCur === 1 ? "" : "s") + " in other currencies excluded.";
      if (!M && pageRes && pageRes.hasMore) cap += " Based on the 500 most recently updated quotes.";
      b.appendChild(el("p", "bz-caption", cap));
      // QA: "no confirmed quotes" vs "confirmed quotes with no price / confirmed earlier" (0108 pipeline counts when present)
      var nConf = MP && MP.confirmed && MP.closed ? mN(MP.confirmed.count) + mN(MP.closed.count) : rows.filter(function (q) { return q.status === "confirmed"; }).length;
      if (!tot) b.insertBefore(el("p", "bz-note", nConf ? "Your confirmed events add no booked value in the last 12 months yet \u2014 check that their quotes have a price." : "Revenue appears once your first quote is confirmed."), s);
    })();

    /* ---- overdue payments ---- */
    (function () {
      var b = body(cOver);
      if (!MFIN) { empty(b, M ? "You need finance access to see payments." : "Overdue payments need the payment ledger. Open Settlement on an event to record payments."); return; }
      var list = (M.overdue || []).filter(function (o) { return o && o.quote_id; });
      if (!list.length) { empty(b, "No overdue payments. Nice."); return; }
      var ul = el("ul", "bz-list");
      list.forEach(function (o) {
        var bal = mN(o.balance != null ? o.balance : mN(o.amount) - mN(o.paid)), oc = String(o.currency || CUR).toUpperCase(), mny;
        try { mny = S().moneyIn(bal, oc); } catch (e) { mny = full(bal); }
        var li = el("li", "bz-li"); li.appendChild(el("i", "bz-dot bz-dot-bad"));
        var m = el("div", "bz-main"); m.appendChild(el("b", null, o.title || o.code || "Event"));
        m.appendChild(el("small", null, [o.client, o.label, o.due_date ? "due " + fmtDay(o.due_date) : ""].filter(Boolean).join(" · "))); li.appendChild(m);
        li.appendChild(money(el("span", "bz-num bz-t-bad", mny)));
        li.appendChild(link("settlement.html?quote=" + encodeURIComponent(o.quote_id), "bz-btn bz-sm", "Collect"));
        ul.appendChild(li);
      });
      b.appendChild(ul);
      if (list.length >= 10) b.appendChild(el("p", "bz-note", "Showing the 10 oldest. Open Reports for the full list."));
    })();

    /* ---- upcoming events with value + % paid ---- */
    (function () {
      var b = body(cUp), in30 = iso(new Date(todayD.getTime() + 30 * DAY));
      var list = rows.filter(function (q) { var d = q.eventDate && String(q.eventDate).slice(0, 10); return d && d >= today && d <= in30 && q.status !== "cancelled"; })
        .sort(function (a, c) { return String(a.eventDate).localeCompare(String(c.eventDate)); });
      if (!list.length) { empty(b, "No events in the next 30 days."); return; }
      var tbl = el("div", "bz-table");
      list.slice(0, 8).forEach(function (q) {
        var a = link(evHref(q.id), "bz-trow"), d = dOf(q.eventDate);
        var dc = el("div", "bz-day"); dc.appendChild(el("small", null, dfmt(d, { month: "short" }))); dc.appendChild(el("b", null, d.getDate())); a.appendChild(dc);
        var m = el("div", "bz-main"); m.appendChild(el("b", null, qName(q)));
        m.appendChild(el("small", null, [iso(d) === today ? "Today" : fmtDay(q.eventDate), q.client && q.client.name, qLabel(q)].filter(Boolean).join(" · "))); a.appendChild(m);
        var pu = paidBy[q.id], pv = pu ? mN(pu.value) : 0;
        /* qts-1018: the row value = the invoice total (server dashboard_money: pricing.total + approved change orders),
           the same number as the Quotes list + Event Workspace header; the bare quote total only when the server sent none */
        var val = el("div", "bz-val"); val.appendChild(money(el("span", "bz-num", (pu && pv > 0 ? qMoneyN(pv, q) : qMoney(q)) || "—")));
        if (pu && pv > 0) { var pp = Math.max(0, Math.min(100, Math.round(100 * mN(pu.paid) / pv)));
          var pw = el("div", "bz-paid"); pw.appendChild(meter(pp / 100, pp >= 100 ? "ok" : pp >= 50 ? null : "wait")); pw.appendChild(money(el("small", pp >= 100 ? "bz-t-ok" : null, pp + "% paid"))); val.appendChild(pw); }
        else val.appendChild(el("small", "bz-muted", MFIN ? "No payments yet" : ""));
        a.appendChild(val); tbl.appendChild(a);
      });
      b.appendChild(tbl);
      if (list.length > 8) b.appendChild(el("p", "bz-note", "+" + (list.length - 8) + " more in the next 30 days."));
    })();

    /* ---- pipeline funnel with values + conversion ---- */
    (function () {
      var b = body(cPipe);
      var sum2 = function (l) { return l.reduce(function (s, q) { return s + (qCur(q) === CUR ? Number(q.total) || 0 : 0); }, 0); };
      var quoted = rows.filter(function (q) { return q.status === "quote"; }), confd = rows.filter(function (q) { return q.status === "confirmed" && q.lifecycleStage !== "closed"; }),
          done = rows.filter(function (q) { return q.status === "confirmed" && q.lifecycleStage === "closed"; });
      var openLeads = leads.filter(function (l) { var s = String(l.status || "new"); return !l.quote_id && s !== "lost" && s !== "won" && s !== "converted"; }).length;
      if (M && M.leads && typeof M.leads === "object") { openLeads = 0; Object.keys(M.leads).forEach(function (k) { if (k !== "lost" && k !== "won" && k !== "converted") openLeads += mN(M.leads[k]); }); }
      var stages = [];
      if (vLeads) stages.push({ l: "Leads", n: openLeads, v: null, href: "leads.html" });
      var po = mStage("open"), ps = mStage("sent"), pc = mStage("confirmed"), pd = mStage("closed");
      if (vQuotes && po && ps && pc && pd) stages.push({ l: "Quoted", n: po.n + ps.n, v: po.v == null || ps.v == null ? null : po.v + ps.v, href: "quotes.html" },
        { l: "Confirmed", n: pc.n, v: pc.v, href: "quotes.html" }, { l: "Completed", n: pd.n, v: pd.v, href: "quotes.html" });
      else if (vQuotes) stages.push({ l: "Quoted", n: counts && typeof counts.quote === "number" ? counts.quote : quoted.length, v: sum2(quoted), href: "quotes.html" },
        { l: "Confirmed", n: confd.length, v: sum2(confd), href: "quotes.html" }, { l: "Completed", n: done.length, v: sum2(done), href: "quotes.html" });
      var tot = stages.reduce(function (s, x) { return s + x.n; }, 0);
      if (!tot) { empty(b, "No pipeline yet. Add a lead to get started."); return; }
      var mx = Math.max.apply(null, stages.map(function (x) { return x.n; })) || 1, list = el("div", "bz-funnel");
      stages.forEach(function (st, i) {
        if (i) {
          var nextN = 0; for (var j = i; j < stages.length; j++) nextN += Math.max(0, Number(stages[j].n) || 0);
          var prevN = Math.max(0, Number(stages[i - 1].n) || 0) > 0 ? Math.max(0, Number(stages[i - 1].n) || 0) + nextN : 0;
          var conv = prevN > 0 ? Math.min(100, Math.round(100 * nextN / prevN)) : null;
          list.appendChild(el("div", "bz-conv", conv == null || !isFinite(conv) ? "↓ —" : "↓ " + conv + "% moved on"));
        }
        var a = link(st.href, "bz-stage"), tp = el("div", "bz-stage-top");
        tp.appendChild(el("span", null, st.l)); tp.appendChild(el("b", null, num(st.n))); a.appendChild(tp);
        a.appendChild(meter(st.n / mx));
        if (st.v != null) a.appendChild(money(el("small", null, st.v ? compact(st.v) : "—")));
        list.appendChild(a);
      });
      b.appendChild(list);
      b.appendChild(el("p", "bz-caption", "Share of each stage that has moved past the previous one" + (!(MP && po) && pageRes && pageRes.hasMore ? "; values from the 500 most recent quotes." : ".")));
    })();

    /* ---- top clients by value (from the quotes already loaded) ---- */
    (function () {
      var b = body(cTop), by = {};
      curRows.forEach(function (q) {
        if (q.status !== "confirmed" && q.status !== "quote") return;
        var c = q.client || {}, nm = String(c.name || "").trim(); if (!nm) return;
        var k = c.id || nm.toLowerCase(); if (!by[k]) by[k] = { name: nm, v: 0, n: 0, conf: 0 };
        by[k].v += Number(q.total) || 0; by[k].n++; if (q.status === "confirmed") by[k].conf++;
      });
      var list = Object.keys(by).map(function (k) { return by[k]; }).filter(function (x) { return x.v > 0; }).sort(function (a, c) { return c.v - a.v; }).slice(0, 6);
      if (!list.length) { empty(b, "Client totals appear once quotes have a client and a price."); return; }
      var mx = list[0].v || 1, ul = el("ul", "bz-list");
      list.forEach(function (x) {
        var li = el("li", "bz-li bz-client"), m = el("div", "bz-main");
        m.appendChild(el("b", null, x.name)); m.appendChild(el("small", null, x.n + (x.n === 1 ? " event" : " events") + (x.conf ? " · " + x.conf + " confirmed" : "")));
        m.appendChild(meter(x.v / mx)); li.appendChild(m); li.appendChild(money(el("span", "bz-num", compact(x.v)))); ul.appendChild(li);
      });
      b.appendChild(ul);
      b.appendChild(el("p", "bz-caption", "Confirmed + open quotes in " + CUR + (pageRes && pageRes.hasMore ? ", from the 500 most recently updated quotes." : ".")));
    })();

    note.textContent = M ? "Exact numbers from your payment ledger." : "Showing estimates from your latest quotes (exact ledger numbers aren't available on this account yet).";
  }

  window.HelmMoney = { mount: mount, compact: compact, full: full,
    /* shared with dashboard Demo 2 (shell-b-dash2.js); additive, the Business page is unchanged */
    setCurrency: function (c) { if (c) CUR = String(c).toUpperCase(); }, currency: function () { return CUR; },
    money: money, revenueBars: revenueBars };
})();
