/* tables-mobile.js — prepares data tables for the stacked phone layout in
   tables-mobile.css. No markup is generated: it only sets classes and
   data-label attributes (header text) on existing cells, and re-runs when
   rows are re-rendered.
   Applies to every <table> inside <main> (or body) with a <thead> of 3+ columns.
   Per-table overrides (optional attributes on <table>):
     data-tm="off"            skip this table
     data-tm-primary="2"      1-based column to use as the card title
     data-tm-actions="8"      1-based column holding row actions
   API: window.HelmTablesMobile.refresh(root?) re-scans manually. */
(function () {
  "use strict";
  var PRIMARY = /^(event|item|name|client|title|vendor|staff|member|lead|contact)$/i;
  var ACTIONS = /^(actions?|open|manage|)$/i;

  function headers(table) {
    var row = table.tHead && table.tHead.rows[table.tHead.rows.length - 1];
    if (!row) return null;
    var out = [];
    for (var i = 0; i < row.cells.length; i++) {
      var th = row.cells[i], span = th.colSpan || 1;
      var txt = (th.getAttribute("data-label") || th.textContent || "").replace(/\s+/g, " ").trim();
      for (var s = 0; s < span; s++) out.push(txt);
    }
    return out;
  }

  function pick(table, labels) {
    var p = parseInt(table.getAttribute("data-tm-primary"), 10) - 1;
    var a = parseInt(table.getAttribute("data-tm-actions"), 10) - 1;
    if (!(p >= 0)) { p = -1; for (var i = 0; i < labels.length; i++) if (PRIMARY.test(labels[i])) { p = i; break; } if (p < 0) p = 0; }
    if (!(a >= 0)) { var last = labels.length - 1; a = ACTIONS.test(labels[last]) ? last : -1; }
    return { p: p, a: a };
  }

  function prep(table) {
    if (table.getAttribute("data-tm") === "off") return;
    var labels = headers(table);
    if (!labels || labels.length < 3) return;
    var cols = pick(table, labels);
    table.classList.add("tm-stack");
    for (var b = 0; b < table.tBodies.length; b++) {
      var rows = table.tBodies[b].rows;
      for (var r = 0; r < rows.length; r++) {
        var tr = rows[r], cells = tr.cells;
        var full = cells.length === 1 && (cells[0].colSpan || 1) > 1;
        tr.classList.toggle("tm-full", full);
        if (full) continue;
        var col = 0;
        for (var c = 0; c < cells.length; c++) {
          var td = cells[c], label = labels[col] || "";
          if (label && td.getAttribute("data-label") !== label) td.setAttribute("data-label", label);
          td.classList.toggle("tm-primary", col === cols.p);
          td.classList.toggle("tm-actions", col === cols.a);
          var blank = !td.textContent.trim() && !td.querySelector("input,select,button,a,img,svg,textarea");
          td.classList.toggle("tm-empty", blank && col !== cols.p);
          col += td.colSpan || 1;
        }
      }
    }
  }

  function refresh(root) {
    var scope = root || document.querySelector("main") || document.body;
    if (!scope) return;
    var list = scope.tagName === "TABLE" ? [scope] : scope.querySelectorAll("table");
    for (var i = 0; i < list.length; i++) prep(list[i]);
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; refresh(); });
  }

  function start() {
    refresh();
    var scope = document.querySelector("main") || document.body;
    // childList only: our own attribute/class writes don't retrigger it
    new MutationObserver(schedule).observe(scope, { childList: true, subtree: true });
  }

  window.HelmTablesMobile = { refresh: refresh };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
