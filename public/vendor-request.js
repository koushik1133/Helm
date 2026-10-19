/* vendor-request.js - /vendor-request?t=<64 hex> (0256). A vendor answers a studio's request without signing in
   (Accept / Decline with a comment) and, once accepted, sends their tax invoice from the same link (number, date,
   taxable value, CGST + SGST or IGST, GSTIN, one PDF / photo). Talks only to the public RPCs vendor_link_get /
   vendor_link_respond / vendor_invoice_upload / vendor_invoice_submit and to the private 'vendor-invoices' bucket
   with the one-time key the upload RPC grants (the token is the only key; the database keeps only its hash).
   Text only (textContent), no inline script. */
(function () {
  "use strict";
  var TOKEN_RE = /^[0-9a-f]{64}$/;
  var KEY_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png|webp)$/;
  var MAX_BYTES = 10 * 1024 * 1024;
  var LABEL = { sent: "Waiting for your answer", accepted: "Accepted", rejected: "Declined", cancelled: "Cancelled by the studio",
    reassigned: "Given to another vendor" };
  var INV = { submitted: "Sent - waiting for approval", queried: "Question from the studio", approved: "Approved", rejected: "Rejected",
    superseded: "Replaced by a corrected invoice" };
  var PAY = { due: "not paid yet", partial: "part paid", paid: "paid" };
  var $ = function (id) { return document.getElementById(id); };
  var token = String(new URLSearchParams(location.search).get("t") || "").trim().toLowerCase();
  var cfg = window.SUPABASE_CONFIG || {};
  var base = String(cfg.url || "").replace(/\/+$/, "");
  var cur = null, answer = null, replaces = null;

  function inr(n) {
    var v = Number(n); if (!isFinite(v)) return "";
    return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function rpc(fn, body) {
    if (!base || !cfg.anonKey) return Promise.resolve({ ok: false, error: "config" });
    return fetch(base + "/rest/v1/rpc/" + fn, { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true, data: j } : { ok: false, error: String((j && j.message) || "") }; }, function () { return { ok: false, error: "" }; }); })
      .catch(function () { return { ok: false, error: "network" }; });
  }
  function fact(dl, k, v) { if (!v) return; var dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.appendChild(dt); dl.appendChild(dd); }
  function bad(title, msg) {
    $("vr-title").textContent = title; $("vr-msg").textContent = msg;
    ["vr-facts", "vr-now", "vr-answer", "vr-invoice", "vr-invoices"].forEach(function (id) { $(id).hidden = true; });
  }
  function err(id, msg) { var el = $(id); el.textContent = msg || ""; el.hidden = !msg; }
  // the server's message when it is one of ours (plain words), else a generic one
  function say(e, fallback) {
    var m = String(e || "");
    if (/^(enter|attach|the |please|an |invoice|charge|CGST|GST|only|upload|too many|say|comment|notes|this )/i.test(m) && m.length < 200) return m.charAt(0).toUpperCase() + m.slice(1);
    return fallback;
  }

  function render(d) {
    if (!d || d.ok !== true) {
      if (d && d.reason === "rate") return bad("Please wait a moment", "Too many tries from this link. Try again in a few minutes.");
      if (d && d.reason === "closed" && d.status) { /* fall through with the fresh state */ }
      else return bad("Link not valid", "This link is not valid or has expired. Ask the studio for a new link.");
    }
    cur = d;
    var item = String(d.what || "") + (Number(d.qty) > 0 ? " × " + Number(d.qty).toLocaleString("en-IN") : "");
    $("vr-title").textContent = item || "Vendor request";
    $("vr-msg").textContent = "Request from " + (d.studio || "your event planner") + (d.vendor_name ? " for " + d.vendor_name : "");
    var dl = $("vr-facts"); while (dl.firstChild) dl.removeChild(dl.firstChild);
    fact(dl, "Event", (d.event || "") + (d.event_date ? " on " + d.event_date : ""));
    fact(dl, "Venue", d.venue || "");
    fact(dl, "When", d.when_text || "");
    fact(dl, "Where", d.where_text || "");
    fact(dl, "Details", d.details || "");
    fact(dl, "Agreed amount", d.agreed_amount != null ? inr(d.agreed_amount) : "");
    if (d.status === "sent") fact(dl, "Please reply by", d.respond_by_text || "");
    if (d.response_note) fact(dl, "Your comment", d.response_note);
    dl.hidden = false;
    $("vr-now").textContent = "Status: " + (LABEL[d.status] || d.status);
    $("vr-now").hidden = false;
    $("vr-answer").hidden = d.can_respond !== true;
    $("vr-answer-form").hidden = true;
    $("vr-answer").querySelector(".vr-actions").hidden = false;
    renderInvoices(d.invoices || []);
    $("vr-invoice").hidden = d.can_invoice !== true;
    if (d.can_invoice !== true) $("vr-inv-form").hidden = true;
  }
  function renderInvoices(list) {
    var ul = $("vr-inv-list"); while (ul.firstChild) ul.removeChild(ul.firstChild);
    var shown = list.filter(function (i) { return i.status !== "superseded"; });
    $("vr-invoices").hidden = !shown.length;
    shown.forEach(function (i) {
      var li = document.createElement("li"); li.className = "vr-inv vr-inv-" + i.status;
      var top = document.createElement("div"); top.className = "vr-inv-top";
      var no = document.createElement("b"); no.textContent = "Invoice " + i.invoice_no; top.appendChild(no);
      var amt = document.createElement("span"); amt.textContent = inr(i.total_amount) + " · " + (i.invoice_date || ""); top.appendChild(amt);
      li.appendChild(top);
      var st = document.createElement("div"); st.className = "vr-inv-st";
      st.textContent = (INV[i.status] || i.status) + (i.status === "approved" && i.pay_status ? " · " + PAY[i.pay_status] + (i.pay_status === "partial" ? " (" + inr(i.paid) + " paid)" : "") : "");
      li.appendChild(st);
      if (i.review_note && (i.status === "queried" || i.status === "rejected")) {
        var n = document.createElement("div"); n.className = "vr-inv-note"; n.textContent = "Studio: " + i.review_note; li.appendChild(n);
      }
      if (i.status === "queried" && cur && cur.can_invoice) {
        var b = document.createElement("button"); b.type = "button"; b.className = "vr-btn vr-ghost vr-sm"; b.textContent = "Send a corrected invoice";
        b.addEventListener("click", function () { openInvoice(i); }); li.appendChild(b);
      }
      ul.appendChild(li);
    });
  }

  // ---- accept / decline ----
  function openAnswer(a) {
    answer = a; err("vr-answer-err", "");
    $("vr-comment-l").textContent = a === "reject" ? "Why can't you take this? (required)" : "Comment (optional, e.g. delivery time)";
    $("vr-comment").value = "";
    $("vr-answer-send").textContent = a === "reject" ? "Decline the request" : "Accept the request";
    $("vr-answer").querySelector(".vr-actions").hidden = true; $("vr-answer-form").hidden = false;
    setTimeout(function () { $("vr-comment").focus(); }, 0);
  }
  function sendAnswer(ev) {
    if (ev) ev.preventDefault();
    var c = $("vr-comment").value.trim();
    if (answer === "reject" && c.length < 3) { err("vr-answer-err", "Please say why you can't take this."); $("vr-comment").focus(); return; }
    if (/[<>]/.test(c)) { err("vr-answer-err", "Please don't use < or >."); return; }
    $("vr-answer-send").disabled = true;
    rpc("vendor_link_respond", { p_token: token, p_action: answer, p_comment: c || null }).then(function (r) {
      $("vr-answer-send").disabled = false;
      if (!r.ok) { err("vr-answer-err", say(r.error, "Could not send that just now. Please try again.")); return; }
      render(r.data);
      if (r.data && r.data.ok) $("vr-now").textContent = "Thank you - " + (answer === "accept" ? "you accepted this request." : "you declined this request.") + " " + (r.data.studio || "The studio") + " has been told.";
    });
  }

  // ---- invoice ----
  function num(id) { var v = $(id).value.trim(); if (v === "") return 0; var n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : NaN; }
  function gstMode() { return $("vi-gst").value; }
  function autoGst() {
    var t = num("vi-taxable"), rate = Number($("vi-rate").value) || 0;
    if (!(t > 0)) return;
    if (gstMode() === "intra") { var half = Math.round(t * rate / 2) / 100; $("vi-cgst").value = half.toFixed(2); $("vi-sgst").value = half.toFixed(2); }
    if (gstMode() === "inter") $("vi-igst").value = (Math.round(t * rate) / 100).toFixed(2);
    total();
  }
  function showGst() {
    var m = gstMode();
    $("vi-rate-w").hidden = m === "none"; $("vi-cgst-w").hidden = m !== "intra"; $("vi-sgst-w").hidden = m !== "intra";
    $("vi-igst-w").hidden = m !== "inter"; $("vi-gstin-w").hidden = m === "none";
    autoGst(); total();
  }
  function parts() {
    var m = gstMode();
    return { taxable: num("vi-taxable"), cgst: m === "intra" ? num("vi-cgst") : 0, sgst: m === "intra" ? num("vi-sgst") : 0, igst: m === "inter" ? num("vi-igst") : 0 };
  }
  function total() {
    var p = parts(), t = p.taxable + p.cgst + p.sgst + p.igst;
    $("vi-total").textContent = isFinite(t) && p.taxable > 0 ? "Invoice total: " + inr(t) + (cur && Number(cur.agreed_amount) > 0 && t > Number(cur.agreed_amount) + 0.005 ? " (above the agreed " + inr(cur.agreed_amount) + " - the studio will check it)" : "") : "";
  }
  function openInvoice(prev) {
    replaces = prev && prev.status === "queried" ? prev.id : null;
    $("vr-inv-title").textContent = replaces ? "Send a corrected invoice" : "Send your invoice";
    $("vi-no").value = prev ? prev.invoice_no : "";
    var today = new Date(), iso = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    $("vi-date").value = prev && prev.invoice_date_iso ? String(prev.invoice_date_iso).slice(0, 10) : iso;
    $("vi-taxable").value = prev ? prev.taxable_amount : "";
    $("vi-gst").value = prev ? (Number(prev.igst) > 0 ? "inter" : Number(prev.cgst) > 0 ? "intra" : "none") : "none";
    $("vi-cgst").value = prev ? prev.cgst : ""; $("vi-sgst").value = prev ? prev.sgst : ""; $("vi-igst").value = prev ? prev.igst : "";
    $("vi-gstin").value = prev && prev.vendor_gstin ? prev.vendor_gstin : ""; $("vi-notes").value = ""; $("vi-file").value = "";
    err("vi-err", ""); $("vr-inv-open").hidden = true; $("vr-inv-form").hidden = false;
    showGst(); if (prev) { $("vi-cgst").value = prev.cgst || ""; $("vi-sgst").value = prev.sgst || ""; $("vi-igst").value = prev.igst || ""; total(); }
    setTimeout(function () { $("vi-no").focus(); }, 0);
  }
  function closeInvoice() { $("vr-inv-form").hidden = true; $("vr-inv-open").hidden = false; replaces = null; }
  // the file's real type from its first bytes (never from its name)
  function sniff(file) {
    return file.slice(0, 16).arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf), s = function (i, arr) { return arr.every(function (x, k) { return b[i + k] === x; }); };
      if (s(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
      if (s(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
      if (s(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
      if (s(0, [0x52, 0x49, 0x46, 0x46]) && s(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
      return null;
    });
  }
  function validate() {
    var no = $("vi-no").value.replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z0-9\/-]{1,16}$/.test(no)) return { err: "Invoice number: up to 16 letters, digits, - or /.", el: "vi-no" };
    var d = $("vi-date").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { err: "Enter the invoice date.", el: "vi-date" };
    var p = parts();
    if (!(p.taxable > 0)) return { err: "Enter the taxable value (above 0).", el: "vi-taxable" };
    if ([p.cgst, p.sgst, p.igst].some(function (x) { return !isFinite(x) || x < 0; })) return { err: "GST amounts must be 0 or more.", el: "vi-cgst" };
    if (gstMode() === "intra" && Math.abs(p.cgst - p.sgst) > 1) return { err: "CGST and SGST must be the same amount.", el: "vi-sgst" };
    var gstin = $("vi-gstin").value.replace(/\s+/g, "").toUpperCase();
    if (gstMode() !== "none" && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin)) return { err: "Enter your 15-character GSTIN (e.g. 36ABCDE1234F1Z5).", el: "vi-gstin" };
    var notes = $("vi-notes").value.trim();
    if (/[<>]/.test(notes)) return { err: "Notes may not contain < or >.", el: "vi-notes" };
    var f = $("vi-file").files && $("vi-file").files[0];
    if (!f) return { err: "Attach the invoice (PDF or photo).", el: "vi-file" };
    if (f.size > MAX_BYTES) return { err: "The file is larger than 10 MB.", el: "vi-file" };
    return { no: no, date: d, p: p, gstin: gstMode() === "none" ? null : gstin, notes: notes || null, file: f };
  }
  function sendInvoice(ev) {
    if (ev) ev.preventDefault();
    var v = validate();
    if (v.err) { err("vi-err", v.err); try { $(v.el).focus(); } catch (e) { /* ignore */ } return; }
    err("vi-err", ""); $("vi-send").disabled = true; $("vi-send").textContent = "Sending…";
    var done = function (m) { $("vi-send").disabled = false; $("vi-send").textContent = "Send invoice"; if (m) err("vi-err", m); };
    sniff(v.file).then(function (mime) {
      if (!mime) return done("The file must be a PDF, JPEG, PNG or WebP.");
      return rpc("vendor_invoice_upload", { p_token: token, p_mime: mime }).then(function (g) {
        if (!g.ok || !g.data || !KEY_RE.test(String(g.data.path || ""))) return done(say(g.error, "Could not prepare the upload. Please try again."));
        return fetch(base + "/storage/v1/object/vendor-invoices/" + g.data.path, { method: "POST", credentials: "omit",
          headers: { apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey, "Content-Type": mime, "x-upsert": "false" }, body: v.file })
          .then(function (up) {
            if (!up.ok) return done("The file could not be uploaded. Please try again.");
            var body = { invoice_no: v.no, invoice_date: v.date, taxable_amount: v.p.taxable, cgst: v.p.cgst, sgst: v.p.sgst, igst: v.p.igst,
              vendor_gstin: v.gstin, notes: v.notes, file_path: g.data.path };
            if (replaces) body.replaces_id = replaces;
            return rpc("vendor_invoice_submit", { p_token: token, p: body }).then(function (r) {
              if (!r.ok) return done(say(r.error, "Could not send the invoice just now. Please try again."));
              if (!r.data || r.data.ok !== true) { done(); return render(r.data); }
              done(); closeInvoice(); render(r.data);
              $("vr-now").textContent = "Thank you - invoice " + (r.data.submitted || v.no) + " was sent to " + (r.data.studio || "the studio") + " for approval.";
            });
          }, function () { done("The file could not be uploaded. Please check your connection."); });
      });
    });
  }

  function start() {
    $("vr-accept").addEventListener("click", function () { openAnswer("accept"); });
    $("vr-reject").addEventListener("click", function () { openAnswer("reject"); });
    $("vr-answer-form").addEventListener("submit", sendAnswer);
    $("vr-answer-back").addEventListener("click", function () { $("vr-answer-form").hidden = true; $("vr-answer").querySelector(".vr-actions").hidden = false; });
    $("vr-inv-open").addEventListener("click", function () { openInvoice(null); });
    $("vi-cancel").addEventListener("click", closeInvoice);
    $("vr-inv-form").addEventListener("submit", sendInvoice);
    $("vi-gst").addEventListener("change", showGst);
    $("vi-rate").addEventListener("change", autoGst);
    $("vi-taxable").addEventListener("input", autoGst);
    ["vi-cgst", "vi-sgst", "vi-igst"].forEach(function (id) { $(id).addEventListener("input", total); });
    if (!TOKEN_RE.test(token)) return render(null);
    rpc("vendor_link_get", { p_token: token }).then(function (r) {
      if (!r.ok) return bad("Something went wrong", "We could not load this link just now. Please try again in a minute.");
      render(r.data);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
