/* share-checklist.js — "Share with client" checklist (flow.html card + the Share booklet dialog, 0069).
   The studio picks which booklet sections the client sees; the server filters the booklet to
   exactly these (contract: sections = {studio, client, venue, menu, layout2d, layout3d, quotation,
   payments, terms}). 0083: the 2D / 3D sections show the builder's real pictures, stored in the
   database in two styles — "With labels" (numbered badges + legend) and "Without labels" — and the
   studio picks which styles the client sees (default both). These pages have no 3D scene, so they
   use the newest pictures from the builder. R8b: ZERO manual picture-taking — when a ticked picture
   is missing or older than the latest layout, Create/Update link renders them automatically in a
   hidden same-origin capture host (capture.html, the only page that may be framed, by 'self'),
   which uploads them and reports back by postMessage (origin + source + quote id are checked).
   DOM via createElement / textContent / setAttribute only. */
(function (global) {
  "use strict";
  const doc = global.document;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SECTIONS = [["studio", "Studio details"], ["client", "Client details"], ["venue", "Venue details"], ["menu", "Menu / packages"],
    ["layout2d", "2D floor plan screenshot"], ["layout3d", "3D view screenshot"], ["quotation", "Quotation breakdown"],
    ["payments", "Payment breakdown"], ["terms", "Terms"]];
  const DAYS = [7, 14, 30, 60, 90, 180];
  const MAX_W = 1600;

  /* ---- pure helpers (exported for tests) ---- */
  function normalize(s) {
    const src = s && typeof s === "object" ? s : null, out = {};
    SECTIONS.forEach((x) => { out[x[0]] = src ? src[x[0]] === true : true; });
    return out;
  }
  function menuRule(hasPackage) {
    return hasPackage ? "Client will see your selected package" : "Client will choose from all packages and you'll be notified";
  }
  function preview(sections, hasPackage) {
    const s = normalize(sections), out = ["Event title and date"];
    SECTIONS.forEach((x) => {
      if (!s[x[0]]) return;
      out.push(x[0] === "menu" ? "Menu — " + menuRule(hasPackage).replace(/^Client will /, "").replace(/^./, (c) => c.toUpperCase()) : x[1].replace(/ screenshot$/, ""));
    });
    return out;
  }
  function fitSize(w, h, max) { max = max || MAX_W; w = Math.max(1, Number(w) || 1); h = Math.max(1, Number(h) || 1); if (w <= max) return { w: Math.round(w), h: Math.round(h) }; return { w: max, h: Math.round(h * max / w) }; }
  // a stored image is usable when it was written at/after the newest saved layout version
  function freshEnough(updatedAt, versions) {
    const t = Date.parse(updatedAt || ""); if (!isFinite(t)) return false;
    let latest = 0; (versions || []).forEach((v) => { const x = Date.parse((v && (v.createdAt || v.created_at)) || ""); if (isFinite(x) && x > latest) latest = x; });
    return t >= latest;
  }
  // R8: accept the 0083 nested shape {"2d":{labels:iso,plain:iso}} and a flat {"2d_labels":iso} / {"2d":iso} shape
  function normInfo(info) {
    const out = { "2d": {}, "3d": {} }; if (!info || typeof info !== "object") return out;
    ["2d", "3d"].forEach((k) => {
      const x = info[k];
      if (x && typeof x === "object") ["labels", "plain"].forEach((v) => { if (x[v]) out[k][v] = String(x[v]); });
      else if (typeof x === "string" && x) out[k].labels = x;
      ["labels", "plain"].forEach((v) => { const f = info[k + "_" + v]; if (f && !out[k][v]) out[k][v] = String(f); });
    });
    return out;
  }
  // R8: per kind / style: 'missing' (never captured), 'stale' (older than the newest layout version), 'ok'
  function imageStatus(info, versions) {
    const n = normInfo(info), out = {};
    ["2d", "3d"].forEach((k) => { out[k] = {}; ["labels", "plain"].forEach((v) => {
      const t = n[k][v]; out[k][v] = !t ? "missing" : (freshEnough(t, versions) ? "ok" : "stale"); }); });
    return out;
  }
  function quoteIdFor(n) {
    const q = n && n.getAttribute("data-quote");
    if (q && UUID_RE.test(q)) return q;
    const p = new URLSearchParams(global.location.search); const id = p.get("quote") || p.get("id");
    return id && UUID_RE.test(id) ? id : null;
  }

  /* ---- DOM ---- */
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function btn(cls, text) { const b = el("button", cls, text); b.type = "button"; return b; }
  function toast(msg, type) { try { if (global.BPUI && global.BPUI.toast) global.BPUI.toast(msg, { type: type || "ok" }); } catch (e) {} }
  function errText(e) { try { if (global.BPUI && global.BPUI.friendlyError) return global.BPUI.friendlyError(e, { action: "share the booklet" }); } catch (x) {} return String((e && e.message) || "Something went wrong"); }
  function when(t) { const d = new Date(t); if (!t || isNaN(d.getTime())) return ""; try { return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); } catch (e) { return d.toISOString().slice(0, 10); } }

  async function hasSelectedPackage(quoteId) {
    try { const p = global.BPStore.plan && await global.BPStore.plan.get(quoteId); return !!(p && (p.menu_template || p.package)); } catch (e) { return false; }
  }
  // 0083: the pictures come from the builder ("Update client images" / auto-capture), stored in the
  // database in two styles. kind '2d' | '3d', variant 'labels' | 'plain'.
  const STYLES = [["labels", "With labels"], ["plain", "Without labels"]];
  function variantsFor(state, k) { const v = state.variants[k] || {}; return STYLES.filter((x) => v[x[0]] !== false).map((x) => x[0]); }
  // what is missing for the share: [{section, kind, variant}] for every ticked section + style without a stored picture
  function missingImages(sections, variants, info) {
    const out = []; info = normInfo(info);
    [["layout2d", "2d"], ["layout3d", "3d"]].forEach((x) => {
      if (!sections || sections[x[0]] !== true) return;
      const v = (variants && variants[x[0]]) || {};
      STYLES.forEach((st) => { if (v[st[0]] !== false && !(info[x[1]] && info[x[1]][st[0]])) out.push({ section: x[0], kind: x[1], variant: st[0] }); });
    });
    return out;
  }
  // server style flags for the link: { "2d_labels": bool, ... }
  function variantFlags(variants) {
    const o = {}; [["layout2d", "2d"], ["layout3d", "3d"]].forEach((x) => { const v = (variants && variants[x[0]]) || {};
      STYLES.forEach((st) => { o[x[1] + "_" + st[0]] = v[st[0]] !== false; }); });
    return o;
  }
  /* ---- R8b: offscreen capture host protocol ---- */
  const CAPTURE_TIMEOUT_MS = 60000;
  function captureUrl(quoteId) { return "capture.html?quote=" + encodeURIComponent(String(quoteId || "")); }
  // a message from the capture host is trusted only when it is same-origin, from OUR iframe, for OUR quote
  function acceptCaptureMessage(ev, o) {
    if (!ev || !o || ev.origin !== o.origin) return null;
    if (o.source && ev.source !== o.source) return null;
    const d = ev.data;
    if (!d || typeof d !== "object" || (d.type !== "helm-capture-done" && d.type !== "helm-capture-progress")) return null;
    if (!o.quoteId || d.quoteId !== o.quoteId) return null;
    return d;
  }
  // kinds ('2d' / '3d') whose ticked pictures are missing or older than the latest layout
  function needsCapture(sections, variants, info, stale) {
    const out = [], miss = missingImages(sections, variants, info);
    [["layout2d", "2d"], ["layout3d", "3d"]].forEach((x) => {
      if (!sections || sections[x[0]] !== true) return;
      if (miss.some((m) => m.kind === x[1]) || (stale && stale[x[1]])) out.push(x[1]);
    });
    return out;
  }
  // render + upload the pictures in a hidden capture host; resolves { ok, empty, results } or rejects (timeout / failure)
  function autoCapture(quoteId, o) {
    o = o || {};
    const win = o.win || global, d = o.doc || doc, ms = o.timeoutMs || CAPTURE_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (!quoteId || !UUID_RE.test(quoteId) || !d) { reject(new Error("Save the event first.")); return; }
      const fr = d.createElement("iframe");
      fr.setAttribute("title", "Preparing client pictures"); fr.setAttribute("aria-hidden", "true"); fr.setAttribute("tabindex", "-1");
      fr.setAttribute("style", "position:fixed;left:-12000px;top:0;width:1400px;height:900px;border:0;opacity:0;pointer-events:none");
      let done = false, timer = null;
      const finish = (err, val) => {
        if (done) return; done = true; clearTimeout(timer);
        try { win.removeEventListener("message", onMsg); } catch (e) {}
        try { if (fr.parentNode) fr.parentNode.removeChild(fr); } catch (e) {}
        if (err) reject(err); else resolve(val);
      };
      function onMsg(ev) {
        const m = acceptCaptureMessage(ev, { origin: win.location.origin, source: fr.contentWindow, quoteId: quoteId });
        if (!m) return;
        if (m.type === "helm-capture-progress") { try { if (o.onProgress) o.onProgress(m.step); } catch (e) {} return; }
        if (m.error && !m.empty) finish(new Error(String(m.error).slice(0, 200)));
        else finish(null, { ok: !!m.ok, empty: !!m.empty, results: m.results || {} });
      }
      win.addEventListener("message", onMsg);
      timer = setTimeout(() => finish(Object.assign(new Error("Preparing the pictures took longer than 60 seconds."), { timeout: true })), ms);
      fr.setAttribute("src", captureUrl(quoteId));
      (d.body || d.documentElement).appendChild(fr);
    });
  }
  function builderUrl(quoteId) {
    try { if (global.HelmUrl && global.HelmUrl.build) return global.HelmUrl.build("floor-plan", { id: quoteId }); } catch (e) {}
    return "builder.html?quote=" + encodeURIComponent(quoteId);
  }

  /* mount(host, { quoteId, cur, embedded }) → { sections(), variants(), uploadSnapshots(), attachSnapshots() }
     embedded = inside the Share booklet dialog (the dialog owns note / days / submit). */
  function mount(host, o) {
    o = o || {};
    const quoteId = o.quoteId, cur = o.cur || null;
    const iv = cur && cur.image_variants && typeof cur.image_variants === "object" ? cur.image_variants : {};
    const state = { sections: normalize(cur && cur.sections), hasPkg: false, info: null, previews: {},
      variants: { layout2d: { labels: iv["2d_labels"] !== false, plain: iv["2d_plain"] !== false },
                  layout3d: { labels: iv["3d_labels"] !== false, plain: iv["3d_plain"] !== false } } };
    const wrap = el("div", "sc-wrap");
    const fs = el("fieldset", "sc-fs"); fs.appendChild(el("legend", "sc-lab", "What the client will see"));
    const list = el("div", "sc-list"); fs.appendChild(list); wrap.appendChild(fs);
    const rule = el("p", "sc-rule"); rule.setAttribute("aria-live", "polite");
    const thumbs = el("div", "sc-thumbs");
    const pv = el("div", "sc-preview"); pv.appendChild(el("p", "sc-lab", "Client will see"));
    const pvl = el("ul", "sc-pvl"); pvl.setAttribute("aria-live", "polite"); pv.appendChild(pvl);
    const sfx = o.embedded ? "_d" : "";
    SECTIONS.forEach((x) => {
      const id = "sc_" + x[0] + sfx;
      const lab = el("label", "sc-item"); lab.setAttribute("for", id);
      const cb = el("input"); cb.type = "checkbox"; cb.id = id; cb.setAttribute("role", "switch"); cb.checked = state.sections[x[0]]; cb.setAttribute("data-sec", x[0]);
      cb.addEventListener("change", () => { state.sections[x[0]] = cb.checked; refresh(); });
      lab.appendChild(cb); lab.appendChild(el("span", "", x[1].replace(/ screenshot$/, ""))); list.appendChild(lab);
      if (x[0] === "menu") list.appendChild(rule);
    });
    const prog = el("p", "sc-meta sc-prog"); prog.setAttribute("aria-live", "polite"); prog.hidden = true;
    wrap.appendChild(thumbs); wrap.appendChild(prog); wrap.appendChild(pv);

    function thumb(k) {
      const kind = k === "layout2d" ? "2d" : "3d", name = kind === "2d" ? "2D floor plan" : "3D view";
      const box = el("figure", "sc-thumb"); box.setAttribute("data-kind", kind);
      const vs = variantsFor(state, k), info = state.info;
      const first = vs[0] || "labels", url = state.previews[kind + "_" + first];
      if (url) { const img = el("img"); img.setAttribute("src", url); img.setAttribute("alt", name + (first === "plain" ? " without labels" : " with labels")); box.appendChild(img); }
      const tg = el("div", "sc-styles"); tg.setAttribute("role", "group"); tg.setAttribute("aria-label", name + " picture styles");
      STYLES.forEach((st) => {
        const id = "sc_" + kind + "_" + st[0] + sfx, lab = el("label", "sc-style"); lab.setAttribute("for", id);
        const cb = el("input"); cb.type = "checkbox"; cb.id = id; cb.checked = state.variants[k][st[0]] !== false; cb.setAttribute("data-style", st[0]);
        cb.addEventListener("change", () => { state.variants[k][st[0]] = cb.checked; refresh(); });
        lab.appendChild(cb); lab.appendChild(doc.createTextNode(" " + st[1])); tg.appendChild(lab);
      });
      box.appendChild(tg);
      if (!vs.length) box.appendChild(el("p", "sc-meta sc-warn", "Pick at least one style, or untick " + name + "."));
      else if (info === null) box.appendChild(el("p", "sc-meta", "Checking the builder pictures…"));
      else if (state.infoErr) box.appendChild(el("p", "sc-meta sc-warn", "Couldn’t check the builder pictures — they are re-checked when you share."));
      else {
        const miss = missingImages({ [k]: true }, { [k]: state.variants[k] }, info);
        if (miss.length) box.appendChild(el("p", "sc-meta", "The " + name + " pictures are prepared automatically from the latest layout when you create or update the link."));
        else if (state.stale && state.stale[kind]) box.appendChild(el("p", "sc-meta", "The layout changed since these pictures — they are refreshed automatically when you share."));
      }
      const cap = el("figcaption"); cap.appendChild(el("span", "", name)); box.appendChild(cap);
      return box;
    }
    // newest stored pictures (+ previews of the first chosen style)
    async function loadInfo() {
      const B = global.BPStore && global.BPStore.booklet;
      // R8: a failed check is NOT "no pictures" — remember the error instead of claiming they are missing
      state.infoErr = null;
      try { state.info = normInfo(B && B.imageInfo ? await B.imageInfo(quoteId) : {}); } catch (e) { state.info = normInfo({}); state.infoErr = e || new Error("check failed"); }
      try {
        const vs = (await global.BPStore.quotes.versions(quoteId)) || []; const st = imageStatus(state.info, vs); state.stale = {};
        ["2d", "3d"].forEach((kind) => { state.stale[kind] = st[kind].labels === "stale" || st[kind].plain === "stale"; });
      } catch (e) { state.stale = {}; }
      refresh();
      for (const kind of ["2d", "3d"]) for (const st of STYLES) {
        if (!(state.info[kind] && state.info[kind][st[0]]) || !B || !B.staffImage) continue;
        try { const u = await B.staffImage(quoteId, kind, st[0]); if (u) { state.previews[kind + "_" + st[0]] = u; refresh(); } } catch (e) {}
      }
    }
    function refresh() {
      rule.textContent = state.sections.menu ? menuRule(state.hasPkg) : "Menu hidden — the client won't see packages or the menu.";
      clear(thumbs);
      ["layout2d", "layout3d"].forEach((k) => { if (state.sections[k]) thumbs.appendChild(thumb(k)); });
      clear(pvl); preview(state.sections, state.hasPkg).forEach((x) => pvl.appendChild(el("li", "", x)));
    }
    hasSelectedPackage(quoteId).then((h) => { state.hasPkg = h; refresh(); });
    refresh();
    host.appendChild(wrap);
    loadInfo();
    // R8: re-check when the studio comes back from the builder tab
    try { global.addEventListener("focus", () => { if (host.isConnected !== false) loadInfo(); }); } catch (e) {}

    return {
      // R8b: an empty layout has no pictures — the 2D / 3D sections are skipped (with a note) instead of blocking
      sections: () => { const s = normalize(state.sections); if (state.skipPics) { s.layout2d = false; s.layout3d = false; } return s; },
      variants: () => variantFlags(state.variants),
      // before the share: every ticked 2D / 3D section needs its stored builder pictures (never publish nothing)
      async uploadSnapshots() {
        const sec = normalize(state.sections);
        // R8: always re-check — the pictures are usually captured in another tab (builder) after this page loaded
        await loadInfo();
        if (state.infoErr) throw new Error("Couldn’t check the builder pictures (" + errText(state.infoErr) + "). Please try again.");
        for (const k of ["layout2d", "layout3d"]) if (sec[k] && !variantsFor(state, k).length)
          throw new Error("Pick “With labels” and/or “Without labels” for the " + (k === "layout2d" ? "2D floor plan" : "3D view") + ", or untick it.");
        // R8b: missing / stale pictures are rendered automatically (no trip to the builder)
        state.skipPics = false;
        const need = needsCapture(sec, state.variants, state.info, state.stale);
        if (need.length) {
          const mark = { "2d": "…", "3d": "…" };
          const show = () => { prog.hidden = false; prog.textContent = "Preparing pictures… 2D " + mark["2d"] + " 3D " + mark["3d"]; };
          show();
          let r;
          try { r = await (o.autoCapture || autoCapture)(quoteId, { onProgress: (step) => { if (step === "2d" || step === "3d") { mark[step] = "\u2713"; show(); } } }); }
          catch (e) { prog.textContent = ""; prog.hidden = true;
            throw new Error("Couldn’t prepare the 2D / 3D pictures (" + String((e && e.message) || "failed") + "). Press the button again to retry, or untick them."); }
          if (r && r.empty) { state.skipPics = true; prog.textContent = "The floor layout has no items yet — the 2D / 3D pictures are skipped for this link."; refresh(); return; }
          mark["2d"] = mark["3d"] = "\u2713"; show();
          await loadInfo();
          const still = missingImages(sec, state.variants, state.info);
          if (still.length) throw new Error("Some pictures couldn’t be prepared (" + still.map((m) => m.kind.toUpperCase() + (m.variant === "plain" ? " without" : " with") + " labels").join(", ") + "). Press the button again to retry, or untick them.");
          prog.textContent = "Pictures ready — 2D \u2713 3D \u2713";
        }
      },
      // after the link exists: which picture styles it shows
      async attachSnapshots() {
        const B = global.BPStore.booklet; if (!B || !B.setImageVariants) return;
        await B.setImageVariants(quoteId, variantFlags(state.variants));
      },
    };
  }
  // share payload (keeps the 0065 versionIds key alongside the new versions key)
  function sharePayload(o) {
    return { days: Number(o.days) || 30, versions: o.versions || null, versionIds: o.versions || null, note: o.note || "", terms: o.terms || "", sections: normalize(o.sections) };
  }

  /* ---- the standalone card on flow.html ---- */
  async function renderCard(card) {
    const quoteId = quoteIdFor(card); const body = clear(card.querySelector(".sc-body"));
    if (!quoteId) { body.appendChild(el("p", "sc-meta", "Save the client first to share a booklet.")); return; }
    const st = global.BPStore;
    let cur = null; try { cur = await st.booklet.current(quoteId); } catch (e) { cur = null; }
    const ck = mount(body, { quoteId: quoteId, cur: cur });
    const g = el("div", "sc-grid");
    const nl = el("label", "sc-lab", "Note to your client (optional)"); nl.setAttribute("for", "scNote");
    const note = el("textarea", "sc-in"); note.id = "scNote"; note.rows = 2; note.maxLength = 1000; note.value = (cur && cur.note) || "";
    const dl = el("label", "sc-lab", "Link valid for"); dl.setAttribute("for", "scDays");
    const days = el("select", "sc-in"); days.id = "scDays";
    DAYS.forEach((d) => { const op = el("option", "", d + " days"); op.value = String(d); if (d === 30) op.selected = true; days.appendChild(op); });
    const f1 = el("div"); f1.appendChild(nl); f1.appendChild(note); const f2 = el("div"); f2.appendChild(dl); f2.appendChild(days);
    g.appendChild(f1); g.appendChild(f2); body.appendChild(g);
    const live = el("div", "sc-live");
    const msg = el("p", "sc-err"); msg.setAttribute("role", "alert");
    const acts = el("div", "sc-acts");
    const go = btn("btn primary", cur && cur.token ? "Update client booklet link" : "Create client booklet link"); acts.appendChild(go);
    body.appendChild(acts); body.appendChild(msg); body.appendChild(live);
    const showLive = (c) => {
      clear(live); if (!c || !c.token) return;
      const url = st.booklet.url(c.token);
      const row = el("div", "sc-row");
      const lab = el("label", "sc-lab", "Client booklet link"); lab.setAttribute("for", "scUrl");
      const inp = el("input", "sc-in"); inp.id = "scUrl"; inp.readOnly = true; inp.value = url; inp.addEventListener("focus", () => inp.select());
      const copy = btn("sc-btn", "Copy"); copy.addEventListener("click", async () => { try { await global.navigator.clipboard.writeText(url); toast("Booklet link copied"); } catch (e) { inp.focus(); inp.select(); } });
      const open = el("a", "sc-btn ghost", "Open"); open.setAttribute("href", url); open.setAttribute("target", "_blank"); open.setAttribute("rel", "noopener noreferrer");
      const rev = btn("sc-btn danger", "Revoke");
      rev.addEventListener("click", async () => {
        let ok = true; try { if (global.BPUI && global.BPUI.confirm) ok = await global.BPUI.confirm("The client will no longer be able to open this booklet.", { title: "Revoke booklet link?", okLabel: "Revoke", danger: true }); } catch (e) {}
        if (!ok) return; rev.disabled = true;
        try { await st.booklet.revoke(quoteId); toast("Booklet link revoked"); clear(live); go.textContent = "Create client booklet link"; } catch (e) { rev.disabled = false; msg.textContent = errText(e); }
      });
      live.appendChild(lab); row.appendChild(inp); row.appendChild(copy); row.appendChild(open); row.appendChild(rev); live.appendChild(row);
      live.appendChild(el("p", c.expired ? "sc-meta sc-warn" : "sc-meta", (c.expired ? "Expired on " : "Valid until ") + when(c.expires_at)));
    };
    showLive(cur);
    go.addEventListener("click", async () => {
      msg.textContent = ""; go.disabled = true;
      try {
        await ck.uploadSnapshots();
        await st.booklet.share(quoteId, sharePayload({ days: days.value, versions: cur && cur.shared_versions, note: note.value.trim(), terms: (cur && cur.terms) || "", sections: ck.sections() }));
        await ck.attachSnapshots();
        toast("Booklet link ready");
        try { cur = await st.booklet.current(quoteId); } catch (e) {}
        showLive(cur); go.textContent = "Update client booklet link";
      } catch (e) { msg.textContent = errText(e); }
      go.disabled = false;
    });
  }
  async function wire() {
    const cards = Array.from(doc.querySelectorAll("[data-share-checklist]"));
    if (!cards.length || !global.BPStore) return;
    let can = false;
    try { await global.BPStore.init(); can = global.BPStore.mode() === "supabase" && await global.BPStore.auth.canEditArea("quotes"); } catch (e) { can = false; }
    cards.forEach((c) => { if (!can) { c.hidden = true; return; } if (c.dataset.scWired) return; c.dataset.scWired = "1"; c.hidden = false; renderCard(c).catch(() => {}); });
  }

  global.HelmShareChecklist = { mount, wire, normalize, menuRule, preview, fitSize, sharePayload, freshEnough, missingImages, normInfo, imageStatus, variantFlags, builderUrl, captureUrl, acceptCaptureMessage, needsCapture, autoCapture, CAPTURE_TIMEOUT_MS, STYLES, SECTIONS };
  if (doc && doc.querySelector("[data-share-checklist]")) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", wire); else wire();
  }
})(typeof window !== "undefined" ? window : globalThis);
