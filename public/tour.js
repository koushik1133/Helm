/* =========================================================================
   HELM — shared per-page guided tour engine (zero-dependency, vanilla JS)
   -------------------------------------------------------------------------
   One engine, many pages. Each page's steps live in STEPS keyed by filename.
   A page opts in simply by including  <script src="tour.js?v=1"></script>.

   • Injects its own spotlight CSS (pages need no markup).
   • Renders a floating "? Tour" button, or wires an existing #helpBtn.
   • Auto-starts once per page for signed-in first-time visitors.
   • Robust: a step whose target is missing is SKIPPED, not fatal — this is
     the fix for the old "tour jumps straight to the end" bug.
   ========================================================================= */
(function () {
  "use strict";

  /* ---- per-page steps: { selector, title, desc } --------------------- */
  const STEPS = {
    "builder.html": [
      { sel: "#customBtn", title: "Build your floor", desc: "Click ✨ Custom Event, type your hall length × breadth and guest count, and Helm sizes the canvas to your hall and auto-arranges the seating." },
      { sel: "#preset", title: "…or start from a template", desc: "Prefer a head start? Pick a ready-made event layout (wedding, conference, concert…) and tweak it." },
      { sel: "#toolbox", title: "Drag any asset", desc: "Drag stages, chairs, tables, bars, exits — anything — onto the floor. Every object is movable, resizable and rotatable." },
      { sel: "#measureBtn", title: "Measure everything", desc: "Turn on 📏 Measure, then select an object to see its distance from all four walls AND its nearest neighbour on every side." },
      { sel: "#capMeter", title: "Capacity & congestion", desc: "Seats placed vs the venue's capacity. It flags any block packed tighter than a walkable aisle." },
      { sel: "#saveBtn", title: "Save to the quote", desc: "Save ties this layout to the event — and the chair count flows straight into the price breakdown on the right." },
    ],
    "quotes.html": [
      { sel: "#newBtn", title: "Start a new quote", desc: "Price a fresh event here. It becomes the event everything else hangs off." },
      { sel: "#tabs", title: "Find confirmed fast", desc: "Active · Quotes · Confirmed · Archived. Confirmed events rise to the top and are highlighted so you never scroll to find them." },
      { sel: "#search", title: "Search", desc: "Jump to any quote by client name or quote code." },
      { sel: "#rows", title: "Your quotes", desc: "Click a row to open it, confirm it, re-price it, or take client approval by OTP / consent / payment link." },
    ],
    "flow.html": [
      { sel: "#code", title: "The event workspace", desc: "Every stage of this one event lives here, top to bottom — fill it in order and nothing gets missed." },
      { sel: "#sec-client", title: "1 · Client", desc: "Who the event is for. Saved here, reused everywhere." },
      { sel: "#sec-discovery", title: "2 · Discovery", desc: "Capture requirements and the budget range before you price." },
      { sel: "#sec-proposal", title: "3 · Proposal", desc: "Your pitch to the client — it sits above the floor layout so you sell first, then plan." },
      { sel: "#sec-layout", title: "4 · Floor layout", desc: "Open the builder. The chairs you place here feed straight back into the quotation." },
      { sel: "#sec-quote", title: "5 · Quote", desc: "Final pricing and confirmation. Confirming sets the event live." },
      { sel: "#sec-pay", title: "6 · Payment", desc: "Send the client an approval + payment link and track what's paid." },
    ],
    "logistics.html": [
      { sel: "#tabs", title: "Event logistics", desc: "Everything that has to happen for this event, organised by section (stage, lighting, catering…)." },
      { sel: "#tplBar", title: "Apply a template", desc: "Drop a saved checklist into this event in one click — no retyping the same tasks every time. (You build templates in Control Center.)" },
      { sel: "#a_title", title: "Add a one-off task", desc: "Need something the template didn't cover? Add your own task right here." },
      { sel: "#pane", title: "Assign & track", desc: "Assign staff to each task and tick off progress as the event comes together." },
    ],
  };

  // Normalise the page key so it matches with or without the ".html" suffix
  // (the app is served under clean URLs, e.g. "/builder" as well as "/builder.html").
  const base = (location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "");
  const page = base || "index";
  const steps = STEPS[page + ".html"] || STEPS[page];
  if (!steps || !steps.length) return;   // this page has no tour — do nothing

  /* ---- inject spotlight styles once ---------------------------------- */
  const css = `
  .htour{position:fixed;inset:0;z-index:9000;pointer-events:none;font-family:inherit}
  .htour .ring{position:absolute;border:3px solid var(--gold,#e0a938);border-radius:12px;
    box-shadow:0 0 0 9999px rgba(20,18,40,.58);transition:all .28s cubic-bezier(.4,0,.2,1)}
  .htour .arrow{position:absolute;color:var(--gold,#e0a938);font-size:28px;line-height:1;
    filter:drop-shadow(0 2px 3px rgba(0,0,0,.25));animation:htbob 1s ease-in-out infinite}
  @keyframes htbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
  .htour .tip{position:absolute;max-width:320px;background:var(--panel,#fff);color:var(--ink,#1b1930);
    border:1px solid var(--line,#e8e3db);border-radius:14px;box-shadow:0 10px 30px rgba(20,18,40,.22);
    padding:16px 18px;pointer-events:auto}
  .htour .tip .tstep{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--accent,#6d28d9)}
  .htour .tip h4{margin:4px 0 6px;font-size:16px}
  .htour .tip p{margin:0 0 13px;font-size:13px;color:var(--ink-2,#4b475f);line-height:1.55}
  .htour .tip .trow{display:flex;gap:8px;align-items:center}
  .htour .tip .trow .sp{flex:1}
  .htour .tip button{height:32px;padding:0 13px;border-radius:8px;border:1px solid var(--line,#e8e3db);
    background:var(--panel,#fff);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;color:var(--ink-2,#4b475f)}
  .htour .tip button.pri{background:linear-gradient(120deg,var(--accent,#6d28d9),#7c5cff);border-color:transparent;color:#fff}
  .htour .tip button.skip{border:0;background:transparent;color:var(--ink-3,#6b6577)}
  .htour-fab{position:fixed;left:16px;bottom:16px;z-index:8000;height:34px;padding:0 14px;border-radius:20px;
    border:1px solid var(--line,#e8e3db);background:var(--panel,#fff);color:var(--accent,#6d28d9);font-family:inherit;
    font-weight:700;font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(20,18,40,.14);display:inline-flex;align-items:center;gap:5px}
  .htour-fab:hover{border-color:var(--accent,#6d28d9);background:var(--accent-soft,#efe9ff)}`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  /* ---- engine -------------------------------------------------------- */
  let list = [], i = 0, root = null;
  const seenKey = "helm_tour_seen_" + page;

  function present(sel) { const t = document.querySelector(sel); return t && t.offsetParent !== null ? t : null; }

  function end() {
    if (root) { root.remove(); root = null; }
    window.removeEventListener("resize", place);
    try { localStorage.setItem(seenKey, "1"); } catch (_) {}
  }

  function start() {
    end();
    list = steps.filter(s => present(s.sel));   // only steps whose target is on-screen now
    if (!list.length) return;
    i = 0;
    root = document.createElement("div");
    root.className = "htour";
    root.innerHTML = `<div class="ring"></div><div class="arrow">▼</div>
      <div class="tip"><div class="tstep"></div><h4></h4><p></p>
        <div class="trow"><button class="skip">Skip</button><span class="sp"></span>
        <button class="back">Back</button><button class="pri next">Next →</button></div></div>`;
    document.body.appendChild(root);
    root.querySelector(".skip").onclick = end;
    root.querySelector(".back").onclick = () => { if (i > 0) { i--; place(); } };
    root.querySelector(".next").onclick = () => { if (i < list.length - 1) { i++; place(); } else end(); };
    window.addEventListener("resize", place);
    place();
  }

  function place() {
    if (!root) return;
    // skip forward over any step whose target vanished (the old "jumps to end" bug fix)
    while (i < list.length && !present(list[i].sel)) i++;
    if (i >= list.length) { end(); return; }
    const step = list[i], tgt = present(step.sel);
    tgt.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => {
      if (!root) return;
      const r = tgt.getBoundingClientRect(), pad = 6;
      const ring = root.querySelector(".ring");
      ring.style.left = (r.left - pad) + "px"; ring.style.top = (r.top - pad) + "px";
      ring.style.width = (r.width + pad * 2) + "px"; ring.style.height = (r.height + pad * 2) + "px";
      const tip = root.querySelector(".tip"), arrow = root.querySelector(".arrow");
      root.querySelector(".tstep").textContent = `Step ${i + 1} of ${list.length}`;
      root.querySelector("h4").textContent = step.title;
      root.querySelector("p").textContent = step.desc;
      root.querySelector(".back").style.visibility = i ? "visible" : "hidden";
      root.querySelector(".next").textContent = i < list.length - 1 ? "Next →" : "Done";
      const below = r.bottom + 190 < window.innerHeight;
      const tw = Math.min(320, window.innerWidth - 24);
      const tx = Math.min(Math.max(12, r.left), window.innerWidth - tw - 12);
      const ty = below ? r.bottom + 18 : r.top - tip.offsetHeight - 18;
      tip.style.left = tx + "px"; tip.style.top = Math.max(12, ty) + "px";
      arrow.style.left = (r.left + r.width / 2 - 9) + "px";
      arrow.textContent = below ? "▲" : "▼";
      arrow.style.top = (below ? r.bottom + 2 : r.top - 30) + "px";
    }, 240);
  }

  /* ---- mount: reuse #helpBtn if present, else a floating button ------- */
  function mount() {
    const existing = document.getElementById("helpBtn");
    if (existing) { existing.addEventListener("click", start); }
    else {
      const fab = document.createElement("button");
      fab.className = "htour-fab"; fab.type = "button";
      fab.textContent = "? Tour"; fab.title = "Take a guided tour of this page";
      fab.addEventListener("click", start);
      document.body.appendChild(fab);
    }
    document.addEventListener("keydown", e => { if (e.key === "Escape") end(); });
    // first-time auto-start (signed-in users only), once per page
    try {
      if (!localStorage.getItem(seenKey)) {
        setTimeout(() => {
          const signedIn = !(window.BPStore && BPStore.auth && BPStore.auth.enabled()) ||
                           (window.BPStore && BPStore.auth.user());
          if (signedIn) start();
        }, 1400);
      }
    } catch (_) {}
  }

  window.HelmTour = { start, end };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
