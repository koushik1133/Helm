/* studio-templates-core.js (0096) - pure helpers for a studio's OWN floor-layout templates.
 * No DOM. Used by studio-templates.js (builder + Control Center + layout wizard) and the tests.
 *   validate(meta)            name / event type / description checks (same limits as the DB)
 *   payload(meta, items, room, thumb)  the jsonb sent to studio_template_save (size-limited)
 *   fitToHall(data, hall, cap) template objects scaled / clamped to the CURRENT hall (ft)
 *   order(rows, eventType)    picker order: live only; default for this event type, same type, rest
 *   thumbOk(dataUrl)          a preview the DB will accept (png / jpeg / webp data URL, <= 400 KB)
 *   roomOf(data)              the template's own hall {w,h} ft: data.room (saved here), else the builder's
 *                             scale.worldFt / venue.room (sample templates seeded by SQL carry only those)
 *   previewShapes(data, max)  plain shapes for a card preview drawn from the layout itself, used when
 *                             a template has no stored picture: {w, h, rects[{x,y,w,h,rot,fill,round}], more} */
(function (G) {
  "use strict";
  var EVENT_TYPES = [["wedding", "Wedding"], ["reception", "Reception"], ["engagement", "Engagement"], ["birthday", "Birthday"],
    ["corporate", "Corporate"], ["product_launch", "Product launch"], ["conference", "Conference"], ["political", "Political / rally"],
    ["concert", "Concert"], ["festival", "Festival"], ["other", "Other"]];
  var LIMITS = { name: 120, description: 1000, items: 5000, dataBytes: 600 * 1024, thumbChars: 400 * 1024 };

  function label(key) { for (var i = 0; i < EVENT_TYPES.length; i++) if (EVENT_TYPES[i][0] === key) return EVENT_TYPES[i][1]; return key || "Any event"; }
  function num(v) { var n = +v; return isFinite(n) ? n : null; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function validate(m) {
    m = m || {}; var errors = [];
    var name = String(m.name == null ? "" : m.name).trim(), desc = String(m.description == null ? "" : m.description).trim();
    var type = String(m.event_type == null ? "" : m.event_type).trim().toLowerCase();
    if (!name) errors.push({ field: "name", msg: "Give the template a name." });
    else if (name.length > LIMITS.name) errors.push({ field: "name", msg: "Name is too long (" + LIMITS.name + " characters max)." });
    if (type && !/^[a-z][a-z0-9_]{0,39}$/.test(type)) errors.push({ field: "event_type", msg: "Unknown event type." });
    if (desc.length > LIMITS.description) errors.push({ field: "description", msg: "Description is too long (" + LIMITS.description + " characters max)." });
    return { ok: !errors.length, errors: errors, value: { name: name, event_type: type || null, description: desc || null } };
  }

  function thumbOk(t) {
    return typeof t === "string" && t.length <= LIMITS.thumbChars && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(t);
  }

  function roomOf(d) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    var c = [d.room, d.scale && d.scale.worldFt, d.venue && d.venue.room];
    for (var i = 0; i < c.length; i++) {
      var r = c[i];
      if (r && typeof r === "object" && num(r.w) > 0 && num(r.h) > 0) return { w: num(r.w), h: num(r.h) };
    }
    return null;
  }

  // card preview straight from the layout JSON (no stored picture). Colours are only ever a plain
  // #hex from the item or the category default; numbers are finite; at most `max` shapes.
  var CAT_COLORS = { seating: "#0d9488", structure: "#2f6fed", av: "#7c5cff", logistics: "#e8912d", decor: "#d6549a",
    security: "#e5484d", safety: "#18a558", catering: "#e8912d", lighting: "#c79a00" };
  var ROUND = { table: 1, cocktail: 1, planter: 1, ottoman: 1, floral: 1, pillar: 1, heater: 1, uplight: 1, fountain: 1, chandelier: 1 };
  function hexColor(c) { return typeof c === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()) ? c.trim().toLowerCase() : null; }
  function previewShapes(data, max) {
    var lim = num(max) > 0 ? Math.floor(num(max)) : 1500;
    var items = (data && Array.isArray(data.items) ? data.items : []).filter(function (it) {
      return it && typeof it === "object" && isFinite(+it.x) && isFinite(+it.y) && num(it.width) > 0 && num(it.height) > 0; });
    var room = roomOf(data), ew = 0, eh = 0;
    items.forEach(function (it) { ew = Math.max(ew, +it.x + +it.width); eh = Math.max(eh, +it.y + +it.height); });
    var W = Math.max(room ? room.w : 0, ew) || 200, H = Math.max(room ? room.h : 0, eh) || 140;
    var rects = items.slice(0, lim).map(function (it) {
      var rot = num(it.rotation); rot = isFinite(rot) ? ((rot % 360) + 360) % 360 : 0;
      var shape = it.properties && typeof it.properties === "object" ? it.properties.shape : null;
      return { x: +it.x, y: +it.y, w: Math.max(0.3, +it.width), h: Math.max(0.3, +it.height), rot: rot,
        fill: hexColor(it.color) || CAT_COLORS[it.category] || "#8a8f98",
        round: !!ROUND[it.type] && shape !== "square" };
    });
    // big pieces first, so chairs / decor stay visible on top of stages and seat blocks
    rects.sort(function (a, b) { return b.w * b.h - a.w * a.h; });
    return { w: Math.round(W * 100) / 100, h: Math.round(H * 100) / 100, rects: rects, more: Math.max(0, items.length - rects.length) };
  }

  // items: the builder's floor objects; room: {w,h} in ft. Throws a plain-words Error when too big.
  function payload(meta, items, room, thumb) {
    var v = validate(meta); if (!v.ok) { var e = new Error(v.errors[0].msg); e.field = v.errors[0].field; throw e; }
    var list = (Array.isArray(items) ? items : []).filter(function (it) { return it && typeof it === "object"; });
    if (list.length > LIMITS.items) throw new Error("This layout has more than " + LIMITS.items + " objects - too large for a template.");
    var w = num(room && room.w), h = num(room && room.h);
    var data = { v: 1, items: JSON.parse(JSON.stringify(list)), room: { w: w > 0 ? Math.round(w) : 200, h: h > 0 ? Math.round(h) : 140 } };
    if (JSON.stringify(data).length > LIMITS.dataBytes) throw new Error("This layout is too large to save as a template.");
    var out = { name: v.value.name, event_type: v.value.event_type, description: v.value.description, data: data };
    if (thumb !== undefined) out.thumbnail = thumbOk(thumb) ? thumb : null;
    return out;
  }

  // Scale the template's positions from its own hall to the current hall; objects never grow,
  // they shrink only when the hall is smaller, and everything is clamped inside the floor.
  function fitToHall(data, hall, capFt) {
    var cap = num(capFt) > 0 ? num(capFt) : 1000;
    var items = (data && Array.isArray(data.items) ? data.items : []).filter(function (it) { return it && typeof it === "object"; });
    var W = clamp(num(hall && hall.w) || 200, 20, cap), H = clamp(num(hall && hall.h) || 140, 20, cap);
    var src = roomOf(data);   // data.room, else the builder's scale.worldFt / venue.room (SQL-seeded samples)
    if (!src) {   // older data: use the objects' extent
      src = { w: 0, h: 0 };
      items.forEach(function (it) { src.w = Math.max(src.w, (num(it.x) || 0) + (num(it.width) || 0)); src.h = Math.max(src.h, (num(it.y) || 0) + (num(it.height) || 0)); });
      src.w = src.w || W; src.h = src.h || H;
    }
    var sx = W / src.w, sy = H / src.h, kx = Math.min(1, sx), ky = Math.min(1, sy);
    var out = items.map(function (it) {
      var c = JSON.parse(JSON.stringify(it));
      var wd = Math.max(0.5, (num(c.width) || 1) * kx), ht = Math.max(0.5, (num(c.height) || 1) * ky);
      wd = Math.min(wd, W); ht = Math.min(ht, H);
      var cx = ((num(c.x) || 0) + (num(c.width) || 0) / 2) * sx, cy = ((num(c.y) || 0) + (num(c.height) || 0) / 2) * sy;
      c.width = Math.round(wd * 100) / 100; c.height = Math.round(ht * 100) / 100;
      c.x = Math.round(clamp(cx - wd / 2, 0, W - wd) * 100) / 100; c.y = Math.round(clamp(cy - ht / 2, 0, H - ht) * 100) / 100;
      return c;
    });
    return { items: out, hall: { w: W, h: H }, scaled: Math.abs(sx - 1) > 0.001 || Math.abs(sy - 1) > 0.001, from: src };
  }

  function order(rows, eventType) {
    var t = eventType || "";
    return (Array.isArray(rows) ? rows : []).filter(function (r) { return r && !r.archived; }).slice().sort(function (a, b) {
      var ra = (a.is_default && (a.event_type || "") === t ? 0 : (t && a.event_type === t ? 1 : (a.is_default ? 2 : 3)));
      var rb = (b.is_default && (b.event_type || "") === t ? 0 : (t && b.event_type === t ? 1 : (b.is_default ? 2 : 3)));
      return ra - rb || String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  var API = { EVENT_TYPES: EVENT_TYPES, LIMITS: LIMITS, label: label, validate: validate, thumbOk: thumbOk, payload: payload, fitToHall: fitToHall, order: order,
    roomOf: roomOf, previewShapes: previewShapes };
  G.HelmStudioTemplatesCore = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
