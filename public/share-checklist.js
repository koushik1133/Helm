/* share-checklist.js — "Share with client" checklist (flow.html card + the Share booklet dialog, 0069).
   The studio picks which booklet sections the client sees; the server filters the booklet to
   exactly these (contract: sections = {studio, client, venue, menu, layout2d, layout3d, quotation,
   payments, terms}). 2D / 3D ticked → PNG screenshots (≤1600 px) are captured and uploaded with
   BPStore.booklet.uploadSnapshot(quoteId, '2d'|'3d', blob):
     • 2D — the saved layout drawn by the booklet's own plan renderer (booklet.js), rasterised offscreen
     • 3D — the live 3D viewer's WebGL canvas (#scene3d) when this page has one, else the booklet's
       isometric render of the same layout (the builder can't be framed: frame-ancestors 'none').
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

  async function layoutFor(quoteId) {
    const st = global.BPStore;
    const q = await st.quotes.get(quoteId); if (!q) return null;
    const v = await st.quotes.getVersion(quoteId, q.currentVersion);
    const data = (v && v.data) || {};
    return { items: Array.isArray(data.items) ? data.items : [], room: data.room || null };
  }
  async function hasSelectedPackage(quoteId) {
    try { const p = global.BPStore.plan && await global.BPStore.plan.get(quoteId); return !!(p && (p.menu_template || p.package)); } catch (e) { return false; }
  }
  function canvasToBlob(cv) { return new Promise((res) => { try { cv.toBlob((b) => res(b), "image/png"); } catch (e) { res(null); } }); }
  async function rasterSvg(svgEl) {
    const vb = (svgEl.getAttribute("viewBox") || "0 0 800 600").split(/\s+/).map(Number);
    const sz = fitSize(vb[2] * 8, vb[3] * 8, MAX_W);
    svgEl.setAttribute("width", String(sz.w)); svgEl.setAttribute("height", String(sz.h)); svgEl.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new global.XMLSerializer().serializeToString(svgEl));
    const img = new global.Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("Couldn't draw the layout")); img.src = src; });
    const cv = doc.createElement("canvas"); cv.width = sz.w; cv.height = sz.h;
    const cx = cv.getContext("2d"); cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, sz.w, sz.h); cx.drawImage(img, 0, 0, sz.w, sz.h);
    return canvasToBlob(cv);
  }
  async function capture(kind, quoteId) {
    if (kind === "3d") {
      const live = doc.getElementById("scene3d");
      if (live && live.width > 10 && typeof live.toBlob === "function") {
        const sz = fitSize(live.width, live.height, MAX_W), cv = doc.createElement("canvas"); cv.width = sz.w; cv.height = sz.h;
        try { cv.getContext("2d").drawImage(live, 0, 0, sz.w, sz.h); const b = await canvasToBlob(cv); if (b && b.size > 2000) return b; } catch (e) {}
      }
    }
    const B = global.HelmBooklet; if (!B) throw new Error("Screenshot tools aren't loaded on this page.");
    const layout = await layoutFor(quoteId);
    if (!layout || !B.normalizeItems(layout).items.length) throw new Error("Draw the floor plan in the builder first.");
    const fig = el("figure");
    if (kind === "2d") B.render2d({ layout: layout }, fig, el("ul")); else B.render3d({ layout: layout }, fig);
    const svgEl = fig.querySelector("svg"); if (!svgEl) throw new Error("Couldn't draw the layout");
    return rasterSvg(svgEl);
  }

  /* mount(host, { quoteId, cur, embedded }) → { sections(), snapshots, uploadSnapshots() }
     embedded = inside the Share booklet dialog (the dialog owns note / days / submit). */
  function mount(host, o) {
    o = o || {};
    const quoteId = o.quoteId, cur = o.cur || null;
    const state = { sections: normalize(cur && cur.sections), snaps: {}, hasPkg: false };
    const wrap = el("div", "sc-wrap");
    const fs = el("fieldset", "sc-fs"); fs.appendChild(el("legend", "sc-lab", "What the client will see"));
    const list = el("div", "sc-list"); fs.appendChild(list); wrap.appendChild(fs);
    const rule = el("p", "sc-rule"); rule.setAttribute("aria-live", "polite");
    const thumbs = el("div", "sc-thumbs");
    const pv = el("div", "sc-preview"); pv.appendChild(el("p", "sc-lab", "Client will see"));
    const pvl = el("ul", "sc-pvl"); pvl.setAttribute("aria-live", "polite"); pv.appendChild(pvl);
    SECTIONS.forEach((x) => {
      const id = "sc_" + x[0] + (o.embedded ? "_d" : "");
      const lab = el("label", "sc-item"); lab.setAttribute("for", id);
      const cb = el("input"); cb.type = "checkbox"; cb.id = id; cb.setAttribute("role", "switch"); cb.checked = state.sections[x[0]]; cb.setAttribute("data-sec", x[0]);
      cb.addEventListener("change", () => { state.sections[x[0]] = cb.checked; if ((x[0] === "layout2d" || x[0] === "layout3d") && cb.checked && !state.snaps[x[0]]) take(x[0] === "layout2d" ? "2d" : "3d"); refresh(); });
      lab.appendChild(cb); lab.appendChild(el("span", "", x[1])); list.appendChild(lab);
      if (x[0] === "menu") list.appendChild(rule);
    });
    wrap.appendChild(thumbs); wrap.appendChild(pv);

    function thumb(k) {
      const kind = k === "layout2d" ? "2d" : "3d", s = state.snaps[k];
      const box = el("figure", "sc-thumb");
      if (s && s.url) { const img = el("img"); img.setAttribute("src", s.url); img.setAttribute("alt", (kind === "2d" ? "2D floor plan" : "3D view") + " screenshot"); box.appendChild(img); }
      else box.appendChild(el("p", "sc-meta", s && s.busy ? "Capturing…" : s && s.error ? s.error : "No screenshot yet"));
      const cap = el("figcaption"); cap.appendChild(el("span", "", kind === "2d" ? "2D floor plan" : "3D view"));
      const rt = btn("sc-btn ghost", s && s.url ? "Retake" : "Capture"); rt.setAttribute("aria-label", (s && s.url ? "Retake " : "Capture ") + (kind === "2d" ? "2D floor plan" : "3D view") + " screenshot");
      rt.disabled = !!(s && s.busy); rt.addEventListener("click", () => take(kind)); cap.appendChild(rt); box.appendChild(cap);
      return box;
    }
    async function take(kind) {
      const k = kind === "2d" ? "layout2d" : "layout3d";
      const old = state.snaps[k]; state.snaps[k] = { busy: true }; refresh();
      try {
        const blob = await capture(kind, quoteId);
        if (!blob) throw new Error("Couldn't capture the screenshot");
        if (old && old.url) { try { global.URL.revokeObjectURL(old.url); } catch (e) {} }
        state.snaps[k] = { blob: blob, url: global.URL.createObjectURL(blob), uploaded: false };
      } catch (e) { state.snaps[k] = { error: String((e && e.message) || "Couldn't capture").slice(0, 120) }; }
      refresh();
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
    if (state.sections.layout2d) take("2d");
    if (state.sections.layout3d) take("3d");

    return {
      sections: () => normalize(state.sections),
      snapshots: state.snaps,
      async uploadSnapshots() {
        const up = global.BPStore.booklet && global.BPStore.booklet.uploadSnapshot;
        for (const k of ["layout2d", "layout3d"]) {
          const s = state.snaps[k];
          if (!state.sections[k] || !s || !s.blob || s.uploaded) continue;
          if (typeof up !== "function") throw new Error("Screenshot upload isn't available yet — untick the screenshots or try again later.");
          await up(quoteId, k === "layout2d" ? "2d" : "3d", s.blob); s.uploaded = true;
        }
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

  global.HelmShareChecklist = { mount, wire, normalize, menuRule, preview, fitSize, sharePayload, capture, SECTIONS };
  if (doc && doc.querySelector("[data-share-checklist]")) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", wire); else wire();
  }
})(typeof window !== "undefined" ? window : globalThis);
