/* delivery-tracker.js (0241, owner r21) - "Deliveries & arrivals" on the event-day page.
 * A planner assigns a delivery / arrival ("120 chairs from Deccan Rentals by 4:30 pm") and, at the bottom of the
 * same form, picks how many reminders and when (e.g. 1 hour before, 30 minutes before, at the time - defaults
 * from Control Center). Helm e-mails the responsible person at those times with a one-tap status link; every
 * reply (on the way / arrived / delayed + new time / problem) shows here live, is kept in the history and is
 * posted by Helm into the event's team chat. Late items are red.
 * Reads / writes only through BPStore.deliveries (RPCs; studio + 'deliveries' area checked in the database).
 * Builds DOM nodes only (no HTML strings). Pure helpers are exported for the node tests. */
(function (global) {
  "use strict";
  var doc = global.document;

  /* ------------------------------------------------------------------ pure helpers (unit-tested) */
  var PRESETS = [1440, 180, 120, 60, 45, 30, 15, 10, 5, 0];
  function offsetLabel(m) {
    m = Math.round(Number(m));
    if (!isFinite(m) || m <= 0) return "At the time";
    if (m % 1440 === 0) return (m / 1440) + (m === 1440 ? " day" : " days") + " before";
    if (m % 60 === 0) return (m / 60) + (m === 60 ? " hour" : " hours") + " before";
    return m + " min before";
  }
  // a clean reminder list: whole minutes 0..1440, unique, latest first, at most 6
  function cleanOffsets(list) {
    var seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (v) {
      var n = Number(v); if (!isFinite(n) || n < 0 || n > 1440 || Math.round(n) !== n || seen[n]) return; seen[n] = 1; out.push(n);
    });
    return out.sort(function (a, b) { return b - a; }).slice(0, 6);
  }
  // minutes from a typed value: "45", "1h", "1.5 h", "2 hours", "at the time" / "0"
  function parseOffset(s) {
    var t = String(s == null ? "" : s).trim().toLowerCase();
    if (!t) return null;
    if (/^(0|at the time|now|on time)$/.test(t)) return 0;
    var m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)?$/.exec(t);
    if (!m) return null;
    var n = Number(m[1]), u = (m[2] || "m").charAt(0);
    var mins = Math.round(u === "h" ? n * 60 : u === "d" ? n * 1440 : n);
    return mins >= 0 && mins <= 1440 ? mins : null;
  }
  // the offset of a time zone at a UTC instant, in minutes (Asia/Kolkata = 330)
  function tzOffsetMin(tz, utcMs) {
    try {
      var f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      var p = {}; f.formatToParts(new Date(utcMs)).forEach(function (x) { p[x.type] = x.value; });
      var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
      return Math.round((asUtc - utcMs) / 60000);
    } catch (e) { return 330; }
  }
  // "2026-10-20" + "16:30" in the studio's zone -> ISO UTC instant; "" when incomplete
  function zonedToIso(date, time, tz) {
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || "")), t = /^(\d{2}):(\d{2})$/.exec(String(time || ""));
    if (!d || !t) return "";
    var guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2], 0);
    var off = tzOffsetMin(tz, guess), ms = guess - off * 60000, off2 = tzOffsetMin(tz, ms);
    if (off2 !== off) ms = guess - off2 * 60000;
    return new Date(ms).toISOString();
  }
  // ISO instant -> { date: "yyyy-mm-dd", time: "hh:mm" } in the studio's zone
  function isoToZoned(iso, tz) {
    var ms = Date.parse(iso); if (!isFinite(ms)) return { date: "", time: "" };
    var z = new Date(ms + tzOffsetMin(tz, ms) * 60000), pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return { date: z.getUTCFullYear() + "-" + pad(z.getUTCMonth() + 1) + "-" + pad(z.getUTCDate()), time: pad(z.getUTCHours()) + ":" + pad(z.getUTCMinutes()) };
  }
  var OPEN = { scheduled: 1, reminded: 1, confirmed: 1, delayed: 1 };
  // late = still open and the due time (or the promised new time) has passed
  function isLate(row, nowMs) {
    if (!row || !OPEN[row.status]) return false;
    var t = Date.parse(row.eta_at || row.due_at); return isFinite(t) && t < (nowMs == null ? Date.now() : nowMs);
  }
  function itemText(row) {
    var q = Number(row && row.qty);
    return String((row && row.what) || "") + (q > 0 ? " ×" + q.toLocaleString("en-IN") : "");
  }
  // board summary: "2 / 5 arrived · 1 late"
  function summary(rows, nowMs) {
    var live = (rows || []).filter(function (r) { return r.status !== "cancelled"; });
    if (!live.length) return "";
    var arr = live.filter(function (r) { return r.status === "arrived"; }).length, late = live.filter(function (r) { return isLate(r, nowMs); }).length;
    return arr + " / " + live.length + " arrived" + (late ? " · " + late + " late" : "");
  }
  // prefill from the URL (Resource plan / shortage "Schedule delivery" link): ?deliver=1&vendor=<uuid>&what=&qty=
  function prefillFromSearch(search) {
    var p = new URLSearchParams(String(search || "")); if (p.get("deliver") !== "1") return null;
    var v = String(p.get("vendor") || ""), q = Number(p.get("qty"));
    return { party_kind: "vendor", vendor_id: /^[0-9a-f-]{36}$/i.test(v) ? v : null, what: String(p.get("what") || "").slice(0, 200),
             qty: q > 0 && q <= 1000000 ? q : null, source: p.get("src") === "shortage" ? "shortage" : "resource" };
  }

  var api = { offsetLabel: offsetLabel, cleanOffsets: cleanOffsets, parseOffset: parseOffset, tzOffsetMin: tzOffsetMin,
    zonedToIso: zonedToIso, isoToZoned: isoToZoned, isLate: isLate, itemText: itemText, summary: summary,
    prefillFromSearch: prefillFromSearch, PRESETS: PRESETS };
  global.HelmDelivery = api;
  if (!doc) return;

  /* ------------------------------------------------------------------ DOM */
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); }
  function S() { return global.BPStore; }
  function U() { return global.BPUI; }
  function toast(msg, type) { try { U().toast(msg, { type: type || "info" }); } catch (e) {} }
  function friendly(e, action) { try { return U().friendlyError(e, { action: action }); } catch (x) { return (e && e.message) || "Something went wrong."; } }

  var state = { host: null, quoteId: null, canEdit: false, cfg: null, rows: [], open: {} };

  // ---- the reminders editor (assignment form bottom + Control Center defaults) ----
  function offsetsEditor(initial, o) {
    o = o || {};
    var list = cleanOffsets(initial);
    var chips = h("div", { cls: "dlv-chips", role: "list", "aria-label": "Reminder times" });
    var sel = h("select", { "aria-label": "Add a reminder time", cls: "dlv-addsel" }, [h("option", { value: "", text: "+ Add a reminder…" })]
      .concat(PRESETS.map(function (m) { return h("option", { value: String(m), text: offsetLabel(m) }); }))
      .concat([h("option", { value: "custom", text: "Other time…" })]));
    var count = h("span", { cls: "dlv-count", "aria-live": "polite" });
    function paint() {
      clear(chips);
      if (!list.length) chips.appendChild(h("span", { cls: "dlv-none", text: o.emptyText || "No reminders" }));
      list.forEach(function (m) {
        var x = h("button", { type: "button", cls: "dlv-chipx", "aria-label": "Remove " + offsetLabel(m), text: "✕" });
        x.addEventListener("click", function () { list = list.filter(function (v) { return v !== m; }); paint(); });
        chips.appendChild(h("span", { cls: "dlv-chip", role: "listitem" }, [offsetLabel(m), x]));
      });
      count.textContent = list.length ? list.length + (list.length === 1 ? " reminder" : " reminders") : "";
      sel.disabled = list.length >= 6;
    }
    sel.addEventListener("change", async function () {
      var v = sel.value; sel.value = ""; if (!v) return;
      var m = v === "custom" ? null : Number(v);
      if (v === "custom") {
        var ans = null;
        try { ans = await U().prompt("Minutes before the due time (0 = at the time; up to 1440, e.g. 90 or 1.5h):", { title: "Reminder time" }); } catch (e) { ans = null; }
        m = parseOffset(ans); if (ans != null && m == null) { toast("Use minutes (0-1440), e.g. 90 or 1.5h.", "err"); return; }
      }
      if (m == null) return;
      list = cleanOffsets(list.concat([m])); paint();
    });
    paint();
    var el = h("div", { cls: "dlv-offsets" }, [chips, h("div", { cls: "dlv-addrow" }, [sel, count])]);
    return { el: el, get: function () { return list.slice(); }, set: function (v) { list = cleanOffsets(v); paint(); } };
  }
  api.offsetsEditor = offsetsEditor;

  // ---- the assignment dialog ----
  var people = null;
  async function loadPeople() {
    if (people) return people;
    var st = S(), r = await Promise.all([
      (st.vendors && st.vendors.listAll ? st.vendors.listAll(false) : Promise.resolve([])).catch(function () { return []; }),
      (st.staff && st.staff.list ? st.staff.list(false) : Promise.resolve([])).catch(function () { return []; }),
      (st.auth && st.auth.admin && st.auth.admin.listUsers ? st.auth.admin.listUsers() : Promise.resolve([])).catch(function () { return []; })]);
    people = { vendor: r[0] || [], staff: r[1] || [], user: (r[2] || []).filter(function (u) { return u.role !== "client"; }) };
    return people;
  }
  function personName(kind, p) { return kind === "user" ? (p.full_name || p.email || "User") : (p.name || ""); }

  function openDialog(row, prefill) {
    row = row || null; prefill = prefill || {};
    var cfg = state.cfg || {}, tz = cfg.timezone || "Asia/Kolkata", src = row || prefill;
    var kindSel = h("select", { id: "dlv_kind", "aria-label": "Who is responsible" }, [["vendor", "A vendor"], ["staff", "A staff member"], ["user", "A studio user"], ["other", "Someone else"]]
      .map(function (k) { return h("option", { value: k[0], text: k[1] }); }));
    kindSel.value = src.party_kind || "vendor";
    var pickSel = h("select", { id: "dlv_pick", "aria-label": "Pick the person" }, [h("option", { value: "", text: "Loading…" })]);
    var name = h("input", { id: "dlv_name", maxlength: "120", placeholder: "Name", "aria-label": "Name", value: src.party_name || "" });
    var email = h("input", { id: "dlv_email", type: "email", maxlength: "200", placeholder: "name@example.com", "aria-label": "E-mail for reminders", value: src.contact_email || "" });
    var what = h("input", { id: "dlv_what", maxlength: "200", placeholder: "e.g. Chairs", "aria-required": "true", value: src.what || "" });
    var qty = h("input", { id: "dlv_qty", type: "number", min: "1", step: "1", inputmode: "numeric", placeholder: "Qty", value: src.qty == null ? "" : String(src.qty) });
    var z = row ? isoToZoned(row.due_at, tz) : { date: "", time: "" };
    var date = h("input", { id: "dlv_date", type: "date", "aria-required": "true", value: z.date });
    var time = h("input", { id: "dlv_time", type: "time", "aria-required": "true", value: z.time });
    var note = h("input", { id: "dlv_note", maxlength: "500", placeholder: "Where to unload, gate, contact on site…", value: (row && row.note) || "" });
    var remOn = h("input", { type: "checkbox", id: "dlv_rem_on" }); remOn.checked = row ? row.reminders_on !== false : true;
    var ed = offsetsEditor(row ? (row.offsets || row.offsets_effective || cfg.offsets) : (cfg.offsets || [60, 30, 0]), { emptyText: "No reminders for this one" });
    var err = h("p", { cls: "dlv-err", role: "alert", hidden: true });
    var off = cfg.enabled === false;
    var kinds = cfg.ping_kinds || ["vendor", "staff", "user"];
    var hint = h("p", { cls: "dlv-hint" });
    function paintHint() {
      var k = kindSel.value;
      hint.textContent = off ? "Reminders are switched off for the studio (Control Center → Notifications). The delivery is still tracked here."
        : kinds.indexOf(k) < 0 ? "Your studio does not e-mail this kind of person (Control Center). The delivery is still tracked here."
        : "Each reminder e-mails a one-tap link to reply On the way / Arrived / Delayed / Problem - no sign-in. Replies show here and in the event's team chat.";
    }
    async function paintPick() {
      var k = kindSel.value; clear(pickSel);
      pickSel.hidden = k === "other";
      if (k === "other") { paintHint(); return; }
      pickSel.appendChild(h("option", { value: "", text: "Loading…" }));
      var pp = await loadPeople(); clear(pickSel);
      var list = pp[k] || [];
      pickSel.appendChild(h("option", { value: "", text: list.length ? "Pick " + (k === "vendor" ? "a vendor" : k === "staff" ? "a staff member" : "a user") : "None yet - type a name instead" }));
      list.forEach(function (p) { pickSel.appendChild(h("option", { value: p.id, text: personName(k, p) + (p.category ? " · " + p.category : "") })); });
      var cur = k === "vendor" ? src.vendor_id : k === "staff" ? src.crew_id : src.user_id;
      if (cur && kindSel.value === (src.party_kind || "vendor")) pickSel.value = cur;
      paintHint();
    }
    pickSel.addEventListener("change", function () {
      var k = kindSel.value, p = ((people && people[k]) || []).filter(function (x) { return x.id === pickSel.value; })[0];
      if (p) { name.value = personName(k, p); email.value = String(p.email || "").toLowerCase(); }
    });
    kindSel.addEventListener("change", function () { paintPick(); });
    var save = h("button", { type: "button", cls: "btn primary", text: row ? "Save changes" : "Schedule" });
    var cancel = h("button", { type: "button", cls: "btn", text: "Cancel" });
    var fld = function (label, ctl, forId) { return h("div", { cls: "dlv-fld" }, [h("label", { for: forId, text: label }), ctl]); };
    var sheet = h("div", { cls: "dlv-sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "dlv_title" }, [
      h("h3", { id: "dlv_title", text: row ? "Edit delivery / arrival" : "Schedule a delivery / arrival" }),
      h("div", { cls: "dlv-grid2" }, [fld("What *", what, "dlv_what"), fld("Quantity", qty, "dlv_qty")]),
      h("div", { cls: "dlv-grid2" }, [fld("Who is responsible", kindSel, "dlv_kind"), h("div", { cls: "dlv-fld" }, [h("label", { for: "dlv_pick", text: "Person" }), pickSel])]),
      h("div", { cls: "dlv-grid2" }, [fld("Name", name, "dlv_name"), fld("E-mail for reminders", email, "dlv_email")]),
      h("div", { cls: "dlv-grid2" }, [fld("Due date *", date, "dlv_date"), fld("Due time * (" + tz + ")", time, "dlv_time")]),
      fld("Note for the board", note, "dlv_note"),
      h("fieldset", { cls: "dlv-remset" }, [h("legend", { text: "Reminders" }),
        h("label", { cls: "dlv-chk", for: "dlv_rem_on" }, [remOn, " Remind them before it is due"]), ed.el, hint]),
      err,
      h("div", { cls: "dlv-foot" }, [cancel, save])]);
    var ov = h("div", { cls: "dlv-ov" }, [sheet]);
    doc.body.appendChild(ov);
    var en = null; try { en = U().modal.open(sheet); } catch (e) {}
    function close() { try { U().modal.close(sheet); } catch (e) {} if (ov.parentNode) ov.parentNode.removeChild(ov); }
    cancel.addEventListener("click", close);
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    ov.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    function fail(t, focus) { err.textContent = t; err.hidden = false; if (focus) try { focus.focus(); } catch (e) {} }
    save.addEventListener("click", function () {
      err.hidden = true;
      var w = what.value.trim(); if (!w) return fail("Say what is delivered or who arrives.", what);
      var q = qty.value.trim() === "" ? null : Number(qty.value);
      if (q !== null && !(q > 0 && q <= 1000000)) return fail("Quantity must be above 0.", qty);
      var iso = zonedToIso(date.value, time.value, tz); if (!iso) return fail("Pick the due date and time.", date.value ? time : date);
      var k = kindSel.value, em = email.value.trim().toLowerCase();
      if (em && !/^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(em)) return fail("Enter a valid e-mail (or leave it empty).", email);
      if (!pickSel.value && !name.value.trim()) return fail("Pick or name the responsible person.", k === "other" ? name : pickSel);
      var p = { what: w, qty: q, party_kind: k, party_name: name.value.trim() || null, contact_email: em || null, due_at: iso,
        note: note.value.trim() || null, reminders_on: remOn.checked, offsets: ed.get() };
      if (row) p.id = row.id; else { p.quote_id = state.quoteId; p.source = prefill.source || "command"; }
      if (k === "vendor") p.vendor_id = pickSel.value || null; else if (k === "staff") p.crew_id = pickSel.value || null; else if (k === "user") p.user_id = pickSel.value || null;
      var run = async function () {
        try { await S().deliveries.save(p); close(); toast(row ? "Saved." : "Scheduled" + (remOn.checked && p.offsets.length && !off ? " - " + p.offsets.length + (p.offsets.length === 1 ? " reminder" : " reminders") + " set." : "."), "ok"); await refresh(); }
        catch (e) { fail(friendly(e, "save the delivery")); }
      };
      return U() && U().guard ? U().guard(save, run, { busyLabel: "Saving…" }) : run();
    });
    paintPick(); paintHint();
    setTimeout(function () { try { what.focus(); } catch (e) {} }, 30);
    return en;
  }
  api.openDialog = function (row, prefill) { return openDialog(row, prefill); };

  // ---- the board ----
  var PILL = { scheduled: "dlv-s-sched", reminded: "dlv-s-sched", confirmed: "dlv-s-way", arrived: "dlv-s-ok", delayed: "dlv-s-warn", issue: "dlv-s-bad", cancelled: "dlv-s-off" };
  async function setStatus(btn, row, status) {
    var note = null, eta = null;
    if (status === "delayed") {
      var tz = (state.cfg && state.cfg.timezone) || "Asia/Kolkata";
      var ans = await U().prompt("New expected time (hh:mm, " + tz + ") - and a short reason after a space, e.g. 17:30 truck stuck", { title: "Delayed" });
      if (ans == null) return;
      var m = /^\s*(\d{1,2}):(\d{2})\s*(.*)$/.exec(String(ans));
      if (m) {
        var due = isoToZoned(row.eta_at || row.due_at, tz), hh = ("0" + m[1]).slice(-2);
        var iso = zonedToIso(due.date, hh + ":" + m[2], tz);
        if (iso && Date.parse(iso) < Date.now() - 3600000) iso = zonedToIso(isoToZoned(new Date().toISOString(), tz).date, hh + ":" + m[2], tz);
        eta = iso || null; note = m[3] || null;
      } else note = String(ans).trim() || null;
    } else if (status === "issue") {
      note = await U().prompt("What is the problem?", { title: "Problem" }); if (note == null || !String(note).trim()) return;
    } else if (status === "cancelled") {
      if (!(await U().confirm("Cancel “" + itemText(row) + "”? Reminders stop; the history is kept.", { title: "Cancel delivery?", danger: true, okLabel: "Cancel delivery" }))) return;
    }
    var run = async function () {
      try { await S().deliveries.setStatus(row.id, status, note, eta); await refresh(); }
      catch (e) { toast(friendly(e, "update the delivery"), "err"); }
    };
    return U().guard(btn, run);
  }
  async function copyLink(btn, row) {
    return U().guard(btn, async function () {
      try {
        var r = await S().deliveries.issueLink(row.id), url = S().deliveries.linkUrl(r && r.token);
        if (!url) throw new Error("No link");
        try { await navigator.clipboard.writeText(url); toast("Status link copied - valid until " + (r.expires_text || "the day after") + ". Share it with " + (row.party_name || "them") + ".", "ok"); }
        catch (e) { await U().alert(url, { title: "Status link (copy it)" }); }
      } catch (e) { toast(friendly(e, "make the link"), "err"); }
    });
  }
  async function toggleHistory(row, box) {
    if (state.open[row.id]) { delete state.open[row.id]; clear(box); box.hidden = true; return; }
    state.open[row.id] = 1; box.hidden = false; clear(box); box.appendChild(h("p", { cls: "dlv-muted", text: "Loading…" }));
    try {
      var r = await S().deliveries.history(row.id); clear(box);
      var ul = h("ol", { cls: "dlv-hist" });
      (r.log || []).forEach(function (l) {
        ul.appendChild(h("li", {}, [h("b", { text: S().deliveries.statusLabel(l.status) }), " · " + (l.at_text || "") + " · " + (l.actor || ""),
          l.eta_text ? " · new time " + l.eta_text : "", l.note ? h("span", { cls: "dlv-note", text: " “" + l.note + "”" }) : null]));
      });
      var sent = (r.reminders || []).filter(function (x) { return x.status === "sent" && x.to === "party"; }).length;
      box.appendChild(ul);
      box.appendChild(h("p", { cls: "dlv-muted", text: sent ? sent + (sent === 1 ? " reminder e-mail sent." : " reminder e-mails sent.") : "No reminder e-mail sent yet." }));
    } catch (e) { clear(box); box.appendChild(h("p", { cls: "dlv-err", text: friendly(e, "load the history") })); }
  }
  function rowEl(row) {
    var late = isLate(row);
    var who = [row.party_name || "-", row.party_kind === "staff" ? "staff" : row.party_kind === "user" ? "team" : row.party_kind === "other" ? "" : "vendor"].filter(Boolean).join(" · ");
    var when = "Due " + (row.due_text || "") + (row.eta_text && row.status === "delayed" ? " → new time " + row.eta_text : "");
    var last = (row.status_by ? "by " + row.status_by : "");
    var hist = h("div", { cls: "dlv-histbox", hidden: true });
    var acts = null;
    if (state.canEdit && row.status !== "cancelled") {
      var b = function (label, st, cls) { var x = h("button", { type: "button", cls: "mini " + (cls || ""), text: label, "aria-label": label + ": " + itemText(row) }); x.addEventListener("click", function () { setStatus(x, row, st); }); return x; };
      var edit = h("button", { type: "button", cls: "mini", text: "Edit", "aria-label": "Edit " + itemText(row) });
      edit.addEventListener("click", function () { openDialog(row); });
      var link = h("button", { type: "button", cls: "mini", text: "🔗 Link", title: "Copy the one-tap status link", "aria-label": "Copy status link for " + itemText(row) });
      link.addEventListener("click", function () { copyLink(link, row); });
      acts = h("div", { cls: "dlv-acts" }, [row.status !== "arrived" ? b("On the way", "confirmed") : null, row.status !== "arrived" ? b("Arrived", "arrived", "go") : null,
        row.status !== "arrived" ? b("Delayed", "delayed") : null, b("Problem", "issue", "no"), edit, link, b("✕", "cancelled", "del")]);
    }
    var histBtn = h("button", { type: "button", cls: "dlv-histbtn", "aria-expanded": state.open[row.id] ? "true" : "false", text: "History" });
    histBtn.addEventListener("click", function () { toggleHistory(row, hist).then(function () { histBtn.setAttribute("aria-expanded", state.open[row.id] ? "true" : "false"); }); });
    var rem = row.reminders_on && (row.offsets_effective || []).length ? "⏰ " + (row.offsets_effective || []).map(offsetLabel).join(", ") : "No reminders";
    var el = h("div", { cls: "dlv-row" + (late ? " dlv-late" : "") + (row.status === "cancelled" ? " dlv-off" : ""), "data-id": row.id }, [
      h("div", { cls: "dlv-main" }, [
        h("div", { cls: "dlv-what" }, [itemText(row), h("span", { cls: "dlv-who", text: " · " + who })]),
        h("div", { cls: "dlv-when" }, [when, late ? h("b", { cls: "dlv-latetag", text: " · LATE" }) : null]),
        h("div", { cls: "dlv-meta" }, [rem + (row.reminders_sent ? " · " + row.reminders_sent + " sent" : "") + (last ? " · " + last : ""),
          row.note ? h("span", { cls: "dlv-note", text: " · " + row.note }) : null, " ", histBtn])]),
      h("span", { cls: "dlv-pill " + (PILL[row.status] || "dlv-s-sched"), text: S().deliveries.statusLabel(row.status) }),
      acts, hist]);
    if (state.open[row.id]) { delete state.open[row.id]; toggleHistory(row, hist); }
    return el;
  }
  function paint() {
    var host = state.host; if (!host) return;
    var list = host.querySelector(".dlv-list"), prog = host.querySelector(".dlv-prog"), sub = host.querySelector(".dlv-sub");
    prog.textContent = summary(state.rows);
    var c = state.cfg || {};
    sub.textContent = c.enabled ? "Helm e-mails each person at their reminder times and posts every reply in the event's team chat. Late items turn red."
      : "Track who is bringing what and when. Automatic e-mail reminders are off - an admin can switch them on in Control Center → Notifications.";
    clear(list);
    if (!state.rows.length) { list.appendChild(h("div", { cls: "empty", text: state.canEdit ? "Nothing scheduled yet. Add deliveries and arrivals with their due time." : "Nothing scheduled yet." })); return; }
    state.rows.forEach(function (r) { list.appendChild(rowEl(r)); });
  }
  async function refresh() {
    try { state.rows = await S().deliveries.list(state.quoteId); paint(); }
    catch (e) { var list = state.host && state.host.querySelector(".dlv-list"); if (list) { clear(list); list.appendChild(h("p", { cls: "dlv-err", text: friendly(e, "load the deliveries") })); } }
  }
  api.refresh = function () { return refresh(); };

  // mount the card into `host` (an empty element) for one event; hides itself when the role can't view it
  api.mount = async function (host, o) {
    o = o || {}; if (!host || !S() || !S().deliveries) return false;
    var st = S();
    var cfg = null;
    try { cfg = await st.deliveries.settings(); } catch (e) { cfg = null; }
    if (!cfg) { host.hidden = true; return false; }                       // server older than 0241, or no access
    var canView = true; try { canView = await st.auth.canView("deliveries"); } catch (e) { canView = true; }
    if (!canView) { host.hidden = true; return false; }
    state.host = host; state.quoteId = o.quoteId; state.cfg = cfg;
    state.canEdit = !!cfg.can_schedule; try { state.canEdit = state.canEdit && (await st.auth.canEditArea("deliveries")); } catch (e) {}
    clear(host);
    var add = state.canEdit ? h("button", { type: "button", cls: "btn primary dlv-add", text: "＋ Schedule" }) : null;
    if (add) add.addEventListener("click", function () { openDialog(null); });
    host.appendChild(h("h2", {}, ["🚚 Deliveries & arrivals ", h("span", { cls: "prog dlv-prog" }), add]));
    host.appendChild(h("p", { cls: "sub dlv-sub" }));
    host.appendChild(h("div", { cls: "dlv-list" }, [h("div", { cls: "empty", text: "Loading…" })]));
    host.hidden = false;
    await refresh();
    var pre = prefillFromSearch(global.location && global.location.search);
    if (pre && state.canEdit) {
      if (pre.vendor_id) { try { var pp = await loadPeople(); var v = pp.vendor.filter(function (x) { return x.id === pre.vendor_id; })[0]; if (v) { pre.party_name = v.name; pre.contact_email = String(v.email || "").toLowerCase(); } } catch (e) {} }
      openDialog(null, pre);
    }
    // live: replies arrive while the page is open (every 60 s while visible)
    if (!state.timer) state.timer = setInterval(function () { if (!doc.hidden) refresh(); }, 60000);
    return true;
  };
})(typeof window !== "undefined" ? window : globalThis);
