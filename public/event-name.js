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
    const t = typeCode(p.eventType), d = dateCode(p.eventDate);
    // B13: a guest count alone is not a name - "1000" (layout wizard: guests set, nothing else) replaced
    // "Untitled event". A name needs the event type, place or date.
    if (!t && !loc && !d) return "";
    return [t, loc, guestsCode(p.guests), d].filter(Boolean).join("_");
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
    if (/^\d{1,7}$/.test(t)) return true;   // B13: a bare guest count written by the old guests-only auto name
    // r9: a quote-code-shaped title (MMDDYYYY-NN) is the creation placeholder even when it no
    // longer equals the code (the client guessed -01, the server issued -02) - still automatic
    if (/^\d{8}-\d{2,}$/.test(t)) return true;
    if (AUTO_RE.test(t) && /_/.test(t)) return true;
    // a bare 3-letter title is auto only when it is a known type code (a manual "VIP" / "DJS" is kept)
    const bare = /^([A-Z]{3})(?:-\d+)?$/.exec(t);
    return !!bare && Object.keys(TYPES).some((k) => TYPES[k] === bare[1]);
  }
  // add -2, -3… when another event already uses the name. taken: titles of OTHER events
  function unique(base, taken) {
    if (!base) return base;
    const set = new Set((taken || []).map((x) => String(x || "").trim()));
    if (!set.has(base)) return base;
    for (let i = 2; i < 10000; i++) if (!set.has(base + "-" + i)) return base + "-" + i;
    return base + "-" + Date.now();
  }
  /* E3: one shared, client-facing label map for event types ("wedding" -> "Wedding") */
  const LABELS = { wedding: "Wedding", reception: "Reception", engagement: "Engagement", sangeet: "Sangeet", haldi: "Haldi",
    mehendi: "Mehendi", mehndi: "Mehendi", birthday: "Birthday", corporate: "Corporate event", conference: "Conference",
    political: "Political rally", "political rally": "Political rally", rally: "Political rally", gala: "Gala", anniversary: "Anniversary",
    "baby shower": "Baby shower", housewarming: "Housewarming", "naming ceremony": "Naming ceremony", upanayanam: "Upanayanam",
    seminar: "Seminar", "product launch": "Product launch", concert: "Concert", party: "Party", general: "Event", other: "Event" };
  function label(t) {
    const raw = String(t == null ? "" : t).trim(); if (!raw) return "";
    const k = raw.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    if (LABELS[k]) return LABELS[k];
    for (const w of k.split(" ")) if (LABELS[w] && w !== "other" && w !== "general") return k.split(" ").length === 1 ? LABELS[w] : raw.charAt(0).toUpperCase() + raw.slice(1).replace(/[_]+/g, " ");
    return k.charAt(0).toUpperCase() + k.slice(1);   // custom type: "baby shower" -> "Baby shower"
  }
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(d) {
    const r = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d == null ? "" : d)); if (!r) return "";
    const m = +r[2] - 1; if (!(m >= 0 && m < 12)) return "";
    return (+r[3]) + " " + MON[m] + " " + r[1];
  }
  /* E4: what a CLIENT sees as the event title. A manual rename is kept; an auto code
     (WED_HYD_300_28DEC26 / the quote code / blank) becomes "Asha & Ravi's Wedding" when the
     couple's names are known, else "Wedding for Asha Rao · 28 Dec 2026". The code stays the reference. */
  function friendlyTitle(q) {
    q = q || {}; const c = (q.client && typeof q.client === "object") ? q.client : {};
    const title = String(q.title == null ? "" : q.title).trim();
    if (title && !isAuto(title, q.code)) return title;
    const lbl = label(q.eventType != null ? q.eventType : (q.event_type != null ? q.event_type : c.eventType)) || "Event";
    const names = String(q.names || c.names || c.coupleNames || "").trim().slice(0, 80);
    if (names) return names + "'s " + lbl;
    const who = String(q.clientName || q.client_name || c.name || "").trim().slice(0, 60);
    const when = shortDate(q.eventDate || q.event_date || c.eventDate);
    return (who ? lbl + " for " + who : lbl) + (when ? " · " + when : "");
  }
  const api = { TYPES, CITIES, LABELS, typeCode, cityCode, cityFromText, dateCode, guestsCode, format, fromQuote, isAuto, unique, label, shortDate, friendlyTitle };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.HelmEventName = api;
})(typeof window !== "undefined" ? window : null);
