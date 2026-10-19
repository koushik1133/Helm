/* stage-history.js - r23 (0263): the "Stage history" card on the event workspace (event.html) and the quote flow
   (flow.html). One canonical stage pill (BPStore.quoteStageLabel / quoteStageTone - the same words + colours everywhere) and
   the moves newest first: "Moved to Approved by the client · 20/10/2026, 14:05", with the reason when one was given.
   Mounts on every [data-stage-history] element; the quote id comes from data-quote or the page URL (?id= / ?quote=).
   Reads ONLY through BPStore.stages.history (quote_stage_history - the server re-checks studio + Quotes view and
   self-heals a stage that fell behind). Hidden on a database without 0263, when the studio switched the history off
   in Control Center, or when the user may not see it. DOM via textContent only. describe() / when() / pillSpec() are
   pure and unit-tested (test/r23-state-machine.test.mjs). */
(function (global) {
  "use strict";
  var SHOW = 5;
  function B() { return global.BPStore; }
  function label(s) { var b = B(); return b && b.quoteStageLabel ? b.quoteStageLabel(s) : String(s || ""); }
  function tone(s) { var b = B(); return b && b.quoteStageTone ? b.quoteStageTone(s) : "draft"; }
  // the pill for a stage: { text, cls } (cls = the status-pills.css tone class on span.st)
  function pillSpec(stage) { return { text: label(stage), cls: "stat r23-pill " + tone(stage) }; }
  // dd/mm/yyyy, hh:mm in the studio's own zone (BPStore.fmtDateTime); en-IN Asia/Kolkata when the store is absent
  function when(iso) {
    if (!iso) return "";
    var b = B(); if (b && b.fmtDateTime) { var o = b.fmtDateTime(iso); if (o) return o; }
    var d = new Date(iso); if (isNaN(d.getTime())) return "";
    try { return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }); }
    catch (e) { return d.toISOString().slice(0, 16).replace("T", " "); }
  }
  // who / how, in plain words
  function byWho(m) {
    m = m || {};
    if (m.source === "client") return "by the client";
    if (m.source === "cron") return "automatically";
    if (m.actor_name) return "by " + m.actor_name;
    if (m.source === "ui" || m.source === "rpc") return "by a team member";
    return "by Helm";
  }
  // one move -> { title, meta, reason, flag }
  function describe(m) {
    m = m || {};
    var to = m.to_label || label(m.to), t;
    if (m.source === "backfill") t = "Stage recorded: " + to + " (when stage tracking began)";
    else if (!m.from) t = "Started as " + to + " " + byWho(m);
    else t = "Moved to " + to + " " + byWho(m);
    return { title: t, meta: when(m.at), reason: m.reason ? "Reason: " + String(m.reason) : "",
      flag: m.legal === false ? "Out of the usual order" : "", from: m.from ? (m.from_label || label(m.from)) : "" };
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function quoteIdFor(box) {
    var id = box.getAttribute("data-quote") || "";
    if (!id && box.hasAttribute("data-quote-from-url")) {
      try { var sp = new URLSearchParams(global.location.search); id = sp.get("id") || sp.get("quote") || ""; } catch (e) { id = ""; }
    }
    return /^[0-9a-f-]{36}$/i.test(id) ? id : "";
  }
  function render(box, d) {
    while (box.firstChild) box.removeChild(box.firstChild);
    var list = Array.isArray(d.history) ? d.history : [];
    var hd = el("div", "r23-sh-hd");
    hd.appendChild(el("h3", "r23-sh-ttl", "Stage history"));
    if (d.stage) { var p = pillSpec(d.stage), pill = el("span", p.cls, p.text); pill.setAttribute("data-stage", d.stage); hd.appendChild(pill); }
    if (d.since) hd.appendChild(el("span", "r23-sh-since muted", "since " + when(d.since)));
    box.appendChild(hd);
    if (!list.length) { box.appendChild(el("p", "muted r23-sh-empty", "No stage changes recorded yet.")); return; }
    var ol = el("ol", "r23-sh-list"); ol.setAttribute("aria-label", "Stage changes, newest first");
    list.forEach(function (m, i) {
      var x = describe(m), li = el("li", "r23-sh-row" + (i >= SHOW ? " r23-more" : ""));
      if (i >= SHOW) li.hidden = true;
      var dot = el("span", "r23-sh-dot " + tone(m.to)); dot.setAttribute("aria-hidden", "true"); li.appendChild(dot);
      var body = el("div", "r23-sh-body");
      var line = el("div", "r23-sh-line"); line.appendChild(el("span", "r23-sh-what", x.title));
      if (x.meta) line.appendChild(el("span", "r23-sh-when muted", " · " + x.meta));
      body.appendChild(line);
      if (x.from) body.appendChild(el("div", "r23-sh-from muted", "from " + x.from));
      if (x.reason) body.appendChild(el("div", "r23-sh-why", x.reason));
      if (x.flag) { var f = el("span", "r23-sh-flag", x.flag); f.title = "This move is not in the usual stage order. It was allowed and logged (the studio's stage rules are in warn mode)."; body.appendChild(f); }
      li.appendChild(body); ol.appendChild(li);
    });
    box.appendChild(ol);
    if (list.length > SHOW) {
      var btn = el("button", "btn sm r23-sh-all", "Show all (" + list.length + ")"); btn.type = "button"; btn.setAttribute("aria-expanded", "false");
      btn.addEventListener("click", function () {
        var open = btn.getAttribute("aria-expanded") !== "true";
        Array.prototype.forEach.call(ol.querySelectorAll(".r23-more"), function (n) { n.hidden = !open; });
        btn.setAttribute("aria-expanded", open ? "true" : "false"); btn.textContent = open ? "Show fewer" : "Show all (" + list.length + ")";
      });
      box.appendChild(btn);
    }
  }
  var boxes = [], tries = 0, busy = false;
  async function load(box) {
    var id = quoteIdFor(box), b = B(); if (!id || !b || !b.stages) return;
    var d = null;
    try { d = await b.stages.history(id); } catch (e) { d = null; }   // not allowed / older server: stays hidden
    if (!d || d.show_history === false) { box.hidden = true; return; }
    render(box, d); box.hidden = false;
  }
  async function refresh() {
    if (busy) return; busy = true;
    try { for (var i = 0; i < boxes.length; i++) await load(boxes[i]); } finally { busy = false; }
  }
  function init() {
    if (typeof document === "undefined") return;
    boxes = Array.prototype.slice.call(document.querySelectorAll("[data-stage-history]"));
    if (!boxes.length) return;
    var b = B();
    if (!b || !b.stages || !b.auth || !b.auth.user || !b.auth.user()) { if (++tries < 30) setTimeout(init, 1000); return; }
    refresh();
    global.addEventListener("focus", function () { refresh(); });
    global.addEventListener("helm:stage-refresh", function () { refresh(); });
    // data-refresh-on="#statusBadge": when the page repaints that status (a stage move just happened), reload
    var timer = null, kick = function () { clearTimeout(timer); timer = setTimeout(refresh, 900); };
    boxes.forEach(function (box) {
      var sel = box.getAttribute("data-refresh-on"); if (!sel || typeof MutationObserver === "undefined") return;
      sel.split(",").forEach(function (s) {
        var n = null; try { n = document.querySelector(s.trim()); } catch (e) { n = null; }
        if (n) new MutationObserver(kick).observe(n, { childList: true, characterData: true, subtree: true });
      });
    });
  }
  global.HelmStageHistory = { init: init, refresh: refresh, describe: describe, when: when, pillSpec: pillSpec, byWho: byWho };
  if (typeof module !== "undefined" && module.exports) module.exports = global.HelmStageHistory;
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 600); });
  else setTimeout(init, 600);
})(typeof window !== "undefined" ? window : globalThis);
