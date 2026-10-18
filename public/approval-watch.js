/* confirm-1018 #3: keep a studio page's client-approval state live (Quotes list, event workspace, quote flow).
 * When the client approves on approve.html (OTP, or "Test mode - confirm" in a free trial) the studio page used to
 * show the old state until a manual reload. The quotes table is not on the realtime publication, so this polls a
 * LEAN read (id / code / status / approval_status / updated_at - BPStore.quotes.approvalStates) every ~15 s while
 * the page is visible, and right away when the tab gets focus again. Only quotes still waiting for the client are
 * asked about; nothing is polled when there are none.
 *   HelmApprovalWatch.start({ ids:()=>[...], known:(id)=>({status, approvalStatus}), onChange:(d)=>{}, intervalMs })
 *   d = { changed:[row], approved:[row] }  (approved = rows that just became approved / paid)
 * Pure diff() is exported for the unit test. No DOM writes here except the toast. */
(function (global) {
  "use strict";
  function done(a) { return a === "approved" || a === "paid"; }
  function key(r) { return String((r && r.status) || "") + "|" + String((r && r.approvalStatus) || "none"); }
  // compare fresh rows with what the page knew -> what changed, and which became approved
  function diff(known, rows) {
    var changed = [], approved = [];
    (rows || []).forEach(function (r) {
      if (!r || !r.id) return;
      var k = null; try { k = known ? known(r.id) : null; } catch (_) { k = null; }
      if (!k) return;
      if (key(k) === key(r)) return;
      changed.push(r);
      if (done(r.approvalStatus) && !done(k.approvalStatus)) approved.push(r);
    });
    return { changed: changed, approved: approved };
  }
  // the quotes worth asking about: not approved / paid yet, not cancelled
  function pending(list) {
    return (list || []).filter(function (q) { return q && q.id && q.status !== "cancelled" && !done(q.approvalStatus); }).map(function (q) { return q.id; });
  }
  function start(o) {
    o = o || {};
    var ms = Math.max(5000, Number(o.intervalMs) || 15000), seen = {}, busy = false, stopped = false, last = 0, timer = null;
    var fetchRows = o.fetch || function (ids) { return global.BPStore.quotes.approvalStates(ids); };
    function knownFor(id) { if (seen[id]) return seen[id]; try { return o.known ? o.known(id) : null; } catch (_) { return null; } }
    function hidden() { try { return global.document && global.document.visibilityState === "hidden"; } catch (_) { return false; } }
    async function tick(force) {
      if (stopped || busy || hidden()) return;
      if (!force && Date.now() - last < 3000) return;
      var ids = []; try { ids = (o.ids && o.ids()) || []; } catch (_) { ids = []; }
      ids = ids.filter(function (x) { return typeof x === "string" && x; }).slice(0, 100);
      if (!ids.length) return;
      busy = true; last = Date.now();
      try {
        var rows = await fetchRows(ids);
        var d = diff(knownFor, rows);
        (rows || []).forEach(function (r) { if (r && r.id) seen[r.id] = { status: r.status, approvalStatus: r.approvalStatus }; });
        if (d.approved.length && o.toast !== false && global.BPUI && global.BPUI.toast) {
          var codes = d.approved.map(function (r) { return r.code; }).filter(Boolean);
          global.BPUI.toast("Client approved" + (codes.length ? ": " + codes.slice(0, 3).join(", ") + (codes.length > 3 ? " +" + (codes.length - 3) : "") : "") + ".", { type: "ok" });
        }
        if (d.changed.length && o.onChange) { try { await o.onChange(d); } catch (_) {} }
      } catch (_) { /* offline / signed out: try again next tick */ }
      finally { busy = false; }
    }
    function onVis() { if (!hidden()) tick(true); }
    timer = setInterval(function () { tick(false); }, ms);
    try { global.document.addEventListener("visibilitychange", onVis); global.addEventListener("focus", onVis); } catch (_) {}
    return {
      check: function () { return tick(true); },
      // the page reloaded its data: forget what this watcher saw, ask the page again
      reset: function () { seen = {}; },
      stop: function () { stopped = true; if (timer) clearInterval(timer); try { global.document.removeEventListener("visibilitychange", onVis); global.removeEventListener("focus", onVis); } catch (_) {} }
    };
  }
  global.HelmApprovalWatch = { start: start, diff: diff, pending: pending, done: done };
})(typeof window !== "undefined" ? window : globalThis);
