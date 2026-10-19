/* budget-plan.js (0196) - Budget & margin built from the client's requirements.
 *
 * The quote's step 3 "Requirements" (event_requirements: Must-have / Nice-to-have / Optional) are
 * mapped to cost lines (event_costs) on the event's Budget page:
 *   - one line per requirement (deduplicated case-insensitively), grouped by priority, with
 *     Estimated cost, Vendor, Quoted to client (prefilled from the quote's own lines), Actual cost
 *     and Margin (amount + %), totals per group and overall, and warnings;
 *   - standard lines most events need (venue, catering, chairs, decor, sound & lights, staff,
 *     logistics, contingency) are offered in a collapsible "Suggested" group (one click to add);
 *   - requirements added later show as "New requirement: X - add to budget?".
 * Safety: lines are only ever ADDED (never deleted or overwritten by this file); a unique
 * (quote_id, requirement_key) index (0196) makes a second pull a no-op, so a reload or two tabs
 * never duplicate a line. Removing a requirement leaves its budget line as it is.
 * Pure helpers are exported for node tests (module.exports); the page uses window.HelmBudgetPlan.
 */
(function (root) {
  "use strict";
  var PRI_ORDER = ["mandatory", "nice", "optional"];
  var PRI_LABEL = { mandatory: "Must-have", nice: "Nice-to-have", optional: "Optional" };
  var PRI_RANK = { mandatory: 0, nice: 1, optional: 2 };
  var MIN_MARGIN_PCT = 15;
  var CONTINGENCY_PCT = 5;
  // Standard lines. `re` runs on folded text (lower case, accents removed). Order matters: the
  // first match names the line's kind (e.g. "Stage decor" -> decor, "Stage & lighting" -> sound).
  var STD = [
    { id: "venue", label: "Venue", re: /\b(venue|hall|lawn|banquet|ballroom|resort|location|space rent)/ },
    { id: "catering", label: "Catering", re: /(cater|food|menu|meal|buffet|plate|dinner|lunch|breakfast|snack|beverage|drink|\bbar\b|chef|kitchen|cuisine)/ },
    { id: "furniture", label: "Chairs & furniture", re: /(chair|seat|furniture|\btables?\b|sofa|lounge|couch|tent|shamiana)/ },
    { id: "decor", label: "Décor & flowers", re: /(decor|flor|flower|mandap|backdrop|centerpiece|centrepiece|drap|theme|balloon|garland)/ },
    { id: "sound", label: "Sound & lights", re: /(sound|light|audio|\bdj\b|\bav\b|\bled\b|stage|speaker|\bmics?\b|music|truss|projector)/ },
    { id: "staff", label: "Staff & crew", re: /(staff|crew|waiter|manpower|security|bouncer|\bhosts?\b|anchor|emcee|\bmc\b|helper|labou?r|coordinator)/ },
    { id: "logistics", label: "Logistics & transport", re: /(logistic|transport|truck|vehicle|delivery|travel|parking|valet|generator|\bpower\b|cartage)/ },
    { id: "contingency", label: "Contingency (" + CONTINGENCY_PCT + "%)", re: /(contingen|buffer|miscellaneous|\bmisc\b)/ }
  ];
  var STD_BY_ID = {}; STD.forEach(function (s) { STD_BY_ID[s.id] = s; });

  function fold(s) {
    var t = String(s == null ? "" : s);
    try { t = t.normalize("NFKD"); } catch (e) {}
    return t.replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }
  function reqKey(name) { var f = fold(name); return f ? ("req:" + f).slice(0, 300) : ""; }
  function classify(text) { var f = fold(text); if (!f) return null; for (var i = 0; i < STD.length; i++) if (STD[i].re.test(f)) return STD[i].id; return null; }
  function classifyAll(text) { var f = fold(text), out = []; if (!f) return out; STD.forEach(function (s) { if (s.re.test(f)) out.push(s.id); }); return out; }
  function num(v) { if (v === null || v === undefined || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; }
  function pos(v) { var n = num(v); return n != null && n > 0 ? n : 0; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function pctRound(n) { return n < 0 ? -Math.round(-n) : Math.round(n); }   // like Postgres round(): half away from zero

  /* r22 money: the "Planned margin" of the cost lines = the shared P&L's planned margin (0246 ledger: revenue minus
   * every estimated cost incl. crew wages), the same number as the Budget & margin card. pnl = event_pnl
   * (BPStore.vendorBills.pnl). Without the ledger (older database / offline) -> null and the lines' own margin is used. */
  function ledgerPlan(pnl) {
    if (!pnl || pnl.source !== "server" || pnl.rules !== "r21") return null;
    var m = num(pnl.margin_estimated), rev = num(pnl.net_revenue != null ? pnl.net_revenue : pnl.revenue);
    if (m == null) return null;
    return { margin: r2(m), pct: rev != null && rev !== 0 ? pctRound(m / rev * 100) : null, cost: num(pnl.cost_estimated) };
  }

  // The quote's own priced lines (before service charge / discount / tax), by standard line id.
  function quoteLines(p) {
    p = p && typeof p === "object" ? p : {};
    var out = {};
    var chairs = pos(p.chairs) * pos(p.chairPrice); if (chairs > 0) out.furniture = r2(chairs);
    var clientCater = !!(p.catering && p.catering.mode === "client");
    var cater = clientCater ? 0 : pos(p.guests) * pos(p.platePrice) + pos(p.catering && p.catering.amount);
    if (cater > 0) out.catering = r2(cater);
    var other = pos(p.other); if (other > 0) out.decor = r2(other);
    return out;
  }

  // requirements -> [{ key, name, priority, std }], one per folded name, highest priority kept
  function dedupeReqs(reqs) {
    var byKey = {}, order = [];
    (reqs || []).forEach(function (r) {
      var name = String((r && (r.service || r.title)) || "").replace(/\s+/g, " ").trim().slice(0, 200);
      var key = reqKey(name); if (!key) return;
      var pr = PRI_RANK[r.priority] != null ? r.priority : "mandatory";
      if (!byKey[key]) { byKey[key] = { key: key, name: name, priority: pr, std: classify(name) }; order.push(key); }
      else if (PRI_RANK[pr] < PRI_RANK[byKey[key].priority]) byKey[key].priority = pr;
    });
    return order.map(function (k) { return byKey[k]; });
  }

  // the whole page model. costs = event_costs rows, reqs = event_requirements rows,
  // pricing = quote.pricing, vendors = active vendors, o.dismissed = { key: true }
  function build(costs, reqs, pricing, vendors, o) {
    o = o || {};
    var dismissed = o.dismissed || {};
    var minPct = o.minMarginPct != null ? Number(o.minMarginPct) : MIN_MARGIN_PCT;
    var R = dedupeReqs(reqs), reqByKey = {}; R.forEach(function (r) { reqByKey[r.key] = r; });
    var Q = quoteLines(pricing), qUsed = {};
    var V = (vendors || []).map(function (v) {
      var svc = Array.isArray(v.services) ? v.services.join(" ") : "";
      return { id: v.id, name: v.name || "Vendor", kinds: classifyAll([v.category, svc, v.name].join(" ")) };
    });
    var covered = {}, stdSeen = {};
    var lines = (costs || []).map(function (c) {
      var key = c.requirement_key || null;
      var descKey = reqKey(c.description);
      var req = (key && reqByKey[key]) || (!key && reqByKey[descKey]) || null;
      var fromReq = !!(key && key.indexOf("req:") === 0);
      if (key) covered[key] = true;
      if (descKey) covered[descKey] = true;
      var std = (key && key.indexOf("std:") === 0 && STD_BY_ID[key.slice(4)]) ? key.slice(4) : classify(c.description);
      if (std) stdSeen[std] = true;
      var est = num(c.estimated), act = num(c.actual), quoted = num(c.quoted);
      if (quoted != null && std) qUsed[std] = true;
      var cost = act != null ? act : (est || 0);
      var noEstimate = !(est > 0) && act == null;
      // no cost typed yet: no margin (a 100 % margin on an un-costed line would mislead)
      var margin = (quoted != null && !noEstimate) ? r2(quoted - cost) : null;
      var priority = req ? req.priority : (PRI_RANK[c.priority] != null ? c.priority : null);
      var vm = std ? V.filter(function (v) { return v.kinds.indexOf(std) >= 0; }) : [];
      return { id: c.id, description: c.description || "", category: c.category || "", kind: c.kind || "internal",
        key: key, priority: priority, fromReq: fromReq || !!req, reqRemoved: fromReq && !req, std: std,
        estimated: est, actual: act, quoted: quoted, cost: cost, margin: margin,
        pct: (margin != null && quoted > 0) ? Math.round(margin / quoted * 100) : null,
        vendor_id: c.vendor_id || null, booking: !!c.booking_id,
        vMatch: vm, vOther: V.filter(function (v) { return vm.indexOf(v) < 0; }),
        vMissing: !!(c.vendor_id && !V.some(function (v) { return v.id === c.vendor_id; })),
        noEstimate: noEstimate };
    });
    R.forEach(function (r) { if (r.std) stdSeen[r.std] = true; });

    // requirement lines still to add (priority order), each with its quote prefill
    var missing = R.filter(function (r) { return !covered[r.key]; })
      .sort(function (a, b) { return PRI_RANK[a.priority] - PRI_RANK[b.priority]; })
      .map(function (r) {
        var q = null; if (r.std && Q[r.std] != null && !qUsed[r.std]) { q = Q[r.std]; qUsed[r.std] = true; }
        return { key: r.key, description: r.name, priority: r.priority, quoted: q, std: r.std,
          category: r.std ? STD_BY_ID[r.std].label : null, dismissed: !!dismissed[r.key] };
      });
    var estSum = lines.reduce(function (a, l) { return a + (l.std === "contingency" ? 0 : (l.estimated || 0)); }, 0);
    var suggestions = STD.filter(function (s) { return !stdSeen[s.id] && !covered["std:" + s.id]; }).map(function (s) {
      var q = (Q[s.id] != null && !qUsed[s.id]) ? Q[s.id] : null;
      return { key: "std:" + s.id, id: s.id, description: s.label, quoted: q,
        estimated: s.id === "contingency" ? Math.round(estSum * CONTINGENCY_PCT / 100) : 0 };
    });

    function totals(ls) {
      var t = { count: ls.length, estimated: 0, actual: 0, quoted: 0, cost: 0, hasQuoted: false, incomplete: false };
      ls.forEach(function (l) { t.estimated += l.estimated || 0; t.actual += l.actual || 0; t.cost += l.cost;
        if (l.quoted != null) { t.quoted += l.quoted; t.hasQuoted = true; if (l.noEstimate) t.incomplete = true; } });
      t.estimated = r2(t.estimated); t.actual = r2(t.actual); t.quoted = r2(t.quoted); t.cost = r2(t.cost);
      t.margin = r2(t.quoted - t.cost);
      t.pct = t.quoted > 0 ? Math.round(t.margin / t.quoted * 100) : null;
      return t;
    }
    var groups = PRI_ORDER.map(function (p) { return { id: p, label: PRI_LABEL[p], lines: lines.filter(function (l) { return l.priority === p; }) }; })
      .concat([{ id: "other", label: "Other lines", lines: lines.filter(function (l) { return !l.priority; }) }])
      .filter(function (g) { return g.lines.length; });
    groups.forEach(function (g) { g.totals = totals(g.lines); });
    var all = totals(lines);
    var plan = ledgerPlan(o.pnl);
    if (plan) { all.lineMargin = all.margin; all.linePct = all.pct; all.margin = plan.margin; all.pct = plan.pct; all.ledger = true; all.hasQuoted = true; }

    var warnings = [];
    var mustNoEst = lines.filter(function (l) { return l.priority === "mandatory" && l.noEstimate; });
    if (mustNoEst.length) warnings.push({ kind: "must", text: mustNoEst.length + " must-have item" + (mustNoEst.length === 1 ? " has" : "s have") + " no estimated cost yet: " +
      mustNoEst.map(function (l) { return l.description; }).join(", ") + "." });
    if (all.ledger || (all.hasQuoted && all.quoted > 0)) {
      if (all.margin < 0) warnings.push({ kind: "neg", text: all.ledger ? "Planned margin is negative - the estimated costs (incl. crew wages) are higher than the event's revenue." : "Planned margin is negative - costs are higher than what the client is quoted for these lines." });
      else if (all.pct != null && all.pct < minPct) warnings.push({ kind: "low", text: "Planned margin is " + all.pct + "%, below the " + minPct + "% target." });
    }
    var negLines = lines.filter(function (l) { return l.margin != null && l.margin < 0; });
    if (negLines.length) warnings.push({ kind: "negline", text: negLines.length + " line" + (negLines.length === 1 ? " costs" : "s cost") + " more than quoted: " +
      negLines.map(function (l) { return l.description; }).join(", ") + "." });

    return { lines: lines, groups: groups, totals: all, warnings: warnings, missing: missing, suggestions: suggestions,
      reqCount: R.length, hasReqLines: lines.some(function (l) { return l.key && l.key.indexOf("req:") === 0; }), minMarginPct: minPct };
  }

  // first visit: pull every requirement in when none was pulled before (and some are missing)
  function shouldAutoPull(m) { return !!(m && !m.hasReqLines && m.missing.length > 0); }

  // event_costs insert rows (only the 0196 columns + the ones the page already writes)
  function reqRow(r) { return { description: r.description, kind: "internal", estimated: 0, actual: null,
    category: r.category || null, requirement_key: r.key, priority: r.priority, quoted: r.quoted != null ? r.quoted : null }; }
  function stdRow(s) { return { description: s.description, kind: "internal", estimated: s.estimated || 0, actual: null,
    category: "Standard", requirement_key: s.key, priority: null, quoted: s.quoted != null ? s.quoted : null }; }

  var API = { PRI_ORDER: PRI_ORDER, PRI_LABEL: PRI_LABEL, STD: STD, MIN_MARGIN_PCT: MIN_MARGIN_PCT, CONTINGENCY_PCT: CONTINGENCY_PCT,
    fold: fold, reqKey: reqKey, classify: classify, classifyAll: classifyAll, quoteLines: quoteLines, dedupeReqs: dedupeReqs,
    build: build, shouldAutoPull: shouldAutoPull, reqRow: reqRow, stdRow: stdRow, ledgerPlan: ledgerPlan };

  /* ------------------------------------------------------------------ page UI (browser only) */
  if (typeof document !== "undefined") {
    var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
    var autoTried = {};
    var vendorCache = null;
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    function dismissedFor(q) { try { return JSON.parse(lsGet("helm.budget.dismissed." + q) || "{}") || {}; } catch (e) { return {}; } }
    function toast(m, t) { try { BPUI.toast(m, { type: t || "info" }); } catch (e) {} }
    function friendly(e, action) { try { return BPUI.friendlyError(e, { action: action, setupHint: "APPLY-0196.sql" }); } catch (_) { return (e && e.message) || "Something went wrong."; } }

    // ctx: { el, quoteId, pricing, costs, inr, canEdit, canDelete, reload, pnl (r22: event_pnl, optional) }
    API.render = async function (ctx) {
      var S = window.BPStore, el = ctx.el, inr = ctx.inr, q = ctx.quoteId;
      var ready = false; try { ready = await S.budget.planReady(); } catch (e) { ready = false; }
      var reqs = []; try { reqs = (await S.discovery.listReqs(q)) || []; } catch (e) { reqs = []; }
      if (vendorCache == null) { try { vendorCache = (await S.vendors.listAll()) || []; } catch (e) { vendorCache = []; } }
      var dismissed = dismissedFor(q);
      var m = build(ctx.costs || [], reqs, ctx.pricing, vendorCache, { dismissed: dismissed, pnl: ctx.pnl });
      // first visit: map the requirements automatically (once per event per device, never twice)
      if (ready && ctx.canEdit && shouldAutoPull(m) && !autoTried[q] && !lsGet("helm.budget.autopull." + q)) {
        autoTried[q] = true; lsSet("helm.budget.autopull." + q, "1");
        try { var n = await S.budget.addPlanLines(q, m.missing.map(reqRow));
          if (n) { toast("Added " + n + " budget line" + (n === 1 ? "" : "s") + " from the client's requirements.", "ok"); await ctx.reload(); return; } }
        catch (e) { try { console.warn("budget auto-pull", e); } catch (_) {} }
      }
      el.__ctx = ctx; el.__model = m; el.__ready = ready;
      wire(el);
      var ed = !!ctx.canEdit, ok = ready && ed;
      var newReqs = m.missing.filter(function (r) { return !r.dismissed; });
      var T = m.totals;
      el.innerHTML =
        `<div class="bp-head">
          <div class="bp-sum">
            <div><span class="l">Total estimated cost</span><b class="num">${inr(T.estimated)}</b></div>
            <div><span class="l">Total quoted</span><b class="num">${T.hasQuoted ? inr(T.quoted) : "—"}</b></div>
            <div><span class="l">Planned margin</span><b class="num ${T.margin < 0 ? "neg" : "pos"}">${T.hasQuoted ? inr(T.margin) : "—"}</b>${T.pct != null ? `<small>${Number(T.pct)}%</small>` : ""}${T.ledger ? `<small class="bp-inc bp-ledger">all estimated costs incl. crew wages - same as Budget &amp; margin</small>` : (T.incomplete ? `<small class="bp-inc">some quoted lines have no cost yet</small>` : "")}</div>
          </div>
          ${ok ? `<button type="button" class="btn sm" data-pl-pull>↧ Pull from requirements</button>` : ""}
        </div>
        ${!ready ? `<p class="bp-note">Requirement mapping, vendors and quoted prices per line need the database update APPLY-0196.sql. Estimated and actual costs still work.</p>` : ""}
        ${m.warnings.length ? `<div class="bp-warn" role="status">${m.warnings.map(function (w) { return `<div class="w ${esc(w.kind)}">⚠ ${esc(w.text)}</div>`; }).join("")}</div>` : ""}
        ${ok && newReqs.length ? `<div class="bp-new" aria-live="polite">
            ${newReqs.map(function (r) { return `<div class="bp-newrow"><span>New requirement: <b>${esc(r.description)}</b> <span class="pri ${esc(r.priority)}">${esc(PRI_LABEL[r.priority])}</span> — add to budget?</span>
              <span class="bp-newact"><button type="button" class="btn sm primary" data-pl-addreq="${esc(r.key)}">＋ Add</button><button type="button" class="btn sm" data-pl-dismiss="${esc(r.key)}">Dismiss</button></span></div>`; }).join("")}
            ${newReqs.length > 1 ? `<div class="bp-newrow"><span></span><button type="button" class="btn sm" data-pl-addall>＋ Add all ${Number(newReqs.length)}</button></div>` : ""}
          </div>` : ""}
        ${m.groups.length ? m.groups.map(function (g) { return `<section class="bp-group" data-group="${esc(g.id)}">
          <div class="bp-ghead">${g.id === "other" ? `<b>${esc(g.label)}</b>` : `<span class="pri ${esc(g.id)}">${esc(g.label)}</span>`}<span class="bp-gcount">${Number(g.lines.length)} line${g.lines.length === 1 ? "" : "s"}</span></div>
          <div class="table-scroll"><table class="bp-table">
            <colgroup><col class="c-line"><col class="c-est"><col class="c-ven"><col class="c-quo"><col class="c-act"><col class="c-mar"><col class="c-x"></colgroup>
            <thead><tr><th scope="col">Line</th><th scope="col" class="num">Estimated cost</th><th scope="col">Vendor</th><th scope="col" class="num">Quoted to client</th><th scope="col" class="num">Actual cost</th><th scope="col" class="num">Margin</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>${g.lines.map(function (l) { return `<tr data-id="${esc(l.id)}" class="${l.margin != null && l.margin < 0 ? "neg" : ""}">
              <td><b>${esc(l.description)}</b>${l.priority && g.id === "other" ? ` <span class="pri ${esc(l.priority)}">${esc(PRI_LABEL[l.priority])}</span>` : ""}
                <div class="bp-meta"><span class="kind ${esc(l.kind)}">${esc(l.kind === "vendor" ? "Vendor" : l.kind === "other" ? "Other" : "Internal")}</span>${l.category ? ` ${esc(l.category)}` : ""}${l.reqRemoved ? ` · <span class="bp-gone">requirement removed</span>` : ""}${l.priority === "mandatory" && l.noEstimate ? ` · <span class="bp-need">needs an estimate</span>` : ""}</div></td>
              <td class="num">${ed ? `<input class="cin" type="number" min="0" inputmode="decimal" value="${l.estimated != null ? Number(l.estimated) : ""}" placeholder="0" data-pl-est="${esc(l.id)}" aria-label="Estimated cost for ${esc(l.description)}">` : inr(l.estimated || 0)}</td>
              <td>${ok ? `<select class="bp-vsel" data-pl-vendor="${esc(l.id)}" aria-label="Vendor for ${esc(l.description)}"><option value="">— none —</option>${l.vMissing ? `<option value="${esc(l.vendor_id)}" selected>Saved vendor</option>` : ""}${l.vMatch.length ? `<optgroup label="Matching vendors">${l.vMatch.map(function (v) { return `<option value="${esc(v.id)}"${v.id === l.vendor_id ? " selected" : ""}>${esc(v.name)}</option>`; }).join("")}</optgroup>` : ""}${l.vOther.length ? `<optgroup label="${l.vMatch.length ? "Other vendors" : "All vendors"}">${l.vOther.map(function (v) { return `<option value="${esc(v.id)}"${v.id === l.vendor_id ? " selected" : ""}>${esc(v.name)}</option>`; }).join("")}</optgroup>` : ""}</select>` : esc((l.vMatch.concat(l.vOther).filter(function (v) { return v.id === l.vendor_id; })[0] || { name: l.vendor_id ? "Saved vendor" : "—" }).name)}</td>
              <td class="num">${ok ? `<input class="cin" type="number" min="0" inputmode="decimal" value="${l.quoted != null ? Number(l.quoted) : ""}" placeholder="—" data-pl-quoted="${esc(l.id)}" aria-label="Quoted to client for ${esc(l.description)}">` : (l.quoted != null ? inr(l.quoted) : "—")}</td>
              <td class="num">${ed ? `<input class="cin" type="number" min="0" inputmode="decimal" value="${l.actual != null ? Number(l.actual) : ""}" placeholder="—" data-pl-act="${esc(l.id)}" aria-label="Actual cost for ${esc(l.description)}">` : (l.actual != null ? inr(l.actual) : "—")}</td>
              <td class="num">${l.margin == null ? "—" : `<span class="${l.margin < 0 ? "neg" : "pos"}">${inr(l.margin)}</span>${l.pct != null ? `<small>${Number(l.pct)}%</small>` : ""}`}</td>
              <td>${ctx.canDelete ? `<button type="button" class="rm" data-pl-del="${esc(l.id)}" aria-label="Remove cost line ${esc(l.description)}">✕</button>` : ""}</td>
            </tr>`; }).join("")}</tbody>
            <tfoot><tr><th scope="row">${esc(g.label)} total</th><td class="num">${inr(g.totals.estimated)}</td><td></td><td class="num">${g.totals.hasQuoted ? inr(g.totals.quoted) : "—"}</td><td class="num">${g.totals.actual ? inr(g.totals.actual) : "—"}</td>
              <td class="num">${g.totals.hasQuoted && !g.totals.incomplete ? `<span class="${g.totals.margin < 0 ? "neg" : "pos"}">${inr(g.totals.margin)}</span>${g.totals.pct != null ? `<small>${Number(g.totals.pct)}%</small>` : ""}` : "—"}</td><td></td></tr></tfoot>
          </table></div></section>`; }).join("")
        : `<div class="empty">No cost lines yet.${m.reqCount ? "" : " Add the client's requirements in the quote (step 3) and they appear here, or add a suggested line below."}</div>`}
        ${ok && (m.suggestions.length || m.missing.some(function (r) { return r.dismissed; })) ? `<details class="bp-sugg">
            <summary>Suggested lines <span class="bp-gcount">${Number(m.suggestions.length + m.missing.filter(function (r) { return r.dismissed; }).length)}</span></summary>
            <p class="sub">Lines most events need. Add one with a click, then type its estimated cost.</p>
            <div class="bp-chips">${m.suggestions.map(function (s) { return `<button type="button" class="btn sm" data-pl-addstd="${esc(s.id)}">＋ ${esc(s.description)}${s.quoted != null ? ` <small>quoted ${inr(s.quoted)}</small>` : ""}</button>`; }).join("")}${m.missing.filter(function (r) { return r.dismissed; }).map(function (r) { return `<button type="button" class="btn sm" data-pl-addreq="${esc(r.key)}">＋ ${esc(r.description)} <span class="pri ${esc(r.priority)}">${esc(PRI_LABEL[r.priority])}</span></button>`; }).join("")}</div>
          </details>` : ""}`;
    };

    function wire(el) {
      if (el.__wired) return; el.__wired = true;
      var S = function () { return window.BPStore; };
      function after(fn, action, btn) {
        var run = async function () { try { await fn(); } catch (e) { toast(friendly(e, action), "err"); } try { await el.__ctx.reload(); } catch (_) {} };
        return (window.BPUI && BPUI.guard && btn) ? BPUI.guard(btn, run) : run();
      }
      function money(inp, field) {
        if (inp.value === "") return { ok: true, value: null };
        return S().validate.money(inp.value, { field: field });
      }
      el.addEventListener("change", function (e) {
        var t = e.target, id;
        if ((id = t.getAttribute("data-pl-est"))) {
          var r = money(t, "Estimated cost"); if (!r.ok) { toast(r.error, "err"); return; }
          after(function () { return S().budget.updateCost(id, { estimated: r.value == null ? 0 : r.value }); }, "save the estimated cost", t);
        } else if ((id = t.getAttribute("data-pl-quoted"))) {
          var rq = money(t, "Quoted to client"); if (!rq.ok) { toast(rq.error, "err"); return; }
          after(function () { return S().budget.updateCost(id, { quoted: rq.value }); }, "save the quoted price", t);
        } else if ((id = t.getAttribute("data-pl-act"))) {
          var ra = money(t, "Actual cost"); if (!ra.ok) { toast(ra.error, "err"); return; }
          after(function () { return S().budget.updateCost(id, { actual: ra.value }); }, "save the actual cost", t);
        } else if ((id = t.getAttribute("data-pl-vendor"))) {
          var v = t.value || null;
          // a line paid to a vendor counts as vendor spend (P&L keeps vendor bills and vendor lines from double counting)
          after(function () { return S().budget.updateCost(id, v ? { vendor_id: v, kind: "vendor" } : { vendor_id: null }); }, "save the vendor", t);
        }
      });
      el.addEventListener("click", async function (e) {
        var b = e.target.closest && e.target.closest("button"); if (!b || !el.contains(b)) return;
        var m = el.__model, ctx = el.__ctx; if (!m || !ctx) return;
        var q = ctx.quoteId, k;
        if (b.hasAttribute("data-pl-pull")) {
          var rows = m.missing.map(reqRow);
          if (!rows.length) { toast(m.reqCount ? "Every requirement is already in the budget." : "This event has no requirements yet. Add them in the quote (step 3).", "info"); return; }
          after(async function () { var n = await S().budget.addPlanLines(q, rows); toast(n ? "Added " + n + " line" + (n === 1 ? "" : "s") + " from the requirements." : "Every requirement is already in the budget.", n ? "ok" : "info"); }, "pull the requirements", b);
        } else if (b.hasAttribute("data-pl-addall")) {
          after(async function () { await S().budget.addPlanLines(q, m.missing.filter(function (r) { return !r.dismissed; }).map(reqRow)); }, "add the requirements", b);
        } else if ((k = b.getAttribute("data-pl-addreq"))) {
          var r = m.missing.filter(function (x) { return x.key === k; })[0]; if (!r) return;
          after(async function () { await S().budget.addPlanLines(q, [reqRow(r)]);
            var d = dismissedFor(q); if (d[k]) { delete d[k]; lsSet("helm.budget.dismissed." + q, JSON.stringify(d)); } }, "add the requirement", b);
        } else if ((k = b.getAttribute("data-pl-dismiss"))) {
          var d = dismissedFor(q); d[k] = true; lsSet("helm.budget.dismissed." + q, JSON.stringify(d)); await ctx.reload();
        } else if ((k = b.getAttribute("data-pl-addstd"))) {
          var s = m.suggestions.filter(function (x) { return x.id === k; })[0]; if (!s) return;
          after(async function () { await S().budget.addPlanLines(q, [stdRow(s)]); }, "add the line", b);
        } else if ((k = b.getAttribute("data-pl-del"))) {
          var l = m.lines.filter(function (x) { return x.id === k; })[0]; if (!l) return;
          var money2 = (l.estimated || 0) + (l.actual || 0) + (l.quoted || 0);
          var msg = "Remove the cost line “" + l.description + "”?" + (money2 > 0 ? " It has amounts entered - they are removed with it." : "");
          if (!(await BPUI.confirm(msg, { title: "Remove cost line?", danger: true }))) return;
          after(function () { return S().budget.removeCost(k); }, "remove the cost line", b);
        }
      });
    }
    root.HelmBudgetPlan = API;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})(typeof window !== "undefined" ? window : globalThis);
