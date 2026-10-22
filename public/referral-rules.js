/* referral-rules.js - r29 referral program, PHASE 1 (UI only). The plain rules of "refer a studio, both get a month free",
   written ONCE so the studio page, the sign-up field, the HQ page and the tests all say the same thing. Pure functions,
   no network, no storage, no DOM. Phase 2 moves the deciding parts to the server (the browser never decides a reward);
   these stay as the display rules + the test oracle. See REFERRAL-PROGRAM-PLAN.md.
   Works in the browser (window.HelmReferral) and in node tests (module.exports). */
(function (root) {
  "use strict";
  var DAY = 864e5;
  var RULES = {
    holdDays: 14,            // the reward is confirmed 14 days after the new studio's first real (non-zero) payment
    payWithinDays: 60,       // a referred studio that has not paid within 60 days of signing up does not count
    linkDays: 60,            // a clicked link is remembered for 60 days (last link wins; a typed code beats a link)
    lateCodeDays: 14,        // a code can be added after sign-up only through support, within 14 days and before the first payment
    capPerYear: 12,          // at most 12 free months earned in any rolling 12 months
    heldMonths: 6,           // a referrer still on trial / not paying: rewards wait up to 6 months for their first payment
    frozenMonths: 6,         // a referrer who cancels: unused months are frozen, back if they return within 6 months
    expiryMonths: 24,        // an unused free month expires 24 months after it was earned
    velocityPerDay: 5        // more than 5 sign-ups on one code in 24 hours: held for a person to review
  };
  /* USD list prices (public /pricing, plan-cards.js). A free month is "one month of your plan", never cash. */
  var PLAN_USD = { starter: { name: "Starter", monthly: 24, yearly: 240 }, studio: { name: "Studio", monthly: 59, yearly: 590 } };

  var CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
  function normalizeCode(raw) {
    var s = String(raw == null ? "" : raw).trim().toUpperCase().replace(/\s+/g, "");
    return CODE_RE.test(s) ? s : "";
  }
  /* a personal code: the studio's name in capitals (max 8 letters) + 4 characters with no look-alikes (0/O, 1/I/L) */
  var SAFE = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  function personalCode(studioName, rand) {
    var base = String(studioName || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "HELM";
    var r = typeof rand === "function" ? rand : Math.random, tail = "";
    for (var i = 0; i < 4; i++) tail += SAFE.charAt(Math.floor(r() * SAFE.length) % SAFE.length);
    return base + "-" + tail;
  }
  function shareLink(code, origin) {
    var c = normalizeCode(code); if (!c) return "";
    return String(origin || "https://helm.events").replace(/\/+$/, "") + "/r/" + encodeURIComponent(c);
  }

  /* referral statuses, in the order a studio moves through them */
  var STATUS = {
    clicked:       { label: "Clicked",                 tone: "muted", step: 1, help: "Opened your link. Nothing is saved about them until they sign up." },
    signed_up:     { label: "Signed up",               tone: "info",  step: 2, help: "Created a Helm account with your code." },
    trial:         { label: "On free trial",           tone: "info",  step: 2, help: "Trying Helm for 8 days." },
    first_month:   { label: "Paid plan, free month",   tone: "info",  step: 3, help: "Picked a plan. Their first paid month is free; their first payment is after it." },
    hold:          { label: "Paid, checking",          tone: "warn",  step: 3, help: "Paid their first bill. We wait 14 days for refunds or disputes, then your month is confirmed." },
    review:        { label: "Under review",            tone: "warn",  step: 3, help: "Our team is checking this one by hand. Nothing is wrong yet." },
    qualified:     { label: "Paid ✓ reward earned", tone: "good",  step: 4, help: "They are a paying studio. You earned 1 free month." },
    not_qualified: { label: "Not qualified",           tone: "bad",   step: 0, help: "This sign-up does not earn a reward." }
  };
  var REASONS = {
    self_referral:    "Same person or business as the referrer (same e-mail, phone, device or payment card).",
    existing:         "Already had a Helm workspace before they used your link.",
    refunded:         "Refunded or disputed their first payment.",
    no_payment:       "Did not start paying within 60 days of signing up.",
    cancelled:        "Cancelled before their first payment was confirmed.",
    code_after:       "The code was added too late (after the first payment, or more than 14 days after sign-up).",
    cap:              "You already earned the most free months allowed in 12 months (12).",
    duplicate:        "This studio already used another referral or partner code.",
    fraud:            "Rejected after a manual review."
  };
  var REWARD = {
    held:      { label: "Waiting for your first payment", tone: "warn" },
    scheduled: { label: "Upcoming",  tone: "info" },
    applied:   { label: "Used",      tone: "good" },
    frozen:    { label: "Frozen (subscription cancelled)", tone: "muted" },
    expired:   { label: "Expired",   tone: "muted" },
    reversed:  { label: "Reversed",  tone: "bad" }
  };

  /* can this referral be rewarded? Deterministic, from the facts only. Returns { ok, status, reason } */
  function qualifies(r, now) {
    now = now || Date.now();
    if (!r) return { ok: false, status: "not_qualified", reason: "fraud" };
    if (r.existingCustomer) return { ok: false, status: "not_qualified", reason: "existing" };
    if (r.selfReferral) return { ok: false, status: "not_qualified", reason: "self_referral" };
    if (r.otherCodeUsed) return { ok: false, status: "not_qualified", reason: "duplicate" };
    if (r.rejected) return { ok: false, status: "not_qualified", reason: "fraud" };
    if (r.refunded || r.chargeback) return { ok: false, status: "not_qualified", reason: "refunded" };
    if (r.codeAddedAt && r.signedUpAt && (r.codeAddedAt - r.signedUpAt > RULES.lateCodeDays * DAY || (r.firstPaidAt && r.codeAddedAt > r.firstPaidAt)))
      return { ok: false, status: "not_qualified", reason: "code_after" };
    if (!r.firstPaidAt) {
      if (r.cancelled) return { ok: false, status: "not_qualified", reason: "cancelled" };
      if (r.signedUpAt && now - r.signedUpAt > RULES.payWithinDays * DAY) return { ok: false, status: "not_qualified", reason: "no_payment" };
      return { ok: false, status: r.planStartedAt ? "first_month" : (r.signedUpAt ? "trial" : "clicked"), reason: "" };
    }
    if (r.flagged && !r.approved) return { ok: false, status: "review", reason: "" };
    if (now - r.firstPaidAt < RULES.holdDays * DAY) return { ok: false, status: "hold", reason: "" };
    if (r.cancelled && r.cancelledAt && r.cancelledAt - r.firstPaidAt < RULES.holdDays * DAY) return { ok: false, status: "not_qualified", reason: "cancelled" };
    return { ok: true, status: "qualified", reason: "" };
  }

  /* add calendar months, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb) */
  function addMonths(ts, n) {
    var d = new Date(ts), day = d.getUTCDate();
    var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, d.getUTCHours(), d.getUTCMinutes()));
    var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(day, last)); return t.getTime();
  }
  /* Which renewals become free. Monthly: earned months cover the NEXT renewals in a row (paid month 3 -> month 4 free ->
     charging resumes month 5). Annual: each month moves the renewal date one month later (no cash, no part refund).
     earned: count of confirmed, unused months. Returns [{ from, to, kind }] */
  function freeSchedule(o) {
    var out = [], n = Math.max(0, Math.min(o.earned | 0, RULES.capPerYear));
    if (!n || !o.nextRenewalAt) return out;
    if (o.interval === "yearly") {
      out.push({ from: o.nextRenewalAt, to: addMonths(o.nextRenewalAt, n), kind: "extend" });
      return out;
    }
    for (var i = 0; i < n; i++) out.push({ from: addMonths(o.nextRenewalAt, i), to: addMonths(o.nextRenewalAt, i + 1), kind: "free_month" });
    return out;
  }
  /* how many of `requested` new months fit under the rolling-12-month cap, given months earned in the last 12 months */
  function capRoom(earnedLast12, requested) {
    return Math.max(0, Math.min(requested | 0, RULES.capPerYear - (earnedLast12 | 0)));
  }
  /* USD value shown in HQ reports only (never paid out) */
  function monthValueUsd(plan) { var p = PLAN_USD[plan]; return p ? p.monthly : PLAN_USD.studio.monthly; }

  /* fraud signals -> plain-words flags + a score. 0 = auto, 1-2 = person reviews, >= 3 or a hard match = reject */
  var PUBLIC_MAIL = /^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|me|proton|protonmail|rediffmail|aol|zoho)\./i;
  function fraudSignals(a, b) {
    a = a || {}; b = b || {};
    var flags = [], score = 0, hard = false;
    function dom(e) { var m = /@([^@\s]+)$/.exec(String(e || "").toLowerCase()); return m ? m[1] : ""; }
    if (a.email && b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase()) { flags.push("Same e-mail address"); hard = true; }
    var da = dom(a.email), db = dom(b.email);
    if (da && da === db && !PUBLIC_MAIL.test(da + ".")) { flags.push("Same company e-mail domain (" + da + ")"); score += 2; }
    if (a.cardFp && a.cardFp === b.cardFp) { flags.push("Same payment card or UPI"); hard = true; }
    if (a.deviceId && a.deviceId === b.deviceId) { flags.push("Same device"); score += 2; }
    if (a.ip && a.ip === b.ip) { flags.push("Same internet address"); score += 1; }
    if (a.phone && a.phone === b.phone) { flags.push("Same phone number"); hard = true; }
    if (a.gstin && a.gstin === b.gstin) { flags.push("Same GSTIN / tax number"); hard = true; }
    if ((b.codeSignups24h | 0) > RULES.velocityPerDay) { flags.push("Many sign-ups on this code in 24 hours (" + (b.codeSignups24h | 0) + ")"); score += 1; }
    if (b.disposableEmail) { flags.push("Throw-away e-mail service"); score += 2; }
    var action = hard || score >= 3 ? "reject" : score >= 1 ? "review" : "auto";
    return { flags: flags, score: hard ? 9 : score, action: action };
  }

  /* partner / marketing codes: what the new studio gets */
  function partnerOffer(p) {
    if (!p) return "";
    if (p.reward === "months") return (p.months | 0) + " free month" + ((p.months | 0) === 1 ? "" : "s") + " after your first payment";
    if (p.reward === "percent") return (p.percent | 0) + "% off for " + (p.forMonths | 0) + " month" + ((p.forMonths | 0) === 1 ? "" : "s") + " after your first payment";
    return "";
  }
  function partnerUsable(p, now) {
    now = now || Date.now();
    if (!p || !p.active) return { ok: false, why: "This code is no longer active." };
    if (p.expiresAt && now > p.expiresAt) return { ok: false, why: "This code has expired." };
    if (p.maxUses && (p.uses | 0) >= p.maxUses) return { ok: false, why: "This code has reached its limit." };
    return { ok: true, why: "" };
  }

  var api = { RULES: RULES, PLAN_USD: PLAN_USD, STATUS: STATUS, REASONS: REASONS, REWARD: REWARD, normalizeCode: normalizeCode,
    personalCode: personalCode, shareLink: shareLink, qualifies: qualifies, addMonths: addMonths, freeSchedule: freeSchedule,
    capRoom: capRoom, monthValueUsd: monthValueUsd, fraudSignals: fraudSignals, partnerOffer: partnerOffer, partnerUsable: partnerUsable };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmReferral = api;
})(typeof window !== "undefined" ? window : this);
