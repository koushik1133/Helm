/* confirm-1018 #4: "Save & back" next to a workspace sub-page's Save button (Venue & menu, Discovery, Proposal,
 * Closure). It runs the page's OWN save and, only when that save succeeded (its status line turned "ok"), goes
 * back to where "← Back" points (the event workspace, or Quotes). A failed / refused save stays on the page with
 * its message. The new button follows the Save button: hidden / disabled together.
 *   HelmSaveBack.add({ button:"#v_save", msg:"#v_msg", run:()=>saveVenue(), back:"#backLink" })
 * label(href) is exported for the unit test. */
(function (global) {
  "use strict";
  function $(s) { return typeof s === "string" ? global.document.querySelector(s) : s; }
  // "Save & back to event" when "← Back" goes to the event workspace, else "Save & back to quotes"
  function label(href) {
    var h = String(href || "");
    if (/(^|\/)event(\.html)?(\?|$)|\/events\//.test(h)) return "Save & back to event";
    if (/(^|\/)flow(\.html)?(\?|$)/.test(h)) return "Save & back to quote";
    return "Save & back to quotes";
  }
  function add(o) {
    o = o || {}; var save = $(o.button), back = $(o.back || "#backLink");
    if (!save || !save.parentNode || save.__saveBack) return null; save.__saveBack = true;
    var b = global.document.createElement("button"); b.type = "button"; b.className = "btn save-back";
    if (o.id) b.id = o.id;
    var href = function () { return (back && back.getAttribute("href") && back.getAttribute("href") !== "#") ? back.href : "quotes.html"; };
    var paint = function () { b.textContent = label(href()); b.hidden = save.hidden; b.disabled = save.disabled; };
    paint();
    save.parentNode.insertBefore(b, save.nextSibling);
    try { new MutationObserver(paint).observe(save, { attributes: true, attributeFilter: ["hidden", "disabled"] }); } catch (_) {}
    if (back) { try { new MutationObserver(paint).observe(back, { attributes: true, attributeFilter: ["href"] }); } catch (_) {} }
    b.addEventListener("click", async function () {
      if (b.disabled || save.disabled || b.getAttribute("aria-busy") === "true") return;
      var m = $(o.msg); if (m) { m.classList.remove("ok"); }
      b.setAttribute("aria-busy", "true"); b.disabled = true;
      var ok = false;
      try { var r = await o.run(); ok = r === true || !!(m ? m.classList.contains("ok") : r !== false); } catch (_) { ok = false; }
      finally { b.removeAttribute("aria-busy"); paint(); }
      if (!ok) return;
      try { if (global.BPUI && global.BPUI.allowUnload) global.BPUI.allowUnload(); } catch (_) {}
      global.location.href = href();
    });
    return b;
  }
  global.HelmSaveBack = { add: add, label: label };
})(typeof window !== "undefined" ? window : globalThis);
