/* closure-checklist.js - r22 Closure page (0254): the closure dashboard, the live "Before you close" checklist
 * (per-item inventory table) and the "Request to close anyway" + approval flow.
 * Data: BPStore.closure.review(quote) -> event_closure_review (checks, failed, inventory, counts, requests, pending),
 *       BPStore.moneyLedger.breakdown(quote) -> the shared 0246 P&L (finance only; null = no access / older DB),
 *       BPStore.closure.blockers(quote) -> invoice total / paid / balance (0049).
 * Privacy ("Hide amounts"): every amount node has data-money; charts carry no amount text (bars only, the legend
 * holds the amounts), percentages stay readable.
 * No HTML-string sinks and no style= attributes: DOM via createElement / textContent, sizes via SVG attributes.
 * Pure helpers (costSplit, fixHref, icon, summary, buttonState, invTotals, topCategories, pct) are exported for
 * test/r22-closure.test.mjs. */
(function (root) {
  "use strict";
  var NS = "http://www.w3.org/2000/svg";

  /* ---------------- pure helpers ---------------- */
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmtQty(n) { n = num(n); return Math.round(n * 100) / 100 + ""; }
  function pct(part, whole) { part = num(part); whole = num(whole); return whole > 0 ? Math.round(part / whole * 100) : null; }
  var PAGES = { event: ["event.html", "id", "Open the event"], quote: ["event.html", "id", "Open the event"],
    settlement: ["settlement.html", "quote", "Open Settlement"], inventory: ["inventory.html", "quote", "Open Inventory"],
    command: ["command.html", "quote", "Open Event-day command"] };
  function fixHref(fix, quoteId) {
    var p = PAGES[fix]; if (!p || !quoteId) return "";
    return p[0] + "?" + p[1] + "=" + encodeURIComponent(String(quoteId));
  }
  function fixLabel(fix) { var p = PAGES[fix]; return p ? p[2] : "Open"; }
  function icon(status) { return status === "fail" ? "✗" : status === "warn" ? "⚠" : "✓"; }
  function statusWord(status) { return status === "fail" ? "Blocking" : status === "warn" ? "Check" : "Done"; }
  function overrideWord(o) { return o === "none" ? "No override" : o === "admin" ? "Admin approval" : o === "any" ? "Approval needed" : ""; }
  function summary(review) {
    var checks = (review && Array.isArray(review.checks)) ? review.checks : [];
    var s = { total: checks.length, ok: 0, warn: 0, fail: 0, adminOnly: false, early: !!(review && review.too_early),
              pending: (review && review.pending) || null, closed: !!(review && review.closed_at) };
    checks.forEach(function (c) { if (c.status === "fail") { s.fail++; if (c.override === "admin" || c.override === "none") s.adminOnly = true; }
                                  else if (c.status === "warn") s.warn++; else s.ok++; });
    return s;
  }
  // what the Close button says / does
  function buttonState(review) {
    var s = summary(review);
    if (s.closed) return { mode: "closed", label: "Event closed" };
    if (s.early) return { mode: "early", label: "Can't close until after the event day" };
    if (s.pending) return { mode: "pending", label: "Close requested - waiting for approval" };
    if (s.fail > 0) return { mode: "request", label: "Request to close anyway…" };
    return { mode: "close", label: "Mark event closed & archived" };
  }
  function invTotals(items) {
    var t = { items: 0, reserved: 0, out: 0, back: 0, missing: 0, writtenOff: 0, stillOut: 0, reservedOpen: 0, notBack: 0 };
    (items || []).forEach(function (i) {
      t.items++; t.reserved += num(i.reserved); t.out += num(i.checked_out); t.back += num(i.checked_in);
      t.missing += num(i.missing); t.writtenOff += num(i.written_off); t.stillOut += num(i.still_out); t.reservedOpen += num(i.reserved_open);
      if (i.status === "fail") t.notBack++;
    });
    return t;
  }
  function topCategories(m, n) {
    var cats = (m && Array.isArray(m.by_category)) ? m.by_category.slice() : [];
    cats = cats.filter(function (c) { return num(c.expected) > 0 && c.key !== "contingency"; });
    cats.sort(function (a, b) { return num(b.expected) - num(a.expected); });
    return cats.slice(0, n || 4);
  }
  // staff vs vendor cost from the 0246 ledger lines (forecast = actual when known, else committed / estimate)
  var VENDOR_SRC = { booking: 1, bill: 1, vendor_line: 1 };
  function costSplit(m) {
    var o = { staff: 0, vendors: 0, vendorsPaid: 0, other: 0 };
    ((m && Array.isArray(m.lines)) ? m.lines : []).forEach(function (l) {
      var v = num(l.c_fc != null ? l.c_fc : (l.actual != null ? l.actual : l.estimated));
      if (l.source === "crew" || l.category === "staff") o.staff += v;
      else if (VENDOR_SRC[l.source]) { o.vendors += v; o.vendorsPaid += num(l.paid); }
      else o.other += v;
    });
    return o;
  }

  /* ---------------- DOM helpers ---------------- */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function money(node) { node.setAttribute("data-money", ""); return node; }
  function svg(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  // horizontal bars (no amount text inside the chart; the legend has them)
  function bars(rows, w) {
    w = w || 260; var h = rows.length * 22, max = 0;
    rows.forEach(function (r) { max = Math.max(max, Math.abs(num(r.v))); });
    var s = svg("svg", { viewBox: "0 0 " + w + " " + h, width: "100%", height: String(h), role: "img", "aria-hidden": "true", focusable: "false", class: "cl-bars" });
    rows.forEach(function (r, i) {
      var bw = max > 0 ? Math.max(2, Math.round(Math.abs(num(r.v)) / max * (w - 4))) : 2;
      s.appendChild(svg("rect", { x: "0", y: String(i * 22 + 4), width: String(w), height: "14", rx: "4", class: "cl-bar-bg" }));
      s.appendChild(svg("rect", { x: "0", y: String(i * 22 + 4), width: String(bw), height: "14", rx: "4", class: "cl-bar " + (r.cls || "") }));
    });
    return s;
  }
  // a single stacked meter (e.g. collected vs outstanding, tasks done vs open)
  function meter(parts) {
    var tot = 0; parts.forEach(function (p) { tot += Math.max(0, num(p.v)); });
    var s = svg("svg", { viewBox: "0 0 100 10", width: "100%", height: "10", preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false", class: "cl-meter" });
    s.appendChild(svg("rect", { x: "0", y: "0", width: "100", height: "10", rx: "5", class: "cl-bar-bg" }));
    var x = 0;
    parts.forEach(function (p) {
      var wv = tot > 0 ? Math.max(0, num(p.v)) / tot * 100 : 0; if (wv <= 0) return;
      s.appendChild(svg("rect", { x: String(x), y: "0", width: String(wv), height: "10", class: "cl-bar " + (p.cls || "") })); x += wv;
    });
    return s;
  }
  function legendRow(cls, label, value, isMoney) {
    var r = el("div", "cl-leg"); var sw = el("span", "cl-sw " + (cls || "")); sw.setAttribute("aria-hidden", "true"); r.appendChild(sw);
    r.appendChild(el("span", "cl-leg-k", label)); var v = el("span", "cl-leg-v", value); if (isMoney) money(v); r.appendChild(v); return r;
  }
  function tile(title, big, sub, isMoney) {
    var t = el("div", "cl-tile"); t.appendChild(el("div", "cl-tile-k", title));
    var b = el("div", "cl-tile-v", big); if (isMoney) money(b); t.appendChild(b);
    if (sub) t.appendChild(sub.nodeType ? sub : el("div", "cl-tile-s", sub)); return t;
  }

  /* ---------------- dashboard ---------------- */
  // o: { review, ledger (0246 breakdown or null), blockers (0049 or null), fmt(n) }
  function renderDashboard(mount, o) {
    if (!mount) return; mount.replaceChildren();
    var r = o.review || {}, m = o.ledger, b = o.blockers, fmt = o.fmt || function (n) { return String(Math.round(num(n))); };
    var c = r.counts || {}, grid = el("div", "cl-grid");
    var head = el("div", "cl-dash-head"); head.appendChild(el("h2", null, "📈 Closure summary"));
    head.appendChild(el("p", "sub", "How this event went - money, accuracy, people, stock and follow-ups."));
    mount.appendChild(head);
    if (m) {
      var rev = num(m.net_revenue != null ? m.net_revenue : m.revenue), cost = num(m.cost_expected), prof = num(m.margin_expected);
      var t1 = tile("Profit", fmt(prof), null, true); t1.classList.add(prof >= 0 ? "pos" : "neg");
      var mp = m.margin_expected_pct; var sub = el("div", "cl-tile-s hbp-skip", mp != null ? "Margin " + mp + "%" : "Margin -"); t1.appendChild(sub);
      var lg = el("div", "cl-legs");
      lg.appendChild(legendRow("rev", "Revenue (ex-tax)", fmt(rev), true)); lg.appendChild(legendRow("cost", "Costs", fmt(cost), true));
      lg.appendChild(legendRow(prof >= 0 ? "prof" : "loss", prof >= 0 ? "Profit" : "Loss", fmt(prof), true));
      t1.appendChild(bars([{ v: rev, cls: "rev" }, { v: cost, cls: "cost" }, { v: prof, cls: prof >= 0 ? "prof" : "loss" }]));
      t1.appendChild(lg); grid.appendChild(t1);
      // estimate vs actual
      var est = num(m.cost_estimated), acc = m.accuracy_pct, varc = cost - est;
      var t2 = tile("Estimate vs actual", acc != null ? acc + "% actual" : "-", null, false);
      t2.querySelector(".cl-tile-v").classList.add("hbp-skip");
      var l2 = el("div", "cl-legs"); l2.appendChild(legendRow("est", "Estimated cost", fmt(est), true)); l2.appendChild(legendRow("cost", "Expected cost", fmt(cost), true));
      var vr = legendRow(varc > 0 ? "loss" : "prof", varc > 0 ? "Over the plan" : "Under the plan", fmt(Math.abs(varc)), true); l2.appendChild(vr);
      t2.appendChild(bars([{ v: est, cls: "est" }, { v: cost, cls: "cost" }])); t2.appendChild(l2);
      t2.appendChild(el("div", "cl-tile-s", "Accuracy = share of the cost backed by bills, attendance or receipts."));
      grid.appendChild(t2);
      // top cost categories
      var top = topCategories(m, 4);
      var t3 = tile("Top cost categories", top.length ? String(top.length) : "None yet", null, false);
      t3.querySelector(".cl-tile-v").classList.add("cl-tile-v-sm");
      if (top.length) {
        t3.appendChild(bars(top.map(function (x) { return { v: x.expected, cls: "cost" }; })));
        var l3 = el("div", "cl-legs"); top.forEach(function (x) { l3.appendChild(legendRow("cost", x.label || x.key, fmt(x.expected), true)); }); t3.appendChild(l3);
      }
      grid.appendChild(t3);
      // staff vs vendor costs
      var cs = costSplit(m);
      if (cs.staff > 0 || cs.vendors > 0) {
        var t3b = tile("Staff & vendor costs", fmt(cs.staff + cs.vendors), null, true);
        t3b.appendChild(bars([{ v: cs.vendors, cls: "cost" }, { v: cs.staff, cls: "est" }]));
        var l3b = el("div", "cl-legs"); l3b.appendChild(legendRow("cost", "Vendors", fmt(cs.vendors), true));
        l3b.appendChild(legendRow("prof", "Paid to vendors", fmt(Math.min(cs.vendorsPaid, cs.vendors)), true));
        l3b.appendChild(legendRow("est", "Staff & crew wages", fmt(cs.staff), true)); t3b.appendChild(l3b);
        grid.appendChild(t3b);
      }
    }
    if (b && (num(b.total) > 0 || num(b.paid) > 0)) {
      var tot = num(b.total), paid = num(b.paid), due = Math.max(0, num(b.balance_owed));
      var t4 = tile("Collected", fmt(paid), null, true);
      var p4 = pct(paid, tot); t4.appendChild(el("div", "cl-tile-s hbp-skip", p4 != null ? p4 + "% of the invoice" : ""));
      t4.appendChild(meter([{ v: paid, cls: "prof" }, { v: due, cls: "loss" }]));
      var l4 = el("div", "cl-legs"); l4.appendChild(legendRow("prof", "Collected", fmt(paid), true)); l4.appendChild(legendRow("loss", "Outstanding", fmt(due), true));
      t4.appendChild(l4); grid.appendChild(t4);
    }
    // people
    var t5 = tile("Vendors & crew", (num(c.vendors)) + " · " + num(c.crew), null, false);
    var l5 = el("div", "cl-legs"); l5.appendChild(legendRow("est", "Vendors booked", String(num(c.vendors)), false));
    l5.appendChild(legendRow("prof", "Crew arrived", num(c.crew_arrived) + " of " + num(c.crew), false)); t5.appendChild(l5); grid.appendChild(t5);
    // inventory movement
    var it = invTotals(r.inventory);
    var t6 = tile("Equipment", it.items ? it.back + " of " + it.out + " back" : "None booked", null, false);
    if (it.items) {
      t6.appendChild(meter([{ v: it.back, cls: "prof" }, { v: it.missing, cls: "warn" }, { v: it.stillOut, cls: "loss" }]));
      var l6 = el("div", "cl-legs"); l6.appendChild(legendRow("prof", "Checked in", fmtQty(it.back), false));
      l6.appendChild(legendRow("warn", "Missing / written off", fmtQty(Math.max(it.missing, it.writtenOff)), false));
      l6.appendChild(legendRow("loss", "Still out / not marked returned", fmtQty(it.stillOut + it.reservedOpen), false)); t6.appendChild(l6);
    }
    grid.appendChild(t6);
    // tasks + issues
    var t7 = tile("Tasks", num(c.tasks_done) + " of " + num(c.tasks) + " done", null, false);
    if (num(c.tasks)) t7.appendChild(meter([{ v: c.tasks_done, cls: "prof" }, { v: c.tasks_open, cls: "warn" }]));
    var l7 = el("div", "cl-legs"); l7.appendChild(legendRow("warn", "Still open", String(num(c.tasks_open)), false));
    l7.appendChild(legendRow("loss", "Issues logged", num(c.issues) + (num(c.issues_open) ? " (" + num(c.issues_open) + " open)" : ""), false));
    t7.appendChild(l7); grid.appendChild(t7);
    mount.appendChild(grid);
    if (!m) mount.appendChild(el("p", "cl-note", "Money figures show for roles with Finance access."));
    mount.hidden = false;
  }

  /* ---------------- checklist + inventory table ---------------- */
  function inventoryTable(items) {
    var wrap = el("div", "cl-inv-wrap"); var t = el("table", "cl-inv");
    var cap = el("caption", null, "Equipment for this event, per item"); t.appendChild(cap);
    var hr = el("tr"); ["Item", "Reserved", "Checked out", "Checked in", "Missing", "Written off", "Still out", ""].forEach(function (h, i) {
      var th = el("th", i ? "num" : null, h); th.setAttribute("scope", "col"); if (!h) th.appendChild(el("span", "sr-only", "Status")); hr.appendChild(th); });
    var th0 = el("thead"); th0.appendChild(hr); t.appendChild(th0);
    var tb = el("tbody");
    (items || []).forEach(function (i) {
      var tr = el("tr", "cl-inv-" + (i.status || "ok"));
      var td = el("th", null, i.item || "Item"); td.setAttribute("scope", "row"); tr.appendChild(td);
      [i.reserved, i.checked_out, i.checked_in, i.missing, i.written_off, num(i.still_out) + num(i.reserved_open)].forEach(function (v) { tr.appendChild(el("td", "num", fmtQty(v))); });
      var st = el("td", "cl-st"); var ic = el("span", "cl-ic " + (i.status || "ok"), icon(i.status)); ic.setAttribute("aria-hidden", "true"); st.appendChild(ic);
      st.appendChild(el("span", "sr-only", i.status === "fail" ? "not returned" : i.status === "warn" ? "missing or written off" : "returned"));
      tr.appendChild(st); tb.appendChild(tr);
    });
    t.appendChild(tb); wrap.appendChild(t);
    wrap.appendChild(el("p", "cl-note", "Still out = checked out and not checked in, plus stock reserved for this event that was never marked returned. Written off = lost or damaged, taken off your stock."));
    return wrap;
  }
  // o: { quoteId, fmt, compact (modal), openInventory }
  function checklistNode(review, o) {
    o = o || {}; var list = el("ul", "cl-checks"); list.setAttribute("role", "list");
    (review.checks || []).forEach(function (c) {
      var li = el("li", "cl-check " + c.status); li.setAttribute("data-check", c.key || "");
      var ic = el("span", "cl-ic " + c.status, icon(c.status)); ic.setAttribute("aria-hidden", "true"); li.appendChild(ic);
      var body = el("div", "cl-cbody");
      var top = el("div", "cl-ctop"); top.appendChild(el("span", "sr-only", statusWord(c.status) + ": "));
      top.appendChild(el("b", null, c.key === "inventory" && c.status === "fail" ? "Equipment not returned" : c.label));
      var ow = overrideWord(c.override); if (ow) top.appendChild(el("span", "cl-tag " + (c.override || ""), ow));
      body.appendChild(top);
      var d = el("div", "cl-cdetail", c.detail || "");
      if (c.amount != null && num(c.amount) > 0 && o.fmt) { d.appendChild(document.createTextNode(" ")); d.appendChild(money(el("span", "cl-amt", "(" + o.fmt(c.amount) + ")"))); }
      body.appendChild(d);
      if (c.key === "inventory" && (review.inventory || []).length) {
        var det = el("details", "cl-invd"); if (c.status !== "ok" || o.compact) det.open = true;
        det.appendChild(el("summary", null, "Per item: checked out, checked in, missing, written off"));
        det.appendChild(inventoryTable(review.inventory)); body.appendChild(det);
      }
      li.appendChild(body);
      var href = c.status !== "ok" ? fixHref(c.fix, o.quoteId) : "";
      if (href) { var a = el("a", "cl-fix", fixLabel(c.fix) + " →"); a.href = href; a.setAttribute("aria-label", fixLabel(c.fix) + " to fix: " + c.label); li.appendChild(a); }
      list.appendChild(li);
    });
    return list;
  }
  function renderChecklist(mount, review, o) {
    if (!mount) return; mount.replaceChildren();
    if (!review) { mount.hidden = true; return; }
    var s = summary(review);
    var h = el("div", "cl-chead"); h.appendChild(el("strong", null, "Before you close"));
    h.appendChild(el("span", "cl-count " + (s.fail ? "fail" : s.warn ? "warn" : "ok"),
      s.fail ? s.fail + " blocking · " + s.warn + " to check" : s.warn ? "Ready · " + s.warn + " to check" : "All clear"));
    mount.appendChild(h); mount.appendChild(checklistNode(review, o)); mount.hidden = false;
  }

  /* ---------------- requests panel ---------------- */
  function when(at) { try { return new Date(at).toLocaleString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  // h: { approve(req), decline(req), withdraw(req) }
  function renderRequests(mount, review, h) {
    if (!mount) return; mount.replaceChildren();
    var reqs = (review && review.requests) || [], ovr = (review && review.overrides) || [];
    if (!reqs.length && !ovr.length) { mount.hidden = true; return; }
    reqs.forEach(function (q) {
      var box = el("div", "cl-req " + q.status);
      var title = q.status === "pending" ? "Close requested by " + q.requested_name + " - waiting for approval"
        : q.status === "approved" ? "Closed with override approved by " + (q.decided_name || "someone") + "; requested by " + q.requested_name
        : q.status === "declined" ? "Close request declined by " + (q.decided_name || "someone") + " (requested by " + q.requested_name + ")"
        : "Close request withdrawn (requested by " + q.requested_name + ")";
      box.appendChild(el("b", null, title));
      box.appendChild(el("div", "cl-req-when", when(q.at) + (q.decided_at ? " · decided " + when(q.decided_at) : "")));
      var rs = el("div", "cl-req-r"); rs.appendChild(el("span", "cl-req-k", "Reason: ")); rs.appendChild(document.createTextNode(q.reason || "")); box.appendChild(rs);
      if (q.decision_note) { var dn = el("div", "cl-req-r"); dn.appendChild(el("span", "cl-req-k", q.status === "declined" ? "Why declined: " : "Note: ")); dn.appendChild(document.createTextNode(q.decision_note)); box.appendChild(dn); }
      if ((q.failed || []).length) {
        var fl = el("div", "cl-req-r"); fl.appendChild(el("span", "cl-req-k", "Open when asked: "));
        fl.appendChild(document.createTextNode(q.failed.map(function (f) { return f.label + (f.override === "admin" ? " (admin)" : ""); }).join(", "))); box.appendChild(fl);
      }
      if (q.status === "pending" && (q.can_decide || q.can_withdraw)) {
        var acts = el("div", "foot cl-req-acts");
        if (q.can_withdraw) { var w = el("button", "btn", q.mine ? "Withdraw my request" : "Withdraw"); w.type = "button"; w.addEventListener("click", function () { h.withdraw(q, w); }); acts.appendChild(w); }
        if (q.can_decide) {
          var d = el("button", "btn", "Decline…"); d.type = "button"; d.addEventListener("click", function () { h.decline(q, d); }); acts.appendChild(d);
          var a = el("button", "btn go", "Approve & close"); a.type = "button"; a.addEventListener("click", function () { h.approve(q, a); }); acts.appendChild(a);
        }
        box.appendChild(acts);
      } else if (q.status === "pending" && q.mine) box.appendChild(el("div", "cl-note", "An admin or coordinator will approve or decline it. You'll get a notification."));
      mount.appendChild(box);
    });
    ovr.forEach(function (x) {
      var box = el("div", "cl-req approved"); box.appendChild(el("b", null, "Closed with override by " + x.who));
      box.appendChild(el("div", "cl-req-when", when(x.at)));
      var rs = el("div", "cl-req-r"); rs.appendChild(el("span", "cl-req-k", "Reason: ")); rs.appendChild(document.createTextNode(x.reason || "")); box.appendChild(rs);
      mount.appendChild(box);
    });
    mount.hidden = false;
  }

  /* ---------------- the "Before you close" dialog ---------------- */
  // resolves { reason } when the user asks to close anyway, null on cancel
  function openModal(review, o) {
    o = o || {};
    return new Promise(function (resolve) {
      var prev = document.activeElement, s = summary(review);
      var ov = el("div", "lmodal cl-modal"); ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-labelledby", "clmTitle");
      var sh = el("div", "sheet cl-sheet"); ov.appendChild(sh);
      var h = el("h3", null, s.pending ? "Close request waiting for approval" : "Before you close"); h.id = "clmTitle"; sh.appendChild(h);
      sh.appendChild(el("p", "sub", s.fail ? "These checks are still open. Fix them (links below) - or ask an admin / coordinator to approve closing anyway."
        : "Everything that blocks closing is done."));
      var body = el("div", "cl-mbody"); body.appendChild(checklistNode(review, { quoteId: o.quoteId, fmt: o.fmt, compact: true })); sh.appendChild(body);
      var ta = null, err = el("div", "err"); err.hidden = true; err.setAttribute("role", "alert");
      var foot = el("div", "foot");
      var cancel = el("button", "btn", s.pending || !o.canRequest ? "Close" : "Cancel"); cancel.type = "button"; foot.appendChild(cancel);
      if (s.pending) {
        sh.appendChild(el("p", "cl-note", "Requested by " + s.pending.requested_name + " on " + when(s.pending.at) + ": " + (s.pending.reason || "")));
      } else if (s.fail && o.canRequest) {
        var f = el("div", "fld"); var lb = el("label", null, "Why should this event close anyway? (required, 10+ characters)"); lb.htmlFor = "clmReason"; f.appendChild(lb);
        ta = el("textarea"); ta.id = "clmReason"; ta.maxLength = 1000; ta.required = true; ta.setAttribute("aria-describedby", "clmHelp");
        ta.placeholder = "e.g. Client paying the last instalment by bank on Monday; 3 chairs lost, already written off"; f.appendChild(ta);
        var help = el("div", "cl-note", s.adminOnly ? "Some checks can only be approved by an admin." : "An admin, coordinator or manager approves it. Everyone who can approve is notified.");
        help.id = "clmHelp"; f.appendChild(help); sh.appendChild(f); sh.appendChild(err);
        var go = el("button", "btn go cl-anyway", "Request to close anyway"); go.type = "button"; foot.appendChild(go);
        go.addEventListener("click", function () {
          var v = String(ta.value || "").trim();
          if (v.length < 10) { err.textContent = "Write a reason of at least 10 characters - it is saved with your name and shown to the approver."; err.hidden = false; ta.focus(); return; }
          done({ reason: v });
        });
      } else if (s.fail) sh.appendChild(el("p", "cl-note", "Your role can't ask to close this event. Ask an admin."));
      sh.appendChild(foot);
      function done(v) { document.removeEventListener("keydown", onKey, true); ov.remove(); try { if (prev && prev.focus) prev.focus(); } catch (e) {} resolve(v); }
      function onKey(e) { if (e.key === "Escape") { e.preventDefault(); done(null); } }
      cancel.addEventListener("click", function () { done(null); });
      ov.addEventListener("click", function (e) { if (e.target === ov) done(null); });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(ov);
      setTimeout(function () { (ta || cancel).focus(); }, 30);
    });
  }

  var api = { costSplit: costSplit, fixHref: fixHref, icon: icon, summary: summary, buttonState: buttonState, invTotals: invTotals, topCategories: topCategories, pct: pct,
              renderDashboard: renderDashboard, renderChecklist: renderChecklist, renderRequests: renderRequests, openModal: openModal, inventoryTable: inventoryTable };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelmClosure = api;
})(typeof window !== "undefined" ? window : globalThis);
