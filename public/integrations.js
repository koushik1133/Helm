/* integrations.js — /<studio>/integrations (0134). Read-only status cards for Email invites,
   WhatsApp and Razorpay; the setup guides are static markup in integrations.html.
   Status comes from BPStore.integrations.overview() (integrations_overview, Control Center
   view only) plus the app's live-channel flags in config.js. CSP-safe: textContent only,
   no inline styles, no HTML strings. Pure helpers exported for tests (HelmIntegrations). */
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

  // ---- pure: one {state, label, meta} per card. state: on | wait | off ----
  function emailStatus(ov) {
    var e = ov && ov.email;
    if (!ov || !ov.has_invite_mailer || !e) return { state: "off", label: "Not switched on yet", meta: "Invites still work: copy the Join link and share it. Helm will switch e-mail on (see the steps below)." };
    var sent = n(e.sent_30d), skipped = n(e.skipped_30d), failed = n(e.failed_30d), pending = n(e.pending);
    if (sent > 0) return { state: "on", label: "On – sent by Helm", meta: sent + " invite e-mail" + (sent === 1 ? "" : "s") + " sent in the last 30 days" + (failed ? ", " + failed + " could not be delivered" : "") + "." };
    if (skipped > 0 || failed > 0) return { state: "wait", label: "Waiting for Helm", meta: "Invites were queued but e-mail is not switched on yet. Copy the Join link and share it for now." };
    if (pending > 0) return { state: "wait", label: "Sending…", meta: pending + " invite e-mail" + (pending === 1 ? " is" : "s are") + " waiting to go out (usually within 2 minutes)." };
    return { state: "on", label: "Ready", meta: "No invites sent yet. The next invite you create is e-mailed automatically." };
  }
  function whatsappStatus(ov, live) {
    var num = ov && showPhone(ov.studio_whatsapp);
    var acct = ov && ov.whatsapp && ov.whatsapp.status;
    if (live && num) return { state: "on", label: "Connected", meta: "Messages go out from Helm's WhatsApp number on behalf of your studio. Your studio number: " + num + "." };
    if (num) return { state: "wait", label: "Number saved – waiting for Helm", meta: "Your studio number " + num + " is saved. Helm is still switching WhatsApp on; nothing is sent yet." };
    if (acct === "pending") return { state: "wait", label: "Waiting for Helm to verify", meta: "Your WhatsApp details are saved. Helm checks them before any message is sent." };
    return { state: "off", label: "Not connected", meta: live ? "Add your studio WhatsApp number in Control Center to start." : "Not switched on yet. Follow the steps below; nothing is sent until it is." };
  }
  function razorpayStatus(ov, live) {
    var r = ov && ov.razorpay;
    if (r && r.status === "connected" && live) return { state: "on", label: "Connected" + (r.mode === "live" ? "" : " (test mode)"), meta: "Payment links on your events collect money into your Razorpay account." };
    if (r && (r.status === "pending" || r.status === "connected")) return { state: "wait", label: "Waiting for Helm to verify", meta: "Your keys are saved. Helm checks them in test mode before any client sees a payment link." };
    if (r && r.status === "error") return { state: "off", label: "Needs attention", meta: "Helm could not verify your Razorpay keys. Contact Helm support." };
    return { state: "off", label: "Not connected", meta: "Record payments by hand on each event for now." };
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
      // server older than 0134: still show the guides, gate on Control Center view
      try { denied = !(await S.auth.canView("controls")); } catch (e) { denied = false; }
    }
    if (denied) { doc.getElementById("noaccess").hidden = false; return; }
    var live = liveFlags();
    paint(doc, "itgEmail", emailStatus(ov));
    paint(doc, "itgWa", whatsappStatus(ov, live.whatsapp));
    paint(doc, "itgPay", razorpayStatus(ov, live.pay));
    doc.getElementById("app").hidden = false;
    // open the guide the user came for (#whatsapp / #email / #payments)
    var h = String(global.location.hash || "").slice(1);
    var target = { whatsapp: "itgWa", email: "itgEmail", payments: "itgPay" }[h];
    if (target) { var sec = doc.getElementById(target), d = sec && sec.querySelector("details"); if (d) d.open = true; try { sec.scrollIntoView({ block: "start" }); } catch (e) {} }
  }

  var api = { emailStatus: emailStatus, whatsappStatus: whatsappStatus, razorpayStatus: razorpayStatus, showPhone: showPhone };
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
