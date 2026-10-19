/* inbox-core.js - r23 (0266) notification inbox: the pure parts of the /inbox page (no DOM, no network), shared with
   the node tests (test/r23-inbox.test.mjs).
     sections(items, { by: "event" | "day", now, tz })  -> [{ key, title, sub, items }]  newest section first
     snoozeChoices(now, tz)                            -> the snooze menu (later today / tomorrow 9 am / next week / custom)
     keyAction(event-like)                             -> "next" | "prev" | "done" | "snooze" | "toggle_read" | "select" | "open" | "clear" | null
     when(iso, now, tz)                                -> "now" / "12m" / "3h" / "Yesterday" / "19/10/2026"
     emptyText(tab, filter)                            -> [title, line] for an empty list
     digestLabel(mode)                                 -> plain words for an e-mail mode
   India-first: Asia/Kolkata by default, dd/mm/yyyy dates, 12-hour times with am / pm. */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HelmInboxCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var DEFAULT_TZ = "Asia/Kolkata";

  // calendar parts of an instant in a time zone (falls back to the device zone when Intl lacks the zone)
  function parts(t, tz) {
    var d = new Date(t), out = {};
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz || DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
        .formatToParts(d).forEach(function (p) { out[p.type] = p.value; });
    } catch (e) {
      out = { year: String(d.getFullYear()), month: ("0" + (d.getMonth() + 1)).slice(-2), day: ("0" + d.getDate()).slice(-2),
              hour: ("0" + d.getHours()).slice(-2), minute: ("0" + d.getMinutes()).slice(-2), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()] };
    }
    return { y: +out.year, m: +out.month, d: +out.day, H: +out.hour % 24, M: +out.minute, wd: out.weekday || "" };
  }
  function dayKey(t, tz) { var p = parts(t, tz); return p.y * 10000 + p.m * 100 + p.d; }
  function ddmmyyyy(t, tz) { var p = parts(t, tz); return ("0" + p.d).slice(-2) + "/" + ("0" + p.m).slice(-2) + "/" + p.y; }
  function clock(t, tz) {
    var p = parts(t, tz), h = p.H % 12 || 12;
    return h + ":" + ("0" + p.M).slice(-2) + " " + (p.H < 12 ? "am" : "pm");
  }
  function ts(n) { var t = new Date((n && (n.sort_at || n.created_at)) || NaN).getTime(); return isFinite(t) ? t : 0; }

  function when(iso, now, tz) {
    var t = new Date(iso).getTime(); now = Number(now) || Date.now();
    if (!isFinite(t)) return "";
    var s = Math.max(0, (now - t) / 1000);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (dayKey(t, tz) === dayKey(now, tz)) return Math.floor(s / 3600) + "h";
    if (dayKey(t, tz) === dayKey(now - 86400000, tz)) return "Yesterday";
    return ddmmyyyy(t, tz);
  }

  function sections(items, opts) {
    opts = opts || {};
    var by = opts.by === "day" ? "day" : "event", now = Number(opts.now) || Date.now(), tz = opts.tz || DEFAULT_TZ;
    var list = (Array.isArray(items) ? items : []).filter(function (n) { return n && typeof n === "object" && n.id; })
      .slice().sort(function (a, b) { return ts(b) - ts(a); });
    var map = {}, order = [];
    list.forEach(function (n) {
      var key, title, sub = "";
      if (by === "day") {
        var k = dayKey(ts(n), tz);
        key = "d" + k;
        title = k === dayKey(now, tz) ? "Today" : k === dayKey(now - 86400000, tz) ? "Yesterday" : ddmmyyyy(ts(n), tz);
      } else if (n.quote_id) {
        key = "q" + n.quote_id;
        title = [n.event_code, n.event_title].filter(Boolean).join(" · ") || "Event";
      } else { key = "studio"; title = "Studio-wide"; sub = "Not linked to one event"; }
      if (!map[key]) { map[key] = { key: key, title: title, sub: sub, quote_id: by === "event" ? (n.quote_id || null) : null, items: [], unread: 0 }; order.push(key); }
      map[key].items.push(n); if (n.unread) map[key].unread++;
    });
    return order.map(function (k) { return map[k]; });
  }

  // the snooze menu; hint = when it comes back, in the studio's time zone
  function snoozeChoices(now, tz) {
    now = Number(now) || Date.now(); tz = tz || DEFAULT_TZ;
    var p = parts(now, tz), later = now + 3 * 3600000;
    // days to next Monday (isodow: Mon=1 .. Sun=7); always 1..7 days ahead
    var iso = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.wd] || 1;
    var toMon = 8 - iso;
    // next Monday's calendar date (UTC arithmetic on the local calendar day; time zone only matters for the label)
    var mon = new Date(Date.UTC(p.y, p.m - 1, p.d + toMon));
    var tom = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
    var dm = function (d) { return ("0" + d.getUTCDate()).slice(-2) + "/" + ("0" + (d.getUTCMonth() + 1)).slice(-2); };
    var wd = function (d) { return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]; };
    return [
      { preset: "later_today", label: dayKey(later, tz) === dayKey(now, tz) ? "Later today" : "In 3 hours", hint: clock(later, tz) },
      { preset: "tomorrow", label: "Tomorrow", hint: wd(tom) + " " + dm(tom) + ", 9:00 am" },
      { preset: "next_week", label: "Next week", hint: "Mon " + dm(mon) + ", 9:00 am" },
      { preset: "custom", label: "Pick a date & time…", hint: "" },
    ];
  }

  // keyboard: j / k (or arrows) move, e Done, s Snooze, u read / unread, x select, Enter / o open, Esc clear
  function keyAction(e) {
    if (!e || e.metaKey || e.ctrlKey || e.altKey) return null;
    var k = String(e.key || "");
    if (k === "j" || k === "ArrowDown") return "next";
    if (k === "k" || k === "ArrowUp") return "prev";
    if (k === "e") return "done";
    if (k === "s") return "snooze";
    if (k === "u") return "toggle_read";
    if (k === "x") return "select";
    if (k === "Enter" || k === "o") return "open";
    if (k === "Escape" || k === "Esc") return "clear";
    return null;
  }

  function emptyText(tab, filter) {
    var f = filter ? " here" : "";
    if (tab === "unread") return ["You're all caught up", "Nothing unread" + f + ". New tasks, payments and client updates will show up here."];
    if (tab === "snoozed") return ["Nothing snoozed", "Snooze a notification (press s) and it comes back here as unread at the time you pick."];
    if (tab === "done") return ["Nothing marked Done yet", "Press e (or Done) on a notification to clear it from your inbox. It stays here."];
    return ["No notifications" + f, "Everything Helm tells you about your events lands here."];
  }

  function digestLabel(mode) {
    return mode === "off" ? "No e-mails" : mode === "instant_important" ? "Instant, important only" : mode === "daily" ? "Daily digest" : "Studio default";
  }

  return { sections: sections, snoozeChoices: snoozeChoices, keyAction: keyAction, when: when, emptyText: emptyText,
           digestLabel: digestLabel, ddmmyyyy: ddmmyyyy, clock: clock, parts: parts, DEFAULT_TZ: DEFAULT_TZ };
});
