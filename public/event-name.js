/* =========================================================================
   HELM — human-facing event / quotation name:  TYPE_LOC_GUESTS_DDMMMYY
   e.g. WED_HYD_1000_19AUG26. Pure functions, no DOM. Loaded as a plain script
   (window.HelmEventName) before store-api.js, and in tests via require().
   The unique quote CODE (e.g. 08102026-04) is untouched: it stays the internal
   reference used in URLs and links. Only the display title follows this format.
   ========================================================================= */
(function (root) {
  "use strict";
  const TYPES = { wedding: "WED", reception: "REC", engagement: "ENG", birthday: "BDY", corporate: "COR",
    conference: "CON", sangeet: "SAN", haldi: "HAL", mehendi: "MEH", mehndi: "MEH" };
  // common Indian cities (lower-case key, aliases included) -> 3-letter code
  const CITIES = { hyderabad: "HYD", secunderabad: "HYD", bengaluru: "BLR", bangalore: "BLR", mumbai: "MUM", bombay: "MUM",
    delhi: "DEL", "new delhi": "DEL", chennai: "CHE", madras: "CHE", kolkata: "KOL", calcutta: "KOL", pune: "PUN", goa: "GOA",
    ahmedabad: "AMD", jaipur: "JAI", udaipur: "UDR", jodhpur: "JDH", lucknow: "LKO", kochi: "COK", cochin: "COK",
    visakhapatnam: "VIZ", vizag: "VIZ", vijayawada: "VJA", warangal: "WGL", mysuru: "MYS", mysore: "MYS", noida: "NOI",
    gurugram: "GGN", gurgaon: "GGN", chandigarh: "CHD", indore: "IDR", bhopal: "BPL", nagpur: "NAG", surat: "SUR",
    coimbatore: "CBE", madurai: "MDU", thiruvananthapuram: "TRV", trivandrum: "TRV", tirupati: "TPT", amritsar: "ATQ",
    agra: "AGR", varanasi: "VNS", patna: "PAT", bhubaneswar: "BBI", guwahati: "GAU", nashik: "NSK", mangaluru: "IXE", mangalore: "IXE" };
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const letters = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z]/g, "");

  function typeCode(t) {
    const k = String(t == null ? "" : t).trim().toLowerCase(); if (!k) return "";
    for (const w of Object.keys(TYPES)) if (k === w || k.split(/[^a-z]+/).indexOf(w) >= 0) return TYPES[w];
    return letters(k).slice(0, 3);
  }
  // explicit city field: map or first 3 letters
  function cityCode(c) {
    const k = String(c == null ? "" : c).trim().toLowerCase().replace(/\s+/g, " "); if (!k) return "";
    if (CITIES[k]) return CITIES[k];
    const first = k.split(",")[0].trim(); if (CITIES[first]) return CITIES[first];
    return letters(first).slice(0, 3);
  }
  // free text (venue / address): only a KNOWN city is recognised, never a guess
  function cityFromText(txt) {
    const k = " " + String(txt == null ? "" : txt).toLowerCase().replace(/[^a-z]+/g, " ") + " ";
    let best = "", at = -1;
    for (const name of Object.keys(CITIES)) { const i = k.lastIndexOf(" " + name + " "); if (i > at) { at = i; best = CITIES[name]; } }
    return best;
  }
  function dateCode(d) {
    let y, m, day;
    if (d instanceof Date && !isNaN(d)) { y = d.getFullYear(); m = d.getMonth(); day = d.getDate(); }
    else { const r = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d == null ? "" : d)); if (!r) return ""; y = +r[1]; m = +r[2] - 1; day = +r[3]; }
    if (!(m >= 0 && m < 12) || !(day >= 1 && day <= 31)) return "";
    return String(day).padStart(2, "0") + MONTHS[m] + String(y % 100).padStart(2, "0");
  }
  function guestsCode(g) { const n = Number(g); return Number.isFinite(n) && n > 0 ? String(Math.floor(Math.min(n, 9999999))) : ""; }

  /* parts: { eventType, city, venue, address, guests, eventDate } — any may be missing (omitted) */
  function format(p) {
    p = p || {};
    const loc = cityCode(p.city) || cityFromText(p.venue) || cityFromText(p.address);
    return [typeCode(p.eventType), loc, guestsCode(p.guests), dateCode(p.eventDate)].filter(Boolean).join("_");
  }
  // from a quote row / summary (supabase or local shape)
  function fromQuote(q) {
    q = q || {}; const c = (q.client && typeof q.client === "object") ? q.client : {};
    return format({ eventType: q.eventType != null ? q.eventType : q.event_type, city: c.city, venue: c.venue, address: c.address,
      guests: c.guests, eventDate: q.eventDate || q.event_date || c.eventDate });
  }
  const AUTO_RE = /^[A-Z]{1,3}(?:_[A-Z0-9]+)*(?:-\d+)?$/;
  // true when the current title was generated (code / blank / default / this format) — a manual rename is kept
  function isAuto(title, code) {
    const t = String(title == null ? "" : title).trim();
    if (!t || t === "Untitled event" || (code && t === code)) return true;
    return AUTO_RE.test(t) && /_/.test(t) || /^[A-Z]{3}(?:-\d+)?$/.test(t);
  }
  // add -2, -3… when another event already uses the name. taken: titles of OTHER events
  function unique(base, taken) {
    if (!base) return base;
    const set = new Set((taken || []).map((x) => String(x || "").trim()));
    if (!set.has(base)) return base;
    for (let i = 2; i < 10000; i++) if (!set.has(base + "-" + i)) return base + "-" + i;
    return base + "-" + Date.now();
  }
  const api = { TYPES, CITIES, typeCode, cityCode, cityFromText, dateCode, guestsCode, format, fromQuote, isAuto, unique };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.HelmEventName = api;
})(typeof window !== "undefined" ? window : null);
