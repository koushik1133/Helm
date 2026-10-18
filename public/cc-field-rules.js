/* cc-field-rules.js - Control Center input rules + inline field errors (Oct 2026 sweep B).
 * Sections: Menus & catalog (dish add + dish filter), Layout rules, Reminders & client messages,
 * Layout templates (rename) and the Venues list filters.
 *
 * Pure rules (work in Node for the tests). Each returns {ok, value, error}:
 *   text(raw, {label, required, min, max, noEmoji, needLetter})   trims, collapses inner spaces,
 *        drops control characters; rejects < >, emoji (when noEmoji), too short / too long.
 *   number(raw, {label, required, integer, min, max, gt, dp})      plain digits only (no e-notation,
 *        no sign); leading zeros are fine ("007" -> 7); whole numbers when integer; at most dp decimals.
 *   dish({category, name, kind}, existing)  -> {ok, value, errors:{category,name,kind}}  (duplicate =
 *        same category + name, ignoring case and spaces - the same rule as the DB unique index 0073)
 *   layoutRule({spg, buf, bars})            -> {ok, value:{seatsPerGuest, buffetPer, bars}, errors}
 *   templatePlaceholders(text, allowed)     -> unknown {placeholders} (they would reach clients as typed)
 *   tokens(q) / matches(hay, tokens) / key(s)   list-filter helpers (venues search + city filter)
 * DOM helpers (browser only): fieldError(input, msg, anchor), clearErrors(root), showErrors(list).
 * An error message is a NEW <p class="fv-msg" role="alert"> each time, so the Control Center's
 * "unsaved changes" bar sees a failed save. Text only - never HTML. */
(function (G) {
  "use strict";
  var CTRL = /[\u0000-\u001f\u007f]/g;
  var EMOJI = /\p{Extended_Pictographic}|‍|[︎️]|[\u{1f1e6}-\u{1f1ff}]/u;
  var LETTER = /\p{L}/u;
  function str(v) { return String(v == null ? "" : v); }
  function clean(v) { return str(v).replace(CTRL, " ").replace(/\s+/g, " ").trim(); }
  function chars(s) { return Array.from(s).length; }
  function cap(s) { s = str(s); return s.charAt(0).toUpperCase() + s.slice(1); }
  function low(s) { s = str(s); return s.charAt(0).toLowerCase() + s.slice(1); }

  function text(raw, o) {
    o = o || {}; var label = o.label || "this field", s = clean(raw);
    if (!s) return o.required ? { ok: false, error: "Enter " + low(label) + "." } : { ok: true, value: "" };
    if (/[<>]/.test(s)) return { ok: false, error: cap(label) + " can't contain < or >." };
    if (o.noEmoji && EMOJI.test(s)) return { ok: false, error: "Emoji can't be used in " + low(label) + " - use plain text." };
    if (o.min && chars(s) < o.min) return { ok: false, error: cap(label) + " needs at least " + o.min + " characters." };
    if (o.max && chars(s) > o.max) return { ok: false, error: "Keep " + low(label) + " to " + o.max + " characters or fewer (now " + chars(s) + ")." };
    if (o.needLetter && !LETTER.test(s)) return { ok: false, error: cap(label) + " needs at least one letter." };
    return { ok: true, value: s };
  }

  function rangeText(o) {
    var kind = o.integer ? "a whole number" : "a number";
    if (o.gt != null && o.max != null) return kind + " more than " + o.gt + " and up to " + o.max;
    if (o.min != null && o.max != null) return kind + " from " + o.min + " to " + o.max;
    if (o.min != null) return kind + " of " + o.min + " or more";
    if (o.max != null) return kind + " up to " + o.max;
    return kind;
  }
  function number(raw, o) {
    o = o || {}; var label = o.label || "this value", s = str(raw).trim();
    var want = "Enter " + rangeText(o) + " for " + low(label) + ".";
    if (s === "") return o.required ? { ok: false, error: want } : { ok: true, value: null };
    if (/^-/.test(s)) return { ok: false, error: cap(label) + " can't be negative." };
    if (!/^\+?(\d+\.?\d*|\.\d+)$/.test(s)) return { ok: false, error: want };
    var n = Number(s.replace(/^\+/, ""));
    if (!isFinite(n)) return { ok: false, error: want };
    if (o.integer && !Number.isInteger(n)) return { ok: false, error: cap(label) + " must be a whole number (no decimals)." };
    var dec = (s.split(".")[1] || "").replace(/0+$/, "");
    if (!o.integer && o.dp != null && dec.length > o.dp) return { ok: false, error: "Use up to " + o.dp + " decimal place" + (o.dp === 1 ? "" : "s") + " for " + low(label) + "." };
    if ((o.gt != null && !(n > o.gt)) || (o.min != null && n < o.min) || (o.max != null && n > o.max)) return { ok: false, error: want };
    return { ok: true, value: n };
  }

  function key(s) { return clean(s).toLowerCase(); }

  var DISH_KINDS = ["veg", "nonveg", "special"];
  var DISH_LIMITS = { category: 60, name: 80 };
  function dish(f, existing) {
    f = f || {}; var errors = {};
    var c = text(f.category, { label: "Category", required: true, min: 2, max: DISH_LIMITS.category, noEmoji: true, needLetter: true });
    var n = text(f.name, { label: "Dish name", required: true, min: 2, max: DISH_LIMITS.name, noEmoji: true, needLetter: true });
    var k = str(f.kind || "veg");
    if (!c.ok) errors.category = c.error;
    if (!n.ok) errors.name = n.error;
    if (DISH_KINDS.indexOf(k) < 0) errors.kind = "Pick veg, non-veg or special.";
    if (c.ok && n.ok) {
      var ck = key(c.value), nk = key(n.value);
      var hit = (Array.isArray(existing) ? existing : []).filter(function (d) {
        return d && d.active !== false && key(d.category) === ck && key(d.name) === nk; })[0];
      if (hit) errors.name = "“" + clean(hit.name) + "” is already in " + clean(hit.category) + ".";
    }
    var ok = !Object.keys(errors).length;
    return { ok: ok, errors: errors, value: ok ? { category: c.value, name: n.value, kind: k } : null };
  }

  var LR = {
    spg: { label: "Seats per guest", required: true, gt: 0, max: 10, dp: 2 },
    buf: { label: "Buffet table per N guests", required: true, integer: true, min: 10, max: 500 },
    bars: { label: "Bars", required: true, integer: true, min: 0, max: 20 }
  };
  function layoutRule(f) {
    f = f || {}; var errors = {}, out = {};
    var a = number(f.spg, LR.spg), b = number(f.buf, LR.buf), c = number(f.bars, LR.bars);
    if (!a.ok) errors.spg = a.error; else out.seatsPerGuest = a.value;
    if (!b.ok) errors.buf = b.error; else out.buffetPer = b.value;
    if (!c.ok) errors.bars = c.error; else out.bars = c.value;
    var ok = !Object.keys(errors).length;
    return { ok: ok, errors: errors, value: ok ? out : null };
  }

  // {…} tokens the server will NOT fill in. public._comms_render replaces exact, case-sensitive "{client}" only,
  // so "{amout}", "{Client}" or "{ client }" would reach the client exactly as typed.
  function templatePlaceholders(t, allowed) {
    var bad = [], seen = {}, m, re = /\{([^{}\n]{0,40})\}/g, s = str(t);
    while ((m = re.exec(s))) { if ((allowed || []).indexOf(m[1]) < 0 && !seen[m[0]]) { seen[m[0]] = 1; bad.push(m[0]); } }
    return bad;
  }

  function tokens(q) { var s = key(q).slice(0, 100); return s ? s.split(" ") : []; }
  function matches(hay, toks) { var h = key(hay); for (var i = 0; i < toks.length; i++) if (h.indexOf(toks[i]) < 0) return false; return true; }

  var API = { clean: clean, text: text, number: number, dish: dish, layoutRule: layoutRule, LR: LR,
    DISH_KINDS: DISH_KINDS, DISH_LIMITS: DISH_LIMITS, templatePlaceholders: templatePlaceholders, tokens: tokens, matches: matches, key: key };

  if (typeof document !== "undefined") {
    var n = 0;
    // CSP: runtime CSS through the shared constructable-stylesheet helper (store-api.js), never inline <style>
    try { if (typeof G.__helmAdoptCss === "function") G.__helmAdoptCss(document,
      ".cc-row-errs:empty,.cc-row-ok:empty{display:none}.cc-row-errs .fv-msg{margin:4px 0 0}" +
      ".cc-row-ok{margin:6px 0 0;color:var(--safe-text,#0f7a43)}.lr_rng{font-weight:400;text-transform:none;letter-spacing:0;color:var(--ink-3)}" +
      ".lr_msg{align-self:center;margin-right:8px}.lr_msg[data-kind=ok]{color:var(--safe-text,#0f7a43)}.lr_err{margin:8px 0 0}" +
      ".st-renbox .fv-msg{flex-basis:100%}.cm-ferr-grp{outline:2px solid var(--bad,#c0392b);outline-offset:3px;border-radius:6px}"); } catch (_) {}
    // the visible box of a field: the HelmPhone wrapper for phone inputs, else the input itself
    var boxOf = function (input) { return (input && input.helmPhone && input.helmPhone.wrap) || input; };
    API.fieldError = function (input, msg, anchor) {
      if (!input) return null;
      var box = boxOf(input), old = input.__ccErr;
      if (old && old.parentNode) old.parentNode.removeChild(old);
      input.__ccErr = null;
      var ids = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(function (x) { return x && x.indexOf("ccerr_") !== 0; });
      if (!msg) {
        box.classList.remove("fv-error"); input.removeAttribute("aria-invalid");
        if (ids.length) input.setAttribute("aria-describedby", ids.join(" ")); else input.removeAttribute("aria-describedby");
        return null;
      }
      var p = document.createElement("p"); p.className = "fv-msg cc-ferr"; p.id = "ccerr_" + (++n); p.setAttribute("role", "alert");
      p.textContent = String(msg);
      var at = anchor || box;
      if (at.hasAttribute && at.hasAttribute("data-cc-errs")) at.appendChild(p);   // a list box under an add-row: messages in field order
      else at.parentNode.insertBefore(p, at.nextSibling);
      input.__ccErr = p; box.classList.add("fv-error"); input.setAttribute("aria-invalid", "true");
      ids.push(p.id); input.setAttribute("aria-describedby", ids.join(" "));
      if (!input.__ccClr) {   // typing / picking again clears the message for that field
        input.__ccClr = true;
        var clr = function () { if (input.__ccErr) API.fieldError(input, ""); };
        input.addEventListener("input", clr); input.addEventListener("change", clr);
      }
      return p;
    };
    API.clearErrors = function (root) {
      if (!root) return;
      Array.prototype.forEach.call(root.querySelectorAll("[aria-invalid='true']"), function (x) { if (x.__ccErr !== undefined) API.fieldError(x, ""); });
    };
    // list = [[input, msg, anchor?], ...]; shows every message, focuses the first; true when all fine
    API.showErrors = function (list) {
      var first = null;
      (list || []).forEach(function (x) { if (x && x[0] && x[1]) { API.fieldError(x[0], x[1], x[2]); if (!first) first = x[0]; } });
      if (first) { try { first.focus({ preventScroll: true }); first.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) { try { first.focus(); } catch (e) {} } }
      return !first;
    };
  }
  G.HelmCCFields = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
