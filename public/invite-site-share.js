/* invite-site-share.js - 0195 "Send to client" on the Invitation Studio.
 * Sends the PUBLISHED invitation website link to the event's client by Email or WhatsApp through
 * BPStore.sites.send (event_site_send -> comms_outbox -> comms-dispatch, the same outbox as payment
 * reminders). The address is pre-filled from the quote and editable; the message is fixed text,
 * shown as a preview. WhatsApp needs the client's opt-in (stored with who / when); STOP is respected.
 * R114 (0323, owner decision): a FREE TRIAL is a full SIMULATION - the button becomes "Preview (trial - not sent)":
 * it shows the message the client would get and opens the client page for the studio; the server is never asked to
 * send (and refuses anyway: 0323 stores a trial send as 'skipped'). The red trial banner sits on top of the box.
 * (Before R114) FREE TRIAL (0212): e-mail WORKS in an ACTIVE trial - the link really reaches the client (capped by the server:
 * 30 a day per studio, 5 a day to one address); the WhatsApp option is HIDDEN (WhatsApp and SMS unlock on a paid
 * plan). An ended trial / owner switch off / a database without 0212 (BPStore.subscription.messaging() says
 * email false or null): test mode as before - the server stores the send as skipped and the box says so.
 * Shared (0200): the "Share booklet" dialog mounts the same box for the client booklet link with
 * adapter options (send / sendLog / ready / message / gateText / pendingPreview / logKey) - see
 * booklet-share.js. Without them it behaves exactly as the Invitation Studio box above.
 * CSP-safe: DOM built with createElement / textContent, no inline styles or handlers. */
(function () {
  "use strict";
  var OPT_TEXT = "Client agreed to receive WhatsApp messages about this event from Helm Events on behalf of the studio.";
  var TRIAL_NOTE = "Test mode — in the free trial we don't send real messages; copy the link instead.";
  // R114 (0323): the trial preview
  var SIM_NOTE = "Trial simulation — nothing is sent to your client. Preview shows the message they would get and opens their page for you.";
  var SIM_DONE = "Preview only — nothing was sent to your client (trial simulation). Their page opened in a new tab.";
  // 0212: an ACTIVE free trial - e-mail is real, WhatsApp is not offered
  var TRIAL_EMAIL_NOTE = "Free trial: the e-mail really goes to your client (up to 30 a day). WhatsApp and SMS unlock on a paid plan.";
  var TRIAL_CAP = "Not sent: the free trial e-mail limit for today is reached (30 a day, 5 to one address). Use Copy link to share it yourself.";
  var EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  var STATUS = { queued: "Queued", pending: "Queued", sent: "Sent", skipped: "Not sent", failed: "Failed" };
  // r21 email audit: a send still "Queued" after this long has not gone out (Helm's sender runs every few minutes)
  var STALE_MS = 15 * 60000;
  var STALE_NOTE = "Not sent yet: a message above has been waiting more than 15 minutes. Helm's e-mail sender may be paused — use Copy link to share it yourself, and tell your Helm admin.";
  // pure: is any queued row older than STALE_MS? (rows: [{ status, at }])
  function staleQueued(rows, now) {
    var t = typeof now === "number" ? now : Date.now();
    return (Array.isArray(rows) ? rows : []).some(function (r) {
      var st = r && r.status, at = r && Date.parse(r.at);
      return (st === "queued" || st === "pending") && isFinite(at) && t - at > STALE_MS;
    });
  }

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  // same greeting as the server (event_site_send): first 60 characters of the client name, else "there"
  function clientName(q) {
    var c = q && q.client && typeof q.client === "object" ? q.client : {};
    // r20: display only - a free-trial sample client is stored as "Demo · Ananya Reddy"; the greeting never shows the "Demo · " prefix
    var n = String(c.name || "").replace(/\s+/g, " ").trim(), o = n.replace(/^Demo\s*[\u00b7\u2022]\s*/, "").trim();
    return (o || n).slice(0, 60) || "there";
  }
  function message(q, link) { return "Hi " + clientName(q) + ", here is your invitation website: " + (link || ""); }
  function e164(raw, cc) {
    var S = window.BPStore, d = S && S.waNumber ? S.waNumber(raw, cc) : String(raw || "").replace(/\D/g, "");
    return /^[1-9][0-9]{7,14}$/.test(String(d || "")) ? "+" + d : "";
  }
  // server wording is written for people (P0001 / 22023 / caps / STOP) - show it; anything else goes through friendlyError
  function errText(e) {
    var c = e && e.code, m = e && e.message;
    if (m && /^(P0001|22023|HL429|HL451)$/.test(String(c || "")) && m.length < 300) return m;
    var U = window.BPUI;
    return U && U.friendlyError ? U.friendlyError(e, { action: "send the link" }) : String(m || "Couldn't send the link.");
  }
  function resultText(r, channel) {
    var st = r && r.status, how = channel === "whatsapp" ? "on WhatsApp" : "by email", to = (r && r.masked) ? " to " + r.masked : "";
    if (st === "queued") return "Queued — it goes out " + how + to + " within a few minutes.";
    if (st === "already_queued") return "Already queued a moment ago" + to + " — no second message was added.";
    if (st === "skipped" && r.reason === "trial_email_cap") return TRIAL_CAP;
    if (st === "skipped" && r.reason === "free_trial" && channel === "whatsapp") return "Not sent: WhatsApp unlocks on a paid plan. Send it by email or use Copy link.";
    if (st === "skipped" && r.reason === "free_trial") return "Test mode: nothing was sent (free trial). Use Copy link to share it yourself.";
    if (st === "skipped" && r.reason === "demo") return "Not sent: this is a demo event. Use Copy link to share it yourself.";
    if (st === "skipped") return "Not sent. Use Copy link to share it yourself.";
    return "Done.";
  }
  function fmtAt(v) {
    var d = new Date(v); if (isNaN(d.getTime())) return "";
    var S = window.BPStore;
    try { if (S && S.fmtDateTime) return S.fmtDateTime(d); } catch (e) {}
    return d.toLocaleString();
  }

  // opts: { getSite(), getQuote(), getLink(), country(), isDirty(), trial: Promise<boolean> }
  // shared adapters (0200 booklet): send(channel, to, optIn, consentText) -> Promise, sendLog() -> Promise<rows>,
  //   ready() -> boolean, message(quote, link) -> string, gateText, pendingPreview, logKey() -> string
  function mount(host, opts) {
    var S = window.BPStore, U = window.BPUI;
    if (!host || !opts || !S || !(opts.send || (S.sites && S.sites.send))) return null;
    var GATE = opts.gateText || "Publish first — then you can send the link to your client.";
    var box = el("div", "ish-box"); box.setAttribute("data-invite-share", "1");

    var gate = el("p", "ish-gate", GATE);
    gate.id = "ishGate"; box.appendChild(gate);

    var body = el("div", "ish-body"); body.id = "ishBody";
    var fs = el("fieldset", "ish-ch"); var lg = el("legend", null, "Send by"); fs.appendChild(lg);
    var radios = {}, radioLabs = {};
    [["email", "Email"], ["whatsapp", "WhatsApp"]].forEach(function (p) {
      var lab = el("label", "ish-radio"); radioLabs[p[0]] = lab; var r = el("input"); r.type = "radio"; r.name = "ishCh"; r.value = p[0]; r.id = "ishCh_" + p[0];
      if (p[0] === "email") r.checked = true;
      lab.appendChild(r); lab.appendChild(el("span", null, p[1])); fs.appendChild(lab); radios[p[0]] = r;
    });
    body.appendChild(fs);

    var fld = el("div", "fld");
    var toLbl = el("label", null, "Client email"); toLbl.setAttribute("for", "ishTo");
    var to = el("input"); to.id = "ishTo"; to.type = "email"; to.maxLength = 200; to.autocomplete = "off"; to.setAttribute("aria-describedby", "ishToHint");
    var hint = el("p", "mnote ish-hint", ""); hint.id = "ishToHint";
    fld.appendChild(toLbl); fld.appendChild(to); fld.appendChild(hint); body.appendChild(fld);

    var optLab = el("label", "ish-opt"); var opt = el("input"); opt.type = "checkbox"; opt.id = "ishOpt";
    optLab.appendChild(opt); optLab.appendChild(el("span", null, "Client agreed to receive WhatsApp messages about this event")); optLab.hidden = true;
    body.appendChild(optLab);

    var pvLbl = el("div", "ish-pv-lbl", "Message preview"); pvLbl.id = "ishPvLbl";
    var pv = el("div", "ish-pv"); pv.id = "ishPreview"; pv.setAttribute("aria-labelledby", "ishPvLbl");
    body.appendChild(pvLbl); body.appendChild(pv);

    var trial = el("p", "ish-trial", TRIAL_NOTE); trial.id = "ishTrial"; trial.hidden = true; trial.setAttribute("role", "note");
    body.appendChild(trial);
    var dirtyNote = el("p", "mnote ish-dirty", "You have unsaved changes — the client sees the last published version until you publish again.");
    dirtyNote.hidden = true; body.appendChild(dirtyNote);

    var row = el("div", "ish-row");
    var send = el("button", "btn primary", "Send by email"); send.type = "button"; send.id = "ishSend";
    row.appendChild(send); body.appendChild(row);
    var msg = el("div", "ish-msg"); msg.id = "ishMsg"; msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    body.appendChild(msg);
    var logH = el("div", "ish-log-h", "Send history"); logH.hidden = true;   // qa-quote-flow B28: the log also lists "Not sent" (test mode) rows
    var log = el("ul", "ish-log"); log.id = "ishLog"; log.hidden = true;
    var stale = el("p", "mnote ish-stale", STALE_NOTE); stale.hidden = true; stale.setAttribute("role", "note");
    body.appendChild(logH); body.appendChild(log); body.appendChild(stale);
    box.appendChild(body);
    host.appendChild(box);
    // these fields are not part of the invitation: keep them out of the editor's "unsaved changes" tracking
    ["input", "change"].forEach(function (t) { box.addEventListener(t, function (e) { e.stopPropagation(); }); });

    // isTrial: test mode (nothing reaches the client); trialEmail (0212): active trial, e-mail real, no WhatsApp
    var typed = { email: null, whatsapp: null }, isTrial = false, trialEmail = false, loadedFor = null;
    function channel() { return radios.whatsapp.checked ? "whatsapp" : "email"; }
    function quoteTo(ch) {
      var q = opts.getQuote ? opts.getQuote() : null, c = q && q.client && typeof q.client === "object" ? q.client : {};
      if (ch === "email") return String(c.email || "").trim();
      return e164(c.phone || c.whatsapp || "", opts.country ? opts.country() : "IN") || String(c.phone || "").trim();
    }
    function published() {
      if (opts.ready) return !!(opts.ready() && opts.getLink && opts.getLink());
      var s = opts.getSite ? opts.getSite() : null; return !!(s && s.id && s.status === "published" && opts.getLink && opts.getLink());
    }
    function logKey() { if (opts.logKey) return opts.logKey(); var s = opts.getSite ? opts.getSite() : null; return s && s.id; }
    function valid(ch, v) { return ch === "email" ? EMAIL_RE.test(v) : !!e164(v, opts.country ? opts.country() : "IN"); }

    function paint() {
      // 0212: the WhatsApp option is hidden in an active free trial (e-mail only)
      radioLabs.whatsapp.hidden = trialEmail && !isTrial;
      if (radioLabs.whatsapp.hidden && radios.whatsapp.checked) { radios.whatsapp.checked = false; radios.email.checked = true; }
      var ch = channel(), pub = published();
      gate.hidden = pub; body.hidden = false;
      fs.disabled = !pub; to.disabled = !pub; opt.disabled = !pub;
      var v = typed[ch] != null ? typed[ch] : quoteTo(ch);
      if (to.value !== v && document.activeElement !== to) to.value = v;
      toLbl.textContent = ch === "email" ? "Client email" : "Client WhatsApp number";
      to.type = ch === "email" ? "email" : "tel";
      to.placeholder = ch === "email" ? "client@example.com" : "+91 98765 43210";
      hint.textContent = typed[ch] != null && typed[ch] !== quoteTo(ch) ? "Changed here only — the quote keeps its own details."
        : quoteTo(ch) ? "From the quote — you can change it." : (ch === "email" ? "No email on the quote — type one." : "No mobile number on the quote — type one with the country code.");
      optLab.hidden = ch !== "whatsapp";
      var q0 = opts.getQuote ? opts.getQuote() : null;
      pv.textContent = pub ? (opts.message || message)(q0, opts.getLink())
        : (opts.pendingPreview || ("Hi " + clientName(q0) + ", here is your invitation website: (link appears after you publish)"));
      trial.hidden = !(isTrial || trialEmail);
      trial.textContent = isTrial ? SIM_NOTE : trialEmail ? TRIAL_EMAIL_NOTE : TRIAL_NOTE;
      dirtyNote.hidden = !(pub && opts.isDirty && opts.isDirty());
      send.textContent = isTrial ? "Preview (trial \u2014 not sent)" : (ch === "whatsapp" ? "Send on WhatsApp" : "Send by email");
      if (isTrial) { try { if (window.HelmTrialSim && window.HelmTrialSim.banner) window.HelmTrialSim.banner(box); } catch (x) {} }
      var ok = pub && (isTrial || valid(ch, String(to.value || "").trim()));
      send.disabled = !ok; if (!ok) send.setAttribute("aria-disabled", "true"); else send.removeAttribute("aria-disabled");
      var k = logKey();
      if (pub && k && loadedFor !== k) { loadedFor = k; loadLog(); }
    }
    function paintLog(rows) {
      while (log.firstChild) log.removeChild(log.firstChild);
      var list = Array.isArray(rows) ? rows : [];
      list.forEach(function (r) {
        var li = el("li", "ish-li");
        li.appendChild(el("span", "ish-when", fmtAt(r.at)));
        li.appendChild(el("span", null, (r.channel === "whatsapp" ? "WhatsApp" : "Email") + " · " + String(r.to || "")));
        var label = STATUS[r.status] || String(r.status || "");
        if (staleQueued([r])) label = "Queued — not sent yet";
        var st = el("span", "ish-st ish-" + String(r.status || "").replace(/[^a-z]/g, ""), label);
        li.appendChild(st); log.appendChild(li);
      });
      log.hidden = logH.hidden = !list.length;
      stale.hidden = !staleQueued(list);
    }
    function loadLog() {
      if (opts.sendLog) return Promise.resolve().then(opts.sendLog).then(paintLog).catch(function () {});
      var s = opts.getSite ? opts.getSite() : null;
      if (!s || !s.id || !S.sites || !S.sites.sendLog) return Promise.resolve();
      return S.sites.sendLog(s.id).then(paintLog).catch(function () {});
    }

    Object.keys(radios).forEach(function (k) { radios[k].addEventListener("change", function () { msg.textContent = ""; paint(); }); });
    to.addEventListener("input", function () { typed[channel()] = to.value; msg.textContent = ""; paint(); });
    opt.addEventListener("change", function () { msg.textContent = ""; });
    send.addEventListener("click", function () {
      msg.textContent = "";
      var ch = channel(), v = String(to.value || "").trim(), s = opts.getSite ? opts.getSite() : null;
      if (!published() || (!opts.send && !s)) { msg.textContent = GATE; return; }
      // R114 (0323): a trial previews - the message the client would get + their page for the studio; NOTHING is sent
      if (isTrial) {
        var TS = window.HelmTrialSim, link = opts.getLink ? String(opts.getLink() || "") : "";
        if (TS && TS.preview) TS.preview(body, { subject: "", text: pv.textContent });
        if (/^https?:\/\//i.test(link)) { try { window.open(link.split("#")[0] + "#preview", "_blank", "noopener,noreferrer"); } catch (x) {} }
        msg.textContent = SIM_DONE;
        return;
      }
      if (!valid(ch, v)) { msg.textContent = ch === "email" ? "Enter a valid email address." : "Enter a valid mobile number with the country code."; to.focus(); return; }
      var addr = ch === "whatsapp" ? e164(v, opts.country ? opts.country() : "IN") : v;
      var run = function () {
        var go = opts.send ? opts.send(ch, addr, ch === "whatsapp" && opt.checked, OPT_TEXT)
          : S.sites.send(s.id, ch, addr, ch === "whatsapp" && opt.checked, OPT_TEXT);
        return Promise.resolve(go).then(function (r) {
          msg.textContent = resultText(r, ch);
          if (r && r.status === "queued" && U && U.toast) U.toast(msg.textContent, { type: "ok" });
          return loadLog();
        }).catch(function (e) {
          msg.textContent = errText(e);
          if (e && e.hint === "opt_in") opt.focus();
        });
      };
      return U && U.guard ? U.guard(send, run) : run();
    });

    // trial: 0212 my_trial_messaging (e-mail real in an active trial) wins; before 0212 (null) opts.trial = test mode
    var sub = S.subscription || {};
    Promise.all([Promise.resolve(opts.trial).catch(function () { return false; }),
                 Promise.resolve(sub.messaging ? sub.messaging() : null).catch(function () { return null; })]).then(function (a) {
      var m = a[1];
      if (m && typeof m === "object" && typeof m.trial === "boolean") {
        // R114 (0323): any free trial is a simulation (an older database may still say email:true - never sent)
        trialEmail = false;
        isTrial = m.trial === true;
      } else { isTrial = a[0] === true; trialEmail = false; }
      paint();
    }, function () {});
    paint();
    return { refresh: paint, reloadLog: loadLog };
  }

  window.HelmInviteShare = { mount: mount, message: message, clientName: clientName, resultText: resultText, OPT_TEXT: OPT_TEXT, TRIAL_NOTE: TRIAL_NOTE,
    TRIAL_EMAIL_NOTE: TRIAL_EMAIL_NOTE, TRIAL_CAP: TRIAL_CAP, SIM_NOTE: SIM_NOTE, SIM_DONE: SIM_DONE, staleQueued: staleQueued, STALE_NOTE: STALE_NOTE };
  window.HelmSendToClient = window.HelmInviteShare;   // shared name (booklet dialog, 0200)
})();
