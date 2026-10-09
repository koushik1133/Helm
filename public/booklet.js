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
  function fmtTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "")); if (!m) return t ? String(t).slice(0, 40) : "";
    const dt = new Date(2000, 0, 1, Number(m[1]), Number(m[2]));
    try { return dt.toLocaleTimeString(FMT.locale, { hour: "numeric", minute: "2-digit" }); } catch (e) { return m[1] + ":" + m[2]; }
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
    try { return dt.toLocaleDateString(FMT.locale, { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return String(d); }
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
    // 0079: non-India studios — one tax line named for the country (from the quote currency);
    // "(included)" when the total is the post-discount value itself (tax-inclusive prices).
    const cur = String(q.currency || "INR").toUpperCase(); const tn = cur === "INR" ? null : (TAX_BY_CURRENCY[cur] || "Tax");
    const incl = sub != null && gst && num(q.total) != null && Math.round(sub - (disc || 0)) === Math.round(num(q.total));
    if (tn && (gst || igst || cgst || sgst)) out.push({ label: tn + (incl ? " (included)" : ""), detail: pct ? pct + "%" : "", amount: gst || ((igst || 0) + (cgst || 0) + (sgst || 0)) });
    else if (tn) { /* no tax on this quote */ }
    else if (igst) out.push({ label: "IGST", detail: pct ? pct + "%" : "", amount: igst });
    else if (cgst || sgst) {
      out.push({ label: "CGST", detail: pct ? pct / 2 + "%" : "", amount: cgst || 0 });
      out.push({ label: "SGST", detail: pct ? pct / 2 + "%" : "", amount: sgst || 0 });
    } else if (gst) out.push({ label: "GST", detail: pct ? pct + "%" : "", amount: gst });
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
    const logo = safeLogo(s.logo), img = $("#s_logo");
    if (logo) { img.setAttribute("src", logo); img.setAttribute("alt", (s.name || "Studio") + " logo"); img.setAttribute("referrerpolicy", "no-referrer");
      img.hidden = false; $("#s_mark").classList.add("has-logo");
      img.addEventListener("error", () => { img.hidden = true; $("#s_mark").classList.remove("has-logo"); }); }
    const ct = clear($("#s_contact"));
    // #16 studio contact, first that exists: (1) the event coordinator's name + phone,
    // (2) the studio business phone (Control Center > Studio details), (3) the business email -
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
    const title = e.title || e.code || "Your event";
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
  function fact(dl, k, v) { if (v == null || v === "") return null; const d = el("div"); d.appendChild(el("dt", "", k)); const dd = el("dd", "", String(v)); d.appendChild(dd); dl.appendChild(d); return dd; }
  function renderDetails(d) {
    const e = d.event || {}, dl = clear($("#factList"));
    fact(dl, "Event", e.title || e.code);
    fact(dl, "Occasion", e.event_type);
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
    fact(dl, "Reference", e.code);
  }
  function render2d(d, figEl, legEl) {
    const fig = clear(figEl || $("#plan2d")), leg = clear(legEl || $("#legend2d") || el("ul"));
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
  function renderMenu(d) {
    const box = clear($("#menuBody")), mn = d.menu || {}, pk = mn.selected_package;
    let any = false;
    if (pk && pk.name) {
      any = true; const c = el("div", "pkg"); c.appendChild(el("h3", "", pk.name));
      const meta = [pk.tier, pk.diet, num(pk.price_per_plate) ? money(pk.price_per_plate) + " per plate" : ""].filter(Boolean).join(" · ");
      if (meta) c.appendChild(el("p", "meta", meta));
      const dishes = Array.isArray(pk.dishes) ? pk.dishes.map((x) => (x && typeof x === "object" ? x.name : x)).filter((x) => typeof x === "string" && x) : [];
      if (dishes.length) { const ul = el("ul", "chips"); dishes.slice(0, 80).forEach((x) => ul.appendChild(el("li", "", x.slice(0, 60)))); c.appendChild(ul); }
      box.appendChild(c);
    } else if (mn.package) {
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
    let words = ""; try { if (r.total != null && global.BPStore && global.BPStore.amountInWords) words = global.BPStore.amountInWords(r.total); } catch (e) {}
    $("#quoteWords").textContent = words || "";
  }
  function renderVersions(d) {
    const ol = clear($("#versionList")), vs = Array.isArray(d.versions) ? d.versions : [];
    if (!vs.length) { ol.appendChild(el("li", "empty", "This is the first version of your quotation.")); return; }
    vs.forEach((v) => {
      const li = el("li"); const left = el("div"); const lab = el("span", "v-label", String(v.label || "Quotation")); left.appendChild(lab);
      if (v.latest) left.appendChild(el("span", "badge", "Latest"));
      if (v.created_at) { const t = el("time", "", shortDate(v.created_at)); t.setAttribute("datetime", String(v.created_at)); left.appendChild(t); }
      li.appendChild(left); li.appendChild(el("span", "v-total", money(v.total))); ol.appendChild(li);
    });
  }
  function renderPayments(d) {
    const p = d.payments || {}, ms = Array.isArray(p.milestones) ? p.milestones : [];
    const total = quoteLines(d.quote).total;
    const sum = clear($("#paySum"));
    const rc = Array.isArray(p.receipts) ? p.receipts.filter((x) => x && typeof x === "object") : null;
    // 0070 servers send outstanding = total - paid (receipts present); older ones only the unpaid milestones
    const bal = (rc || ms.length) && p.outstanding != null && num(p.outstanding) != null ? Number(p.outstanding) : (total != null ? total - (Number(p.paid) || 0) : p.outstanding);
    const credit = bal != null && num(bal) != null && Number(bal) < 0;
    [["Total", total], ["Paid", p.paid], [credit ? "Credit" : "Balance", credit ? -Number(bal) : bal]].forEach((x) => {
      const b = el("div"); b.appendChild(el("div", "k", x[0])); b.appendChild(el("div", "v", money(x[1]))); sum.appendChild(b);
    });
    renderReceipts(rc || []);
    const tb = clear($("#payLines"));
    if (!ms.length) { const tr = el("tr"); const td = el("td", "empty", "The payment schedule will be shared by the studio."); td.setAttribute("colspan", "4"); tr.appendChild(td); tb.appendChild(tr); return; }
    ms.forEach((m) => {
      const tr = el("tr"); tr.appendChild(el("td", "", String(m.label || "Payment"))); tr.appendChild(el("td", "", shortDate(m.due_date) || "—"));
      const st = String(m.status || "due").toLowerCase().replace(/[^a-z_]/g, "");
      const td = el("td"); td.appendChild(el("span", "st " + st, st.replace(/_/g, " "))); tr.appendChild(td);
      tr.appendChild(el("td", "amt", money(m.amount))); tb.appendChild(tr);
    });
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
      if (!lay && !snapUrl(d, "layout2d")) out.layout2d = false;
      if (!lay && !snapUrl(d, "layout3d")) out.layout3d = false;
      const mn = d.menu || {};
      if (!(mn.selected_package || mn.package || mn.menu || (Array.isArray(mn.items) && mn.items.length))) out.menu = false;
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
      if (isBad(e)) { show("#bad"); return; }
      $("#errMsg").textContent = /too many/i.test(String((e && e.message) || "")) ? "Too many requests — please wait a few minutes and try again." : "Please check your connection and try again.";
      show("#err"); return;
    }
    if (!d || typeof d !== "object") { show("#bad"); return; }
    d.__token = token;
    render(d); show("#app");
    if (global.HelmBookletPkg && VISIBLE.packages !== false && !(d.menu && d.menu.mode === "hidden")) global.HelmBookletPkg.mount(token, d).catch(() => {});
  }

  global.HelmBooklet = { render2d, render3d, visibleSections, snapUrl, money, setFormat, fmtTime, mapLink, fmtDate, shortDate, safeHex, safeLogo, tokenFrom, quoteLines, normalizeItems, bounds, corners, iso, shade, SECTIONS };
  if (doc && doc.getElementById("tocList")) {
    const pb = doc.getElementById("printBtn"); if (pb) pb.addEventListener("click", () => global.print());
    const rt = doc.getElementById("retry"); if (rt) rt.addEventListener("click", () => start());
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
  }
})(typeof window !== "undefined" ? window : globalThis);
