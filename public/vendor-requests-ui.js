/* vendor-requests-ui.js - Vendors page, "Requests & invoices" tab (0256, r23).
   Assign a vendor to an event (what / when / where / details / agreed amount) -> the vendor answers from a one-tap
   link (or a planner records the answer) -> reassign / cancel; the vendor's invoices arrive from the same link and
   Finance approves (-> vendor bill = Actual cost in Budget / Closure / Insights), queries or rejects them; payments
   go through the existing vendor-bill payout (paid / partial / due). Every call is an RPC that checks the studio and
   the Vendors / Finance areas in the database. DOM built with textContent only (no innerHTML of data). */
(function (global) {
  "use strict";
  var doc = global.document;
  if (!doc) return;
  var S = function () { return global.BPStore; }, U = function () { return global.BPUI; };
  var qs = new URLSearchParams(global.location.search);
  var quoteId = qs.get("quote") || qs.get("id") || null;
  var state = { rows: [], filter: "open", canAssign: false, canReview: false, vendors: null, events: null, loaded: false };

  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v;
      else if (k === "on") Object.keys(v).forEach(function (e) { el.addEventListener(e, v[e]); });
      else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function toast(msg, type) { try { U().toast(msg, { type: type || "info" }); } catch (e) { /* ignore */ } }
  function friendly(e, action) { try { return U().friendlyError(e, { action: action }); } catch (x) { return (e && e.message) || "Something went wrong."; } }
  function inr(n) { var v = Number(n); if (!isFinite(v)) return ""; return "₹" + v.toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
  function tz() { try { return S().studioTimezone() || "Asia/Kolkata"; } catch (e) { return "Asia/Kolkata"; } }
  function pill(text, kind) { return h("span", { cls: "vrq-pill vrq-" + kind, text: text }); }
  var PILL = { sent: "wait", accepted: "ok", rejected: "bad", cancelled: "off", reassigned: "off",
    submitted: "wait", queried: "warn", approved: "ok", superseded: "off" };

  /* ---------------------------------------------------------------- tab switch */
  function setView(v) {
    var reqs = v === "requests";
    var pv = doc.getElementById("partnersView"), rv = doc.getElementById("requestsView");
    if (pv) pv.hidden = reqs; if (rv) rv.hidden = !reqs;
    Array.prototype.forEach.call(doc.querySelectorAll("#viewTabs [data-view]"), function (b) {
      var on = b.getAttribute("data-view") === v; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
    try { var u = new URL(global.location.href); if (reqs) u.searchParams.set("tab", "requests"); else u.searchParams.delete("tab"); global.history.replaceState(null, "", u.toString()); } catch (e) { /* ignore */ }
    if (reqs && !state.loaded) load();
  }

  /* ---------------------------------------------------------------- data */
  function load() {
    var box = doc.getElementById("vrqList"); if (!box) return Promise.resolve();
    state.loaded = true;
    clear(box); box.appendChild(h("div", { cls: "empty", text: "Loading requests…" }));
    return S().vendorRequests.list(quoteId, null).then(function (rows) { state.rows = rows || []; render(); },
      function (e) { clear(box); box.appendChild(h("div", { cls: "err", role: "alert", text: friendly(e, "load vendor requests") })); });
  }
  function matches(r) {
    var f = state.filter;
    if (f === "all") return true;
    if (f === "open") return r.status === "sent" || r.status === "accepted";
    if (f === "review") return (r.invoices || []).some(function (i) { return i.status === "submitted"; });
    if (f === "unpaid") return (r.invoices || []).some(function (i) { return i.status === "approved" && i.pay_status !== "paid"; });
    if (f === "closed") return r.status === "rejected" || r.status === "cancelled" || r.status === "reassigned";
    return true;
  }
  function render() {
    var box = doc.getElementById("vrqList"); clear(box);
    var rows = state.rows.filter(matches);
    var cnt = doc.getElementById("vrqCount");
    if (cnt) cnt.textContent = state.rows.length ? rows.length + " of " + state.rows.length : "";
    if (!state.rows.length) {
      box.appendChild(h("div", { cls: "empty" }, [
        h("p", { text: quoteId ? "No vendor requests for this event yet." : "No vendor requests yet." }),
        h("p", { cls: "meta", text: "Send a vendor what you need, when and where, and the agreed amount. They accept or decline from a link (no sign-in) and send their invoice the same way." }),
        state.canAssign ? h("button", { type: "button", cls: "btn primary", text: "＋ New request", on: { click: function () { openForm(); } } }) : null]));
      return;
    }
    if (!rows.length) { box.appendChild(h("div", { cls: "empty", text: "Nothing in this filter." })); return; }
    rows.forEach(function (r) { box.appendChild(card(r)); });
  }

  /* ---------------------------------------------------------------- one request card */
  function card(r) {
    var item = r.what + (Number(r.qty) > 0 ? " × " + Number(r.qty).toLocaleString("en-IN") : "");
    var st = [pill(S().vendorRequests.statusLabel(r.status), PILL[r.status] || "off")];
    if (r.overdue_reply) st.push(pill("Reply overdue", "bad"));
    if (r.invoices_open) st.push(pill(r.invoices_open + " invoice" + (r.invoices_open === 1 ? "" : "s") + " to review", "warn"));
    if (r.over_agreed) st.push(pill("Billed above agreed", "bad"));
    var c = h("article", { cls: "vrq-card vrq-s-" + r.status, "data-id": r.id }, [
      h("div", { cls: "vrq-head" }, [h("span", { cls: "nm", text: r.vendor_name }), h("span", { cls: "vrq-pills" }, st)]),
      h("div", { cls: "vrq-what", text: item }),
      h("div", { cls: "meta" }, [
        quoteId ? null : h("a", { href: "event.html?id=" + encodeURIComponent(r.quote_id), cls: "vrq-ev", text: (r.event_code || "Event") + (r.event_title ? " · " + r.event_title : "") }),
        quoteId ? null : " · ",
        "When " + (r.when_text || "-"), r.where_text ? " · " + r.where_text : ""]),
      r.details ? h("div", { cls: "meta vrq-det", text: r.details }) : null,
      h("div", { cls: "meta" }, [
        r.agreed_amount != null ? h("b", { text: "Agreed " + inr(r.agreed_amount) }) : null,
        r.agreed_amount != null ? " · " : null,
        r.status === "sent" ? "Reply by " + (r.respond_by_text || "-") : (r.responded_text ? (r.status === "accepted" ? "Accepted " : "Answered ") + r.responded_text + (r.responded_via === "studio" ? " (recorded by the studio)" : "") : ""),
        r.emails_sent ? " · " + r.emails_sent + " e-mail" + (r.emails_sent === 1 ? "" : "s") + " sent" : (r.emails_queued ? " · e-mail queued" : "")]),
      r.response_note ? h("div", { cls: "vrq-note", text: "“" + r.response_note + "”" }) : null]);
    // invoices
    var inv = (r.invoices || []).filter(function (i) { return i.status !== "superseded"; });
    if (inv.length) {
      var ul = h("ul", { cls: "vrq-inv" });
      inv.forEach(function (i) { ul.appendChild(invoiceRow(r, i)); });
      c.appendChild(ul);
    }
    // actions
    var acts = h("div", { cls: "acts" });
    if (state.canAssign && (r.status === "sent" || r.status === "accepted")) {
      acts.appendChild(h("button", { type: "button", cls: "ic", text: "Share link", on: { click: function () { share(r); } } }));
    }
    if (state.canAssign && r.status === "sent") {
      acts.appendChild(h("button", { type: "button", cls: "ic", text: "Record answer", on: { click: function () { recordAnswer(r); } } }));
    }
    if (state.canAssign && (r.status === "sent" || r.status === "accepted" || (r.status === "rejected" && !r.replaced_by)) && !(r.invoices_open || r.invoices_queried || r.invoices_approved)) {
      acts.appendChild(h("button", { type: "button", cls: "ic", text: "Reassign", on: { click: function () { openReassign(r); } } }));
    }
    if (state.canAssign && (r.status === "sent" || r.status === "accepted") && !(r.invoices_open || r.invoices_queried || r.invoices_approved)) {
      acts.appendChild(h("button", { type: "button", cls: "ic vrq-danger", text: "Cancel", on: { click: function () { cancel(r); } } }));
    }
    acts.appendChild(h("button", { type: "button", cls: "ic", text: "History", on: { click: function () { history(r); } } }));
    c.appendChild(acts);
    return c;
  }
  function invoiceRow(r, i) {
    var pay = i.status === "approved" && i.pay_status ? (i.pay_status === "paid" ? pill("Paid", "ok") : i.pay_status === "partial" ? pill("Part paid · " + inr(i.balance) + " due", "warn") : pill(inr(i.balance) + " due", "wait")) : null;
    var gst = Number(i.cgst) > 0 ? "CGST " + inr(i.cgst) + " + SGST " + inr(i.sgst) : Number(i.igst) > 0 ? "IGST " + inr(i.igst) : "no GST";
    var li = h("li", { cls: "vrq-inv-row" }, [
      h("div", { cls: "vrq-inv-top" }, [h("b", { text: "Invoice " + i.invoice_no }), h("span", { text: inr(i.total_amount) }),
        pill(S().vendorRequests.invoiceLabel(i.status), PILL[i.status] || "off"), pay,
        i.possible_duplicate ? pill("Same number as a typed bill", "bad") : null]),
      h("div", { cls: "meta", text: (i.invoice_date || "") + " · taxable " + inr(i.taxable_amount) + " · " + gst + (i.vendor_gstin ? " · GSTIN " + i.vendor_gstin : "")
        + (i.tds_amount ? " · TDS " + inr(i.tds_amount) + " (" + i.tds_section + ")" : "") }),
      i.notes ? h("div", { cls: "meta", text: "Vendor: " + i.notes }) : null,
      i.review_note ? h("div", { cls: "vrq-note", text: "Studio: " + i.review_note }) : null]);
    var acts = h("div", { cls: "acts" });
    if (i.has_file) acts.appendChild(h("button", { type: "button", cls: "ic", text: "View file", on: { click: function () { viewFile(i); } } }));
    if (state.canReview && i.status === "submitted") {
      acts.appendChild(h("button", { type: "button", cls: "ic vrq-ok", text: "Approve", on: { click: function () { openApprove(r, i); } } }));
      acts.appendChild(h("button", { type: "button", cls: "ic", text: "Query", on: { click: function () { reviewNote(i, "query"); } } }));
      acts.appendChild(h("button", { type: "button", cls: "ic vrq-danger", text: "Reject", on: { click: function () { reviewNote(i, "reject"); } } }));
    }
    if (state.canReview && i.status === "approved" && i.bill_id && Number(i.balance) > 0.004) {
      acts.appendChild(h("button", { type: "button", cls: "ic vrq-ok", text: "Record payment", on: { click: function () { openPay(i); } } }));
    }
    if (acts.firstChild) li.appendChild(acts);
    return li;
  }

  /* ---------------------------------------------------------------- actions */
  function share(r) {
    S().vendorRequests.issueLink(r.id).then(function (l) {
      var url = S().vendorRequests.linkUrl(l && l.token);
      if (!url) throw new Error("No link");
      var text = "Hello " + r.vendor_name + ", please confirm " + r.what + (Number(r.qty) > 0 ? " x" + r.qty : "") + " for " + (r.event_title || "our event")
        + " (" + (r.when_text || "") + "). Accept or decline here, and send your invoice the same way: " + url;
      sheet("Share the request link", [
        h("p", { cls: "meta", text: "The link opens only this request, without signing in. It expires " + (l.expires_text || "after the event") + "." }),
        h("input", { cls: "vrq-link", value: url, readonly: true, "aria-label": "Request link", on: { focus: function (e) { e.target.select(); } } }),
        h("div", { cls: "foot" }, [
          h("a", { cls: "btn", href: "https://wa.me/" + String(r.contact_phone || "").replace(/\D/g, "") + "?text=" + encodeURIComponent(text), target: "_blank", rel: "noopener noreferrer", text: "Open in WhatsApp" }),
          h("button", { type: "button", cls: "btn primary", text: "Copy link", on: { click: function () {
            try { global.navigator.clipboard.writeText(url).then(function () { toast("Link copied.", "ok"); }); } catch (e) { toast("Select the link and copy it.", "info"); } } } })])]);
    }).catch(function (e) { toast(friendly(e, "make a link"), "err"); });
  }
  function recordAnswer(r) {
    U().confirm("Did " + r.vendor_name + " accept this request? Choose Accepted or Declined (you will be asked for the reason).",
      { title: "Record the vendor's answer", okLabel: "Accepted", cancelLabel: "Declined" }).then(function (yes) {
      var go = function (status, note) {
        return S().vendorRequests.setStatus(r.id, status, note).then(function () { toast(status === "accepted" ? "Recorded: accepted." : "Recorded: declined.", "ok"); return load(); },
          function (e) { toast(friendly(e, "record the answer"), "err"); });
      };
      if (yes) return U().prompt("Note (optional)", { title: "Accepted", label: "Note (optional)", maxLength: 500 }).then(function (n) { if (n === null) return; return go("accepted", n); });
      return U().prompt("Why did they decline?", { title: "Declined", label: "Reason", maxLength: 500, required: true }).then(function (n) {
        if (n === null) return; if (String(n).trim().length < 3) { toast("Say why the vendor declined.", "err"); return; } return go("rejected", n); });
    });
  }
  function cancel(r) {
    U().prompt("Why is this request cancelled?", { title: "Cancel the request to " + r.vendor_name, label: "Reason", maxLength: 500, required: true, okLabel: "Cancel request", cancelLabel: "Keep it" }).then(function (n) {
      if (n === null) return; if (String(n).trim().length < 3) { toast("Say why it is cancelled.", "err"); return; }
      return S().vendorRequests.cancel(r.id, n).then(function () { toast("Request cancelled. History is kept.", "ok"); return load(); },
        function (e) { toast(friendly(e, "cancel the request"), "err"); });
    });
  }
  function history(r) {
    S().vendorRequests.history(r.id).then(function (hst) {
      var ul = h("ul", { cls: "vrq-hist" });
      (hst.log || []).forEach(function (l) { ul.appendChild(h("li", {}, [h("b", { text: l.at_text + " · " + l.event.replace(/_/g, " ") }), " ", l.actor ? "(" + l.actor + ")" : "", l.note ? h("div", { cls: "meta", text: l.note }) : null])); });
      (hst.sends || []).forEach(function (s) { ul.appendChild(h("li", { cls: "meta", text: s.at_text + " · " + s.kind + " " + s.channel + ": " + s.status + (s.reason ? " (" + s.reason.replace(/_/g, " ") + ")" : "") })); });
      sheet("History · " + r.vendor_name, [ul]);
    }).catch(function (e) { toast(friendly(e, "load the history"), "err"); });
  }
  function viewFile(i) {
    S().vendorRequests.fileUrl(i.storage_path).then(function (u) { if (!u) throw new Error("not available"); global.open(u, "_blank", "noopener"); })
      .catch(function (e) { toast(friendly(e, "open the invoice file"), "err"); });
  }
  function reviewNote(i, action) {
    U().prompt(action === "query" ? "What should the vendor fix or add?" : "Why is this invoice rejected?",
      { title: (action === "query" ? "Query invoice " : "Reject invoice ") + i.invoice_no, label: "Message to the vendor", maxLength: 500, required: true, multiline: true,
        okLabel: action === "query" ? "Send query" : "Reject invoice" }).then(function (n) {
      if (n === null) return; if (String(n).trim().length < 3) { toast("Tell the vendor what is wrong.", "err"); return; }
      return S().vendorRequests.review(i.id, action, n, {}).then(function () { toast(action === "query" ? "Query sent - the vendor sees it on their link." : "Invoice rejected.", "ok"); return load(); },
        function (e) { toast(friendly(e, "review the invoice"), "err"); });
    });
  }
  function openApprove(r, i) {
    var approvedSoFar = (r.invoices || []).filter(function (x) { return x.status === "approved"; }).reduce(function (a, x) { return a + Number(x.total_amount || 0); }, 0);
    var over = approvedSoFar + Number(i.total_amount) > Number(r.agreed_amount || 0) + 0.005;
    var claim = h("select", { id: "vrqClaim" }, [h("option", { value: "", text: "Default (yes, except food / catering)" }), h("option", { value: "yes", text: "Yes - claim input credit" }), h("option", { value: "no", text: "No - GST is a cost" })]);
    var tdsS = h("select", { id: "vrqTdsS" }, ["", "194C", "194J", "194I", "194H", "194Q"].map(function (x) { return h("option", { value: x, text: x || "No TDS" }); }));
    var tdsA = h("input", { id: "vrqTdsA", type: "number", inputmode: "decimal", min: "0", step: "0.01" });
    var due = h("input", { id: "vrqDue", type: "date" });
    var allow = h("input", { id: "vrqOver", type: "checkbox" });
    var errEl = h("div", { cls: "err", role: "alert", hidden: true });
    var go = h("button", { type: "button", cls: "btn primary", text: "Approve invoice" });
    var body = [
      h("p", { cls: "meta", text: "Approving adds this invoice as the vendor's actual cost for the event (Budget, Closure and Insights margins update). Payments are recorded against it." }),
      h("div", { cls: "vrq-match" }, [
        h("div", {}, [h("span", { cls: "meta", text: "Agreed" }), h("b", { text: inr(r.agreed_amount) })]),
        h("div", {}, [h("span", { cls: "meta", text: "Approved so far" }), h("b", { text: inr(approvedSoFar) })]),
        h("div", {}, [h("span", { cls: "meta", text: "This invoice" }), h("b", { text: inr(i.total_amount) })])]),
      h("div", { cls: "fgrid" }, [
        h("div", { cls: "fld" }, [h("label", { for: "vrqClaim", text: "GST input credit" }), claim]),
        h("div", { cls: "fld" }, [h("label", { for: "vrqDue", text: "Pay by (optional)" }), due]),
        h("div", { cls: "fld" }, [h("label", { for: "vrqTdsS", text: "TDS section (optional)" }), tdsS]),
        h("div", { cls: "fld" }, [h("label", { for: "vrqTdsA", text: "TDS amount (₹)" }), tdsA])]),
      over ? h("label", { cls: "vrq-over" }, [allow, h("span", { text: "Approve above the agreed amount (" + inr(approvedSoFar + Number(i.total_amount) - Number(r.agreed_amount || 0)) + " more than agreed)" })]) : null,
      errEl, h("div", { cls: "foot" }, [go])];
    var close = sheet("Approve invoice " + i.invoice_no + " · " + r.vendor_name, body);
    go.addEventListener("click", function () {
      var opts = {};
      if (claim.value) opts.gst_claimable = claim.value === "yes";
      if (tdsS.value) opts.tds_section = tdsS.value;
      if (tdsA.value !== "") { var t = Number(tdsA.value); if (!isFinite(t) || t < 0) { errEl.textContent = "TDS must be 0 or more."; errEl.hidden = false; return; } opts.tds_amount = Math.round(t * 100) / 100; }
      if (due.value) opts.due_date = due.value;
      if (over) { if (!allow.checked) { errEl.textContent = "Tick “Approve above the agreed amount” to go ahead."; errEl.hidden = false; return; } opts.allow_over = true; }
      go.disabled = true;
      S().vendorRequests.review(i.id, "approve", null, opts).then(function () { close(); toast("Invoice approved - it is now in the event's costs.", "ok"); return load(); },
        function (e) { go.disabled = false; errEl.textContent = friendly(e, "approve the invoice"); errEl.hidden = false; });
    });
  }
  function openPay(i) {
    var amt = h("input", { id: "vrqPayAmt", type: "number", inputmode: "decimal", min: "0", step: "0.01", value: String(Number(i.balance).toFixed(2)) });
    var method = h("select", { id: "vrqPayM" }, ["UPI", "Bank transfer", "Cheque", "Cash", "TDS deducted"].map(function (x) { return h("option", { value: x.toLowerCase(), text: x }); }));
    var ref = h("input", { id: "vrqPayRef", maxlength: "120", autocomplete: "off" });
    var day = h("input", { id: "vrqPayDay", type: "date" });
    try { var d = new Date(); day.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); } catch (e) { /* ignore */ }
    var errEl = h("div", { cls: "err", role: "alert", hidden: true });
    var go = h("button", { type: "button", cls: "btn primary", text: "Record payment" });
    var close = sheet("Pay invoice " + i.invoice_no, [
      h("p", { cls: "meta", text: "Left to pay " + inr(i.balance) + (i.tds_amount ? " (TDS " + inr(i.tds_amount) + " - record it as “TDS deducted”)" : "") + ". Cash above ₹10,000 to one person in a day is not deductible for income tax." }),
      h("div", { cls: "fgrid" }, [
        h("div", { cls: "fld" }, [h("label", { for: "vrqPayAmt", text: "Amount (₹)" }), amt]),
        h("div", { cls: "fld" }, [h("label", { for: "vrqPayDay", text: "Paid on" }), day]),
        h("div", { cls: "fld" }, [h("label", { for: "vrqPayM", text: "Method" }), method]),
        h("div", { cls: "fld" }, [h("label", { for: "vrqPayRef", text: "Reference (UTR / cheque no.)" }), ref])]),
      errEl, h("div", { cls: "foot" }, [go])]);
    var key = "vrq-" + i.id + "-" + Date.now();
    go.addEventListener("click", function () {
      var a = Number(amt.value);
      if (!(a > 0) || a > Number(i.balance) + 0.004) { errEl.textContent = "Enter an amount above 0 and up to " + inr(i.balance) + "."; errEl.hidden = false; return; }
      go.disabled = true;
      S().vendorBills.pay(i.bill_id, a, day.value || null, method.value, ref.value.trim() || null, key).then(function () { close(); toast("Payment recorded.", "ok"); return load(); },
        function (e) { go.disabled = false; errEl.textContent = friendly(e, "record the payment"); errEl.hidden = false; });
    });
  }

  /* ---------------------------------------------------------------- new request / reassign */
  function vendorsList() {
    if (state.vendors) return Promise.resolve(state.vendors);
    return S().vendors.listAll(false).then(function (v) { state.vendors = (v || []).filter(function (x) { return x.active !== false; }); return state.vendors; });
  }
  function eventsList() {
    if (quoteId) return Promise.resolve(null);
    if (state.events) return Promise.resolve(state.events);
    return S().quotes.list().then(function (l) {
      state.events = (l || []).filter(function (q) { var s = String(q.status || "").toLowerCase(); return q.id && s !== "lost" && s !== "cancelled"; }).slice(0, 200);
      return state.events; });
  }
  function vendorSelect(id, list, exclude) {
    return h("select", { id: id }, [h("option", { value: "", text: "Choose a vendor…" })].concat(list.filter(function (v) { return v.id !== exclude; }).map(function (v) {
      return h("option", { value: v.id, text: v.name + (v.category ? " · " + v.category : "") + (v.email ? "" : " (no e-mail - share the link)") }); })));
  }
  function openForm() {
    Promise.all([vendorsList(), eventsList()]).then(function (res) {
      var vend = res[0], evs = res[1];
      if (!vend.length) { toast("Add the vendor in Partners first.", "info"); return; }
      var ev = evs ? h("select", { id: "vrqEv" }, [h("option", { value: "", text: "Choose the event…" })].concat(evs.map(function (q) {
        return h("option", { value: q.id, text: (q.code || "") + " · " + (q.title || "Event") + (q.eventDate ? " · " + String(q.eventDate).slice(0, 10).split("-").reverse().join("/") : "") }); }))) : null;
      var vs = vendorSelect("vrqV", vend, null);
      var what = h("input", { id: "vrqWhat", maxlength: "200", placeholder: "e.g. Chairs (white chiavari)", autocomplete: "off" });
      var qty = h("input", { id: "vrqQty", type: "number", inputmode: "decimal", min: "0", step: "1" });
      var dt = h("input", { id: "vrqDate", type: "date" }), tm = h("input", { id: "vrqTime", type: "time", value: "10:00" });
      var where = h("input", { id: "vrqWhere", maxlength: "300", placeholder: "e.g. Lawn gate 2, unload by the stage", autocomplete: "off" });
      var det = h("textarea", { id: "vrqDet", maxlength: "1000", rows: "3", placeholder: "Specs, contact on site, anything they must know" });
      var amt = h("input", { id: "vrqAmt", type: "number", inputmode: "decimal", min: "0", step: "1" });
      var send = h("input", { id: "vrqSend", type: "checkbox", checked: true });
      var errEl = h("div", { cls: "err", role: "alert", hidden: true });
      var go = h("button", { type: "button", cls: "btn primary", text: "Send request" });
      var fail = function (m, el) { errEl.textContent = m; errEl.hidden = false; try { if (el) el.focus(); } catch (e) { /* ignore */ } };
      var close = sheet("＋ New vendor request", [
        h("div", { cls: "fgrid" }, [
          ev ? h("div", { cls: "fld full" }, [h("label", { for: "vrqEv", text: "Event *" }), ev]) : null,
          h("div", { cls: "fld full" }, [h("label", { for: "vrqV", text: "Vendor *" }), vs]),
          h("div", { cls: "fld" }, [h("label", { for: "vrqWhat", text: "What *" }), what]),
          h("div", { cls: "fld" }, [h("label", { for: "vrqQty", text: "Quantity" }), qty]),
          h("div", { cls: "fld" }, [h("label", { for: "vrqDate", text: "When - date *" }), dt]),
          h("div", { cls: "fld" }, [h("label", { for: "vrqTime", text: "Time *" }), tm]),
          h("div", { cls: "fld full" }, [h("label", { for: "vrqWhere", text: "Where" }), where]),
          h("div", { cls: "fld full" }, [h("label", { for: "vrqDet", text: "Details" }), det]),
          h("div", { cls: "fld" }, [h("label", { for: "vrqAmt", text: "Agreed amount (₹) *" }), amt]),
          h("label", { cls: "fld vrq-chk" }, [send, " E-mail the request when e-mail is switched on"])]),
        h("p", { cls: "meta", text: "A booking is added to the event at this amount (Estimated). When the vendor accepts it becomes Committed; their approved invoice becomes the Actual cost." }),
        errEl, h("div", { cls: "foot" }, [go])]);
      go.addEventListener("click", function () {
        var q = quoteId || (ev && ev.value);
        if (!q) return fail("Choose the event.", ev);
        if (!vs.value) return fail("Choose the vendor.", vs);
        var w = what.value.trim(); if (!w || /[<>]/.test(w)) return fail("Say what is needed (no < or >).", what);
        var qn = qty.value === "" ? null : Number(qty.value); if (qn !== null && !(qn > 0)) return fail("Quantity must be above 0.", qty);
        if (!dt.value || !tm.value) return fail("Pick the date and time.", dt.value ? tm : dt);
        var iso = global.HelmDelivery && global.HelmDelivery.zonedToIso ? global.HelmDelivery.zonedToIso(dt.value, tm.value, tz()) : new Date(dt.value + "T" + tm.value).toISOString();
        if (!iso) return fail("Pick the date and time.", dt);
        var a = Number(amt.value); if (amt.value === "" || !(a >= 0)) return fail("Enter the agreed amount (0 or more).", amt);
        if (/[<>]/.test(where.value + det.value)) return fail("Where / details may not contain < or >.", where);
        go.disabled = true;
        S().vendorRequests.save({ quote_id: q, vendor_id: vs.value, what: w, qty: qn, when_at: iso, where_text: where.value.trim() || null,
          details: det.value.trim() || null, agreed_amount: Math.round(a * 100) / 100, send: !!send.checked }).then(function (row) {
          close(); toast("Request sent to " + row.vendor_name + ".", "ok");
          load().then(function () { if (row.link && row.link.token) shareFromRow(row); });
        }, function (e) { go.disabled = false; fail(friendly(e, "send the request")); });
      });
      setTimeout(function () { try { (ev || vs).focus(); } catch (e) { /* ignore */ } }, 30);
    }).catch(function (e) { toast(friendly(e, "load vendors"), "err"); });
  }
  // right after sending: the fresh link is shown once so it can go on WhatsApp too
  function shareFromRow(row) {
    var url = S().vendorRequests.linkUrl(row.link.token);
    if (!url) return;
    sheet("Request sent", [
      h("p", { cls: "meta", text: row.contact_email ? "The request e-mail is queued for " + row.contact_email + " (sent when studio e-mail is switched on). You can also share the link yourself:" : row.vendor_name + " has no e-mail on file - share this link with them:" }),
      h("input", { cls: "vrq-link", value: url, readonly: true, "aria-label": "Request link", on: { focus: function (e) { e.target.select(); } } }),
      h("div", { cls: "foot" }, [
        h("a", { cls: "btn", href: "https://wa.me/" + String(row.contact_phone || "").replace(/\D/g, "") + "?text=" + encodeURIComponent("Hello " + row.vendor_name + ", please confirm " + row.what + " for " + (row.event_title || "our event") + " (" + (row.when_text || "") + "): " + url), target: "_blank", rel: "noopener noreferrer", text: "Open in WhatsApp" }),
        h("button", { type: "button", cls: "btn primary", text: "Copy link", on: { click: function () { try { global.navigator.clipboard.writeText(url).then(function () { toast("Link copied.", "ok"); }); } catch (e) { /* ignore */ } } } })])]);
  }
  function openReassign(r) {
    vendorsList().then(function (vend) {
      var vs = vendorSelect("vrqRV", vend, r.vendor_id);
      var amt = h("input", { id: "vrqRA", type: "number", inputmode: "decimal", min: "0", step: "1", value: r.agreed_amount != null ? String(r.agreed_amount) : "" });
      var note = h("input", { id: "vrqRN", maxlength: "500", autocomplete: "off", placeholder: "e.g. Deccan is fully booked" });
      var errEl = h("div", { cls: "err", role: "alert", hidden: true });
      var go = h("button", { type: "button", cls: "btn primary", text: "Reassign" });
      var close = sheet("Reassign " + r.what + " from " + r.vendor_name, [
        h("p", { cls: "meta", text: "The request to " + r.vendor_name + " is closed (kept in the history), the booking moves to the new vendor and a fresh request goes to them." }),
        h("div", { cls: "fgrid" }, [
          h("div", { cls: "fld full" }, [h("label", { for: "vrqRV", text: "New vendor *" }), vs]),
          r.agreed_amount != null ? h("div", { cls: "fld" }, [h("label", { for: "vrqRA", text: "Agreed amount (₹)" }), amt]) : null,
          h("div", { cls: "fld full" }, [h("label", { for: "vrqRN", text: "Note (optional)" }), note])]),
        errEl, h("div", { cls: "foot" }, [go])]);
      go.addEventListener("click", function () {
        if (!vs.value) { errEl.textContent = "Choose the new vendor."; errEl.hidden = false; return; }
        var a = r.agreed_amount != null && amt.value !== "" ? Number(amt.value) : null;
        if (a !== null && !(a >= 0)) { errEl.textContent = "Enter the agreed amount (0 or more)."; errEl.hidden = false; return; }
        go.disabled = true;
        S().vendorRequests.reassign(r.id, vs.value, a, note.value.trim() || null).then(function (row) {
          close(); toast("Reassigned to " + row.vendor_name + ".", "ok");
          load().then(function () { if (row.link && row.link.token) shareFromRow(row); });
        }, function (e) { go.disabled = false; errEl.textContent = friendly(e, "reassign"); errEl.hidden = false; });
      });
    }).catch(function (e) { toast(friendly(e, "load vendors"), "err"); });
  }

  /* ---------------------------------------------------------------- a simple sheet (the page's own modal look) */
  function sheet(title, body) {
    var prev = doc.activeElement;
    var ov = h("div", { cls: "lmodal vrq-modal", role: "dialog", "aria-modal": "true", "aria-label": title });
    var closeBtn = h("button", { type: "button", cls: "close", "aria-label": "Close", text: "×" });
    var sh = h("div", { cls: "sheet" }, [h("h3", {}, [h("span", { text: title }), closeBtn])].concat(body));
    ov.appendChild(sh); doc.body.appendChild(ov);
    var close = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); doc.removeEventListener("keydown", onKey); try { if (prev && prev.focus) prev.focus(); } catch (e) { /* ignore */ } };
    var onKey = function (e) { if (e.key === "Escape") close(); };
    closeBtn.addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    doc.addEventListener("keydown", onKey);
    setTimeout(function () { var f = sh.querySelector("input:not([type=checkbox]),select,textarea,button.btn"); try { (f || closeBtn).focus(); } catch (e) { /* ignore */ } }, 30);
    return close;
  }

  /* ---------------------------------------------------------------- boot */
  function boot() {
    var tabs = doc.getElementById("viewTabs"); if (!tabs) return;
    tabs.addEventListener("click", function (e) { var b = e.target.closest("[data-view]"); if (b) setView(b.getAttribute("data-view")); });
    Array.prototype.forEach.call(doc.querySelectorAll("#vrqFilters [data-f]"), function (b) {
      b.addEventListener("click", function () { state.filter = b.getAttribute("data-f");
        Array.prototype.forEach.call(doc.querySelectorAll("#vrqFilters [data-f]"), function (x) { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
        render(); }); });
    var nb = doc.getElementById("vrqNew"); if (nb) nb.addEventListener("click", function () { openForm(); });
    var st = S(); if (!st || !st.vendorRequests) { tabs.hidden = true; return; }
    st.init().then(function () { return Promise.all([st.auth.canEditArea("vendors").catch(function () { return false; }), st.auth.canEditArea("finance").catch(function () { return false; })]); })
      .then(function (r) { state.canAssign = !!r[0]; state.canReview = !!r[1]; if (nb) nb.hidden = !state.canAssign;
        if (qs.get("tab") === "requests") setView("requests"); })
      .catch(function () { /* the page's own boot shows sign-in / access problems */ });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot); else boot();
  global.HelmVendorRequests = { reload: load, open: function () { setView("requests"); } };
})(typeof window !== "undefined" ? window : this);
