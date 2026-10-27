/* team-safety.js - r33 (SQL 0283): Control Center -> Users & access -> Team members.
   Deactivate instead of delete, Reactivate (counts against the seat limit again), the protected Studio owner (badge),
   24-hour admin changes by a non-owner admin (banner + Cancel for the owner / the asker), ownership hand-over (owner +
   a fresh two-step code when set up; the new owner accepts), and "what they still have open" after a deactivation.
   The database decides every rule (team_* RPCs); this file only shows the state and calls BPStore.team.
   No innerHTML: every node is built with createElement / textContent. window.HelmTeam. */
(function (global) {
  "use strict";

  // ---- pure helpers (unit-tested in test/r33-team-safety.test.mjs) ----------------------------------------------
  // overview (team_safety_overview) -> what the members table needs
  function view(ov) {
    if (!ov || typeof ov !== "object") return null;
    const off = {};
    (Array.isArray(ov.deactivated) ? ov.deactivated : []).forEach((d) => { if (d && d.user_id) off[d.user_id] = d.deactivated_at || true; });
    const pending = {};
    (Array.isArray(ov.pending) ? ov.pending : []).forEach((c) => { if (c && c.target_user) pending[c.target_user] = c; });
    return { ownerId: ov.owner_id || null, iAmOwner: ov.i_am_owner === true, isAdmin: ov.is_admin === true, me: ov.me || null,
      off: off, pending: pending, isOff: (id) => Object.prototype.hasOwnProperty.call(off, id) };
  }

  // the server's refusal in plain words (by its hint; else its own message)
  const HINT_TEXT = {
    owner_protected: "The studio owner can't be deactivated or made a non-admin. The owner can transfer ownership first.",
    admin_change_delay: "Only the studio owner can change another admin straight away. Your request takes effect after 24 hours.",
    change_pending: "A change for this admin is already waiting. The owner can cancel it on this page.",
    self: "You can't deactivate yourself. Ask another admin, or (as the owner) transfer ownership first.",
    not_owner: "Only the studio owner can transfer ownership.",
    not_admin: "Ownership can only go to another active admin. Make them an admin first.",
    transfer_pending: "A hand-over is already waiting. Cancel it first.",
    deactivated: "This person is deactivated. Reactivate them first.",
    use_deactivate: "Team members are never deleted. Use Deactivate instead.",
  };
  function hintOf(e) { return String((e && (e.hint || (e.cause && e.cause.hint))) || ""); }
  function errText(e, fallback) {
    const h = hintOf(e);
    if (HINT_TEXT[h]) return HINT_TEXT[h];
    if (h === "plan_seat_limit" || h === "seat_limit") return String((e && e.message) || "All seats are in use.") + " To reactivate this person, free a seat first.";
    const m = String((e && e.message) || "");
    return m && !/^(not authorized|permission denied)/i.test(m) ? m : (fallback || "That didn't work. Please try again.");
  }

  // a date + time in the studio's style ("28 Oct 2026, 2:00 pm")
  function when(iso) {
    if (!iso) return "";
    try {
      if (global.BPStore && global.BPStore.fmtStudioDate) {
        const d = global.BPStore.fmtStudioDate(iso, { style: "long" });
        const t = new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
        if (d) return d + ", " + t;
      }
      return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return ""; }
  }

  // one line per waiting change / hand-over: { text, actions: [{ act, id, label, danger }] }
  function bannerItems(ov) {
    const out = [];
    if (!ov || typeof ov !== "object") return out;
    (Array.isArray(ov.pending) ? ov.pending : []).forEach((c) => {
      const what = c.kind === "deactivate" ? (c.target_name || "An admin") + " will be deactivated"
                                         : (c.target_name || "An admin") + " will become " + (c.role_label || "a non-admin");
      out.push({ kind: "change", text: what + " on " + when(c.effective_at) + " (asked by " + (c.requested_by_name || "an admin") + ").",
        actions: c.can_cancel ? [{ act: "cancel-change", id: c.id, label: "Cancel" }] : [] });
    });
    const t = ov.transfer;
    if (t && t.id) {
      if (t.to_user && t.to_user === ov.me) {
        out.push({ kind: "transfer", text: (t.from_name || "The owner") + " wants to make you the studio owner. You will be responsible for the studio's billing and team.",
          actions: [{ act: "transfer-accept", id: t.id, label: "Accept" }, { act: "transfer-decline", id: t.id, label: "Decline" }] });
      } else if (ov.i_am_owner) {
        out.push({ kind: "transfer", text: "Waiting for " + (t.to_name || "the new owner") + " to accept ownership (until " + when(t.expires_at) + ").",
          actions: [{ act: "transfer-cancel", id: t.id, label: "Cancel hand-over" }] });
      } else {
        out.push({ kind: "transfer", text: (t.from_name || "The owner") + " is handing ownership to " + (t.to_name || "another admin") + ".", actions: [] });
      }
    }
    return out;
  }

  // links to what a person still has open (tasks, events they manage, leads they own)
  function workLinks(work) {
    const w = work && typeof work === "object" ? work : {};
    const enc = encodeURIComponent, out = [];
    (Array.isArray(w.tasks) ? w.tasks : []).forEach((t) => out.push({ group: "Tasks", text: (t.title || "Task") + (t.code ? " - " + t.code : ""),
      href: "ops.html?quote=" + enc(t.quote_id || "") + "&task=" + enc(t.id || "") }));
    (Array.isArray(w.events) ? w.events : []).forEach((q) => out.push({ group: "Events they manage", text: (q.code ? q.code + " - " : "") + (q.event || "Event"),
      href: "event.html?id=" + enc(q.quote_id || "") }));
    (Array.isArray(w.leads) ? w.leads : []).forEach((l) => out.push({ group: "Leads they own", text: l.name || "Lead", href: "leads.html" }));
    return out;
  }

  // ---- DOM ---------------------------------------------------------------------------------------------------------
  function el(tag, attrs, kids) {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => { if (k === "text") n.textContent = attrs[k]; else if (k === "cls") n.className = attrs[k]; else if (attrs[k] != null) n.setAttribute(k, attrs[k]); });
    (kids || []).forEach((c) => { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }

  // run a team call; a "fresh two-step code" refusal asks for the code once and retries
  async function call(fn, deps) {
    try { return await fn(); }
    catch (e) {
      // r35 / r44: store-api's withStepUp already asked for the code (or offered the two-step set-up) - never ask twice
      if (hintOf(e) !== "reauth" || (e && e.stepUp) || !deps.prompt || !deps.mfa || !deps.mfa.challenge) throw e;
      const code = await deps.prompt("Enter the 6-digit code from your authenticator app to confirm this change.",
        { title: "Confirm it's you", label: "6-digit code", required: true, maxLength: 6, okLabel: "Confirm" });
      if (code == null) throw new Error("Cancelled - nothing was changed.");
      await deps.mfa.challenge(String(code).trim());
      return fn();
    }
  }

  // banner (waiting changes / hand-over) + the owner's "Transfer ownership" box, into `box`
  function paint(box, ov, deps) {
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!ov || ov.is_admin !== true) { box.hidden = true; return; }
    const team = deps.store;
    bannerItems(ov).forEach((it) => {
      const row = el("div", { cls: "msg " + (it.kind === "transfer" ? "info" : "warn") + " tsBanner", role: "status" }, [el("span", { text: it.text })]);
      it.actions.forEach((a) => {
        const b = el("button", { type: "button", cls: "btn sm", "data-act": a.act, text: a.label });
        b.addEventListener("click", async () => {
          try {
            if (a.act === "cancel-change") { await deps.guard(b, () => team.cancelChange(a.id)); deps.msg("ok", "Cancelled. Nothing was changed."); }
            else if (a.act === "transfer-accept") {
              if (!(await deps.confirm("Become the studio owner? Only the owner can hand ownership on, and other admins can't remove you.", { title: "Accept ownership", okLabel: "Accept" }))) return;
              await deps.guard(b, () => team.transferAccept(a.id)); deps.msg("ok", "You are now the studio owner.");
            } else if (a.act === "transfer-decline") { await deps.guard(b, () => team.transferCancel(a.id)); deps.msg("ok", "Declined. The owner stays the same."); }
            else if (a.act === "transfer-cancel") { await deps.guard(b, () => team.transferCancel(a.id)); deps.msg("ok", "Hand-over cancelled."); }
            await deps.reload();
          } catch (e) { deps.msg("err", errText(e)); }
        });
        row.appendChild(b);
      });
      box.appendChild(row);
    });
    if (ov.i_am_owner && !(ov.transfer && ov.transfer.id)) {
      const others = (Array.isArray(ov.admins) ? ov.admins : []).filter((a) => a && a.user_id && a.user_id !== ov.me);
      const det = el("details", { cls: "tsTransfer" }, [el("summary", { text: "Transfer ownership" })]);
      det.appendChild(el("p", { cls: "mnote", text: "You are the studio owner. Other admins can't remove you or change your role. To hand the studio to someone else, pick another admin - they must accept. "
        + (ov.my_two_step ? "You'll be asked for a two-step code." : "Tip: set up two-step in your account first.") }));
      if (!others.length) det.appendChild(el("p", { cls: "mnote", text: "Make someone else an admin first - ownership can only go to an active admin." }));
      else {
        const sel = el("select", { id: "ts_to", "aria-label": "New owner" });
        others.forEach((a) => sel.appendChild(el("option", { value: a.user_id, text: a.name || "Admin" })));
        const go = el("button", { type: "button", cls: "btn", id: "ts_go", text: "Send hand-over" });
        go.addEventListener("click", async () => {
          const name = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : "this admin";
          if (!(await deps.confirm("Ask " + name + " to become the studio owner? You stay an admin. Every admin is told by e-mail and in the bell.", { title: "Transfer ownership", okLabel: "Send hand-over" }))) return;
          try { await deps.guard(go, () => call(() => team.transferStart(sel.value), deps)); deps.msg("ok", "Hand-over sent. " + name + " must accept it within 7 days."); await deps.reload(); }
          catch (e) { deps.msg("err", errText(e)); }
        });
        det.appendChild(el("div", { cls: "addrow" }, [sel, go]));
      }
      box.appendChild(det);
    }
    box.hidden = !box.firstChild;
  }

  // "what they still have open" panel (after a deactivation, or from a deactivated row)
  function paintWork(box, name, work) {
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    const links = workLinks(work);
    const card = el("div", { cls: "msg info tsWork", role: "status" });
    if (!links.length) card.appendChild(el("span", { text: (name || "This person") + " has no open tasks, events or leads." }));
    else {
      card.appendChild(el("strong", { text: (name || "This person") + " still has open work. Give it to someone else:" }));
      let last = "", ul = null;
      links.forEach((l) => {
        if (l.group !== last) { last = l.group; card.appendChild(el("div", { cls: "tsWorkH", text: l.group })); ul = el("ul", { cls: "tsWorkL" }); card.appendChild(ul); }
        ul.appendChild(el("li", null, [el("a", { href: l.href, text: l.text })]));
      });
    }
    const close = el("button", { type: "button", cls: "btn sm", text: "Close" });
    close.addEventListener("click", () => { box.hidden = true; while (box.firstChild) box.removeChild(box.firstChild); });
    card.appendChild(close);
    box.appendChild(card); box.hidden = false;
  }

  global.HelmTeam = { view, bannerItems, workLinks, errText, hintOf, when, call, paint, paintWork, HINT_TEXT };
})(typeof window !== "undefined" ? window : globalThis);
