/* trial-preview.js - R125 (owner, database 0334): in a free trial no link and no message leaves Helm.
   Loaded by trial-lock.js for a free-trial studio only: a paid studio never downloads this file.
   Two jobs:
   1  The screens: every send button becomes "... (Preview)" and opens a pop-up; every way to copy, open or send a link
      to an outsider disappears (static ones also in trial-lock.css, so they never flash). Team invitations stay.
   2  The pop-up: Next / Back through what the client, guest, crew member or vendor would really get, with the studio's
      own data. The real pages run in a frame (trial-preview-frame.js) on data this signed-in session fetched
      (trial_preview_bundle). No token exists, so there is no address to copy. Only the test approval and Simulate
      payment write anything, through the members-only functions, always marked TEST.
   The server refuses everything anyway (0334): this file only keeps the screens honest.
   CSP-safe: createElement / textContent only, no inline handlers, no HTML strings. */
(function (global) {
  "use strict";
  if (global.HelmTrialPreview) return;
  var doc = global.document;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* ---- words (pure, unit-tested) ---- */
  var VALID = {
    approval: "valid until 30 days after the event",
    booklet: "valid for the time you choose, 7 to 180 days (30 by default)",
    invitation: "valid until 7 days after the event",
    proposal: "valid until 7 days after the event",
    crew: "valid until 7 days after the event, or 60 days if there is no event date",
    vendor: "valid until 90 days after the work date, and at most 180 days from when it is made",
    enquiry: "with no end date while you keep the form switched on"
  };
  var WHO = { approval: "your client", booklet: "your client", invitation: "your guests", proposal: "your client",
    crew: "your crew member", vendor: "your vendor", enquiry: "your enquirers" };
  var TITLE = { approval: "Send for approval (Preview)", booklet: "Share booklet (Preview)", invitation: "Publish invitation (Preview)",
    proposal: "Share proposal (Preview)", crew: "Send crew tasks (Preview)", vendor: "Send vendor request (Preview)", enquiry: "Enquiry form (Preview)" };
  function disclaimer(kind) {
    var head = kind === "invitation" ? "Nothing was published or sent, and no link was made." : "Nothing was sent and no link was made.";
    return { lead: "Preview only.", text: " " + head + " This opens only inside your signed-in studio. On a paid plan a private link, "
      + (VALID[kind] || VALID.approval) + ", is created and sent to " + (WHO[kind] || WHO.approval) + " by WhatsApp or e-mail." };
  }
  var PREVIEW_NOTE = "Preview only in a free trial: nothing is sent and no link is made.";
  var NOTE_DEAD = "This is a preview: this button does nothing here.";

  function clean(s, n) { return String(s == null ? "" : s).replace(/^\s*Demo\s*·\s*/, "").replace(/\s+/g, " ").trim().slice(0, n || 120); }
  function initial(s) { return (clean(s).charAt(0) || "H").toUpperCase(); }
  // the real wording (client-mailer logic.mjs / manual messages), with a plain button and no address
  function messages(kind, h, studio) {
    h = h || {}; var c = clean(h.client_name) || "there", st = clean(studio) || "your event planner", ev = clean(h.title) || "your event";
    if (kind === "booklet") return { subject: "Your event booklet from " + st, heading: "Your event booklet",
      body: ["Hi " + c + ",", "Your event booklet from " + st + " is ready: the event details, floor plan, menu, quotation and payments in one private page."],
      button: "Open your booklet", wa: "Hi " + c + ", here is your event booklet from " + st + "." };
    if (kind === "proposal") return { subject: "Your event proposal from " + st, heading: "Your event proposal", body: ["Hi " + c + ",", "Here is your event proposal from " + st + "."],
      button: "Open proposal", wa: "Hi " + c + ", here is your event proposal from " + st + "." };
    if (kind === "invitation") return { wa: "You're invited to " + ev + ". Please open the invitation and let us know if you can come.", button: "Open invitation" };
    return { subject: "Your event proposal from " + st, heading: "Your event proposal",
      body: ["Hi " + c + ",", "Here is your event proposal and quote from " + st + ". Open the link to review it and approve when you are ready (you will get a one-time code to confirm)."],
      button: "Review & approve", wa: "Hi " + c + ", here's your event proposal and quote from " + st + "." };
  }
  // Pure: is this link something the screens must not show to a trial studio? Helm's own addresses and teammates stay.
  function outsiderHref(href, page) {
    var h = String(href || "").trim().toLowerCase();
    if (/^https?:\/\/(api\.)?(wa\.me|whatsapp\.com)|^https?:\/\/api\.whatsapp\.com|^whatsapp:|^sms:/.test(h)) return true;
    if (h.indexOf("mailto:") === 0) {
      if (/^mailto:[^?]*@helm\.events/.test(h)) return false;
      return page !== "chat";            // the team chat's profile card: a teammate, not an outsider
    }
    return false;
  }

  /* ---- the rules for the studio screens ---- */
  function pageName() { var p = String((global.location && global.location.pathname) || "").replace(/\.html$/, "").replace(/\/+$/, "").split("/"); return p[p.length - 1] || "index"; }
  var PAGE = pageName();
  // Team invitations are not here on purpose (owner rule 1): Settings + Staff keep e-mail and Copy link.
  var HIDE = ["#linkModal", "#lk_copy", "#lk_sms", "#lk_open", "#lk_url", "#apprLinks", "[data-email-send]", "[data-wa-proposal]", ".pkr-link",
    "#sec-share", "#shareModal", "#shareHost", "#unpubBtn", "#newLinkBtn", "#linkWrap", "#pubLink", "#copyBtn", "#openBtn", "#copyLink", "#openView", "#shareLink",
    "#oldLinks", "#workerLinks", ".linkline", ".linkline + .muted", ".au-link", "#sm_wa", "#sm_copy", "#sm_link", "#lib_wa", "[data-key=\"refer\"]", "a[href*=\"/refer\"]"];
  function setHidden(n) {
    if (n.classList.contains("tp-gone")) return;
    n.classList.add("tp-gone"); n.setAttribute("aria-hidden", "true");
    if (n.tagName === "A") { n.removeAttribute("href"); n.setAttribute("tabindex", "-1"); }
    if (n.tagName === "INPUT") { n.value = ""; }
  }
  var SWAPS = [
    { sel: "#sendApproval", kind: "approval" },
    { sel: "#shareClient", kind: "approval" },
    { sel: "#reapprBtn", kind: "approval" },
    { sel: "[data-act=\"link\"]", kind: "approval", plain: true },
    { sel: "[data-act=\"relink\"]", kind: "approval", plain: true },
    { sel: "[data-booklet-share]", kind: "booklet" }
  ];
  if (PAGE === "invite-studio") SWAPS.push({ sel: "#pubBtn", kind: "invitation", show: true });
  if (PAGE === "proposal") SWAPS.push({ sel: "#pubBtn", kind: "proposal", show: true });
  function outOfText(n) { return n.textContent !== undefined; }
  function swap(n, r) {
    if (!n.getAttribute("data-tp-kind")) n.setAttribute("data-tp-kind", r.kind);
    var t = TITLE[r.kind];
    if (n.textContent !== t && outOfText(n)) n.textContent = t;
    if (n.getAttribute("title")) n.removeAttribute("title");
    n.setAttribute("aria-label", t);
    if (r.show && n.hidden) n.hidden = false;
    n.disabled = false;
  }
  function button(kind, cls, extra) {
    var b = doc.createElement("button"); b.type = "button"; b.className = cls || "btn tp-open"; b.textContent = TITLE[kind];
    b.setAttribute("data-tp-kind", kind);
    Object.keys(extra || {}).forEach(function (k) { b.setAttribute(k, extra[k]); });
    return b;
  }
  function inject() {
    var s = doc.getElementById("sendApproval");
    if (s && !doc.getElementById("tpEntry")) {
      var box = doc.createElement("div"); box.id = "tpEntry"; box.className = "tp-entry";
      ["booklet", "invitation", "proposal", "crew", "vendor", "enquiry"].forEach(function (k) { box.appendChild(button(k)); });
      s.parentNode.insertBefore(box, s.nextSibling);
      var note = doc.createElement("p"); note.className = "tp-note-line";
      note.textContent = "In a free trial nothing is sent and no link is made. Each button shows exactly what the other person would get.";
      box.parentNode.insertBefore(note, box.nextSibling);
    }
    // the event page: the one share button stays the booklet; the approval gets its own button until the client approved
    var bk = doc.querySelector("#bkShare[data-approval]");
    if (bk && !bk.hidden && !doc.getElementById("tpApprove")) { var ab = button("approval", "bk-share tp-open", { id: "tpApprove" }); bk.parentNode.insertBefore(ab, bk); }
    // the quotes list: one preview button on each quote
    Array.prototype.forEach.call(doc.querySelectorAll("#rows tr[data-id]"), function (tr) {
      if (tr.querySelector("[data-tp-kind]")) return;
      var cell = tr.lastElementChild; if (!cell) return;
      var b = button("approval", "ic tp-open"); cell.insertBefore(b, cell.firstChild);
    });
    // the crew page: one preview button per person, in place of the worker link
    Array.prototype.forEach.call(doc.querySelectorAll(".grp .gh .ph"), function (ph) {
      var g = ph.closest(".grp"); if (!g || g.querySelector("[data-tp-kind=\"crew\"]")) return;
      g.appendChild(button("crew", "btn sm tp-open", { "data-phone": ph.textContent.trim() }));
    });
    var host = doc.getElementById("au_eq_save");
    if (host && !doc.getElementById("tpEnq")) { var eb = button("enquiry", "btn tp-open", { id: "tpEnq" }); host.parentNode.insertBefore(eb, host); }
    // pages with no send button of their own: one preview button at the top
    var pk = { ops: "crew", vendors: "vendor", resources: "vendor" }[PAGE], top = pk && doc.querySelector("main");
    if (top && !doc.getElementById("tpPage")) {
      var pw = doc.createElement("div"); pw.id = "tpPage"; pw.className = "tp-entry"; pw.appendChild(button(pk));
      top.insertBefore(pw, top.firstChild);
    }
  }
  function sweep() {
    HIDE.forEach(function (sel) { Array.prototype.forEach.call(doc.querySelectorAll(sel), function (n) {
      if (n.closest && n.closest(".tp-dlg")) return;
      setHidden(n); }); });
    SWAPS.forEach(function (r) { Array.prototype.forEach.call(doc.querySelectorAll(r.sel), function (n) { swap(n, r); }); });
    // buttons built on the fly, found by what they do
    Array.prototype.forEach.call(doc.querySelectorAll("button"), function (b) {
      if (b.closest && b.closest(".tp-dlg")) return;
      var t = (b.textContent || "").trim(), a = b.getAttribute("aria-label") || "";
      if (t === "Share link" && b.closest("[data-vrq],.vrq-row,tr,li")) { swapVendor(b); return; }
      if (t === "🔗 Link" || /^Copy status link/.test(a)) b.remove();
      if (t === "Copy link" && b.closest(".vrq-sheet,.linkline,.au-link,.pkr-link")) b.remove();
    });
    Array.prototype.forEach.call(doc.querySelectorAll("a[href]"), function (a) {
      if (a.closest && a.closest(".tp-dlg")) return;
      if (!outsiderHref(a.getAttribute("href"), PAGE)) return;
      if (/^mailto:/i.test(a.getAttribute("href") || "") && a.textContent.indexOf("@") >= 0) { a.removeAttribute("href"); return; }   // the address stays as plain text
      a.remove();
    });
    var rn = doc.getElementById("shareClientNote"); if (rn && rn.textContent !== PREVIEW_NOTE) rn.textContent = PREVIEW_NOTE;
    inject();
  }
  function swapVendor(b) {
    var n = b.cloneNode(false); n.textContent = TITLE.vendor; n.setAttribute("data-tp-kind", "vendor");
    b.parentNode.replaceChild(n, b);
  }
  function quoteOf(el) {
    var q = el && el.getAttribute && el.getAttribute("data-quote");
    if (q && UUID_RE.test(q)) return q;
    var tr = el && el.closest && el.closest("tr[data-id],[data-quote-id]");
    if (tr) { var v = tr.getAttribute("data-id") || tr.getAttribute("data-quote-id"); if (UUID_RE.test(v || "")) return v; }
    var sp = new URLSearchParams(global.location.search), c = [sp.get("quote"), sp.get("id"), sp.get("q")];
    try { if (global.HelmUrl && global.HelmUrl.value) c.push(global.HelmUrl.value("id"), global.HelmUrl.value("quote")); } catch (e) {}
    for (var i = 0; i < c.length; i++) if (c[i] && UUID_RE.test(c[i])) return c[i];
    return null;
  }
  function onClick(e) {
    var t = e.target && e.target.closest && e.target.closest("[data-tp-kind]");
    if (!t || (t.closest && t.closest(".tp-dlg"))) return;
    e.preventDefault(); e.stopImmediatePropagation();
    api.open(t.getAttribute("data-tp-kind"), { quoteId: quoteOf(t), phone: t.getAttribute("data-phone") || null, opener: t });
  }

  /* ---- the pop-up ---- */
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function toast(msg) { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(msg, { type: "info", timeout: 3000 }); } catch (e) {} }
  var S = null;      // the open pop-up
  function store() { return global.BPStore && global.BPStore.trialPreview; }
  function val(v) {
    if (v && typeof v === "object" && v.__error) return { status: 400, json: { message: String(v.__error), code: String(v.__state || "P0001") } };
    return { status: 200, json: v === undefined ? null : v };
  }
  // the server calls of a real page inside the frame
  function frameRpc(name, a) {
    if (!S) return { status: 200, json: null };
    var o = S.step && S.step.over;
    if (o && Object.prototype.hasOwnProperty.call(o, name)) return val(typeof o[name] === "function" ? o[name](a) : o[name]);
    if (ACT[name]) return ACT[name](a);
    var b = S.bundle || {};
    if (Object.prototype.hasOwnProperty.call(b, name)) return val(b[name]);
    return { status: 200, json: null };
  }
  function approveAct(a) {
    var st = store(), code = String(a.p_code == null ? "000000" : a.p_code).replace(/\s/g, "");
    return st.testApprove(S.quoteId, code, a.p_client_name || null, a.p_terms_version || null, a.p_consent_text || null).then(function (r) {
      if (r && r.approved === true) { S.changed = true; S.approved = true; return reload().then(function () { return { status: 200, json: r }; }); }
      return { status: 200, json: r || { approved: false, message: "Could not record the test approval." } };
    }).catch(function (e) { return { status: 200, json: { approved: false, message: String((e && e.message) || "Could not record the test approval.") } }; });
  }
  var ACT = {
    public_trial_simulation: function () { return val({ simulation: false }); },
    public_trial_simulation_for_proposal: function () { return val({ simulation: false }); },
    public_trial_approval_mode: function () { return val({ test_mode: false, can_approve: false, ended: false }); },
    public_link_viewed: function () { return val(null); }, public_link_opened: function () { return val(null); },
    public_link_studio: function () { return val(null); }, public_booklet_studio: function () { return val(null); },
    wa_request_otp: function () { return val({ sent: true, simulated: true, dev_code: "000000", masked: "the address on your quote" }); },
    request_otp: function () { return val({ sent: true, simulated: true, dev_code: "000000", masked: "the number on your quote" }); },
    approval_check_shown: function () { return val({ ok: true }); },
    verify_and_consent: approveAct, wa_verify_and_consent: approveAct, trial_test_approve_code: approveAct,
    trial_simulate_payment: function () { return store().simulatePayment(S.quoteId, null).then(function (r) { S.changed = true; return { status: 200, json: r }; }); },
    public_booklet_otp_request: function () { return val({ sent: true, simulated: true, dev_code: "000000" }); },
    public_booklet_choose: function () { return val({ ok: true, preview: true, status: "submitted", message: "Preview only: nothing was saved." }); },
    public_invite_reveal: function () { return val({ ok: false }); },
    public_invite_rsvp: function () { return val({ ok: true, token: "", updated: false, reveal: (S.reveal || null) }); },
    public_request_new_quote: function () { return val({ status: "sent" }); },
    public_enquiry_submit: function () { return val({ ok: true }); },
    vendor_link_respond: function () { var v = (S.bundle && S.bundle.vendor_link_get) || {}; var n = Object.assign({}, v, { status: "accepted", ok: true }); S.bundle.vendor_link_get = n; return val(n); },
    worker_respond: function () { return val({ ok: true, preview: true }); },
    worker_respond_evidence: function () { return val({ ok: true, preview: true }); }
  };
  global.HelmTrialPreviewBridge = { rpc: frameRpc, note: function () { toast(NOTE_DEAD); }, close: function () { close(); } };

  function reload() {
    var st = store();
    return Promise.resolve(st.bundle(S.kind, S.quoteId, S.opts)).then(function (b) { if (S) S.bundle = b || {}; return b; });
  }
  function setBody(node, white) { S.body.textContent = ""; S.body.className = "tp-body" + (white ? " white" : ""); S.body.appendChild(node); S.body.scrollTop = 0; }

  function viewWait(text) { return el("div", "tp-wait", text || "Loading the preview..."); }
  function viewMail(m) {
    var w = el("div", "tp-mail"), side = el("div", "tp-mail-side"), main = el("div", "tp-mail-main");
    side.setAttribute("aria-hidden", "true");
    side.appendChild(el("b", null, "Mail")); ["Inbox", "Starred", "Sent", "Drafts"].forEach(function (x, i) { side.appendChild(el("span", i ? "" : "on", x)); });
    main.appendChild(el("h3", "tp-mail-subj", m.subject));
    var from = el("div", "tp-mail-from"), who = el("div");
    from.appendChild(el("div", "tp-av", initial(S.studio)));
    who.appendChild(el("b", null, clean(S.studio) + " via Helm")); who.appendChild(el("small", null, "to " + (clean(S.hint.client_name) || "your client")));
    from.appendChild(who); from.appendChild(el("span", "tp-mail-time", timeNow())); main.appendChild(from);
    var cv = el("div", "tp-mail-canvas"), br = el("div", "tp-mail-brand"), card = el("div", "tp-mail-card");
    br.appendChild(el("span", "tp-mark")); br.appendChild(el("span", null, "Helm Events")); cv.appendChild(br);
    card.appendChild(el("h3", null, m.heading)); m.body.forEach(function (p) { card.appendChild(el("p", null, p)); });
    card.appendChild(el("span", "tp-fake", m.button));
    card.appendChild(el("p", null, "If you have questions, just reply to this e-mail."));
    card.appendChild(el("p", null, "")).appendChild(el("b", null, clean(S.studio)));
    cv.appendChild(card);
    cv.appendChild(el("p", "tp-mail-foot", "Helm Events. You received this because your event planner sent you a link about your event."));
    main.appendChild(cv); w.appendChild(side); w.appendChild(main); return w;
  }
  function timeNow() { try { return new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function viewPhone(from, text, btn, soon) {
    var w = el("div", "tp-phone-wrap"), p = el("div", "tp-phone"), top = el("div", "tp-ph-top"), nm = el("div");
    top.appendChild(el("div", "tp-av", initial(from))); nm.appendChild(el("b", null, from)); nm.appendChild(el("small", null, "Business account")); top.appendChild(nm);
    p.appendChild(top);
    if (soon) p.appendChild(el("span", "tp-soon", "WhatsApp: coming soon"));
    p.appendChild(el("span", "tp-ph-day", "TODAY"));
    var msg = el("div", "tp-ph-msg", text); msg.appendChild(el("small", null, timeNow())); p.appendChild(msg);
    p.appendChild(el("div", "tp-ph-btn", btn)); p.appendChild(el("div", "tp-ph-sp")); p.appendChild(el("div", "tp-ph-in", "Type a message"));
    w.appendChild(p); return w;
  }
  function viewFrame(page, title, after, hint, action) {
    var col = el("div", "tp-col");
    if (hint) col.appendChild(el("p", "tp-hint", hint));
    if (action) col.appendChild(action);
    var f = el("iframe", "tp-frame"); f.setAttribute("title", title); f.src = "/trial-preview-" + page;
    f.addEventListener("load", function () {
      var tries = 0;
      (function tick() {
        if (!S || !f.contentDocument) return;
        var ready = !after || after(f.contentDocument, f.contentWindow);
        if (!ready && ++tries < 40) setTimeout(tick, 150);
      })();
    });
    col.appendChild(f); return col;
  }
  function viewPhoneFrame(page, title, after, hint) {
    var col = viewFrame(page, title, after, hint), f = col.querySelector("iframe"), shell = el("div", "tp-phone tp-phone-fr"), w = el("div", "tp-phone-wrap tp-grow");
    col.removeChild(f); shell.appendChild(f); w.appendChild(shell); col.appendChild(w); return col;
  }
  function viewSimPay() {
    var bar = el("div", "tp-act"), b = el("button", "tp-btn pri", "Simulate payment (TEST)"), res = el("span", "tp-act-res"); b.type = "button";
    res.setAttribute("role", "status"); res.setAttribute("aria-live", "polite");
    b.addEventListener("click", function () {
      b.disabled = true; res.textContent = ""; res.className = "tp-act-res";
      store().simulatePayment(S.quoteId, clean(S.hint.client_name)).then(function (r) {
        if (r && r.simulated === true) { S.changed = true; res.textContent = r.already ? String(r.message || "Already simulated.") : "Recorded as a TEST, receipt " + r.receipt + ". No real money moved and it never counts as income."; return reload(); }
        res.className = "tp-act-res err"; res.textContent = String((r && r.message) || "Could not simulate the payment.");
      }).catch(function (e) { res.className = "tp-act-res err"; res.textContent = String((e && e.message) || "Could not simulate the payment."); })
        .then(function () { b.disabled = false; });
    });
    bar.appendChild(b); bar.appendChild(res); return bar;
  }
  function money(n) { try { return (S.hint.currency && S.hint.currency !== "INR" ? S.hint.currency + " " : "₹") + Math.round(Number(n) || 0).toLocaleString("en-IN"); } catch (e) { return String(n); } }
  function nextDue() {
    var sc = (S.bundle && S.bundle.public_trial_payment_sim) || {}, a = Number(sc.amount) || 0;
    if (a > 0) return { amount: a, label: sc.label || "Booking payment" };
    return { amount: Number(S.hint.total) || 0, label: "Booking payment" };
  }
  function viewPayPage() {
    var due = nextDue(), w = el("div", "tp-pay"), top = el("div", "tp-pay-top"), b = el("div", "tp-pay-b");
    top.appendChild(el("div", null, clean(S.studio) + " · " + (clean(S.hint.title) || "Your event")));
    top.appendChild(el("div", null, due.label)); top.appendChild(el("strong", null, money(due.amount)));
    [["UPI", "Selected"], ["Debit or credit card", ""], ["Net banking", ""]].forEach(function (o, i) {
      var r = el("div", "tp-pay-opt" + (i ? "" : " on")); r.appendChild(el("span", null, o[0])); r.appendChild(el("span", null, o[1])); b.appendChild(r); });
    b.appendChild(el("div", "tp-pay-go", "Pay " + money(due.amount)));
    b.appendChild(el("p", "tp-pay-note", "On a paid plan this page belongs to the payment partner. No money moves here."));
    w.appendChild(top); w.appendChild(b); return w;
  }
  function hideIn(d, sels) { sels.forEach(function (s) { Array.prototype.forEach.call(d.querySelectorAll(s), function (n) { n.hidden = true; n.style.display = "none"; }); }); }
  function jump(d, w, sel) {
    var n = Array.prototype.filter.call(d.querySelectorAll(sel), function (x) { return !x.hidden && x.offsetParent !== null; })[0];
    if (!n) return false;
    try { n.scrollIntoView({ block: "start" }); } catch (e) {}
    return true;
  }
  function bookletOnly(id, label) {
    return function (d) {
      var app = d.getElementById("app"); if (!app || app.hidden) return false;
      var toc = d.getElementById("toc"), main = d.getElementById("main"), wrap = toc && toc.parentNode;
      if (toc) toc.style.display = "none";
      if (wrap && wrap !== app) { wrap.style.display = "block"; wrap.style.maxWidth = "none"; }
      hideIn(d, ["#printBtn", ".dl-bar", "#qvBanner", ".toc-toggle", "footer"]);
      var cover = d.getElementById("cover"), secs = d.querySelectorAll("section.sec");
      if (id === "cover") { Array.prototype.forEach.call(secs, function (n) { n.style.display = "none"; }); return true; }
      if (cover) cover.style.display = "none";
      Array.prototype.forEach.call(secs, function (n) { n.style.display = n.id === id ? "" : "none"; });
      var t = d.getElementById(id);
      if (t && t.hidden && main && !d.getElementById("tpEmpty")) {
        var p = d.createElement("p"); p.id = "tpEmpty"; p.textContent = label + ": nothing to show yet for this event. Your client would see it here once you add it.";
        p.style.padding = "24px"; main.insertBefore(p, main.firstChild);
      }
      return true;
    };
  }
  // a recorded approval says TEST; a look-only step does not claim anything was recorded
  function markApproved(d) {
    var t = d.getElementById("approvedTitle"), n = d.getElementById("approvedNote");
    if (t && S.approved) t.textContent = "Approved (test mode)";
    if (n) n.textContent = S.approved ? "Recorded as a TEST on this quote." : "";
  }
  function quoteState(status) {
    var base = (S.bundle && S.bundle.public_get_quote) || null;
    return (base && !base.__error) ? Object.assign({}, base, { approval_status: base.approval_status === "paid" ? "paid" : status }) : base;
  }
  var B_SECTIONS = [["cover", "Cover"], ["details", "Event details"], ["packages", "Package choice"], ["layout2d", "Floor plan"], ["layout3d", "3D view"],
    ["menu", "Menu"], ["quote", "Quotation"], ["versions", "Quote history"], ["payments", "Payments"], ["terms", "Terms"]];

  function viewBookletSettings() {
    var f = el("div", "tp-form");
    f.appendChild(el("h3", null, "Event booklet settings")); f.appendChild(el("p", null, "Choose what your client would see, then preview it."));
    f.appendChild(el("label", "tp-lab", "Link valid for, on a paid plan")).setAttribute("for", "tpDays");
    var sel = el("select", "tp-sel"); sel.id = "tpDays";
    [7, 14, 30, 60, 90, 180].forEach(function (d) { var o = el("option", null, d + " days"); o.value = String(d); if (d === (S.opts.days || 30)) o.selected = true; sel.appendChild(o); });
    sel.addEventListener("change", function () { S.opts.days = Number(sel.value); });
    f.appendChild(sel);
    var vs = Array.isArray(S.bundle && S.bundle.versions) ? S.bundle.versions : [];
    if (vs.length) {
      f.appendChild(el("div", "tp-lab", "Quote versions to show"));
      var vb = el("div", "tp-vers"); S.opts.version_ids = S.opts.version_ids || vs.map(function (v) { return v.id; });
      vs.forEach(function (v, i) {
        var l = el("label"), c = el("input"); c.type = "checkbox"; c.checked = S.opts.version_ids.indexOf(v.id) >= 0;
        c.addEventListener("change", function () { S.opts.version_ids = c.checked ? S.opts.version_ids.concat([v.id]) : S.opts.version_ids.filter(function (x) { return x !== v.id; }); });
        l.appendChild(c); l.appendChild(el("span", null, "Quotation " + String(v.label || "version " + (vs.length - i)) + (v.total != null ? " · " + money(v.total) : "") + (i ? "" : " (latest)")));
        vb.appendChild(l); });
      f.appendChild(vb);
    }
    f.appendChild(el("div", "tp-lab", "What the client sees"));
    var ch = el("div", "tp-checks"); S.opts.sections = S.opts.sections || {};
    [["studio", "Studio details"], ["client", "Client details"], ["venue", "Venue details"], ["menu", "Menu / packages"], ["layout2d", "Floor plan"], ["layout3d", "3D view"],
      ["quotation", "Quotation"], ["payments", "Payments"], ["terms", "Terms"]].forEach(function (x) {
      var l = el("label"), c = el("input"); c.type = "checkbox"; c.checked = S.opts.sections[x[0]] !== false; S.opts.sections[x[0]] = c.checked;
      c.addEventListener("change", function () { S.opts.sections[x[0]] = c.checked; });
      l.appendChild(c); l.appendChild(el("span", null, x[1])); ch.appendChild(l); });
    f.appendChild(ch);
    f.appendChild(el("label", "tp-lab", "Note to your client (optional)")).setAttribute("for", "tpNote");
    var ta = el("textarea", "tp-note"); ta.id = "tpNote"; ta.rows = 2; ta.maxLength = 1000; ta.value = S.opts.note || "";
    ta.addEventListener("input", function () { S.opts.note = ta.value; }); f.appendChild(ta);
    return f;
  }
  var TEMPLATES = [["eternal", "Eternal", "Elegant \u00b7 wedding"], ["promise", "Promise", "Romantic \u00b7 engagement"], ["confetti", "Confetti", "Festive \u00b7 birthday"],
    ["summit", "Summit", "Professional \u00b7 corporate"], ["soiree", "Soir\u00e9e", "Modern \u00b7 any event"], ["shubh", "Shubh Vivah", "Regal \u00b7 Indian wedding"],
    ["mehndi", "Mehndi", "Vibrant \u00b7 sangeet"], ["solitaire", "Solitaire", "Graceful \u00b7 engagement"], ["jubilee", "Jubilee", "Joyful \u00b7 birthday"],
    ["gala", "Gala Noir", "Black-tie \u00b7 corporate"], ["linen", "Linen", "Minimal \u00b7 modern"]];
  function viewTemplates() {
    var w = el("div"), names = clean(((S.bundle.public_event_site || [])[0] || {}).title) || clean(S.hint.client_name) || "Your event";
    var g = el("div", "tp-tpl"); g.setAttribute("role", "group"); g.setAttribute("aria-label", "Choose a template");
    S.opts.template = S.opts.template || ((S.bundle.public_event_site || [])[0] || {}).template || "eternal";
    TEMPLATES.forEach(function (t) {
      var b = el("button"); b.type = "button"; b.setAttribute("aria-pressed", String(t[0] === S.opts.template));
      b.appendChild(el("i", "t-" + t[0], names)); b.appendChild(el("b", null, t[1])); b.appendChild(el("small", null, t[2]));
      b.addEventListener("click", function () { S.opts.template = t[0]; Array.prototype.forEach.call(g.children, function (x) { x.setAttribute("aria-pressed", String(x === b)); }); });
      g.appendChild(b); });
    w.appendChild(g); return w;
  }
  function siteRow() {
    var r = Object.assign({}, ((S.bundle && S.bundle.public_event_site) || [])[0] || {}), h = S.hint, d = Object.assign({}, r.data || {});
    if (!d.names) d.names = clean(h.client_name) || clean(h.title);
    if (!d.date && h.event_date) d.date = h.event_date;
    if (!d.venue && h.venue) d.venue = clean(h.venue);
    if (!d.rsvpForm) d.rsvpForm = true;
    r.data = d; r.template = S.opts.template || r.template; r.title = r.title || clean(h.title);
    return [r];
  }
  function openCover(d) { var c = d.getElementById("cover"), b = d.getElementById("openBtn"); if (!b || !c) return false; if (c.hidden) return true; if (!b.getClientRects().length) return false; b.click(); return false; }

  function sample(kind) {
    var h = S.hint || {}, ev = clean(h.title) || "your event";
    if (kind === "crew") return {
      worker_get_tasks: { event: { code: h.code || "EV-0001", title: ev, event_date: h.event_date, event_time: null }, worker: { name: "Sample crew member", phone: "+91 00000 00000" },
        tasks: [{ id: "00000000-0000-4000-8000-000000000001", category: "Setup", title: "Hang lights over the stage", status: "assigned" },
                { id: "00000000-0000-4000-8000-000000000002", category: "Setup", title: "Check the sound system", status: "accepted" }] },
      worker_get_equipment: { equipment: [] }, worker_assignment_updates: null, crew_link_home: null, crew_name: "Sample crew member" };
    if (kind === "vendor") return { vendor_link_get: { ok: true, status: "sent", studio: S.studio, vendor_name: "Sample vendor", what: "Fresh flower garlands", qty: 40, event_title: ev,
      when_text: h.event_date || "", where_text: clean(h.venue), agreed_amount: 25000, currency: h.currency || "INR", details: "Sample request: assign a vendor on this event to see your own." } };
    return {};
  }
  function buildSteps() {
    var k = S.kind, st = clean(S.studio) || "Your studio", h = S.hint, m = messages(k, h, st), out = [];
    function mail() { return viewMail(m); }
    if (k === "approval") {
      var codeHint = "Try it: use the code 000000. Nothing is sent. Pressing Confirm records a TEST approval on this quote, seen only in your studio. On a paid plan the code lasts 10 minutes.";
      out = [
        { label: "E-mail", view: mail },
        { label: "WhatsApp", view: function () { return viewPhone("Helm Events", m.wa, m.button, true); } },
        { label: "Client page", view: function () { return viewFrame("approve", "Client page", function (d) { if (!d.getElementById("content") || d.getElementById("content").hidden) return false; hideIn(d, ["#flow"]); return true; }); }, over: { public_get_quote: function () { return quoteState("sent"); } } },
        { label: "One-time code", view: function () { return viewFrame("approve", "One-time code", function (d, w) { if (!d.getElementById("content") || d.getElementById("content").hidden) return false;
            hideIn(d, ["#sendOtp"]); var wa = d.getElementById("sendWa"); if (wa) { wa.textContent = "Send code on WhatsApp (coming soon)"; wa.disabled = true; }
            var em = d.getElementById("sendEmailOtp"); if (em) em.addEventListener("click", function () { w.setTimeout(function () { var m0 = d.getElementById("msg"); if (m0) m0.textContent = "Preview: nothing was sent. Use the code 000000."; }, 400); });
            jump(d, w, "#flow"); return true; }, codeHint); },
          over: { public_get_quote: function () { return quoteState("sent"); } } },
        { label: "Approved", view: function () { return viewFrame("approve", "Approved", function (d, w) { var s3 = d.getElementById("step3"); if (!s3 || s3.hidden) return false; hideIn(d, ["#payBtn", "#simPay", "#payManual"]); markApproved(d); jump(d, w, "#flow"); return true; },
            S.approved ? "Recorded as a TEST approval on this quote. Your client saw nothing." : "This is the screen your client would see. Nothing was recorded."); },
          over: { public_get_quote: function () { return quoteState("approved"); } } },
        { label: "Payment", view: function () { return viewFrame("approve", "Payment", function (d, w) { var s3 = d.getElementById("step3"); if (!s3 || s3.hidden) return false; var b = d.getElementById("payBtn"); if (b) { b.hidden = false; b.style.display = ""; } hideIn(d, ["#simPay", "#payManual"]); markApproved(d); jump(d, w, "#flow"); return true; },
            "The button below records a TEST payment on this quote. It never reaches income, the ledger or P&L.", viewSimPay()); },
          over: { public_get_quote: function () { return quoteState("approved"); } } },
        { label: "Payment", view: viewPayPage },
        { label: "Payment", view: function () { return viewFrame("approve", "Advance received", function (d, w) { var p = d.getElementById("stepPaid"); if (!p || p.hidden) return false; jump(d, w, "#flow"); return true; }); },
          over: { public_get_quote: function () { var q = quoteState("approved"); return q ? Object.assign({}, q, { approval_status: "paid" }) : q; },
            public_quote_paid_status: function () { var due = nextDue(), sim = (S.bundle.public_trial_sim_payments && S.bundle.public_trial_sim_payments.rows) || [];
              return { paid: due.amount, total: Number(h.total) || due.amount, receipt_no: (sim[0] && sim[0].receipt) || "TEST-00000000" }; } } },
        { label: "Portal", view: function () { return viewFrame("portal", "Client portal"); } }
      ];
    } else if (k === "booklet") {
      out = [{ label: "Settings", view: viewBookletSettings, white: true, leave: function () { return reload(); } }];
      B_SECTIONS.forEach(function (x) { out.push({ label: x[1], view: function () { return viewFrame("booklet", x[1], bookletOnly(x[0], x[1])); } }); });
    } else if (k === "invitation") {
      var over = { public_event_site: function () { return siteRow(); }, public_invite_info: function () { return { state: "live", studio: st }; } };
      out = [
        { label: "Template", view: viewTemplates, white: true, leave: function () { return reload(); } },
        { label: "Full site", view: function () { return viewFrame("invite", "Invitation cover", function (d) { return !!d.getElementById("openBtn"); }); }, over: over },
        { label: "Full site", view: function () { return viewFrame("invite", "Invitation", function (d) { return openCover(d); }); }, over: over },
        { label: "RSVP", view: function () { return viewFrame("invite", "RSVP", function (d, w) { if (!openCover(d)) return false; w.setTimeout(function () { jump(d, w, "#rsvpSlot"); }, 500); return jump(d, w, "#rsvpSlot"); }, "Clickable, nothing is saved and no real guest's details are collected."); }, over: over },
        { label: "Guest view", view: function () { return viewPhoneFrame("invite", "Guest view on a phone", function (d) { return openCover(d); }, "How your guests would see it on a phone."); }, over: over }
      ];
    } else if (k === "proposal") {
      out = [
        { label: "Message", view: function () { return viewPhone("Helm Events", m.wa, m.button, true); } },
        { label: "Concept", view: function () { return viewFrame("proposal", "Proposal concept"); } },
        { label: "Mood board", view: function () { return viewFrame("proposal", "Mood board", function (d, w) { return jump(d, w, "#paletteSec,#gallerySec"); }); } },
        { label: "Scope and price", view: function () { return viewFrame("proposal", "Scope and price", function (d, w) { return jump(d, w, "#scopeSec,#priceSec"); }); } }
      ];
    } else if (k === "crew") {
      var nm = clean(S.bundle.crew_name) || "there", date = h.event_date ? " on " + h.event_date : "";
      out = [
        { label: "Message", view: function () { return viewPhone(st, "Hi " + nm + ", your tasks for " + (clean(h.title) || "the event") + date + " are ready.", "Open my tasks", true); } },
        { label: "Tasks", view: function () { return viewFrame("work", "Crew tasks", null, "Clickable, nothing is saved."); } },
        { label: "Run-sheet", view: function () { return viewFrame("work", "Crew run-sheet", function (d, w) { return !d.getElementById("content").hidden && (jump(d, w, "#rsSec,#tasks") || true); }); } }
      ];
    } else if (k === "vendor") {
      var vg = S.bundle.vendor_link_get || {}, wh = clean(vg.what) || "the work";
      out = [
        { label: "Message", view: function () { return viewPhone(st, "Hello " + (clean(vg.vendor_name) || "there") + ", please confirm " + wh + " for " + (clean(h.title) || "our event") + (vg.when_text ? " (" + vg.when_text + ")" : "") + ". Accept or decline here, and send your invoice the same way.", "Open request", true); } },
        { label: "Request", view: function () { return viewFrame("vendor", "Vendor request", null, "Clickable, nothing is saved."); } },
        { label: "Reply", view: function () { return viewFrame("vendor", "After the vendor accepts", function (d) { var a = d.getElementById("vr-answer"); if (a) a.hidden = true; return !!a; }); }, over: { vendor_link_get: function () { return Object.assign({}, vg, { ok: true, status: "accepted" }); } } }
      ];
    } else if (k === "enquiry") {
      out = [
        { label: "Form", view: function () { return viewFrame("enquiry", "Enquiry form", null, "Clickable, nothing is saved. In a free trial the form stays off; on a paid plan your form has its own address."); } },
        { label: "Thank you", view: function () { return viewFrame("enquiry", "Thank you", function (d) { var f = d.getElementById("eq-form"), t = d.getElementById("eq-title"), m2 = d.getElementById("eq-msg"); if (!f || !t) return false; f.hidden = true; t.textContent = "Thank you"; if (m2) m2.textContent = "We have your details and will get back to you shortly."; return true; }); } }
      ];
    }
    return out;
  }
  function groups() { var g = []; S.steps.forEach(function (s, i) { var l = g[g.length - 1]; if (!l || l.label !== s.label) g.push({ label: s.label, first: i, last: i }); else l.last = i; }); return g; }
  function paint() {
    var i = S.i, s = S.steps[i]; S.step = s;
    S.bar.textContent = "";
    var gs = groups(), cur = 0, many = gs.length > 8;
    gs.forEach(function (g, n) {
      var on = i >= g.first && i <= g.last; if (on) cur = n;
      var li = el("li", on ? "cur" : (i > g.last ? "done" : "")); if (on) li.setAttribute("aria-current", "step");
      li.appendChild(el("span", "tp-n", String(n + 1)));
      if (!many || on) li.appendChild(el("span", "tp-l", g.label));
      S.bar.appendChild(li);
    });
    S.live.textContent = "Step " + (cur + 1) + " of " + gs.length + ": " + s.label;
    S.back.disabled = i === 0;
    S.next.textContent = i === S.steps.length - 1 ? "Done" : "Next";
    setBody(s.view(), !!s.white);
    var li = S.bar.querySelector(".cur"); if (li && li.scrollIntoView) try { li.scrollIntoView({ block: "nearest", inline: "center" }); } catch (e) {}
  }
  function go(d) {
    if (!S) return;
    var i = S.i + d;
    if (i >= S.steps.length) { close(); return; }
    if (i < 0) return;
    var run = d > 0 && S.steps[S.i].leave;
    S.next.disabled = true; S.back.disabled = true;
    Promise.resolve(run ? run() : null).catch(function () {}).then(function () { if (!S) return; S.next.disabled = false; S.i = i; paint(); });
  }
  function close() {
    if (!S) return;
    var s = S; S = null;
    doc.removeEventListener("keydown", s.key, true);
    s.ov.remove(); doc.documentElement.classList.remove("tp-lock");
    try { if (s.opener && s.opener.isConnected) s.opener.focus(); } catch (e) {}
    if (s.changed) { try { global.location.reload(); } catch (e) {} }
  }
  function focusable(root) { return Array.prototype.filter.call(root.querySelectorAll("button,select,textarea,input,a[href],iframe,[tabindex]"), function (n) { return !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null; }); }
  function css() { if (doc.getElementById("trialPreviewCss")) return; var l = doc.createElement("link"); l.id = "trialPreviewCss"; l.rel = "stylesheet"; l.href = "/trial-preview.css?v=1"; (doc.head || doc.documentElement).appendChild(l); }

  var api = {
    disclaimer: disclaimer, messages: messages, outsiderHref: outsiderHref, TITLE: TITLE, VALID: VALID,
    open: function (kind, ctx) {
      ctx = ctx || {};
      if (S || !TITLE[kind]) return null;
      css();
      var st = store(); if (!st) return null;
      var ov = el("div", "tp-ov hbp-skip"), dlg = el("div", "tp-dlg"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "tpTitle");
      var head = el("div", "tp-head"), t = el("h2", "tp-title", TITLE[kind]); t.id = "tpTitle";
      var x = el("button", "tp-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Close preview");
      head.appendChild(t); head.appendChild(el("span", "tp-chip", "NOT SENT")); head.appendChild(x);
      var bar = el("ol", "tp-steps"); bar.setAttribute("aria-label", "Preview steps");
      var dt = disclaimer(kind), disc = el("p", "tp-disc"); disc.setAttribute("role", "note"); disc.appendChild(el("b", null, dt.lead)); disc.appendChild(doc.createTextNode(dt.text));
      var live = el("div", "sr-only"); live.setAttribute("aria-live", "polite"); live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)";
      var body = el("div", "tp-body"); body.setAttribute("tabindex", "-1");
      var foot = el("div", "tp-foot"), cl = el("button", "tp-btn", "Close"), plan = el("button", "tp-btn", "Choose a plan"), back = el("button", "tp-btn", "Back"), next = el("button", "tp-btn pri", "Next");
      [cl, plan, back, next].forEach(function (b) { b.type = "button"; });
      foot.appendChild(cl); foot.appendChild(plan); foot.appendChild(el("span", "tp-sp")); foot.appendChild(back); foot.appendChild(next);
      [head, bar, disc, live, body, foot].forEach(function (n) { dlg.appendChild(n); }); ov.appendChild(dlg);
      S = { kind: kind, quoteId: ctx.quoteId || null, opts: Object.assign({}, ctx.opts || {}), i: 0, ov: ov, bar: bar, body: body, live: live, back: back, next: next,
        opener: ctx.opener || doc.activeElement, bundle: {}, hint: {}, studio: "", steps: [] };
      if (ctx.phone) S.opts.phone = ctx.phone;
      if (ctx.requestId) S.opts.request_id = ctx.requestId;
      var key = function (e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
        if (e.key !== "Tab" || !S) return;
        var f = focusable(dlg); if (!f.length) return;
        var a = doc.activeElement, i0 = f[0], l = f[f.length - 1];
        if (e.shiftKey && a === i0) { e.preventDefault(); l.focus(); } else if (!e.shiftKey && a === l) { e.preventDefault(); i0.focus(); }
      };
      S.key = key; doc.addEventListener("keydown", key, true);
      x.addEventListener("click", close); cl.addEventListener("click", close);
      plan.addEventListener("click", function () { var u = "/plan"; close(); try { global.location.href = global.HelmUrl && global.HelmUrl.page ? global.HelmUrl.page("plan") : u; } catch (e) { global.location.href = u; } });
      back.addEventListener("click", function () { go(-1); }); next.addEventListener("click", function () { go(1); });
      ov.addEventListener("mousedown", function (e) { if (e.target === ov) close(); });
      doc.documentElement.classList.add("tp-lock"); doc.body.appendChild(ov);
      setBody(viewWait()); back.disabled = true; next.disabled = true; next.focus();
      var fail = function (m) { if (S) { setBody(viewWait(m)); } };
      if (kind !== "enquiry" && !S.quoteId) { fail("Open an event first: this preview shows that event's own details."); x.focus(); return S; }
      st.bundle(kind, S.quoteId, S.opts).then(function (b) {
        if (!S) return;
        b = b || {};
        if (b.__error) { fail("This preview could not load: " + String(b.__error)); return; }
        var sm = sample(kind);
        S.bundle = b; S.hint = b.hint || {}; S.studio = b.studio || (b.public_enquiry_info && b.public_enquiry_info.studio) || "";
        if ((kind === "crew" && !b.worker_get_tasks) || (kind === "vendor" && !b.vendor_link_get)) { sm = sample(kind); Object.keys(sm).forEach(function (k) { S.bundle[k] = sm[k]; }); }
        S.steps = buildSteps(); next.disabled = false; paint(); next.focus();
      }).catch(function (e) { fail("This preview could not load: " + String((e && e.message) || "please try again.")); });
      return S;
    },
    start: function () {
      css();
      doc.addEventListener("click", onClick, true);
      var pend = false;
      var run = function () { pend = false; if (doc.body) sweep(); };
      run();
      new global.MutationObserver(function () { if (pend) return; pend = true; (global.requestAnimationFrame || setTimeout)(run); })
        .observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "href"] });
    }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.HelmTrialPreview = api;
  if (doc && doc.documentElement) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", api.start); else api.start();
  }
})(typeof window !== "undefined" ? window : this);
