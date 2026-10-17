/* QA1026 #10: event-scoped pages (settlement / budget / closure) opened WITHOUT ?quote=
   (e.g. the bare /<studio>/settlement route) show a friendly "Pick an event" list instead
   of "Event not found, or your role can't open it". Read-only: lists the quotes this
   role can already read (RLS) and links each to <page>?quote=<id>. Builds DOM with
   textContent only (no innerHTML of data). */
(function (global) {
  "use strict";
  var doc = global.document;
  function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function href(page, id) {
    var h = page + ".html?quote=" + encodeURIComponent(String(id));
    try { if (global.HelmUrl && global.HelmUrl.upgrade) h = global.HelmUrl.upgrade(h); } catch (e) {}
    return h;
  }
  function pickable(q) {
    var s = String((q && q.status) || "").toLowerCase();
    return !!(q && q.id) && s !== "lost" && s !== "cancelled";
  }
  function render(box, page, what, list) {
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(el("h2", "pick-ev-h", "Pick an event"));
    box.appendChild(el("p", "muted", "Choose the event whose " + what + " you want to open."));
    if (list === null) { box.appendChild(el("p", "muted", "Loading events…")); return; }
    var rows = (list || []).filter(pickable).slice(0, 30);
    if (!rows.length) {
      var p = el("p", "muted", "No events yet. ");
      var a = el("a", null, "Go to Quotes"); a.href = "quotes.html"; p.appendChild(a);
      box.appendChild(p); return;
    }
    var ul = el("ul", "pick-ev-list"); ul.style.listStyle = "none"; ul.style.padding = "0"; ul.style.margin = "8px 0 0";
    rows.forEach(function (q) {
      var li = el("li"); li.style.padding = "6px 0";
      var a = el("a", null, (q.code ? q.code + " · " : "") + (q.title || (q.client && q.client.name) || "Event"));
      a.href = href(page, q.id); li.appendChild(a);
      if (q.eventDate || q.event_date) li.appendChild(el("span", "muted", "  " + String(q.eventDate || q.event_date).slice(0, 10)));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }
  // show(box, "settlement", "settlement") — always resolves; never throws
  function show(box, page, what) {
    if (!box) return Promise.resolve();
    box.hidden = false;
    render(box, page, what || page, null);
    var st = global.BPStore;
    if (!st || !st.quotes || typeof st.quotes.list !== "function") { render(box, page, what || page, []); return Promise.resolve(); }
    return Promise.resolve().then(function () { return st.quotes.list(); })
      .then(function (list) { render(box, page, what || page, Array.isArray(list) ? list : []); })
      .catch(function () { render(box, page, what || page, []); });
  }
  var api = { show: show, _href: href, _pickable: pickable };
  global.HelmPickEvent = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
