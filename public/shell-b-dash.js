/* Shell B — home dashboard. Read-only: never writes data. DOM APIs only (no innerHTML with
   data, no inline style attributes). Every store call is try/caught and fired in parallel;
   skeletons paint first and each section fills as soon as its data is in.
   The page's own sections (#roleboard, #myworkSection, #mytasksSection, "Your quotes",
   #createBtn) are MOVED into this layout, not rebuilt — they stay wired to dashboard.html.
   OWNER DECISION (Oct 2026): Demo 1 is THE dashboard. It carries one money block (Revenue, finance
   roles only); every amount there is span/svg[data-money] (via HelmMoney.money), so privacy mode
   masks it behind the PIN. Colours come only from theme tokens (--hb-*). Every block carries a
   stable data-block attribute (for later drag-and-drop ordering). The adopted "All quotes" list renders totals as text: tagMoney() moves them into
   span[data-money], which the home page hides (and privacy mode masks). */
/* Dashboard layout helpers (pure, no DOM) - shared by the dashboard and test/dashboard-customize.test.mjs.
   A layout is { order: [block ids], hidden: [block ids] }. It only orders / hides blocks that the role
   already sees: a gated block stays gated whatever is saved, unknown ids are dropped, new blocks are
   appended in their default place, and v1 only reorders inside a block's own column. */
(function (g) {
  "use strict";
  var ID = /^[a-z][a-z0-9_-]{0,31}$/;
  function ids(a) { var out = []; if (Array.isArray(a)) for (var i = 0; i < a.length && out.length < 40; i++) { var v = a[i]; if (typeof v === "string" && ID.test(v) && out.indexOf(v) < 0) out.push(v); } return out; }
  function colOf(cls) { cls = " " + String(cls || "") + " "; return cls.indexOf(" hd-s-full ") >= 0 ? "full" : cls.indexOf(" hd-s-wide ") >= 0 ? "wide" : "side"; }
  /* blocks: [{ id, col, gated }] in DEFAULT order. Returns { order, hidden, visible: {id: bool} }. */
  function merge(saved, blocks) {
    var s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    var so = ids(s.order), sh = ids(s.hidden), byCol = {}, cols = [], known = {};
    (blocks || []).forEach(function (b) { if (!b || !ID.test(String(b.id)) || known[b.id]) return; known[b.id] = b; if (!byCol[b.col]) { byCol[b.col] = []; cols.push(b.col); } byCol[b.col].push(b.id); });
    var colOrder = {};
    cols.forEach(function (c) {
      var inCol = byCol[c], out = so.filter(function (id) { return inCol.indexOf(id) >= 0; });
      inCol.forEach(function (id, di) {                                   // new block: right after its nearest default predecessor
        if (out.indexOf(id) >= 0) return;
        var at = 0; for (var k = di - 1; k >= 0; k--) { var p = out.indexOf(inCol[k]); if (p >= 0) { at = p + 1; break; } }
        out.splice(at, 0, id);
      });
      colOrder[c] = out;
    });
    var order = [], ptr = {};   // interleave columns in default slot order (each default slot of a column takes that column's next id)
    (blocks || []).forEach(function (b) { if (!known[b.id] || known[b.id] !== b) return; var i = ptr[b.col] || 0; order.push(colOrder[b.col][i]); ptr[b.col] = i + 1; });
    var hidden = sh.filter(function (id) { return known[id] && !known[id].gated; }), visible = {};
    Object.keys(known).forEach(function (id) { visible[id] = !known[id].gated && hidden.indexOf(id) < 0; });
    return { order: order, hidden: hidden, visible: visible };
  }
  /* move id by delta (-1/+1) among the non-gated blocks of its own column; returns a new order */
  function move(order, blocks, id, delta) {
    var info = {}; (blocks || []).forEach(function (b) { info[b.id] = b; });
    var me = info[id]; if (!me || me.gated) return order.slice();
    var peers = order.filter(function (x) { return info[x] && info[x].col === me.col && !info[x].gated; });
    var i = peers.indexOf(id), j = i + delta; if (i < 0 || j < 0 || j >= peers.length) return order.slice();
    var out = order.slice(), a = out.indexOf(id), b = out.indexOf(peers[j]); out[a] = peers[j]; out[b] = id; return out;
  }
  function isDefault(layout, blocks) {
    var d = (blocks || []).map(function (b) { return b.id; });
    return !(layout.hidden && layout.hidden.length) && JSON.stringify(layout.order || []) === JSON.stringify(d);
  }
  var api = { ids: ids, colOf: colOf, merge: merge, move: move, isDefault: isDefault };
  g.HelmDashLayout = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

(function () {
  "use strict";
  if (document.documentElement.getAttribute("data-shell") !== "b") return;
  if (window.__hbDash) return; window.__hbDash = 1;

  var NS = "http://www.w3.org/2000/svg";
  var REDUCED = false; try { REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  var DAY = 864e5;

  /* ---------- tiny DOM helpers ---------- */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }
  function sv(tag, attrs, parent) { var e = document.createElementNS(NS, tag); for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, String(attrs[k])); if (parent) parent.appendChild(e); return e; }
  function icon(d, cls) {
    var s = sv("svg", { viewBox: "0 0 24 24", "class": cls || "hd-ic", "aria-hidden": "true" });
    d.split("|").forEach(function (p) { sv("path", { d: p }, s); });
    return s;
  }
  var IC = {
    cal: "M4 6h16v14H4z|M4 10h16|M8 3v4|M16 3v4",
    alert: "M12 3 2 20h20z|M12 10v4|M12 17h.01",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M4 21a8 8 0 0 1 16 0",
    task: "M9 11l3 3 8-8|M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h11",
    pipe: "M3 5h18|M6 12h12|M10 19h4",
    doc: "M6 3h9l4 4v14H6z|M14 3v5h5",
    arrow: "M5 12h14|M13 6l6 6-6 6",
    check: "M5 12l5 5 9-10",
    plus: "M12 5v14|M5 12h14",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z|M20 20l-4-4",
    chart: "M4 20V10|M10 20V4|M16 20v-7|M22 20H2",
    pulse: "M3 12h4l3-8 4 16 3-8h4",
    pin: "M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z|M12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    login: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4|M10 17l5-5-5-5|M15 12H3",
    people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z|M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5|M16 4.5a3.5 3.5 0 0 1 0 7|M18 14.8c2 .7 3.2 2.5 3.6 5.2",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 7v5l3 2",
    chev: "M9 6l6 6-6 6",
    inbox: "M3 13h5l1 3h6l1-3h5|M5 5h14l2 8v6H3v-6z",
    ticket: "M3 7h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4z|M14 7v12",
    spark: "M18 3v4|M16 5h4",
    sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z|M12 1v2|M12 21v2|M4.2 4.2l1.4 1.4|M18.4 18.4l1.4 1.4|M1 12h2|M21 12h2|M4.2 19.8l1.4-1.4|M18.4 5.6l1.4-1.4",
    moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
    team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M19 8v6|M22 11h-6",
    rocket: "M5 15c-1.5 1.3-2 4-2 6 2 0 4.7-.5 6-2|M9 12a14 14 0 0 1 12-9 14 14 0 0 1-9 12l-3-3z|M9 12H5l3-4h4|M12 15v4l4-3v-4",
    info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 11v5|M12 8h.01",
    grip: "M9 6h.01|M15 6h.01|M9 12h.01|M15 12h.01|M9 18h.01|M15 18h.01",
    eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    eyeOff: "M3 3l18 18|M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9|M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6|M9.9 9.9a3 3 0 0 0 4.2 4.2",
    sliders: "M4 6h9|M17 6h3|M15 4v4|M4 12h3|M11 12h9|M9 10v4|M4 18h11|M19 18h1|M17 16v4",
    chevDown: "M6 9l6 6 6-6",
    box: "M3 7l9-4 9 4v10l-9 4-9-4z|M3 7l9 4 9-4|M12 11v10",
    shop: "M4 9h16l-1-5H5z|M5 9v11h14V9|M10 20v-6h4v6"
  };
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function abs(h) { try { if (window.HelmUrl && HelmUrl.upgrade) h = HelmUrl.upgrade(h); } catch (e) {} return (typeof h === "string" && h && !/^([a-z]+:|\/|#)/i.test(h)) ? "/" + h : h; }
  function link(href, cls, text) { var a = el("a", cls, text); a.href = abs(href); return a; }
  function S() { return window.BPStore; }
  async function safe(fn, dflt) { try { var r = await fn(); return r == null ? dflt : r; } catch (e) { return dflt; } }
  function authOn() { try { var A = S().auth; return !!(A && A.enabled && A.enabled()); } catch (e) { return false; } }
  async function canView(a) { try { if (!authOn()) return true; return !!(await S().auth.canView(a)); } catch (e) { return false; } }
  async function canEdit(a) { try { if (!authOn()) return true; var A = S().auth; return A.canEditArea ? !!(await A.canEditArea(a)) : !!(await A.can("create")); } catch (e) { return false; } }

  /* ---------- dates ---------- */
  function iso(d) { var m = d.getMonth() + 1, x = d.getDate(); return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (x < 10 ? "0" : "") + x; }
  function dOf(s) { var d = new Date(String(s || "").slice(0, 10) + "T00:00:00"); return isNaN(d) ? null : d; }
  /* whole calendar days from `now`'s day to date string ds (shared by the countdown + "In N days") */
  function dayDiff(ds, now) { var d = dOf(ds), t = dOf(iso(now || new Date())); return d && t ? Math.round((d - t) / DAY) : null; }
  function ym(d) { return d.getFullYear() * 12 + d.getMonth(); }
  function fmtDay(s) { var d = dOf(s); return d ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) : ""; }
  function ago(t) {
    var d = new Date(t); if (isNaN(d)) return "";
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 7 * 86400) return Math.floor(s / 86400) + "d ago";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  /* ---------- numbers (counts only: money lives on the Business page) ---------- */
  var CUR = "INR";
  function num(n) { return Math.round(Number(n) || 0).toLocaleString(CUR === "INR" ? "en-IN" : undefined); }
  function qCur(q) { try { return S().quoteCurrency(q); } catch (e) { return "INR"; } }
  function qName(q) { try { var H = window.HelmEventName; if (H && H.displayName) { var x = H.displayName(q); if (x) return x; } } catch (e) {} var c = q.client || {}; return q.title || c.name || q.code || "Untitled"; }
  function evHref(id) { return "event.html?id=" + encodeURIComponent(id); }

  /* ---------- motion ---------- */
  function countUp(node, target, fmt) {
    if (REDUCED || !isFinite(target) || target === 0 || !window.requestAnimationFrame) { node.textContent = fmt(target); return; }
    var t0 = null;
    function step(t) { if (t0 == null) t0 = t; var p = Math.min(1, (t - t0) / 600), e = 1 - Math.pow(1 - p, 3);
      node.textContent = fmt(target * e); if (p < 1) requestAnimationFrame(step); else node.textContent = fmt(target); }
    requestAnimationFrame(step);
  }

  /* ---------- small visual pieces ---------- */
  function pill(kind, text) { return el("span", "hd-pill hd-" + kind, text); }
  function statusPill(q) {
    var st = String(q.status || ""), ap = String(q.approvalStatus || q.approval_status || ""), lc = q.lifecycleStage || q.lifecycle_stage;
    if (st === "confirmed") return pill("ok", lc === "closed" ? "Completed" : "Confirmed");
    if (st === "cancelled") return pill("mute", "Cancelled");
    if (ap === "sent" || ap === "viewed") return pill("wait", "Awaiting client");
    if (ap === "approved") return pill("ok", "Approved");
    return pill("mute", st === "quote" ? "Tentative" : "Draft");
  }
  function sparkline(points) {
    var s = sv("svg", { viewBox: "0 0 100 32", preserveAspectRatio: "none", "class": "hd-spark", "aria-hidden": "true" });
    if (!points || points.length < 2) return s;
    var mx = Math.max.apply(null, points), mn = Math.min.apply(null, points), rg = mx - mn || 1;
    var pts = points.map(function (v, i) { return [(i / (points.length - 1)) * 100, 29 - ((v - mn) / rg) * 26]; });
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    sv("path", { d: d + " L100 32 L0 32 Z", "class": "hd-spark-fill" }, s);
    sv("path", { d: d, "class": "hd-spark-line", pathLength: "1", "vector-effect": "non-scaling-stroke" }, s);
    return s;
  }
  function meter(frac, kind) {
    var s = sv("svg", { viewBox: "0 0 100 6", preserveAspectRatio: "none", "class": "hd-meter", "aria-hidden": "true" });
    sv("rect", { x: 0, y: 0, width: 100, height: 6, rx: 3, "class": "hd-meter-bg" }, s);
    sv("rect", { x: 0, y: 0, width: Math.max(0, Math.min(1, frac || 0)) * 100, height: 6, rx: 3, "class": "hd-meter-fg" + (kind ? " hd-mf-" + kind : "") }, s);
    return s;
  }
  var delayN = 0;
  /* entrance class only on first render: dropped once the animation ends */
  function enter(n, d) { n.classList.add("hd-in", "hd-d" + Math.min(8, d)); n.addEventListener("animationend", function f(ev) { if (ev.target !== n) return; n.classList.remove("hd-in"); n.removeEventListener("animationend", f); }); return n; }
  function card(id, title, ic, opts) {
    opts = opts || {};
    var c = enter(el("section", "hd-card" + (opts.span ? " " + opts.span : "")), delayN++); c.id = id; c.setAttribute("aria-label", title);
    if (opts.block) c.setAttribute("data-block", opts.block);
    var h = el("div", "hd-head"); h.appendChild(icon(ic)); h.appendChild(el("h3", null, title));
    var tools = el("div", "hd-tools"); h.appendChild(tools); c.appendChild(h);
    if (opts.more) tools.appendChild(moreLink(opts.more[0], opts.more[1]));
    var b = el("div", "hd-body"); c.appendChild(b);
    for (var i = 0; i < (opts.skel || 3); i++) b.appendChild(el("div", "hd-skel"));
    return c;
  }
  function moreLink(href, text) { var a = link(href, "hd-more-link", text || "View all"); a.appendChild(icon(IC.arrow)); return a; }
  function body(c) { return clear(c.querySelector(".hd-body")); }
  function tools(c) { return c.querySelector(".hd-tools"); }
  /* 40px line illustrations for empty states (stroke = currentColor) */
  var ILL = { events: IC.cal + "|" + IC.spark, inbox: IC.inbox, ticket: IC.ticket, clear: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M8 12.5l2.7 2.7L16 10", pipe: IC.pipe, pulse: IC.pulse };
  function empty(b, text, cta, kind, sub) {
    var e = el("div", "hd-empty" + (kind === "clear" ? " hd-empty-ok" : ""));
    e.appendChild(icon(ILL[kind] || ILL.inbox, "hd-ill"));
    e.appendChild(el("p", "hd-empty-t", text));
    if (sub) e.appendChild(el("p", "hd-empty-s", sub));
    if (cta) { cta.classList.add("hd-sm"); e.appendChild(cta); }
    b.appendChild(e);
  }
  /* width step class (no inline style): hd-w-0 .. hd-w-100 in 5% steps */
  function wcls(frac) { var p = Math.round(Math.max(0, Math.min(1, frac || 0)) * 20) * 5; if (frac > 0 && p === 0) p = 5; return "hd-w-" + p; }

  /* ---------- Getting-started chip (admin/manager only; toggles #gsCard) ---------- */
  function setupChip() {
    var gs = document.getElementById("gsCard"); if (!gs) return null;
    var chip = el("button", "hd-chip"); chip.id = "hdSetup"; chip.type = "button"; chip.setAttribute("data-tour", "setup"); chip.hidden = true;
    chip.setAttribute("aria-controls", "gsCard"); chip.setAttribute("aria-expanded", "false");
    chip.addEventListener("click", function () {
      if (chip.__href) { location.href = chip.__href; return; }
      var open = !document.documentElement.classList.contains("hd-gs-open");
      document.documentElement.classList.toggle("hd-gs-open", open); chip.setAttribute("aria-expanded", String(open));
    });
    chip.__allowed = true;
    function sync() {
      // Shared source: when the studio-setup wizard has progress (onboarding-wizard.js), show
      // the same % it shows on /onboarding instead of the separate getting-started count.
      var W = window.HelmOnbWizard, n = W && W.lastNudge;
      if (chip.__allowed && n && n.pct < 100) {
        chip.__href = n.href; chip.removeAttribute("aria-controls"); chip.removeAttribute("aria-expanded");
        clear(chip); chip.appendChild(el("span", null, "Setup " + n.pct + "% done"));
        chip.appendChild(meter(n.pct / 100)); chip.appendChild(icon(IC.arrow)); chip.hidden = false; return;
      }
      if (chip.__href) { chip.__href = null; chip.setAttribute("aria-controls", "gsCard"); chip.setAttribute("aria-expanded", "false"); }
      var t = gs.querySelector(".gs-ring-txt"), m = t && /(\d+)\s*\/\s*(\d+)/.exec(t.textContent || "");
      if (!chip.__allowed || gs.hidden || !m || +m[1] >= +m[2]) { chip.hidden = true; return; }
      clear(chip); chip.appendChild(el("span", null, "Setup " + m[1] + " of " + m[2]));
      chip.appendChild(meter(+m[1] / +m[2])); chip.appendChild(icon(IC.arrow)); chip.hidden = false;
    }
    chip.__sync = sync;
    document.addEventListener("helm:onb-progress", sync);
    sync(); try { new MutationObserver(sync).observe(gs, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] }); } catch (e) {}
    return chip;
  }

  /* ---------- adopt the page's own create button (keeps its handler + gating + #nextName) ---------- */
  function adoptCreate(host) {
    var b = document.getElementById("createBtn"); if (!b) return null;
    b.classList.add("hd-btn", "hd-primary"); b.classList.remove("btn", "primary");
    for (var i = 0; i < b.childNodes.length; i++) { var n = b.childNodes[i]; if (n.nodeType === 3 && /\S/.test(n.nodeValue)) { n.nodeValue = "New quote "; break; } }
    if (!b.querySelector(".hd-ic")) b.insertBefore(icon(IC.plus), b.firstChild);
    var nx = document.getElementById("nextName"); if (nx) { nx.classList.add("hd-code"); nx.title = "Next quote code"; }
    b.title = "Start a new quote";
    host.appendChild(b); return b;
  }

  /* ---------- move an existing page section into a slot ---------- */
  function adopt(sec, slot, cls) { if (!sec || !slot) return; sec.classList.add("hd-legacy"); if (cls) sec.classList.add(cls); slot.appendChild(sec); }

  /* CLIENT-SAFE: the adopted quotes list renders "v3 · <amount> · <date>" as plain text.
     Move any currency-looking segment into a span[data-money] (hidden on the home page and
     masked by privacy mode). DOM-only: text is moved with textContent, never re-parsed. */
  var MONEY_RE = /[₹$€£¥]|\b(?:INR|USD|EUR|GBP|AED|SGD|Rs\.?)\b/;
  function tagMoney(host) {
    if (!host) return;
    function run() {
      var smalls = host.querySelectorAll(".ecard small");
      for (var i = 0; i < smalls.length; i++) {
        var s = smalls[i]; if (s.__hdMoney || s.querySelector("[data-money]")) continue;
        var parts = String(s.textContent || "").split(" · ");
        if (!parts.some(function (p) { return MONEY_RE.test(p); })) { s.__hdMoney = 1; continue; }
        clear(s);
        var kept = [];
        parts.forEach(function (p) { if (MONEY_RE.test(p)) { var m = el("span", "hd-money", p); m.setAttribute("data-money", ""); s.appendChild(m); } else kept.push(p); });
        s.insertBefore(document.createTextNode(kept.join(" · ")), s.firstChild); s.__hdMoney = 1;
      }
    }
    run(); try { new MutationObserver(run).observe(host, { childList: true, subtree: true }); } catch (e) {}
  }

  /* ---------- countdown to the next event (interval paused while the tab is hidden) ---------- */
  function countdown(panel, ev, label) {
    var timer = null, last = {};
    var tm = ev.time && /^(\d{1,2}):(\d{2})/.exec(String(ev.time));
    var target = dOf(ev.date); if (!target) return;
    if (tm) target.setHours(+tm[1], +tm[2], 0, 0);
    clear(panel);
    panel.appendChild(el("p", "hd-eyebrow", label));
    var nm = link(evHref(ev.id), "hd-next-name", ev.name); panel.appendChild(nm);
    var meta = el("p", "hd-next-meta"); meta.appendChild(icon(IC.cal));
    meta.appendChild(el("span", null, [fmtDay(ev.date), ev.client, ev.type].filter(Boolean).join(" · "))); panel.appendChild(meta);
    var clock = el("div", "hd-count"); panel.appendChild(clock);
    function unit(v, l, key) {
      var u = el("span", "hd-cu"), b = el("b", "hd-cd", v); u.appendChild(b); u.appendChild(el("small", "hd-eyebrow", l));
      if (last[key] != null && last[key] !== v && !REDUCED) { b.classList.add("hd-tick"); }
      last[key] = v; return u;
    }
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    function paint() {
      var now = new Date(), isToday = iso(now) === ev.date;
      clear(clock); clock.classList.toggle("hd-count-today", isToday);
      if (isToday) {
        clock.appendChild(el("b", "hd-cd", "Today"));
        if (tm) clock.appendChild(el("span", "hd-mono", pad(+tm[1]) + ":" + tm[2]));
        panel.setAttribute("aria-label", label + ": " + ev.name + ", today" + (tm ? " at " + pad(+tm[1]) + ":" + tm[2] : ""));
        return;
      }
      // Days = calendar-day difference (same rule as the "In N days" list via dayDiff), so a
      // 14-day-away event never reads "13 days 11 hrs" here. 1+ days away: days (+ start time).
      var cd = dayDiff(ev.date, now);
      if (cd != null && cd > 0) {
        clock.appendChild(unit(pad(cd), cd === 1 ? "Day" : "Days", "d"));
        if (tm) clock.appendChild(el("span", "hd-mono", pad(+tm[1]) + ":" + tm[2]));
        panel.setAttribute("aria-label", label + ": " + ev.name + ", in " + cd + (cd === 1 ? " day" : " days") + (tm ? " at " + pad(+tm[1]) + ":" + tm[2] : ""));
        return;
      }
      var ms = Math.max(0, target - now), mins = Math.floor(ms / 6e4), d = 0, h = Math.floor((mins % 1440) / 60), m = mins % 60;
      clock.appendChild(unit(pad(h), "Hrs", "h")); clock.appendChild(el("i", "hd-csep", d > 0 ? "·" : ":"));
      clock.appendChild(unit(pad(m), "Min", "m"));
      panel.setAttribute("aria-label", label + ": " + ev.name + ", in " + (d ? d + " days " : "") + h + " hours " + m + " minutes");
    }
    function start() { stop(); paint(); timer = setInterval(paint, 60000); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    document.addEventListener("visibilitychange", function () { if (document.hidden) stop(); else start(); });
    if (!document.hidden) start(); else paint();
  }

  /* ================================================================== */

  /* ---------- Customize mode (0109): reorder within a column + hide blocks; per user, per studio ----------
     Layout only re-orders / hides blocks the role already sees: gating (hidden attr / .hd-off) is never
     touched, so a saved layout can't reveal a gated block. Saved on Done (server RPC when 0109 is
     applied, else this device). Mouse = native drag and drop; touch = pointer events on the grip;
     keyboard = grip button (Space/Enter pick up, arrows move, Space drop, Esc cancel). */
  var CZ_NAMES = { mywork: "My work", mytasks: "My tasks", quotes: "All quotes", roleboard: "Team board" };
  var CZ_CACHE = "helm.dash.layout.last";
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function lsGet2(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet2(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function parseJ(s) { try { var o = JSON.parse(s); return o && typeof o === "object" ? o : null; } catch (e) { return null; } }
  function L() { return window.HelmDashLayout; }
  function czBlocks(grid) { var out = []; for (var n = grid.firstElementChild; n; n = n.nextElementSibling) if (n.hasAttribute("data-block")) out.push(n); return out; }
  function czGated(n) {
    if (n.hidden || n.classList.contains("hd-off")) return true;
    if (n.classList.contains("hd-slot")) { for (var c = n.firstElementChild; c; c = c.nextElementSibling) if (!c.hidden && !c.classList.contains("hd-ed")) return false; return true; }
    return false;
  }
  function czInfo(grid) { return czBlocks(grid).map(function (n) { return { id: n.getAttribute("data-block"), col: L().colOf(n.className), gated: czGated(n), n: n }; }); }
  function czName(n) { var id = n.getAttribute("data-block"); return CZ_NAMES[id] || n.getAttribute("aria-label") || id; }
  /* put the blocks of each column into `order` using the DOM slots that column already occupies */
  function czApply(grid, layout) {
    var info = czInfo(grid), m = L().merge(layout, info), byId = {};
    info.forEach(function (b) { byId[b.id] = b.n; });
    var cols = {};
    info.forEach(function (b) { (cols[b.col] = cols[b.col] || []).push(b.n); });
    Object.keys(cols).forEach(function (c) {
      var want = m.order.filter(function (id) { return byId[id] && L().colOf(byId[id].className) === c; }).map(function (id) { return byId[id]; });
      if (want.length !== cols[c].length) return;
      var marks = cols[c].map(function (n) { var k = document.createComment(""); grid.insertBefore(k, n); return k; });
      marks.forEach(function (k, i) { grid.replaceChild(want[i], k); });
    });
    var hid = ids0(layout && layout.hidden);
    info.forEach(function (b) { b.n.classList.toggle("hd-uhide", hid.indexOf(b.id) >= 0); });
  }
  /* Reset: moves can shift which DOM slot each column owns, so put every block back in its exact
     default slot (DEF order) before czApply; blocks not in DEF keep their relative place at the end. */
  function czResetSlots(grid, def) {
    var bl = czBlocks(grid); if (!bl.length) return;
    var want = bl.slice().sort(function (a, b) {
      var ia = def.indexOf(a.getAttribute("data-block")), ib = def.indexOf(b.getAttribute("data-block"));
      if (ia < 0) ia = def.length + bl.indexOf(a); if (ib < 0) ib = def.length + bl.indexOf(b); return ia - ib;
    });
    var marks = bl.map(function (n) { var k = document.createComment(""); grid.insertBefore(k, n); return k; });
    marks.forEach(function (k, i) { grid.replaceChild(want[i], k); });
  }
  function ids0(a) { return L() ? L().ids(a) : []; }
  function czRead(grid) {
    var bl = czBlocks(grid);
    return { order: bl.map(function (n) { return n.getAttribute("data-block"); }), hidden: bl.filter(function (n) { return n.classList.contains("hd-uhide"); }).map(function (n) { return n.getAttribute("data-block"); }) };
  }

  function setupCustomize(o) {
    var root = o.root, grid = o.grid, uid = o.uid, lsKey = "helm.dash.layout." + uid;
    var DEF = o.defaults, editing = false, snap = null, bar = null, live = null, grabbed = null, grabSnap = null, serverOk = false;
    var btn = o.button;

    /* load: server first, else this device; cache for a flicker-free next paint */
    function useLayout(lay) { if (!lay) return; czApply(grid, lay); ssSet(CZ_CACHE, JSON.stringify(lay)); }
    o.prefs.then(function (p) {
      if (p) { serverOk = true; var lay = p.layout && typeof p.layout === "object" ? p.layout : {};
        useLayout({ order: ids0(lay.order), hidden: ids0(p.hidden) }); return; }
      useLayout(parseJ(lsGet2(lsKey)) || {});
    });

    function announce(t) { if (live) { live.textContent = ""; setTimeout(function () { live.textContent = t; }, 30); } }
    function editable() { return czInfo(grid).filter(function (b) { return !b.gated; }); }
    function peers(n) { var c = L().colOf(n.className); return editable().filter(function (b) { return b.col === c; }).map(function (b) { return b.n; }); }
    function posText(n) { var p = peers(n); return "position " + (p.indexOf(n) + 1) + " of " + p.length; }

    function tools(n) {
      var t = n.querySelector(":scope > .hd-ed"); if (t) return t;
      t = el("div", "hd-ed"); t.hidden = true;
      var g = el("button", "hd-grip"); g.type = "button"; g.setAttribute("aria-label", "Move " + czName(n) + " (Space to pick up)");
      g.setAttribute("aria-describedby", "hdCzHelp"); g.appendChild(icon(IC.grip));
      var nm = el("span", "hd-ed-name", czName(n));
      var eye = el("button", "hd-eye"); eye.type = "button";
      function syncEye() { var off = n.classList.contains("hd-uhide"); clear(eye).appendChild(icon(off ? IC.eyeOff : IC.eye));
        eye.setAttribute("aria-pressed", off ? "false" : "true"); eye.setAttribute("aria-label", (off ? "Show " : "Hide ") + czName(n)); eye.title = off ? "Hidden - click to show" : "Shown - click to hide"; }
      eye.__sync = syncEye; syncEye();
      eye.addEventListener("click", function () { n.classList.toggle("hd-uhide"); syncEye(); announce(czName(n) + (n.classList.contains("hd-uhide") ? " hidden" : " shown")); });
      wireGrip(g, n);
      t.appendChild(g); t.appendChild(nm); t.appendChild(eye);
      n.insertBefore(t, n.firstChild); return t;
    }
    function syncAllEyes() { czBlocks(grid).forEach(function (n) { var e = n.querySelector(":scope > .hd-ed .hd-eye"); if (e && e.__sync) e.__sync(); }); }

    /* --- moving --- */
    function placeNear(n, target, after) {
      if (!target || target === n) return false;
      if (after ? target.nextElementSibling === n : target.previousElementSibling === n) return false;   /* idempotent: already there */
      grid.insertBefore(n, after ? target.nextSibling : target); return true;
    }
    /* drag moves: one per animation frame, with hysteresis, so reflow can't ping-pong the card (froze the page) */
    var dragPend = null, dragRaf = 0, lastT = null, lastX = 0, lastY = 0;
    function dragTo(n, x, y) {
      dragPend = { n: n, x: x, y: y }; if (dragRaf) return;
      dragRaf = requestAnimationFrame(dragRun);
    }
    function dragRun() {
      dragRaf = 0; var p = dragPend; dragPend = null; if (!p) return;
      var h = targetAt(p.n, p.x, p.y); if (!h) return;
      if (h.t === lastT && Math.abs(p.y - lastY) < 24 && Math.abs(p.x - lastX) < 24) return;
      var fwd = !!(p.n.compareDocumentPosition(h.t) & Node.DOCUMENT_POSITION_FOLLOWING);   /* DOM order decides the side */
      if (fwd !== h.after) return;   /* only once the pointer crosses the target's midpoint: a re-check can't flip it back */
      if (placeNear(p.n, h.t, fwd)) { lastT = h.t; lastX = p.x; lastY = p.y; }
    }
    /* end of a drag: apply the last pending move instead of dropping it (a quick release landed nowhere) */
    function dragReset() { if (dragRaf) { cancelAnimationFrame(dragRaf); dragRun(); } dragRaf = 0; dragPend = null; lastT = null; }
    function step(n, d) {
      var p = peers(n), i = p.indexOf(n), j = i + d; if (i < 0 || j < 0 || j >= p.length) return false;
      placeNear(n, p[j], d > 0); return true;
    }
    function targetAt(n, x, y) {
      var hit = document.elementFromPoint(x, y), t = hit && hit.closest ? hit.closest("[data-block]") : null;
      var ps = peers(n);
      if (!t || t.parentNode !== grid) {   /* in a gap: nearest same-column peer, if the point is inside the grid */
        var gr = root.getBoundingClientRect(); t = null;   /* .hd-grid may be display:contents (0x0 box) */
        if (x >= gr.left && x <= gr.right && y >= gr.top - 40 && y <= gr.bottom + 40) {
          var best = 1e9; ps.forEach(function (p) { if (p === n) return; var q = p.getBoundingClientRect();
            var d = Math.abs(x - (q.left + q.right) / 2) + Math.abs(y - Math.max(q.top, Math.min(y, q.bottom))) * 2; if (d < best) { best = d; t = p; } });
        }
      }
      if (!t || t === n || ps.indexOf(t) < 0) return null;
      var r = t.getBoundingClientRect(); return { t: t, after: y > r.top + r.height / 2 };
    }
    function wireGrip(g, n) {
      // mouse: native HTML5 drag, armed only from the grip
      g.addEventListener("mousedown", function () { if (editing) n.draggable = true; });
      g.addEventListener("mouseup", function () { if (!n.classList.contains("hd-dragging")) n.draggable = false; });
      document.addEventListener("mouseup", function () { if (!n.classList.contains("hd-dragging")) n.draggable = false; });
      n.addEventListener("dragstart", function (ev) {
        if (!editing || !n.draggable) return;
        try { ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", n.getAttribute("data-block")); } catch (e) {}
        n.classList.add("hd-dragging"); root.__czDrag = n;
      });
      n.addEventListener("dragend", function () { dragReset(); n.draggable = false; n.classList.remove("hd-dragging"); root.__czDrag = null; announce(czName(n) + " moved to " + posText(n)); });
      // touch / pen: pointer events from the grip; the page still scrolls everywhere else
      g.addEventListener("pointerdown", function (ev) {
        if (!editing || ev.pointerType === "mouse") return;
        ev.preventDefault(); try { g.setPointerCapture(ev.pointerId); } catch (e) {}
        n.classList.add("hd-dragging"); g.__pid = ev.pointerId;
      });
      g.addEventListener("pointermove", function (ev) {
        if (g.__pid !== ev.pointerId) return;
        dragTo(n, ev.clientX, ev.clientY);
        var edge = 64; if (ev.clientY < edge) window.scrollBy(0, -14); else if (ev.clientY > window.innerHeight - edge) window.scrollBy(0, 14);
      });
      function endP(ev) { if (g.__pid !== ev.pointerId) return; g.__pid = null; dragReset(); n.draggable = false; try { g.releasePointerCapture(ev.pointerId); } catch (e) {} n.classList.remove("hd-dragging"); announce(czName(n) + " moved to " + posText(n)); }
      g.addEventListener("pointerup", endP); g.addEventListener("pointercancel", endP);
      // keyboard
      g.addEventListener("keydown", function (ev) {
        var k = ev.key;
        if (grabbed !== n) {
          if (k === " " || k === "Enter") { ev.preventDefault(); grabbed = n; grabSnap = czRead(grid); n.classList.add("hd-grabbed");
            announce(czName(n) + " picked up, " + posText(n) + ". Arrow keys move, Space drops, Escape cancels."); }
          return;
        }
        if (k === "ArrowUp" || k === "ArrowLeft" || k === "ArrowDown" || k === "ArrowRight") {
          ev.preventDefault(); var moved = step(n, k === "ArrowUp" || k === "ArrowLeft" ? -1 : 1); g.focus();
          announce(moved ? czName(n) + ", " + posText(n) : czName(n) + " can't move further in this column");
        } else if (k === " " || k === "Enter") { ev.preventDefault(); drop(); announce(czName(n) + " dropped at " + posText(n)); }
        else if (k === "Escape") { ev.preventDefault(); ev.stopPropagation(); czResetSlots(grid, grabSnap.order); czApply(grid, grabSnap); drop(); g.focus(); announce("Move cancelled. " + czName(n) + " back at " + posText(n)); }
      });
      g.addEventListener("blur", function () { if (grabbed === n) setTimeout(function () { if (grabbed === n && document.activeElement !== g) drop(); }, 0); });
      function drop() { if (grabbed) grabbed.classList.remove("hd-grabbed"); grabbed = null; grabSnap = null; }
    }
    root.addEventListener("dragover", function (ev) {   /* whole dashboard, so gaps between cards still accept the drop */
      var n = root.__czDrag; if (!editing || !n) return;
      ev.preventDefault(); try { ev.dataTransfer.dropEffect = "move"; } catch (e) {}
      dragTo(n, ev.clientX, ev.clientY);
    });
    root.addEventListener("drop", function (ev) { var n = root.__czDrag; if (!n) return; ev.preventDefault(); if (editing) { dragPend = { n: n, x: ev.clientX, y: ev.clientY }; dragRun(); } });

    /* --- the sticky bar --- */
    function buildBar() {
      bar = el("div", "hd-czbar hd-s-full"); bar.setAttribute("role", "region"); bar.setAttribute("aria-label", "Customize dashboard"); bar.hidden = true;
      var txt = el("div", "hd-czbar-t"); txt.appendChild(el("b", null, "Customize your dashboard"));
      var help = el("span", "hd-caption", "Drag the grip to reorder within a column. Use the eye to hide a block."); help.id = "hdCzHelp"; txt.appendChild(help);
      var bx = el("div", "hd-czbar-b");
      var reset = el("button", "hd-btn hd-ghost", "Reset to default"); reset.type = "button";
      var cancel = el("button", "hd-btn hd-ghost", "Cancel"); cancel.type = "button";
      var done = el("button", "hd-btn hd-primary", "Done"); done.type = "button";
      reset.addEventListener("click", function () { czResetSlots(grid, DEF); czApply(grid, { order: DEF.slice(), hidden: [] }); syncAllEyes(); announce("Default layout restored. Press Done to keep it."); });
      cancel.addEventListener("click", function () { exit(false); });
      done.addEventListener("click", function () { exit(true); });
      bx.appendChild(reset); bx.appendChild(cancel); bx.appendChild(done);
      live = el("p", "hd-sr"); live.setAttribute("aria-live", "polite"); live.setAttribute("role", "status");
      bar.appendChild(txt); bar.appendChild(bx);
      root.insertBefore(bar, root.firstChild); root.appendChild(live);
      bar.__done = done;
    }
    function enterEdit() {
      if (editing || o.isBlocked()) return;
      if (!bar) buildBar();
      editing = true; snap = czRead(grid);
      editable().forEach(function (b) { tools(b.n).hidden = false; });
      syncAllEyes();
      root.classList.add("hd-editing"); bar.hidden = false; if (btn) btn.setAttribute("aria-pressed", "true");
      try { bar.scrollIntoView({ block: "nearest", behavior: REDUCED ? "auto" : "smooth" }); } catch (e) {}
      bar.__done.focus(); announce("Customize mode. " + editable().length + " blocks can be moved or hidden.");
    }
    function exit(save) {
      if (!editing) return;
      if (grabbed) { grabbed.classList.remove("hd-grabbed"); grabbed = null; }
      if (!save && snap) { czResetSlots(grid, snap.order); czApply(grid, snap); }
      editing = false; root.classList.remove("hd-editing"); bar.hidden = true; if (btn) { btn.setAttribute("aria-pressed", "false"); btn.focus(); }
      czBlocks(grid).forEach(function (n) { n.draggable = false; var t = n.querySelector(":scope > .hd-ed"); if (t) t.hidden = true; });
      if (!save) { announce("Changes discarded."); return; }
      var lay = czRead(grid); if (L().isDefault(lay, DEF.map(function (id) { return { id: id }; }))) lay = {};
      ssSet(CZ_CACHE, JSON.stringify(lay)); lsSet2(lsKey, JSON.stringify(lay));
      var dash = S() && S().dashboard;
      if (serverOk && dash && dash.saveLayout) dash.saveLayout(lay).then(function (r) { if (r === false) announce("Layout saved on this device only - couldn't reach the server."); });
    }
    if (btn) btn.addEventListener("click", function () { if (editing) exit(true); else enterEdit(); });
    window.addEventListener("hb:customize", enterEdit);
    document.addEventListener("keydown", function (ev) { if (editing && ev.key === "Escape" && !grabbed && !ev.defaultPrevented) exit(false); });
    try { var u = new URL(location.href); if (u.searchParams.get("customize") === "1") { u.searchParams.delete("customize");
      history.replaceState(history.state, "", u.pathname + (u.search || "") + u.hash); setTimeout(enterEdit, 0); } } catch (e) {}
  }

  /* ---------- split "New ..." menu next to the page's own #createBtn ---------- */
  function setupNewMenu(slot, createBtn, items) {
    if (!createBtn || !items.length) return;
    slot.classList.add("hd-split");
    var tog = el("button", "hd-btn hd-primary hd-split-tog"); tog.type = "button"; tog.id = "hdNewTog";
    tog.setAttribute("aria-haspopup", "menu"); tog.setAttribute("aria-expanded", "false"); tog.setAttribute("aria-label", "More things to create");
    tog.appendChild(icon(IC.chevDown)); slot.appendChild(tog);
    var menu = el("ul", "hd-menu"); menu.id = "hdNewMenu"; menu.setAttribute("role", "menu"); menu.setAttribute("aria-labelledby", tog.id); menu.hidden = true;
    tog.setAttribute("aria-controls", menu.id);
    items.forEach(function (it) {
      var li = el("li"); li.setAttribute("role", "none");
      var a = it.href ? link(it.href, "hd-menu-i") : el("button", "hd-menu-i"); if (!it.href) a.type = "button";
      a.setAttribute("role", "menuitem"); a.tabIndex = -1; a.appendChild(icon(it.ic)); a.appendChild(el("span", null, it.t));
      if (it.act) a.addEventListener("click", function () { close(false); it.act(); });
      li.appendChild(a); menu.appendChild(li);
    });
    document.body.appendChild(menu);
    function mi() { return Array.prototype.slice.call(menu.querySelectorAll("[role=menuitem]")); }
    function place() { var r = tog.getBoundingClientRect(); menu.style.setProperty("--hd-mt", Math.round(r.bottom + 6) + "px"); menu.style.setProperty("--hd-mr", Math.round(Math.max(8, document.documentElement.clientWidth - r.right)) + "px"); }
    function open(focusLast) { place(); menu.hidden = false; tog.setAttribute("aria-expanded", "true"); var l = mi(); (focusLast ? l[l.length - 1] : l[0]).focus(); }
    function close(refocus) { if (menu.hidden) return; menu.hidden = true; tog.setAttribute("aria-expanded", "false"); if (refocus) tog.focus(); }
    tog.addEventListener("click", function () { if (menu.hidden) open(); else close(true); });
    tog.addEventListener("keydown", function (ev) { if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); open(ev.key === "ArrowUp"); } });
    menu.addEventListener("keydown", function (ev) {
      var l = mi(), i = l.indexOf(document.activeElement);
      if (ev.key === "ArrowDown") { ev.preventDefault(); l[(i + 1) % l.length].focus(); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); l[(i - 1 + l.length) % l.length].focus(); }
      else if (ev.key === "Home") { ev.preventDefault(); l[0].focus(); }
      else if (ev.key === "End") { ev.preventDefault(); l[l.length - 1].focus(); }
      else if (ev.key === "Escape") { ev.preventDefault(); close(true); }
      else if (ev.key === "Tab") close(false);
    });
    document.addEventListener("click", function (ev) { if (!menu.hidden && !menu.contains(ev.target) && !tog.contains(ev.target)) close(false); });
    window.addEventListener("resize", function () { close(false); });
    window.addEventListener("scroll", function () { if (!menu.hidden) place(); }, { passive: true });
  }

  async function build() {
    var main = document.getElementById("main"); if (!main || document.getElementById("hdDash")) return;
    var wrap = el("div", "hd-wrap");                                         // container-query host (not #main: keeps fixed modals unaffected)
    var root = el("div", "hd-dash"); root.id = "hdDash"; wrap.appendChild(root);

    /* S0 hero: greeting left, countdown panel right */
    /* S-1 "Today" strip: one calm line at the very top (events today, tasks due, payments overdue). Read-only, empty-safe. */
    var todayBar = el("nav", "hd-today hd-s-full hd-today-wait");   /* space reserved from the first paint: no layout jump when it fills */ todayBar.setAttribute("aria-label", "Today"); todayBar.setAttribute("data-tour", "today");
    root.appendChild(todayBar);
    var hero = enter(el("header", "hd-hero hd-s-full hd-hero-solo"), 0);
    var spot = sv("svg", { viewBox: "0 0 240 240", "class": "hd-spot", "aria-hidden": "true", focusable: "false" }, hero);
    [[120, 110, "hd-sp1"], [120, 78, "hd-sp2"], [120, 46, "hd-sp3"]].forEach(function (c) { sv("circle", { cx: 200, cy: 40, r: c[1], "class": c[2] }, spot); });
    var hl = el("div", "hd-hl");
    var now = new Date();
    var hr = now.getHours(), tod = hr < 5 || hr >= 20 ? "night" : hr < 12 ? "morning" : hr < 17 ? "afternoon" : "evening";
    hero.classList.add("hd-tod-" + tod);
    var orb = el("span", "hd-orb"); orb.setAttribute("aria-hidden", "true"); orb.appendChild(icon(tod === "night" || tod === "evening" ? IC.moon : IC.sun, "hd-ic hd-orb-ic")); hero.appendChild(orb);
    var dl = el("p", "hd-date hd-eyebrow"); dl.appendChild(el("span", null, now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })));
    var clk = el("time", "hd-clock hd-mono"); dl.appendChild(clk); hl.appendChild(dl);
    (function () {                                                           // live clock, one tick per minute, paused while hidden
      var tmr = null;
      function paint() { var d = new Date(); clk.textContent = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); clk.setAttribute("datetime", d.toISOString()); }
      function arm() { clearTimeout(tmr); paint(); tmr = setTimeout(arm, 60000 - (Date.now() % 60000) + 50); }
      document.addEventListener("visibilitychange", function () { if (document.hidden) clearTimeout(tmr); else arm(); });
      arm();
    })();
    var greet = hr < 5 ? "Good evening" : hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
    var h1 = el("h2", "hd-greet"), h1t = el("span", "hd-greet-t", greet); h1.appendChild(h1t); hl.appendChild(h1);
    var sum = el("p", "hd-sum"); sum.appendChild(el("span", "hd-skel hd-skel-line")); hl.appendChild(sum);
    var acts = el("div", "hd-acts");
    var chip = setupChip(); if (chip) acts.appendChild(chip);                // order: Setup, Search, New lead, New quote
    var createSlot = el("span", "hd-create-slot");
    var sb = el("button", "hd-btn hd-ghost"); sb.type = "button"; sb.appendChild(icon(IC.search)); sb.appendChild(el("span", null, "Search"));
    var kbd = el("kbd", "hd-kbd", /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘K" : "Ctrl K"); sb.appendChild(kbd);
    sb.setAttribute("aria-label", "Search (" + kbd.textContent + ")");
    sb.addEventListener("click", function () { try { if (window.HelmStudioSearch && HelmStudioSearch.open) HelmStudioSearch.open(); } catch (e) {} });
    acts.appendChild(sb);
    var nl = link("leads.html#hb-new", "hd-btn hd-ghost"); nl.appendChild(icon(IC.user)); nl.appendChild(el("span", null, "New lead")); nl.hidden = true; acts.appendChild(nl);
    acts.appendChild(createSlot);
    var signIn = el("button", "hd-btn hd-primary"); signIn.type = "button"; signIn.hidden = true; signIn.appendChild(icon(IC.login)); signIn.appendChild(el("span", null, "Sign in"));
    signIn.addEventListener("click", function () { var b = document.getElementById("loginBtn"); if (b) b.click(); else location.href = "/login?next=dashboard"; });
    acts.appendChild(signIn);
    var czBtn = el("button", "hd-btn hd-ghost hd-cz"); czBtn.type = "button"; czBtn.hidden = true; czBtn.setAttribute("data-tour", "customize"); czBtn.title = "Customize dashboard";
    czBtn.setAttribute("aria-label", "Customize dashboard"); czBtn.setAttribute("aria-pressed", "false");
    czBtn.appendChild(icon(IC.sliders)); czBtn.appendChild(el("span", "hd-cz-l", "Customize")); acts.appendChild(czBtn);
    var createBtn = adoptCreate(createSlot);
    hl.appendChild(acts); hero.appendChild(hl);
    var nextP = el("aside", "hd-next"); nextP.hidden = true; nextP.setAttribute("aria-live", "off"); hero.appendChild(nextP);
    root.appendChild(hero);

    /* S2 KPI strip (one banded card, 4 count tiles) */
    var kpis = enter(el("div", "hd-kpis hd-s-full"), 1); kpis.setAttribute("aria-label", "Key numbers"); kpis.setAttribute("role", "group");
    var tiles = [];
    for (var i = 0; i < 4; i++) { var t = el("div", "hd-kpi"); t.appendChild(el("div", "hd-skel hd-skel-line")); t.appendChild(el("div", "hd-skel hd-skel-big")); kpis.appendChild(t); tiles.push(t); }
    root.appendChild(kpis);

    /* S1b "Get set up" strip for a new studio (shown only when there is genuinely no data yet) */
    var getSet = enter(el("section", "hd-getset hd-s-full"), 1); getSet.hidden = true; getSet.id = "hdGetSet"; getSet.setAttribute("aria-label", "Get set up");
    root.appendChild(getSet);

    /* sections: one parent, DOM order = reading order (grid/cols are display:contents) */
    var grid = el("div", "hd-grid"); root.appendChild(grid);
    delayN = 2;
    var cShift = card("hdShift", "My next shift", IC.pin, { skel: 2, span: "hd-s-full", block: "shift" }); cShift.hidden = true;
    var cCal = card("hdCal", "Your month", IC.cal, { skel: 4, more: ["calendar.html", "Calendar"], span: "hd-s-wide", block: "calendar" });
    var cAtt = card("hdAtt", "Needs attention", IC.alert, { span: "hd-s-side", block: "attention" });
    var cWeek = card("hdWeek", "This week", IC.cal, { skel: 4, span: "hd-s-side", block: "week" }); cWeek.classList.add("hd-off");   // crew only (the month calendar covers it)
    var cUp = card("hdUp", "Coming up in 30 days", IC.cal, { more: ["calendar.html", "Calendar"], span: "hd-s-wide", block: "upcoming" });
    var cFol = card("hdFol", "Follow-ups", IC.inbox, { skel: 3, more: ["leads.html", "Leads"], span: "hd-s-side", block: "followups" }); cFol.hidden = true;
    var cRev = card("hdRev", "Revenue", IC.chart, { skel: 2, more: ["reports.html", "Reports"], span: "hd-s-wide", block: "revenue" }); cRev.hidden = true;   // finance roles only
    var cPipe = card("hdPipe", "Pipeline", IC.pipe, { more: ["quotes.html", "Quotes"], span: "hd-s-side", block: "pipeline" });
    var slotWork = el("div", "hd-slot hd-s-wide"), slotTasks = el("div", "hd-slot hd-s-side"), slotQuotes = el("div", "hd-slot hd-s-wide"), slotRole = el("div", "hd-slot hd-s-side");
    slotWork.setAttribute("data-block", "mywork"); slotTasks.setAttribute("data-block", "mytasks"); slotQuotes.setAttribute("data-block", "quotes"); slotRole.setAttribute("data-block", "roleboard");
    var cNotes = card("hdNotes", "Desk notes", IC.doc, { skel: 1, span: "hd-s-side", block: "notes" });
    var cAct = card("hdAct", "Recent activity", IC.pulse, { more: ["audit.html", "Audit log"], span: "hd-s-side hd-act-card", block: "activity" }); cAct.hidden = true;
    [cShift, cCal, cAtt, cUp, cFol, cRev, cPipe, slotWork, slotTasks, slotQuotes, cNotes, slotRole, cAct, cWeek].forEach(function (n) { grid.appendChild(n); });
    var DEF_ORDER = czBlocks(grid).map(function (n) { return n.getAttribute("data-block"); });
    if (L()) { var czLast = parseJ(ssGet(CZ_CACHE)); if (czLast) czApply(grid, czLast); }   // last layout this tab saw: no flicker

    // move the page's own sections in (they keep their ids, handlers and hidden logic)
    var secQuotes = null, elist = document.getElementById("elist"); if (elist) secQuotes = elist.closest("section");
    adopt(document.getElementById("roleboard"), slotRole, "hd-rb");
    adopt(document.getElementById("mytasksSection"), slotTasks, "hd-mt");
    adopt(document.getElementById("myworkSection"), slotWork, "hd-mw");
    if (secQuotes) { adopt(secQuotes, slotQuotes, "hd-quotes"); secQuotes.id = secQuotes.id || "hdQuotes";
      var qh = secQuotes.querySelector(".head h3"); if (qh) qh.textContent = "All quotes"; tagMoney(elist); }
    main.insertBefore(wrap, main.firstChild);

    /* ---- store ---- */
    for (var w = 0; w < 100 && !(S() && S().quotes); w++) await new Promise(function (r) { setTimeout(r, 100); });
    if (!S()) { clear(sum).appendChild(document.createTextNode("Data isn't available right now.")); [cAtt, cUp, cCal, cPipe].forEach(function (c) { empty(body(c), "Not available right now."); }); kpis.hidden = true; return; }
    await safe(function () { return S().init(); });
    try { CUR = S().studioCurrency() || "INR"; } catch (e) {}

    var A = S().auth || {};
    var user = null; try { user = A.user ? A.user() : null; } catch (e) {}
    var signedOut = authOn() && !user;
    if (signedOut) { signIn.hidden = false; if (createBtn) createBtn.hidden = true; }

    var role = signedOut ? null : await safe(function () { return A.role(); }, null);
    var MONEY = ["admin", "manager", "planner", "sales"], TASK = ["crew", "worker", "coordinator", "supervisor", "operations", "quality"];
    var isMoney = !authOn() || MONEY.indexOf(role) >= 0, isTask = TASK.indexOf(role) >= 0;
    var isCrew = role === "crew" || role === "worker";
    var perms = await Promise.all([canView("quotes"), canView("leads"), canEdit("leads"), canEdit("quotes"),
      (role === "admin" || role === "manager" || !authOn()) ? canView("audit") : Promise.resolve(false)]);
    var vQuotes = perms[0] && !signedOut, vLeads = perms[1] && !signedOut, eLeads = perms[2] && !signedOut, eQuotes = perms[3], vAudit = perms[4] && !signedOut && authOn();
    nl.hidden = !eLeads;
    if (createBtn && !eQuotes) createBtn.hidden = true;                       // page JS also hides it for !can("create")
    if (chip) { chip.__allowed = !authOn() || role === "admin" || role === "manager"; chip.__sync(); }
    root.classList.toggle("hd-role-task", !isMoney);
    kpis.hidden = isCrew || !isMoney && !isTask;
    if (!isMoney) { cRev.hidden = true; if (!vQuotes && !vLeads) cPipe.hidden = true; }
    if (isMoney) slotRole.classList.add("hd-off");                           // KPI tiles cover the money roles' board
    if (isCrew) { cShift.hidden = false; root.classList.add("hd-crew"); cWeek.classList.remove("hd-off");   // crew home: shift ticket, tasks, their week; nothing else
      [cAtt, cUp, cCal, cFol, cPipe, cRev, slotWork, slotQuotes, slotRole].forEach(function (n) { n.classList.add("hd-off"); }); }
    if (vAudit) cAct.hidden = false;
    if ((vLeads || vQuotes) && !isCrew) cFol.hidden = false;
    if (signedOut) {                                                         // one shared empty instead of a wall of empty cards
      [cAtt, cCal, cFol, cNotes, cPipe, cRev, cAct, slotWork, slotQuotes, slotRole, slotTasks].forEach(function (n) { n.classList.add("hd-off"); });
      cUp.classList.remove("hd-s-wide"); cUp.classList.add("hd-s-full"); kpis.hidden = true;
    }

    /* ---- customize + split "New" menu (signed-in only; demo mode keeps the layout on this device) ---- */
    var prefsP = signedOut ? Promise.resolve(null) : safe(function () { var D = S().dashboard; return D && D.prefs ? D.prefs() : null; }, null);
    if (!signedOut && L()) {
      czBtn.hidden = false;
      setupCustomize({ root: root, grid: grid, button: czBtn, defaults: DEF_ORDER, prefs: prefsP,
        uid: (user && user.id) || "local", isBlocked: function () { return czBtn.hidden; } });
    }
    if (createBtn && !createBtn.hidden && !signedOut) Promise.all([canEdit("inventory"), canEdit("vendors"), canEdit("staff"), canEdit("crm")]).then(function (pe) {
      var items = [{ t: "New quote", ic: IC.doc, act: function () { createBtn.click(); } }];
      if (eLeads) items.push({ t: "New lead", ic: IC.user, href: "leads.html#hb-new" });
      if (pe[3]) items.push({ t: "New client", ic: IC.people, href: "crm.html" });
      if (pe[0]) items.push({ t: "Inventory item", ic: IC.box, href: "inventory.html" });
      if (pe[1]) items.push({ t: "Vendor", ic: IC.shop, href: "vendors.html" });
      if (pe[2]) items.push({ t: "Staff member", ic: IC.team, href: "staff.html" });
      setupNewMenu(createSlot, createBtn, items);
    });

    /* name for the greeting (fills while data loads) */
    safe(function () { return S().profile && S().profile.mine ? S().profile.mine() : null; }).then(function (p) {
      var nm = (p && (p.full_name || p.name)) || (user && user.user_metadata && user.user_metadata.full_name) || (user && user.email ? String(user.email).split("@")[0] : "");
      nm = String(nm || "").trim().split(/\s+/)[0];
      if (nm) h1t.textContent = greet + ", " + nm.charAt(0).toUpperCase() + nm.slice(1);
      var rl = ""; try { rl = role && A.admin && A.admin.roleLabel ? A.admin.roleLabel(role) : ""; } catch (e) {}
      if (rl) { var rp = el("span", "hd-role", rl); h1.appendChild(rp); }
    });

    /* fire everything in parallel */
    var P = {
      page: vQuotes ? safe(function () { return S().quotes.page({ sort: "updated", limit: 500 }); }, null) : Promise.resolve(null),
      counts: vQuotes ? safe(function () { return S().quotes.counts(); }, null) : Promise.resolve(null),
      leads: vLeads ? safe(function () { return S().leads.list(); }, null) : Promise.resolve(null),
      pend: signedOut ? Promise.resolve(null) : safe(function () { return S().pending(); }, null),
      tasks: signedOut ? Promise.resolve(null) : safe(function () { return S().myTasks(); }, null),
      audit: vAudit ? safe(function () { return S().audit.list({ limit: 12 }); }, null) : Promise.resolve(null),
      // 0108: exact server numbers (ledger-based collected, overdue, pipeline). null = not installed -> fallback below
      money: (vQuotes || isMoney) && !signedOut && S().dashboard && S().dashboard.money ? safe(function () { return S().dashboard.money(12); }, null) : Promise.resolve(null)
    };
    var R = await Promise.all([P.page, P.counts, P.leads, P.pend, P.tasks, P.money]);
    var pageRes = R[0], rows = (pageRes && pageRes.rows) || [], counts = R[1], leads = R[2] || [], pend = R[3], tasks = R[4];
    var M = R[5] && typeof R[5] === "object" && Array.isArray(R[5].months) ? R[5] : null;
    var mCur = M && M.currency ? String(M.currency).toUpperCase() : null;
    if (M && mCur !== CUR) M = null;                                         // never mix currencies
    var MP = M && M.pipeline ? M.pipeline : null, MT = (M && M.totals) || {};
    var MFIN = !!(M && M.finance && MT.outstanding != null);
    function mN(x) { var v = Number(x); return isFinite(v) ? v : 0; }
    function mStage(k) { var x = MP && MP[k]; return x ? { n: mN(x.count), v: x.value == null ? null : mN(x.value) } : null; }
    var mOpenLeads = null;
    if (M && M.leads && typeof M.leads === "object") { mOpenLeads = 0; Object.keys(M.leads).forEach(function (k) { if (k !== "lost" && k !== "won" && k !== "converted") mOpenLeads += mN(M.leads[k]); }); }
    var today = iso(now), todayD = dOf(today);
    var curRows = rows.filter(function (q) { return qCur(q) === CUR; });

    /* merged event list (my_pending scoped feed + loaded quotes) */
    var events = [], seen = {};
    ((pend && pend.upcoming) || []).forEach(function (e) {
      if (!e || !e.event_date) return; seen[e.id] = 1; if (String(e.status || "") === "cancelled") return;
      var q = null; for (var k = 0; k < rows.length; k++) if (rows[k].id === e.id) { q = rows[k]; break; }
      events.push({ id: e.id, date: String(e.event_date).slice(0, 10), name: qName(q || e) || "Event", code: e.code, type: e.event_type,
        client: q && q.client && q.client.name, q: q || { status: e.status, lifecycleStage: e.lifecycle_stage, approvalStatus: e.approval_status },
        open: Number(e.open_tasks || 0), done: Number(e.done_tasks || 0), hasTasks: e.open_tasks != null, time: (q && q.eventTime) || e.event_time || null });
    });
    rows.forEach(function (q) { if (q.eventDate && !seen[q.id] && q.status !== "cancelled") events.push({ id: q.id, date: String(q.eventDate).slice(0, 10), name: qName(q), code: q.code, type: q.eventType, client: q.client && q.client.name, q: q, time: q.eventTime || null }); });
    events.sort(function (a, b) { return a.date.localeCompare(b.date); });
    var future = events.filter(function (e) { return e.date >= today; });
    var in30 = iso(new Date(todayD.getTime() + 30 * DAY));
    var weekStart = new Date(todayD); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    var weekEnd = iso(new Date(weekStart.getTime() + 6 * DAY)), weekS = iso(weekStart);
    var thisWeek = events.filter(function (e) { return e.date >= weekS && e.date <= weekEnd; });

    var openLeads = leads.filter(function (l) { var s = String(l.status || "new"); return !l.quote_id && s !== "lost" && s !== "won" && s !== "converted"; });
    var staleLeads = leads.filter(function (l) { return String(l.status || "new") === "new" && l.created_at && (Date.now() - new Date(l.created_at).getTime()) > DAY; });
    var tc = (tasks && tasks.counts) || {};

    safe(function () {
      if (signedOut) return;
      var tEv = events.filter(function (e) { return e.date === today; });
      var tDue = Number(tc.today || 0), tOver = Number(tc.overdue || 0);
      var pOver = MFIN && Array.isArray(M.overdue) ? M.overdue : [];
      var pSum = 0; pOver.forEach(function (o) { var a = Number(o.amount) - Number(o.paid || 0); if (isFinite(a) && a > 0) pSum += a; });
      clear(todayBar);
      todayBar.appendChild(el("span", "hd-today-lbl hd-eyebrow", "Today"));
      function seg(href, ic, txt, kind) {
        var a = link(href, "hd-today-seg" + (kind ? " hd-today-" + kind : "")); a.appendChild(icon(ic, "hd-ic")); a.appendChild(txt); todayBar.appendChild(a); return a;
      }
      var evT = tEv.length ? tEv.length + (tEv.length === 1 ? " event" : " events") + (tEv.length === 1 && tEv[0].name ? " · " + tEv[0].name : "") : "No events";
      seg(tEv.length === 1 ? evHref(tEv[0].id) : "calendar.html", IC.cal, document.createTextNode(evT), tEv.length ? "on" : null);
      if (tasks) {
        var tt = (tDue ? tDue + (tDue === 1 ? " task" : " tasks") + " due" : "No tasks due") + (tOver ? " · " + tOver + " overdue" : "");
        seg("#mytasksSection", IC.task, document.createTextNode(tt), tOver ? "bad" : tDue ? "on" : null);
      }
      if (MFIN) {
        var pt = el("span");
        if (pOver.length) {
          pt.appendChild(document.createTextNode(pOver.length + (pOver.length === 1 ? " payment" : " payments") + " overdue · "));
          var amt = el("span", null, (window.HelmMoney && HelmMoney.compact) ? HelmMoney.compact(pSum) : CUR + " " + Math.round(pSum).toLocaleString());
          if (window.HelmMoney && HelmMoney.money) HelmMoney.money(amt); else amt.setAttribute("data-money", "");
          pt.appendChild(amt);
        } else pt.textContent = "No payments overdue";
        seg(pOver.length === 1 && pOver[0].quote_id ? evHref(pOver[0].quote_id) : "business.html", IC.alert, pt, pOver.length ? "bad" : null);
      }
      todayBar.hidden = false; todayBar.classList.remove("hd-today-wait");
      /* 0121: payments due TODAY, added when the call answers (fail-soft: nothing shown if not installed) */
      if (MFIN && window.BPStore && BPStore.dashboard && typeof BPStore.dashboard.dueToday === "function") {
        Promise.resolve(BPStore.dashboard.dueToday()).then(function (d) {
          var list = d && Array.isArray(d.due_today) ? d.due_today.filter(function (o) { return !o.currency || o.currency === CUR; }) : null;
          if (!list) return;
          var sum = 0; list.forEach(function (o) { var a = Number(o.balance != null ? o.balance : Number(o.amount) - Number(o.paid || 0)); if (isFinite(a) && a > 0) sum += a; });
          var dt = el("span");
          if (list.length) {
            dt.appendChild(document.createTextNode(list.length + (list.length === 1 ? " payment" : " payments") + " due today · "));
            var am = el("span", null, (window.HelmMoney && HelmMoney.compact) ? HelmMoney.compact(sum) : CUR + " " + Math.round(sum).toLocaleString());
            if (window.HelmMoney && HelmMoney.money) HelmMoney.money(am); else am.setAttribute("data-money", "");
            dt.appendChild(am);
          } else dt.textContent = "No payments due today";
          seg(list.length === 1 && list[0].quote_id ? evHref(list[0].quote_id) : "business.html", IC.cal, dt, list.length ? "on" : null);
        }, function () {});
      }
    });

    /* ---- S0 summary line ---- */
    (function () {
      var parts = [], waitQ = vQuotes ? rows.filter(function (q) { return q.status === "quote" && (q.approvalStatus === "sent" || q.approvalStatus === "viewed"); }).length : 0;
      var wk7 = iso(new Date(todayD.getTime() + 6 * DAY)), next7 = future.filter(function (e) { return e.date <= wk7; }).length;   // same 7 days as the agenda
      if (next7) parts.push(next7 + (next7 === 1 ? " event" : " events") + " this week");
      if (waitQ) parts.push(waitQ + (waitQ === 1 ? " quote" : " quotes") + " waiting on clients");
      if (vLeads && staleLeads.length) parts.push(staleLeads.length + (staleLeads.length === 1 ? " lead" : " leads") + " awaiting reply");
      if (tc.today) parts.push(tc.today + (tc.today === 1 ? " task" : " tasks") + " due today");
      if (tc.overdue) parts.push(tc.overdue + " overdue");
      clear(sum);
      if (signedOut) { sum.textContent = "Sign in to see your events."; return; }
      if (!parts.length) { sum.textContent = "Nothing urgent on your plate today."; return; }
      var txt = parts.join(", ") + "."; sum.textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
    })();

    /* ---- S1b get set up: a new studio sees next steps instead of empty cards (no numbers invented) ---- */
    if (!signedOut && !isCrew && isMoney && (vQuotes || vLeads) && !events.length && !rows.length && !(leads.length > 2)) (function () {
      var steps = [];
      var isAdm = !authOn() || role === "admin";
      if (chip && chip.__allowed) steps.push({ ic: IC.rocket, t: "Finish studio setup", s: "Brand, packages and preferences.", done: false, act: function () { if (!document.documentElement.classList.contains("hd-gs-open")) chip.click(); var g = document.getElementById("gsCard"); if (g && g.scrollIntoView) g.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" }); } });
      if (eLeads) steps.push({ ic: IC.user, t: "Add your first lead", s: "Capture an enquiry in under a minute.", done: leads.length > 0, href: "leads.html" });
      if (eQuotes && createBtn) steps.push({ ic: IC.doc, t: "Create your first quote", s: "Turn an enquiry into a proposal.", done: rows.length > 0, act: function () { createBtn.click(); } });
      if (isAdm) steps.push({ ic: IC.team, t: "Invite your team", s: "Give planners and crew their own access.", done: false, href: "control.html" });
      if (!steps.length) return;
      var doneN = steps.filter(function (x) { return x.done; }).length;
      var head = el("div", "hd-gs-head");
      var ht = el("div"); ht.appendChild(el("p", "hd-eyebrow", "Get set up")); ht.appendChild(el("h3", "hd-gs-title", "Welcome aboard. A few steps and your dashboard comes alive."));
      head.appendChild(ht); head.appendChild(el("span", "hd-pill hd-info hd-count-pill", doneN + " of " + steps.length + " done"));
      getSet.appendChild(head);
      var ol = el("ol", "hd-gs-steps");
      steps.forEach(function (x, i) {
        var li = el("li"), a = x.href ? link(x.href, "hd-gs-step") : el("button", "hd-gs-step");
        if (!x.href) { a.type = "button"; a.addEventListener("click", x.act); }
        if (x.done) a.classList.add("hd-gs-done");
        var n = el("span", "hd-gs-n"); n.appendChild(icon(x.done ? IC.check : x.ic)); a.appendChild(n);
        var m = el("span", "hd-gs-m"); m.appendChild(el("b", null, (i + 1) + ". " + x.t)); m.appendChild(el("small", null, x.done ? "Done" : x.s)); a.appendChild(m);
        a.appendChild(icon(IC.arrow, "hd-ic hd-gs-go"));
        li.appendChild(a); ol.appendChild(li);
      });
      getSet.appendChild(ol); getSet.hidden = false; root.classList.add("hd-new");
    })();

    /* ---- S1 countdown panel: next confirmed event (crew: next shift) ---- */
    (function () {
      var nx = null;
      if (isCrew) nx = future[0] || null;
      else for (var k = 0; k < future.length; k++) { if (future[k].q && future[k].q.status === "confirmed") { nx = future[k]; break; } }
      if (!nx || signedOut) { nextP.hidden = true; hero.classList.add("hd-hero-solo"); return; }
      nextP.hidden = false; hero.classList.remove("hd-hero-solo");
      countdown(nextP, nx, isCrew ? "Next shift" : "Next event");
    })();

    /* ---- S2 KPI tiles ---- */
    function monthSeries(list, dateOf, valOf, n) {
      var cur = ym(now), out = []; for (var j = 0; j < n; j++) out.push(0);
      list.forEach(function (x) { var d = dOf(dateOf(x)); if (!d) return; var k = n - 1 - (cur - ym(d)); if (k >= 0 && k < n) out[k] += valOf(x); });
      return out;
    }
    function tile(t, o) {
      clear(t); t.classList.toggle("hd-kpi-link", !!o.href);
      var top = el("div", "hd-kpi-top"); top.appendChild(el("span", "hd-kpi-l hd-eyebrow", o.label));
      top.appendChild(icon(o.ic || IC.chart, "hd-ic hd-kpi-ic")); t.appendChild(top);
      var vr = el("div", "hd-kpi-vr"), v = el("div", "hd-kpi-v"); vr.appendChild(v); if (o.delta != null) vr.appendChild(o.delta); t.appendChild(vr);
      if (o.value == null) v.textContent = "—"; else countUp(v, o.value, o.fmt || num);
      t.appendChild(el("p", "hd-kpi-sub" + (o.subKind ? " hd-t-" + o.subKind : ""), o.sub || ""));
      if (o.dots) {                                                          // 7 days ahead: filled where an event exists
        var foot = el("div", "hd-kpi-foot hd-dots7"); foot.setAttribute("aria-hidden", "true");
        o.dots.forEach(function (on) { foot.appendChild(el("i", on ? "hd-on" : null)); }); t.appendChild(foot);
      }
      if (o.tip) { var tp = el("span", "hd-tip", o.tip); tp.id = "hdTip" + tiles.indexOf(t); tp.setAttribute("role", "tooltip"); t.appendChild(tp); }
      if (o.href) { var a = link(o.href, "hd-kpi-a"); a.setAttribute("aria-label", o.label + ": open"); if (o.tip) a.setAttribute("aria-describedby", "hdTip" + tiles.indexOf(t)); t.appendChild(a); }
    }
    function delta(curV, prevV, goodUp) {
      if (!prevV) return el("span", "hd-delta hd-delta-na", "—");
      var p = Math.round(((curV - prevV) / Math.abs(prevV)) * 100), up = p >= 0;
      var good = goodUp === false ? !up : up;
      var d = el("span", "hd-delta " + (p === 0 ? "hd-delta-na" : good ? "hd-delta-up" : "hd-delta-dn"), (up ? "▲ " : "▼ ") + Math.abs(p) + "%");
      d.title = "vs previous period"; return d;
    }
    if (!kpis.hidden) {
      if (isMoney) {
        // client-safe: counts only (money is on the Business page)
        var up30 = future.filter(function (e) { return e.date <= in30; });
        var upSeries = []; for (var wk = 0; wk < 7; wk++) { var a0 = iso(new Date(todayD.getTime() + wk * 7 * DAY)), a1 = iso(new Date(todayD.getTime() + (wk * 7 + 6) * DAY)); upSeries.push(future.filter(function (e) { return e.date >= a0 && e.date <= a1; }).length); }
        var dots7 = []; for (var dd = 0; dd < 7; dd++) { var dIso = iso(new Date(todayD.getTime() + dd * DAY)); dots7.push(future.some(function (e) { return e.date === dIso; })); }
        var nx0 = up30[0];
        tile(tiles[0], { label: "Upcoming · 30d", tip: "Events dated in the next 30 days. Dots show the next 7 days.", ic: IC.cal, value: up30.length, sub: nx0 ? "Next: " + nx0.name + ", " + (nx0.date === today ? "today" : fmtDay(nx0.date)) : "Nothing booked yet", dots: dots7, href: "calendar.html" });
        var pc0 = mStage("confirmed"), confN = pc0 ? pc0.n : counts && typeof counts.confirmed === "number" ? counts.confirmed : curRows.filter(function (q) { return q.status === "confirmed" && q.lifecycleStage !== "closed"; }).length;
        var confSeries = monthSeries(rows.filter(function (q) { return q.status === "confirmed"; }), function (q) { return q.confirmedAt || q.eventDate || q.updatedAt; }, function () { return 1; }, 7);
        tile(tiles[1], { label: "Confirmed events", tip: "Confirmed events not yet closed. The arrow compares confirmations this month with last month.", ic: IC.check, value: vQuotes ? confN : null, delta: vQuotes ? delta(confSeries[6], confSeries[5]) : null,
          sub: vQuotes ? confSeries[6] + " confirmed this month" : "No access to quotes", spark: vQuotes ? confSeries : null, href: vQuotes ? "quotes.html" : null });
        var mo = mStage("open"), ms = mStage("sent");
        var openN = mo && ms ? mo.n + ms.n : counts && typeof counts.quote === "number" ? counts.quote : rows.filter(function (q) { return q.status === "quote"; }).length;
        var waitN = rows.filter(function (q) { return q.status === "quote" && (q.approvalStatus === "sent" || q.approvalStatus === "viewed"); }).length;
        tile(tiles[2], { label: "Open quotes", tip: "Quotes still in progress, including ones sent to clients.", ic: IC.doc, value: vQuotes ? openN : null, sub: vQuotes ? (waitN ? waitN + " awaiting client" : "None waiting on a client") : "No access to quotes", subKind: waitN ? "wait" : null,
          spark: vQuotes ? monthSeries(rows, function (q) { return q.createdAt; }, function () { return 1; }, 7) : null, href: vQuotes ? "quotes.html" : null });
        if (vLeads) {
          var nowT = Date.now(), l7 = 0, lp7 = 0;
          leads.forEach(function (l) { var t = l.created_at ? new Date(l.created_at).getTime() : NaN; if (!isFinite(t)) return; var a = nowT - t; if (a >= 0 && a < 7 * DAY) l7++; else if (a >= 7 * DAY && a < 14 * DAY) lp7++; });
          tile(tiles[3], { label: "New leads · 7d", tip: "Enquiries received in the last 7 days, compared with the 7 days before.", ic: IC.user, value: l7, delta: delta(l7, lp7), sub: (mOpenLeads != null ? mOpenLeads : openLeads.length) + " open" + (staleLeads.length ? " · " + staleLeads.length + " waiting > 24h" : ""),
            subKind: staleLeads.length ? "wait" : null, href: "leads.html" });
        } else {
          tile(tiles[3], { label: "Tasks overdue", tip: "Your tasks past their due date.", ic: IC.task, value: tasks ? (tc.overdue || 0) : null, sub: tasks ? (tc.today || 0) + " due today" : "Tasks unavailable", subKind: tc.overdue ? "bad" : null, href: "#mytasksSection" });
        }
      } else {
        // task-centric roles (coordinator, supervisor, operations, quality)
        tile(tiles[0], { label: "Tasks today", tip: "Your tasks due today.", ic: IC.task, value: tasks ? (tc.today || 0) : null, sub: "Due today", href: "#mytasksSection" });
        tile(tiles[1], { label: "Overdue", tip: "Your tasks past their due date.", ic: IC.alert, value: tasks ? (tc.overdue || 0) : null, sub: tc.overdue ? "Needs action" : "On track", subKind: tc.overdue ? "bad" : "ok", href: "#mytasksSection" });
        tile(tiles[2], { label: "Blocked", tip: "Your tasks waiting on someone or something.", ic: IC.clock, value: tasks ? (tc.blocked || 0) : null, sub: tc.blocked ? "Waiting on something" : "Nothing blocked", subKind: tc.blocked ? "wait" : null, href: "#mytasksSection" });
        tile(tiles[3], role === "operations" ? { label: "Upcoming events", tip: "All upcoming events you can see.", ic: IC.cal, value: future.length, sub: "Open inventory", href: "inventory.html" }
          : { label: "Completed", tip: "Tasks you have finished.", ic: IC.check, value: tasks ? (tc.completed || 0) : null, sub: future.length + " upcoming events", subKind: "ok", href: "#mytasksSection" });
      }
    }

    /* shared: ticket stub (month eyebrow + day) */
    function stub(ds, big) {
      var d = dOf(ds), s = el("div", "hd-stub" + (ds === today ? " hd-stub-today" : "") + (big ? " hd-stub-lg" : ""));
      s.appendChild(el("small", "hd-eyebrow", ds === today ? "Today" : d ? d.toLocaleDateString(undefined, { month: "short" }) : ""));
      s.appendChild(el("b", "hd-stub-d", d ? d.getDate() : "—"));
      return s;
    }
    function metaI(ic, text, cls) { var m = el("span", "hd-mi" + (cls ? " " + cls : "")); m.appendChild(icon(ic)); m.appendChild(el("span", null, text)); return m; }
    function hhmm(t) { var m = t && /^(\d{1,2}):(\d{2})/.exec(String(t)); return m ? (m[1].length < 2 ? "0" : "") + m[1] + ":" + m[2] : ""; }
    function ring(done, total) {                                             // readiness ring: tasks done / total
      var f = total ? done / total : 0, C = 2 * Math.PI * 15, w = el("span", "hd-ring" + (f >= 1 ? " hd-ring-ok" : ""));
      w.setAttribute("role", "img"); w.setAttribute("aria-label", done + " of " + total + " tasks done"); w.title = "Readiness: " + done + "/" + total + " tasks done";
      var s = sv("svg", { viewBox: "0 0 36 36", "aria-hidden": "true" }, w);
      sv("circle", { cx: 18, cy: 18, r: 15, "class": "hd-ring-bg" }, s);
      sv("circle", { cx: 18, cy: 18, r: 15, "class": "hd-ring-fg", "stroke-dasharray": (C * f).toFixed(2) + " " + C.toFixed(2), transform: "rotate(-90 18 18)" }, s);
      w.appendChild(el("b", null, Math.round(f * 100)));
      return w;
    }
    function daysAway(ds) { return dayDiff(ds, now); }

    /* ---- S9 crew: my next shift (large ticket) ---- */
    if (!cShift.hidden) (function () {
      var b = body(cShift);
      var tlist = [].concat((tasks && tasks.today) || [], (tasks && tasks.upcoming) || []);
      var nextEv = future[0], nextT = tlist[0];
      if (!nextEv && !nextT) { empty(b, "No shifts scheduled", null, "events", "New assignments will show here."); return; }
      var ds = nextEv ? nextEv.date : String(nextT.planned_start || nextT.planned_end || "").slice(0, 10);
      var tk = el("div", "hd-ticket hd-shift");
      tk.appendChild(stub(ds, true));
      var m = el("div", "hd-shift-m");
      m.appendChild(el("b", "hd-shift-n", nextEv ? nextEv.name : (nextT.event_title || nextT.title || "Task")));
      var call = hhmm(nextEv && nextEv.time);
      if (call) { var cl = el("p", "hd-shift-call"); cl.appendChild(el("small", "hd-eyebrow", "Call time")); cl.appendChild(el("span", "hd-shift-t", call)); m.appendChild(cl); }
      var meta = el("p", "hd-tk-meta");
      meta.appendChild(metaI(IC.cal, ds === today ? "Today" : fmtDay(ds)));
      if (nextEv && nextEv.type) meta.appendChild(el("span", "hd-chip-role", nextEv.type));
      if (nextEv && nextEv.code) meta.appendChild(el("span", "hd-code", nextEv.code));
      m.appendChild(meta);
      if (nextT) m.appendChild(el("p", "hd-shift-task", "Next task: " + (nextT.title || "Task") + (nextT.status ? " (" + nextT.status + ")" : "")));
      tk.appendChild(m);
      var id = nextEv ? nextEv.id : nextT.quote_id;
      if (id) { var go = link(evHref(id), "hd-btn hd-primary hd-sm", "Open"); go.appendChild(icon(IC.arrow)); tk.appendChild(go); }
      b.appendChild(tk);
      var stats = el("div", "hd-mini");
      [["Today", tc.today], ["Overdue", tc.overdue], ["Blocked", tc.blocked], ["Done", tc.completed]].forEach(function (x) {
        var s = el("a", "hd-mini-i" + (x[0] === "Overdue" && x[1] ? " hd-t-bad" : "")); s.href = "#mytasksSection"; s.appendChild(el("b", null, x[1] == null ? "—" : x[1])); s.appendChild(el("span", null, x[0])); stats.appendChild(s);
      });
      b.appendChild(stats);
    })();

    /* ---- S3 needs attention ---- */
    (function () {
      var b = body(cAtt), items = [];
      function add(rank, kind, title, ctx, href, act, code) { items.push({ rank: rank, kind: kind, title: title, ctx: ctx, href: href, act: act, code: code }); }
      ((tasks && tasks.overdue) || []).forEach(function (t) { add(1, "risk", (t.title || "Task") + " is overdue", [t.event_title, t.planned_end ? "due " + fmtDay(t.planned_end) : ""].filter(Boolean).join(" · "), t.quote_id ? evHref(t.quote_id) : "#mytasksSection", "Open", t.event_code); });
      if (vQuotes) rows.forEach(function (q) {
        if (q.status === "confirmed" && q.lifecycleStage !== "closed" && q.eventDate && String(q.eventDate).slice(0, 10) < today)
          add(2, "risk", qName(q) + " — settlement pending", "event was " + fmtDay(q.eventDate), "settlement.html?quote=" + encodeURIComponent(q.id), "Settle", q.code);
      });
      if (MFIN) (M.overdue || []).forEach(function (o) {
        if (!o || !o.quote_id) return;
        // client-safe: no amount on the dashboard (the Business page has it)
        add(2, "risk", "Payment overdue · " + (o.client || o.title || o.code || "Event"), [o.title && o.client ? o.title : "", "due " + fmtDay(o.due_date)].filter(Boolean).join(" · "),
          "settlement.html?quote=" + encodeURIComponent(o.quote_id), "Collect", o.code);
      });
      events.forEach(function (e) {
        if (e.date >= today && (dOf(e.date) - todayD) <= 3 * DAY && e.open > 0)
          add(3, "warn", e.name + " — " + e.open + " open task" + (e.open === 1 ? "" : "s"), e.date === today ? "Today" : fmtDay(e.date), evHref(e.id), "Review", e.code);
      });
      // 0129: confirmed events inside the studio's reminder window ("Upcoming in N days")
      var ER = window.HelmEventReminders, erWin = ER ? ER.days() : 7;
      if (ER && vQuotes) rows.forEach(function (q) {
        if (q.status !== "confirmed" || q.lifecycleStage === "closed" || !q.eventDate) return;
        var dl = ER.daysUntil(q.eventDate);
        if (dl != null && dl >= 0 && dl <= erWin) add(3, "warn", qName(q) + " — " + ER.chipText(dl).toLowerCase(), "check the checklist, staff and vendors", evHref(q.id), "Get ready", q.code);
      });
      ((tasks && tasks.blocked) || []).forEach(function (t) { add(4, "warn", (t.title || "Task") + " is blocked", t.event_title || "", t.quote_id ? evHref(t.quote_id) : "#mytasksSection", "Unblock", t.event_code); });
      if (vLeads) staleLeads.forEach(function (l) { add(5, "warn", (l.name || "Unnamed lead") + " — new lead not contacted", [l.event_type, l.event_date ? fmtDay(l.event_date) : "", "came in " + ago(l.created_at)].filter(Boolean).join(" · "), "leads.html", "Reply"); });
      if (vQuotes) rows.forEach(function (q) {
        if (q.status === "quote" && (q.approvalStatus === "sent" || q.approvalStatus === "viewed") && q.updatedAt && Date.now() - new Date(q.updatedAt).getTime() > 3 * DAY)
          add(6, "info", qName(q) + " — awaiting client", (q.approvalStatus === "viewed" ? "viewed " : "sent ") + Math.floor((Date.now() - new Date(q.updatedAt).getTime()) / DAY) + " days ago", evHref(q.id), "Follow up", q.code);
      });
      items.sort(function (a, b2) { return a.rank - b2.rank; });
      if (items.length) { var bd = pill(items[0].kind === "risk" ? "risk" : items[0].kind === "warn" ? "warn" : "info", items.length); bd.classList.add("hd-count-pill"); bd.setAttribute("aria-label", items.length + " items"); tools(cAtt).insertBefore(bd, tools(cAtt).firstChild); }
      if (!items.length) { empty(b, "All clear", null, "clear", "Nothing needs your attention right now."); return; }
      var GL = { risk: IC.alert, warn: IC.clock, info: IC.info };
      var list = el("div", "hd-att-groups"), GN = { risk: "Urgent", warn: "Soon", info: "Follow up" }, shown = 0;
      ["risk", "warn", "info"].forEach(function (k) {
        var grp = items.filter(function (x) { return x.kind === k; }); if (!grp.length || shown >= 6) return;
        var gh = el("p", "hd-att-gh hd-eyebrow hd-gh-" + k); gh.appendChild(el("span", null, GN[k])); gh.appendChild(el("span", "hd-pill hd-count-pill hd-" + k, grp.length)); list.appendChild(gh);
        var ul = el("ul", "hd-att"); list.appendChild(ul);
        grp.slice(0, 6 - shown).forEach(function (it) { shown++; addRow(ul, it); });
      });
      function addRow(ul, it) {
        var li = el("li"), a = link(it.href, "hd-att-i");
        var g = el("span", "hd-glyph hd-g-" + it.kind); g.appendChild(icon(GL[it.kind] || IC.info)); a.appendChild(g);
        var m = el("span", "hd-main"); m.appendChild(el("b", null, it.title));
        if (it.code || it.ctx) { var sm = el("small"); if (it.code) sm.appendChild(el("span", "hd-code", it.code)); if (it.ctx) sm.appendChild(document.createTextNode((it.code ? " · " : "") + it.ctx)); m.appendChild(sm); }
        a.appendChild(m);
        var ac = el("span", "hd-act-l", it.act); ac.appendChild(icon(IC.arrow)); a.appendChild(ac);
        li.appendChild(a); ul.appendChild(li);
      }
      b.appendChild(list);
      if (items.length > 6) b.appendChild(el("p", "hd-note", "+" + (items.length - 6) + " more — see My tasks, Leads and Quotes."));
    })();

    /* ---- S4 this week: agenda spine (7 days from today) ---- */
    (function () {
      var b = body(cWeek), ol = el("ol", "hd-week-list"), any = false;
      ol.setAttribute("aria-label", "Next 7 days");
      for (var k = 0; k < 7; k++) {
        var d = new Date(todayD.getTime() + k * DAY); d.setHours(0, 0, 0, 0); var ds = iso(d);
        var evs = events.filter(function (e) { return e.date === ds; }), wkEnd = d.getDay() === 0 || d.getDay() === 6;
        var li = el("li", "hd-day" + (ds === today ? " hd-today" : "") + (evs.length ? "" : " hd-free") + (wkEnd ? " hd-wkend" : ""));
        li.appendChild(el("i", "hd-node"));
        var lab = el("div", "hd-dlab"); lab.appendChild(el("small", "hd-wd hd-eyebrow", d.toLocaleDateString(undefined, { weekday: "short" }))); lab.appendChild(el("b", "hd-dn", d.getDate())); li.appendChild(lab);
        var box = el("div", "hd-devs");
        if (!evs.length) box.appendChild(el("span", "hd-free-t", "Free"));
        else {
          any = true;
          evs.slice(0, 3).forEach(function (e) {
            var st = e.q && e.q.status === "confirmed" ? "conf" : e.q && e.q.status === "quote" && (e.q.approvalStatus === "sent" || e.q.approvalStatus === "viewed" || e.q.approvalStatus === "approved") ? "tent" : "quote";
            var a = link(evHref(e.id), "hd-mini-i hd-ev-" + st);
            a.appendChild(el("b", null, e.name));
            var mt = [hhmm(e.time), e.client, e.type].filter(Boolean).join(" · "); if (mt) a.appendChild(el("small", "hd-mono", mt));
            box.appendChild(a);
          });
          if (evs.length > 3) box.appendChild(link("calendar.html", "hd-more-link", "+" + (evs.length - 3) + " more"));
        }
        li.appendChild(box); li.setAttribute("aria-label", fmtDay(ds) + ": " + (evs.length ? evs.length + (evs.length === 1 ? " event" : " events") : "free"));
        ol.appendChild(li);
      }
      var tEv = events.filter(function (e) { return e.date === today; });
      var tl = el("p", "hd-today-line");
      tl.appendChild(el("b", null, "Today"));
      tl.appendChild(document.createTextNode(tEv.length ? " · " + tEv.length + (tEv.length === 1 ? " event" : " events") + (tc.today ? ", " + tc.today + (tc.today === 1 ? " task" : " tasks") + " due" : "") : tc.today ? " · " + tc.today + (tc.today === 1 ? " task" : " tasks") + " due" : " · a clear day"));
      b.appendChild(tl);
      b.appendChild(ol);
      if (!any) b.appendChild(el("p", "hd-note", "No events in the next 7 days. New bookings will show here."));
      ol.addEventListener("keydown", function (ev) {                          // arrow keys move between agenda chips
        if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp" && ev.key !== "Home" && ev.key !== "End") return;
        var ls = [].slice.call(ol.querySelectorAll("a")), i = ls.indexOf(document.activeElement); if (i < 0 || !ls.length) return;
        ev.preventDefault();
        var j = ev.key === "Home" ? 0 : ev.key === "End" ? ls.length - 1 : Math.max(0, Math.min(ls.length - 1, i + (ev.key === "ArrowDown" ? 1 : -1)));
        ls[j].focus();
      });
    })();

    /* ---- S5 revenue (finance roles only): booked in the last 12 months by confirmation month.
       Every amount is [data-money] (HelmMoney.money / mny) so privacy mode masks it behind the PIN. ---- */
    function HM() { return window.HelmMoney || null; }
    function mny(n) { var h = HM(); if (h && h.money) return h.money(n); n.setAttribute("data-money", ""); return n; }
    function cmpM(n) { var h = HM(); return h && h.compact ? h.compact(n) : CUR + " " + num(n); }
    if (isMoney && vQuotes && !signedOut && !isCrew) canView("finance").then(function (fin) {
      if (!fin) return;
      try { if (HM() && HM().setCurrency) HM().setCurrency(CUR); } catch (e) {}
      var booked = M ? M.months.slice(-12).map(function (m) { return mN(m.booked); })
        : monthSeries(curRows.filter(function (q) { return q.status === "confirmed"; }), function (q) { return q.confirmedAt || q.eventDate || q.updatedAt; }, function (q) { return Number(q.total) || 0; }, 12);
      while (booked.length < 12) booked.unshift(0);
      var collected = MFIN ? M.months.slice(-12).map(function (m) { return mN(m.collected); }) : null;
      if (collected) while (collected.length < 12) collected.unshift(0);
      cRev.hidden = false; var b = body(cRev);
      var tot = booked.reduce(function (x, v) { return x + v; }, 0), totC = collected ? collected.reduce(function (x, v) { return x + v; }, 0) : 0;
      var hd = el("div", "hd-rv-head"), big = mny(el("b", "hd-rv-total")); countUp(big, tot, cmpM); hd.appendChild(big);
      hd.appendChild(el("span", "hd-rv-muted", "booked in the last 12 months"));
      if (collected) { var cc = el("span", "hd-rv-muted"); cc.appendChild(document.createTextNode("· ")); cc.appendChild(mny(el("span", null, cmpM(totC)))); cc.appendChild(document.createTextNode(" collected")); hd.appendChild(cc); }
      b.appendChild(hd);
      if (collected) {
        var lg = el("div", "hd-rv-legend");
        [["hd-rv-lg-b", "Booked"], ["hd-rv-lg-c", "Collected"]].forEach(function (x) { var it = el("span", "hd-rv-lg-i"); it.appendChild(el("i", x[0])); it.appendChild(document.createTextNode(x[1])); lg.appendChild(it); });
        b.appendChild(lg);
      }
      if (HM() && HM().revenueBars) b.appendChild(HM().revenueBars(booked, collected, now, "hd-rv-"));
      // QA: "no confirmed quotes" vs "confirmed quotes with no price / confirmed earlier" (0108 pipeline counts when present)
      var nConf = MP && MP.confirmed && MP.closed ? mN(MP.confirmed.count) + mN(MP.closed.count) : rows.filter(function (q) { return q.status === "confirmed"; }).length;
      if (!tot) b.appendChild(el("p", "hd-note", nConf ? "Your confirmed events add no booked value in the last 12 months yet \u2014 check that their quotes have a price." : "Revenue appears once your first quote is confirmed."));
      b.appendChild(el("p", "hd-caption", (M ? "Exact numbers from your payment ledger. " : "Estimated from your latest quotes. ") + "Booked = confirmed value (" + CUR + ") by confirmation month." + (collected ? " Collected = payments recorded." : "")));
    });

    /* ---- S4b "Your month": month grid + selected day's events (real events, by date) ---- */
    if (!cCal.classList.contains("hd-off") && !signedOut) (function () {
      var b = body(cCal), wrapC = el("div", "hd-calwrap"), calBox = el("div", "hd-cal"), agenda = el("div", "hd-agenda");
      agenda.setAttribute("aria-live", "polite");
      var view = new Date(todayD.getFullYear(), todayD.getMonth(), 1), sel = today;
      var navH = el("div", "hd-cal-nav"), title = el("b", "hd-cal-title");
      var prev = el("button", "hd-cal-btn"); prev.type = "button"; prev.setAttribute("aria-label", "Previous month"); prev.appendChild(icon("M15 6l-6 6 6 6"));
      var next = el("button", "hd-cal-btn"); next.type = "button"; next.setAttribute("aria-label", "Next month"); next.appendChild(icon("M9 6l6 6-6 6"));
      navH.appendChild(prev); navH.appendChild(title); navH.appendChild(next);
      var gridC = el("div", "hd-cal-grid"); gridC.setAttribute("role", "grid");
      calBox.appendChild(navH); calBox.appendChild(gridC);
      var byDay = {}; events.forEach(function (e) { (byDay[e.date] = byDay[e.date] || []).push(e); });
      var chipM = pill("info", ""); chipM.classList.add("hd-count-pill"); tools(cCal).insertBefore(chipM, tools(cCal).firstChild);
      function stKey(e) { return e.q && e.q.status === "confirmed" ? "conf" : "quote"; }
      function showDay(ds) {
        sel = ds; clear(agenda);
        Array.prototype.forEach.call(gridC.querySelectorAll(".hd-cd"), function (x) { var on = x.getAttribute("data-ds") === ds; x.classList.toggle("hd-sel", on); x.setAttribute("aria-selected", String(on)); });
        var d = dOf(ds), hd = el("div", "hd-ag-head");
        hd.appendChild(el("small", "hd-eyebrow", ds === today ? "Today" : d.toLocaleDateString(undefined, { weekday: "long" })));
        hd.appendChild(el("b", null, d.toLocaleDateString(undefined, { day: "numeric", month: "long" })));
        agenda.appendChild(hd);
        var evs = byDay[ds] || [];
        if (!evs.length) { var e0 = el("div", "hd-ag-empty"); e0.appendChild(icon(IC.cal)); e0.appendChild(el("span", null, "A free day, nothing booked.")); agenda.appendChild(e0); return; }
        evs.forEach(function (e) {
          var a = link(evHref(e.id), "hd-ag-row hd-ag-" + stKey(e));
          a.appendChild(el("i", "hd-ag-bar"));
          var m = el("div", "hd-main"); m.appendChild(el("b", null, e.name)); var mt = [hhmm(e.time), e.type, e.client, e.code].filter(Boolean).join(" · "); if (mt) m.appendChild(el("small", null, mt)); a.appendChild(m);
          if (e.q && e.q.status) a.appendChild(statusPill(e.q));
          agenda.appendChild(a);
        });
      }
      function render() {
        clear(gridC);
        title.textContent = view.toLocaleDateString(undefined, { month: "long", year: "numeric" });
        var pre = iso(view).slice(0, 7), nM = events.filter(function (e) { return e.date.slice(0, 7) === pre; }).length;
        chipM.textContent = nM + (nM === 1 ? " event" : " events") + " this month";
        var mon = new Date(2024, 0, 1); for (var w = 0; w < 7; w++) { var hdc = el("span", "hd-cal-wd", new Date(mon.getTime() + w * DAY).toLocaleDateString(undefined, { weekday: "narrow" })); hdc.setAttribute("aria-hidden", "true"); gridC.appendChild(hdc); }
        var lead = (view.getDay() + 6) % 7, dim = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
        for (var k = 0; k < lead; k++) gridC.appendChild(el("span", "hd-cd-pad"));
        for (var dd = 1; dd <= dim; dd++) {
          var dt = new Date(view.getFullYear(), view.getMonth(), dd), ds = iso(dt), evs = byDay[ds] || [];
          var bt = el("button", "hd-cd" + (ds === today ? " hd-cd-today" : "") + (ds < today ? " hd-cd-past" : "") + (evs.length ? " hd-cd-has" : ""));
          if (evs.length) bt.title = evs.slice(0, 4).map(function (e) { return e.name; }).join("\n") + (evs.length > 4 ? "\n+" + (evs.length - 4) + " more" : "");
          bt.type = "button"; bt.setAttribute("data-ds", ds); bt.setAttribute("role", "gridcell");
          if (ds === today) bt.setAttribute("aria-current", "date");
          bt.setAttribute("aria-label", fmtDay(ds) + ": " + evs.length + (evs.length === 1 ? " event" : " events"));
          bt.appendChild(el("span", "hd-cd-n", dd));
          var dots = el("span", "hd-cd-dots"); evs.slice(0, 3).forEach(function (e) { dots.appendChild(el("i", "hd-cd-" + stKey(e))); }); if (evs.length > 3) dots.appendChild(el("em", "hd-cd-more", "+" + (evs.length - 3))); bt.appendChild(dots);
          (function (x) { bt.addEventListener("click", function () { showDay(x); }); })(ds);
          gridC.appendChild(bt);
        }
        var c = gridC.querySelector('[data-ds="' + sel + '"]'); if (c) { c.classList.add("hd-sel"); c.setAttribute("aria-selected", "true"); }
      }
      function goM(delta) {                                                   // panel follows the month: today, else its first event day, else the 1st
        view = new Date(view.getFullYear(), view.getMonth() + delta, 1); var pre = iso(view).slice(0, 7);
        var pick = today.slice(0, 7) === pre ? today : null;
        if (!pick) for (var k = 0; k < events.length; k++) if (events[k].date.slice(0, 7) === pre) { pick = events[k].date; break; }
        sel = pick || iso(view); render(); showDay(sel);
      }
      prev.addEventListener("click", function () { goM(-1); });
      next.addEventListener("click", function () { goM(1); });
      wrapC.appendChild(calBox); wrapC.appendChild(agenda); b.appendChild(wrapC);
      render(); showDay(today);
    })();

    /* ---- follow-ups: stale leads + quotes waiting on the client ---- */
    if (!cFol.hidden && !signedOut) (function () {
      var b = body(cFol), items = [];
      if (vLeads) staleLeads.forEach(function (l) { items.push({ age: Date.now() - new Date(l.created_at).getTime(), who: l.name || "Unnamed lead", what: "New enquiry, not contacted", ctx: [l.event_type, l.event_date ? fmtDay(l.event_date) : "", "came in " + ago(l.created_at)].filter(Boolean).join(" · "), href: "leads.html", act: "Reply" }); });
      if (vQuotes) rows.forEach(function (q) {
        if (q.status === "quote" && (q.approvalStatus === "sent" || q.approvalStatus === "viewed") && q.updatedAt && Date.now() - new Date(q.updatedAt).getTime() > 3 * DAY)
          items.push({ age: Date.now() - new Date(q.updatedAt).getTime(), who: qName(q), what: "Quote " + (q.approvalStatus === "viewed" ? "viewed" : "sent") + ", no reply", ctx: [q.code, "for " + Math.floor((Date.now() - new Date(q.updatedAt).getTime()) / DAY) + " days"].filter(Boolean).join(" · "), href: evHref(q.id), act: "Follow up" });
      });
      items.sort(function (a, c) { return c.age - a.age; });
      if (items.length) { var bd = pill("warn", String(items.length)); bd.classList.add("hd-count-pill"); tools(cFol).insertBefore(bd, tools(cFol).firstChild); }
      if (!items.length) { empty(b, "No one is waiting on you", vLeads ? link("leads.html", "hd-btn hd-ghost", "Open leads") : null, "clear", "Every enquiry and sent quote is moving."); return; }
      var ul = el("ul", "hd-feed hd-fol");
      items.slice(0, 5).forEach(function (it) {
        var li = el("li", "hd-act hd-fol-i");
        var ini = String(it.who).split(/\s+/).filter(Boolean).slice(0, 2).map(function (x) { return x.charAt(0).toUpperCase(); }).join("") || "•";
        li.appendChild(el("span", "hd-av", ini));
        var m = el("div", "hd-main"); m.appendChild(el("b", null, it.who)); m.appendChild(el("small", null, it.what + (it.ctx ? " · " + it.ctx : ""))); li.appendChild(m);
        li.appendChild(link(it.href, "hd-btn hd-ghost hd-sm", it.act)); ul.appendChild(li);
      });
      b.appendChild(ul);
      if (items.length > 5) b.appendChild(el("p", "hd-note", "+" + (items.length - 5) + " more waiting."));
      if (vLeads) { var ol = link("leads.html", "hd-btn hd-ghost hd-sm", "Open leads"); ol.appendChild(icon(IC.arrow)); b.appendChild(ol); }
    })();

    /* ---- desk notes (private to this user: own row in user_dashboard_prefs, 0109; RLS = own row only).
       Fallback when 0109 isn't applied: this device only. The local copy is kept as a backup and is
       only cleared after the server confirms an empty save; existing local notes are copied up once
       when the server copy is empty. ---- */
    if (!cNotes.classList.contains("hd-off")) (function () {
      function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
      function lsSet(k, v) { try { if (v == null || v === "") localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
      var uid = (user && (user.id || user.email)) || "local";
      var b = body(cNotes), key = "helm.dash3.notes." + uid;                // same key as Demo 3, so notes carry over
      var ta = el("textarea", "hd-notes"); ta.id = "hdNotesTa"; ta.rows = 6; ta.maxLength = 2000; ta.placeholder = "Jot a reminder, a vendor's number, an idea for Saturday…";
      var lb = el("label", "hd-sr", "Desk notes"); lb.htmlFor = ta.id;
      var local = lsGet(key) || ""; ta.value = local;
      var st = el("p", "hd-caption", "Private to you."); st.setAttribute("aria-live", "polite");
      var tm = null, server = false, dirty = false, seq = 0;
      function hhmm() { return new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }); }
      function push(v) {
        var D = S().dashboard, my = ++seq;
        if (!server || !D || !D.saveNotes) { lsSet(key, v.trim() ? v : ""); st.textContent = "Saved on this device · " + hhmm(); return Promise.resolve(); }
        if (v.trim()) lsSet(key, v);                                         // backup first; never cleared before the server confirms
        st.textContent = "Saving…";
        return D.saveNotes(v.trim() ? v : "").then(function (r) {
          if (my !== seq) return;
          if (r === true) { if (!v.trim()) lsSet(key, ""); st.textContent = "Saved to your account · " + hhmm(); }
          else if (r === null) { server = false; lsSet(key, v.trim() ? v : ""); st.textContent = "Saved on this device · " + hhmm(); }
          else st.textContent = "Not saved to your account - kept on this device. Keep typing to retry.";
        });
      }
      function flush() { if (tm) { clearTimeout(tm); tm = null; push(ta.value); } }
      ta.addEventListener("input", function () { dirty = true; clearTimeout(tm); tm = setTimeout(function () { tm = null; push(ta.value); }, 800); });
      document.addEventListener("visibilitychange", function () { if (document.hidden) flush(); });
      window.addEventListener("pagehide", flush);
      prefsP.then(function (p) {
        if (!p) { if (!dirty) st.textContent = "Private to you, saved on this device only."; return; }
        server = true;
        var srv = typeof p.desk_notes === "string" ? p.desk_notes : "";
        if (srv) { if (!dirty) { ta.value = srv; st.textContent = "Private to you, saved to your account."; } }
        else if (local.trim() && !dirty) push(local).then(function () { if (/Saved to your account/.test(st.textContent)) st.textContent = "Your notes from this device are now saved to your account."; });
        else if (!dirty) st.textContent = "Private to you, saved to your account.";
      });
      b.appendChild(lb); b.appendChild(ta); b.appendChild(st);
    })();
    /* ---- S6 pipeline funnel (counts only) ---- */
    if (!cPipe.hidden) (function () {
      var b = body(cPipe);
      var quoted = rows.filter(function (q) { return q.status === "quote"; }), confd = rows.filter(function (q) { return q.status === "confirmed" && q.lifecycleStage !== "closed"; }),
          done = rows.filter(function (q) { return q.status === "confirmed" && q.lifecycleStage === "closed"; });
      var stages = [];
      if (vLeads) stages.push({ l: "Leads", n: mOpenLeads != null ? mOpenLeads : openLeads.length, href: "leads.html" });
      var po = mStage("open"), ps = mStage("sent"), pc = mStage("confirmed"), pd = mStage("closed");
      if (vQuotes && po && ps && pc && pd) stages.push({ l: "Quoted", n: po.n + ps.n, href: "quotes.html" },
        { l: "Confirmed", n: pc.n, href: "quotes.html" }, { l: "Completed", n: pd.n, href: "quotes.html" });
      else if (vQuotes) stages.push({ l: "Quoted", n: counts && typeof counts.quote === "number" ? counts.quote : quoted.length, href: "quotes.html" },
        { l: "Confirmed", n: confd.length, href: "quotes.html" }, { l: "Completed", n: done.length, href: "quotes.html" });
      var exact = !!(MP && po);
      var tot = stages.reduce(function (s, x) { return s + x.n; }, 0);
      if (!tot) { var cta = vLeads && eLeads ? link("leads.html", "hd-btn hd-ghost", "Add a lead") : null; empty(b, "No pipeline yet", cta, "pipe", "Add your first lead to start your pipeline."); return; }
      var mx = Math.max.apply(null, stages.map(function (x) { return x.n; })) || 1;
      var seg = el("div", "hd-seg"); seg.setAttribute("aria-hidden", "true");
      stages.forEach(function (st, i) { if (st.n > 0) seg.appendChild(el("i", "hd-bs" + Math.min(3, i + (4 - stages.length)) + " " + wcls(st.n / tot))); });
      b.appendChild(seg);
      var chips = el("div", "hd-seg-chips");
      stages.forEach(function (st, i) { var c = link(st.href, "hd-seg-chip"); c.appendChild(el("i", "hd-bs" + Math.min(3, i + (4 - stages.length)))); c.appendChild(el("span", null, st.l)); c.appendChild(el("b", null, num(st.n))); chips.appendChild(c); });
      b.appendChild(chips);
      var list = el("div", "hd-funnel");
      stages.forEach(function (st, i) {
        if (i) {
          // share of everything that reached the previous stage that went further; an empty previous
          // stage (e.g. 0 leads) has no base, so it shows a dash instead of a fake 100%
          var nextN = 0; for (var j = i; j < stages.length; j++) nextN += Math.max(0, Number(stages[j].n) || 0);
          var prevN = Math.max(0, Number(stages[i - 1].n) || 0) > 0 ? Math.max(0, Number(stages[i - 1].n) || 0) + nextN : 0;
          var conv = prevN > 0 ? Math.min(100, Math.round(100 * nextN / prevN)) : null;
          list.appendChild(el("div", "hd-conv", conv == null || !isFinite(conv) ? "↓ —" : "↓ " + conv + "% move on")); }
        var a = link(st.href, "hd-stage");
        var top = el("div", "hd-stage-top"); top.appendChild(el("span", null, st.l)); top.appendChild(el("b", null, num(st.n))); a.appendChild(top);
        var bar = el("span", "hd-bar"); bar.appendChild(el("i", "hd-bar-fg hd-bs" + Math.min(3, i + (4 - stages.length)) + " " + wcls(st.n / mx))); a.appendChild(bar);
        a.setAttribute("aria-label", st.l + ": " + num(st.n));
        list.appendChild(a);
      });
      b.appendChild(list);
      b.appendChild(el("p", "hd-caption", "Share of each stage that has moved past the previous one" + (!exact && pageRes && pageRes.hasMore ? "; counts from the 500 most recent quotes." : ".")));
    })();

    /* ---- S7 upcoming events (30 days): ticket cards ---- */
    (function () {
      var b = body(cUp), list = future.filter(function (e) { return e.date <= in30; });
      if (!list.length) {
        if (signedOut) { var si = el("button", "hd-btn hd-primary"); si.type = "button"; si.appendChild(el("span", null, "Sign in")); si.addEventListener("click", function () { signIn.click(); }); empty(b, "Sign in to see your events", si, "events", "Your studio's events, tasks and quotes appear here once you sign in."); }
        else empty(b, "Nothing coming up in the next 30 days", null, "events", "Confirmed and quoted events will line up here.");
        return;
      }
      var ul = el("ul", "hd-tickets");
      list.slice(0, 5).forEach(function (e) {
        var li = el("li"), a = link(evHref(e.id), "hd-ticket hd-trow" + (e.date === today ? " hd-tk-today" : ""));
        a.appendChild(stub(e.date));
        var m = el("div", "hd-tk-body"); m.appendChild(el("b", "hd-tk-name", e.name));
        var meta = el("p", "hd-tk-meta"), da = daysAway(e.date);
        if (e.client) meta.appendChild(metaI(IC.user, e.client));
        if (e.type) meta.appendChild(metaI(IC.ticket, e.type));
        if (hhmm(e.time)) meta.appendChild(metaI(IC.clock, hhmm(e.time), "hd-mono"));
        if (da != null) meta.appendChild(el("span", "hd-away" + (da <= 2 ? " hd-away-soon" : ""), da === 0 ? "Today" : da === 1 ? "Tomorrow" : "In " + da + " days"));
        m.appendChild(meta); a.appendChild(m);
        var r = el("div", "hd-tk-end"); if (e.q && e.q.status) r.appendChild(statusPill(e.q));
        if (e.hasTasks && e.open + e.done > 0) r.appendChild(ring(e.done, e.open + e.done));
        r.appendChild(icon(IC.chev, "hd-ic hd-chev")); a.appendChild(r);
        li.appendChild(a); ul.appendChild(li);
      });
      b.appendChild(ul);
      if (list.length > 5) b.appendChild(el("p", "hd-note", "+" + (list.length - 5) + " more in the next 30 days."));
    })();

    /* ---- S8 activity feed (audit log) ----
       Live, not a snapshot: the list is re-read (cheap, 12 rows) when the tab comes back
       into view, when the page is restored from the back/forward cache, and every 60s
       while visible; the relative times re-render each time. Before this the card was
       painted once at load, so a dashboard left open (or restored with Back) kept its
       first list and its frozen "14m ago" labels while the Audit log page was current. */
    if (!cAct.hidden) (function () {
      var lastSig = "", lastRows = null, busy = false, tmr = null;
      function paintAct(rowsA) {
        if (!rowsA) { if (lastRows === null) cAct.hidden = true; return; }
        lastRows = rowsA;
        var b = body(cAct);
        if (!rowsA.length) { empty(b, "No activity yet", null, "pulse", "Changes made by your team will appear here."); return; }
        var ul = el("ul", "hd-feed");
        rowsA.slice(0, 8).forEach(function (r) {
          var li = el("li", "hd-act");
          var who = String(r.actor_name || r.actor_email || "System"), ini = who.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(function (x) { return x.charAt(0).toUpperCase(); }).join("") || "\u2022";
          li.appendChild(el("span", "hd-av", ini));
          var m = el("p", "hd-act-t"), ch = r.changed && typeof r.changed === "object" ? r.changed : {};
          var lbl = ""; try { lbl = S().audit.actionLabel ? S().audit.actionLabel(r.action) : r.action; } catch (e) { lbl = r.action; }
          var obj = [String(r.entity || "").replace(/_/g, " "), ch.code || ch.title || ch.name || ""].filter(Boolean).join(" ");
          m.appendChild(el("b", null, who.replace(/@.*/, ""))); m.appendChild(document.createTextNode(" " + String(lbl || "").toLowerCase() + " "));
          if (obj) m.appendChild(el("em", null, obj));
          var t = el("time", "hd-ago", ago(r.at)); try { t.setAttribute("datetime", new Date(r.at).toISOString()); } catch (e) {}
          li.appendChild(m); li.appendChild(t);
          ul.appendChild(li);
        });
        b.appendChild(ul);
      }
      function sigOf(rows) { return (rows || []).slice(0, 8).map(function (r) { return r.id + "@" + r.at; }).join("|"); }
      function retick() { [].forEach.call(cAct.querySelectorAll("time.hd-ago[datetime]"), function (t) { var x = ago(t.getAttribute("datetime")); if (t.textContent !== x) t.textContent = x; }); }
      function refresh(force) {
        if (busy || (document.hidden && force !== true) || !document.body.contains(cAct)) return;
        busy = true;
        Promise.resolve().then(function () { return S().audit.list({ limit: 12 }); }).then(function (rows) {
          busy = false; var sg = sigOf(rows); if (sg !== lastSig) { lastSig = sg; paintAct(rows); } else retick();
        }, function () { busy = false; retick(); });
      }
      function arm() { clearInterval(tmr); tmr = setInterval(refresh, 60000); }
      P.audit.then(function (rowsA) { lastSig = sigOf(rowsA); paintAct(rowsA); arm(); });
      document.addEventListener("visibilitychange", function () { if (document.hidden) clearInterval(tmr); else { refresh(); arm(); } });
      window.addEventListener("pageshow", function (ev) { if (ev.persisted) { refresh(true); arm(); } });   /* Back/Forward restore: always re-read */
      window.addEventListener("focus", function () { refresh(); });
    })();
    root.classList.add("hd-ready");
  }

  function go() { build().catch(function () {}); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
})();
