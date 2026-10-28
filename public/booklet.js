/* booklet.js — the client event booklet (booklet.html?t=<token>, 0065).
   • Data comes only from BPStore.booklet.get() → public_get_booklet(token), which returns
     client-safe fields for ONE event (server is the authority; expired / revoked → "invalid link").
   • Every value is inserted with textContent / setAttribute — no HTML strings, no innerHTML.
   • The floor plan is drawn read-only as SVG from the saved layout shapes; the 3D view is an
     isometric extrusion of the same shapes (no WebGL, no external libraries).
   • "Download PDF" = window.print() with the print stylesheet in booklet.css. */
(function (global) {
  "use strict";
  const doc = global.document;
  const SVGNS = "http://www.w3.org/2000/svg";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const CAT_COLOR = { structure: "#8b7cf6", seating: "#d4a373", av: "#4f9bd9", decor: "#e07a9a", logistics: "#8a9a5b",
    safety: "#e0a33a", security: "#6b7280" };
  const CAT_LABEL = { structure: "Structure", seating: "Seating", av: "Sound & light", decor: "Décor", logistics: "Logistics",
    safety: "Safety", security: "Security" };
  const CAT_HEIGHT = { structure: 4, seating: 2.6, av: 7, decor: 6, logistics: 4, safety: 3, security: 3 };
  const SECTIONS = [["details", "Event details"], ["layout2d", "Floor plan"], ["layout3d", "3D view"], ["menu", "Menu"],
    ["quote", "Quotation"], ["versions", "Quote history"], ["payments", "Payments"], ["terms", "Terms"]];
  const DEFAULT_TERMS = [
    "This booklet summarises the event as planned on the date shown. Final quantities, menu and layout may be adjusted with your agreement.",
    "Prices include the taxes shown. Any change to guest numbers, menu or set-up after confirmation may change the total.",
    "Payments are due on the dates listed in the payment schedule. Bookings are held once the first payment is received.",
    "Please contact the studio with any questions about this booklet.",
  ];

  // tax name per quote currency for non-India studios (India keeps CGST/SGST/IGST/GST) - 0079
  const TAX_BY_CURRENCY = { AED: "VAT", GBP: "VAT", USD: "Sales tax", SGD: "GST", AUD: "GST", CAD: "GST/HST", EUR: "VAT" };
  /* ---- pure helpers (exported for tests) ---- */
  function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
  // 0069: language / currency come from the quote (validated; default en-IN / INR)
  const FMT = { locale: "en-IN", currency: "INR" };
  function setFormat(locale, currency) {
    try { if (locale && typeof locale === "string" && locale.length < 36) { new Intl.DateTimeFormat(locale); FMT.locale = locale; } } catch (e) {}
    if (currency && /^[A-Z]{3}$/.test(String(currency))) FMT.currency = String(currency);
    try { if (doc && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(FMT.locale)) doc.documentElement.setAttribute("lang", FMT.locale); } catch (e) {}
    return { locale: FMT.locale, currency: FMT.currency };
  }
  function money(n) {
    const v = num(n); if (v == null) return "—";
    try { return new Intl.NumberFormat(FMT.locale, { style: "currency", currency: FMT.currency, maximumFractionDigits: 0 }).format(v); } catch (e) { return String(Math.round(v)); }
  }
  // R36: parse with HelmCountry.parseTime so "6:30 PM" stays PM (the old H:MM-only match made it 6:30 AM).
  // Without country-profile.js a 12h string is shown as typed rather than guessed.
  function parseTime(t) {
    const HC = global.HelmCountry; if (HC && HC.parseTime) return HC.parseTime(t);
    const m = /^(\d{1,2}):(\d{2})(?!\d|\s*[ap]\.?\s*m)/i.exec(String(t == null ? "" : t));
    return m && +m[1] < 24 && +m[2] < 60 ? { h: +m[1], m: +m[2] } : null;
  }
  function fmtTime(t) {
    const p = parseTime(t); if (!p) return t ? String(t).slice(0, 40) : "";
    const dt = new Date(2000, 0, 1, p.h, p.m);
    try { return dt.toLocaleTimeString(FMT.locale, { hour: "numeric", minute: "2-digit" }); } catch (e) { return p.h + ":" + (p.m < 10 ? "0" : "") + p.m; }
  }
  // a maps search link for the venue (external, no app links); only https and a text query
  function mapLink(e) {
    e = e || {};
    if (typeof e.venue_map_url === "string" && /^https:\/\/[^\s"'<>]+$/i.test(e.venue_map_url) && e.venue_map_url.length <= 500) return e.venue_map_url;
    const q = [e.venue_name, e.venue_address].filter(Boolean).join(", ").slice(0, 300);
    return q ? "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q) : null;
  }
  function fmtDate(d) {
    if (!d) return "";
    const s = String(d); const dt = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00" : s);
    if (isNaN(dt.getTime())) return s;
    try { return dt.toLocaleDateString(FMT.locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }); } catch (e) { return s; }
  }
  function shortDate(d) {
    if (!d) return "";
    const dt = new Date(String(d).length === 10 ? d + "T00:00:00" : d);
    if (isNaN(dt.getTime())) return String(d);
    // a timestamp (not a plain day) is shown in the studio's zone for INR / AED quotes, so "valid until" is the same day as the studio's share box
    const tz = String(d).length === 10 ? undefined : (FMT.currency === "INR" ? "Asia/Kolkata" : FMT.currency === "AED" ? "Asia/Dubai" : undefined);
    try { return dt.toLocaleDateString(FMT.locale, tz ? { day: "numeric", month: "short", year: "numeric", timeZone: tz } : { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return String(d); }
  }
  function safeHex(c) { return typeof c === "string" && HEX_RE.test(c.trim()) ? c.trim() : null; }
  function safeLogo(u) { return typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u) && u.length <= 500 ? u : null; }
  function tokenFrom(search) {
    const p = new URLSearchParams(search || "");
    const t = String(p.get("t") || p.get("token") || "").trim();
    return UUID_RE.test(t) ? t : null;
  }
  // client-facing quotation lines from the allow-listed pricing object
  function quoteLines(q) {
    q = q || {}; const c = q.computed || {}; const out = [];
    const chairs = num(q.chairs) || 0, chairPrice = num(q.chairPrice) || 0, other = num(q.other) || 0;
    const guests = num(q.guests) || 0, plate = num(q.platePrice) || 0, catAmt = num(q.cateringAmount) || 0;
    if (chairs && chairPrice) out.push({ label: "Seating", detail: chairs + " chairs × " + money(chairPrice), amount: chairs * chairPrice });
    if (other) out.push({ label: "Décor, staging & equipment", detail: "", amount: other });
    if (q.cateringMode === "client") out.push({ label: "Catering", detail: "Arranged by you", amount: 0 });
    else {
      if (guests && plate) out.push({ label: "Catering", detail: guests + " plates × " + money(plate), amount: guests * plate });
      if (catAmt) out.push({ label: "Additional catering", detail: "", amount: catAmt });
    }
    const svc = num(c.serviceCharge);
    if (svc) out.push({ label: "Service charge", detail: q.serviceChargePct ? q.serviceChargePct + "%" : "", amount: svc });
    const sub = num(c.subtotal);
    if (sub != null && out.length) out.push({ label: "Subtotal", detail: "", amount: sub, kind: "sub" });
    const disc = num(c.discount);
    if (disc) out.push({ label: "Discount", detail: q.couponCode ? "Code " + String(q.couponCode).slice(0, 32) : "", amount: -disc, kind: "neg" });
    const igst = num(c.igst), cgst = num(c.cgst), sgst = num(c.sgst), gst = num(c.totalGst);
    const pct = num(q.gstPct);
    // 0079/0081: the server now returns the quote's own tax keys (taxCountry / taxName /
    // taxInclusive); use them for the exact label. Older servers: infer from the currency.
    const cur = String(q.currency || "INR").toUpperCase();
    const cc = /^[A-Z]{2}$/.test(String(q.taxCountry || "")) ? String(q.taxCountry) : null;
    const nm = String(q.taxName == null ? "" : q.taxName).replace(/[<>"'`\u0000-\u001f]/g, "").trim().slice(0, 24);
    const india = cc ? cc === "IN" : cur === "INR";
    const tn = india ? null : (nm || TAX_BY_CURRENCY[cur] || "Tax");
    const incl = q.taxInclusive === true || String(q.taxInclusive).toLowerCase() === "true"
      || (!india && q.taxInclusive == null && sub != null && !!gst && num(q.total) != null && Math.round(sub - (disc || 0)) === Math.round(num(q.total)));
    const inc = incl ? " (included)" : "";
    if (tn && (gst || igst || cgst || sgst)) out.push({ label: tn + inc, detail: pct ? pct + "%" : "", amount: gst || ((igst || 0) + (cgst || 0) + (sgst || 0)) });
    else if (tn) { /* no tax on this quote */ }
    else if (igst) out.push({ label: "IGST" + inc, detail: pct ? pct + "%" : "", amount: igst });
    else if (cgst || sgst) {
      // one rounding to whole rupees, split from it: CGST + SGST = GST on every screen
      const g2 = Math.round((cgst || 0) + (sgst || 0)), c2 = Math.round(g2 / 2);
      out.push({ label: "CGST" + inc, detail: pct ? pct / 2 + "%" : "", amount: c2 });
      out.push({ label: "SGST" + inc, detail: pct ? pct / 2 + "%" : "", amount: g2 - c2 });
    } else if (gst) out.push({ label: "GST" + inc, detail: pct ? pct + "%" : "", amount: gst });
    const total = num(q.total) != null ? num(q.total) : num(c.total);
    return { lines: out, total: total };
  }
  function normalizeItems(layout) {
    const items = (layout && Array.isArray(layout.items) ? layout.items : []).map((it) => {
      const x = num(it && it.x), y = num(it && it.y), w = num(it && it.width), h = num(it && it.height);
      if (x == null || y == null || !w || !h || w <= 0 || h <= 0 || w > 5000 || h > 5000) return null;
      const cat = CAT_COLOR[it.category] ? it.category : "other";
      return { x: x, y: y, w: w, h: h, r: num(it.rotation) || 0, type: String(it.type || ""), cat: cat,
        label: String(it.label || it.type || "").slice(0, 60), color: safeHex(it.color) || CAT_COLOR[cat] || "#a59e94" };
    }).filter(Boolean);
    let room = layout && layout.room ? { w: num(layout.room.w), h: num(layout.room.h) } : null;
    if (!room || !room.w || !room.h) room = null;
    return { items: items, room: room };
  }
  function bounds(m) {
    let x0 = 0, y0 = 0, x1 = m.room ? m.room.w : 0, y1 = m.room ? m.room.h : 0;
    m.items.forEach((i) => { x0 = Math.min(x0, i.x); y0 = Math.min(y0, i.y); x1 = Math.max(x1, i.x + i.w); y1 = Math.max(y1, i.y + i.h); });
    if (x1 - x0 < 1) x1 = x0 + 10; if (y1 - y0 < 1) y1 = y0 + 10;
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  function corners(i) {
    const cx = i.x + i.w / 2, cy = i.y + i.h / 2, a = (i.r * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    return [[-i.w / 2, -i.h / 2], [i.w / 2, -i.h / 2], [i.w / 2, i.h / 2], [-i.w / 2, i.h / 2]]
      .map((p) => [cx + p[0] * ca - p[1] * sa, cy + p[0] * sa + p[1] * ca]);
  }
  function iso(x, y, z) { return [(x - y) * 0.866, (x + y) * 0.5 - z]; }
  function shade(hex, f) {
    let h = hex.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const n = parseInt(h.slice(0, 6), 16); if (!isFinite(n)) return hex;
    const ch = (s) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
    return "#" + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("");
  }

  let VISIBLE = {};
  /* ---- DOM ---- */
  const $ = (s) => doc.querySelector(s);
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function svg(tag, attrs) { const n = doc.createElementNS(SVGNS, tag); Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k]))); return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function emptyNote(box, text) { box.appendChild(el("p", "empty", text)); }

  function renderCover(d) {
    const s = d.studio || {}, e = d.event || {};
    const accent = safeHex(s.accent);
    if (accent) { try { doc.documentElement.style.setProperty("--accent", accent); doc.documentElement.style.setProperty("--accent-soft", accent + "1a"); } catch (x) {} }
    $("#s_name").textContent = s.name || "Your event studio";
    // QA1026 #3: the <img> is created only when there is a logo — no empty-src image in the DOM.
    const logo = safeLogo(s.logo);
    if (logo && !$("#s_logo")) { const im = doc.createElement("img"); im.id = "s_logo"; im.className = "logo"; im.alt = ""; im.hidden = true; $("#s_mark").parentNode.insertBefore(im, $("#s_mark")); }
    const img = $("#s_logo");
    if (logo && img) { img.setAttribute("src", logo); img.setAttribute("alt", (s.name || "Studio") + " logo"); img.setAttribute("referrerpolicy", "no-referrer");
      img.hidden = false; $("#s_mark").classList.add("has-logo");
      img.addEventListener("error", () => { img.hidden = true; $("#s_mark").classList.remove("has-logo"); }); }
    const ct = clear($("#s_contact"));
    // #16 studio contact, first that exists: (1) the event coordinator's name + phone,
    // (2) the studio business phone (Settings > Studio details), (3) the business email -
    // the server sends it only when an admin saved it there (0075), never the signup login email.
    const co = (d.coordinator && typeof d.coordinator === "object") ? d.coordinator : { name: e.coordinator_name, phone: e.coordinator_phone };
    const tel = (p) => { const a = el("a", "", String(p).slice(0, 32)); a.setAttribute("href", "tel:" + String(p).replace(/[^\d+]/g, "")); return a; };
    const bizEmail = String(s.email || "").trim();
    if (co && (co.name || co.phone)) {
      if (co.name) ct.appendChild(el("span", "", String(co.name).slice(0, 80)));
      if (co.phone) ct.appendChild(tel(co.phone));
    } else if (s.phone) ct.appendChild(tel(s.phone));
    else if (bizEmail && /^[^\s@<>"]+@[^\s@<>"]+$/.test(bizEmail)) { const a = el("a", "", bizEmail); a.setAttribute("href", "mailto:" + bizEmail); ct.appendChild(a); }
    if (s.location) ct.appendChild(el("span", "", String(s.location)));
    const title = clientTitle(e);
    $("#e_title").textContent = title;
    $("#e_sub").textContent = [fmtDate(e.event_date), e.venue_name].filter(Boolean).join(" · ");
    $("#e_for").textContent = e.client_name ? "Prepared for " + e.client_name : "";
    const note = $("#b_note"); note.hidden = !d.note; note.textContent = d.note || "";
    try { doc.title = title + " — Event booklet" + (s.name ? " · " + s.name : ""); } catch (x) {}
  }
  function renderToc() {
    const ol = clear($("#tocList"));
    SECTIONS.filter((s) => VISIBLE[s[0]] !== false).forEach((s, i) => {
      const li = el("li"); const a = el("a"); a.setAttribute("href", "#" + s[0]);
      a.appendChild(el("span", "n", String(i + 1).padStart(2, "0"))); a.appendChild(doc.createTextNode(s[1]));
      li.appendChild(a); ol.appendChild(li);
    });
    if (!("IntersectionObserver" in global)) return;
    const links = Array.from(ol.querySelectorAll("a"));
    const io = new global.IntersectionObserver((ents) => {
      ents.forEach((en) => { if (!en.isIntersecting) return;
        links.forEach((a) => a.setAttribute("aria-current", String(a.getAttribute("href") === "#" + en.target.id))); });
    }, { rootMargin: "-20% 0px -70% 0px" });
    SECTIONS.forEach((s) => { const n = doc.getElementById(s[0]); if (n) io.observe(n); });
  }
  // E3/E4: client-facing title / event type via the shared map (event-name.js); the code is the reference
  function clientTitle(e) { e = e || {}; const H = global.HelmEventName; return H && H.friendlyTitle ? H.friendlyTitle(e) : (e.title || e.code || "Your event"); }
  function typeLabel(t) { const H = global.HelmEventName; return H && H.label ? H.label(t) : (t || ""); }
  function fact(dl, k, v) { if (v == null || v === "") return null; const d = el("div"); d.appendChild(el("dt", "", k)); const dd = el("dd", "", String(v)); d.appendChild(dd); dl.appendChild(d); return dd; }
  function renderDetails(d) {
    const e = d.event || {}, dl = clear($("#factList"));
    fact(dl, "Event", clientTitle(e));
    if (e.code) fact(dl, "Reference", e.code);
    fact(dl, "Occasion", typeLabel(e.event_type));
    fact(dl, "Date", fmtDate(e.event_date));
    const st = fmtTime(e.start_time || e.event_time), en = fmtTime(e.end_time);
    fact(dl, "Time", st && en ? st + " – " + en : st);
    fact(dl, "Venue", e.venue_name);
    const ad = fact(dl, "Address", e.venue_address), ml = mapLink(e);
    if (ml && (e.venue_name || e.venue_address)) {
      const a = el("a", "map-link", "Open in Maps"); a.setAttribute("href", ml); a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener noreferrer");
      (ad || fact(dl, "Map", " ")).appendChild(a);
    }
    const co = (d.coordinator && typeof d.coordinator === "object") ? d.coordinator : { name: e.coordinator_name, phone: e.coordinator_phone };
    if (co.name || co.phone) {
      const cd = fact(dl, "Your coordinator", co.name || "");
      if (cd && co.phone) { const a = el("a", "tel", String(co.phone).slice(0, 32)); a.setAttribute("href", "tel:" + String(co.phone).replace(/[^\d+]/g, "")); cd.appendChild(doc.createTextNode(co.name ? " · " : "")); cd.appendChild(a); }
    }
    global.HelmBookletGuests = num(e.guests) || 0;
    fact(dl, "Guests", num(e.guests) != null ? Number(e.guests).toLocaleString(FMT.locale) : "");
  }
  function render2d(d, figEl, legEl) {
    const fig = clear(figEl || $("#plan2d")), leg = clear(legEl || $("#legend2d") || el("ul"));
    if (!figEl && dbImages(d, "layout2d").length) { dbFigure(fig, d, "2d", dbImages(d, "layout2d"), "Floor plan of the event", () => render2d(Object.assign({}, d, { images: null }))); return; }
    if (!figEl && snapUrl(d, "layout2d")) { snapFigure(fig, snapUrl(d, "layout2d"), "Floor plan of the event", () => render2d(Object.assign({}, d, { snapshots: null }))); return; }
    const m = normalizeItems(d.layout);
    if (!m.items.length) { emptyNote(fig, "The floor plan will appear here once it's ready."); return; }
    const b = bounds(m), pad = 4, w = b.x1 - b.x0 + pad * 2, h = b.y1 - b.y0 + pad * 2;
    const s = svg("svg", { viewBox: (b.x0 - pad) + " " + (b.y0 - pad) + " " + w + " " + h, role: "img", "aria-label": "Floor plan of the event (" + m.items.length + " items)" });
    s.appendChild(svg("rect", { x: b.x0 - pad, y: b.y0 - pad, width: w, height: h, fill: "#fbf8f3" }));
    if (m.room) s.appendChild(svg("rect", { x: 0, y: 0, width: m.room.w, height: m.room.h, fill: "#ffffff", stroke: "#cdbfae", "stroke-width": 0.4 }));
    const fs = Math.max(1.2, Math.min(w, h) / 45);
    m.items.forEach((i) => {
      const g = svg("g", { transform: "rotate(" + i.r + " " + (i.x + i.w / 2) + " " + (i.y + i.h / 2) + ")" });
      const round = /round|cocktail|chandelier|fountain/.test(i.type);
      g.appendChild(round ? svg("ellipse", { cx: i.x + i.w / 2, cy: i.y + i.h / 2, rx: i.w / 2, ry: i.h / 2, fill: i.color, "fill-opacity": 0.82, stroke: shade(i.color, 0.7), "stroke-width": 0.25 })
        : svg("rect", { x: i.x, y: i.y, width: i.w, height: i.h, rx: Math.min(i.w, i.h) * 0.08, fill: i.color, "fill-opacity": 0.82, stroke: shade(i.color, 0.7), "stroke-width": 0.25 }));
      const t = svg("title", {}); t.textContent = i.label; g.appendChild(t);
      if (i.w * i.h > fs * fs * 14 && i.label) {
        const tx = svg("text", { x: i.x + i.w / 2, y: i.y + i.h / 2, "text-anchor": "middle", "dominant-baseline": "central", "font-size": fs,
          fill: "#1f1a17", "font-family": "IBM Plex Sans, sans-serif" });
        tx.textContent = i.label.length > 18 ? i.label.slice(0, 17) + "…" : i.label; g.appendChild(tx);
      }
      s.appendChild(g);
    });
    fig.appendChild(s);
    const cap = el("figcaption", "", m.room ? "Room " + Math.round(m.room.w) + " × " + Math.round(m.room.h) + " ft · " + m.items.length + " items" : m.items.length + " items");
    fig.appendChild(cap);
    Array.from(new Set(m.items.map((i) => i.cat))).forEach((c) => {
      const li = el("li"); li.appendChild(el("span", "sw sw-" + c)); li.appendChild(doc.createTextNode(CAT_LABEL[c] || "Other")); leg.appendChild(li);
    });
  }
  function render3d(d, figEl) {
    const fig = clear(figEl || $("#plan3d"));
    if (!figEl && dbImages(d, "layout3d").length) { dbFigure(fig, d, "3d", dbImages(d, "layout3d"), "3D view of the event", () => render3d(Object.assign({}, d, { images: null }))); return; }
    if (!figEl && snapUrl(d, "layout3d")) { snapFigure(fig, snapUrl(d, "layout3d"), "3D view of the event", () => render3d(Object.assign({}, d, { snapshots: null }))); return; }
    const m = normalizeItems(d.layout);
    if (!m.items.length) { emptyNote(fig, "A 3D preview will appear here once the floor plan is ready."); return; }
    const b = bounds(m);
    const floor = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map((p) => iso(p[0], p[1], 0));
    const shapes = m.items.map((i) => ({ i: i, c: corners(i), z: (CAT_HEIGHT[i.cat] || 3) * (/stage|dancefloor|redcarpet|riser/.test(i.type) ? 0.35 : 1) }))
      .sort((a, b2) => (a.i.x + a.i.w / 2 + a.i.y + a.i.h / 2) - (b2.i.x + b2.i.w / 2 + b2.i.y + b2.i.h / 2));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (p) => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); };
    floor.forEach(grow); shapes.forEach((sh) => sh.c.forEach((p) => grow(iso(p[0], p[1], sh.z))));
    const pad = 4, s = svg("svg", { viewBox: (minX - pad) + " " + (minY - pad) + " " + (maxX - minX + pad * 2) + " " + (maxY - minY + pad * 2),
      role: "img", "aria-label": "Illustrative 3D view of the floor plan" });
    const pts = (a) => a.map((p) => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" ");
    s.appendChild(svg("polygon", { points: pts(floor), fill: "#efe7da", stroke: "#cdbfae", "stroke-width": 0.4 }));
    shapes.forEach((sh) => {
      const g = svg("g", {}), c = sh.c, z = sh.z, col = sh.i.color;
      for (let k = 0; k < 4; k++) {
        const p = c[k], q = c[(k + 1) % 4];
        const nx = q[1] - p[1], ny = -(q[0] - p[0]);            // outward-ish edge normal
        if (nx + ny <= 0) continue;                              // faces away from the viewer
        g.appendChild(svg("polygon", { points: pts([iso(p[0], p[1], 0), iso(q[0], q[1], 0), iso(q[0], q[1], z), iso(p[0], p[1], z)]),
          fill: shade(col, nx > ny ? 0.72 : 0.86), stroke: shade(col, 0.6), "stroke-width": 0.15 }));
      }
      g.appendChild(svg("polygon", { points: pts(c.map((p) => iso(p[0], p[1], z))), fill: col, stroke: shade(col, 0.65), "stroke-width": 0.15 }));
      const t = svg("title", {}); t.textContent = sh.i.label; g.appendChild(t);
      s.appendChild(g);
    });
    fig.appendChild(s);
    fig.appendChild(el("figcaption", "", "Illustrative preview — heights and finishes are indicative."));
  }
  // 0069 menu.mode: 'choose' = the server found no package applied/accepted for this quote
  function menuChoosing(mn) { return !!(mn && mn.mode === "choose"); }
  function renderMenu(d) {
    const box = clear($("#menuBody")), mn = d.menu || {}, choosing = menuChoosing(mn), pk = choosing ? null : mn.selected_package;
    let any = false;
    if (choosing) {
      // no package applied for THIS quote: never present a free-text note or a stale name as the chosen package
      any = true; const c = el("div", "pkg pkg-none"); c.appendChild(el("h3", "", "Choose a package"));
      c.appendChild(el("p", "meta", "No package has been selected yet. Pick the one that suits you in \u201cChoose your package\u201d and the studio will be notified."));
      box.appendChild(c);
    } else if (pk && pk.name) {
      any = true; const c = el("div", "pkg"); c.appendChild(el("h3", "", pk.name));
      const meta = [pk.tier, pk.diet, num(pk.price_per_plate) ? money(pk.price_per_plate) + " per plate" : ""].filter(Boolean).join(" · ");
      if (meta) c.appendChild(el("p", "meta", meta));
      const dishes = Array.isArray(pk.dishes) ? pk.dishes.map((x) => (x && typeof x === "object" ? x.name : x)).filter((x) => typeof x === "string" && x) : [];
      if (dishes.length) { const ul = el("ul", "chips"); dishes.slice(0, 80).forEach((x) => ul.appendChild(el("li", "", x.slice(0, 60)))); c.appendChild(ul); }
      box.appendChild(c);
    } else if (mn.package && !choosing) {
      any = true; const c = el("div", "pkg"); c.appendChild(el("h3", "", String(mn.package)));
      if (num(mn.plate_price)) c.appendChild(el("p", "meta", money(mn.plate_price) + " per plate")); box.appendChild(c);
    }
    if (mn.menu) { any = true; box.appendChild(el("p", "menu-text", String(mn.menu))); }
    const items = Array.isArray(mn.items) ? mn.items.filter((x) => x && x.name) : [];
    if (items.length) {
      any = true; const groups = {};
      items.forEach((x) => { const k = String(x.category || "Menu"); (groups[k] = groups[k] || []).push(x); });
      Object.keys(groups).forEach((k) => {
        const g = el("div", "dish-group"); g.appendChild(el("h3", "", k)); const ul = el("ul");
        groups[k].forEach((x) => ul.appendChild(el("li", "", String(x.name) + (x.kind ? " (" + x.kind + ")" : "")))); g.appendChild(ul); box.appendChild(g);
      });
    }
    if (!any) emptyNote(box, "Your menu is still being finalised with the studio.");
  }
  function renderQuote(d) {
    const tb = clear($("#quoteLines")), r = quoteLines(d.quote);
    if (!r.lines.length) { const tr = el("tr"); const td = el("td", "empty", "Detailed line items will be added by the studio."); td.setAttribute("colspan", "2"); tr.appendChild(td); tb.appendChild(tr); }
    r.lines.forEach((l) => {
      const tr = el("tr", l.kind || ""); const th = el("th"); th.setAttribute("scope", "row"); th.textContent = l.label;
      if (l.detail) th.appendChild(el("span", "detail", l.detail));
      tr.appendChild(th); tr.appendChild(el("td", "amt", l.amount < 0 ? "− " + money(-l.amount) : money(l.amount))); tb.appendChild(tr);
    });
    $("#quoteTotal").textContent = r.total != null ? money(r.total) : "—";
    // 0114: approved change orders (payments.changes) + the invoice total, same figure as Payments
    const tf = $("#quoteTotal").closest("tfoot"), ch = quoteChanges(d, r.total);
    if (tf) Array.from(tf.querySelectorAll("tr.chg, tr.chg-total")).forEach((x) => x.remove());
    if (tf && ch.rows.length) {
      ch.rows.forEach((c) => { const tr = el("tr", "chg"); const th = el("th", "", "Approved change: " + c.title); th.setAttribute("scope", "row");
        if (c.date) th.appendChild(el("span", "detail", shortDate(c.date)));
        tr.appendChild(th); tr.appendChild(el("td", "amt", c.amount < 0 ? "− " + money(-c.amount) : money(c.amount))); tf.appendChild(tr); });
      if (ch.total != null) { const tr = el("tr", "chg-total sub"); const th = el("th", "", "Total incl. approved changes"); th.setAttribute("scope", "row");
        tr.appendChild(th); tr.appendChild(el("td", "amt", money(ch.total))); tf.appendChild(tr); }
    }
    const wt = ch.rows.length && ch.total != null ? ch.total : r.total;
    let words = ""; try { if (wt != null && FMT.currency === "INR" && global.BPStore && global.BPStore.amountInWords) words = global.BPStore.amountInWords(wt); } catch (e) {}
    $("#quoteWords").textContent = words || "";
  }
  // 0114: approved change orders from payments.changes (absent on older DBs -> no rows). The total
  // prefers the server invoice (payments.total, 0111) so it always matches the Payments section.
  function quoteChanges(d, quoteTotal) {
    const p = (d && d.payments) || {}, raw = Array.isArray(p.changes) ? p.changes : [];
    const rows = raw.filter((c) => c && typeof c === "object" && num(c.amount) != null && Number(c.amount) !== 0)
      .map((c) => ({ title: String(c.title || "Change").slice(0, 120), amount: Number(c.amount), date: c.date || null }));
    if (!rows.length) return { rows: [], total: null };
    const sum = rows.reduce((a, c) => a + c.amount, 0);
    const total = num(p.total) != null && num(p.total) > 0 ? num(p.total) : (num(quoteTotal) != null ? Math.round((num(quoteTotal) + sum) * 100) / 100 : null);
    return { rows, total };
  }
  function renderVersions(d) {
    const ol = clear($("#versionList")), vs = Array.isArray(d.versions) ? d.versions : [];
    if (!vs.length) { ol.appendChild(el("li", "empty", "This is the first version of your quotation.")); return; }
    // PP1028 #4: never show two totals as both current - when the live quote differs from the latest saved
    // version, the version reads "Saved" and the live total is its own clearly-labelled row
    let live = null; try { live = quoteLines(d.quote).total; } catch (e) {}
    const lv = vs.find((v) => v && v.latest), differs = lv && num(live) != null && num(lv.total) != null && Math.abs(num(live) - num(lv.total)) > 0.5;
    if (differs) { const li = el("li"); const left = el("div"); left.appendChild(el("span", "v-label", "Current quotation"));
      left.appendChild(el("span", "badge", "Latest")); li.appendChild(left); li.appendChild(el("span", "v-total", money(live))); ol.appendChild(li); }
    vs.forEach((v) => {
      const li = el("li"); const left = el("div"); const lab = el("span", "v-label", String(v.label || "Quotation")); left.appendChild(lab);
      if (v.latest) left.appendChild(el("span", "badge", differs ? "Saved" : "Latest"));
      if (v.created_at) { const t = el("time", "", shortDate(v.created_at)); t.setAttribute("datetime", String(v.created_at)); left.appendChild(t); }
      li.appendChild(left); li.appendChild(el("span", "v-total", money(v.total))); ol.appendChild(li);
    });
  }
  function renderPayments(d) {
    const p = d.payments || {}; let ms = Array.isArray(p.milestones) ? p.milestones : [];
    // 0111: the server's payments.total = quote + approved change orders (the invoice); else the quote total
    const total = num(p.total) != null && num(p.total) > 0 ? num(p.total) : quoteLines(d.quote).total;
    const sum = clear($("#paySum"));
    const rc = Array.isArray(p.receipts) ? p.receipts.filter((x) => x && typeof x === "object") : null;
    // 0070 servers send outstanding = total - paid (receipts present); older ones only the unpaid milestones
    const bal = (rc || ms.length) && p.outstanding != null && num(p.outstanding) != null ? Number(p.outstanding) : (total != null ? total - (Number(p.paid) || 0) : p.outstanding);
    const credit = bal != null && num(bal) != null && Number(bal) < 0;
    [["Total", total], ["Paid", p.paid], [credit ? "Credit" : "Balance", credit ? -Number(bal) : bal]].forEach((x) => {
      const b = el("div"); b.appendChild(el("div", "k", x[0])); b.appendChild(el("div", "v", money(x[1]))); sum.appendChild(b);
    });
    renderReceipts(rc || []);
    // E6: say what is due from the studio's payment terms + the event date (same rule as the portal)
    const line = balanceLine(total, p.paid, bal, (d.event || {}).event_date, d.payTerms);
    const pt = $("#payTerm"); if (pt) { pt.textContent = line || ""; pt.hidden = !line; }
    const tb = clear($("#payLines"));
    // PP1028 #9: the advance is part of the schedule - show it when the studio set one and no milestone covers it
    ms = withAdvance(ms, total, d.payTerms);
    if (!ms.length) { const tr = el("tr"); const td = el("td", "empty", line || "The payment schedule will be shared by the studio."); td.setAttribute("colspan", "6"); tr.appendChild(td); tb.appendChild(tr); return; }
    const alloc = msAllocate(ms, p.paid);
    ms.forEach((m, i) => {
      const tr = el("tr"); tr.appendChild(el("td", "", String(m.label || "Payment"))); tr.appendChild(el("td", "", shortDate(m.due_date) || "—"));
      const a = alloc[i], st = overdueOf(a.status, m.due_date, a.remaining);
      const td = el("td"); td.appendChild(el("span", "st " + st, st.replace(/_/g, " "))); tr.appendChild(td);
      tr.appendChild(el("td", "amt", money(m.amount)));
      tr.appendChild(el("td", "amt", a.paid > 0 ? money(a.paid) : "—"));
      tr.appendChild(el("td", "amt", a.remaining != null ? money(a.remaining) : "—")); tb.appendChild(tr);
    });
  }
  // r23 (0264, display only): an open payment past its due date (the studio's day) reads "overdue"
  function overdueOf(status, due, remaining) {
    if (status !== "due" && status !== "part_paid" && status !== "invoiced") return status;
    const d = String(due || "").slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return status;
    let today = ""; try { today = global.BPStore && global.BPStore.todayLocal ? global.BPStore.todayLocal() : ""; } catch (e) { today = ""; }
    if (!today) { try { var H = global.HelmCountry; if (H && H.todayIn) today = H.todayIn(FMT.currency === "AED" ? "Asia/Dubai" : "Asia/Kolkata"); } catch (e) {} }   // r37: the studio's day
    if (!today) today = new Date().toISOString().slice(0, 10);
    return d < today && !(Number(remaining) <= 0.5 && remaining != null) ? "overdue" : status;
  }
  // PP1028 #9 (display only): prepend an "Advance" row from the studio's advance % when no milestone is the advance
  // 1029 #2: same default the flow shows (studio advance % from settings, else the flow's 10%) - read side only
  const DEFAULT_ADVANCE_PCT = 10;
  function advancePctOf(terms) { const v = terms && terms.advance_pct; return (v == null || String(v).trim() === "" || !isFinite(Number(v))) ? DEFAULT_ADVANCE_PCT : Number(v); }
  function withAdvance(ms, total, terms) {
    const list = Array.isArray(ms) ? ms.slice() : [], pct = advancePctOf(terms), t = num(total);
    if (!(pct > 0) || !(t > 0)) return list;
    if (list.some((m) => m && /advance|booking|token/i.test(String(m.label || "")))) return list;
    return [{ label: "Advance (" + pct + "%)", due_date: null, status: "due", amount: Math.round(t * pct) / 100 }].concat(list);
  }
  // Display only (no data change): milestones are a schedule, the ledger is the money truth. Money received
  // beyond the milestones already marked paid covers the remaining ones in schedule order, so a fully
  // paid event no longer lists them as "due". Stored milestone statuses are never rewritten.
  function msDisplayStatus(ms, paid) {
    const list = Array.isArray(ms) ? ms : [];
    const st = list.map((m) => String((m && m.status) || "due").toLowerCase().replace(/[^a-z_]/g, ""));
    let left = (num(paid) || 0) - list.reduce((a, m, i) => a + (st[i] === "paid" ? (num(m && m.amount) || 0) : 0), 0);
    return st.map((x, i) => {
      if (x !== "due" && x !== "overdue" && x !== "pending") return x;
      const amt = num(list[i] && list[i].amount) || 0;
      if (amt > 0 && left + 0.5 >= amt) { left -= amt; return "paid"; }
      left = 0; return x;
    });
  }
  // Display only: allocate money received to milestones oldest-first (milestones stored as paid take their
  // full amount first). Each row gets {status, paid, remaining}; a partly covered row reads "part_paid".
  function msAllocate(ms, paid) {
    const list = Array.isArray(ms) ? ms : [];
    const st = list.map((m) => String((m && m.status) || "due").toLowerCase().replace(/[^a-z_]/g, ""));
    const amt = list.map((m) => Math.max(0, num(m && m.amount) || 0));
    let left = Math.max(0, (num(paid) || 0) - amt.reduce((a, v, i) => a + (st[i] === "paid" ? v : 0), 0));
    return st.map((x, i) => {
      const a = amt[i];
      if (x === "paid") return { status: "paid", paid: a, remaining: 0 };
      if (x !== "due" && x !== "overdue" && x !== "pending") return { status: x, paid: 0, remaining: null };
      const take = Math.min(a, left); left -= take;
      const rem = Math.round((a - take) * 100) / 100;
      if (a > 0 && rem <= 0.5) return { status: "paid", paid: a, remaining: 0 };
      return { status: take > 0.5 ? "part_paid" : x, paid: Math.round(take * 100) / 100, remaining: rem };
    });
  }
  // E6: "Paid in full" | "Balance ₹X due by dd/mm/yyyy" (terms.balance_due_days before the event) | null
  function dmy(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? m[3] + "/" + m[2] + "/" + m[1] : ""; }
  function balanceLine(total, paid, bal, eventDate, terms) {
    const t = num(total), pd = num(paid) || 0, b = num(bal) != null ? Number(bal) : (t != null ? t - pd : null);
    if (t == null || !(t > 0) || b == null) return null;
    if (b <= 0.5 && pd > 0) return "Paid in full";
    if (b <= 0.5) return null;
    const ev = /^\d{4}-\d{2}-\d{2}/.test(String(eventDate || "")) ? String(eventDate).slice(0, 10) : "";
    const days = terms && terms.balance_due_days != null && Number.isInteger(Number(terms.balance_due_days)) && Number(terms.balance_due_days) >= 0 && Number(terms.balance_due_days) <= 365 ? Number(terms.balance_due_days) : null;
    let due = "";
    if (ev && days != null) { const ms = Date.UTC(+ev.slice(0, 4), +ev.slice(5, 7) - 1, +ev.slice(8, 10)) - days * 86400000; if (isFinite(ms)) due = new Date(ms).toISOString().slice(0, 10); }
    if (due) return "Balance " + money(b) + " due by " + dmy(due);
    if (ev) return "Balance " + money(b) + " due before the event (" + dmy(ev) + ")";
    return "Balance " + money(b) + " due";
  }
  // receipts: number, date, amount, method (textContent only)
  function renderReceipts(rc) {
    const tb = $("#receiptLines"), wrap = $("#receiptTable");
    if (!tb) return; clear(tb);
    if (wrap) wrap.hidden = !rc.length;
    rc.slice(0, 200).forEach((x) => {
      const tr = el("tr");
      tr.appendChild(el("td", "", x.number ? String(x.number).slice(0, 60) : "Receipt"));
      tr.appendChild(el("td", "", shortDate(x.date) || "—"));
      tr.appendChild(el("td", "", x.method ? String(x.method).slice(0, 40) : "—"));
      tr.appendChild(el("td", "amt", money(x.amount))); tb.appendChild(tr);
    });
  }
  function renderTerms(d) {
    const box = clear($("#termsBody"));
    const paras = d.terms ? String(d.terms).split(/\n{2,}/) : DEFAULT_TERMS;
    paras.forEach((t) => { if (t.trim()) box.appendChild(el("p", "", t.trim())); });
    renderFoot(d);
  }
  function renderFoot(d) {
    const s = d.studio || {};
    $("#footLine").textContent = "Prepared by " + (s.name || "your event studio") + (d.shared_at ? " on " + shortDate(d.shared_at) : "");
    $("#expLine").textContent = d.expires_at ? "This link is valid until " + shortDate(d.expires_at) + "." : "";
  }
  // 0069: studio-captured screenshots (signed https URLs from the server) win over the drawn plan
  function snapUrl(d, k) {
    const sn = d && d.snapshots && typeof d.snapshots === "object" ? d.snapshots : null;
    const kind = k === "layout3d" ? "3d" : "2d";
    let u = sn ? (sn[kind] != null ? sn[kind] : sn[k]) : null;
    if (u === true) { try { u = d.__token && global.BPStore && global.BPStore.booklet && global.BPStore.booklet.snapshotUrl ? global.BPStore.booklet.snapshotUrl(d.__token, kind) : null; } catch (e) { u = null; } }
    if (u && typeof u === "object") u = u.url;
    return typeof u === "string" && /^https:\/\/[^\s"'<>]+$/i.test(u) && u.length <= 2000 ? u : null;
  }
  function snapFigure(fig, url, alt, fallback) {
    const img = el("img", "snap"); img.setAttribute("src", url); img.setAttribute("alt", alt); img.setAttribute("referrerpolicy", "no-referrer"); img.setAttribute("loading", "lazy");
    const zoom = el("button", "snap-zoom"); zoom.type = "button"; zoom.setAttribute("aria-label", alt + " — open full size");
    zoom.appendChild(img); zoom.addEventListener("click", () => openLightbox(url, alt));
    if (fallback) img.addEventListener("error", () => { if (zoom.parentNode) zoom.parentNode.removeChild(zoom); fallback(); }, { once: true });   // edge function dormant → drawn plan
    fig.appendChild(zoom);
  }
  // 0083: pictures stored in the database. d.images = { "2d": { labels: bool, plain: bool }, "3d": {...} }
  // (flags only; the bytes come from public_get_booklet_image, one picture at a time, when shown)
  const IMG_VARIANTS = [["labels", "With labels"], ["plain", "Without labels"]];
  function dbImages(d, k) {
    const im = d && d.images && typeof d.images === "object" ? d.images[k === "layout3d" ? "3d" : "2d"] : null;
    if (!im || typeof im !== "object") return [];
    const out = IMG_VARIANTS.filter((v) => im[v[0]] === true).map((v) => ({ variant: v[0], label: v[1] }));
    // 0095: the studio's photo render - its own picture (kind "photo"), shown in the 3D section
    const ph = k === "layout3d" && d.images.photo && typeof d.images.photo === "object" ? d.images.photo : null;
    if (ph && ph.plain === true) out.push({ variant: "photo", label: "Photo" });
    return out;
  }
  const isDataImg = (u) => typeof u === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(u);
  function dbFigure(fig, d, kind, variants, alt, fallback) {
    const cache = {}, B = global.BPStore && global.BPStore.booklet;
    const load = (v) => cache[v] || (cache[v] = (d.__token && B && B.publicImage ? (v === "photo" ? B.publicImage(d.__token, "photo", "plain") : B.publicImage(d.__token, kind, v)) : Promise.resolve(null))
      .then((u) => (isDataImg(u) ? u : null)).catch(() => null));
    let cur = null, seq = 0, bar = null;
    const img = el("img", "snap"); img.setAttribute("alt", alt);
    const zoom = el("button", "snap-zoom"); zoom.type = "button"; zoom.setAttribute("aria-label", alt + " — open full size"); zoom.hidden = true;
    zoom.appendChild(img); zoom.addEventListener("click", () => { if (cur) openLightbox(cur, alt); });   // lightbox follows the chosen style
    const gone = () => { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); if (zoom.parentNode) zoom.parentNode.removeChild(zoom); fallback(); };
    const pick = (v, first) => {
      const my = ++seq;
      if (bar) bar.querySelectorAll("button").forEach((b) => { const on = b.getAttribute("data-v") === v; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false"); });
      load(v).then((u) => {
        if (my !== seq) return;
        if (!u) { if (first) gone(); return; }
        cur = u; img.setAttribute("src", u); img.setAttribute("data-variant", v); zoom.hidden = false;
      });
    };
    if (variants.length > 1) {   // "With labels | Without labels" - only when both styles exist
      bar = el("div", "snap-labels"); bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Labels");
      variants.forEach((v) => { const b = el("button", "", v.label); b.type = "button"; b.setAttribute("data-v", v.variant); b.addEventListener("click", () => pick(v.variant)); bar.appendChild(b); });
      fig.appendChild(bar);
    }
    fig.appendChild(zoom);
    pick((variants.find((v) => v.variant === "labels") || variants[0]).variant, true);
  }
  // R2: full-size view of a studio image (click / tap to zoom in further, Esc or ✕ closes)
  function openLightbox(url, alt) {
    let dlg = doc.getElementById("bkLightbox");
    if (!dlg) {
      dlg = el("dialog", "lightbox"); dlg.id = "bkLightbox"; dlg.setAttribute("aria-label", "Image viewer");
      const x = el("button", "lb-close", "✕"); x.type = "button"; x.setAttribute("aria-label", "Close"); x.addEventListener("click", () => dlg.close());
      const wrap = el("div", "lb-wrap"); const im = el("img", "lb-img"); im.setAttribute("referrerpolicy", "no-referrer");
      im.addEventListener("click", (e) => { e.stopPropagation(); wrap.classList.toggle("zoomed"); });
      wrap.appendChild(im); dlg.appendChild(x); dlg.appendChild(wrap);
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
      doc.body.appendChild(dlg);
    }
    const im = dlg.querySelector(".lb-img"); im.setAttribute("src", url); im.setAttribute("alt", alt);
    dlg.querySelector(".lb-wrap").classList.remove("zoomed");
    if (typeof dlg.showModal === "function") { if (!dlg.open) dlg.showModal(); } else global.open(url, "_blank", "noopener");
  }
  // 0069: which sections the studio chose to share. No `sections` from the server → legacy booklet (all on).
  const SEC_MAP = { details: ["client", "venue"], layout2d: ["layout2d"], layout3d: ["layout3d"], menu: ["menu"], packages: ["menu"],
    quote: ["quotation"], versions: ["quotation"], payments: ["payments"], terms: ["terms"] };
  function visibleSections(d) {
    const sc = d && d.sections && typeof d.sections === "object" ? d.sections : null;
    const on = (k) => !sc || sc[k] === true;
    const out = {};
    Object.keys(SEC_MAP).forEach((id) => { out[id] = SEC_MAP[id].some(on); });
    out.details = true;                                   // event date / title always shown
    if (sc) {                                             // hide empty sections — never placeholders
      const lay = normalizeItems(d.layout).items.length;
      if (!lay && !snapUrl(d, "layout2d") && !dbImages(d, "layout2d").length) out.layout2d = false;
      if (!lay && !snapUrl(d, "layout3d") && !dbImages(d, "layout3d").length) out.layout3d = false;
      const mn = d.menu || {};
      if (!(menuChoosing(mn) || mn.selected_package || mn.package || mn.menu || (Array.isArray(mn.items) && mn.items.length))) out.menu = false;
      if (!quoteLines(d.quote).lines.length && quoteLines(d.quote).total == null) out.quote = false;
      if (!(Array.isArray(d.versions) && d.versions.length)) out.versions = false;
      const p = d.payments || {}; if (!(Array.isArray(p.milestones) && p.milestones.length) && p.paid == null && p.outstanding == null) out.payments = false;
    }
    return { show: out, studio: on("studio"), client: on("client"), venue: on("venue") };
  }
  function render(d) {
    const q = d.quote || {}; setFormat(d.locale || q.locale, q.currency || d.currency);
    const vis = visibleSections(d);
    if (!vis.studio) d = Object.assign({}, d, { studio: { name: (d.studio || {}).name, accent: (d.studio || {}).accent } });
    if (!vis.client) d = Object.assign({}, d, { event: Object.assign({}, d.event, { client_name: null }) });
    if (!vis.venue) d = Object.assign({}, d, { event: Object.assign({}, d.event, { venue_name: null, venue_address: null, venue_map_url: null }) });
    VISIBLE = vis.show;
    Object.keys(vis.show).forEach((id) => { const n = doc.getElementById(id); if (n && id !== "packages") n.hidden = !vis.show[id]; });
    let ix = 0; SECTIONS.forEach((x) => { const h = doc.getElementById(x[0]); const nm = h && h.querySelector(".num"); if (nm && vis.show[x[0]] !== false) nm.textContent = String(++ix).padStart(2, "0"); });
    renderCover(d); renderToc(); renderDetails(d);
    if (vis.show.layout2d) render2d(d); if (vis.show.layout3d) render3d(d); if (vis.show.menu) renderMenu(d);
    if (vis.show.quote) renderQuote(d); if (vis.show.versions) renderVersions(d); if (vis.show.payments) renderPayments(d); if (vis.show.terms) renderTerms(d); else renderFoot(d);
  }

  function show(id) { ["#loading", "#bad", "#err", "#app"].forEach((s) => { $(s).hidden = s !== id; }); }
  const isBad = (e) => { const m = String((e && e.message) || ""); return /invalid link|expired/i.test(m) || (e && (e.code === "22P02" || e.code === "PGRST116")); };
  async function start() {
    // 0067: /<studio>/booklet/<token> — the token is the secret; the studio part must match it
    const R = global.HelmUrl && global.HelmUrl.route();
    const pretty = R && R.kind === "booklet" ? R : null;
    const token = pretty ? tokenFrom("?t=" + encodeURIComponent(pretty.ref || "")) : tokenFrom(global.location.search);
    if (!token) { show("#bad"); return; }
    show("#loading");
    let d;
    try {
      await global.BPStore.init();
      if (pretty && !(await global.BPStore.booklet.studioOk(token, pretty.studio))) { show("#bad"); return; }
      d = await global.BPStore.booklet.get(token);
    }
    catch (e) {
      if (/has been cancelled/i.test(String((e && e.message) || ""))) {   // r23-0260: the event was cancelled
        const b = $("#bad"); b.querySelector("h1").textContent = "This event has been cancelled";
        b.querySelector("p").textContent = "This booklet link is no longer active. If you have any questions, please contact your event studio.";
        show("#bad"); return;
      }
      if (isBad(e)) { show("#bad"); return; }
      $("#errMsg").textContent = /too many/i.test(String((e && e.message) || "")) ? "Too many requests — please wait a few minutes and try again." : "Please check your connection and try again.";
      show("#err"); return;
    }
    if (!d || typeof d !== "object") { show("#bad"); return; }
    d.__token = token;
    render(d); show("#app");
    // E6 (0101): the studio's balance-due term for this link; older servers -> the event-date fallback
    try { const pt = global.BPStore.booklet.payTerms ? await global.BPStore.booklet.payTerms(token) : null;
      if (pt && typeof pt === "object" && VISIBLE.payments !== false && $("#payTerm")) { d.payTerms = pt; renderPayments(d); } } catch (e) {}
    if (global.HelmBookletPkg && VISIBLE.packages !== false && !(d.menu && d.menu.mode === "hidden")) global.HelmBookletPkg.mount(token, d).catch(() => {});
    // r23 (0262): "This quote is valid until dd/mm/yyyy" / expired + "Request a new quote" (nothing once approved)
    if (global.HelmQuoteValidity && $("#qvBanner")) global.HelmQuoteValidity.mountClient($("#qvBanner"), "booklet", token).catch(() => {});
  }

  global.HelmBooklet = { menuChoosing, quoteChanges, withAdvance, balanceLine, msDisplayStatus, msAllocate, render2d, render3d, visibleSections, snapUrl, dbImages, dbFigure, isDataImg, IMG_VARIANTS, money, setFormat, fmtTime, mapLink, fmtDate, shortDate, safeHex, safeLogo, tokenFrom, quoteLines, normalizeItems, bounds, corners, iso, shade, SECTIONS };
  if (doc && doc.getElementById("tocList")) {
    const pb = doc.getElementById("printBtn"); if (pb) pb.addEventListener("click", () => global.print());
    const rt = doc.getElementById("retry"); if (rt) rt.addEventListener("click", () => start());
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
  }
})(typeof window !== "undefined" ? window : globalThis);
