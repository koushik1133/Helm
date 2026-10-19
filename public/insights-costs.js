/* insights-costs.js - r21 Insights: "Event costs & profit" charts + "Benchmarks" (vanilla SVG + DOM, no libraries).
 * Data: BPStore.insights.costs(from, to) -> insights_event_costs (0240). One row per confirmed event:
 *   revenue (ex-tax), tax, vendors / crew / logistics / rentals / change_orders / other_costs / expense_claims / refunds,
 *   cost_total, profit (= event_pnl net profit), margin_pct, collected, outstanding, event_type, guests, currency.
 * Privacy ("Hide amounts"): charts keep their shapes, but every amount (axis ticks, tooltips, legends, labels) is "••••"
 * while amounts are hidden; percentages stay. The charts re-draw when the eye button is toggled.
 * No HTML-string sinks and no style= attributes: DOM via createElement / textContent, sizes via SVG attributes / CSSOM.
 * Pure helpers (median, benchmarks, trend, totals; r22: alignEvents, moneyByCurrency) are exported for
 * test/insights-costs-r21.test.mjs + test/r22-money.test.mjs. */
(function (root) {
  "use strict";
  var NS = "http://www.w3.org/2000/svg", MASK = "••••";
  var CATS = [
    { k: "vendors", label: "Vendors" }, { k: "crew", label: "Crew & staff" }, { k: "logistics", label: "Logistics" },
    { k: "rentals", label: "Rentals & inventory" }, { k: "expense_claims", label: "Expense claims" },
    { k: "change_orders", label: "Change orders" }, { k: "other_costs", label: "Miscellaneous" }, { k: "refunds", label: "Refunds to client" }
  ];
  var DEFAULT_TARGET = 30;           // target margin % until the studio sets one (Control Center, 0242)
  var TARGET_KEY = "helm_ins_target_margin";   // retired per-device value (before 0242): offered once to the studio, then removed

  /* ---------------- pure helpers ---------------- */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function typeKey(t) { return String(t == null ? "" : t).trim().replace(/\s+/g, " ").toLowerCase(); }
  function typeTitle(k) { return k ? k.replace(/(^|[\s\-\/])(\S)/g, function (m, a, b) { return a + b.toUpperCase(); }) : "Other"; }
  function median(list) {
    var a = (list || []).filter(function (x) { return x != null && isFinite(x); }).map(Number).sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    var m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function cur(r) { return String((r && r.currency) || "INR").toUpperCase(); }
  function costOf(r) {   // cost_total from the server; else the parts
    if (r && r.cost_total != null) return num(r.cost_total);
    return CATS.reduce(function (a, c) { return a + num(r && r[c.k]); }, 0);
  }
  function marginOf(r) { var rev = num(r && r.revenue); return rev > 0 ? Math.round(num(r.profit) / rev * 100) : null; }
  function perGuest(v, r) { var g = num(r && r.guests); return g > 0 ? v / g : null; }
  // share of revenue per cost category (percent, 1 decimal); null when there is no revenue
  function mixOf(r) {
    var rev = num(r && r.revenue), o = {};
    CATS.forEach(function (c) { o[c.k] = rev > 0 ? Math.round(num(r[c.k]) / rev * 1000) / 10 : null; });
    return o;
  }
  function totals(rows) {
    var t = { revenue: 0, cost: 0, profit: 0, collected: 0, outstanding: 0, n: 0 };
    CATS.forEach(function (c) { t[c.k] = 0; });
    (rows || []).forEach(function (r) {
      t.n++; t.revenue += num(r.revenue); t.cost += costOf(r); t.profit += num(r.profit);
      t.collected += num(r.collected); t.outstanding += num(r.outstanding);
      CATS.forEach(function (c) { t[c.k] += num(r[c.k]); });
    });
    t.margin = t.revenue > 0 ? Math.round(t.profit / t.revenue * 100) : null;
    return t;
  }
  /* r22 money: ONE profit source on Insights. The older per-event table (insights_events) and the Money tiles
   * (insights_range) left the crew wages of the 0246 ledger out, so they showed e.g. 100% where this card, Benchmarks
   * and Business showed 98%. These two helpers put the ledger numbers (insights_event_costs = event_pnl) on them. */
  function inRangeDay(r, from, to) { var d = String((r && r.date) || "").slice(0, 10); return (!from || d >= from) && (!to || d <= to); }
  // per-event rows (insights_events*) -> same rows with revenue / cost / profit / margin / collected / outstanding
  // taken from the ledger row of the same event (rows without one are left exactly as they came)
  function alignEvents(peRows, costRows) {
    var by = {};
    (costRows || []).forEach(function (r) { if (r && r.id != null) by[String(r.id)] = r; });
    return (peRows || []).map(function (p) {
      var r = p && p.id != null ? by[String(p.id)] : null;
      if (!r) return p;
      var o = {}, k; for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) o[k] = p[k];
      var m = marginOf(r);
      o.revenue_ex_tax = num(r.revenue); o.cost = costOf(r); o.profit = num(r.profit); o.profit_ex_tax = num(r.profit);
      o.margin_pct = m; o.margin_pct_ex_tax = m;
      if (r.collected != null) o.collected = num(r.collected);
      if (r.outstanding != null) o.outstanding = num(r.outstanding);
      o.ledger = true;
      return o;
    });
  }
  // Money tiles: the ledger totals of the events dated in [from, to], one entry per currency, same keys as
  // insights_range money (cost = delivery, expenses = expense claims; cost + expenses = the card's Cost)
  function moneyByCurrency(costRows, from, to) {
    var g = {};
    (costRows || []).filter(function (r) { return inRangeDay(r, from, to); }).forEach(function (r) { var c = cur(r); (g[c] = g[c] || []).push(r); });
    var out = {};
    Object.keys(g).forEach(function (c) {
      var t = totals(g[c]), exp = g[c].reduce(function (a, r) { return a + num(r.expense_claims); }, 0);
      out[c] = { currency: c, events: t.n, revenue_ex_tax: t.revenue, cost: t.cost - exp, expenses: exp,
        profit: t.profit, profit_ex_tax: t.profit, margin_pct: t.margin, margin_pct_ex_tax: t.margin,
        collected: t.collected, outstanding: t.outstanding, ledger: true };
    });
    return out;
  }
  function badgeFor(margin, target) {
    if (margin == null) return "na";
    if (margin >= target) return "good";
    if (margin >= target - 10 && margin >= 0) return "watch";
    return "poor";
  }
  /* Benchmarks: each event against the studio's own typical (median) for the same event type and currency
   * (needs 2+ other events of that type with revenue), else against every other event in that currency (2+),
   * else only against the target margin. money(n, currency) formats an amount (or masks it). */
  function benchmarks(rows, opts) {
    opts = opts || {};
    var target = isFinite(Number(opts.target)) ? Number(opts.target) : DEFAULT_TARGET;
    var money = typeof opts.money === "function" ? opts.money : function (n) { return String(Math.round(n)); };
    var withRev = (rows || []).filter(function (r) { return num(r.revenue) > 0; });
    return (rows || []).map(function (r) {
      var margin = marginOf(r), c = cur(r), tk = typeKey(r.event_type);
      var others = withRev.filter(function (x) { return x !== r && x.id !== r.id && cur(x) === c; });
      var same = others.filter(function (x) { return typeKey(x.event_type) === tk; });
      var basis = null, peers = [];
      if (tk && same.length >= 2) { basis = "type"; peers = same; } else if (others.length >= 2) { basis = "studio"; peers = others; }
      var peer = null;
      if (basis) {
        peer = { n: peers.length, basis: basis, label: basis === "type" ? typeTitle(tk) : "all events",
          margin: median(peers.map(marginOf)),
          costPerGuest: median(peers.map(function (x) { return perGuest(costOf(x), x); })),
          revPerGuest: median(peers.map(function (x) { return perGuest(num(x.revenue), x); })), mix: {} };
        CATS.forEach(function (k) { peer.mix[k.k] = median(peers.map(function (x) { return mixOf(x)[k.k]; })); });
      }
      var out = { id: r.id, margin: margin, target: target, badge: badgeFor(margin, target), peer: peer,
        costPerGuest: perGuest(costOf(r), r), revPerGuest: perGuest(num(r.revenue), r), mix: mixOf(r), why: "" };
      if (out.badge === "na") { out.why = "No revenue recorded yet - margin cannot be measured."; return out; }
      var where = peer ? (peer.basis === "type" ? " typical for " + peer.label + " events" : " studio typical") : "";
      // biggest cost category above the typical share of revenue (5+ points)
      var worst = null;
      if (peer) CATS.forEach(function (k) {
        var a = out.mix[k.k], b = peer.mix[k.k];
        if (a == null || b == null || a < 5) return;
        var gap = a - b; if (gap >= 5 && (!worst || gap > worst.gap)) worst = { k: k, a: a, b: b, gap: gap };
      });
      var cpgHigh = peer && out.costPerGuest != null && peer.costPerGuest != null && peer.costPerGuest > 0 && out.costPerGuest / peer.costPerGuest >= 1.15;
      if (out.badge === "good" && !worst) {
        out.why = "Margin " + margin + "% - " + (margin - target === 0 ? "on" : Math.round((margin - target) * 10) / 10 + " pts above") + " your " + target + "% target" +
          (peer && peer.margin != null ? " (" + Math.round(peer.margin) + "%" + where + ")" : "") + ".";
      } else if (worst) {
        out.why = worst.k.label + " " + fmtPct(worst.a) + " of revenue vs " + fmtPct(worst.b) + where + ".";
      } else if (cpgHigh) {
        out.why = "Cost per guest " + money(out.costPerGuest, c) + " vs " + money(peer.costPerGuest, c) + where + ".";
      } else {
        out.why = "Margin " + margin + "% vs your " + target + "% target" + (peer && peer.margin != null ? " (" + Math.round(peer.margin) + "%" + where + ")" : "") + ".";
      }
      return out;
    });
  }
  function fmtPct(v) { return v == null ? "-" : (Math.round(v * 10) / 10) + "%"; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseDay(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  /* Trend buckets between from and to (both "YYYY-MM-DD"; missing = the data's own first / last day):
   * weeks (Monday start) for spans up to 62 days, else months; empty buckets kept; at most 24 (the latest). */
  function trend(rows, from, to) {
    var days = (rows || []).map(function (r) { return parseDay(r.date); }).filter(Boolean).sort(function (a, b) { return a - b; });
    var a = parseDay(from) || days[0], b = parseDay(to) || days[days.length - 1];
    if (!a || !b || b < a) return { unit: "month", buckets: [] };
    if (days.length) { if (a < days[0] && !parseDay(from)) a = days[0]; if (b > days[days.length - 1] && !parseDay(to)) b = days[days.length - 1]; }
    var span = Math.round((b - a) / 864e5) + 1, unit = span <= 62 ? "week" : "month";
    var keyOf = function (d) {
      if (unit === "month") return d.getFullYear() + "-" + pad(d.getMonth() + 1);
      var m = new Date(d.getFullYear(), d.getMonth(), d.getDate()); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); return ymd(m);
    };
    var labelOf = function (k) {
      if (unit === "month") { var p = k.split("-"); return MON[+p[1] - 1] + " " + p[0].slice(2); }
      var d = parseDay(k); return d.getDate() + " " + MON[d.getMonth()];
    };
    var list = [], seen = {}, d = new Date(a.getFullYear(), a.getMonth(), a.getDate()), guard = 0;
    while (d <= b && guard++ < 4000) { var k = keyOf(d); if (!seen[k]) { seen[k] = { key: k, label: labelOf(k), revenue: 0, cost: 0, profit: 0, n: 0 }; list.push(seen[k]); }
      if (unit === "month") d = new Date(d.getFullYear(), d.getMonth() + 1, 1); else d.setDate(d.getDate() + 1); }
    (rows || []).forEach(function (r) { var dd = parseDay(r.date); if (!dd) return; var bk = seen[keyOf(dd)]; if (!bk) return;
      bk.n++; bk.revenue += num(r.revenue); bk.cost += costOf(r); bk.profit += num(r.profit); });
    return { unit: unit, buckets: list.slice(-24) };
  }
  // compact axis numbers: 12.5L / 1.2Cr for INR, 50K / 1.2M otherwise
  function compact(n, c) {
    var a = Math.abs(n), s = n < 0 ? "-" : "", r = function (x) { return String(Math.round(x * 10) / 10); };
    if (c === "INR") { if (a >= 1e7) return s + r(a / 1e7) + "Cr"; if (a >= 1e5) return s + r(a / 1e5) + "L"; if (a >= 1e3) return s + r(a / 1e3) + "K"; return s + Math.round(a); }
    if (a >= 1e6) return s + r(a / 1e6) + "M"; if (a >= 1e3) return s + r(a / 1e3) + "K"; return s + Math.round(a);
  }
  // axis: a "nice" step (1 / 2 / 2.5 / 5 x 10^n) so ticks read 0, 5L, 10L ... and the range covers min..max (min <= 0)
  function ticks(min, max) {
    min = Math.min(0, min || 0); max = Math.max(0, max || 0); if (max === min) max = min + 1;
    var step = niceMax((max - min) / 4), lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, out = [];
    for (var v = lo, g = 0; v <= hi + step / 2 && g < 12; v += step, g++) out.push(Math.round(v * 100) / 100);
    return { lo: lo, hi: hi, list: out };
  }
  function niceMax(v) { if (!(v > 0)) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

  /* ---------------- DOM helpers ---------------- */
  function H(tag, cls, text, parent) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; }
  function S(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, String(attrs[k])); if (parent) parent.appendChild(e); return e; }
  /* r21 (0242): the target margin is ONE studio-wide value (Control Center). The old per-device value is only read
   * to offer it once to someone who can edit Control Center, then removed. */
  function readDeviceTarget() { try { var raw = String(localStorage.getItem(TARGET_KEY) || "").trim(), v = Number(raw); if (raw !== "" && isFinite(v)) return Math.round(v); } catch (e) {} return null; }
  function forgetDeviceTarget() { try { localStorage.removeItem(TARGET_KEY); } catch (e) {} }

  /* ---------------- the component ---------------- */
  /* mount(costHost, benchHost, ctx) -> { set(data), clear(msg) }
   *   ctx.money(n, currency) - formatted amount; ctx.hidden() - amounts hidden?; ctx.href(id) - event link;
   *   ctx.fmtDate(d); ctx.studioCurrency() ; data = { rows (benchmark window), from, to } */
  function mount(costHost, benchHost, ctx) {
    var st = { rows: [], from: null, to: null, sel: "all", cur: null, target: DEFAULT_TARGET, msg: "", ready: false,
      tm: { loaded: false, missing: false, studio: null, canEdit: false, offer: null, busy: false, err: "" } };
    var hidden = function () { try { return !!ctx.hidden(); } catch (e) { return false; } };
    var M = function (n, c) { return hidden() ? MASK : ctx.money(n, c); };
    var inPeriod = function (r) { var d = String(r.date || "").slice(0, 10); return (!st.from || d >= st.from) && (!st.to || d <= st.to); };
    var label = function (r) { return (r.code || "Event") + (r.title && r.title !== r.code ? " · " + r.title : ""); };
    var tip = null, tipHost = null;

    function showTip(host, evt, lines) {
      if (!tip || tipHost !== host) { if (tip) tip.remove(); tip = H("div", "ic-tip"); tip.setAttribute("role", "tooltip"); host.appendChild(tip); tipHost = host; }
      tip.textContent = "";
      lines.forEach(function (l, i) { var p = H("div", i === 0 ? "ic-tip-h" : "ic-tip-l", null, tip);
        if (Array.isArray(l)) { H("span", "ic-tip-k" + (l[2] ? " " + l[2] : ""), l[0], p); H("b", null, l[1], p); } else p.textContent = l; });
      tip.hidden = false;
      var hb = host.getBoundingClientRect(), x, y;
      if (evt && evt.clientX != null && evt.type !== "focus") { x = evt.clientX - hb.left; y = evt.clientY - hb.top; }
      else { var tb = evt.target.getBoundingClientRect(); x = tb.left - hb.left + tb.width / 2; y = tb.top - hb.top; }
      var w = tip.offsetWidth || 200, h = tip.offsetHeight || 60;
      var left = Math.max(4, Math.min(hb.width - w - 4, x + 14)), top = y - h - 12; if (top < 4) top = y + 18;
      tip.style.left = Math.round(left) + "px"; tip.style.top = Math.round(top) + "px";
    }
    function hideTip() { if (tip) tip.hidden = true; }
    function hook(el, host, lines, onPick, aria) {
      el.setAttribute("tabindex", "0"); el.setAttribute("role", "button"); el.setAttribute("aria-label", aria || (Array.isArray(lines[0]) ? lines[0].join(" ") : lines[0]));
      el.addEventListener("pointermove", function (e) { showTip(host, e, lines); });
      el.addEventListener("pointerleave", hideTip);
      el.addEventListener("focus", function (e) { showTip(host, e, lines); });
      el.addEventListener("blur", hideTip);
      if (onPick) { el.addEventListener("click", onPick); el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } }); }
    }
    function pick(id) { st.sel = id || "all"; render(); try { costHost.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {} }

    function currencies() {
      var seen = {}, list = [];
      st.rows.forEach(function (r) { var c = cur(r); if (!seen[c]) { seen[c] = 1; list.push(c); } });
      var home = (ctx.studioCurrency && ctx.studioCurrency()) || "INR";
      list.sort(function (a, b) { return (a === home ? -1 : 0) - (b === home ? -1 : 0) || (a < b ? -1 : a > b ? 1 : 0); });
      return list;
    }

    /* --- chart: revenue / cost / profit per event (grouped columns) --- */
    function chartGroups(host, rows, c) {
      var box = H("div", "ic-chart", null, host), W = Math.max(300, Math.round(host.clientWidth || 640)), Hh = 230, padL = hidden() ? 12 : 54, padB = 34, padT = 10;
      var gw = Math.max(62, Math.min(96, (W - padL - 8) / Math.max(rows.length, 1)));
      var vw = Math.max(W, Math.round(padL + gw * rows.length + 8));
      if (vw > W) box.classList.add("ic-scroll");
      var svg = S("svg", { viewBox: "0 0 " + vw + " " + Hh, width: vw, height: Hh, role: "img", "aria-label": "Revenue, cost and profit by event", class: "ic-svg" }, box);
      var max = 0, min = 0;
      rows.forEach(function (r) { max = Math.max(max, num(r.revenue), costOf(r), num(r.profit)); min = Math.min(min, num(r.profit)); });
      var tk = ticks(min, max), top = tk.hi, bot = tk.lo, ih = Hh - padT - padB;
      var y = function (v) { return padT + (top - v) / (top - bot) * ih; };
      tk.list.forEach(function (v) { var yy = y(v);
        S("line", { x1: padL, x2: vw - 4, y1: yy, y2: yy, class: "ic-grid" }, svg);
        if (!hidden()) S("text", { x: padL - 6, y: yy + 4, class: "ic-ax", "text-anchor": "end" }, svg).textContent = compact(v, c); });
      if (bot < 0) S("line", { x1: padL, x2: vw - 4, y1: y(0), y2: y(0), class: "ic-zero" }, svg);
      var bw = Math.max(8, Math.min(22, (gw - 14) / 3));
      rows.forEach(function (r, i) {
        var gx = padL + gw * i + (gw - bw * 3 - 4) / 2;
        [["revenue", num(r.revenue), "ic-rev"], ["cost", costOf(r), "ic-cost"], ["profit", num(r.profit), num(r.profit) < 0 ? "ic-loss" : "ic-prof"]].forEach(function (b, j) {
          var y0 = y(Math.max(0, b[1])), y1 = y(Math.min(0, b[1]));
          S("rect", { x: gx + j * (bw + 2), y: y0, width: bw, height: Math.max(1, y1 - y0), rx: 2, class: "ic-bar " + b[2] }, svg);
        });
        var t = S("text", { x: padL + gw * i + gw / 2, y: Hh - padB + 16, class: "ic-xl", "text-anchor": "middle" }, svg);
        var code = String(r.code || "Event"); t.textContent = code.length > 11 ? code.slice(0, 10) + "…" : code;
        var hit = S("rect", { x: padL + gw * i, y: padT, width: gw, height: Hh - padT - 4, class: "ic-hit" }, svg);
        var m = marginOf(r);
        hook(hit, host, [label(r) + (r.date ? " · " + ctx.fmtDate(r.date) : ""), ["Revenue", M(r.revenue, c), "k-rev"], ["Cost", M(costOf(r), c), "k-cost"],
          ["Profit", M(r.profit, c), num(r.profit) < 0 ? "k-loss" : "k-prof"], ["Margin", m == null ? "-" : m + "%"], "Click to see this event's costs"],
          function () { pick(r.id); }, label(r) + ": margin " + (m == null ? "not measured" : m + "%") + ". Show this event's costs.");
      });
      var lg = H("div", "ic-legend", null, host);
      [["ic-rev", "Revenue (ex-tax)"], ["ic-cost", "Cost"], ["ic-prof", "Profit"]].forEach(function (x) { var s = H("span", null, null, lg); H("i", x[0], null, s); s.appendChild(document.createTextNode(x[1])); });
      if (hidden()) H("span", "ic-note", "Amounts hidden - bar heights still compare events.", lg);
    }

    /* --- chart: cost breakdown donut + legend --- */
    function chartDonut(host, t, c) {
      var wrap = H("div", "ic-donut", null, host), total = CATS.reduce(function (a, k) { return a + Math.max(0, t[k.k]); }, 0);
      if (!(total > 0)) { H("div", "ic-empty", "No costs recorded for these events yet. Add cost lines on the event's Budget page, vendor bills or expense claims.", wrap); return; }
      var R = 70, r0 = 44, cx = 80, cy = 80;
      var svg = S("svg", { viewBox: "0 0 160 160", width: 160, height: 160, role: "img", "aria-label": "Cost breakdown by category", class: "ic-svg ic-pie" }, wrap);
      var a0 = -Math.PI / 2, list = H("ul", "ic-cats", null, wrap);
      CATS.forEach(function (k, i) {
        var v = Math.max(0, t[k.k]); if (!(v > 0)) return;
        var share = v / total, a1 = a0 + share * Math.PI * 2, big = share > 0.5 ? 1 : 0;
        var p = function (a, rr) { return (cx + rr * Math.cos(a)).toFixed(2) + " " + (cy + rr * Math.sin(a)).toFixed(2); };
        var d = share >= 0.9999 ? "M " + p(-Math.PI / 2, R) + " A " + R + " " + R + " 0 1 1 " + p(Math.PI * 1.5 - 0.0001, R) + " L " + p(Math.PI * 1.5 - 0.0001, r0) + " A " + r0 + " " + r0 + " 0 1 0 " + p(-Math.PI / 2, r0) + " Z"
          : "M " + p(a0, R) + " A " + R + " " + R + " 0 " + big + " 1 " + p(a1, R) + " L " + p(a1, r0) + " A " + r0 + " " + r0 + " 0 " + big + " 0 " + p(a0, r0) + " Z";
        var seg = S("path", { d: d, class: "ic-seg ic-c" + i }, svg);
        var pct = Math.round(share * 1000) / 10, revPct = t.revenue > 0 ? Math.round(v / t.revenue * 1000) / 10 : null;
        var lines = [k.label, ["Amount", M(v, c)], ["Share of cost", pct + "%"], ["Share of revenue", revPct == null ? "-" : revPct + "%"]];
        hook(seg, host, lines, null, k.label + ": " + pct + "% of cost");
        var li = H("li", null, null, list); H("i", "ic-c" + i, null, li); H("span", "ic-cn", k.label, li); H("span", "ic-cv", M(v, c), li); H("span", "ic-cp", pct + "%", li);
        a0 = a1;
      });
      var ct = S("text", { x: cx, y: cy - 4, class: "ic-ctr-l", "text-anchor": "middle" }, svg); ct.textContent = "Total cost";
      var cv = S("text", { x: cx, y: cy + 13, class: "ic-ctr-v", "text-anchor": "middle" }, svg); cv.textContent = hidden() ? MASK : compact(total, c);
    }

    /* --- chart: collected vs outstanding per event (stacked rows) --- */
    function chartCollect(host, rows, c) {
      var list = rows.slice().sort(function (a, b) { return num(b.outstanding) - num(a.outstanding) || num(b.revenue) - num(a.revenue); }).slice(0, 10);
      var box = H("div", "ic-rows", null, host);
      list.forEach(function (r) {
        var col = Math.max(0, num(r.collected)), out = Math.max(0, num(r.outstanding)), tot = col + out, pc = tot > 0 ? Math.round(col / tot * 100) : 0;
        var row = H("div", "ic-row", null, box);
        H("span", "ic-rl", r.code || "Event", row).title = label(r);
        var tr = H("span", "ic-track", null, row), a = H("span", "ic-seg-a", null, tr), b = H("span", "ic-seg-b", null, tr);
        a.style.width = (tot ? pc : 0) + "%"; b.style.width = (tot ? 100 - pc : 0) + "%";
        H("span", "ic-rv", tot ? pc + "% in" : "-", row);
        hook(row, host, [label(r), ["Collected", M(col, c), "k-col"], ["Outstanding", M(out, c), "k-out"], ["Collected so far", pc + "%"], "Click to see this event's costs"],
          function () { pick(r.id); }, label(r) + ": " + pc + "% collected");
      });
      if (rows.length > list.length) H("div", "ic-note", "Showing the 10 events with the most still to collect.", host);
      var lg = H("div", "ic-legend", null, host);
      [["ic-seg-a", "Collected"], ["ic-seg-b", "Outstanding (incl. tax)"]].forEach(function (x) { var s = H("span", null, null, lg); H("i", x[0], null, s); s.appendChild(document.createTextNode(x[1])); });
    }

    /* --- chart: trend over time (lines) --- */
    function chartTrend(host, rows, c) {
      var tr = trend(rows, st.from, st.to), bk = tr.buckets;
      if (bk.filter(function (b) { return b.n; }).length < 2) { H("div", "ic-empty", "Pick a longer period (or one with events in two or more " + tr.unit + "s) to see a trend.", host); return; }
      var W = Math.max(300, Math.round(host.clientWidth || 640)), Hh = 210, padL = hidden() ? 12 : 54, padB = 30, padT = 10, ih = Hh - padT - padB;
      var svg = S("svg", { viewBox: "0 0 " + W + " " + Hh, width: W, height: Hh, role: "img", "aria-label": "Revenue, cost and profit by " + tr.unit, class: "ic-svg" }, H("div", "ic-chart", null, host));
      var max = 0, min = 0; bk.forEach(function (b) { max = Math.max(max, b.revenue, b.cost, b.profit); min = Math.min(min, b.profit); });
      var tk = ticks(min, max), top = tk.hi, bot = tk.lo;
      var y = function (v) { return padT + (top - v) / (top - bot) * ih; }, step = (W - padL - 16) / Math.max(bk.length - 1, 1), x = function (i) { return padL + 8 + step * i; };
      tk.list.forEach(function (v) {
        S("line", { x1: padL, x2: W - 4, y1: y(v), y2: y(v), class: "ic-grid" }, svg);
        if (!hidden()) S("text", { x: padL - 6, y: y(v) + 4, class: "ic-ax", "text-anchor": "end" }, svg).textContent = compact(v, c); });
      if (bot < 0) S("line", { x1: padL, x2: W - 4, y1: y(0), y2: y(0), class: "ic-zero" }, svg);
      var every = Math.ceil(bk.length / Math.max(1, Math.floor((W - padL) / 64)));
      bk.forEach(function (b, i) { if (i % every === 0 || i === bk.length - 1) S("text", { x: x(i), y: Hh - 10, class: "ic-xl", "text-anchor": "middle" }, svg).textContent = b.label; });
      [["revenue", "ic-l-rev"], ["cost", "ic-l-cost"], ["profit", "ic-l-prof"]].forEach(function (s) {
        S("path", { d: bk.map(function (b, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(b[s[0]]).toFixed(1); }).join(" "), class: "ic-line " + s[1] }, svg);
        bk.forEach(function (b, i) { S("circle", { cx: x(i), cy: y(b[s[0]]), r: 3, class: "ic-dot " + s[1] }, svg); });
      });
      bk.forEach(function (b, i) {
        var hit = S("rect", { x: x(i) - step / 2, y: padT, width: Math.max(step, 12), height: ih, class: "ic-hit" }, svg);
        var m = b.revenue > 0 ? Math.round(b.profit / b.revenue * 100) : null;
        hook(hit, host, [(tr.unit === "week" ? "Week of " : "") + b.label + " · " + b.n + " event" + (b.n === 1 ? "" : "s"), ["Revenue", M(b.revenue, c), "k-rev"], ["Cost", M(b.cost, c), "k-cost"],
          ["Profit", M(b.profit, c), b.profit < 0 ? "k-loss" : "k-prof"], ["Margin", m == null ? "-" : m + "%"]], null, b.label + ": " + b.n + " events, margin " + (m == null ? "not measured" : m + "%"));
      });
      var lg = H("div", "ic-legend", null, host);
      [["ic-rev", "Revenue"], ["ic-cost", "Cost"], ["ic-prof", "Profit"]].forEach(function (z) { var s = H("span", null, null, lg); H("i", z[0], null, s); s.appendChild(document.createTextNode(z[1])); });
    }

    function badge(parent, b) {
      var t = { good: "On target", watch: "Watch", poor: "Below target", na: "No revenue" }[b] || b;
      return H("span", "ic-badge ic-b-" + b, t, parent);
    }

    /* --- one event --- */
    function renderOne(body, r, bm, c) {
      var head = H("div", "ic-ev-head", null, body);
      var tl = H("div", "ic-ev-t", null, head);
      H("div", "ic-ev-name", label(r), tl);
      H("div", "ic-ev-meta", [r.date ? ctx.fmtDate(r.date) : null, r.event_type ? typeTitle(typeKey(r.event_type)) : null, num(r.guests) > 0 ? num(r.guests) + " guests" : "guests not set"].filter(Boolean).join(" · "), tl);
      var acts = H("div", "ic-ev-acts", null, head);
      if (bm) badge(acts, bm.badge);
      var a = H("a", "ic-open", "Open event →", acts); a.href = ctx.href(r.id);
      var back = H("button", "ic-back", "← All events", acts); back.type = "button"; back.addEventListener("click", function () { pick("all"); });
      var k = H("div", "ic-mini", null, body), m = marginOf(r);
      [["Revenue (ex-tax)", M(r.revenue, c), ""], ["Cost", M(costOf(r), c), ""], ["Profit", M(r.profit, c), num(r.profit) < 0 ? "neg" : "pos"], ["Margin", m == null ? "-" : m + "%", m != null && m < 0 ? "neg" : ""],
       ["Collected", M(r.collected, c), ""], ["Outstanding", M(r.outstanding, c), num(r.outstanding) > 0 ? "warn" : ""]].forEach(function (x) {
        var d = H("div", "ic-m", null, k); H("div", "ic-mv " + x[2], x[1], d); H("div", "ic-ml", x[0], d); });
      var g = H("div", "ic-grid2", null, body);
      var p1 = H("section", "ic-panel", null, g); H("h4", null, "Where the money goes", p1); chartDonut(p1, totals([r]), c);
      var p2 = H("section", "ic-panel", null, g); H("h4", null, "How it compares", p2);
      if (bm) {
        H("p", "ic-why ic-why-" + bm.badge, bm.why, p2);
        var t = H("table", "ic-cmp", null, p2); t.setAttribute("data-tm", "off");   /* 3 short columns fit a phone: no stacked cards */
        var th = H("tr", null, null, H("thead", null, null, t));
        ["", "This event", bm.peer ? "Typical (" + bm.peer.label + ", " + bm.peer.n + ")" : "Typical"].forEach(function (x) { H("th", null, x, th).scope = "col"; });
        var tb = H("tbody", null, null, t), P = bm.peer;
        var rowc = function (l, a2, b2, bad) { var tr = H("tr", bad ? "ic-off" : null, null, tb); H("th", null, l, tr).scope = "row"; H("td", null, a2, tr); H("td", null, b2, tr); };
        rowc("Margin (target " + bm.target + "%)", m == null ? "-" : m + "%", P && P.margin != null ? Math.round(P.margin) + "%" : "-", m != null && m < bm.target);
        rowc("Cost per guest", bm.costPerGuest == null ? "-" : M(bm.costPerGuest, c), P && P.costPerGuest != null ? M(P.costPerGuest, c) : "-", P && bm.costPerGuest != null && P.costPerGuest > 0 && bm.costPerGuest / P.costPerGuest >= 1.15);
        rowc("Revenue per guest", bm.revPerGuest == null ? "-" : M(bm.revPerGuest, c), P && P.revPerGuest != null ? M(P.revPerGuest, c) : "-", false);
        CATS.forEach(function (cc) { var a3 = bm.mix[cc.k], b3 = P ? P.mix[cc.k] : null; if (!(a3 > 0) && !(b3 > 0)) return;
          rowc(cc.label + " (% of revenue)", fmtPct(a3), fmtPct(b3), a3 != null && b3 != null && a3 - b3 >= 5 && a3 >= 5); });
        if (!P) H("p", "ic-note", "Not enough other events in this currency yet to compare against - only the target margin is used.", p2);
      }
      var p3 = H("section", "ic-panel ic-wide", null, body); H("h4", null, "Collected vs outstanding", p3); chartCollect(p3, [r], c);
    }

    var waits = 0;
    function render() {
      /* not laid out yet (section still hidden): draw once it has a width, so the charts measure their real size */
      if (!costHost.clientWidth && waits < 20 && typeof requestAnimationFrame === "function") { waits++; requestAnimationFrame(render); return; }
      waits = 0;
      hideTip(); tip = null; tipHost = null;
      costHost.textContent = ""; if (benchHost) benchHost.textContent = "";
      if (st.msg) { H("div", "ic-empty", st.msg, costHost); if (benchHost) H("div", "ic-empty", st.msg, benchHost); return; }
      var curs = currencies();
      if (!st.cur || curs.indexOf(st.cur) < 0) st.cur = curs[0] || null;
      var c = st.cur || "INR";
      var rowsC = st.rows.filter(function (r) { return cur(r) === c; }), period = rowsC.filter(inPeriod);
      if (st.sel !== "all" && !period.some(function (r) { return r.id === st.sel; })) st.sel = "all";
      /* toolbar */
      var bar = H("div", "ic-tools", null, costHost);
      var fl = H("label", "ic-f", null, bar); H("span", null, "Event", fl);
      var sel = H("select", null, null, fl); sel.id = "icEvent";
      var o0 = H("option", null, "All events in this period (" + period.length + ")", sel); o0.value = "all";
      period.forEach(function (r) { var o = H("option", null, label(r) + (r.date ? " · " + ctx.fmtDate(r.date) : ""), sel); o.value = r.id; });
      sel.value = st.sel; sel.addEventListener("change", function () { pick(sel.value); });
      if (curs.length > 1) {
        var cl = H("label", "ic-f", null, bar); H("span", null, "Currency", cl);
        var cs = H("select", null, null, cl); curs.forEach(function (x) { H("option", null, x, cs).value = x; }); cs.value = c;
        cs.addEventListener("change", function () { st.cur = cs.value; st.sel = "all"; render(); });
        H("span", "ic-note", "Each currency is charted on its own (no conversion).", bar);
      }
      var body = H("div", "ic-body", null, costHost);
      var bms = benchmarks(rowsC, { target: st.target, money: M }), bmBy = {}; bms.forEach(function (b) { bmBy[b.id] = b; });
      if (!period.length) H("div", "ic-empty", "No confirmed events in this period" + (curs.length > 1 ? " in " + c : "") + ".", body);
      else if (st.sel !== "all") { var one = period.filter(function (r) { return r.id === st.sel; })[0]; renderOne(body, one, bmBy[one.id], c); }
      else {
        var t = totals(period);
        var sum = H("div", "ic-mini", null, body);
        [["Revenue (ex-tax)", M(t.revenue, c), ""], ["Cost", M(t.cost, c), ""], ["Profit", M(t.profit, c), t.profit < 0 ? "neg" : "pos"], ["Margin", t.margin == null ? "-" : t.margin + "%", ""],
         ["Collected", M(t.collected, c), ""], ["Outstanding", M(t.outstanding, c), t.outstanding > 0 ? "warn" : ""]].forEach(function (x) {
          var d = H("div", "ic-m", null, sum); H("div", "ic-mv " + x[2], x[1], d); H("div", "ic-ml", x[0], d); });
        var p1 = H("section", "ic-panel ic-wide", null, body); H("h4", null, "Revenue, cost & profit by event", p1);
        H("p", "ic-hint", "Hover a column for the numbers; click it to open that event's cost breakdown.", p1);
        chartGroups(p1, period.slice().sort(function (a, b) { return String(a.date || "").localeCompare(String(b.date || "")); }), c);
        var g = H("div", "ic-grid2", null, body);
        var p2 = H("section", "ic-panel", null, g); H("h4", null, "Where the money goes", p2); chartDonut(p2, t, c);
        var p3 = H("section", "ic-panel", null, g); H("h4", null, "Collected vs outstanding", p3); chartCollect(p3, period, c);
        var p4 = H("section", "ic-panel ic-wide", null, body); H("h4", null, "Over time", p4); chartTrend(p4, period, c);
      }
      if (benchHost) renderBench(benchHost, period, bmBy, c);
    }

    /* once: this device had its own target before 0242 and the studio has none yet - offer it to an editor */
    function renderOffer(host) {
      var v = st.tm.offer, box = H("div", "ic-offer", null, host); box.setAttribute("role", "region"); box.setAttribute("aria-label", "Studio target margin");
      H("p", null, "This device used a " + fmtPct(v) + " target margin. Targets are now one setting for the whole studio (currently the " + DEFAULT_TARGET + "% default).", box);
      var acts = H("div", "ic-offer-acts", null, box);
      var yes = H("button", "btn primary sm", "Save " + fmtPct(v) + " for the whole studio", acts); yes.type = "button";
      var no = H("button", "btn sm", "Keep " + DEFAULT_TARGET + "%", acts); no.type = "button";
      var m = H("span", "ic-offer-msg", st.tm.err || "", acts); m.setAttribute("role", "status"); m.setAttribute("aria-live", "polite");
      yes.disabled = no.disabled = !!st.tm.busy;
      yes.addEventListener("click", function () {
        if (st.tm.busy || !ctx.saveTargetMargin) return; st.tm.busy = true; st.tm.err = ""; yes.disabled = no.disabled = true; m.textContent = "Saving…";
        Promise.resolve().then(function () { return ctx.saveTargetMargin(v); }).then(function (d) {
          var p = d && d.target_margin_pct != null ? Number(d.target_margin_pct) : v;
          st.tm.studio = p; st.target = p; st.tm.offer = null; st.tm.busy = false; forgetDeviceTarget(); render();
        }, function (e) { st.tm.busy = false; st.tm.err = "Couldn't save: " + ((e && e.message) || "try again."); render(); });
      });
      no.addEventListener("click", function () { st.tm.offer = null; st.tm.err = ""; forgetDeviceTarget(); render(); });
    }
    function loadTarget() {
      if (typeof ctx.targetMargin !== "function") { st.tm.loaded = true; return; }
      Promise.resolve().then(function () { return ctx.targetMargin(); }).then(function (d) {
        st.tm.loaded = true;
        if (!d) {   // server older than 0242 (or signed out): keep this device's old value until the update, else 30
          var dv = readDeviceTarget(); st.tm.missing = true; st.target = dv != null && dv >= 0 && dv <= 90 ? dv : DEFAULT_TARGET;
        } else {
          var p = d.target_margin_pct == null ? null : Number(d.target_margin_pct), dev = readDeviceTarget();
          st.tm.missing = false; st.tm.canEdit = !!d.can_edit;
          st.tm.studio = p != null && isFinite(p) ? p : null; st.target = st.tm.studio != null ? st.tm.studio : DEFAULT_TARGET;
          if (dev != null && st.tm.studio == null && st.tm.canEdit && dev >= 0 && dev <= 90 && dev !== DEFAULT_TARGET) st.tm.offer = dev;
          else if (dev != null) forgetDeviceTarget();   // the studio value wins; the per-device setting is retired
        }
        if (st.ready) render();
      }, function () { st.tm.loaded = true; /* keep the default; the cards still work */ });
    }

    function renderBench(host, period, bmBy, c) {
      var top = H("div", "ic-tools", null, host);
      /* hbp-skip: a percent, not money - the privacy screen leaves it readable. Read-only here: the ONE studio-wide
       * target is set in Control Center -> Pricing (0242), so everyone in the studio sees the same colours. */
      var fl = H("div", "ic-f ic-target hbp-skip", null, top); H("span", null, "Target margin", fl);
      var tv = H("b", "ic-tval", fmtPct(st.target), fl); tv.id = "icTarget";
      var nt = H("span", "ic-note", null, top); nt.id = "icTargetNote";
      nt.appendChild(document.createTextNode(st.tm.missing ? "Default " + DEFAULT_TARGET + "% - a studio-wide target needs database update 0242. "
        : (st.tm.studio == null ? "Studio default (" + DEFAULT_TARGET + "%), the same for everyone. " : "Set for the whole studio, the same for everyone. ")));
      if (!st.tm.missing && st.tm.canEdit) { var cl = H("a", "ic-tlink", "Change in Control Center", nt); cl.href = "control.html#target-margin"; nt.appendChild(document.createTextNode(". ")); }
      else if (!st.tm.missing) nt.appendChild(document.createTextNode("An admin can change it in Control Center. "));
      nt.appendChild(document.createTextNode("Typical = your own median for the same event type over the last 12 months."));
      if (st.tm.offer != null) renderOffer(host);
      if (!period.length) { H("div", "ic-empty", "No confirmed events in this period.", host); return; }
      var counts = { good: 0, watch: 0, poor: 0, na: 0 };
      period.forEach(function (r) { var b = bmBy[r.id]; if (b) counts[b.badge]++; });
      var sm = H("div", "ic-bsum", null, host);
      [["good", "on target"], ["watch", "to watch"], ["poor", "below target"], ["na", "without revenue"]].forEach(function (x) { if (!counts[x[0]] && x[0] === "na") return;
        var s = H("span", "ic-bs", null, sm); badge(s, x[0]).textContent = String(counts[x[0]]); s.appendChild(document.createTextNode(" " + x[1])); });
      var sc = H("div", "tscroll", null, host), t = H("table", "ic-btab", null, sc), hr = H("tr", null, null, H("thead", null, null, t));
      [["Event", ""], ["Status", ""], ["Margin", "n"], ["Typical", "n"], ["Cost / guest", "n"], ["Revenue / guest", "n"], ["Why", "ic-whycol"]].forEach(function (x) { var th = H("th", x[1], x[0], hr); th.scope = "col"; });
      var tb = H("tbody", null, null, t);
      var order = { poor: 0, watch: 1, na: 2, good: 3 };
      period.slice().sort(function (a, b) { var x = bmBy[a.id], y = bmBy[b.id]; return (order[x.badge] - order[y.badge]) || ((x.margin == null ? 999 : x.margin) - (y.margin == null ? 999 : y.margin)); }).forEach(function (r) {
        var b = bmBy[r.id], tr = H("tr", null, null, tb); tr.tabIndex = 0;
        var td0 = H("td", "ic-evc", null, tr), a = H("a", null, r.code || "Event", td0); a.href = ctx.href(r.id);
        H("div", "ic-sub", [r.title && r.title !== r.code ? r.title : null, r.event_type ? typeTitle(typeKey(r.event_type)) : null].filter(Boolean).join(" · "), td0);
        badge(H("td", null, null, tr), b.badge);
        H("td", "n" + (b.margin != null && b.margin < 0 ? " neg" : ""), b.margin == null ? "-" : b.margin + "%", tr);
        H("td", "n muted", b.peer && b.peer.margin != null ? Math.round(b.peer.margin) + "%" : "-", tr);
        H("td", "n", b.costPerGuest == null ? "-" : M(b.costPerGuest, c), tr);
        H("td", "n", b.revPerGuest == null ? "-" : M(b.revPerGuest, c), tr);
        H("td", "ic-whycol", b.why, tr);
        var go = function () { pick(r.id); };
        tr.addEventListener("click", function (e) { if (e.target.closest("a")) return; go(); });
        tr.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target === tr) { e.preventDefault(); go(); } });
      });
      H("p", "ic-note", "On target = margin at or above the target. Watch = up to 10 points below. Below target = more than 10 points below, or a loss. Cost per guest needs the guest count on the event. Click a row to see that event's costs.", host);
    }

    loadTarget();

    /* re-draw when the eye button hides / shows amounts, and when the width changes (crisp text at every size) */
    var lastHidden = hidden();
    try { new MutationObserver(function () { var h = hidden(); if (h !== lastHidden) { lastHidden = h; render(); } }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); } catch (e) {}
    var lastW = 0, rt = null;
    try { window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { var w = costHost.clientWidth; if (Math.abs(w - lastW) > 24) { lastW = w; render(); } }, 180); }); } catch (e) {}

    return {
      set: function (data) { st.ready = true; st.rows = Array.isArray(data && data.rows) ? data.rows : []; st.from = (data && data.from) || null; st.to = (data && data.to) || null; st.msg = ""; lastW = costHost.clientWidth; render(); },
      clear: function (msg) { st.ready = true; st.rows = []; st.msg = msg || ""; render(); },
      select: function (id) { pick(id); },
      target: function () { return st.target; }
    };
  }

  var API = { CATS: CATS, DEFAULT_TARGET: DEFAULT_TARGET, median: median, benchmarks: benchmarks, trend: trend, totals: totals, mixOf: mixOf,
    alignEvents: alignEvents, moneyByCurrency: moneyByCurrency,
    marginOf: marginOf, badgeFor: badgeFor, compact: compact, niceMax: niceMax, ticks: ticks, typeKey: typeKey, typeTitle: typeTitle, mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.HelmInsightsCosts = API;
})(typeof window !== "undefined" ? window : globalThis);
