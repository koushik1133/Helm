/* Event group team picker (0035) — opens the "Create event group" picker IN PLACE on any page
 * (the event workspace uses it so "Create event group" no longer navigates to Quotes).
 * Same behaviour as the Quotes picker: confirmed events only, managers only, admins/owners and
 * the event's assigned staff pre-ticked, then BPStore.chat.eventGroups.create → open the chat.
 * DOM is built with createElement/textContent only (no innerHTML with data). */
(function (global) {
  "use strict";
  var modal = null, people = [], quote = null, onDone = null, stay = false;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function nm(p) { try { if (BPStore.chat.displayName) return BPStore.chat.displayName(p); } catch (_) {} return p.full_name || p.email || "Member"; }
  function rl(r) { try { return r ? BPStore.auth.admin.roleLabel(r) : ""; } catch (_) { return r || ""; } }
  function ini(n) { var w = String(n || "?").trim().split(/\s+/); return (((w[0] || "")[0] || "?") + ((w[1] || "")[0] || "")).toUpperCase(); }
  function q(sel) { return modal ? modal.querySelector(sel) : null; }
  function build() {
    if (modal) return modal;
    modal = el("div", "lmodal egp-modal"); modal.id = "egpModal"; modal.hidden = true;
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "egp_title");
    var sheet = el("div", "lsheet egp-sheet");
    var h = el("h3", "egp-h"); var t = el("span", null, "💬 Create event group"); t.id = "egp_title";
    var x = el("button", "egp-x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.setAttribute("data-close", "");
    h.appendChild(t); h.appendChild(x); sheet.appendChild(h);
    sheet.appendChild(el("p", "muted egp-sub", "A team chat for this event. Helm posts the event details — client contact, date, venue, guests, layout, menu and notes. Never prices or payments. You can add more people later."));
    var lab = el("label", null, "Add people"); lab.setAttribute("for", "egp_search"); sheet.appendChild(lab);
    var s = el("input"); s.id = "egp_search"; s.type = "search"; s.placeholder = "Search your team…"; s.autocomplete = "off"; sheet.appendChild(s);
    var list = el("div", "egp-list"); list.id = "egp_list"; sheet.appendChild(list);
    var err = el("div", "lerr"); err.id = "egp_err"; err.setAttribute("role", "alert"); err.hidden = true; sheet.appendChild(err);
    var btns = el("div", "egp-btns");
    var cancel = el("button", "btn", "Cancel"); cancel.type = "button";
    var go = el("button", "btn primary", "Create group"); go.type = "button"; go.id = "egp_create";
    btns.appendChild(cancel); btns.appendChild(go); sheet.appendChild(btns);
    modal.appendChild(sheet); document.body.appendChild(modal);
    x.addEventListener("click", close); cancel.addEventListener("click", close);
    modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal && !modal.hidden) close(); });
    s.addEventListener("input", function () { draw(s.value, null); });
    go.addEventListener("click", function () { BPUI.guard(go, create, { busyLabel: "Creating…" }); });
    return modal;
  }
  function draw(filterText, pre) {
    var list = q("#egp_list"); var f = String(filterText || "").toLowerCase().trim();
    var checked = pre ? new Set(pre) : new Set(Array.prototype.map.call(list.querySelectorAll("input:checked"), function (i) { return i.value; }));
    var rows = people.filter(function (p) { return !f || nm(p).toLowerCase().indexOf(f) >= 0; });
    list.textContent = "";
    if (!rows.length) list.appendChild(el("div", "muted egp-empty", people.length ? "Nobody matches." : "No teammates yet — you can create the group and add people later."));
    rows.forEach(function (p) {
      var l = el("label", "egp-row"); var i = el("input"); i.type = "checkbox"; i.value = p.id; i.checked = checked.has(p.id);
      var av = el("span", "egav", ini(nm(p))); av.setAttribute("aria-hidden", "true"); if (p.avatar_path) av.setAttribute("data-avatar-path", p.avatar_path);
      l.appendChild(i); l.appendChild(av); l.appendChild(el("span", null, nm(p))); l.appendChild(el("span", "egp-rl", p.job_title || rl(p.role)));
      list.appendChild(l);
    });
    // keep hidden (filtered-out) selections
    checked.forEach(function (id) { if (!rows.some(function (p) { return p.id === id; })) { var i = el("input"); i.type = "checkbox"; i.value = id; i.checked = true; i.hidden = true; list.appendChild(i); } });
    try { BPStore.chat.paintAvatars(list); } catch (_) {}
  }
  function close() { if (modal) modal.hidden = true; quote = null; }
  async function create() {
    var qq = quote; if (!qq) return;
    var ids = Array.from(new Set(Array.prototype.map.call(q("#egp_list").querySelectorAll("input:checked"), function (i) { return i.value; })));
    try {
      var cid = await BPStore.chat.eventGroups.create(qq.id, ids);
      var g = null; try { g = (await BPStore.chat.eventGroups.index())[qq.id] || null; } catch (_) {}
      close();
      if (g && !g.is_member) { BPUI.toast("This event already has a group. Ask someone in it to add you.", { type: "info" }); if (onDone) onDone(g); return; }
      // opts.stay (event workspace): stay on the page — it re-renders "Open event group"
      if (stay && onDone) { BPUI.toast("Event group created. Use Open event group to chat with the team.", { type: "ok" }); onDone(g || { conversation_id: cid, is_member: true }); return; }
      location.href = "chat.html?c=" + encodeURIComponent((g && g.conversation_id) || cid);
    } catch (e) { var er = q("#egp_err"); er.textContent = BPUI.friendlyError(e, { action: "create the event group" }); er.hidden = false; }
  }
  // open(quote, {canEdit, onDone}) — quote needs id, code, status
  async function open(qt, opts) {
    opts = opts || {}; onDone = opts.onDone || null; stay = !!opts.stay;
    if (!qt || !qt.id) return;
    if (qt.status !== "confirmed") { BPUI.toast("Confirm this quote before creating its event group.", { type: "info" }); return; }
    if (!opts.canEdit) { BPUI.toast("Ask an admin or manager to create this event's group.", { type: "info" }); return; }
    var me = null; try { me = (BPStore.auth.user() || {}).id || (await BPStore.chat.me()).id; } catch (_) {}
    try { people = (await BPStore.chat.roster()).filter(function (p) { return p.id && p.id !== me; }); } catch (_) { people = []; }
    var crew = new Set(); try { (await BPStore.staff.forEvent(qt.id)).forEach(function (s) { if (s.name) crew.add(String(s.name).trim().toLowerCase()); }); } catch (_) {}
    var low = function (p) { return String(p.full_name || "").trim().toLowerCase(); };
    var pre = people.filter(function (p) { return p.role === "owner" || p.role === "admin" || (low(p) && crew.has(low(p))); }).map(function (p) { return p.id; });
    build(); quote = qt;
    q("#egp_err").hidden = true; q("#egp_search").value = "";
    q("#egp_title").textContent = "💬 Event group · " + (qt.code || "");
    draw("", pre); modal.hidden = false;
    setTimeout(function () { var s = q("#egp_search"); if (s) s.focus(); }, 50);
  }
  global.HelmEventGroupPicker = { open: open, close: close };
})(window);
