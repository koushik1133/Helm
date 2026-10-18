/* Event group people picker (0035 + 0194) — opens IN PLACE on any page (Quotes, the event workspace, the
 * quote flow, the chat). Two modes:
 *   open(quote, {canEdit, stay, onDone})                       "Create event group" (confirmed events, managers)
 *   open(quote, {canEdit, mode:"add", conversationId, onDone}) "Add people" to the existing group (chat page)
 * Lists everyone who can be in an event group: teammates who sign in (chat members), staff, vendors and the
 * client (0194: kept as the group's contacts — name only). Pre-ticks owners / admins and the staff assigned to
 * the event. Saving calls BPStore.chat.eventGroups.create (members who sign in) and then addPeople (everyone
 * ticked — also when the group already existed, which used to drop the picks silently). Nothing is sent to
 * anyone: no WhatsApp / SMS / e-mail (in a free trial and outside it).
 * DOM is built with createElement/textContent only (no innerHTML with data). Styles: event-group-picker.css. */
(function (global) {
  "use strict";
  var modal = null, rows = [], quote = null, onDone = null, stay = false, mode = "create", convId = null;
  var KIND_LABEL = { user: "Team", staff: "Staff", vendor: "Vendors", client: "Client" };
  var KIND_NOTE = { user: "signs in to Helm - joins the chat", staff: "staff", vendor: "vendor", client: "client" };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function nm(p) { try { if (BPStore.chat.displayName) return BPStore.chat.displayName(p); } catch (_) {} return p.full_name || p.email || "Member"; }
  function rl(r) { try { return r ? BPStore.auth.admin.roleLabel(r) : ""; } catch (_) { return r || ""; } }
  function ini(n) { var w = String(n || "?").trim().split(/\s+/); return (((w[0] || "")[0] || "?") + ((w[1] || "")[0] || "")).toUpperCase(); }
  function q(sel) { return modal ? modal.querySelector(sel) : null; }
  function val(r) { return r.kind + ":" + (r.id || ""); }
  function build() {
    if (modal) return modal;
    modal = el("div", "egp-layer"); modal.id = "egpModal"; modal.hidden = true;
    modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-labelledby", "egp_title");
    var sheet = el("div", "egp-sheet");
    var h = el("h3", "egp-h"); var t = el("span", null, "💬 Create event group"); t.id = "egp_title";
    var x = el("button", "egp-x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.setAttribute("data-close", "");
    h.appendChild(t); h.appendChild(x); sheet.appendChild(h);
    var sub = el("p", "egp-sub", ""); sub.id = "egp_sub"; sheet.appendChild(sub);
    var lab = el("label", "egp-lab", "Add people"); lab.setAttribute("for", "egp_search"); sheet.appendChild(lab);
    var s = el("input", "egp-search"); s.id = "egp_search"; s.type = "search"; s.placeholder = "Search team, staff, vendors, client…"; s.autocomplete = "off"; sheet.appendChild(s);
    var list = el("div", "egp-list"); list.id = "egp_list"; sheet.appendChild(list);
    var note = el("p", "egp-note", ""); note.id = "egp_note"; sheet.appendChild(note);
    var err = el("div", "egp-err"); err.id = "egp_err"; err.setAttribute("role", "alert"); err.hidden = true; sheet.appendChild(err);
    var btns = el("div", "egp-btns");
    var cancel = el("button", "btn", "Cancel"); cancel.type = "button";
    var go = el("button", "btn primary", "Create group"); go.type = "button"; go.id = "egp_create";
    btns.appendChild(cancel); btns.appendChild(go); sheet.appendChild(btns);
    modal.appendChild(sheet); document.body.appendChild(modal);
    x.addEventListener("click", close); cancel.addEventListener("click", close);
    modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal && !modal.hidden) close(); });
    s.addEventListener("input", function () { draw(s.value, null); });
    go.addEventListener("click", function () { BPUI.guard(go, save, { busyLabel: mode === "add" ? "Adding…" : "Creating…" }); });
    return modal;
  }
  function draw(filterText, pre) {
    var list = q("#egp_list"); var f = String(filterText || "").toLowerCase().trim();
    var checked = pre ? new Set(pre) : new Set(Array.prototype.map.call(list.querySelectorAll("input:checked"), function (i) { return i.value; }));
    var shown = rows.filter(function (r) { return !f || r.name.toLowerCase().indexOf(f) >= 0 || KIND_LABEL[r.kind].toLowerCase().indexOf(f) >= 0; });
    list.textContent = "";
    if (!shown.length) list.appendChild(el("div", "egp-empty", rows.length ? "Nobody matches." : (mode === "add" ? "Everyone is already in this group." : "Nobody to add yet - you can create the group and add people later.")));
    ["user", "staff", "vendor", "client"].forEach(function (k) {
      var part = shown.filter(function (r) { return r.kind === k; }); if (!part.length) return;
      var hd = el("div", "egp-sec", KIND_LABEL[k] + (k === "user" ? " (signs in to Helm)" : "")); hd.setAttribute("role", "presentation"); list.appendChild(hd);
      part.forEach(function (r) {
        var l = el("label", "egp-row"); var i = el("input"); i.type = "checkbox"; i.value = val(r); i.checked = checked.has(val(r));
        var av = el("span", "egav", ini(r.name)); av.setAttribute("aria-hidden", "true"); if (r.avatar_path) av.setAttribute("data-avatar-path", r.avatar_path);
        l.appendChild(i); l.appendChild(av); l.appendChild(el("span", "egp-nm", r.name)); l.appendChild(el("span", "egp-rl", r.sub || ""));
        list.appendChild(l);
      });
    });
    // keep hidden (filtered-out) selections
    checked.forEach(function (v) { if (!shown.some(function (r) { return val(r) === v; })) { var i = el("input"); i.type = "checkbox"; i.value = v; i.checked = true; i.hidden = true; list.appendChild(i); } });
    try { BPStore.chat.paintAvatars(list); } catch (_) {}
  }
  function close() { if (modal) modal.hidden = true; quote = null; }
  function picked() {
    var seen = {}; var out = [];
    Array.prototype.forEach.call(q("#egp_list").querySelectorAll("input:checked"), function (i) {
      if (seen[i.value]) return; seen[i.value] = 1;
      var p = i.value.indexOf(":"), kind = i.value.slice(0, p), id = i.value.slice(p + 1);
      out.push(kind === "client" ? { kind: "client" } : { kind: kind, id: id });
    });
    return out;
  }
  function summary(r) {
    r = r || {}; var u = +r.users || 0, c = +r.contacts || 0, parts = [];
    if (u) parts.push(u + " teammate" + (u === 1 ? "" : "s"));
    if (c) parts.push(c + " contact" + (c === 1 ? "" : "s") + " (staff / vendors / client)");
    var head = parts.length ? "Added " + parts.join(" and ") + "." : "Everyone you picked is already in the group.";
    return head + (r.trial ? " Free trial: no WhatsApp message is sent - they are added in Helm only." : (c ? " Contacts are listed in the group; Helm does not message them." : ""));
  }
  async function save() {
    var qq = quote; if (!qq) return;
    var people = picked(), err = q("#egp_err"); err.hidden = true;
    var ids = people.filter(function (p) { return p.kind === "user"; }).map(function (p) { return p.id; });
    try {
      var cid = convId, g = null;
      if (mode !== "add") {
        cid = await BPStore.chat.eventGroups.create(qq.id, ids);
        try { g = (await BPStore.chat.eventGroups.index())[qq.id] || null; } catch (_) {}
        if (g && !g.is_member) { close(); BPUI.toast("This event already has a group. Ask someone in it to add you.", { type: "info" }); if (onDone) onDone(g); return; }
        cid = (g && g.conversation_id) || cid;
      }
      var r = null;
      if (people.length) {
        try { r = await BPStore.chat.eventGroups.addPeople(cid, people); }
        catch (e) {
          // 0194 not installed yet: teammates are already in (create_event_group); say so instead of failing
          if (BPUI.isMissingFunction && BPUI.isMissingFunction(e) && mode !== "add") r = { users: ids.length, contacts: 0, trial: false, pending: people.length - ids.length };
          else throw e;
        }
      }
      close();
      if (r || mode === "add") BPUI.toast(summary(r) + (r && r.pending ? " Staff, vendors and the client can be added once the database update is installed." : ""), { type: "ok", timeout: 7000 });
      if (mode === "add") { if (onDone) onDone({ conversation_id: cid, result: r }); return; }
      // opts.stay (event workspace): stay on the page — it re-renders "Open event group"
      if (stay && onDone) { if (!r) BPUI.toast("Event group created. Use Open event group to chat with the team.", { type: "ok" }); onDone(g || { conversation_id: cid, is_member: true }); return; }
      location.href = "chat.html?c=" + encodeURIComponent(cid);
    } catch (e) { err.textContent = BPUI.friendlyError(e, { action: mode === "add" ? "add people to the group" : "create the event group" }); err.hidden = false; }
  }
  async function soft(fn, fb) { try { var v = await fn(); return v == null ? fb : v; } catch (_) { return fb; } }
  // everyone who could be in the group: [{kind, id, name, sub, avatar_path, profile_id}]
  async function people(qt, me, exclude) {
    var res = await Promise.all([
      soft(function () { return BPStore.chat.roster(); }, []),
      soft(function () { return BPStore.staff.list(false); }, []),
      soft(function () { return BPStore.vendors.list(); }, []),
      soft(function () { return BPStore.bookings.list(qt.id); }, []),
      soft(function () { return BPStore.staff.forEvent(qt.id); }, []),
      qt.client && qt.client.name ? Promise.resolve(qt) : soft(function () { return BPStore.quotes.get(qt.id); }, qt)]);
    var team = res[0], crew = res[1], vend = res[2], booked = new Set((res[3] || []).map(function (b) { return b && b.vendor_id; }).filter(Boolean));
    var assigned = new Set((res[4] || []).map(function (s) { return s && s.crew_id; }).filter(Boolean));
    var full = res[5] || qt, teamIds = new Set();
    var out = [];
    (team || []).forEach(function (p) { if (!p || !p.id || p.id === me) return; teamIds.add(p.id);
      out.push({ kind: "user", id: p.id, name: nm(p), sub: p.job_title || rl(p.role), avatar_path: p.avatar_path, role: p.role }); });
    (crew || []).forEach(function (s) { if (!s || !s.id || s.active === false) return;
      if (s.profile_id && (teamIds.has(s.profile_id) || s.profile_id === me)) return;   // already listed as a teammate
      out.push({ kind: "staff", id: s.id, name: String(s.name || "Staff"), sub: (assigned.has(s.id) ? "on this event · " : "") + (s.role || s.department || "staff"), assigned: assigned.has(s.id) }); });
    (vend || []).forEach(function (v) { if (!v || !v.id || v.active === false) return;
      out.push({ kind: "vendor", id: v.id, name: String(v.name || "Vendor"), sub: (booked.has(v.id) ? "booked · " : "") + (v.category || v.kind || "vendor"), booked: booked.has(v.id) }); });
    var cn = full && full.client && String(full.client.name || "").trim();
    out.push({ kind: "client", id: "", name: cn || "Client", sub: "the event's client" });
    exclude = exclude || {};
    return out.filter(function (r) { return !exclude[val(r)]; });
  }
  // open(quote, {canEdit, onDone, stay, mode, conversationId}) — quote needs id, code, status
  async function open(qt, opts) {
    opts = opts || {}; onDone = opts.onDone || null; stay = !!opts.stay; mode = opts.mode === "add" ? "add" : "create"; convId = opts.conversationId || null;
    if (!qt || !qt.id) return;
    if (mode === "create" && qt.status !== "confirmed") { BPUI.toast("Confirm this quote before creating its event group.", { type: "info" }); return; }
    if (!opts.canEdit) { BPUI.toast(mode === "add" ? "Ask an admin or manager to add people to this group." : "Ask an admin or manager to create this event's group.", { type: "info" }); return; }
    if (mode === "add" && !convId) return;
    var me = null; try { me = (BPStore.auth.user() || {}).id || (await BPStore.chat.me()).id; } catch (_) {}
    var exclude = {};
    if (mode === "add") {
      (opts.memberIds || []).forEach(function (id) { exclude["user:" + id] = 1; });
      (await soft(function () { return BPStore.chat.eventGroups.contacts(convId); }, [])).forEach(function (k) { exclude[k.kind + ":" + (k.kind === "client" ? "" : (k.ref_id || ""))] = 1; });
    }
    rows = await people(qt, me, exclude);
    var pre = mode === "add" ? [] : rows.filter(function (r) { return (r.kind === "user" && (r.role === "owner" || r.role === "admin")) || (r.kind === "staff" && r.assigned); }).map(val);
    build(); quote = qt;
    q("#egp_err").hidden = true; q("#egp_search").value = "";
    q("#egp_title").textContent = (mode === "add" ? "👥 Add people · " : "💬 Event group · ") + (qt.code || "");
    q("#egp_sub").textContent = mode === "add"
      ? "Pick teammates, staff, vendors or the client. Teammates who sign in join the chat; the others are listed in the group."
      : "A team chat for this event. Helm posts the event details - client contact, date, venue, guests, layout, menu and notes. Never prices or payments. You can add more people later.";
    q("#egp_note").textContent = "Staff, vendors and the client who don't sign in to Helm are listed in the group (no phone or e-mail is shared). Helm sends them nothing - no WhatsApp, SMS or e-mail.";
    q("#egp_create").textContent = mode === "add" ? "Add people" : "Create group";
    draw("", pre); modal.hidden = false;
    setTimeout(function () { var s = q("#egp_search"); if (s) s.focus(); }, 50);
  }
  global.HelmEventGroupPicker = { open: open, close: close, summary: summary };
})(window);
