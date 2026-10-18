/* PP1028: small pure helpers shared by flow.html, quotes.html and builder.js (unit-tested in
   test/prepush-1028.test.mjs). No DOM work except wireExclusive. */
(function (global) {
  "use strict";
  function n(v) { if (v === null || v === undefined || String(v).trim() === "") return 0; const x = Number(v); return isFinite(x) ? x : 0; }
  // #1 client-approval wording from the REAL approval state (an internal Confirm & lock is not an approval)
  function approvalState(ap, hasToken, paid) {
    ap = String(ap || "none");
    if (paid || ap === "paid") return "Booking confirmed.";
    if (ap === "approved") return "Client approved — advance pending.";
    if (ap === "sent" || hasToken) return "Awaiting client approval.";
    return "Not sent yet.";
  }
  // #2 auto-load the priced default layout only on a brand-new, unpriced, unlocked quote (or when asked: ?gen=1)
  function builderAutoDefault(q, priced, genRequested) {
    if (genRequested) return true;
    q = q || {};
    const locked = q.status === "confirmed" || q.approvalStatus === "sent" || q.approvalStatus === "approved" || q.approvalStatus === "paid";
    return !locked && !priced;
  }
  // #3/#5 ₹ and % discount are mutually exclusive: % wins when set (it re-prices as a %), never both
  function pick(amount, pct) {
    const p = n(pct), a = n(amount);
    if (p > 0) return { discount: 0, discountPct: Math.min(p, 100) };
    return { discount: a > 0 ? a : 0, discountPct: 0 };
  }
  // #6 negative / out-of-range raw values are rejected with a message (never flipped or dropped silently)
  function rawError(amount, pct) {
    if (n(amount) < 0 || String(amount == null ? "" : amount).trim().charAt(0) === "-") return "Discount can't be negative.";
    if (n(pct) < 0 || String(pct == null ? "" : pct).trim().charAt(0) === "-") return "Discount % can't be negative.";
    if (n(pct) > 100) return "Discount % can't be more than 100.";
    return "";
  }
  // 1029 #4: a field the number hardener just REJECTED (e.g. "-500" cleared) blocks the save until re-entered
  function rejectedError(els) {
    for (var i = 0; i < (els || []).length; i++) { var e = els[i];
      if (e && e.getAttribute && e.getAttribute("data-rejected") && String(e.value || "").trim() === "") return "Discount can't be negative — enter a positive amount (or leave it at 0) before saving."; }
    return "";
  }
  // 1029 #1: ONE total for the live rail and the save — computed from the exact object that is stored
  function withTotal(pricing, quoteTotal) {
    var t = quoteTotal(pricing); var out = Object.assign({}, pricing, { computed: t, total: t.total }); return out;
  }
  function wireExclusive(amtEl, pctEl) {
    if (!amtEl || !pctEl || amtEl.__ppx) return; amtEl.__ppx = pctEl.__ppx = true;
    amtEl.addEventListener("input", function () { if (n(amtEl.value) > 0) pctEl.value = "0"; });
    pctEl.addEventListener("input", function () { if (n(pctEl.value) > 0) amtEl.value = "0"; });
  }
  // #4 is the live total different from the latest saved version?
  function differs(live, saved) { const a = Number(live), b = Number(saved); return isFinite(a) && isFinite(b) && live !== null && saved !== null && Math.abs(a - b) > 0.5; }
  // #7 the min/max budget check only applies when BOTH are filled
  function budgetBad(a, b) { const sa = String(a == null ? "" : a).trim(), sb = String(b == null ? "" : b).trim();
    if (sa === "" || sb === "") return false; const x = Number(sa), y = Number(sb); return isFinite(x) && isFinite(y) && x > y; }
  // confirm-1018 #1: ONE discount rule, shown line by line (the same formula the server stamps the
  // total with - helm_quote_total_canonical / pricing._canon):
  //   1. subtotal = chairs + decor/setup + catering (+ service charge)
  //   2. the coupon AND the manual discount both come off that subtotal (a % is a % of the subtotal);
  //      the manual discount is EITHER a Rs amount OR a % (never both - pick() above)
  //   3. together they never go below 0 (capped at the subtotal)
  //   4. GST is charged on what is left (the taxable value)
  // lines(p, t) -> [{key, label, amount}] for the discount part, coupon first, each line is what it
  // really takes off (so the lines always add up to t.discount, even when the cap applies).
  function couponValue(p, subtotal) {
    var c = p && p.coupon; if (!c || !(n(c.value) > 0)) return 0;
    return c.kind === "percent" ? subtotal * n(c.value) / 100 : n(c.value);
  }
  function manualValue(p, subtotal) { return n(p && p.discount) + subtotal * n(p && p.discountPct) / 100; }
  function discountLines(p, t) {
    p = p || {}; t = t || {};
    var sub = n(t.subtotal), left = sub, out = [];
    var c = couponValue(p, sub), m = manualValue(p, sub);
    if (c > 0) {
      var ca = Math.min(c, left); left -= ca;
      var code = String(p.couponCode || "").slice(0, 40), cv = n(p.coupon && p.coupon.value);
      out.push({ key: "coupon", label: "Coupon" + (code ? " " + code : "") + (p.coupon && p.coupon.kind === "percent" ? " (" + cv + "%)" : ""), amount: ca });
    }
    if (m > 0) {
      var ma = Math.min(m, left); left -= ma;
      var pct = n(p.discountPct);
      out.push({ key: "discount", label: pct > 0 ? "Discount " + pct + "%" : "Discount", amount: ma });
    }
    return out;
  }
  // the problems that block a save, in the words the owner sees (null = fine)
  function discountProblem(p, t, activeCodes) {
    p = p || {}; t = t || {};
    var raw = rawError(p.discount, p.discountPct); if (raw) return { field: n(p.discountPct) < 0 || n(p.discountPct) > 100 ? "pct" : "amount", message: raw };
    var sub = n(t.subtotal);
    if (n(p.discount) > 0 && n(p.discount) > sub + 0.5) return { field: "amount", message: "Discount is more than the subtotal." };
    if (p.couponCode && Array.isArray(activeCodes) && activeCodes.map(function (x) { return String(x).toLowerCase(); }).indexOf(String(p.couponCode).toLowerCase()) < 0)
      return { field: "coupon", message: "Coupon " + p.couponCode + " is no longer active. Pick another coupon or none." };
    var both = couponValue(p, sub) + manualValue(p, sub);
    if (couponValue(p, sub) > 0 && manualValue(p, sub) > 0 && both > sub + 0.5)
      return { field: "amount", message: "Coupon + discount is more than the subtotal." };
    return null;
  }
  global.HelmPriceLines = { discountLines: discountLines, discountProblem: discountProblem,
    RULE: "The coupon and the discount both come off the subtotal (a % is worked out on the subtotal). Use a ₹ discount or a % discount, not both. GST is added after the discounts." };
  global.HelmApprovalState = approvalState;
  global.HelmBuilderAutoDefault = builderAutoDefault;
  global.HelmDiscount = { pick: pick, rawError: rawError, rejectedError: rejectedError, wireExclusive: wireExclusive };
  global.HelmQuoteTotal = { withTotal: withTotal };
  global.HelmVersionLabel = { differs: differs };
  global.HelmBudgetRange = { bad: budgetBad };
})(typeof window !== "undefined" ? window : globalThis);
