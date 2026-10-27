/* link-views.js - r23 (0261): "see when the client opens their link" (DocSend / PandaDoc model).
   - Quote rows (quotes.html, tbody[data-link-views-rows]): a small "Viewed 3x · last 2h ago" chip under the event name.
   - Event workspace + quote flow step 9 ([data-link-views] / [data-link-views="panel"], quote from ?id= / ?quote=):
     the same chip (+ a one-line summary in the panel); #link-views in the address opens the timeline.
   - The timeline dialog: every visit (first / last open, device, which pages), the IP address for admins only,
     "Viewed but not approved" with a one-tap Send a nudge (e-mail / WhatsApp, queued) and Dismiss.
   - Settings card (#lvCard[data-link-views-settings]): the studio's switches.
   Reads / writes ONLY through BPStore.linkViews (every rule is checked in the database). DOM API only (no HTML
   strings). Hidden when the server is older than 0261, signed out, or without Quotes view. */
(function (global) {
  "use strict";
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var PAGES = { portal: "Proposal", quotation: "Quotation", booklet: "Booklet", approve: "Started approving" };
  var DEVICES = { mobile: "Mobile", tablet: "Tablet", desktop: "Desktop", unknown: "Device" };
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;

  /* ---------- pure helpers (unit-tested in test/r23-link-views.test.mjs) ---------- */
  function ts(v) { var t = new Date(v || "").getTime(); return isNaN(t) ? null : t; }
  function fmtDate(v) {
    var S = global.BPStore;
    if (S && S.fmtStudioDate) { try { var o = S.fmtStudioDate(v, { time: true }); if (o) return o; } catch (e) {} }
    var d = new Date(v); if (isNaN(d.getTime())) return "";
    var p = function (n) { return String(n).padStart(2, "0"); };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear() + ", " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function ago(v, now) {
    var t = ts(v); if (t == null) return "";
    var d = (now == null ? Date.now() : now) - t;
    if (d < MIN) return "just now";
    if (d < HOUR) return Math.floor(d / MIN) + " min ago";
    if (d < DAY) return Math.floor(d / HOUR) + "h ago";
    if (d < 30 * DAY) return Math.floor(d / DAY) + "d ago";
    var s = fmtDate(v); return s ? s.split(",")[0] : "";
  }
  function days(v, now) { var t = ts(v); return t == null ? 0 : Math.max(0, Math.floor(((now == null ? Date.now() : now) - t) / DAY)); }
  // none | approved | followup (open, not approved) | nudged | viewed
  function state(s) {
    if (!s || !(Number(s.views) > 0)) return "none";
    if (s.approved) return "approved";
    var f = s.followup;
    if (f && f.status === "open") return "followup";
    if (f && f.status === "nudged") return "nudged";
    return "viewed";
  }
  function chipText(s, now) {
    if (!s || !(Number(s.views) > 0)) return "";
    var t = "Viewed " + Number(s.views) + "×" + (s.last_at ? " · last " + ago(s.last_at, now) : "");
    var st = state(s);
    if (st === "followup") t += " · not approved";
    else if (st === "nudged") t += " · nudged";
    return t;
  }
  function chipTitle(s, now) {
    if (!s || !(Number(s.views) > 0)) return "";
    var parts = ["The client opened their link " + Number(s.views) + (Number(s.views) === 1 ? " time" : " times")];
    if (s.first_at) parts.push("first " + fmtDate(s.first_at));
    if (s.last_at) parts.push("last " + fmtDate(s.last_at) + " (" + ago(s.last_at, now) + ")");
    if (s.last_device) parts.push("on " + (DEVICES[s.last_device] || "a device").toLowerCase());
    return parts.join(" · ") + ". Click for the timeline.";
  }
  function deviceText(v) {
    v = v || {};
    return [DEVICES[v.device] || "Device", v.os || "", v.browser || ""].filter(Boolean).join(" · ");
  }
  function pageLabel(p) { return PAGES[p] || "Link"; }
  // the pages of one visit in order, a page repeated straight after itself shown once
  function pagesText(pages) {
    var out = [];
    (Array.isArray(pages) ? pages : []).forEach(function (x) { var l = pageLabel(x && x.page); if (out[out.length - 1] !== l) out.push(l); });
    return out.join(" → ");
  }
  function quoteIdFrom(el, loc) {
    var a = el && el.getAttribute ? el.getAttribute("data-quote-id") : "";
    if (a && UUID.test(a)) return a;
    try {
      var p = new URLSearchParams((loc || global.location).search);
      var id = p.get("id") || p.get("quote") || "";
      return UUID.test(id) ? id : "";
    } catch (e) { return ""; }
  }
  function nudgeResultText(r) {
    if (!r) return "";
    if (r.status === "queued") return "Nudge queued to " + (r.masked || "the client") + " - it goes out with your next scheduled messages.";
    if (r.status === "already_queued") return "A nudge to " + (r.masked || "the client") + " is already queued.";
    if (r.status === "skipped") return r.reason === "free_trial" ? "Free trial: the nudge was recorded but not sent (no client messages in a trial)."
      : r.reason === "demo" ? "Demo event: the nudge was recorded but not sent." : "The nudge was recorded but not sent.";
    return "";
  }

  if (typeof document === "undefined") { global.HelmLinkViews = { ago: ago, days: days, state: state, chipText: chipText, chipTitle: chipTitle, deviceText: deviceText, pageLabel: pageLabel, pagesText: pagesText, quoteIdFrom: quoteIdFrom, nudgeResultText: nudgeResultText }; return; }

  /* ---------- DOM ---------- */
  var doc = document;
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function S() { return global.BPStore; }
  function toast(t, type) { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(t, { type: type || "ok" }); } catch (e) {} }
  function friendly(e, action) {
    try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: action }); } catch (x) {}
    return String((e && e.message) || e || "Something went wrong");
  }
  var allowed = null;   // Promise<boolean>: signed in, server has 0261, Quotes view
  function canUse() {
    if (allowed) return allowed;
    allowed = (async function () {
      var st = S(); if (!st || !st.linkViews) return false;
      try { if (st.init) await st.init(); } catch (e) { return false; }
      try { if (st.mode && st.mode() !== "supabase") return false; } catch (e) { return false; }
      try { if (st.auth && st.auth.canView && !(await st.auth.canView("quotes"))) return false; } catch (e) { return false; }
      return true;
    })();
    return allowed;
  }

  // summary cache (60 s) shared by rows + chips
  var cache = {}, cacheAt = {}, TTL = 60000, dead = false;
  async function summaries(ids, fresh) {
    if (dead) return null;
    var need = ids.filter(function (id) { return fresh || !(id in cache) || Date.now() - (cacheAt[id] || 0) > TTL; });
    if (need.length) {
      var r = null;
      try { r = await S().linkViews.summary(need); } catch (e) { r = undefined; }
      if (r === null) { dead = true; return null; }          // server older than 0261
      if (r && typeof r === "object") need.forEach(function (id) { cache[id] = r[id] || null; cacheAt[id] = Date.now(); });
    }
    var out = {}; ids.forEach(function (id) { out[id] = cache[id] || null; }); return out;
  }
  function invalidate(id) { if (id) { delete cache[id]; delete cacheAt[id]; } }

  function chip(id, s) {
    var st = state(s);
    var b = h("button", { type: "button", cls: "lv-chip lv-" + st, "data-lv-quote": id, "aria-haspopup": "dialog",
      title: chipTitle(s), "aria-label": chipText(s) + " - open the views timeline" }, [h("span", { cls: "lv-eye", "aria-hidden": "true", text: "👁" }), chipText(s)]);
    b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); open(id); });
    return b;
  }

  /* quote rows: decorate after every render of the table (the page re-renders rows; the cache keeps it cheap) */
  function decorateRows(tbody) {
    if (!tbody || tbody.__lv) return; tbody.__lv = true;
    var timer = null;
    async function paint() {
      if (!(await canUse())) return;
      var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr[data-id]"));
      var ids = rows.map(function (r) { return r.getAttribute("data-id"); }).filter(function (x) { return UUID.test(x || ""); });
      if (!ids.length) return;
      var m = await summaries(ids); if (!m) return;
      rows.forEach(function (r) {
        var id = r.getAttribute("data-id"), s = m[id];
        var old = r.querySelector(".lv-rowchip");
        if (!s || !(Number(s.views) > 0)) { if (old) old.remove(); return; }
        var a = r.querySelector("a.qname"), td = a ? a.closest("td") : null; if (!td) return;
        var box = h("div", { cls: "lv-rowchip" }, [chip(id, s)]);
        if (old) old.replaceWith(box); else td.appendChild(box);
      });
    }
    var schedule = function () { if (timer) clearTimeout(timer); timer = setTimeout(function () { timer = null; paint().catch(function () {}); }, 120); };
    try { new MutationObserver(function (list) {
      // ignore our own chips being added
      if (list.every(function (x) { return Array.prototype.every.call(x.addedNodes, function (n) { return n.classList && n.classList.contains("lv-rowchip"); }) && x.removedNodes.length <= 1; })) return;
      schedule();
    }).observe(tbody, { childList: true, subtree: true }); } catch (e) {}
    global.addEventListener("helm:link-views", schedule);
    schedule();
  }

  /* chip / panel on the event workspace + quote flow step 9 */
  function mount(el) {
    if (!el || el.__lv) return; el.__lv = true;
    var id = quoteIdFrom(el); if (!id) return;
    var panel = el.getAttribute("data-link-views") === "panel";
    async function paint(fresh) {
      if (!(await canUse())) { el.hidden = true; return; }
      var m = await summaries([id], fresh); if (!m) { el.hidden = true; return; }
      var s = m[id];
      while (el.firstChild) el.removeChild(el.firstChild);
      if (!s || !(Number(s.views) > 0)) {
        if (panel) { el.appendChild(h("p", { cls: "lv-none", text: "👁 Not opened yet - you'll see here (and in the bell) when your client opens their link." })); el.hidden = false; }
        else el.hidden = true;
        return;
      }
      el.hidden = false;
      el.appendChild(chip(id, s));
      if (panel) {
        var line = "First opened " + fmtDate(s.first_at) + (s.last_page ? " · last looked at: " + pageLabel(s.last_page).toLowerCase() : "");
        if (state(s) === "followup") line += " · not approved for " + days(s.first_at) + " days - send a nudge from the timeline";
        el.appendChild(h("p", { cls: "lv-line", text: line }));
      }
    }
    paint(false).then(function () {
      if (String(global.location.hash || "") === "#link-views" && !global.__lvOpened) { global.__lvOpened = true; open(id); }
    }).catch(function () {});
    global.addEventListener("helm:link-views", function (e) { if (!e.detail || e.detail.quoteId === id) paint(true).catch(function () {}); });
    global.addEventListener("helm:approval-link", function () { invalidate(id); paint(true).catch(function () {}); });
  }

  /* the timeline dialog */
  var dlg = null;
  function close() { if (dlg) { try { dlg.close(); } catch (e) {} dlg.remove(); dlg = null; } }
  async function open(id) {
    if (!UUID.test(id || "")) return;
    close();
    dlg = h("dialog", { cls: "lv-dlg", "aria-labelledby": "lvTitle", "aria-modal": "true" });
    var x = h("button", { type: "button", cls: "lv-x", "aria-label": "Close", text: "×" });
    x.addEventListener("click", close);
    var body = h("div", { cls: "lv-body", "aria-live": "polite" }, [h("p", { cls: "lv-muted", text: "Loading…" })]);
    dlg.appendChild(h("div", { cls: "lv-head" }, [h("h2", { id: "lvTitle", text: "Client views" }), x]));
    dlg.appendChild(body);
    dlg.addEventListener("cancel", function (e) { e.preventDefault(); close(); });
    dlg.addEventListener("click", function (e) { if (e.target === dlg) close(); });
    doc.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    var t = null;
    try { t = await S().linkViews.timeline(id); } catch (e) { body.textContent = friendly(e, "load the views"); return; }
    if (!dlg) return;
    if (!t) { body.textContent = "Client views need a newer server - ask your admin to run the latest update."; return; }
    render(body, id, t);
  }

  function render(body, id, t) {
    while (body.firstChild) body.removeChild(body.firstChild);
    var views = Number(t.views) || 0;
    if (!views) {
      body.appendChild(h("p", { cls: "lv-muted", text: "Your client hasn't opened their link yet. You'll get a bell notification the first time they do." }));
    } else {
      body.appendChild(h("div", { cls: "lv-stats" }, [
        h("div", null, [h("b", { text: String(views) }), h("span", { text: views === 1 ? "visit" : "visits" })]),
        h("div", null, [h("b", { text: ago(t.first_at) }), h("span", { text: "first opened" })]),
        h("div", null, [h("b", { text: ago(t.last_at) }), h("span", { text: "last opened" })])
      ]));
    }
    // viewed but not approved -> nudge / dismiss
    var f = t.followup, waiting = !!t.waiting, msg = h("p", { cls: "lv-msg", role: "status", "aria-live": "polite" });
    if (views && t.approved) body.appendChild(h("p", { cls: "lv-ok", text: "✓ The client has approved." }));
    else if (views && waiting) {
      var box = h("div", { cls: "lv-fu" + (f && f.status === "open" ? " is-open" : "") });
      var head = f && f.status === "open" ? "Viewed but not approved for " + days(t.first_at) + (days(t.first_at) === 1 ? " day" : " days")
        : f && f.status === "nudged" ? "Nudge sent " + ago(f.closed_at) + (f.channel ? " by " + (f.channel === "whatsapp" ? "WhatsApp" : "e-mail") : "")
        : "Waiting for the client to approve";
      box.appendChild(h("p", { cls: "lv-fu-h", text: head }));
      if (t.can_nudge) {
        var ch = t.channels || {};
        var acts = h("div", { cls: "lv-acts" });
        var mk = function (channel, label, ok, why) {
          var b = h("button", { type: "button", cls: "lv-btn" + (channel === "whatsapp" ? " ghost" : ""), text: label, disabled: !ok, title: ok ? "" : why });
          b.addEventListener("click", function () {
            var run = async function () {
              try {
                var r = await S().linkViews.nudge(id, channel);
                msg.textContent = nudgeResultText(r); toast(nudgeResultText(r), r && r.status === "skipped" ? "info" : "ok");
                invalidate(id); try { global.dispatchEvent(new CustomEvent("helm:link-views", { detail: { quoteId: id } })); } catch (e) {}
                var t2 = await S().linkViews.timeline(id); if (t2 && dlg) render(body, id, t2);
              } catch (e) { msg.textContent = friendly(e, "send the nudge"); }
            };
            return global.BPUI && global.BPUI.guard ? global.BPUI.guard(b, run, { busyLabel: "Sending…" }) : run();
          });
          return b;
        };
        acts.appendChild(mk("email", "Send a nudge by e-mail", !!ch.email, "Add the client's e-mail to the event first."));
        acts.appendChild(mk("whatsapp", "Nudge on WhatsApp", !!ch.whatsapp,
          "Needs the client's mobile number, their WhatsApp opt-in and your studio's WhatsApp number (Settings → Notifications)."));
        if (f && f.status === "open") {
          var dm = h("button", { type: "button", cls: "lv-btn ghost", text: "Dismiss" });
          dm.addEventListener("click", function () {
            var run = async function () {
              try { await S().linkViews.dismiss(f.id); invalidate(id); try { global.dispatchEvent(new CustomEvent("helm:link-views", { detail: { quoteId: id } })); } catch (e) {}
                var t2 = await S().linkViews.timeline(id); if (t2 && dlg) render(body, id, t2); }
              catch (e) { msg.textContent = friendly(e, "dismiss the follow-up"); }
            };
            return global.BPUI && global.BPUI.guard ? global.BPUI.guard(dm, run, { busyLabel: "Saving…" }) : run();
          });
          acts.appendChild(dm);
        }
        box.appendChild(acts);
        box.appendChild(h("p", { cls: "lv-muted lv-small", text: "The nudge uses your studio's follow-up message (Settings → Notifications → Client follow-ups) and goes to the client's e-mail / WhatsApp on the event. It is queued and sent by Helm's messaging service." }));
      }
      box.appendChild(msg);
      body.appendChild(box);
    }
    // the visits
    var visits = Array.isArray(t.visits) ? t.visits : [];
    if (visits.length) {
      body.appendChild(h("h3", { cls: "lv-h3", text: "Visits" }));
      var ol = h("ol", { cls: "lv-visits" });
      visits.forEach(function (v) {
        var meta = [deviceText(v)];
        if (t.is_admin && v.ip) meta.push("IP " + v.ip);
        ol.appendChild(h("li", { cls: "lv-visit" }, [
          h("div", { cls: "lv-vh" }, [h("b", { text: "Visit " + v.visit }), h("span", { text: fmtDate(v.started_at) + " (" + ago(v.started_at) + ")" })]),
          h("div", { cls: "lv-pages", text: pagesText(v.pages) }),
          h("div", { cls: "lv-muted lv-small", text: meta.join(" · ") })
        ]));
      });
      body.appendChild(ol);
      if (!t.is_admin) body.appendChild(h("p", { cls: "lv-muted lv-small", text: "IP addresses are shown to admins only." }));
    }
    var nd = Array.isArray(t.nudges) ? t.nudges : [];
    if (nd.length) {
      body.appendChild(h("h3", { cls: "lv-h3", text: "Follow-ups to the client" }));
      var ul = h("ul", { cls: "lv-nudges" });
      nd.forEach(function (n) {
        ul.appendChild(h("li", { text: fmtDate(n.at) + " · " + (n.channel === "whatsapp" ? "WhatsApp" : "E-mail") + " to " + (n.to || "the client") + " · "
          + (n.status === "queued" ? "queued" : n.status === "sent" ? "sent" : n.status === "failed" ? "could not be sent" : "not sent") + (n.manual ? "" : " (automatic)") }));
      });
      body.appendChild(ul);
    }
    body.appendChild(h("p", { cls: "lv-muted lv-small", text: "Opens by your own team (signed in) and the Preview buttons are never counted. Pages opened on one device within 30 minutes count as one visit." }));
  }

  /* Settings card */
  async function settingsCard(card) {
    if (!card || card.__lv) return; card.__lv = true;
    var st = S(); if (!st || !st.linkViews) return;
    try { if (st.init) await st.init(); } catch (e) { return; }
    var cfg = null; try { cfg = await st.linkViews.settings(); } catch (e) { cfg = null; }
    if (!cfg) { card.hidden = true; return; }
    var canEdit = !!cfg.can_edit;
    function chk(id, label, on) { var i = h("input", { type: "checkbox", id: id }); i.checked = !!on; return { input: i, el: h("label", { cls: "lv-chk", for: id }, [i, " " + label]) }; }
    function num(id, label, v, min, max) {
      var i = h("input", { type: "number", id: id, min: String(min), max: String(max), step: "1", inputmode: "numeric", value: String(v) });
      return { input: i, el: h("label", { cls: "lv-num", for: id }, [label + " ", i]) };
    }
    var tr = chk("lv_track", "Track when clients open their links (proposal, quotation, booklet)", cfg.track_enabled);
    var bf = chk("lv_bell1", "Bell notification the first time the client opens it", cfg.bell_first);
    var br = chk("lv_bellr", "Also notify on later visits", cfg.bell_repeat);
    var rh = num("lv_rh", "at most once every (hours)", cfg.repeat_hours, 1, 168);
    // r25 (0274): the viewed-but-not-approved alert is switched on / off ONLY in Settings -> Automations
    var fe = { el: h("span", { cls: "mnote au-onoff", id: "lv_fu" }, ["“Viewed but not approved” alert for the quote's owner + admins: ",
      h("b", { text: cfg.followup_enabled ? "on" : "off" }), " (switch it in ", h("a", { href: "#automations", text: "Automations" }), ")"]) };
    var fd = num("lv_fd", "after (days)", cfg.followup_days, 1, 30);
    var an = cfg.auto_nudge || {};
    var autoLine = h("p", { cls: "mnote" }, [
      "Automatic nudge to the client: ", h("b", { text: an.enabled ? "on" : "off" }),
      an.enabled ? " (" + (an.delay_days || 3) + " days after opening, up to " + (an.max || 2) + ")" : " (off by default)",
      " - switch it in ", h("a", { href: "#automations", cls: "lv-link", text: "Automations → Client follow-ups" }), "."]);
    var msg = h("p", { cls: "mnote", role: "status", "aria-live": "polite" });
    var save = h("button", { type: "button", cls: "btn", id: "lv_save", text: "Save client view settings" });
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(h("h3", { text: "👁 Client link views" }));
    card.appendChild(h("p", { cls: "mnote", text: "See when a client opens the link you sent: “Viewed 3× · last 2h ago” on quotes, a timeline on the event (device, which pages) and a bell notification. Opens by your own team and the Preview buttons are never counted. IP addresses are shown to admins only." }));
    card.appendChild(h("fieldset", { cls: "lv-set" }, [h("legend", { text: "Tracking & bell" }), tr.el, bf.el, h("div", { cls: "lv-inline" }, [br.el, rh.el])]));
    card.appendChild(h("fieldset", { cls: "lv-set" }, [h("legend", { text: "Viewed but not approved" }), h("div", { cls: "lv-inline" }, [fe.el, fd.el]),
      h("p", { cls: "mnote", text: "Shows in the Attention tab and on the dashboard, with a one-tap “Send a nudge”." }), autoLine]));
    card.appendChild(msg); card.appendChild(save);
    card.hidden = false;
    if (!canEdit) {
      Array.prototype.forEach.call(card.querySelectorAll("input,button"), function (x) { x.disabled = true; });
      msg.textContent = "Only people with Settings edit rights can change these settings.";
      return;
    }
    save.addEventListener("click", function () {
      var r = Number(rh.input.value), d = Number(fd.input.value);
      if (!Number.isInteger(r) || r < 1 || r > 168) { msg.textContent = "Later-visit alerts: choose 1 to 168 hours."; rh.input.focus(); return; }
      if (!Number.isInteger(d) || d < 1 || d > 30) { msg.textContent = "Viewed but not approved: choose 1 to 30 days."; fd.input.focus(); return; }
      var patch = { track_enabled: tr.input.checked, bell_first: bf.input.checked, bell_repeat: br.input.checked, repeat_hours: r,
        followup_days: d };
      var run = async function () {
        try { await st.linkViews.saveSettings(patch); msg.textContent = "Saved."; }
        catch (e) { msg.textContent = friendly(e, "save the client view settings"); }
      };
      return global.BPUI && global.BPUI.guard ? global.BPUI.guard(save, run, { busyLabel: "Saving…" }) : run();
    });
  }

  function wire() {
    Array.prototype.forEach.call(doc.querySelectorAll("[data-link-views-rows]"), decorateRows);
    Array.prototype.forEach.call(doc.querySelectorAll("[data-link-views]"), mount);
    Array.prototype.forEach.call(doc.querySelectorAll("[data-link-views-settings]"), function (c) { settingsCard(c).catch(function () {}); });
  }
  global.HelmLinkViews = { ago: ago, days: days, state: state, chipText: chipText, chipTitle: chipTitle, deviceText: deviceText, pageLabel: pageLabel,
    pagesText: pagesText, quoteIdFrom: quoteIdFrom, nudgeResultText: nudgeResultText, open: open, mount: mount, decorateRows: decorateRows,
    settingsCard: settingsCard, summaries: summaries, wire: wire };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", wire); else wire();
})(typeof window !== "undefined" ? window : globalThis);
