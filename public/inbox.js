/* inbox.js - r23 (0266) the /inbox page: a person's own notification inbox (Linear / GitHub / Slack model).
   Tabs Unread / All / Snoozed / Done, filters by group (from the server's own catalog groups), grouped by event or by date,
   per-row + bulk actions (read / unread, Done, Snooze: later today / tomorrow 9 am / next week / custom), keyboard
   (j / k move, e Done, s Snooze, u read / unread, x select, Enter open, Esc clear) and the person's e-mail choice
   (Off / Instant important only / Daily digest / studio default). Everything is checked by the database
   (BPStore.inbox -> inbox_feed / inbox_act / inbox_read_all / inbox_set_my_digest). DOM API only (no HTML strings). */
(function () {
  "use strict";
  var doc = document, C = window.HelmInboxCore;
  function $(s) { return doc.querySelector(s); }
  function h(tag, attrs, kids) {
    var e = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") e.textContent = String(v); else if (k === "cls") e.className = v; else e.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; e.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return e;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function here() { try { return HelmUrl.here(); } catch (e) { return "inbox.html"; } }
  function toast(msg, undo, type) {
    try { if (window.BPUI && BPUI.toast) BPUI.toast(msg, { type: type || "info", timeout: 6000, action: undo ? { label: "Undo", onClick: undo } : undefined }); } catch (e) {}
  }
  function errText(e, action) { return (window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: action }) : String((e && e.message) || e); }
  var lsGet = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var lsSet = function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} };

  var TABS = ["unread", "all", "snoozed", "done"];
  var S = { tab: "unread", filter: "", quote: null, by: lsGet("helm.inbox.by") === "day" ? "day" : "event", items: [], cursor: null,
            counts: {}, groups: [], settings: null, sel: {}, focus: -1, busy: false, tz: C ? C.DEFAULT_TZ : "Asia/Kolkata", lastLoad: 0 };

  function readUrl() {
    try {
      var p = new URLSearchParams(location.search);
      var t = p.get("tab"); if (TABS.indexOf(t) !== -1) S.tab = t;
      var f = p.get("f"); if (f && /^[a-z_]{1,40}$/.test(f)) S.filter = f;
      var q = p.get("event"); if (q && /^[0-9a-f-]{36}$/i.test(q)) S.quote = q;
    } catch (e) {}
  }
  function writeUrl() {
    try {
      var p = new URLSearchParams();
      if (S.tab !== "unread") p.set("tab", S.tab); if (S.filter) p.set("f", S.filter); if (S.quote) p.set("event", S.quote);
      var qs = p.toString(); history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    } catch (e) {}
  }

  // ---- data ----
  async function load(more) {
    if (S.busy) return; S.busy = true;
    var list = $("#ibxList"); list.setAttribute("aria-busy", "true");
    try {
      var r = await BPStore.inbox.feed({ tab: S.tab, filter: S.filter || null, quote: S.quote, limit: 50, cursor: more ? S.cursor : null });
      if (r === null) { $("#ibxApp").hidden = true; $("#ibxMissing").hidden = false; return; }
      var items = Array.isArray(r.items) ? r.items : [];
      S.items = more ? S.items.concat(items) : items;
      S.cursor = r.next_cursor || null; S.counts = r.counts || {}; S.groups = Array.isArray(r.groups) ? r.groups : [];
      if (r.settings) { S.settings = r.settings; if (r.settings.timezone) S.tz = r.settings.timezone; }
      if (!more) { var keep = {}; S.items.forEach(function (n) { if (S.sel[n.id]) keep[n.id] = 1; }); S.sel = keep; }
      S.lastLoad = Date.now();
      render();
    } catch (e) {
      clear(list); list.appendChild(h("div", { cls: "ibx-empty", role: "alert" }, [h("b", { text: "Could not load your inbox" }), h("span", { text: errText(e, "load your inbox") })]));
    } finally { S.busy = false; list.setAttribute("aria-busy", "false"); }
  }

  // ---- view ----
  function label(n) { try { return BPStore.bell.label(n) || {}; } catch (e) { return { icon: "🔔", text: String(n.kind || "Update").replace(/_/g, " ") }; } }
  function link(n) { try { var l = BPStore.bell.link(n); return (typeof HelmUrl !== "undefined" && HelmUrl.upgrade) ? HelmUrl.upgrade(l) : l; } catch (e) { return ""; } }
  function groupClass(n) {
    var k = String(n.kind || "").toLowerCase();
    if (k.indexOf("task_") === 0) return "g-task";
    if (/payment|advance_paid|pkg_pay|trial_reminder|price/.test(k)) return "g-billing";
    if (k.indexOf("chat_") === 0) return "g-chat";
    return "g-other";
  }
  function flat() { return Array.prototype.slice.call(doc.querySelectorAll("#ibxList .ibx-row")); }
  function selIds() { return Object.keys(S.sel).filter(function (k) { return S.sel[k]; }); }

  function renderTabs() {
    TABS.forEach(function (t) {
      var b = $("#ibxTab-" + t), n = $("#ibxN-" + t), c = Number(S.counts[t]) || 0;
      b.setAttribute("aria-selected", String(t === S.tab)); b.tabIndex = t === S.tab ? 0 : -1;
      n.textContent = (t === "unread" || t === "snoozed") && c ? (c > 999 ? "999+" : String(c)) : "";
    });
    $("#ibxList").setAttribute("aria-labelledby", "ibxTab-" + S.tab);
    $("#ibxReadAll").disabled = !(Number(S.counts.unread) > 0);
  }
  function renderChips() {
    var box = $("#ibxChips"); clear(box);
    var chip = function (key, text, count) {
      var b = h("button", { type: "button", cls: "ibx-chip", "data-f": key, "aria-pressed": String(S.filter === key) }, [text]);
      if (count) b.appendChild(h("span", { cls: "ibx-cn", text: count > 999 ? "999+" : String(count) }));
      return b;
    };
    box.appendChild(chip("", "All", 0));
    S.groups.forEach(function (g) { if (g && g.key) box.appendChild(chip(String(g.key), String(g.label || g.key), S.tab === "unread" ? Number(g.unread) || 0 : Number(g.count) || 0)); });
    if (S.filter && !S.groups.some(function (g) { return g && g.key === S.filter; })) box.appendChild(chip(S.filter, S.filter.replace(/_/g, " "), 0));
    if (S.quote) {
      var ev = S.items.find(function (n) { return n.quote_id === S.quote; });
      var x = h("button", { type: "button", cls: "ibx-chip is-ev", "data-clear-ev": "1", "aria-label": "Show every event" },
        [(ev ? [ev.event_code, ev.event_title].filter(Boolean).join(" · ") : "One event") + "  ✕"]);
      box.appendChild(x);
    }
  }
  function rowActions(n) {
    var wrap = h("span", { cls: "ibx-ra" });
    var btn = function (act, text, aria) { return h("button", { type: "button", cls: "ibx-ib", "data-act": act, "data-id": n.id, "aria-label": aria + ": " + label(n).text, title: aria }, [text]); };
    if (S.tab === "done") wrap.appendChild(btn("undone", "↩︎", "Back to inbox"));
    else {
      wrap.appendChild(btn(n.unread ? "read" : "unread", n.unread ? "◉" : "○", n.unread ? "Mark read" : "Mark unread"));
      if (S.tab === "snoozed") wrap.appendChild(btn("unsnooze", "⏰✕", "Unsnooze"));
      else wrap.appendChild(btn("snooze", "⏰", "Snooze"));
      wrap.appendChild(btn("done", "✓", "Done"));
    }
    wrap.appendChild(h("button", { type: "button", cls: "ibx-ib ibx-more-btn", "data-menu": n.id, "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "More actions: " + label(n).text, title: "More" }, ["⋯"]));
    return wrap;
  }
  function row(n, i) {
    var L = label(n), href = link(n), now = Date.now();
    var meta = [];
    if (S.by === "day" && (n.event_code || n.event_title)) meta.push([n.event_code, n.event_title].filter(Boolean).join(" · "));
    if (n.returned) meta.push("⏰ Back from snooze");
    if (S.tab === "snoozed" && n.snoozed_until) meta.push("Until " + C.when(n.snoozed_until, now, S.tz).replace(/^now$/, "soon") + ", " + C.clock(new Date(n.snoozed_until).getTime(), S.tz));
    if (S.tab === "done" && n.done_at) meta.push("Done " + C.when(n.done_at, now, S.tz));
    var cb = h("input", { type: "checkbox", cls: "ibx-cb", "data-sel": n.id, "aria-label": "Select: " + L.text });
    cb.checked = !!S.sel[n.id];
    var main = h(href ? "a" : "div", { cls: "ibx-main", href: href || null, "data-open": n.id, tabindex: "-1" }, [
      h("span", { cls: "ibx-chipic", "aria-hidden": "true", text: L.icon || "🔔" }),
      h("span", { cls: "ibx-body" }, [
        h("span", { cls: "ibx-t", text: L.text || "Update" }),
        meta.length ? h("span", { cls: "ibx-p", text: meta.join(" · ") }) : null]),
      h("span", { cls: "ibx-meta" }, [
        h("time", { datetime: new Date(n.sort_at || n.created_at).toISOString(), title: C.ddmmyyyy(new Date(n.sort_at || n.created_at).getTime(), S.tz) + " " + C.clock(new Date(n.sort_at || n.created_at).getTime(), S.tz), text: C.when(n.sort_at || n.created_at, now, S.tz) }),
        n.unread ? h("span", { cls: "ibx-u" }, [h("span", { cls: "ibx-sr", text: "Unread" })]) : null])]);
    return h("div", { cls: "ibx-row " + groupClass(n) + (n.unread ? " is-unread" : "") + (S.sel[n.id] ? " is-sel" : ""), "data-id": n.id, "data-i": i, tabindex: i === Math.max(0, S.focus) ? "0" : "-1", role: "listitem", "aria-label": (n.unread ? "Unread: " : "") + L.text }, [cb, main, rowActions(n)]);
  }
  function render() {
    renderTabs(); renderChips();
    var list = $("#ibxList"); clear(list);
    var secs = C.sections(S.items, { by: S.by, now: Date.now(), tz: S.tz }), i = 0;
    if (!secs.length) {
      var t = C.emptyText(S.tab, S.filter || S.quote);
      list.appendChild(h("div", { cls: "ibx-empty" }, [h("span", { cls: "ibx-art", "aria-hidden": "true", text: S.tab === "snoozed" ? "⏰" : S.tab === "done" ? "✓" : "🔔" }), h("b", { text: t[0] }), h("span", { text: t[1] })]));
    }
    secs.forEach(function (s) {
      var head = h("div", { cls: "ibx-sec-h" }, [h("span", { cls: "ibx-sec-t", text: s.title }), s.sub ? h("span", { cls: "ibx-sec-s", text: s.sub }) : null,
        s.unread ? h("span", { cls: "ibx-sec-n", text: s.unread + " unread" }) : null, h("span", { cls: "ibx-sp" }),
        s.quote_id && S.tab !== "done" && s.unread ? h("button", { type: "button", cls: "ibx-link", "data-read-ev": s.quote_id, text: "Mark read" }) : null,
        s.quote_id && !S.quote ? h("button", { type: "button", cls: "ibx-link", "data-only-ev": s.quote_id, text: "Only this event" }) : null,
        s.quote_id ? h("a", { cls: "ibx-link", href: "event.html?id=" + encodeURIComponent(s.quote_id), text: "Open event" }) : null]);
      var ul = h("div", { cls: "ibx-rows", role: "list", "aria-label": s.title });
      s.items.forEach(function (n) { ul.appendChild(row(n, i++)); });
      list.appendChild(h("section", { cls: "ibx-sec", "aria-label": s.title }, [head, ul]));
    });
    $("#ibxMore").hidden = !S.cursor;
    if (S.focus >= i) S.focus = i - 1;
    renderBulk();
    renderMailLabel();
  }
  function renderBulk() {
    var ids = selIds(), bar = $("#ibxBulk");
    bar.hidden = !ids.length;
    $("#ibxSelN").textContent = ids.length ? ids.length + " selected" : "";
    var shown = S.items.length, all = $("#ibxSelAll");
    all.checked = shown > 0 && ids.length >= shown; all.indeterminate = ids.length > 0 && ids.length < shown;
    var d = bar.querySelector('[data-bulk="done"]'); d.textContent = S.tab === "done" ? "Back to inbox" : "Done";
    bar.querySelector('[data-bulk="snooze"]').hidden = S.tab === "done";
    doc.documentElement.classList.toggle("ibx-has-sel", ids.length > 0);
  }
  function renderMailLabel() {
    var st = S.settings; if (!st) return;
    var m = st.email_enabled === false ? "off" : st.mode;
    $("#ibxMailLbl").textContent = "E-mail: " + C.digestLabel(m);
  }
  function focusRow(i, scroll) {
    var rows = flat(); if (!rows.length) { S.focus = -1; return; }
    i = Math.max(0, Math.min(rows.length - 1, i)); S.focus = i;
    rows.forEach(function (r, j) { r.tabIndex = j === i ? 0 : -1; r.classList.toggle("is-focus", j === i); });
    try { rows[i].focus({ preventScroll: !scroll }); if (scroll) rows[i].scrollIntoView({ block: "nearest" }); } catch (e) {}
  }
  function itemById(id) { return S.items.find(function (n) { return n.id === id; }) || null; }

  // ---- actions ----
  var UNDO = { read: "unread", unread: "read", done: "undone", undone: "done", snooze: "unsnooze", unsnooze: null };
  async function act(ids, action, opts, quiet) {
    ids = (ids || []).filter(Boolean); if (!ids.length) return;
    try {
      var r = await BPStore.inbox.act(ids, action, opts);
      if (r && r.counts) S.counts = r.counts;
    } catch (e) { toast(errText(e, "update the notifications"), null, "err"); return; }
    var n = ids.length, what = n === 1 ? "1 notification" : n + " notifications";
    var undo = UNDO[action];
    var msg = { read: "Marked read", unread: "Marked unread", done: "Done - " + what + " moved to Done", undone: "Back in your inbox",
                snooze: "Snoozed " + what + (r && r.snoozed_until ? " until " + C.ddmmyyyy(new Date(r.snoozed_until).getTime(), S.tz) + ", " + C.clock(new Date(r.snoozed_until).getTime(), S.tz) : ""),
                unsnooze: "Snooze cancelled" }[action];
    if (action !== "read" && action !== "unread") ids.forEach(function (id) { delete S.sel[id]; });
    await load(false);
    if (!quiet) toast(msg, undo ? function () {
      // undo a snooze = unsnooze; undo an unsnooze is not offered (the old time is gone)
      act(ids, undo, null, true);
    } : null);
  }
  async function readAll(quote) {
    try { var r = quote ? await BPStore.inbox.readAll(null, quote) : await BPStore.inbox.readAll(S.filter || null, S.quote); if (r && r.counts) S.counts = r.counts; }
    catch (e) { toast(errText(e, "mark these read"), null, "err"); return; }
    await load(false); toast("Marked read");
  }
  function openRow(id) {
    var n = itemById(id); if (!n) return;
    var href = link(n);
    var p = n.unread ? BPStore.inbox.act([id], "read").catch(function () {}) : Promise.resolve();
    if (!href) { p.then(function () { load(false); }); return; }
    Promise.race([p, new Promise(function (res) { setTimeout(res, 700); })]).then(function () { location.assign(href); });
  }

  // ---- menus (row "more" + snooze) ----
  var menu = null;
  function closeMenu() { if (!menu) return null; var b = menu.__btn; menu.remove(); menu = null; if (b) b.setAttribute("aria-expanded", "false"); return b; }
  function openMenu(anchor, items) {
    closeMenu();
    var m = h("div", { cls: "ibx-menu", role: "menu" });
    items.forEach(function (it) {
      if (it === "-") { m.appendChild(h("div", { cls: "ibx-menu-sep", role: "separator" })); return; }
      var b = h("button", { type: "button", role: "menuitem" }, [h("span", { text: it.label }), it.hint ? h("small", { text: it.hint }) : null]);
      b.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); closeMenu(); it.run(); });
      m.appendChild(b);
    });
    m.__btn = anchor; anchor.setAttribute("aria-expanded", "true");
    doc.body.appendChild(m);
    var r = anchor.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = window.innerHeight;
    if (vw <= 640) { m.classList.add("is-sheet"); }
    else {
      var w = m.offsetWidth || 240, top = r.bottom + 6, left = Math.min(vw - w - 12, Math.max(12, r.right - w));
      if (top + m.offsetHeight > vh - 8) top = Math.max(8, r.top - m.offsetHeight - 6);
      m.style.top = top + "px"; m.style.left = left + "px";
    }
    menu = m;
    try { m.querySelector("button").focus(); } catch (e) {}
  }
  function snoozeItems(ids) {
    return C.snoozeChoices(Date.now(), S.tz).map(function (c) {
      return { label: c.label, hint: c.hint, run: function () { if (c.preset === "custom") customSnooze(ids); else act(ids, "snooze", { preset: c.preset }); } };
    });
  }
  function rowMenu(btn, id) {
    var n = itemById(id); if (!n) return;
    var items = [];
    if (S.tab === "done") items.push({ label: "Back to inbox", run: function () { act([id], "undone"); } });
    else {
      items.push({ label: n.unread ? "Mark read" : "Mark unread", hint: "u", run: function () { act([id], n.unread ? "read" : "unread"); } });
      items.push({ label: "Done", hint: "e", run: function () { act([id], "done"); } });
      if (S.tab === "snoozed") items.push({ label: "Unsnooze", run: function () { act([id], "unsnooze"); } });
      items.push("-");
      snoozeItems([id]).forEach(function (x) { x.label = "Snooze: " + x.label; items.push(x); });
    }
    if (n.quote_id) { items.push("-"); items.push({ label: "Only this event", run: function () { S.quote = n.quote_id; S.cursor = null; writeUrl(); load(false); } }); }
    openMenu(btn, items);
  }
  function customSnooze(ids) {
    var dlg = $("#ibxSnoozeDlg"), inp = $("#ibxSnoozeAt"), msg = $("#ibxSnoozeMsg");
    var d = new Date(Date.now() + 86400000); d.setMinutes(0, 0, 0);
    var pad = function (x) { return ("0" + x).slice(-2); };
    inp.value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":00";
    var now = new Date(Date.now() + 120000), max = new Date(Date.now() + 180 * 86400000);
    inp.min = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) + "T" + pad(now.getHours()) + ":" + pad(now.getMinutes());
    inp.max = max.getFullYear() + "-" + pad(max.getMonth() + 1) + "-" + pad(max.getDate()) + "T23:59";
    msg.textContent = "";
    dlg.__ids = ids;
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    try { inp.focus(); } catch (e) {}
  }

  // ---- e-mail settings dialog ----
  async function openMail() {
    var dlg = $("#ibxMailDlg"), st = S.settings;
    try { st = (await BPStore.inbox.settings()) || st; } catch (e) {}
    if (!st) return;
    S.settings = st;
    var mine = st.mine || "default";
    Array.prototype.forEach.call(dlg.querySelectorAll('input[name="ibxMode"]'), function (r) { r.checked = r.value === mine; });
    $("#ibxModeDef").textContent = "(" + C.digestLabel(st.studio_default) + ")";
    var hr = Number(st.digest_hour); var hrs = isFinite(hr) ? ((hr % 12) || 12) + ":00 " + (hr < 12 ? "am" : "pm") : "8:00 am";
    $("#ibxModeDaily").textContent = "Every morning around " + hrs + " (studio time), the items unread for " + (Number(st.digest_min_age_minutes) || 60) + "+ minutes. Never an item twice.";
    var warn = $("#ibxMailWarn"), w = [];
    if (st.email_enabled === false) w.push("Your studio has inbox e-mails switched off in Settings → Notifications, so nothing is sent right now.");
    if (st.has_email === false) w.push("Your profile has no e-mail address.");
    warn.textContent = w.join(" "); warn.hidden = !w.length;
    $("#ibxMailMsg").textContent = "";
    try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
  }
  async function saveMail() {
    var dlg = $("#ibxMailDlg"), pick = dlg.querySelector('input[name="ibxMode"]:checked'), msg = $("#ibxMailMsg");
    if (!pick) { msg.textContent = "Choose one option."; return; }
    var run = async function () {
      try { S.settings = await BPStore.inbox.setDigest(pick.value === "default" ? null : pick.value); renderMailLabel(); dlg.close(); toast("E-mail setting saved"); }
      catch (e) { msg.textContent = errText(e, "save your e-mail setting"); }
    };
    if (window.BPUI && BPUI.guard) return BPUI.guard($("#ibxMailSave"), run, { busyLabel: "Saving…" });
    return run();
  }

  // ---- wiring ----
  function wire() {
    $("#ibxTabs").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".ibx-tab"); if (!b) return;
      S.tab = b.getAttribute("data-tab"); S.cursor = null; S.sel = {}; S.focus = -1; writeUrl(); load(false);
    });
    $("#ibxTabs").addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      var i = TABS.indexOf(S.tab) + (e.key === "ArrowRight" ? 1 : -1); i = (i + TABS.length) % TABS.length;
      e.preventDefault(); S.tab = TABS[i]; S.cursor = null; S.sel = {}; writeUrl(); load(false).then(function () { try { $("#ibxTab-" + S.tab).focus(); } catch (x) {} });
    });
    $("#ibxChips").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".ibx-chip"); if (!b) return;
      if (b.hasAttribute("data-clear-ev")) S.quote = null; else S.filter = b.getAttribute("data-f") || "";
      S.cursor = null; writeUrl(); load(false);
    });
    var gb = $("#ibxGroupBy"); gb.value = S.by;
    gb.addEventListener("change", function () { S.by = gb.value === "day" ? "day" : "event"; lsSet("helm.inbox.by", S.by); render(); });
    $("#ibxSelAll").addEventListener("change", function (e) {
      var on = e.target.checked; S.sel = {}; if (on) S.items.forEach(function (n) { S.sel[n.id] = 1; }); render();
    });
    $("#ibxReadAll").addEventListener("click", function () { readAll(null); });
    $("#ibxMore").addEventListener("click", function () { load(true); });
    $("#ibxMail").addEventListener("click", openMail);
    $("#ibxMailSave").addEventListener("click", saveMail);
    $("#ibxMailCancel").addEventListener("click", function () { $("#ibxMailDlg").close(); });
    $("#ibxSnoozeCancel").addEventListener("click", function () { $("#ibxSnoozeDlg").close(); });
    $("#ibxSnoozeOk").addEventListener("click", function () {
      var dlg = $("#ibxSnoozeDlg"), v = $("#ibxSnoozeAt").value, t = v ? new Date(v) : null;
      if (!t || isNaN(t.getTime()) || t.getTime() < Date.now() + 60000) { $("#ibxSnoozeMsg").textContent = "Pick a time in the future."; return; }
      if (t.getTime() > Date.now() + 180 * 86400000) { $("#ibxSnoozeMsg").textContent = "Pick a time within the next 6 months."; return; }
      dlg.close(); act(dlg.__ids || [], "snooze", { until: t });
    });
    $("#ibxBulk").addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-bulk]"); if (!b) return;
      var k = b.getAttribute("data-bulk"), ids = selIds();
      if (k === "clear") { S.sel = {}; render(); return; }
      if (k === "snooze") { openMenu(b, snoozeItems(ids)); return; }
      if (k === "done" && S.tab === "done") k = "undone";
      act(ids, k);
    });
    var list = $("#ibxList");
    list.addEventListener("change", function (e) {
      var cb = e.target.closest && e.target.closest("[data-sel]"); if (!cb) return;
      var id = cb.getAttribute("data-sel"); if (cb.checked) S.sel[id] = 1; else delete S.sel[id];
      var r = cb.closest(".ibx-row"); if (r) r.classList.toggle("is-sel", cb.checked);
      renderBulk();
    });
    list.addEventListener("click", function (e) {
      var t = e.target;
      var ab = t.closest && t.closest("[data-act]");
      if (ab) { e.preventDefault(); var id = ab.getAttribute("data-id"), a = ab.getAttribute("data-act");
        if (a === "snooze") openMenu(ab, snoozeItems([id])); else act([id], a); return; }
      var mb = t.closest && t.closest("[data-menu]");
      if (mb) { e.preventDefault(); if (mb.getAttribute("aria-expanded") === "true") closeMenu(); else rowMenu(mb, mb.getAttribute("data-menu")); return; }
      var re = t.closest && t.closest("[data-read-ev]"); if (re) { readAll(re.getAttribute("data-read-ev")); return; }
      var oe = t.closest && t.closest("[data-only-ev]"); if (oe) { S.quote = oe.getAttribute("data-only-ev"); S.cursor = null; writeUrl(); load(false); return; }
      var op = t.closest && t.closest("a[data-open]");
      if (op) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) { BPStore.inbox.act([op.getAttribute("data-open")], "read").catch(function () {}); return; }
        e.preventDefault(); openRow(op.getAttribute("data-open")); return;
      }
      var rw = t.closest && t.closest(".ibx-row");
      if (rw && !(t.closest && t.closest("input,button,a"))) { var rows = flat(); focusRow(rows.indexOf(rw), false); }
    });
    doc.addEventListener("click", function (e) { if (menu && !(e.target.closest && (e.target.closest(".ibx-menu") || e.target === menu.__btn))) closeMenu(); });
    doc.addEventListener("keydown", function (e) {
      if (menu && (e.key === "Escape" || e.key === "Esc")) { e.preventDefault(); var b = closeMenu(); try { b && b.focus(); } catch (x) {} return; }
      if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        var bs = Array.prototype.slice.call(menu.querySelectorAll("button")), i = bs.indexOf(doc.activeElement);
        e.preventDefault(); var nx = bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length]; if (nx) nx.focus(); return;
      }
      var tg = e.target, tag = tg && tg.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (tg && tg.isContentEditable)) return;
      if (doc.querySelector("dialog[open], [aria-modal='true']:not([hidden])") || doc.documentElement.classList.contains("bpb-is-open")) return;
      if (menu) return;
      var a = C.keyAction(e); if (!a) return;
      var rows = flat(), cur = rows[S.focus] || null, id = cur ? cur.getAttribute("data-id") : null;
      var target = selIds().length ? selIds() : (id ? [id] : []);
      if (a === "next" || a === "prev") { if (!rows.length) return; e.preventDefault(); focusRow(S.focus < 0 ? 0 : S.focus + (a === "next" ? 1 : -1), true); return; }
      if (a === "clear") { if (selIds().length) { e.preventDefault(); S.sel = {}; render(); focusRow(S.focus, false); } return; }
      if (!target.length) return;
      e.preventDefault();
      if (a === "done") act(target, S.tab === "done" ? "undone" : "done");
      else if (a === "snooze" && S.tab !== "done") { var anchor = cur ? (cur.querySelector('[data-act="snooze"]') || cur.querySelector("[data-menu]")) : $("#ibxBulkSnooze"); openMenu(anchor || $("#ibxBulkSnooze"), snoozeItems(target)); }
      else if (a === "toggle_read") { var n0 = itemById(target[0]); act(target, n0 && n0.unread ? "read" : "unread"); }
      else if (a === "select" && id) { if (S.sel[id]) delete S.sel[id]; else S.sel[id] = 1; var f = S.focus; render(); focusRow(f, false); }
      else if (a === "open" && id) openRow(id);
    });
    // light refresh: every minute while visible (first page only, nothing selected, no menu open)
    setInterval(function () { if (!doc.hidden && !menu && !selIds().length && !S.cursor && Date.now() - S.lastLoad > 55000 && !doc.querySelector("dialog[open]")) load(false); }, 15000);
    doc.addEventListener("visibilitychange", function () { if (!doc.hidden && Date.now() - S.lastLoad > 30000 && !selIds().length) load(false); });
  }

  async function renderAccount() {
    var box = $("#account"), A = BPStore.auth; if (!A.enabled()) { box.hidden = true; return; }
    box.hidden = false; clear(box);
    var u = A.user();
    if (u) {
      var role = await A.role();
      box.appendChild(h("span", { cls: "role", text: role || "" })); box.appendChild(h("span", { text: u.email || "" }));
      var b = h("button", { type: "button", id: "logoutBtn", text: "Log out" });
      b.addEventListener("click", async function () { await A.signOut(); location.href = "dashboard.html"; }); box.appendChild(b);
    }
  }
  async function start() {
    await BPStore.init(); await renderAccount();
    try { await BPStore.bell.mount($("#bell")); } catch (e) {}
    var A = BPStore.auth;
    if (A.enabled() && A.required() && !A.user()) { location.replace("login.html?next=" + encodeURIComponent(here())); return; }
    if (!C || !BPStore.inbox) { $("#ibxMissing").hidden = false; return; }
    readUrl();
    $("#ibxApp").hidden = false;
    wire();
    await load(false);
    if (location.hash === "#settings") openMail();
  }
  function go() { if (window.BPUI && BPUI.boot) BPUI.boot(start); else start(); }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", go); else go();
})();
