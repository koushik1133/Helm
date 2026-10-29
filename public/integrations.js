/* integrations.js — /<studio>/integrations (0134 + 0150). Status cards for Email, WhatsApp and
   Razorpay, the studio's e-mail sender name / reply-to and WhatsApp number, and "Send test".
   Status per channel is one of three words:
     Not connected  nothing saved / Helm's service not deployed
     Simulated      saved, but the channel's secrets are not set, so nothing really leaves Helm
     Live           the server (integrations-test "status") says the secrets are set
   Status comes from BPStore.integrations.overview() (integrations_overview) and
   BPStore.integrations.channelStatus() (the integrations-test edge function: booleans only,
   never a key). No secret is ever read, shown or stored by this page.
   CSP-safe: textContent only, no inline styles, no HTML strings. Pure helpers exported for
   tests (HelmIntegrations). */
(function (global) {
  "use strict";

  function n(v) { var x = Number(v); return isFinite(x) && x > 0 ? Math.floor(x) : 0; }
  function digits(v) { return String(v == null ? "" : v).replace(/\D/g, ""); }
  // "919876543210" → "+91 98765 43210" (display only)
  function showPhone(v) {
    var d = digits(v); if (d.length < 8) return "";
    if (d.length === 12 && d.indexOf("91") === 0) return "+91 " + d.slice(2, 7) + " " + d.slice(7);
    return "+" + d;
  }

  // ---- pure validation ----
  // E.164: "+" then country code (no leading 0) then subscriber number, 8..15 digits in all.
  // Spaces, dashes, dots and brackets are allowed while typing. "00" prefix = "+".
  // Returns { ok, digits } (digits as stored: no "+") or { ok:false, error }.
  function parseE164(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return { ok: true, digits: "" };
    if (/[^0-9+\s().-]/.test(s)) return { ok: false, error: "Use digits only, starting with + and the country code." };
    s = s.replace(/[\s().-]/g, "");
    if (s.indexOf("00") === 0) s = "+" + s.slice(2);
    if (s.charAt(0) !== "+") return { ok: false, error: "Start with + and the country code, e.g. +91 98765 43210." };
    var d = s.slice(1);
    if (!/^[1-9][0-9]{7,14}$/.test(d)) return { ok: false, error: "Enter 8 to 15 digits after the +, e.g. +91 98765 43210." };
    if (d.indexOf("91") === 0 && d.length !== 12) return { ok: false, error: "Indian numbers are +91 then 10 digits." };
    return { ok: true, digits: d };
  }
  var EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  function validEmail(v) { var s = String(v == null ? "" : v).trim(); return !s || (s.length <= 254 && EMAIL_RE.test(s)); }
  function validFromName(v) { var s = String(v == null ? "" : v).trim(); return s.length <= 60 && !/[<>"\r\n]/.test(s); }

  // ---- pure: one {state, label, meta} per card. state: on (Live) | wait (Simulated) | off (Not connected) ----
  function emailStatus(ov, srv) {
    var e = (ov && ov.email) || {};
    var sent = n(e.sent_30d), failed = n(e.failed_30d), pending = n(e.pending);
    var counts = sent ? " " + sent + " invite e-mail" + (sent === 1 ? "" : "s") + " sent in the last 30 days" + (failed ? ", " + failed + " could not be delivered" : "") + "." : "";
    if (srv && srv.email && srv.email.live) return { state: "on", label: "Live", meta: "Helm sends your studio's e-mails (invites, payment reminders, follow-ups)." + counts + (pending ? " " + pending + " waiting to go out." : "") };
    if (srv && srv.email) return { state: "wait", label: "Simulated", meta: "Client e-mails are simulated – nothing is sent to clients yet. Teammate invites still go out through Helm's sign-in e-mail." + counts };
    if (ov && ov.has_invite_mailer && sent > 0) return { state: "on", label: "Live", meta: "Teammate invites are e-mailed by Helm." + counts };
    return { state: "off", label: "Not connected", meta: "Helm's e-mail service is not switched on yet. Invites still work: copy the Join link and share it." };
  }
  function whatsappStatus(ov, srv) {
    var num = ov && showPhone(ov.studio_whatsapp);
    var acct = ov && ov.whatsapp && ov.whatsapp.status;
    var own = acct === "connected" ? " Your own WhatsApp Business account is connected." : acct === "pending" ? " Your own WhatsApp Business account is saved and waiting for Helm to verify it." : acct === "error" ? " Your own WhatsApp Business account needs attention – contact Helm support." : "";
    var live = !!(srv && srv.whatsapp && srv.whatsapp.live);
    if (num && live) return { state: "on", label: "Live", meta: "Messages go out from Helm's WhatsApp number on behalf of your studio. Your studio number: " + num + "." + own };
    if (num) return { state: "wait", label: "Simulated", meta: "Your studio number " + num + " is saved. Messages are simulated – nothing is sent on WhatsApp until Helm switches it on." + own };
    return { state: "off", label: "Not connected", meta: "Add your studio WhatsApp number below to start." + own };
  }
  function razorpayStatus(ov, live) {
    var r = ov && ov.razorpay;
    if (r && r.status === "connected" && live) return { state: "on", label: "Live" + (r.mode === "live" ? "" : " (test mode)"), meta: "Payment links on your events collect money into your Razorpay account." };
    if (r && (r.status === "pending" || r.status === "connected")) return { state: "wait", label: "Simulated", meta: "Your keys are saved. Helm checks them in test mode before any client sees a payment link." };
    if (r && r.status === "error") return { state: "off", label: "Needs attention", meta: "Helm could not verify your Razorpay keys. Contact Helm support." };
    return { state: "off", label: "Not connected", meta: "Record payments by hand on each event for now." };
  }
  // the line shown after "Send test": {state, text}
  function testResultText(channel, r) {
    var what = channel === "email" ? "e-mail" : "WhatsApp";
    if (!r || typeof r !== "object") return { state: "off", text: "Could not run the test. Try again in a minute." };
    var to = r.to ? " to " + r.to : "";
    if (r.mode === "simulated") {
      var extra = channel === "email" ? (r.from ? " From: " + r.from + "." : "") + (r.reply_to ? " Reply-to: " + r.reply_to + "." : " No reply-to set.") : "";
      return { state: "wait", text: "Simulated – a test " + what + " would go" + to + ", but nothing was sent (" + (r.reason || "channel not switched on yet") + ")." + extra };
    }
    if (r.sent) return { state: "on", text: "Live – test " + what + " sent" + to + ". Check it arrived." };
    return { state: "off", text: "Not sent – " + (r.error || "the provider refused it") + "." };
  }
  // when integrations-test is not deployed yet: a local, clearly-labelled simulation
  function localSimulation(channel, ctx) {
    var c = ctx || {};
    if (channel === "whatsapp") return { mode: "simulated", sent: false, to: c.phone || "", reason: "Helm's test service is not deployed yet" };
    return { mode: "simulated", sent: false, to: c.email || "your login e-mail", from: c.from || "", reply_to: c.replyTo || null, reason: "Helm's test service is not deployed yet" };
  }

  function liveFlags() {
    var c = global.SUPABASE_CONFIG && global.SUPABASE_CONFIG.liveChannels;
    return { whatsapp: !!(c && c.whatsapp), pay: !!(c && c.pay) };
  }

  function paint(doc, id, st) {
    var b = doc.getElementById(id + "Badge"), m = doc.getElementById(id + "Meta");
    if (b) { b.textContent = st.label; b.setAttribute("data-state", st.state); }
    if (m) m.textContent = st.meta || "";
  }
  function friendly(e) {
    // r35 (0285): the reply-to address needs a fresh two-step code (the store asks for it once)
    if (e && e.cancelled) return "Not saved - this change needs your two-step code.";
    if (e && e.stepUp) return String(e.message || "");
    var U = global.BPUI;
    if (U && typeof U.friendlyError === "function") { try { return U.friendlyError(e, { action: "save" }); } catch (x) {} }
    return String((e && e.message) || "Something went wrong. Try again.");
  }

  async function load() {
    var doc = global.document, S = global.BPStore;
    await S.init();
    var boot = doc.getElementById("boot"); if (boot) boot.hidden = true;
    var ov = null, denied = false;
    try { ov = S.integrations ? await S.integrations.overview() : null; }
    catch (e) {
      var c = String((e && (e.code || e.message)) || "");
      if (/42501|not authorized/i.test(c)) denied = true;
    }
    if (!denied && !ov) {
      // server older than 0134: still show the guides, gate on Settings view
      try { denied = !(await S.auth.canView("controls")); } catch (e) { denied = false; }
    }
    if (denied) { doc.getElementById("noaccess").hidden = false; return; }
    var I = S.integrations || {};
    var srv = null, es = null;
    // manager-1019: the two reads run side by side (they were one after the other)
    var both = await Promise.all([
      Promise.resolve().then(function () { return I.channelStatus ? I.channelStatus() : null; }).catch(function () { return null; }),
      Promise.resolve().then(function () { return I.emailSettings ? I.emailSettings() : null; }).catch(function () { return null; })]);
    srv = both[0]; es = both[1];
    var state = { ov: ov || {}, srv: srv, es: es };
    var repaint = function () {
      paint(doc, "itgEmail", emailStatus(state.ov, state.srv));
      paint(doc, "itgWa", whatsappStatus(state.ov, state.srv));
      paint(doc, "itgPay", razorpayStatus(state.ov, liveFlags().pay));
      var fl = doc.getElementById("itgEmailFromLine");
      if (fl) {
        var nm = (state.es && (state.es.from_name || state.es.studio_name)) || "your studio";
        var addr = state.srv && state.srv.email && state.srv.email.sender ? state.srv.email.sender : "Helm's sending address";
        fl.textContent = "Clients see: " + nm + " <" + addr + ">" + (state.es && state.es.reply_to ? ", replies go to " + state.es.reply_to : "") + ".";
      }
    };
    repaint();
    wireEmail(doc, S, state, repaint);
    wireWhatsapp(doc, S, state, repaint);
    doc.getElementById("app").hidden = false;
    // open the guide the user came for (#whatsapp / #email / #payments)
    var h = String(global.location.hash || "").slice(1);
    var target = { whatsapp: "itgWa", email: "itgEmail", payments: "itgPay" }[h];
    if (target) { var sec = doc.getElementById(target), d = sec && sec.querySelector("details"); if (d) d.open = true; try { sec.scrollIntoView({ block: "start" }); } catch (e) {} }
  }

  function setErr(doc, inputId, msg) {
    var el = doc.getElementById(inputId), er = doc.getElementById(inputId + "Err");
    if (er) er.textContent = msg || "";
    if (el) { if (msg) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid"); }
  }
  function showResult(doc, id, r) {
    var el = doc.getElementById(id); if (!el) return;
    el.textContent = r.text; el.setAttribute("data-state", r.state);
  }
  async function busy(btn, fn) {
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }
  async function runTest(doc, S, channel, resultId, ctx) {
    showResult(doc, resultId, { state: "wait", text: "Sending test…" });
    var r;
    try { r = await S.integrations.sendTest(channel); }
    catch (e) {
      var m = String((e && e.message) || "");
      // r59 (audit F-7): only "not deployed" (HTTP 404) is shown as a simulation. A server error or a dropped
      // connection is a real failure in live mode and must never read as a successful (simulated) test.
      var k = testFailureKind(m);
      if (k === "simulate") r = localSimulation(channel, ctx);
      else { showResult(doc, resultId, { state: "off", text: testFailureText(k, m) }); return; }
    }
    showResult(doc, resultId, testResultText(channel, r));
  }

  // r59: what a failed "Send test" call means -> "simulate" (function not deployed: 404) | "server" (5xx) |
  // "network" (no answer) | "refused" (the function said why)
  function testFailureKind(m) {
    m = String(m || "");
    if (/HTTP 404\b/.test(m)) return "simulate";
    if (/HTTP 5\d\d\b/.test(m)) return "server";
    if (!m || /Failed to fetch|NetworkError|Load failed|network/i.test(m)) return "network";
    return "refused";
  }
  function testFailureText(kind, m) {
    if (kind === "server") return "Not sent – Helm had a problem sending the test. Nothing was sent; try again in a minute.";
    if (kind === "network") return "Not sent – couldn't reach Helm (check your connection, or the test service may not be switched on yet). Nothing was sent.";
    return "Not sent – " + String(m || "").replace(/\.$/, "") + ".";
  }

  function wireEmail(doc, S, state, repaint) {
    var form = doc.getElementById("itgEmailForm"), ro = doc.getElementById("itgEmailRo");
    if (!form) return;
    if (!state.es) { // server older than 0150: nothing to edit yet
      if (ro) { ro.textContent = "Sender name and reply-to are not available for your studio yet."; ro.hidden = false; }
      return;
    }
    if (state.es.can_edit !== true) { if (ro) ro.hidden = false; return; }
    var nameEl = doc.getElementById("itgFromName"), rtEl = doc.getElementById("itgReplyTo");
    nameEl.value = state.es.from_name || ""; rtEl.value = state.es.reply_to || "";
    if (state.es.studio_name) nameEl.placeholder = String(state.es.studio_name).slice(0, 60);
    form.hidden = false;
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var nm = nameEl.value.trim(), rt = rtEl.value.trim().toLowerCase(), bad = false;
      setErr(doc, "itgFromName", validFromName(nm) ? "" : (bad = true, "Up to 60 characters, no < > or quotes."));
      setErr(doc, "itgReplyTo", validEmail(rt) ? "" : (bad = true, "Enter one e-mail address, e.g. bookings@yourstudio.com."));
      if (bad) { (doc.querySelector("#itgEmailForm [aria-invalid=true]") || nameEl).focus(); return; }
      busy(doc.getElementById("itgEmailSave"), async function () {
        try {
          var out = await S.integrations.saveEmailSettings(nm, rt);
          state.es.from_name = (out && out.from_name) || null; state.es.reply_to = (out && out.reply_to) || null;
          repaint();
          showResult(doc, "itgEmailResult", { state: "on", text: "E-mail settings saved." });
        } catch (e) { showResult(doc, "itgEmailResult", { state: "off", text: friendly(e) }); }
      });
    });
    doc.getElementById("itgEmailTest").addEventListener("click", function () {
      var btn = this;
      busy(btn, function () { return runTest(doc, S, "email", "itgEmailResult", { from: (state.es.from_name || state.es.studio_name || "Helm") + " <Helm's sending address>", replyTo: state.es.reply_to }); });
    });
  }

  function wireWhatsapp(doc, S, state, repaint) {
    var form = doc.getElementById("itgWaForm"), ro = doc.getElementById("itgWaRo");
    if (!form) return;
    // same edit right as comms_settings_set (Settings edit); es.can_edit carries it (0150),
    // else ask the auth helper
    var canEdit = state.es ? state.es.can_edit === true : null;
    var go = function (ok) {
      if (!ok) { if (ro) ro.hidden = false; return; }
      var numEl = doc.getElementById("itgWaNum");
      numEl.value = showPhone(state.ov.studio_whatsapp);
      form.hidden = false;
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var p = parseE164(numEl.value);
        setErr(doc, "itgWaNum", p.ok ? "" : p.error);
        if (!p.ok) { numEl.focus(); return; }
        busy(doc.getElementById("itgWaSave"), async function () {
          try {
            var cfg = await S.comms.set({ studio_whatsapp: p.digits || null });
            state.ov.studio_whatsapp = (cfg && cfg.studio_whatsapp) || p.digits || null;
            numEl.value = showPhone(state.ov.studio_whatsapp);
            repaint();
            showResult(doc, "itgWaResult", { state: "on", text: p.digits ? "Number saved." : "Number removed. WhatsApp messages are off for your studio." });
          } catch (e) { showResult(doc, "itgWaResult", { state: "off", text: friendly(e) }); }
        });
      });
      doc.getElementById("itgWaTest").addEventListener("click", function () {
        var btn = this;
        if (!/^[0-9]{8,15}$/.test(String(state.ov.studio_whatsapp || ""))) { setErr(doc, "itgWaNum", "Save your studio WhatsApp number first."); numEl.focus(); return; }
        busy(btn, function () { return runTest(doc, S, "whatsapp", "itgWaResult", { phone: showPhone(state.ov.studio_whatsapp) }); });
      });
    };
    if (canEdit !== null) return go(canEdit);
    Promise.resolve(S.auth && S.auth.canEditArea ? S.auth.canEditArea("controls") : false).then(go, function () { go(false); });
  }

  var api = { emailStatus: emailStatus, whatsappStatus: whatsappStatus, razorpayStatus: razorpayStatus, showPhone: showPhone,
    parseE164: parseE164, validEmail: validEmail, validFromName: validFromName, testResultText: testResultText, localSimulation: localSimulation,
    testFailureKind: testFailureKind, testFailureText: testFailureText };
  global.HelmIntegrations = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;
  // MVP/trial: page switched off (HELM_FEATURES.integrationsPage in config.js) -> go to the dashboard
  if (!(global.HELM_FEATURES && global.HELM_FEATURES.integrationsPage === true)) {
    var pm = /^\/([a-z0-9-]{3,40})\/integrations\/?$/.exec(String(global.location.pathname || ""));
    global.location.replace(pm ? "/" + pm[1] + "/dashboard" : "/dashboard.html");
    return;
  }
  if (!global.BPStore) return;
  var run = function () { load().catch(function () { var b = global.document.getElementById("boot"); if (b) b.hidden = true; global.document.getElementById("app").hidden = false; }); };
  if (global.BPUI && typeof global.BPUI.boot === "function") global.BPUI.boot(load); else run();
})(typeof window !== "undefined" ? window : globalThis);
