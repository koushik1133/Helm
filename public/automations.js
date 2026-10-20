/* automations.js - r24 (0269) Control Center -> Automations.
   1. One list of everything Helm does by itself, in plain words: what it does, where it acts, on / off, and a
      "Settings" link to the place that already holds its details. The switches call the SAME settings RPCs as those
      cards (no logic is copied here); a feature whose SQL is not installed yet shows "Not set up yet".
   2. "Run-sheet reminders" card: on / off, the default reminder times (each run-sheet line can change its own),
      e-mail / WhatsApp.
   3. "Enquiry form" card: on / off, the studio's public link (/<studio>/enquiry) to copy or open, the instant
      thank-you e-mail and its words, and the bell for new enquiries.
   Reads / writes only through BPStore (automation, comms, deliveries). Changes need Control Center edit (checked in the
   database too). DOM API only (no HTML strings). */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var doc = document, started = false;
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function errText(e, action) { return (global.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: action }) : String((e && e.message) || e); }
  function chk(id, label, on) { var i = h("input", { type: "checkbox", id: id }); i.checked = !!on; return { input: i, el: h("label", { cls: "au-chk", for: id }, [i, " " + label]) }; }
  var TIMES = [[120, "2 hours"], [60, "1 hour"], [30, "30 min"], [15, "15 min"], [10, "10 min"], [5, "5 min"], [0, "At the start"]];
  function offText(a) {
    a = (Array.isArray(a) ? a : []).slice().sort(function (x, y) { return y - x; });
    return a.map(function (m) { return m === 0 ? "at the start" : m % 60 === 0 ? (m / 60) + (m === 60 ? " hour" : " hours") + " before" : m + " min before"; }).join(" + ");
  }

  /* ---- the registry: each automation = how to read its on / off and how to switch it (existing RPCs only) ---- */
  function registry(S, A) {
    var C = S.comms, D = S.deliveries;
    var comms = null;
    var getComms = function () { if (!comms) comms = C && C.get ? C.get() : Promise.resolve(null); return comms; };
    // switching a client message on with no channel picked yet: e-mail is chosen (the same field as on its card)
    var commsSet = function (key, chans) { return function (on, cur) {
      var p = {}; p[key] = on; if (on && chans && !(cur && Array.isArray(cur[chans]) && cur[chans].length)) p[chans] = ["email"];
      comms = null; return C.set(p);
    }; };
    var opt = function (fn) { return function () { return A.optional(fn, {}); }; };
    return [
      { key: "event", name: "Event reminders", what: "Reminds your team before each event.", where: "Bell for the team · dashboard",
        hash: "#reminders", read: function () { return C && C.reminderGet ? C.reminderGet() : null; },
        status: function (r) { return r ? { always: true, text: "Always on · " + (r.days || 7) + " days before" } : null; } },
      { key: "delivery", name: "Delivery & arrival reminders", what: "Reminds a vendor or staff member before a delivery or arrival is due, and tracks their reply.",
        where: "E-mail to the vendor / staff · event chat · bell", hash: "#notifications",
        read: function () { return D && D.settings ? D.settings() : null; },
        status: function (r) { return r ? { on: !!r.enabled } : null; }, set: function (on) { return D.saveSettings({ enabled: on }); } },
      { key: "runsheet", name: "Run-sheet reminders", what: "Reminds the owner of each run-sheet line before it starts.",
        where: "Bell + e-mail for team members · WhatsApp + e-mail for staff and vendors · event group (when ticked)", card: "rsrCard",
        read: function () { return A.settings(); },
        status: function (r) { return r ? { on: !!r.runsheet_enabled, text: offText(r.runsheet_offsets) } : null; },
        set: function (on) { return A.save({ runsheet_enabled: on }); } },
      { key: "pay", name: "Payment reminders", what: "Reminds clients before and after a payment is due.", where: "E-mail / WhatsApp to the client",
        hash: "#reminders", read: getComms, status: function (r) { return r ? { on: !!r.pay_enabled } : null; }, set: commsSet("pay_enabled", "pay_channels") },
      { key: "overdue", name: "Overdue payment alert", what: "Tells your team in the bell when a client payment is overdue.", where: "Bell for the team",
        hash: "#payment-schedules", read: opt("payment_schedule_settings_get"),
        status: function (r) { return r && typeof r.overdue_bell === "boolean" ? { on: r.overdue_bell } : null; },
        set: function (on) { return A.optional("payment_schedule_settings_set", { p: { overdue_bell: on } }); } },
      { key: "followup", name: "Client follow-ups", what: "Follows up when a client opened their quote or booklet but has not approved.", where: "E-mail / WhatsApp to the client",
        hash: "#reminders", read: getComms, status: function (r) { return r ? { on: !!r.fu_enabled } : null; }, set: commsSet("fu_enabled", "fu_channels") },
      { key: "viewed", name: "Viewed but not approved", what: "Tells the event owner when a client viewed the quote but has not approved after a few days.",
        where: "Bell + a task for the event owner", hash: "#notifications", read: opt("link_view_settings_get"),
        status: function (r) { return r && typeof r.followup_enabled === "boolean" ? { on: r.followup_enabled } : null; },
        set: function (on) { return A.optional("link_view_settings_set", { p: { followup_enabled: on } }); } },
      { key: "expiry", name: "Quote expiry", what: "Each quote stays valid for a set number of days; the client and your team are reminded before it ends.",
        where: "Quote · client link · bell", hash: "#client-links", read: opt("quote_validity_settings_get"),
        status: function (r) { return r && typeof r.enabled === "boolean" ? { on: r.enabled, text: r.default_days ? r.default_days + " days" : "" } : null; },
        set: function (on) { return A.optional("quote_validity_settings_set", { p: { enabled: on } }); } },
      { key: "stock", name: "Low stock warnings", what: "Warns when events on the same date need more of an item than you own.", where: "Bell for the team",
        hash: "#reminders", read: getComms, status: function (r) { return r ? { on: r.low_stock_enabled !== false } : null; }, set: commsSet("low_stock_enabled") },
      { key: "digest", name: "E-mail digests", what: "Sends each person one e-mail a day with the notifications they missed.", where: "E-mail to your team",
        hash: "#notifications", read: opt("admin_get_inbox_settings"),
        status: function (r) { return r && typeof r.digest_default === "string" ? { on: r.digest_default !== "off" } : null; },
        set: function (on) { return A.optional("admin_set_inbox_settings", { p: { digest_default: on ? "daily" : "off" } }); } },
      { key: "enquiry", name: "Enquiry form → Leads", what: "Every enquiry from your public form becomes a lead, with an instant thank-you e-mail.",
        where: "Your public link · Leads · bell", card: "enqCard", read: function () { return A.settings(); },
        status: function (r) { return r ? { on: !!r.enquiry_enabled } : null; }, set: function (on) { return A.save({ enquiry_enabled: on }); } },
      { key: "quoteLead", name: "Quotes → Leads", what: "Every quote with a client name is added to Leads automatically and moves along with it.",
        where: "Leads", href: "leads.html", read: function () { return Promise.resolve({}); }, status: function () { return { always: true, text: "Always on" }; } }
    ];
  }

  function rowEl(it, canEdit, refreshAll) {
    var sw = h("input", { type: "checkbox", cls: "au-sw", role: "switch", "aria-label": it.name + " on or off" });
    var state = h("span", { cls: "au-state", text: "Checking…" });
    var link = it.card ? h("button", { type: "button", cls: "btn sm au-go", text: "Settings" })
      : it.href ? h("a", { cls: "btn sm au-go", href: it.href, text: "Open Leads" })
      : h("a", { cls: "btn sm au-go", href: it.hash, text: "Settings" });
    if (it.card) link.addEventListener("click", function () { var c = doc.getElementById(it.card); if (c) { try { c.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) { c.scrollIntoView(); } } });
    var row = h("li", { cls: "au-row", "data-auto": it.key }, [
      h("div", { cls: "au-txt" }, [h("b", { text: it.name }), h("span", { cls: "au-what", text: it.what }), h("span", { cls: "au-where", text: "Where: " + it.where })]),
      h("div", { cls: "au-ctl" }, [state, sw, link])
    ]);
    sw.hidden = true;
    var cur = null;
    function paint(st, raw) {
      cur = raw;
      if (!st) { state.textContent = "Not set up yet"; state.className = "au-state au-na"; sw.hidden = true; link.hidden = !!it.hash && it.key !== "event"; row.classList.add("au-dim"); return; }
      row.classList.remove("au-dim"); link.hidden = false;
      if (st.always) { state.textContent = st.text || "Always on"; state.className = "au-state au-on"; sw.hidden = true; return; }
      state.textContent = (st.on ? "On" : "Off") + (st.on && st.text ? " · " + st.text : ""); state.className = "au-state " + (st.on ? "au-on" : "au-off");
      sw.checked = !!st.on; sw.hidden = !it.set; sw.disabled = !canEdit;
    }
    function load() {
      return Promise.resolve().then(function () { return it.read(); }).then(function (r) { paint(it.status(r), r); }, function () { paint(null, null); });
    }
    sw.addEventListener("change", function () {
      var on = sw.checked; sw.disabled = true; state.textContent = "Saving…";
      Promise.resolve().then(function () { return it.set(on, cur); })
        .then(function () {
          var mirror = { runsheet: "au_rs_on", enquiry: "au_eq_on" }[it.key], x = mirror && doc.getElementById(mirror); if (x) x.checked = on;
          return refreshAll ? refreshAll(it.key) : load();
        }, function (e) {
          sw.checked = !on; state.textContent = errText(e, "change this automation"); state.className = "au-state au-err";
        })
        .then(function () { sw.disabled = !canEdit; });
    });
    return { el: row, load: load, key: it.key };
  }

  function overview(card, S, A, canEdit) {
    var rows = registry(S, A).map(function (it) { return rowEl(it, canEdit, null); });
    var list = h("ul", { cls: "au-list" }, rows.map(function (r) { return r.el; }));
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(h("h3", { text: "Automations" }));
    card.appendChild(h("p", { cls: "mnote", text: "Everything Helm does by itself, in one list. Switch each one on or off here; “Settings” opens its details. E-mail and WhatsApp messages wait in a queue until sending is switched on for your studio." }));
    if (!canEdit) card.appendChild(h("p", { cls: "mnote", text: "Only people who can edit Control Center can switch these on or off." }));
    card.appendChild(list);
    card.hidden = false;
    var refresh = function () { return Promise.all(rows.map(function (r) { return r.load(); })); };
    rows.forEach(function (r) { r.load(); });
    return refresh;
  }

  function runsheetCard(card, A, cfg, canEdit, onSaved) {
    var on = chk("au_rs_on", "Remind the owner of each run-sheet line before it starts", cfg.runsheet_enabled);
    var picked = (cfg.runsheet_offsets || [15, 0]).slice();
    var chips = h("div", { cls: "au-chips", role: "group", "aria-label": "Default reminder times" });
    TIMES.forEach(function (t) {
      var b = h("button", { type: "button", cls: "au-chip", "aria-pressed": picked.indexOf(t[0]) >= 0 ? "true" : "false", text: t[0] === 0 ? t[1] : t[1] + " before" });
      b.addEventListener("click", function () {
        var i = picked.indexOf(t[0]);
        if (i >= 0) picked.splice(i, 1); else if (picked.length < 4) picked.push(t[0]); else { msg.textContent = "Pick up to 4 reminder times."; return; }
        b.setAttribute("aria-pressed", i >= 0 ? "false" : "true"); msg.textContent = "";
      });
      chips.appendChild(b);
    });
    var em = chk("au_rs_email", "Send e-mail reminders", cfg.runsheet_email);
    var wa = chk("au_rs_wa", "Send WhatsApp reminders to staff and vendors", cfg.runsheet_whatsapp);
    var msg = h("p", { cls: "mnote", role: "status", "aria-live": "polite" });
    var save = h("button", { type: "button", cls: "btn", id: "au_rs_save", text: "Save run-sheet reminders" });
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(h("h3", { text: "Run-sheet reminders" }));
    card.appendChild(h("p", { cls: "mnote", text: "On the run-sheet, pick a real person as the Owner of a line. Helm reminds them at these times before the line starts: team members in the bell and by e-mail, staff and vendors by WhatsApp (and e-mail when they have one). Each line can choose its own time or switch its reminder off." }));
    card.appendChild(on.el);
    card.appendChild(h("fieldset", { cls: "au-set" }, [h("legend", { text: "Default reminder times" }), chips]));
    card.appendChild(h("fieldset", { cls: "au-set" }, [h("legend", { text: "How" }), em.el, wa.el]));
    if (cfg.trial_no_send) card.appendChild(h("p", { cls: "mnote", text: "Free trial: reminders show in the bell and the event group only (no e-mail or WhatsApp)." }));
    card.appendChild(msg); card.appendChild(save); card.hidden = false;
    if (!canEdit) { Array.prototype.forEach.call(card.querySelectorAll("input,button"), function (x) { x.disabled = true; }); msg.textContent = "Only people who can edit Control Center can change these."; return; }
    save.addEventListener("click", function () {
      if (on.input.checked && !picked.length) { msg.textContent = "Pick at least one reminder time, or switch run-sheet reminders off."; return; }
      var patch = { runsheet_enabled: on.input.checked, runsheet_email: em.input.checked, runsheet_whatsapp: wa.input.checked };
      if (picked.length) patch.runsheet_offsets = picked.slice();
      var run = async function () {
        try { await A.save(patch); msg.textContent = "Saved. Default: " + offText(picked) + "."; if (onSaved) onSaved(); }
        catch (e) { msg.textContent = errText(e, "save the run-sheet reminders"); }
      };
      return global.BPUI && BPUI.guard ? BPUI.guard(save, run, { busyLabel: "Saving…" }) : run();
    });
  }

  function enquiryCard(card, A, cfg, canEdit, onSaved) {
    var slug = String(cfg.public_slug || "");
    var url = slug ? (location.origin + "/" + encodeURIComponent(slug) + "/enquiry") : "";
    var on = chk("au_eq_on", "Open my public enquiry form", cfg.enquiry_enabled);
    var link = h("input", { type: "text", id: "au_eq_link", readonly: true, value: url || "Set your client link name in General first", "aria-label": "Your enquiry form link" });
    var copy = h("button", { type: "button", cls: "btn sm", text: "Copy link" }), open = h("a", { cls: "btn sm", href: url || "#", target: "_blank", rel: "noopener", text: "Open" });
    if (!url) { copy.disabled = true; open.hidden = true; }
    copy.addEventListener("click", function () {
      var done = function () { msg.textContent = "Link copied. Put it on your website, Instagram or WhatsApp."; };
      try { navigator.clipboard.writeText(url).then(done, function () { link.select(); done(); }); } catch (e) { link.select(); done(); }
    });
    var rep = chk("au_eq_reply", "Send an instant thank-you e-mail", cfg.enquiry_reply);
    var txt = h("textarea", { id: "au_eq_text", rows: "3", maxlength: "600", placeholder: "Hi {name}, thank you for your enquiry with {studio}. We have your details and will get back to you shortly." });
    txt.value = cfg.enquiry_reply_text || "";
    var bell = chk("au_eq_bell", "Show new enquiries in the bell", cfg.enquiry_notify);
    var msg = h("p", { cls: "mnote", role: "status", "aria-live": "polite" });
    var save = h("button", { type: "button", cls: "btn", id: "au_eq_save", text: "Save enquiry form" });
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(h("h3", { text: "Enquiry form" }));
    card.appendChild(h("p", { cls: "mnote", text: "Share one link and every enquiry lands in Leads by itself (source “Enquiry form”, stage New). The client sees only your studio name and a short form. Off until you switch it on." }));
    card.appendChild(on.el);
    card.appendChild(h("div", { cls: "au-link" }, [link, copy, open]));
    card.appendChild(h("fieldset", { cls: "au-set" }, [h("legend", { text: "Instant reply" }), rep.el,
      h("label", { cls: "au-lbl", for: "au_eq_text", text: "Your words (leave empty for the default). You can use {name} {studio} {event}." }), txt]));
    card.appendChild(bell.el);
    if (typeof cfg.enquiries_7d === "number") card.appendChild(h("p", { cls: "mnote", text: "Enquiries in the last 7 days: " + cfg.enquiries_7d }));
    if (cfg.trial_no_send) card.appendChild(h("p", { cls: "mnote", text: "Free trial: enquiries become leads, but the thank-you e-mail is not sent." }));
    card.appendChild(msg); card.appendChild(save); card.hidden = false;
    if (!canEdit) { Array.prototype.forEach.call(card.querySelectorAll("input:not([readonly]),textarea,button:not(.btn.sm)"), function (x) { x.disabled = true; }); save.disabled = true; msg.textContent = "Only people who can edit Control Center can change these."; return; }
    save.addEventListener("click", function () {
      var t = txt.value.trim();
      if (/[<>]/.test(t)) { msg.textContent = "The reply cannot contain < or >."; return; }
      var patch = { enquiry_enabled: on.input.checked, enquiry_reply: rep.input.checked, enquiry_reply_text: t || null, enquiry_notify: bell.input.checked };
      var run = async function () {
        try { await A.save(patch); msg.textContent = on.input.checked ? "Saved. Your form is open." : "Saved. Your form is closed."; if (onSaved) onSaved(); }
        catch (e) { msg.textContent = errText(e, "save the enquiry form"); }
      };
      return global.BPUI && BPUI.guard ? BPUI.guard(save, run, { busyLabel: "Saving…" }) : run();
    });
  }

  async function init() {
    if (started) return; started = true;
    var S = global.BPStore, A = S && S.automation;
    var card = doc.getElementById("autoCard"), rs = doc.getElementById("rsrCard"), eq = doc.getElementById("enqCard");
    if (!card || !A) return;
    var cfg = null;
    try { cfg = await A.settings(); } catch (e) { cfg = null; }
    var canEdit = !!(cfg && cfg.can_manage);
    if (!cfg) {
      // before 0269: the list still shows the automations that exist; the run-sheet / enquiry cards stay hidden
      try { canEdit = !!(S.auth && S.auth.canEditArea && await S.auth.canEditArea("controls")); } catch (e) { canEdit = false; }
    }
    var refresh = overview(card, S, A, canEdit);
    if (cfg && rs) runsheetCard(rs, A, cfg, canEdit, refresh);
    if (cfg && eq) enquiryCard(eq, A, cfg, canEdit, refresh);
  }
  global.HelmAutomations = { init: init, registry: registry, offText: offText };
})(window);
