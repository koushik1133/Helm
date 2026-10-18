/* =========================================================================
   HELM — human-facing event / quotation name:  TYPE_LOC_GUESTS_DDMMMYY
   e.g. WED_HYD_1000_19AUG26. Pure functions, no DOM. Loaded as a plain script
   (window.HelmEventName) before store-api.js, and in tests via require().
   The unique quote CODE (e.g. 08102026-04) is untouched: it stays the internal
   reference used in URLs and links. Only the display title follows this format.
   ========================================================================= */
(function (root) {
  "use strict";
  // Owner-defined type codes (Oct 2026). Multi-word types are matched as phrases first.
  const TYPES = { wedding: "WED", reception: "REC", engagement: "ENG", birthday: "BDAY", corporate: "CORP",
    conference: "CONF", sangeet: "SAN", haldi: "HAL", mehendi: "MEH", mehndi: "MEH", henna: "HEN", political: "POL", rally: "POL",
    gala: "GAL", iftar: "IFT", exhibition: "EXH", "national day": "NAT", eid: "EID", concert: "CON", "product launch": "LAUNCH",
    launch: "LAUNCH", festival: "FEST", anniversary: "ANN", seminar: "SEM", party: "PTY", housewarming: "HSW", "baby shower": "BABY" };
  // codes written by older builds - still recognised as automatic names
  const LEGACY_CODES = ["BDY", "COR", "CON"];
  // common Indian cities (lower-case key, aliases included) -> 3-letter code
  const CITIES = { hyderabad: "HYD", secunderabad: "HYD", bengaluru: "BLR", bangalore: "BLR", mumbai: "MUM", bombay: "MUM",
    delhi: "DEL", "new delhi": "DEL", chennai: "CHE", madras: "CHE", kolkata: "KOL", calcutta: "KOL", pune: "PUN", goa: "GOA",
    ahmedabad: "AMD", jaipur: "JAI", udaipur: "UDR", jodhpur: "JDH", lucknow: "LKO", kochi: "COK", cochin: "COK",
    visakhapatnam: "VIZ", vizag: "VIZ", vijayawada: "VJA", warangal: "WGL", mysuru: "MYS", mysore: "MYS", noida: "NOI",
    gurugram: "GGN", gurgaon: "GGN", chandigarh: "CHD", indore: "IDR", bhopal: "BPL", nagpur: "NAG", surat: "SUR",
    coimbatore: "CBE", madurai: "MDU", thiruvananthapuram: "TRV", trivandrum: "TRV", tirupati: "TPT", amritsar: "ATQ",
    agra: "AGR", varanasi: "VNS", patna: "PAT", bhubaneswar: "BBI", guwahati: "GAU", nashik: "NSK", mangaluru: "IXE", mangalore: "IXE",
    dubai: "DXB", "abu dhabi": "AUH", sharjah: "SHJ", ajman: "AJM", "ras al khaimah": "RAK", fujairah: "FUJ", "al ain": "AAN" };
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const letters = (s) => String(s == null ? "" : s).toUpperCase().replace(/[^A-Z]/g, "");

  function typeCode(t) {
    const k = String(t == null ? "" : t).trim().toLowerCase(); if (!k) return "";
    const norm = " " + k.replace(/[^a-z]+/g, " ").trim() + " ";
    for (const w of Object.keys(TYPES)) if (w.indexOf(" ") > 0 && norm.indexOf(" " + w + " ") >= 0) return TYPES[w];
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
  const AUTO_RE = /^[A-Z]{1,6}(?:_[A-Z0-9]+)*(?:-\d+)?$/;
  // true when the current title was generated (code / blank / default / this format) — a manual rename is kept
  function isAuto(title, code) {
    const t = String(title == null ? "" : title).trim();
    if (!t || t === "Untitled event" || (code && t === code)) return true;
    if (/^\d{1,7}$/.test(t)) return true;   // B13: a bare guest count written by the old guests-only auto name
    // r9: a quote-code-shaped title (MMDDYYYY-NN) is the creation placeholder even when it no
    // longer equals the code (the client guessed -01, the server issued -02) - still automatic
    if (/^\d{8}-\d{2,}$/.test(t)) return true;
    if (AUTO_RE.test(t) && /_/.test(t)) {
      const head = t.split("_")[0];   // 4-6 letter heads only when they are a known type code (SHARMA_WEDDING stays manual)
      if (head.length <= 3 || Object.keys(TYPES).some((k) => TYPES[k] === head)) return true;
    }
    // a bare 3-letter title is auto only when it is a known type code (a manual "VIP" / "DJS" is kept)
    const bare = /^([A-Z]{3,6})(?:-\d+)?$/.exec(t);
    return !!bare && (Object.keys(TYPES).some((k) => TYPES[k] === bare[1]) || LEGACY_CODES.indexOf(bare[1]) >= 0);
  }
  /* The name shown for a quote in lists / headers: a custom name is kept; an automatic one
     (blank, the quote code, a bare number, an old format) is recomputed from the event's
     current details. Falls back to the stored title / code when nothing is known. Display only. */
  function displayName(q) {
    q = q || {}; const title = String(q.title == null ? "" : q.title).trim();
    if (title && !isAuto(title, q.code)) return title;
    const auto = fromQuote(q);
    if (auto) return (title && (title === auto || title.indexOf(auto + "-") === 0)) ? title : auto;
    return title && !/^\d{8}-\d{2,}$/.test(title) && title !== q.code ? title : (title || q.code || "Untitled event");
  }
  const NAME_MAX = 80;
  // validation for a typed name: returns "" when ok, else a message
  function validateName(s) {
    const t = String(s == null ? "" : s).trim();
    if (!t) return "The name can't be empty.";
    if (t.length > NAME_MAX) return "Keep the name to " + NAME_MAX + " characters or fewer.";
    return "";
  }
  const HINT = "Auto name: TYPE_CITY_GUESTS_DATE — type your own to customise";
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
    seminar: "Seminar", "product launch": "Product launch", galadinner: "Gala dinner", henna: "Henna night", festival: "Festival", launch: "Product launch", "gala dinner": "Gala dinner", iftar: "Iftar", suhoor: "Suhoor", eid: "Eid celebration", "national day": "National Day celebration", exhibition: "Exhibition", concert: "Concert", party: "Party", general: "Event", other: "Event" };
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
  /* one shared event-type dropdown list (flow "Event type", leads, quotes filter). Custom studio
     entries live in localStorage helm_vocab_event_types (added when a new type is saved). */
  const EVENT_TYPE_LIST = ["Wedding","Reception","Engagement","Sangeet","Birthday","Anniversary","Corporate","Conference","Concert","Festival","Exhibition","Product launch","Political","Gala dinner","Seminar","Workshop","Religious / Puja","House warming","Baby shower","Get-together"];
  const EVENT_TYPE_LIST_AE = ["Wedding","Engagement","Henna night","Gala dinner","Corporate","Conference","Exhibition","Product launch","Iftar","Suhoor","Eid celebration","National Day celebration","Birthday","Anniversary","Concert","Festival","Award ceremony","Seminar","Workshop","Baby shower","Get-together"];
  function vocabExtra() { try { const a = JSON.parse((root && root.localStorage && root.localStorage.getItem("helm_vocab_event_types")) || "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch (e) { return []; } }
  function eventTypeOptions(country, current, extra) {
    const out = [], seen = {};
    const push = (v) => { v = String(v == null ? "" : v).trim(); const k = v.toLowerCase(); if (v && !seen[k]) { seen[k] = 1; out.push(v); } };
    (country === "AE" ? EVENT_TYPE_LIST_AE : EVENT_TYPE_LIST).forEach(push);
    (extra || vocabExtra()).forEach(push);
    if (current) push(canonEventType(current, country, extra));   // a saved custom value is never dropped
    return out;
  }
  /* case/space-insensitive match to a list entry ("wedding " -> "Wedding"); otherwise the trimmed custom text */
  function canonEventType(v, country, extra) {
    const raw = String(v == null ? "" : v).trim().replace(/\s+/g, " "); if (!raw) return "";
    const k = raw.toLowerCase();
    const all = EVENT_TYPE_LIST.concat(EVENT_TYPE_LIST_AE, extra || vocabExtra());
    for (const t of all) if (String(t).trim().toLowerCase() === k) return String(t).trim();
    return raw;
  }
  /* LA-29: the name for a list row that ALREADY shows the quote code beside it: when the only name we have is
     the code itself (or a code-shaped placeholder), say "Untitled event" instead of printing the code twice. */
  function listName(q) {
    q = q || {}; const n = String(displayName(q) || "").trim(), code = String(q.code == null ? "" : q.code).trim();
    return !n || (code && n === code) || /^\d{8}-\d{2,}$/.test(n) ? "Untitled event" : n;
  }
  const api = { listName, EVENT_TYPE_LIST, EVENT_TYPE_LIST_AE, eventTypeOptions, canonEventType, TYPES, LEGACY_CODES, NAME_MAX, HINT, displayName, validateName, CITIES, LABELS, typeCode, cityCode, cityFromText, dateCode, guestsCode, format, fromQuote, isAuto, unique, label, shortDate, friendlyTitle };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.HelmEventName = api;
})(typeof window !== "undefined" ? window : null);
