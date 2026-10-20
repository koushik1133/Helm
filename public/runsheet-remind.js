/* runsheet-remind.js - r24 (0269) run-sheet reminders on runsheet.html.
   - Owner picker: Team (people with a Helm login) / Staff / Vendors, or "Someone else" with a typed name (kept as before).
   - Per line: "Remind" (on by default once an owner is picked), when (studio default from Control Center, or a fixed
     time before), and "Also post the reminder in the event group".
   - The list shows a small bell per line with when + who gets it (bell / e-mail / WhatsApp / event group), read from
     runsheet_reminder_targets (no contact details ever reach the page).
   Before 0269 is installed (targets RPC missing) everything falls back to the old Staff + Vendors name picker and no
   new fields are sent. Builds options with the DOM API (textContent), never HTML strings. */
(function (global) {
  "use strict";
  var doc = global.document;
  var S = { ready: false, people: [], team: [], targets: {}, cfg: null };
  var WAYS = { bell: "bell", email: "e-mail", whatsapp: "WhatsApp", group: "event group" };
  var AT = [["", ""], ["0", "At the start time"], ["5", "5 min before"], ["10", "10 min before"], ["15", "15 min before"],
    ["30", "30 min before"], ["60", "1 hour before"], ["120", "2 hours before"]];

  function $(id) { return doc.getElementById(id); }
  function el(tag, attrs, text) {
    var n = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? "" : String(attrs[k])); });
    if (text != null) n.textContent = String(text);
    return n;
  }
  function one(m) {
    m = Number(m);
    if (!isFinite(m)) return "";
    if (m === 0) return "at the start";
    if (m % 60 === 0) return (m / 60) + (m === 60 ? " hour" : " hours") + " before";
    return m + " min before";
  }
  // [15, 0] -> "15 min before + at the start"
  function offsetsText(a) {
    a = Array.isArray(a) ? a.slice().sort(function (x, y) { return y - x; }) : [];
    return a.map(one).filter(Boolean).join(" + ");
  }

  async function init(store) {
    var A = store && store.automation;
    S.people = []; S.team = [];
    try { S.people = await store.people.options(); } catch (e) { S.people = []; }
    if (!A) return S;
    try { S.cfg = await A.settings(); } catch (e) { S.cfg = null; }
    S.ready = !!S.cfg;
    if (S.ready) { try { S.team = await A.teamOptions(); } catch (e) { S.team = []; } }
    return S;
  }
  async function loadTargets(store, quoteId) {
    S.targets = {};
    if (!S.ready || !store || !store.automation) return S.targets;
    var r = null;
    try { r = await store.automation.runsheetTargets(quoteId); } catch (e) { r = null; }
    if (!r) return S.targets;
    S.enabled = !!r.enabled;
    (r.items || []).forEach(function (t) { S.targets[t.id] = t; });
    return S.targets;
  }

  // value for one person option
  function val(kind, id) { return kind + ":" + id; }
  function groupEl(label, list, kind, selected) {
    if (!list.length) return null;
    var g = el("optgroup", { label: label });
    list.forEach(function (p) {
      var o = el("option", { value: val(kind, p.id) }, p.name + (p.role ? " · " + p.role : ""));
      if (selected === o.value) o.selected = true;
      g.appendChild(o);
    });
    return g;
  }
  function staffList(kind) { return S.people.filter(function (p) { return p.kind === kind; }); }
  // the picker value for a saved line (ids first, then a unique name match, else "Someone else")
  function pickedValue(item) {
    item = item || {};
    if (item.owner_user_id) return val("user", item.owner_user_id);
    if (item.owner_crew_id) return val("staff", item.owner_crew_id);
    if (item.owner_vendor_id) return val("vendor", item.owner_vendor_id);
    var name = String(item.owner || "").trim();
    if (!name) return "";
    var low = name.toLowerCase();
    var hit = S.people.filter(function (p) { return String(p.name || "").trim().toLowerCase() === low; });
    if (hit.length === 1) return val(hit[0].kind, hit[0].id);
    if (S.ready) { var th = S.team.filter(function (p) { return String(p.name || "").trim().toLowerCase() === low; }); if (th.length === 1) return val("user", th[0].id); }
    return "other";
  }
  function fillOwner(prefix, item) {
    var sel = $(prefix + "_owner"), other = $(prefix + "_owner_other"); if (!sel) return;
    var v = pickedValue(item);
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    sel.appendChild(el("option", { value: "" }, "Select person…"));
    [groupEl("Team", S.ready ? S.team : [], "user", v), groupEl("Staff", staffList("staff"), "staff", v), groupEl("Vendors", staffList("vendor"), "vendor", v)]
      .forEach(function (g) { if (g) sel.appendChild(g); });
    var o = el("option", { value: "other" }, "Someone else (type a name)"); if (v === "other") o.selected = true; sel.appendChild(o);
    if (!v) sel.value = "";
    if (other) { other.value = v === "other" ? String((item && item.owner) || "") : ""; other.hidden = v !== "other"; }
    fillRemind(prefix, item);
  }
  // { owner, owner_kind?, owner_user_id?, owner_crew_id?, owner_vendor_id? }
  function readOwner(prefix) {
    var sel = $(prefix + "_owner"), other = $(prefix + "_owner_other"); var v = sel ? sel.value : "";
    var out = { owner: null };
    if (v === "other") out.owner = (other && other.value.trim()) || null;
    else if (v) {
      var k = v.split(":")[0], id = v.slice(k.length + 1);
      var list = k === "user" ? S.team : staffList(k);
      var p = list.filter(function (x) { return String(x.id) === id; })[0];
      out.owner = p ? p.name : null;
      if (S.ready && p) { out.owner_kind = k; out.owner_user_id = k === "user" ? id : null; out.owner_crew_id = k === "staff" ? id : null; out.owner_vendor_id = k === "vendor" ? id : null; }
    }
    if (S.ready && !out.owner_kind) { out.owner_kind = out.owner ? "other" : null; out.owner_user_id = null; out.owner_crew_id = null; out.owner_vendor_id = null; }
    return out;
  }
  function defaultLabel() { var t = offsetsText(S.cfg && S.cfg.runsheet_offsets); return "Studio default" + (t ? " (" + t + ")" : ""); }
  function fillRemind(prefix, item) {
    var wrap = $(prefix + "_remWrap"); if (!wrap) return;
    if (!S.ready) { wrap.hidden = true; return; }
    var at = $(prefix + "_remAt"), on = $(prefix + "_rem"), grp = $(prefix + "_remGrp");
    if (at && !at.options.length) AT.forEach(function (a) { at.appendChild(el("option", { value: a[0] }, a[0] === "" ? defaultLabel() : a[1])); });
    item = item || {};
    var offs = Array.isArray(item.remind_offsets) ? item.remind_offsets : null;
    if (at) at.value = offs && offs.length === 1 && AT.some(function (a) { return a[0] === String(offs[0]); }) ? String(offs[0]) : "";
    if (on) on.checked = item.remind == null ? true : !!item.remind;
    if (grp) grp.checked = !!item.remind_group;
    sync(prefix);
  }
  // the reminder options show once an owner is picked (or the group post is on)
  function sync(prefix) {
    var wrap = $(prefix + "_remWrap"), sel = $(prefix + "_owner"), other = $(prefix + "_owner_other");
    if (other && sel) other.hidden = sel.value !== "other";
    if (!wrap) return;
    var has = !!(sel && sel.value && (sel.value !== "other" || (other && other.value.trim())));
    var grp = $(prefix + "_remGrp");
    wrap.hidden = !S.ready || (!has && !(grp && grp.checked));
    var on = $(prefix + "_rem"), at = $(prefix + "_remAt");
    if (at) at.disabled = !(on && on.checked);
  }
  // { remind, remind_offsets, remind_group } (empty object before 0269)
  function readRemind(prefix) {
    if (!S.ready) return {};
    var on = $(prefix + "_rem"), at = $(prefix + "_remAt"), grp = $(prefix + "_remGrp");
    var v = at ? at.value : "";
    return { remind: on ? !!on.checked : null, remind_offsets: v === "" ? null : [Number(v)], remind_group: !!(grp && grp.checked) };
  }
  function wire(prefix) {
    var sel = $(prefix + "_owner"), other = $(prefix + "_owner_other"), on = $(prefix + "_rem"), grp = $(prefix + "_remGrp");
    [sel, other, on, grp].forEach(function (n) { if (n) { n.addEventListener("change", function () { sync(prefix); }); n.addEventListener("input", function () { sync(prefix); }); } });
  }
  // the small bell line for one run-sheet item (null = nothing to show)
  function tag(itemId) {
    var t = S.targets[itemId]; if (!t || !S.enabled) return null;
    if (!t.item_on) return null;
    var span = el("span", { class: "tag rsr-tag" + (t.on ? "" : " rsr-off") });
    if (t.needs_time) { span.textContent = "🔔 Add a start time to send the reminder"; return span; }
    var ways = (t.ways || []).map(function (w) { return WAYS[w] || w; });
    if (!ways.length) { span.textContent = "🔔 No one to remind — pick a person from the list"; span.classList.add("rsr-off"); return span; }
    span.textContent = "🔔 " + offsetsText(t.offsets) + " → " + (t.name || "event group") + " (" + ways.join(", ") + ")";
    span.title = "Helm reminds the owner automatically. Change the default times in Control Center → Automations.";
    return span;
  }

  global.HelmRsRemind = { init: init, loadTargets: loadTargets, fillOwner: fillOwner, readOwner: readOwner, fillRemind: fillRemind,
    readRemind: readRemind, wire: wire, sync: sync, tag: tag, offsetsText: offsetsText, state: S };
})(typeof window !== "undefined" ? window : globalThis);
