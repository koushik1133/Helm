/* money-ledger-ui.js - r21 money (0246): the event's "Budget & margin" card on Budget and Closure.
   Self-mounting: an element with data-ml-mount="margin" is filled once the page shows its #app (after the
   page checked sign-in and access) and only for roles with finance view (the server checks it again).
   One server calculation (event_cost_breakdown): estimated / expected / actual margin + accuracy %, a P&L
   (revenue ex-GST, refunds ex-GST, costs, gross margin, net margin %), and a variance table per category
   (Estimated · Committed · Actual · Variance) whose rows open to the cost lines and where each comes from.
   On a database without 0246 the card stays hidden and the older cards keep working. When it works it
   hides the cards named in data-ml-replaces (one profit picture per page).
   DOM via createElement / textContent only. Every amount has data-money so privacy mode masks it.
   Built so Phase 3 (closure checklist + frozen P&L) can reuse renderPnl / renderVariance as they are. */
(function () {
  "use strict";
  var S = function () { return window.BPStore; };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function money(node) { node.setAttribute("data-money", ""); return node; }
  function qid() { var p = new URLSearchParams(location.search); return p.get("quote") || p.get("id") || ""; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function has(v) { return v !== null && v !== undefined && v !== ""; }
  function errText(e) { return (e && e.message) ? String(e.message).slice(0, 240) : "Something went wrong - try again."; }
  var STAGE_LABEL = { estimated: "Estimate", committed: "Committed", actual: "Actual" };

  async function fmtFor(quoteId) {
    var B = S(), cfg = null;
    if (quoteId) { try { var ev = await B.quotes.get(quoteId); cfg = ev ? B.quoteTax(ev) : null; } catch (e) { cfg = null; } }
    return function (n) { try { return cfg ? B.quoteMoney(n, cfg) : B.studioMoney(n); } catch (e) { return String(Math.round(Number(n) || 0)); } };
  }
  function niceDate(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  // ---------------- pieces (exported for Phase 3) ----------------
  function tile(label, amount, pct, cls, fmt, hint) {
    var t = el("div", "ml-tile " + (cls || ""));
    t.appendChild(el("span", "ml-tl", label));
    var b = money(el("b", amount < 0 ? "neg" : "", fmt(amount))); t.appendChild(b);
    t.appendChild(el("span", "ml-tp", (pct != null ? pct + "% margin" : "") + (hint ? (pct != null ? " · " : "") + hint : "")));
    return t;
  }
  function plRow(box, label, amount, fmt, o) {
    o = o || {};
    var r = el("div", "ml-pl-row" + (o.cls ? " " + o.cls : ""));
    r.appendChild(el("span", null, label));
    var v = el("b", o.vcls || "");
    if (o.text != null) v.textContent = o.text; else money(v).textContent = (o.minus ? "− " : "") + fmt(amount);
    r.appendChild(v); box.appendChild(r); return r;
  }
  function renderPnl(box, m, fmt) {
    var pl = el("div", "ml-pl"); box.appendChild(pl);
    plRow(pl, "Revenue (without GST)", m.revenue, fmt);
    if (num(m.refunds_ex_tax) > 0) plRow(pl, "Refunds to the client (without GST)", m.refunds_ex_tax, fmt, { minus: true });
    plRow(pl, "Net revenue", m.net_revenue, fmt, { cls: "ml-sub" });
    plRow(pl, "Event costs (expected)", m.cost_expected, fmt, { minus: true }).title = "Actual where known, else the agreed amount, else the estimate";
    var g = num(m.gross_margin);
    plRow(pl, "Gross margin (contribution)" + (m.margin_expected_pct != null ? " · " + m.margin_expected_pct + "%" : ""), g, fmt, { cls: "ml-tot", vcls: g < 0 ? "neg" : "pos" });
    plRow(pl, "Studio overhead share", 0, fmt, { text: "not set yet", vcls: "ml-muted" });
    plRow(pl, "Net margin %", 0, fmt, { text: m.net_margin_pct != null ? m.net_margin_pct + "%" : "—", cls: "ml-tot", vcls: num(m.net_margin) < 0 ? "neg" : "pos" });
    // tax view: GST collected vs input credit (only when there is GST)
    if (num(m.tax) > 0 || num(m.input_tax) > 0 || num(m.blocked_gst) > 0) {
      var tx = el("p", "ml-muted ml-tax");
      tx.appendChild(document.createTextNode("GST collected (payable, not profit) "));
      tx.appendChild(money(el("span", null, fmt(num(m.tax) - num(m.refunds_tax)))));
      if (num(m.input_tax) > 0) { tx.appendChild(document.createTextNode(" · input credit on vendor bills (not a cost) ")); tx.appendChild(money(el("span", null, fmt(m.input_tax)))); }
      if (num(m.blocked_gst) > 0) { tx.appendChild(document.createTextNode(" · GST you can't claim, counted in cost ")); tx.appendChild(money(el("span", null, fmt(m.blocked_gst)))); }
      box.appendChild(tx);
    }
  }
  function renderAccuracy(box, m) {
    var a = m.accuracy_pct, w = el("div", "ml-acc");
    var lbl = el("div", "ml-acc-l");
    lbl.appendChild(el("b", null, a != null ? a + "% of the cost is actual" : "No costs recorded yet"));
    lbl.appendChild(el("span", "ml-muted", a != null ? (a >= 100 ? " - every cost line has a bill, attendance or receipt." : " - the rest is still an estimate or an agreed amount.") : ""));
    w.appendChild(lbl);
    var bar = el("div", "ml-bar"); bar.setAttribute("role", "meter"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(a != null ? a : 0)); bar.setAttribute("aria-label", "Share of the cost that is actual");
    var fill = el("i"); fill.style.width = Math.max(0, Math.min(100, num(a))) + "%"; bar.appendChild(fill); w.appendChild(bar);
    box.appendChild(w);
  }
  function renderWarnings(box, m, fmt) {
    var ws = (m.warnings || []).filter(function (w) { return w && w.code !== "estimate_only"; });
    if (!ws.length) return;
    var n = el("div", "ml-warn"); n.setAttribute("role", "note");
    n.appendChild(el("b", null, "Check before you trust the margin"));
    var ul = el("ul");
    ws.forEach(function (w) {
      var li = el("li", null, w.text || w.code);
      if (w.code === "gst_unknown" && has(w.amount)) { li.appendChild(document.createTextNode(" (")); li.appendChild(money(el("span", null, fmt(w.amount)))); li.appendChild(document.createTextNode(")")); }
      ul.appendChild(li);
    });
    n.appendChild(ul); box.appendChild(n);
  }
  function varianceCell(row, fmt) {
    var B = S(), td = el("td", "num"), v = num(row.variance), flag = B.moneyLedger.varianceFlag(row);
    if (Math.abs(v) < 0.005) { td.appendChild(el("span", "ml-muted", "on plan")); return td; }
    var sp = money(el("span", "ml-var " + flag, (v > 0 ? "+" : "−") + fmt(Math.abs(v))));
    td.appendChild(sp);
    if (row.variance_pct != null && v > 0) td.appendChild(el("span", "ml-vp " + flag, (flag === "over" ? " ⚠ " : " ") + row.variance_pct + "%"));
    if (flag === "over") td.title = "More than 10% or more than 10,000 over the estimate";
    return td;
  }
  function amountCell(v, fmt, cls) {
    var td = el("td", "num" + (cls ? " " + cls : ""));
    if (!has(v)) { td.appendChild(el("span", "ml-muted", "—")); return td; }
    td.appendChild(money(el("span", null, fmt(v)))); return td;
  }
  // the variance table; o = { canEdit, onCrewCovered(line, on) }
  function renderVariance(box, m, fmt, o) {
    o = o || {};
    var B = S(), cats = m.by_category || [], lines = m.lines || [];
    var hasCrew = lines.some(function (l) { return l.source === "crew"; });
    var wrap = el("div", "table-scroll"), t = el("table", "ml-table");
    var cap = el("caption", "sr-only", "Cost by category: estimated, committed, actual and variance"); t.appendChild(cap);
    var th = el("thead"), hr = el("tr");
    [["Category", "", ""], ["Estimated", "num", "What you planned"], ["Committed", "num", "What you agreed: booked vendors, crew who accepted, approved changes"],
     ["Actual", "num", "Bills, event-day attendance, approved expenses, write-offs"], ["Variance", "num", "Expected minus estimated (+ = over the plan)"]].forEach(function (h) {
      var c = el("th", h[1] || null, h[0]); c.scope = "col"; if (h[2]) c.title = h[2]; hr.appendChild(c); });
    th.appendChild(hr); t.appendChild(th);
    var body = el("tbody"); t.appendChild(body);
    if (!cats.length) { var er = el("tr"), ec = el("td", "ml-muted", "No costs yet - add budget lines, vendor bookings or crew to see the margin."); ec.colSpan = 5; er.appendChild(ec); body.appendChild(er); }
    cats.forEach(function (c) {
      var tr = el("tr", "ml-cat"), c1 = el("td"), btn = el("button", "ml-open");
      btn.type = "button"; btn.setAttribute("aria-expanded", "false");
      btn.appendChild(el("span", "ml-caret", "▸"));
      btn.appendChild(el("span", null, B.moneyLedger.catLabel(c.key)));
      btn.appendChild(el("span", "ml-n", String(c.lines || 0)));
      c1.appendChild(btn);
      if (num(c.estimate_only) > 0.005 && c.key !== "contingency") { var eo = el("div", "ml-eo"); eo.appendChild(document.createTextNode("not actual yet: ")); eo.appendChild(money(el("span", null, fmt(c.estimate_only)))); c1.appendChild(eo); }
      tr.appendChild(c1);
      tr.appendChild(amountCell(c.estimated, fmt)); tr.appendChild(amountCell(c.committed, fmt)); tr.appendChild(amountCell(c.actual, fmt));
      tr.appendChild(varianceCell(c, fmt));
      body.appendChild(tr);
      var detail = [];
      lines.filter(function (l) { return l.category === c.key; }).forEach(function (l) {
        var r = el("tr", "ml-line"); r.hidden = true;
        var d1 = el("td"), stg = B.moneyLedger.stage(l);
        var nm = el("div", "ml-ln"); nm.appendChild(el("span", "ml-stage " + stg, STAGE_LABEL[stg]));
        nm.appendChild(el("span", null, l.label || "Cost")); d1.appendChild(nm);
        var note = l.note || "";
        if (note) d1.appendChild(el("div", "ml-note" + (/^(not counted|replaced|in the plan only)/.test(note) ? " off" : ""), note));
        if (l.gst_status === "unknown" && num(l.c_act) > 0) d1.appendChild(el("div", "ml-note warn", "GST unknown - counted with its GST"));
        if (has(l.day_rate) && l.source === "crew") { var dr = el("div", "ml-note"); dr.appendChild(document.createTextNode("day rate ")); dr.appendChild(money(el("span", null, fmt(l.day_rate)))); d1.appendChild(dr); }
        if (o.canEdit && hasCrew && l.staff_like && (l.source === "cost_line" || l.source === "vendor_line") && l.source_id && typeof o.onCrewCovered === "function") {
          var on = !!l.crew_covered, tg = el("button", "ml-tg" + (on ? " on" : ""), on ? "✓ Replaced by crew wages" : "Replaced by crew wages?");
          tg.type = "button"; tg.setAttribute("aria-pressed", on ? "true" : "false");
          tg.title = on ? "Count this typed line again (the crew wage lines stay)" : "This typed staff line and the automatic crew wages are the same people - count only the crew wages";
          tg.addEventListener("click", function () { tg.disabled = true; Promise.resolve(o.onCrewCovered(l, !on)).catch(function () {}).then(function () { tg.disabled = false; }); });
          d1.appendChild(tg);
        }
        r.appendChild(d1);
        // a struck-through amount = shown for reference but not counted (replaced / covered by another source)
        r.appendChild(amountCell(l.estimated, fmt, has(l.estimated) && num(l.estimated) !== 0 && num(l.c_est) === 0 ? "ml-off" : ""));
        r.appendChild(amountCell(l.committed, fmt));
        r.appendChild(amountCell(l.actual, fmt, has(l.actual) && num(l.actual) !== 0 && num(l.c_act) === 0 ? "ml-off" : ""));
        r.appendChild(el("td", "num"));
        body.appendChild(r); detail.push(r);
      });
      btn.addEventListener("click", function () {
        var open = btn.getAttribute("aria-expanded") !== "true";
        btn.setAttribute("aria-expanded", open ? "true" : "false"); tr.classList.toggle("open", open);
        detail.forEach(function (r) { r.hidden = !open; });
      });
    });
    var tf = el("tfoot"), fr = el("tr", "ml-total");
    fr.appendChild(el("th", null, "Total cost")); fr.firstChild.scope = "row";
    fr.appendChild(amountCell(m.cost_estimated, fmt)); fr.appendChild(amountCell(m.cost_committed, fmt)); fr.appendChild(amountCell(m.cost_actual, fmt));
    fr.appendChild(varianceCell({ estimated: m.cost_estimated, variance: num(m.cost_expected) - num(m.cost_estimated),
      variance_pct: num(m.cost_estimated) > 0 ? Math.round((num(m.cost_expected) - num(m.cost_estimated)) / num(m.cost_estimated) * 100) : null }, fmt));
    tf.appendChild(fr); t.appendChild(tf);
    wrap.appendChild(t); box.appendChild(wrap);
    var key = el("p", "ml-muted ml-key");
    key.textContent = "Estimated = planned · Committed = agreed (booked vendors, crew who accepted, approved changes, claims waiting) · Actual = vendor bills, event-day attendance, approved expenses, write-offs · Variance = expected − estimated. Tap a category to see its lines.";
    box.appendChild(key);
  }

  // ---------------- the card ----------------
  async function mountMargin(box) {
    var B = S(), id = qid(); if (!id || !B || !B.moneyLedger) { box.hidden = true; return; }
    var finOk = false; try { finOk = await B.auth.canView("finance"); } catch (e) { finOk = false; }
    if (!finOk) { box.hidden = true; return; }
    var canEdit = false; try { canEdit = await B.auth.canEditArea("finance"); } catch (e) { canEdit = false; }
    var fmt = await fmtFor(id), seq = 0, timer = null;
    var replaces = String(box.getAttribute("data-ml-replaces") || "").split(/\s+/).filter(Boolean);
    box.hidden = true;
    async function draw() {
      var my = ++seq, m;
      try { m = await B.moneyLedger.breakdown(id); }
      catch (e) {
        if (my !== seq) return;
        clear(box); box.hidden = false; box.classList.add("card", "ml-card");
        box.appendChild(el("h2", null, "💰 Budget & margin"));
        box.appendChild(el("p", "vb-err", "Couldn't work out the margin: " + errText(e)));
        return;
      }
      if (my !== seq) return;
      if (!m) { box.hidden = true; return; }                      // database without 0246: older cards stay
      replaces.forEach(function (rid) { var n = document.getElementById(rid); if (n) n.hidden = true; });
      clear(box); box.hidden = false; box.classList.add("card", "ml-card");
      var head = el("div", "ml-head"); head.appendChild(el("h2", null, "💰 Budget & margin"));
      var legacy = m.rules === "legacy";
      head.appendChild(el("span", "ml-rules" + (legacy ? " legacy" : ""), legacy ? "Recorded numbers (legacy)" : "Counts staff wages · GST-clean"));
      box.appendChild(head);
      box.appendChild(el("p", "sub", "Estimated vs actual cost per category, and what this event really makes."));
      if (legacy) {
        var lg = el("div", "ml-legacy"); lg.setAttribute("role", "note");
        lg.appendChild(el("b", null, "Closed " + (m.closed_at ? "on " + niceDate(m.closed_at) + " " : "") + "before the new margin rules."));
        var p1 = el("p"); p1.appendChild(document.createTextNode(" Its recorded net profit stays "));
        p1.appendChild(money(el("b", null, fmt(m.legacy && m.legacy.net_profit))));
        p1.appendChild(document.createTextNode(" everywhere (Settlement, Business, reports). Below is the same event under the new rules - for reference only, nothing is changed."));
        lg.appendChild(p1); box.appendChild(lg);
      }
      var tiles = el("div", "ml-tiles");
      tiles.appendChild(tile("Planned margin", num(m.margin_estimated), m.margin_estimated_pct, "", fmt, "on estimates"));
      tiles.appendChild(tile("Expected margin", num(m.margin_expected), m.margin_expected_pct, "main", fmt, "actual where known"));
      tiles.appendChild(tile("Actual so far", num(m.margin_actual), m.margin_actual_pct, "", fmt, m.accuracy_pct != null && m.accuracy_pct < 100 ? "not final yet" : "only real costs"));
      if (box.getAttribute("data-ml-tiles") !== "off") box.appendChild(tiles);   // r24: Budget / Closure already show one profit number above
      var cols = el("div", "ml-cols"), left = el("div", "ml-col"), right = el("div", "ml-col");
      left.appendChild(el("h3", null, "Profit & loss"));
      renderPnl(left, m, fmt);
      right.appendChild(el("h3", null, "How sure is this margin?"));
      renderAccuracy(right, m);
      renderWarnings(right, m, fmt);
      cols.appendChild(left); cols.appendChild(right); box.appendChild(cols);
      var vt = el("div", "ml-vt"); vt.appendChild(el("h3", null, "Cost by category - estimated vs actual"));
      renderVariance(vt, m, fmt, { canEdit: canEdit && !legacy, onCrewCovered: async function (l, on) {
        try { await B.moneyLedger.setCrewCovered(l.source_id, on); }
        catch (e) { try { window.BPUI && BPUI.toast(BPUI.friendlyError ? BPUI.friendlyError(e, { action: "update the line" }) : errText(e), { type: "err" }); } catch (_) {} return; }
        try { document.dispatchEvent(new CustomEvent("helm:pnl-refresh", { detail: { fromLedger: true } })); } catch (_) {}
        soon();
      } });
      if (m.pay_private) vt.appendChild(el("p", "ml-muted", "Crew wages are shown as one line: per-person pay is visible to the studio admin only."));
      box.appendChild(vt);
    }
    function soon() { clearTimeout(timer); timer = setTimeout(draw, 150); }
    document.addEventListener("helm:vendor-bills-changed", soon);
    document.addEventListener("helm:pnl-refresh", function (e) { if (!(e && e.detail && e.detail.fromLedger)) soon(); });
    await draw();
  }

  function whenShown(gate, fn) {
    if (!gate) return;
    var done = false, run = function () { if (done || gate.hidden) return; done = true; obs.disconnect(); fn(); };
    var obs = new MutationObserver(run); obs.observe(gate, { attributes: true, attributeFilter: ["hidden"] }); run();
  }
  function start() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-ml-mount="margin"]'), function (n) {
      var gate = document.getElementById(n.getAttribute("data-ml-gate") || "app");
      whenShown(gate, function () { Promise.resolve().then(function () { return mountMargin(n); }).catch(function (e) { try { console.warn("money ledger:", e && e.message); } catch (_) {} }); });
    });
  }
  window.HelmMoneyLedger = { mountMargin: mountMargin, renderPnl: renderPnl, renderVariance: renderVariance, renderAccuracy: renderAccuracy };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
