/* wa-proposal.js - 0151 studio "Send on WhatsApp" for the proposal share area.
 * Sends through ONE Helm Events WhatsApp number (Meta Cloud API) via BPStore.approval.waSend.
 * Simulated (nothing sent) until the owner adds the Meta secrets + flips liveChannels.whatsapp.
 * The number is ALWAYS the client mobile on the quote (E.164-checked here and again in the DB).
 * Needs "Client agreed to receive WhatsApp updates" ticked (stored with who / when).
 * CSP-safe: DOM built with createElement / textContent, no inline styles or handlers. */
(function () {
  "use strict";
  var OPT_TEXT = "Client agreed to receive WhatsApp updates about this event from Helm Events on behalf of the studio.";
  var LABEL = { simulated: "Simulated", queued: "Sending", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed" };

  // "+919876543210" from whatever was typed (country-aware, like the wa.me link), or ""
  function e164(raw, cc) {
    var S = window.BPStore, d = S && S.waNumber ? S.waNumber(raw, cc) : String(raw || "").replace(/\D/g, "");
    return /^[1-9][0-9]{7,14}$/.test(d) ? "+" + d : "";
  }
  function pickKind(approval, state) {
    if (approval === "paid") return "payment_received";
    if (approval === "approved") return "proposal_approved_pay";
    return state && state.status && state.template && /^proposal_(sent|reminder)$/.test(state.template) ? "proposal_reminder" : "proposal_sent";
  }
  var KIND_BTN = { proposal_sent: "Send on WhatsApp", proposal_reminder: "Send reminder on WhatsApp",
                   proposal_approved_pay: "Send payment link on WhatsApp", payment_received: "Send receipt on WhatsApp" };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function mount(host, opts) {
    if (!host || !opts || !opts.quoteId) return null;
    var S = window.BPStore, U = window.BPUI;
    var box = el("div", "wap-box"); box.setAttribute("data-wa-proposal", "1");
    var head = el("div", "wap-head");
    head.appendChild(el("b", null, "WhatsApp (Helm Events number)"));
    var chip = el("span", "wap-chip", ""); chip.hidden = true; chip.setAttribute("aria-live", "polite"); head.appendChild(chip);
    box.appendChild(head);
    var to = el("div", "wap-to muted"); box.appendChild(to);
    var lab = el("label", "wap-opt"); var cb = el("input"); cb.type = "checkbox"; cb.id = "wapOptIn";
    lab.appendChild(cb); lab.appendChild(el("span", null, "Client agreed to receive WhatsApp updates")); box.appendChild(lab);
    var optNote = el("div", "wap-note muted"); optNote.hidden = true; box.appendChild(optNote);
    var btn = el("button", "btn sm primary", "Send on WhatsApp"); btn.type = "button"; btn.id = "wapSend"; box.appendChild(btn);
    var msg = el("div", "wap-msg"); msg.setAttribute("role", "status"); box.appendChild(msg);
    host.appendChild(box);

    var state = null, phone = "";
    function setChip(s) { var l = LABEL[s] || ""; chip.hidden = !l; chip.textContent = l; chip.className = "wap-chip" + (l ? " wap-" + s : ""); }
    function refreshTo() {
      phone = e164(opts.getPhone ? opts.getPhone() : "", opts.country);
      to.textContent = phone ? "To the client mobile on the quote: " + phone : "Add a valid client mobile number (with country code) in step 1 to send on WhatsApp.";
      btn.disabled = !phone;
      btn.textContent = KIND_BTN[pickKind(opts.getApproval ? opts.getApproval() : "", state)];
    }
    function paintState(st) {
      state = st;
      if (st && st.status) setChip(st.status);
      if (st && st.opted_in && st.phone && st.phone === phone) {
        cb.checked = true; cb.disabled = true;
        optNote.hidden = false;
        optNote.textContent = "Opt-in recorded by " + (st.opted_in_by || "a studio member") + (st.opted_in_at ? " on " + (S.fmtDateTime ? S.fmtDateTime(new Date(st.opted_in_at)) : st.opted_in_at) : "") + ".";
      }
      refreshTo();
    }
    function load() { return S.approval.waState(opts.quoteId).then(paintState).catch(function () { refreshTo(); }); }

    btn.addEventListener("click", function () {
      msg.textContent = "";
      refreshTo();
      if (!phone) return;
      var already = !!(state && state.opted_in && state.phone === phone);
      if (!cb.checked && !already) { msg.textContent = "Tick “Client agreed to receive WhatsApp updates” first."; cb.focus(); return; }
      var kind = pickKind(opts.getApproval ? opts.getApproval() : "", state);
      var run = function () {
        return S.approval.waSend(opts.quoteId, kind, phone, cb.checked && !already, OPT_TEXT).then(function (r) {
          var st = (r && r.status) || (r && r.simulated ? "simulated" : "sent");
          setChip(st);
          msg.textContent = st === "simulated"
            ? "Simulated: nothing was sent. WhatsApp goes live once the Helm Events number is connected. Use Copy link or the manual WhatsApp button meanwhile."
            : "Sent from the Helm Events WhatsApp number.";
          return load();
        }).catch(function (e) { setChip("failed"); msg.textContent = U && U.friendlyError ? U.friendlyError(e, { action: "send on WhatsApp" }) : String((e && e.message) || e); });
      };
      return U && U.guard ? U.guard(btn, run) : run();
    });
    cb.addEventListener("change", function () { msg.textContent = ""; });
    refreshTo(); load();
    return { refresh: load };
  }

  window.HelmWaProposal = { mount: mount, e164: e164, pickKind: pickKind, OPT_TEXT: OPT_TEXT };
})();
