/* vendor-bills-ui.js - Phase C (0124): vendor bills + payouts (Settlement), per-event P&L card
   (Closure, Budget) and payables / net profit by month / top events (Business).
   Self-mounting: any element with data-vb-mount="bills" | "pnl" | "business" is filled once the
   page's own #app (or #bzApp) is shown, i.e. after the page has checked sign-in and access.
   DOM is built with createElement/textContent only (no HTML strings). Every amount has data-money
   so privacy mode masks it. Bills are never deleted: a wrong bill is voided with a reason. */
(function () {
  "use strict";
  var S = function () { return window.BPStore; };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function money(node) { node.setAttribute("data-money", ""); return node; }
  function qid() { var p = new URLSearchParams(location.search); return p.get("quote") || p.get("id") || ""; }
  function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function today() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function key() { try { if (self.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {} return String(Date.now()) + "-" + Math.random().toString(16).slice(2); }
  function errText(e) { return (e && e.message) ? String(e.message).slice(0, 240) : "Something went wrong - try again."; }
  function missingNote(box, what) {
    var n = el("div", "vb-note");
    n.appendChild(el("b", null, what + " turn on after database update 0124. "));
    n.appendChild(document.createTextNode("Ask your admin to run APPLY-0124.sql (nothing existing is changed)."));
    box.appendChild(n);
  }
  function field(label, input) { var f = el("label", "vb-fld"); f.appendChild(el("span", null, label)); f.appendChild(input); return f; }
  function inp(type, ph) { var i = el("input"); i.type = type; if (ph) i.placeholder = ph; return i; }
  var STATE_LABEL = { paid: "Paid", part: "Part paid", unpaid: "Unpaid", overdue: "Overdue", void: "Void" };

  // ---------------- money formatter per page ----------------
  async function fmtFor(quoteId) {
    var B = S(), cfg = null;
    if (quoteId) { try { var ev = await B.quotes.get(quoteId); cfg = ev ? B.quoteTax(ev) : null; } catch (e) { cfg = null; } }
    return function (n) { try { return cfg ? B.quoteMoney(n, cfg) : B.studioMoney(n); } catch (e) { return String(Math.round(Number(n) || 0)); } };
  }

  // ---------------- Settlement: Vendor bills ----------------
  async function mountBills(box) {
    var B = S(), id = qid(); if (!id) return;
    var fmt = await fmtFor(id), canEdit = false;
    try { canEdit = await B.auth.canEditArea("finance"); } catch (e) { canEdit = false; }
    clear(box); box.classList.add("card", "vb-card"); box.id = box.id || "vendorBills";
    box.appendChild(el("h2", null, "🧾 Vendor bills"));
    box.appendChild(el("p", "sub", "Bills your vendors sent for this event, and what you've paid them. Once a booking has bills, the bills replace its booked cost in the profit."));
    var sum = el("div", "vb-sum"), msg = el("div", "vb-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    var list = el("div", "vb-list"), formBox = el("div", "vb-form");
    box.appendChild(sum); box.appendChild(list); box.appendChild(formBox); box.appendChild(msg);
    var bookings = [];
    try { bookings = (await B.bookings.list(id)).filter(function (b) { return b.status !== "cancelled"; }); } catch (e) { bookings = []; }

    async function reload() {
      clear(list); clear(sum); list.appendChild(el("p", "vb-muted", "Loading…"));
      var bills;
      try { bills = await B.vendorBills.list(id); }
      catch (e) {
        clear(list); clear(formBox);
        if (e && e.code === "vendor_bills_missing") { missingNote(list, "Vendor bills"); return; }
        list.appendChild(el("p", "vb-err", "Couldn't load vendor bills: " + errText(e))); return;
      }
      fig = B.vendorBills.settle(bookings, bills, today()).byBill;   // same rule as the vendor table: advance counts toward the bill
      renderSummary(bills); renderList(bills);
      try { document.dispatchEvent(new CustomEvent("helm:vendor-bills-changed")); } catch (e) {}
    }
    var fig = {};
    function paidOf(b) { var f = fig[b.id]; return f ? f.paid : (b.vendor_payouts || []).reduce(function (a, p) { return a + Number(p.amount || 0); }, 0); }
    function stateOf(b, t) { var f = fig[b.id]; return f && f.state ? f.state : B.vendorBills.state(b, t); }
    function renderSummary(bills) {
      var t = today(), live = bills.filter(function (b) { return b.status !== "void"; });
      var billed = 0, paid = 0, over = 0;
      live.forEach(function (b) { var p = paidOf(b); billed += Number(b.amount || 0); paid += p; if (stateOf(b, t) === "overdue") over += Number(b.amount || 0) - p; });
      [["Billed", billed, ""], ["Paid", paid, "ok"], ["Unpaid", billed - paid, billed - paid > 0 ? "due" : ""], ["Overdue", over, over > 0 ? "over" : ""]].forEach(function (x) {
        var c = el("div", "vb-chip " + x[2]); c.appendChild(el("span", null, x[0])); c.appendChild(money(el("b", null, fmt(x[1])))); sum.appendChild(c);
      });
    }
    function bookingLabel(bid) { var b = bookings.find(function (x) { return x.id === bid; }); return b ? (b.label || "Vendor booking") : ""; }
    function renderList(bills) {
      clear(list);
      if (!bills.length) { list.appendChild(el("p", "vb-muted", canEdit ? "No vendor bills yet. Add the first one below - a photo from WhatsApp is enough." : "No vendor bills yet.")); return; }
      var wrap = el("div", "table-scroll"), tb = el("table", "vb-table"), th = el("thead"), hr = el("tr");
      ["Bill", "Date", "Due", "Amount", "Paid", "Status", ""].forEach(function (h, i) { var c = el("th", i === 3 || i === 4 ? "num" : null, h); c.scope = "col"; hr.appendChild(c); });
      th.appendChild(hr); tb.appendChild(th); var body = el("tbody"); tb.appendChild(body); wrap.appendChild(tb); list.appendChild(wrap);
      var t = today();
      bills.forEach(function (b) {
        var st = stateOf(b, t), paid = paidOf(b), f = fig[b.id], tr = el("tr", st === "void" ? "vb-void" : null);
        var c1 = el("td"); c1.appendChild(el("b", null, b.bill_no ? "#" + b.bill_no : "Bill"));
        var sub = [bookingLabel(b.booking_id), b.description].filter(Boolean).join(" · ");
        if (sub) c1.appendChild(el("div", "vb-muted", sub));
        if (st === "void" && b.void_reason) c1.appendChild(el("div", "vb-muted", "Void: " + b.void_reason));
        tr.appendChild(c1); tr.appendChild(el("td", null, b.bill_date || "")); tr.appendChild(el("td", null, b.due_date || "—"));
        // mask the amount, not the cell: on phones the cell carries its column label (Amount / Paid)
        var ca = el("td", "num"); ca.appendChild(money(el("span", null, fmt(b.amount)))); tr.appendChild(ca);
        var cp = el("td", "num"); cp.appendChild(money(el("span", null, fmt(paid))));
        if (f && f.advance > 0) {   // e.g. ₹18,000 (₹5,000 advance + ₹13,000 payouts)
          var br = el("div", "vb-muted"); br.appendChild(document.createTextNode("("));
          br.appendChild(money(el("span", null, fmt(f.advance)))); br.appendChild(document.createTextNode(" advance + "));
          br.appendChild(money(el("span", null, fmt(f.payouts)))); br.appendChild(document.createTextNode(" payouts)"));
          cp.appendChild(br);
        }
        tr.appendChild(cp);
        var sc = el("td"); sc.appendChild(el("span", "vb-st " + st, STATE_LABEL[st] || st)); tr.appendChild(sc);
        var act = el("td", "vb-act");
        if (b.file_id) {
          var vf = el("button", "btn", "View file"); vf.type = "button";
          vf.addEventListener("click", async function () {
            // open the tab inside the click (popup blockers allow it), then point it at the signed link
            var w = null; try { w = window.open("", "_blank"); if (w) w.opener = null; } catch (e) { w = null; }
            try { var fl = await B.files.list(id); var f = (fl || []).find(function (x) { return x.id === b.file_id; });
              if (!f) throw new Error("The file is no longer there.");
              var u = await B.files.signedUrl(f.storage_path, 120); if (!u) throw new Error("Couldn't open the file - try again.");
              if (w) w.location.href = u; else window.open(u, "_blank", "noopener"); }
            catch (e) { if (w) { try { w.close(); } catch (_) {} } msg.textContent = errText(e); }
          });
          act.appendChild(vf);
        }
        if (canEdit && st !== "void" && st !== "paid") {
          var pb = el("button", "btn go", "Record payout"); pb.type = "button";
          pb.addEventListener("click", function () { openPay(tr, b, Number(b.amount || 0) - paid); }); act.appendChild(pb);
        }
        if (canEdit && st !== "void" && !(f ? f.payouts : paid)) {
          var vb = el("button", "rm", "Void"); vb.type = "button"; vb.title = "Void this bill (it is kept, with the reason)";
          vb.addEventListener("click", function () { openVoid(tr, b); }); act.appendChild(vb);
        }
        tr.appendChild(act); body.appendChild(tr);
      });
    }
    function inlineRow(tr) {
      var nx = tr.nextSibling; if (nx && nx.classList && nx.classList.contains("vb-inline")) { nx.parentNode.removeChild(nx); return null; }
      var r = el("tr", "vb-inline"), td = el("td"); td.colSpan = 7; r.appendChild(td); tr.parentNode.insertBefore(r, tr.nextSibling); return td;
    }
    function openPay(tr, b, left) {
      var td = inlineRow(tr); if (!td) return;
      var k = key();                                              // one key per payout attempt (retries reuse it)
      var amt = inp("number"); amt.min = "0"; amt.step = "0.01"; amt.value = String(Math.round(left * 100) / 100);
      var dt = inp("date"); dt.value = today(); dt.max = today();
      var how = el("select"); ["Bank transfer", "UPI", "Cash", "Cheque", "Card", "Other"].forEach(function (m) { var o = el("option", null, m); o.value = m; how.appendChild(o); });
      var ref = inp("text", "UTR / cheque no. (optional)"); ref.maxLength = 120;
      var go = el("button", "btn primary", "Save payout"); go.type = "button";
      var row = el("div", "vb-grid"); row.appendChild(field("Amount (left " + fmt(left) + ")", amt)); row.appendChild(field("Paid on", dt));
      row.appendChild(field("How", how)); row.appendChild(field("Reference", ref)); var g = el("div", "vb-fld"); g.appendChild(go); row.appendChild(g); td.appendChild(row);
      // dev pass 3: payout errors show right here, next to the payout amount (not under the Add-bill form)
      var pmsg = el("p", "vb-err"); pmsg.setAttribute("role", "alert"); pmsg.hidden = true; td.appendChild(pmsg);
      function perr(t) { pmsg.textContent = t; pmsg.hidden = !t; if (t) amt.setAttribute("aria-invalid", "true"); else amt.removeAttribute("aria-invalid"); }
      go.addEventListener("click", async function () {
        var a = Number(amt.value);
        if (!(a > 0)) { perr("Enter an amount above zero."); amt.focus(); return; }
        if (a > left + 0.005) { perr("That's more than the " + fmt(left) + " left on this bill."); amt.focus(); return; }
        perr(""); go.disabled = true; msg.textContent = "Saving…";
        try { var r = await B.vendorBills.pay(b.id, a, dt.value, how.value, ref.value, k);
          msg.textContent = r && r.duplicate ? "Already recorded." : "Payout recorded."; await reload(); }
        catch (e) { go.disabled = false; msg.textContent = ""; perr(errText(e)); }
      });
    }
    function openVoid(tr, b) {
      var td = inlineRow(tr); if (!td) return;
      var rs = inp("text", "Why is this bill wrong? (kept on record)"); rs.maxLength = 300;
      var go = el("button", "btn", "Void bill"); go.type = "button";
      var row = el("div", "vb-grid"); row.appendChild(field("Reason", rs)); var g = el("div", "vb-fld"); g.appendChild(go); row.appendChild(g); td.appendChild(row);
      go.addEventListener("click", async function () {
        if (String(rs.value || "").trim().length < 3) { msg.textContent = "Give a reason (at least 3 characters)."; return; }
        go.disabled = true;
        try { await B.vendorBills.void(b.id, rs.value); msg.textContent = "Bill voided (kept on record)."; await reload(); }
        catch (e) { go.disabled = false; msg.textContent = errText(e); }
      });
    }
    function renderForm() {
      clear(formBox); if (!canEdit) return;
      var tabs = el("div", "vb-tabs"), full = el("button", "btn vb-on", "Add a bill"), quick = el("button", "btn", "📲 Quick add from WhatsApp");
      full.type = quick.type = "button"; tabs.appendChild(full); tabs.appendChild(quick); formBox.appendChild(tabs);
      var g = el("div", "vb-grid");
      var bk = el("select"); var o0 = el("option", null, "Not linked to a booking"); o0.value = ""; bk.appendChild(o0);
      bookings.forEach(function (b) { var o = el("option", null, (b.label || "Vendor booking") + (b.cost != null ? " (booked " + fmt(b.cost) + ")" : "")); o.value = b.id; bk.appendChild(o); });
      var no = inp("text", "e.g. INV-204"); no.maxLength = 80;
      var bd = inp("date"); bd.value = today();
      var dd = inp("date");
      var amt = inp("number", "0"); amt.min = "0"; amt.step = "0.01";
      var ds = inp("text", "e.g. Flowers - stage + entrance"); ds.maxLength = 500;
      var fl = inp("file"); fl.accept = "image/png,image/jpeg,image/webp,application/pdf";
      var add = el("button", "btn primary", "Add bill"); add.type = "button";
      var fBk = field("Vendor booking", bk), fNo = field("Bill no.", no), fBd = field("Bill date", bd), fDd = field("Due date", dd),
          fAmt = field("Amount", amt), fDs = field("What for", ds), fFl = field("Photo / PDF", fl), fGo = el("div", "vb-fld");
      fGo.appendChild(add);
      [fBk, fNo, fBd, fDd, fAmt, fDs, fFl, fGo].forEach(function (n) { g.appendChild(n); });
      formBox.appendChild(g);
      var quickMode = false;
      function mode(q) {
        quickMode = q; full.classList.toggle("vb-on", !q); quick.classList.toggle("vb-on", q);
        [fBk, fNo, fBd, fDd, fDs].forEach(function (n) { n.hidden = q; });
        fl.accept = q ? "image/png,image/jpeg,image/webp" : "image/png,image/jpeg,image/webp,application/pdf";
        fFl.firstChild.textContent = q ? "WhatsApp photo of the bill" : "Photo / PDF";
      }
      full.addEventListener("click", function () { mode(false); }); quick.addEventListener("click", function () { mode(true); });
      add.addEventListener("click", async function () {
        var a = Number(amt.value);
        if (!(a > 0)) { msg.textContent = "Enter the bill amount (above zero)."; amt.focus(); return; }
        var file = fl.files && fl.files[0] ? fl.files[0] : null;
        if (quickMode && !file) { msg.textContent = "Choose the photo of the bill."; return; }
        if (!quickMode && dd.value && bd.value && dd.value < bd.value) { msg.textContent = "The due date is before the bill date."; return; }
        add.disabled = true; msg.textContent = file ? "Uploading…" : "Saving…";
        try {
          await B.vendorBills.add(id, quickMode
            ? { amount: a, description: "From WhatsApp", bill_date: today() }
            : { amount: a, bill_no: no.value, bill_date: bd.value, due_date: dd.value, description: ds.value, booking_id: bk.value || null,
                vendor_id: (bookings.find(function (b) { return b.id === bk.value; }) || {}).vendor_id || null }, file);
          msg.textContent = "Bill added."; amt.value = ""; no.value = ""; ds.value = ""; dd.value = ""; fl.value = ""; await reload();
        } catch (e) { msg.textContent = (e && e.code === "vendor_bills_missing") ? e.message : errText(e); }
        add.disabled = false;
      });
    }
    renderForm(); await reload();
  }

  // ---------------- Closure / Budget: per-event P&L ----------------
  async function mountPnl(box) {
    var B = S(), id = qid(); if (!id) return;
    var fmt = await fmtFor(id);
    clear(box); box.classList.add("card", "vb-card");
    box.appendChild(el("h2", null, "📊 Net profit"));
    box.appendChild(el("p", "sub", "Revenue (without tax) − vendors − logistics & other − staff expenses."));
    var body = el("div", "vb-pnl"); box.appendChild(body);
    var seq = 0, timer = null;
    var replaces = box.getAttribute("data-vb-replaces") ? document.getElementById(box.getAttribute("data-vb-replaces")) : null;
    async function draw() {
      var my = ++seq;
      if (!body.firstChild) body.appendChild(el("p", "vb-muted", "Loading…"));
      var p; try { p = await B.vendorBills.pnl(id); } catch (e) { if (my !== seq) return; clear(body); body.appendChild(el("p", "vb-err", "Couldn't work out the profit: " + errText(e))); return; }
      if (my !== seq) return;                                     // a newer refresh is on its way
      clear(body);
      [["Revenue", p.revenue, "", ""], ["Vendors", p.vendors, "− ", "neg"], ["Logistics & other", p.other, "− ", "neg"], ["Staff expenses", p.staff, "− ", "neg"]].forEach(function (r) {
        var row = el("div", "vb-pl-row"); row.appendChild(el("span", null, r[0])); row.appendChild(money(el("b", r[3], r[2] + fmt(r[1])))); body.appendChild(row);
      });
      var net = Number(p.net_profit || 0), tot = el("div", "vb-pl-row vb-pl-net");
      tot.appendChild(el("span", null, "Net profit" + (p.margin_pct != null ? " (" + p.margin_pct + "%)" : "")));
      tot.appendChild(money(el("b", net < 0 ? "neg" : "pos", fmt(net)))); body.appendChild(tot);
      if (Number(p.tax || 0) > 0) { var tx = el("p", "vb-muted"); tx.appendChild(document.createTextNode("Tax collected (payable, not profit): ")); tx.appendChild(money(el("span", null, fmt(p.tax)))); body.appendChild(tx); }
      if (p.source === "client" && p.missing0124) body.appendChild(el("p", "vb-muted", "Vendor bills aren't counted yet - they start counting after database update 0124."));
      // one profit number per page: once the full P&L (with vendor bills) is live, hide the older card it replaces
      if (replaces) replaces.hidden = p.source === "server";
    }
    function soon() { clearTimeout(timer); timer = setTimeout(draw, 150); }
    document.addEventListener("helm:vendor-bills-changed", soon);
    document.addEventListener("helm:pnl-refresh", soon);
    await draw();
  }

  // ---------------- Business: payables, net profit by month, top events ----------------
  async function mountBusiness(box) {
    var B = S(), fmt = function (n) { try { return B.studioMoney(n); } catch (e) { return String(Math.round(n)); } };
    clear(box); box.hidden = false; box.classList.add("vb-biz");
    var h = el("section", "bz-card vb-card"); box.appendChild(h);
    h.appendChild(el("h2", null, "Vendor payables & net profit"));
    h.appendChild(el("p", "vb-muted", "What you owe vendors, and profit after vendors, logistics and staff expenses (confirmed events: the last 12 months and the next 12)."));
    var pay, biz;
    try { pay = await B.vendorBills.payables(); } catch (e) { pay = null; }
    // upcoming confirmed events count too (most studios book months ahead); the server allows up to 3 years
    try { var d = new Date(), from = new Date(d.getFullYear(), d.getMonth() - 11, 1), to = new Date(d.getFullYear(), d.getMonth() + 13, 0);
      biz = await B.vendorBills.business(ymd(from), ymd(to)); } catch (e) { biz = null; }
    if (!pay && !biz) { missingNote(h, "Payables and net profit"); return; }
    if (pay) {
      var tiles = el("div", "vb-sum");
      [["Owed to vendors", pay.outstanding, pay.outstanding > 0 ? "due" : ""], ["Overdue", pay.overdue, pay.overdue > 0 ? "over" : ""],
       ["Due in 7 days", pay.due_7d, ""], ["Paid to vendors", pay.paid, "ok"]].forEach(function (x) {
        var c = el("div", "vb-chip " + x[2]); c.appendChild(el("span", null, x[0])); c.appendChild(money(el("b", null, fmt(Number(x[1] || 0))))); tiles.appendChild(c);
      });
      h.appendChild(tiles);
    }
    var evs = biz && Array.isArray(biz.events) ? biz.events : [];
    if (!evs.length) { h.appendChild(el("p", "vb-muted", "No confirmed events in the last 12 months or the next 12 yet.")); return; }
    var byMonth = {};
    evs.forEach(function (e) { var m = String(e.date || "").slice(0, 7); if (!m) return; byMonth[m] = byMonth[m] || { rev: 0, net: 0, n: 0 }; byMonth[m].rev += Number(e.revenue || 0); byMonth[m].net += Number(e.net_profit || 0); byMonth[m].n++; });
    function table(head, rows) {
      var w = el("div", "table-scroll"), t = el("table", "vb-table"), th = el("thead"), tr = el("tr");
      head.forEach(function (x, i) { var c = el("th", i > 0 ? "num" : null, x); c.scope = "col"; tr.appendChild(c); }); th.appendChild(tr); t.appendChild(th);
      var b = el("tbody"); rows.forEach(function (r) { var row = el("tr"); r.forEach(function (v, i) { var c = el("td", i > 0 ? "num" : null); if (v && v.nodeType) c.appendChild(v); else if (i > 1 && typeof v === "string") c.appendChild(money(el("span", null, v))); else c.textContent = v; row.appendChild(c); }); b.appendChild(row); });
      t.appendChild(b); w.appendChild(t); return w;
    }
    h.appendChild(el("h3", null, "Net profit by month"));
    var months = Object.keys(byMonth).sort().reverse(), thisMonth = today().slice(0, 7);
    h.appendChild(table(["Month", "Events", "Revenue", "Net profit"], months.map(function (m) {
      var x = byMonth[m], d = new Date(m + "-01T00:00:00");
      return [d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) + (m > thisMonth ? " (upcoming)" : ""), String(x.n), fmt(x.rev), fmt(x.net)];
    })));
    h.appendChild(el("h3", null, "Top events by profit"));
    var top = evs.slice().sort(function (a, b) { return Number(b.net_profit || 0) - Number(a.net_profit || 0); }).slice(0, 10);
    h.appendChild(table(["Event", "Margin", "Revenue", "Net profit"], top.map(function (e) {
      var a = el("a", null, (e.code ? e.code + " · " : "") + (e.title || "Event")); a.href = "closure.html?quote=" + encodeURIComponent(e.quote_id);
      return [a, e.margin_pct != null ? e.margin_pct + "%" : "—", fmt(e.revenue), fmt(e.net_profit)];
    })));
  }

  // ---------------- self-mount once the page shows its app ----------------
  var MOUNTS = { bills: mountBills, pnl: mountPnl, business: mountBusiness };
  function whenShown(gate, fn) {
    if (!gate) return;
    var done = false, run = function () { if (done || gate.hidden) return; done = true; obs.disconnect(); fn(); };
    var obs = new MutationObserver(run); obs.observe(gate, { attributes: true, attributeFilter: ["hidden"] }); run();
  }
  function start() {
    var nodes = document.querySelectorAll("[data-vb-mount]");
    Array.prototype.forEach.call(nodes, function (n) {
      var fn = MOUNTS[n.getAttribute("data-vb-mount")]; if (!fn) return;
      var gate = document.getElementById(n.getAttribute("data-vb-gate") || "app");
      whenShown(gate, function () { Promise.resolve().then(function () { return fn(n); }).catch(function (e) { try { console.warn("vendor bills:", e && e.message); } catch (_) {} }); });
    });
  }
  window.HelmVendorBills = { mountBills: mountBills, mountPnl: mountPnl, mountBusiness: mountBusiness };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
