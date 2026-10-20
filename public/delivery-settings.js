/* delivery-settings.js - Control Center card (0241): delivery / arrival reminders for the studio.
   On / off, the default reminder times (each assignment can change its own), which kinds of people may be
   e-mailed, a copy to the person who scheduled it, and where replies are posted (the event's team chat group
   or a studio group) + the bell + the "no response" alert. Reads through BPStore.deliveries.settings(), writes
   through saveSettings() (delivery_settings_set: Control Center EDIT, checked in the database).
   DOM API only (no HTML strings). Hidden when the server is older than 0241. Needs delivery-tracker.js. */
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
  function chk(id, label, on) { var i = h("input", { type: "checkbox", id: id }); i.checked = !!on; return { input: i, el: h("label", { cls: "dlv-chk", for: id }, [i, " " + label]) }; }

  async function init() {
    if (started) return; started = true;
    var card = doc.getElementById("dlvCard"), S = global.BPStore, D = global.HelmDelivery;
    if (!card || !S || !S.deliveries || !D || !D.offsetsEditor) return;
    var cfg = null;
    try { cfg = await S.deliveries.settings(); } catch (e) { cfg = null; }
    if (!cfg) { card.hidden = true; return; }
    var canEdit = !!cfg.can_manage;
    // r25 (0274): delivery & arrival reminders are switched on / off ONLY in Control Center -> Automations
    var on = { el: h("p", { cls: "mnote au-onoff", id: "dl_on" }, ["Automatic delivery & arrival reminders are ", h("b", { text: cfg.enabled ? "on" : "off" }),
      " - switch them in ", h("a", { href: "#automations", text: "Control Center → Automations" }), "."]) };
    var ed = D.offsetsEditor(cfg.offsets || [60, 30, 0], { emptyText: "No default reminders" });
    var kinds = cfg.ping_kinds || [];
    var kv = chk("dl_k_vendor", "Vendors", kinds.indexOf("vendor") >= 0), ks = chk("dl_k_staff", "Staff members", kinds.indexOf("staff") >= 0),
        ku = chk("dl_k_user", "Studio users", kinds.indexOf("user") >= 0), ko = chk("dl_k_other", "Anyone else (typed e-mail)", kinds.indexOf("other") >= 0);
    var cc = chk("dl_cc", "Also e-mail a copy to the person who scheduled it", cfg.cc_creator);
    var chat = chk("dl_chat", "Post every reply in the team chat", cfg.chat_post);
    var bell = chk("dl_bell", "Show replies in the notification bell", cfg.notify_bell);
    var nr = chk("dl_nr", "Alert the admins + the team when there is no reply 15 minutes after the due time", cfg.no_response_alert);
    var grp = h("select", { id: "dl_group", "aria-label": "Chat group for replies" }, [h("option", { value: "", text: "Each event's own team chat group" })]
      .concat((cfg.groups || []).map(function (g) { return h("option", { value: g.id, text: (g.kind === "broadcast" ? "Everyone: " : "Group: ") + (g.title || "Group") }); })));
    grp.value = cfg.chat_conversation_id || "";
    var msg = h("p", { cls: "mnote", role: "status", "aria-live": "polite" });
    var save = h("button", { type: "button", cls: "btn", id: "dl_save", text: "Save reminder settings" });
    var trial = cfg.trial_email === true ? h("p", { cls: "mnote", text: "Free trial: reminder e-mails count toward the trial's e-mail limit (30 a day, 5 a day to one address)." })
      : cfg.trial_email === false ? h("p", { cls: "mnote", text: "Reminder e-mails are not sent from this studio right now (trial e-mail is off)." }) : null;
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(h("h3", { text: "Delivery & arrival reminders" }));
    card.appendChild(h("p", { cls: "mnote", text: "When someone schedules a delivery or arrival for an event (e.g. 120 chairs from a vendor by 4:30 pm), Helm e-mails the responsible person before it is due with a one-tap link to reply On the way, Arrived, Delayed or Problem. Replies show on the event-day page and in the team chat. Off until you switch it on in Automations. Who may schedule them: Roles & access → “Deliveries & arrivals”." }));
    card.appendChild(on.el);
    card.appendChild(h("fieldset", { cls: "dlv-set" }, [h("legend", { text: "Default reminder times (each assignment can change its own)" }), ed.el]));
    card.appendChild(h("fieldset", { cls: "dlv-set" }, [h("legend", { text: "Who may be e-mailed" }), kv.el, ks.el, ku.el, ko.el, h("br"), cc.el]));
    card.appendChild(h("fieldset", { cls: "dlv-set" }, [h("legend", { text: "Replies & alerts" }), chat.el, h("div", { cls: "dlv-fld" }, [h("label", { for: "dl_group", text: "Post in" }), grp]), bell.el, h("br"), nr.el]));
    if (trial) card.appendChild(trial);
    card.appendChild(msg);
    card.appendChild(save);
    card.hidden = false;
    if (!canEdit) {
      Array.prototype.forEach.call(card.querySelectorAll("input,select,button"), function (x) { x.disabled = true; });
      msg.textContent = "Only people with Control Center edit rights can change these settings.";
      return;
    }
    save.addEventListener("click", function () {
      var k = []; if (kv.input.checked) k.push("vendor"); if (ks.input.checked) k.push("staff"); if (ku.input.checked) k.push("user"); if (ko.input.checked) k.push("other");
      var offs = ed.get();
      if (cfg.enabled && !offs.length) { msg.textContent = "Add at least one default reminder time, or switch reminders off in Automations."; return; }
      var patch = { ping_kinds: k, cc_creator: cc.input.checked, chat_post: chat.input.checked,
        chat_conversation_id: grp.value || null, notify_bell: bell.input.checked, no_response_alert: nr.input.checked };
      if (offs.length) patch.offsets = offs;
      var run = async function () {
        try { await S.deliveries.saveSettings(patch); msg.textContent = "Saved."; }
        catch (e) { msg.textContent = (global.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "save the reminder settings" }) : String((e && e.message) || e); }
      };
      return global.BPUI && BPUI.guard ? BPUI.guard(save, run, { busyLabel: "Saving…" }) : run();
    });
  }
  global.HelmDeliverySettings = { init: init };
})(window);
