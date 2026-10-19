/* inbox-settings.js - Control Center card (0266): the studio's notification inbox + e-mail digest defaults.
   Inbox e-mails on / off (studio switch), the default for people who have not chosen (Daily digest / Instant, important
   only / No e-mails), the digest hour (studio time) and how long an item must stay unread, and whether opening the bell
   marks everything read (off = Linear style: read when opened). Reads BPStore.inbox.admin.get() (Control Center VIEW),
   saves with .set() (EDIT, checked in the database, audit logged). Hidden before 0266. Starts itself the first time the
   Notifications tab is shown. DOM API only. */
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
  function hourLabel(x) { return ((x % 12) || 12) + ":00 " + (x < 12 ? "am" : "pm"); }
  async function init() {
    if (started) return;
    var card = doc.getElementById("inboxCard"), S = global.BPStore;
    if (!card || !S || !S.inbox || !S.inbox.admin) return;
    started = true;
    var cfg = null; try { cfg = await S.inbox.admin.get(); } catch (e) { cfg = null; }
    if (!cfg) { card.hidden = true; return; }
    var on = h("input", { type: "checkbox", id: "ibs_on" }); on.checked = cfg.email_enabled !== false;
    var def = h("select", { id: "ibs_def" }, [["daily", "Daily digest of unread items"], ["instant_important", "Instant e-mail, important items only"], ["off", "No e-mails"]]
      .map(function (o) { return h("option", { value: o[0], text: o[1] }); })); def.value = cfg.digest_default || "daily";
    var hour = h("select", { id: "ibs_hour" }, Array.from({ length: 24 }, function (_, i) { return h("option", { value: String(i), text: hourLabel(i) }); })); hour.value = String(cfg.digest_hour == null ? 8 : cfg.digest_hour);
    var age = h("select", { id: "ibs_age" }, [[15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [240, "4 hours"], [1440, "1 day"]]
      .map(function (o) { return h("option", { value: String(o[0]), text: o[1] }); })); age.value = String(cfg.digest_min_age_minutes || 60);
    var bell = h("input", { type: "checkbox", id: "ibs_bell" }); bell.checked = cfg.bell_open_marks_read === true;
    var msg = h("p", { cls: "mnote", role: "status", "aria-live": "polite" });
    var save = h("button", { type: "button", cls: "btn", id: "ibs_save", text: "Save inbox settings" });
    var ppl = cfg.people || {}, chosen = (ppl.off || 0) + (ppl.instant_important || 0) + (ppl.daily || 0);
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(h("h3", { text: "Inbox & e-mail digest" }));
    card.appendChild(h("p", { cls: "mnote", text: "Everyone has their own Inbox (🔔 → Open inbox): mark read, Done or Snooze. Helm only e-mails what is still unread - anything read, Done or snoozed is left out, and an item is never e-mailed twice. People can pick their own setting on their Inbox page; this is the default for everyone who has not." }));
    card.appendChild(h("label", { cls: "cmchk", for: "ibs_on" }, [on, " Send inbox e-mails from this studio"]));
    card.appendChild(h("div", { cls: "cmgrid" }, [
      h("label", { for: "ibs_def" }, ["Default for the team ", def]),
      h("label", { for: "ibs_hour" }, ["Daily digest at (studio time) ", hour]),
      h("label", { for: "ibs_age" }, ["Only items unread for at least ", age])]));
    card.appendChild(h("label", { cls: "cmchk", for: "ibs_bell" }, [bell, " Opening the bell marks everything read (off: an item is read when it is opened or marked)"]));
    if (chosen) card.appendChild(h("p", { cls: "mnote", text: chosen + " team member" + (chosen === 1 ? " has" : "s have") + " chosen their own setting (" + (ppl.daily || 0) + " daily, " + (ppl.instant_important || 0) + " instant, " + (ppl.off || 0) + " off)." }));
    card.appendChild(h("p", { cls: "mnote", text: "E-mails go out once Helm's e-mail sending is switched on for your account. Free-trial studios do not send them." }));
    card.appendChild(msg); card.appendChild(save);
    card.hidden = false;
    if (!cfg.can_manage) {
      Array.prototype.forEach.call(card.querySelectorAll("input,select,button"), function (x) { x.disabled = true; });
      msg.textContent = "Only people with Control Center edit rights can change these settings."; return;
    }
    save.addEventListener("click", function () {
      var patch = { email_enabled: on.checked, digest_default: def.value, digest_hour: Number(hour.value), digest_min_age_minutes: Number(age.value), bell_open_marks_read: bell.checked };
      var run = async function () {
        try { await S.inbox.admin.set(patch); msg.textContent = "Saved."; }
        catch (e) { msg.textContent = (global.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "save the inbox settings" }) : String((e && e.message) || e); }
      };
      return global.BPUI && BPUI.guard ? BPUI.guard(save, run, { busyLabel: "Saving…" }) : run();
    });
  }
  // start once the Notifications pane is shown (control.html un-hides #pane-notify)
  function watch() {
    var pane = doc.getElementById("pane-notify"); if (!pane) return;
    var go = function () { if (!pane.hidden) init(); };
    go();
    if (global.MutationObserver) new MutationObserver(go).observe(pane, { attributes: true, attributeFilter: ["hidden"] });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", watch); else watch();
  global.HelmInboxSettings = { init: init };
})(window);
