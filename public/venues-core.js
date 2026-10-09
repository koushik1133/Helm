/* venues-core.js (0085) - pure venue logic shared by Control Center, the quote flow and the
 * builder: option lists + labels, metre/foot conversion, form validation, and the warnings
 * shown when a saved venue is picked for an event. No DOM, no network. */
(function (global) {
  "use strict";
  var FT_PER_M = 3.28084;
  var VENUE_TYPES = [
    ["convention_centre", "Convention centre"], ["banquet_hall", "Banquet hall"], ["lawn", "Lawn / open ground"],
    ["hotel_ballroom", "Hotel ballroom"], ["resort", "Resort"], ["community_hall", "Community hall"],
    ["rooftop", "Rooftop"], ["other", "Other"]];
  var AC_TYPES = [["ac", "AC"], ["non_ac", "Non-AC"], ["partial", "Partial AC"]];
  var SETTINGS = [["indoor", "Indoor"], ["outdoor", "Outdoor"], ["both", "Indoor + outdoor"]];
  var EVENT_TYPES = [
    ["wedding", "Wedding"], ["reception", "Reception"], ["engagement", "Engagement"], ["birthday", "Birthday"],
    ["corporate", "Corporate"], ["product_launch", "Product launch"], ["conference", "Conference"],
    ["political", "Political"], ["concert", "Concert"], ["festival", "Festival"], ["other", "Other"]];
  var RESTRICTIONS = [
    ["sound_curfew", "Music / sound curfew"], ["no_open_flame", "No open flame"], ["no_fireworks", "No fireworks"],
    ["no_outside_catering", "Outside catering not allowed"], ["decor_vendor_tieup", "Decor vendor tie-up only"],
    ["no_alcohol", "No alcohol"], ["parking_limited", "Parking limits"], ["generator_required", "Generator required"],
    ["generator_not_allowed", "Generator not allowed"], ["setup_window", "Setup time window"]];
  var COST_BASIS = [["per_day", "per day"], ["per_slot", "per slot"], ["per_plate", "per plate"]];

  function label(list, key) { for (var i = 0; i < list.length; i++) if (list[i][0] === key) return list[i][1]; return key || ""; }
  function keys(list) { return list.map(function (x) { return x[0]; }); }
  function num(v) { if (v === null || v === undefined || String(v).trim() === "") return null; var n = Number(v); return isFinite(n) ? n : NaN; }
  function seats0(v) { var n = num(v); return n && n > 0 ? Math.round(n) : 0; }
  function round2(n) { return Math.round(n * 100) / 100; }

  // canonical storage is metres; the UI may show feet
  function toMeters(v, unit) { var n = num(v); if (n === null || isNaN(n)) return n; return round2(unit === "ft" ? n / FT_PER_M : n); }
  // feet are shown to 0.1 ft: metres are stored to the cm, so 2 decimals of feet would turn a typed 8 ft into 8.01
  function fromMeters(m, unit) { var n = num(m); if (n === null || isNaN(n)) return n; return unit === "ft" ? Math.round(n * FT_PER_M * 10) / 10 : round2(n); }
  function mToFt(m) { var n = num(m); return n === null || isNaN(n) ? null : Math.round(n * FT_PER_M); }

  // Rupees in Indian short form: 350000 -> "3.5 L", 12000000 -> "1.2 Cr"
  function inrShort(v) {
    var n = num(v); if (n === null || isNaN(n)) return "";
    if (n >= 1e7) return "₹" + round2(n / 1e7).toString() + " Cr";
    if (n >= 1e5) return "₹" + round2(n / 1e5).toString() + " L";
    return "₹" + Math.round(n).toLocaleString("en-IN");
  }
  function costText(v) {
    if (!v) return ""; var a = num(v.cost_min), b = num(v.cost_max);
    if (a === null && b === null) return "";
    var basis = label(COST_BASIS, v.cost_basis || "per_day");
    if (a !== null && b !== null && a !== b) return inrShort(a) + " - " + inrShort(b) + " " + basis;
    return inrShort(a !== null ? a : b) + " " + basis;
  }

  // f = form values (strings ok). unit = the unit the length/width are typed in.
  // Returns { ok, errors: [{field, msg}], value: payload for venue_save (metres) }.
  function validate(f, unit) {
    f = f || {}; unit = unit === "ft" ? "ft" : "m";
    var errors = [], bad = function (field, msg) { errors.push({ field: field, msg: msg }); };
    var name = String(f.name || "").trim();
    if (!name) bad("name", "Give the venue a name."); else if (name.length > 200) bad("name", "Name is too long (200 characters max).");
    var seat = num(f.seated_capacity), flt = num(f.floating_capacity);
    if (seat !== null && (isNaN(seat) || seat <= 0 || Math.floor(seat) !== seat)) bad("seated_capacity", "Seated capacity must be a whole number more than 0.");
    if (flt !== null && (isNaN(flt) || flt <= 0 || Math.floor(flt) !== flt)) bad("floating_capacity", "Floating capacity must be a whole number more than 0.");
    if (seat === null && flt === null) bad("seated_capacity", "Enter a seated or floating capacity (more than 0).");
    var len = num(f.length), wid = num(f.width);
    if (len !== null && (isNaN(len) || len <= 0)) bad("length", "Length must be more than 0.");
    if (wid !== null && (isNaN(wid) || wid <= 0)) bad("width", "Width must be more than 0.");
    var cmin = num(f.cost_min), cmax = num(f.cost_max);
    if (cmin !== null && (isNaN(cmin) || cmin < 0)) bad("cost_min", "Minimum cost must be 0 or more.");
    if (cmax !== null && (isNaN(cmax) || cmax < 0)) bad("cost_max", "Maximum cost must be 0 or more.");
    if (cmin !== null && cmax !== null && !isNaN(cmin) && !isNaN(cmax) && cmin > cmax) bad("cost_max", "Minimum cost cannot be more than the maximum.");
    ["parking_spaces", "rooms", "power_backup_kw", "green_rooms", "washrooms"].forEach(function (k) {
      var n = num(f[k]); if (n !== null && (isNaN(n) || n < 0)) bad(k, "Must be 0 or more.");
    });
    var map = String(f.map_url || "").trim();
    if (map && !/^https:\/\/[^\s<>"]+$/i.test(map)) bad("map_url", "The map link must start with https://");
    var curfew = String(f.sound_curfew || "").trim();
    if (curfew && !/^([01]\d|2[0-3]):[0-5]\d$/.test(curfew)) bad("sound_curfew", "Use a time like 22:00.");
    var pick = function (list, v, d) { return keys(list).indexOf(v) >= 0 ? v : d; };
    var arr = function (list, v) { var k = keys(list); return (Array.isArray(v) ? v : []).filter(function (x, i, a) { return k.indexOf(x) >= 0 && a.indexOf(x) === i; }); };
    var t = function (k) { var s = String(f[k] == null ? "" : f[k]).trim(); return s || null; };
    var value = {
      name: name, venue_type: pick(VENUE_TYPES, f.venue_type, "other"), ac_type: pick(AC_TYPES, f.ac_type, "ac"),
      setting: pick(SETTINGS, f.setting, "indoor"), seated_capacity: seat, floating_capacity: flt,
      length_m: len === null || isNaN(len) ? null : toMeters(len, unit), width_m: wid === null || isNaN(wid) ? null : toMeters(wid, unit),
      dim_unit: unit, event_types: arr(EVENT_TYPES, f.event_types), restrictions: arr(RESTRICTIONS, f.restrictions),
      restrictions_note: t("restrictions_note"), sound_curfew: curfew || null, setup_window: t("setup_window"),
      cost_min: cmin, cost_max: cmax, cost_basis: pick(COST_BASIS, f.cost_basis, "per_day"),
      parking_spaces: num(f.parking_spaces), rooms: num(f.rooms), power_backup_kw: num(f.power_backup_kw),
      green_rooms: num(f.green_rooms), washrooms: num(f.washrooms), address: t("address"), city: t("city"),
      map_url: map || null, contact_name: t("contact_name"), contact_phone: t("contact_phone"),
      contact_email: t("contact_email"), notes: t("notes") };
    return { ok: errors.length === 0, errors: errors, value: value };
  }

  // free-typed event type ("Wedding & gala", "Concert / live music", "DJ night") -> venue event key
  function eventKey(s) {
    var t = String(s || "").toLowerCase();
    if (!t) return null;
    var map = [["product_launch", /launch/], ["engagement", /engage|ring|sagai/], ["reception", /reception/],
      ["wedding", /wedding|shaadi|marriage|sangeet|mehendi|haldi/], ["birthday", /birthday|bday/],
      ["conference", /conference|expo|summit|seminar/], ["corporate", /corporate|office|offsite|award/],
      ["political", /political|rally/], ["festival", /festival|mela|fest\b/], ["concert", /concert|music|dj|gig|live/]];
    for (var i = 0; i < map.length; i++) if (map[i][1].test(t)) return map[i][0];
    return "other";
  }
  var LOUD = ["concert", "festival", "political", "wedding", "reception"];

  // ctx: { guests, eventType (free text or key), loud (bool, e.g. DJ chosen),
  //        items (the layout's items, optional: generator / DJ in the plan), seats (seats in the layout, optional) }
  // -> [{ level: "warn"|"info", code, msg }]
  function warnings(v, ctx) {
    var out = []; if (!v) return out; ctx = ctx || {};
    var g = num(ctx.guests), seat = num(v.seated_capacity), flt = num(v.floating_capacity);
    var cap = Math.max(seat || 0, flt || 0);
    if (g && cap && g > cap) out.push({ level: "warn", code: "capacity", msg: g + " guests is more than this venue holds (" + cap + (flt && flt >= (seat || 0) ? " floating" : " seated") + ")." });
    else if (g && seat && g > seat) out.push({ level: "info", code: "capacity_seated", msg: g + " guests is more than the " + seat + " seated capacity - plan part standing." });
    var key = keys(EVENT_TYPES).indexOf(ctx.eventType) >= 0 ? ctx.eventType : eventKey(ctx.eventType);
    var allowed = Array.isArray(v.event_types) ? v.event_types : [];
    if (key && allowed.length && allowed.indexOf(key) < 0)
      out.push({ level: "warn", code: "event_type", msg: label(EVENT_TYPES, key) + " is not listed as allowed at this venue." });
    if (seats0(ctx.seats) && seat && seats0(ctx.seats) > seat)
      out.push({ level: "warn", code: "seats", msg: seats0(ctx.seats) + " seats in the layout is more than the venue's " + seat + " seated capacity." });
    var r = Array.isArray(v.restrictions) ? v.restrictions : [];
    var its = Array.isArray(ctx.items) ? ctx.items.filter(function (i) { return i && typeof i === "object"; }) : null;
    var has = function (re) { return !!its && its.some(function (i) { return re.test(String(i.type || "")); }); };
    var gen = has(/^generator$/);
    var loud = !!ctx.loud || has(/^(dj|speaker|linearray)$/) || LOUD.indexOf(key) >= 0 || /dj|sangeet|music|band/i.test(String(ctx.eventType || ""));
    if (r.indexOf("sound_curfew") >= 0 && loud)
      out.push({ level: "warn", code: "sound_curfew", msg: "Sound curfew" + (v.sound_curfew ? " at " + String(v.sound_curfew).slice(0, 5) : "") + " - plan music / DJ to end on time." });
    if (r.indexOf("no_fireworks") >= 0 && (key === "wedding" || key === "festival" || key === "concert" || key === "reception"))
      out.push({ level: "info", code: "no_fireworks", msg: "No fireworks at this venue." });
    if (r.indexOf("no_open_flame") >= 0) out.push({ level: "info", code: "no_open_flame", msg: "No open flame (diyas, havan, flambe counters) without approval." });
    if (r.indexOf("no_outside_catering") >= 0) out.push({ level: "warn", code: "no_outside_catering", msg: "Outside catering is not allowed - menu must come from the venue." });
    if (r.indexOf("decor_vendor_tieup") >= 0) out.push({ level: "info", code: "decor_vendor_tieup", msg: "Decor only through the venue's tied-up vendor." });
    if (r.indexOf("no_alcohol") >= 0) out.push({ level: "info", code: "no_alcohol", msg: "No alcohol at this venue." });
    if (r.indexOf("generator_required") >= 0) out.push(its && !gen
      ? { level: "warn", code: "generator_required", msg: "Generator required at this venue - the layout has none yet." }
      : { level: "info", code: "generator_required", msg: "Generator required - add power to the plan." });
    if (r.indexOf("generator_not_allowed") >= 0) out.push(gen
      ? { level: "warn", code: "generator_not_allowed", msg: "The layout has a generator, but this venue does not allow generators." }
      : { level: "info", code: "generator_not_allowed", msg: "Generators are not allowed." });
    if (r.indexOf("parking_limited") >= 0) out.push({ level: "info", code: "parking_limited", msg: "Limited parking" + (v.parking_spaces ? " (" + v.parking_spaces + " spaces)" : "") + " - plan valet / shuttles." });
    if (r.indexOf("setup_window") >= 0) out.push({ level: "info", code: "setup_window", msg: "Setup window: " + (v.setup_window || "check with the venue") + "." });
    return out;
  }

  // what a picked venue fills in. Builder works in feet; flow hall fields are feet too.
  function fillFor(v) {
    if (!v) return null;
    return { name: v.name || "", address: [v.address, v.city].filter(Boolean).join(", "),
      contact: [v.contact_name, v.contact_phone].filter(Boolean).join(" / "),
      lenFt: mToFt(v.length_m), widFt: mToFt(v.width_m),
      setting: v.setting === "outdoor" ? "outdoor" : "indoor",
      capacity: Math.max(num(v.seated_capacity) || 0, num(v.floating_capacity) || 0) || null };
  }

  function summary(v) {
    if (!v) return "";
    var parts = [label(VENUE_TYPES, v.venue_type), label(AC_TYPES, v.ac_type), label(SETTINGS, v.setting)];
    if (num(v.length_m) && num(v.width_m)) parts.push(fromMeters(v.length_m, "m") + "×" + fromMeters(v.width_m, "m") + " m");
    if (num(v.seated_capacity)) parts.push(Number(v.seated_capacity).toLocaleString("en-IN") + " seated");
    if (num(v.floating_capacity)) parts.push(Number(v.floating_capacity).toLocaleString("en-IN") + " floating");
    var c = costText(v); if (c) parts.push(c);
    return parts.filter(Boolean).join(" · ");
  }

  global.HelmVenues = { FT_PER_M: FT_PER_M, VENUE_TYPES: VENUE_TYPES, AC_TYPES: AC_TYPES, SETTINGS: SETTINGS,
    EVENT_TYPES: EVENT_TYPES, RESTRICTIONS: RESTRICTIONS, COST_BASIS: COST_BASIS, label: label,
    toMeters: toMeters, fromMeters: fromMeters, mToFt: mToFt, inrShort: inrShort, costText: costText,
    validate: validate, eventKey: eventKey, warnings: warnings, fillFor: fillFor, summary: summary };
})(typeof window !== "undefined" ? window : globalThis);
