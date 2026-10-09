/* =========================================================================
   HELM — flow page per-section autosave (r9 P0).
   Debounced (default 800 ms after the last input, or immediately on blur),
   serialized (one write in flight at a time, per page), with an honest badge:
     hidden → "Saving…" → "Saved ✓" | "Not saved — retry" (clickable) | inline reason.
   Pure logic + a tiny DOM adapter; no innerHTML. window.HelmAutosave / require().
   ========================================================================= */
(function (root) {
  "use strict";
  // opts: { save: {section: async () => (false | {invalid:"msg"} | anything)}, badge(section, state, msg),
  //         delay, setTimeout, clearTimeout }
  function create(opts) {
    const st = opts.setTimeout || root.setTimeout.bind(root), ct = opts.clearTimeout || root.clearTimeout.bind(root);
    const delay = opts.delay == null ? 800 : opts.delay;
    const timers = {}, queued = new Set(), failed = new Set();
    let chain = Promise.resolve(), inflight = 0;
    const badge = (s, state, msg) => { try { opts.badge && opts.badge(s, state, msg); } catch (e) {} };

    function run(s) {
      queued.delete(s);
      const fn = opts.save[s]; if (typeof fn !== "function") return Promise.resolve(true);
      inflight++; badge(s, "saving");
      return Promise.resolve().then(fn).then((r) => {
        if (r && r.invalid) { failed.add(s); badge(s, "invalid", r.invalid); return false; }
        if (r === false) { failed.add(s); badge(s, "error"); return false; }
        failed.delete(s); badge(s, "saved"); return true;
      }, (e) => { failed.add(s); badge(s, "error", e); return false; })
        .finally(() => { inflight--; });
    }
    // enqueue behind any in-flight write; a section already queued is not queued twice
    function now(s) {
      if (timers[s]) { ct(timers[s]); timers[s] = null; }
      if (queued.has(s)) return chain;
      queued.add(s);
      const p = chain.then(() => run(s));
      chain = p.catch(() => false);
      return p;
    }
    function schedule(s) {
      if (!opts.save[s]) return;
      if (timers[s]) ct(timers[s]);
      timers[s] = st(() => { timers[s] = null; now(s); }, delay);
    }
    async function flush() {
      const ss = Object.keys(timers).filter((k) => timers[k]);
      ss.forEach((k) => now(k));
      await chain;
      return failed.size === 0;
    }
    function pending() { return inflight > 0 || queued.size > 0 || Object.keys(timers).some((k) => timers[k]); }
    function hasFailed() { return failed.size > 0; }
    function clearFailed() { failed.clear(); }
    return { schedule, now, flush, pending, hasFailed, clearFailed };
  }

  const LABEL = { saving: "Saving…", saved: "Saved ✓", error: "Not saved — retry" };
  // badge adapter for a `.saved` span: hidden initially; err/invalid get a red tone
  function paint(el, state, msg) {
    if (!el) return;
    el.dataset.state = state;
    el.textContent = state === "invalid" ? ("Not saved — " + String(msg || "check the highlighted field")) : (LABEL[state] || "");
    el.classList.toggle("on", !!state && state !== "idle");
    el.classList.toggle("bad", state === "error" || state === "invalid");
    if (state === "error") { el.setAttribute("role", "button"); el.tabIndex = 0; el.title = "Click to retry saving"; }
    else { el.removeAttribute("role"); el.removeAttribute("tabindex"); el.removeAttribute("title"); }
  }
  const api = { create, paint, LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.HelmAutosave = api;
})(typeof window !== "undefined" ? window : globalThis);
