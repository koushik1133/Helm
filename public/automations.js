/* automations.js - Control Center -> Automations (r24 0269, r25 0274).
   1. THE ONE PLACE to switch automations on or off. Every automation that sends something by itself (e-mail /
      WhatsApp to clients, vendors or crew, an e-mail digest or a scheduled bell reminder for the team) is listed in
      plain words with a "Sends to" tag and ONE switch. Everything starts OFF (0274); switching one on asks first
      ("This will e-mail your clients..."). Switching off never asks. The switch calls automation_switch(key, on) -
      Control Center edit, checked and logged in the database. Each feature's own card keeps its details (times,
      words, channels) but no longer has its own on / off - it links here.
   2. "Run-sheet reminders" card: the default reminder times + e-mail / WhatsApp (on / off is in the list).
   3. "Enquiry form" card: the studio's public link, the instant thank-you e-mail and its words, the bell.
   Reads / writes only through BPStore.automation. DOM API only (no HTML strings). */
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
  function daysText(a) {
    a = (Array.isArray(a) ? a : []).slice().sort(function (x, y) { return y - x; });
    if (!a.length) return "";
    return a.map(function (d) { return d === 0 ? "on the last day" : d + (d === 1 ? " day" : " days"); }).join(" and ") + " before";
  }
  var SENDS = { clients: "Clients", team: "Team", vendors: "Vendors", crew: "Staff", nothing: "Sends nothing" };

  /* ---- the list: key = the database key (automation_switch); sends = who gets something; ask = the confirm text ---- */
  var GROUPS = [
    ["clients", "Messages to your clients"],
    ["team", "Reminders and alerts for your team"],
    ["outside", "Messages to vendors and staff"],
    ["nothing", "Helps by itself, sends nothing"]
  ];
  function registry() {
    return [
      { key: "pay_reminders", group: "clients", name: "Payment reminders", sends: ["clients"], how: "E-mail / WhatsApp",
        what: "Reminds a client before, on and after each payment is due. Stops as soon as it is paid.", hash: "#reminders",
        ask: "This will e-mail (or WhatsApp) your clients before, on and after each payment is due.",
        detail: function (d) { var p = d.pay || {}; if (p.before_days == null) return "";
          return p.before_days + " days before" + (p.on_due ? " · on the day" : "") + (p.max_overdue ? " · up to " + p.max_overdue + " after" : ""); } },
      { key: "client_followups", group: "clients", name: "Client follow-ups", sends: ["clients"], how: "E-mail / WhatsApp",
        what: "Follows up when a client opened their quote or booklet but has not approved yet.", hash: "#reminders",
        ask: "This will message your clients a few days after they open their quote, until they approve.",
        detail: function (d) { var f = d.followups || {}; return f.delay_days ? f.delay_days + " days after they open it · up to " + (f.max || 1) : ""; } },
      { key: "quote_expiry_client", group: "clients", name: "Quote expiry reminder", sends: ["clients"], how: "E-mail",
        what: "E-mails the client a few days before their quote stops being valid.", hash: "#client-links",
        ask: "This will e-mail your clients before their quote expires.",
        detail: function (d) { var q = d.quote_validity || {}; return q.enabled === false ? "Quote validity is off" : daysText(q.reminder_days); } },
      { key: "enquiry", group: "clients", name: "Enquiry form → Leads", sends: ["clients"], how: "E-mail",
        what: "Opens your public enquiry form. Every enquiry becomes a lead and gets an instant thank-you e-mail.", card: "enqCard",
        ask: "This will open your public enquiry form and e-mail a thank-you to everyone who fills it in." },
      { key: "viewed_alert", group: "team", name: "Viewed but not approved", sends: ["team"], how: "Bell",
        what: "Tells the event owner when a client opened the quote but has not approved after a few days.", hash: "#notifications",
        ask: "This will tell the event owner in the bell when a client viewed a quote but has not approved.",
        detail: function (d) { return d.viewed_days ? d.viewed_days + " days after they open it" : ""; } },
      { key: "quote_expiry_team", group: "team", name: "Quote expiry alert", sends: ["team"], how: "Bell",
        what: "Tells your team in the bell before a quote expires, and the day after it expired.", hash: "#client-links",
        ask: "This will tell your team in the bell before a quote expires." },
      { key: "overdue_bell", group: "team", name: "Overdue payment alert", sends: ["team"], how: "Bell",
        what: "Tells your team in the bell when a client payment is overdue.", hash: "#payment-schedules",
        ask: "This will tell your team in the bell the day after a client payment was due and not paid." },
      { key: "low_stock", group: "team", name: "Low stock warnings", sends: ["team"], how: "Bell",
        what: "Warns when events on the same date need more of an item than you own.", hash: "#reminders",
        ask: "This will warn your team in the bell when events on the same date need more of an item than you own." },
      { key: "event_reminders", group: "team", name: "Event reminders", sends: ["team"], how: "Bell + event chat",
        what: "Reminds your team before each confirmed event, and again the day before.", hash: "#reminders",
        ask: "This will remind your whole team in the bell and the event chat before every confirmed event.",
        detail: function (d) { return d.event_days ? d.event_days + " days before + the day before" : ""; } },
      { key: "inbox_email", group: "team", name: "E-mail of missed notifications", sends: ["team"], how: "E-mail",
        what: "E-mails each team member the notifications they have not read - once a day, or instantly for important ones. Each person can change their own.", hash: "#notifications",
        ask: "This will e-mail your team members about notifications they have not read (once a day unless they choose otherwise).",
        detail: function (d) { var i = d.inbox || {}; return i.digest_default === "instant_important" ? "instant, important only" : i.digest_default === "daily" ? "daily at " + (i.digest_hour == null ? 8 : i.digest_hour) + ":00" : ""; } },
      { key: "wa_forward", group: "team", name: "WhatsApp copies of notifications", sends: ["team"], how: "WhatsApp",
        what: "Team members who opt in on their profile get their bell notifications on WhatsApp.", hash: "#reminders",
        ask: "This will send a WhatsApp copy of bell notifications to every team member who opted in.",
        detail: function (d) { return d.studio_whatsapp ? "" : "add your studio WhatsApp number first"; } },
      { key: "vendor_reminders", group: "outside", name: "Vendor request reminders", sends: ["vendors"], how: "E-mail / WhatsApp",
        what: "Reminds a vendor 24 and 48 hours after a request they have not answered yet.",
        ask: "This will e-mail (or WhatsApp) your vendors again when they have not answered a request." },
      { key: "delivery", group: "outside", name: "Delivery & arrival reminders", sends: ["vendors", "crew"], how: "E-mail · event chat · bell",
        what: "Reminds a vendor or staff member before a delivery or arrival is due, and tracks their reply.", hash: "#notifications",
        ask: "This will e-mail your vendors and staff before each delivery or arrival is due.",
        detail: function (d) { return offText(d.delivery_offsets); } },
      { key: "runsheet", group: "outside", name: "Run-sheet reminders", sends: ["team", "crew", "vendors"], how: "Bell · e-mail · WhatsApp",
        what: "Reminds the person who owns a run-sheet line before it starts.", card: "rsrCard",
        ask: "This will remind the owner of each run-sheet line before it starts - by bell and e-mail for your team, by WhatsApp and e-mail for staff and vendors.",
        detail: function (d) { return offText(d.runsheet_offsets); } },
      { key: "assign_whatsapp", group: "outside", name: "Tell staff about new work", sends: ["crew"], how: "WhatsApp",
        what: "Sends a WhatsApp to a staff member when they are given a run-sheet line or a task.",
        ask: "This will WhatsApp your staff each time they are given a run-sheet line or a task." },
      { key: "crew_shifts", group: "outside", name: "Open shift messages", sends: ["crew"], how: "WhatsApp",
        what: "Sends a WhatsApp to free staff when you post an open shift.", hash: "#crew",
        ask: "This will WhatsApp every free staff member each time you post an open shift." },
      { key: "auto_schedule", group: "nothing", name: "Payment schedule on approval", sends: ["nothing"], how: "",
        what: "Adds your default payment schedule to an event when the client approves (never changes one you made).", hash: "#payment-schedules" },
      { key: "quoteLead", group: "nothing", name: "Quotes → Leads", sends: ["nothing"], how: "", always: true,
        what: "Every quote with a client name is added to Leads and moves along with it.", href: "leads.html" }
    ];
  }

  function askFirst(it) {
    var msg = it.ask + " You can switch it off here at any time.";
    var opts = { title: "Switch on " + it.name + "?", okLabel: "Switch on" };
    try {
      if (global.BPUI && typeof BPUI.confirm === "function") return Promise.resolve(BPUI.confirm(msg, opts));
      if (global.HelmUI && typeof HelmUI.confirm === "function") return Promise.resolve(HelmUI.confirm({ title: opts.title, body: msg, confirmLabel: opts.okLabel }));
      if (typeof global.confirm === "function") return Promise.resolve(global.confirm(msg));
    } catch (e) { return Promise.resolve(false); }
    return Promise.resolve(false);   // nobody to ask: never switch on silently
  }

  function rowEl(it, state, A) {
    var sw = h("input", { type: "checkbox", cls: "au-sw", role: "switch", "aria-label": it.name + " on or off" });
    var st = h("span", { cls: "au-state" });
    var tags = h("span", { cls: "au-tags" }, [h("span", { cls: "au-tl", text: it.sends[0] === "nothing" ? "" : "Sends to:" })]
      .concat(it.sends.map(function (s) { return h("span", { cls: "au-tag au-t-" + s, text: SENDS[s] }); }))
      .concat(it.how ? [h("span", { cls: "au-how", text: it.how })] : []));
    var link = it.card ? h("button", { type: "button", cls: "btn sm au-go", text: "Settings" })
      : it.href ? h("a", { cls: "btn sm au-go", href: it.href, text: "Open Leads" })
      : it.hash ? h("a", { cls: "btn sm au-go", href: it.hash, text: "Settings" }) : null;
    if (it.card && link) link.addEventListener("click", function () { var c = doc.getElementById(it.card); if (c) { try { c.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) { c.scrollIntoView(); } } });
    var det = h("span", { cls: "au-det" });
    var row = h("li", { cls: "au-row", "data-auto": it.key }, [
      h("div", { cls: "au-txt" }, [h("b", { text: it.name }), h("span", { cls: "au-what", text: it.what }), tags, det]),
      h("div", { cls: "au-ctl" }, [st, sw, link])
    ]);
    function paint() {
      var ov = state.ov, on = !!(ov && ov.on && ov.on[it.key]);
      var d = it.detail && ov ? it.detail(ov.details || {}) : "";
      det.textContent = d || ""; det.hidden = !d;
      if (it.always) { st.textContent = "Always on"; st.className = "au-state au-on"; sw.hidden = true; return; }
      if (!ov) { st.textContent = "Not set up yet"; st.className = "au-state au-na"; sw.hidden = true; row.classList.add("au-dim"); return; }
      row.classList.remove("au-dim");
      st.textContent = on ? "On" : "Off"; st.className = "au-state " + (on ? "au-on" : "au-off");
      sw.hidden = false; sw.checked = on; sw.disabled = !state.canEdit;
    }
    sw.addEventListener("change", function () {
      var on = sw.checked;
      sw.disabled = true;
      Promise.resolve(on ? askFirst(it) : true).then(function (yes) {
        if (!yes) { sw.checked = !on; sw.disabled = !state.canEdit; return; }
        st.textContent = "Saving…";
        return Promise.resolve().then(function () { return A.switchOn(it.key, on); }).then(function (ov) {
          if (ov && ov.on) state.ov = ov;
          state.repaint();
          if (state.onChange) state.onChange(it.key, on);
        }, function (e) {
          sw.checked = !on; sw.disabled = !state.canEdit; st.textContent = errText(e, "change this automation"); st.className = "au-state au-err";
        });
      });
    });
    return { el: row, paint: paint };
  }

  function overview(card, A, ov, onChange) {
    var state = { ov: ov, canEdit: !!(ov && ov.can_edit), onChange: onChange };
    var items = registry(), rows = [];
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(h("h3", { text: "Automations" }));
    card.appendChild(h("p", { cls: "mnote", text: "Everything Helm can do by itself, in one place. Each one is off until you switch it on here - nothing is sent to your clients, team, vendors or staff before that." }));
    if (!ov) card.appendChild(h("p", { cls: "mnote au-warn", text: "These switches need the latest Helm update. Until it is installed, nothing on this list sends anything." }));
    else if (!state.canEdit) card.appendChild(h("p", { cls: "mnote", text: "Only people who can edit Control Center can switch these on or off." }));
    if (ov && ov.trial_no_send) card.appendChild(h("p", { cls: "mnote", text: "Free trial: e-mails and WhatsApp messages are not sent during the trial, even when switched on." }));
    GROUPS.forEach(function (g) {
      var mine = items.filter(function (it) { return it.group === g[0]; });
      if (!mine.length) return;
      var ul = h("ul", { cls: "au-list" });
      mine.forEach(function (it) { var r = rowEl(it, state, A); rows.push(r); ul.appendChild(r.el); });
      card.appendChild(h("h4", { cls: "au-grp", text: g[1] }));
      card.appendChild(ul);
    });
    state.repaint = function () { rows.forEach(function (r) { r.paint(); }); };
    state.repaint();
    card.hidden = false;
    return state;
  }

  function runsheetCard(card, A, cfg, canEdit) {
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
    card.appendChild(h("p", { cls: "mnote", text: "On the run-sheet, pick a real person as the Owner of a line. Once “Run-sheet reminders” is switched on in the list above, Helm reminds them at these times before the line starts: team members in the bell and by e-mail, staff and vendors by WhatsApp (and e-mail when they have one). Each line can choose its own time or switch its reminder off." }));
    card.appendChild(h("fieldset", { cls: "au-set" }, [h("legend", { text: "Default reminder times" }), chips]));
    card.appendChild(h("fieldset", { cls: "au-set" }, [h("legend", { text: "How" }), em.el, wa.el]));
    if (cfg.trial_no_send) card.appendChild(h("p", { cls: "mnote", text: "Free trial: reminders show in the bell and the event group only (no e-mail or WhatsApp)." }));
    card.appendChild(msg); card.appendChild(save); card.hidden = false;
    if (!canEdit) { Array.prototype.forEach.call(card.querySelectorAll("input,button"), function (x) { x.disabled = true; }); msg.textContent = "Only people who can edit Control Center can change these."; return; }
    save.addEventListener("click", function () {
      if (!picked.length) { msg.textContent = "Pick at least one reminder time."; return; }
      // on / off is NOT sent from here: it lives in the Automations list (one place)
      var patch = { runsheet_email: em.input.checked, runsheet_whatsapp: wa.input.checked, runsheet_offsets: picked.slice() };
      var run = async function () {
        try { await A.save(patch); msg.textContent = "Saved. Default: " + offText(picked) + "."; }
        catch (e) { msg.textContent = errText(e, "save the run-sheet reminders"); }
      };
      return global.BPUI && BPUI.guard ? BPUI.guard(save, run, { busyLabel: "Saving…" }) : run();
    });
  }

  function enquiryCard(card, A, cfg, canEdit) {
    var slug = String(cfg.public_slug || "");
    var url = slug ? (location.origin + "/" + encodeURIComponent(slug) + "/enquiry") : "";
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
    card.appendChild(h("p", { cls: "mnote", text: "Share one link and every enquiry lands in Leads by itself (source “Enquiry form”, stage New). The client sees only your studio name and a short form. The form opens when “Enquiry form → Leads” is switched on in the list above." }));
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
      var patch = { enquiry_reply: rep.input.checked, enquiry_reply_text: t || null, enquiry_notify: bell.input.checked };
      var run = async function () {
        try { await A.save(patch); msg.textContent = "Saved."; }
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
    var ov = null, cfg = null;
    try { ov = A.overview ? await A.overview() : null; } catch (e) { ov = null; }
    try { cfg = await A.settings(); } catch (e) { cfg = null; }
    overview(card, A, ov, null);
    var canEdit = !!(ov && ov.can_edit) || !!(cfg && cfg.can_manage);
    if (cfg && rs) runsheetCard(rs, A, cfg, canEdit);
    if (cfg && eq) enquiryCard(eq, A, cfg, canEdit);
  }
  global.HelmAutomations = { init: init, registry: registry, offText: offText, daysText: daysText, overview: overview, GROUPS: GROUPS };
})(window);
