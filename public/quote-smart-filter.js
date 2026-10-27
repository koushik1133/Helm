/* quote-smart-filter.js — r23: the Quotes list "When" (event date) window + a rule-based
 * smart search. No AI and no server call: a short fixed phrase list.
 *   HelmQuoteSmart.range(key, now)  -> { from, to } yyyy-mm-dd (local / IST day), or null for "any date"
 *   HelmQuoteSmart.parse(text, types) -> { tab, type, date, labels[] } when EVERY word of the text is a
 *       known phrase ("cancelled weddings this month"), else null - the text then stays an ordinary
 *       search of code / client / title, exactly as before.
 * Pure functions (tested in test/r23-quotes-views.test.mjs); quotes.html wires them to its controls.
 */
(function (global) {
  "use strict";
  // "When" options (value -> label); the <select id="dateFilter"> in quotes.html lists the same keys
  var DATES = [
    ["today", "Today"], ["tomorrow", "Tomorrow"], ["week", "This week"], ["month", "This month"],
    ["nextmonth", "Next month"], ["next30", "Next 30 days"], ["past", "Past dates"],
  ];
  var DATE_LABEL = {}; DATES.forEach(function (d) { DATE_LABEL[d[0]] = d[1]; });

  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function day(y, m, dd) { return new Date(y, m, dd, 12, 0, 0); }   // noon: no DST edge
  // r37: no "now" given = a local Date that reads the STUDIO's date + time (Today / This week follow the studio's calendar)
  function studioNow() { try { var B = (typeof window !== "undefined" && window.BPStore) || null, c = B && B.studioClock ? B.studioClock() : null; if (c) return new Date(c.y, c.mo - 1, c.d, c.h, c.mi, c.s); } catch (e) {} return new Date(); }
  function range(key, now) {
    var n = now instanceof Date && !isNaN(now) ? now : studioNow();
    var y = n.getFullYear(), m = n.getMonth(), d = n.getDate();
    switch (key) {
      case "today": return { from: iso(day(y, m, d)), to: iso(day(y, m, d)) };
      case "tomorrow": return { from: iso(day(y, m, d + 1)), to: iso(day(y, m, d + 1)) };
      case "week": { var back = (n.getDay() + 6) % 7;   // Monday-start week (India)
        return { from: iso(day(y, m, d - back)), to: iso(day(y, m, d - back + 6)) }; }
      case "month": return { from: iso(day(y, m, 1)), to: iso(day(y, m + 1, 0)) };
      case "nextmonth": return { from: iso(day(y, m + 1, 1)), to: iso(day(y, m + 2, 0)) };
      case "next30": return { from: iso(day(y, m, d)), to: iso(day(y, m, d + 29)) };
      case "past": return { from: "", to: iso(day(y, m, d - 1)) };
      default: return null;
    }
  }

  // phrase -> filter. Longest phrases are tried first; matching is whole words only.
  var TAB_LABEL = { all: "Active", quote: "Quotes", confirmed: "Sent & confirmed", attention: "Attention",
    cancelled: "Cancelled", archived: "Archive", deleted: "Deleted", inprogress: "In progress" };
  var PHRASES = [
    ["next 30 days", "date", "next30"], ["this week", "date", "week"], ["this month", "date", "month"],
    ["next month", "date", "nextmonth"], ["today", "date", "today"], ["tomorrow", "date", "tomorrow"],
    ["past", "date", "past"], ["past dates", "date", "past"],
    ["cancelled", "tab", "cancelled"], ["canceled", "tab", "cancelled"], ["cancellations", "tab", "cancelled"],
    ["needs attention", "tab", "attention"], ["attention", "tab", "attention"], ["overdue", "tab", "attention"],
    ["confirmed", "tab", "confirmed"], ["sent", "tab", "confirmed"], ["archived", "tab", "archived"], ["archive", "tab", "archived"],
    ["deleted", "tab", "deleted"], ["in progress", "tab", "inprogress"], ["active", "tab", "all"],
  ];
  // words that may sit around the phrases without meaning anything ("show me cancelled events this month")
  var FILLER = { show: 1, me: 1, all: 1, the: 1, of: 1, in: 1, for: 1, on: 1, only: 1, event: 1, events: 1, quote: 1, quotes: 1, and: 1, with: 1, date: 1, dated: 1 };

  function norm(s) { return " " + String(s || "").toLowerCase().replace(/[^a-z0-9\s-]+/g, " ").replace(/-/g, " ").replace(/\s+/g, " ").trim() + " "; }
  function parse(text, types) {
    var src = norm(text); if (src.trim().length < 3 || src.length > 130) return null;
    var out = { tab: "", type: "", date: "", labels: [] }, hit = false, clash = false;
    // event types from the page's type dropdown: "Wedding" matches "wedding" and "weddings"
    var tlist = (types || []).filter(function (t) { return typeof t === "string" && t.trim(); })
      .map(function (t) { return { value: t, key: norm(t).trim() }; })
      .sort(function (a, b) { return b.key.length - a.key.length; });
    function take(phrase) {
      var p = " " + phrase + " ", i = src.indexOf(p); if (i < 0) return false;
      src = src.slice(0, i) + " " + src.slice(i + p.length - 1); return true;
    }
    function set(kind, v) { if (out[kind] && out[kind] !== v) clash = true; out[kind] = v; hit = true; }
    PHRASES.slice().sort(function (a, b) { return b[0].length - a[0].length; }).forEach(function (ph) {
      while (take(ph[0])) set(ph[1], ph[2]);
    });
    tlist.forEach(function (t) { if (!t.key) return; while (take(t.key + "s") || take(t.key)) set("type", t.value); });
    var rest = src.trim().split(/\s+/).filter(function (w) { return w && !FILLER[w]; });
    if (!hit || clash || rest.length) return null;
    if (out.tab) out.labels.push(TAB_LABEL[out.tab] || out.tab);
    if (out.type) out.labels.push(out.type);
    if (out.date) out.labels.push(DATE_LABEL[out.date]);
    return out;
  }

  global.HelmQuoteSmart = { DATES: DATES, DATE_LABEL: DATE_LABEL, TAB_LABEL: TAB_LABEL, range: range, parse: parse };
})(typeof window !== "undefined" ? window : globalThis);
