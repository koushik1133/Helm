/* hq-referrals.js - r29 Helm HQ "Referrals & partners".
   REAL (SQL 0279): a signed-in Helm HQ person with two-step (the same sign-in as /hq). The DATABASE decides every call:
   reads need billing.read or inbox.read, marketing links billing.write or inbox.write, Approve / Reject + reward actions
   billing.write, program rules settings.write (0277 roles); every call is written to the HQ audit log. A change that needs
   a fresh two-step code asks for it here and retries once. Signed out / not HQ -> "page not found" (never confirms HQ).
   DEMO: localhost + ?demo=1 only (referral-demo.js) - in-memory, nothing saved.
   DOM via createElement / textContent only. Money: USD at list price, for reporting only (rewards are months, never cash). */
(function () {
  "use strict";
  var R = window.HelmReferral;
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(location.hostname || ""));
  var D = LOCAL ? window.HelmReferralDemo || null : null;
  var REAL = !D, S = window.HelmHqStaff || null, ME = null;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function fmt(ts) {
    if (!ts) return "-";
    try { return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(ts)); } catch (e) { return new Date(ts).toISOString().slice(0, 10); }
  }
  function ms(v) { if (!v) return 0; var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 6) : Date.parse(v) || 0; }
  function usd(n) { return "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { el.hidden = true; }, 3600); }
  function err(t) { var b = $("errbar"); if (!b) { toast(t); return; } b.textContent = t; b.hidden = !t; }
  function td(label, cls, child) { var c = h("td", cls); c.setAttribute("data-label", label); if (child != null) { if (typeof child === "object") c.appendChild(child); else c.textContent = String(child); } return c; }
  function two(a, b, mono) { var f = document.createDocumentFragment(); f.appendChild(h("b", mono ? "m" : null, a)); if (b) f.appendChild(h("small", null, b)); return f; }
  function can(p) { return !REAL || !ME || !S ? true : S.can(ME.perms, p); }
  function cap(s) { s = String(s || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  var DEMO_NOTE = ". Demo mode - nothing is saved.";

  /* the HQ address is never written in this page's HTML (HQ stays unlinked); set only after the HQ gate passes */
  function hqLinks() { var to = "/" + "hq"; Array.prototype.forEach.call(document.querySelectorAll("[data-hq]"), function (a) { a.setAttribute("href", to); }); }
  function notFound() { document.title = "Page not found - Helm"; $("vApp").hidden = true; $("vSoon").hidden = false; }
  function blocked(title, text) { hqLinks(); $("soonH").textContent = title; $("soonP").textContent = text; $("soonA").hidden = false; $("vApp").hidden = true; $("vSoon").hidden = false; }

  /* ---- every HQ call: a fresh-code refusal asks for the code once and retries; a role refusal gets a plain sentence ---- */
  var codeWait = null;
  function askCode() {
    if (codeWait) return codeWait;
    codeWait = new Promise(function (resolve, reject) {
      var box = $("mCodeOk"), inp = $("reCode"), er = $("reErr"), A = window.BPStore && BPStore.auth;
      if (!A || !A.mfa || !A.mfa.challenge) { reject(new Error("Sign in to Helm HQ again to make this change.")); return; }
      er.textContent = ""; inp.value = ""; $("mScrim").hidden = false; box.hidden = false; setTimeout(function () { try { inp.focus(); } catch (e) {} }, 30);
      function done(ok, e) { box.hidden = true; $("mScrim").hidden = true; $("fRe").onsubmit = null; $("reNo").onclick = null; if (ok) resolve(true); else reject(e || new Error("Cancelled - nothing was changed.")); }
      $("fRe").onsubmit = function (ev) {
        ev.preventDefault(); er.textContent = "";
        Promise.resolve(A.mfa.challenge(String(inp.value || "").trim())).then(function () { done(true); })
          .catch(function (e) { er.textContent = (e && e.message) || "That code didn't work."; });
      };
      $("reNo").onclick = function () { done(false); };
    }).then(function (v) { codeWait = null; return v; }, function (e) { codeWait = null; throw e; });
    return codeWait;
  }
  function call(fn, args) {
    return BPStore.hq(fn, args).catch(function (e) {
      var k = S ? S.errKind(e) : null;
      if (k === "reauth") return askCode().then(function () { return BPStore.hq(fn, args); });
      if (k === "idle" || k === "expired" || k === "ended") { blocked("Sign in to Helm HQ again", S.friendly(k)); throw new Error(S.friendly(k)); }
      if (k === "role" || k === "ip") throw new Error(S.friendly(k, ME && ME.role_label));
      throw e;
    });
  }
  function msg(e) { var m = String((e && e.message) || "Something went wrong."); return m.replace(/^not authorized:\s*HQ_[A-Z_]+\s*/, ""); }

  /* ---- server answers -> the shapes the screens draw (the same as the demo data) ---- */
  var KPI = null, SETTINGS = null;
  function lastReward(list, sides) {
    var x = (Array.isArray(list) ? list : []).filter(function (w) { return sides.indexOf(w.side) >= 0; });
    return x.length ? x[x.length - 1].state : "";
  }
  function mapRef(r) {
    return { id: r.id, short: "RF-" + String(r.id).slice(0, 6).toUpperCase(), referrer: r.referrer_name || (r.kind === "partner" ? (r.partner_name || "Partner code") : "Removed studio"),
      referrerState: r.kind === "partner" ? "partner" : (r.referrer_state === "active" ? "not paying" : r.referrer_state || ""), code: r.code,
      referee: r.referred_name || "Removed studio", refereeEmail: r.referred_email || "", city: r.referred_city || "",
      signedUp: ms(r.signed_up_at), paid: ms(r.first_paid_at), holdUntil: ms(r.hold_until), status: r.status, reason: r.reason || "",
      flags: Array.isArray(r.flags) ? r.flags.slice() : [], approved: !!r.approved, note: r.decision_note || "", via: r.via,
      reward: lastReward(r.rewards, ["referrer", "partner"]), partner: r.kind === "partner" };
  }
  function mapReward(x) {
    return { id: x.id, short: "RW-" + String(x.id).slice(0, 6).toUpperCase(), studio: x.studio_name || "Removed studio",
      side: x.side === "referrer" ? "Referrer" : x.side === "partner" ? "Partner studio" : "New studio", from: x.code || "-",
      plan: x.plan_code || "studio", state: x.state, kind: x.kind, when: ms(x.applied_at) || ms(x.earned_at), usd: x.kind === "discount" ? 0 : Number(x.value_usd) || 0,
      note: (x.kind === "discount" ? x.percent + "% off for " + x.for_months + " months. " : "") + (x.state_reason || "") + (x.flagged ? " - FLAGGED: used, then refunded (written off, not charged)" : ""),
      flagged: !!x.flagged, currency: x.currency || "" };
  }
  function mapCode(c) {
    return { code: c.code, name: c.partner_name, kind: cap(c.partner_kind || "other"), reward: c.offer_type, months: c.offer_months | 0, percent: c.offer_percent | 0,
      forMonths: c.offer_for_months | 0, partnerReward: c.partner_reward, partnerStudio: c.partner_studio || "", active: !!c.active,
      expiresAt: ms(c.ends_at), maxUses: c.max_uses | 0, uses: c.uses | 0, clicks: c.clicks | 0, signups: c.signups | 0, paid: c.paid | 0,
      disclosure: !!c.disclosure_ack, createdAt: ms(c.created_at), terms: c.terms || "", problem: c.problem || "" };
  }
  function loadReal() {
    return Promise.all([call("hq_referral_overview"), call("hq_referrals", { p_status: "all", p_q: null, p_limit: 500, p_offset: 0 }),
                        call("hq_referral_rewards", { p_state: "all" }), call("hq_partner_codes")]).then(function (a) {
      KPI = a[0] || {}; SETTINGS = KPI.settings || null;
      D = { all: (a[1] || []).map(mapRef), ledger: (a[2] || []).map(mapReward), partners: (a[3] || []).map(mapCode), now: Date.now(), lookup: {} };
      paint();
    });
  }

  /* ---- menu (phones) ---- */
  function menu() {
    var hq = $("vApp"), scrim = $("navScrim"), b = $("btnMenu");
    function nav(open) { hq.classList.toggle("nav-open", open); scrim.hidden = !open; b.setAttribute("aria-expanded", open ? "true" : "false"); }
    b.addEventListener("click", function () { nav(!hq.classList.contains("nav-open")); });
    scrim.addEventListener("click", function () { nav(false); });
  }

  /* ---- KPIs ---- */
  function kpis() {
    var all = D.all, k = $("kpis"); clear(k);
    var signed = all.length, paid = all.filter(function (r) { return r.status === "qualified"; }).length;
    var review = all.filter(function (r) { return r.status === "review"; }).length;
    var granted = D.ledger.filter(function (l) { return l.kind !== "discount" && (l.state === "applied" || l.state === "scheduled"); });
    var value = KPI ? Number(KPI.usd_applied || 0) + Number(KPI.usd_upcoming || 0) : granted.reduce(function (s, l) { return s + R.monthValueUsd(l.plan); }, 0);
    var pPaid = D.partners.reduce(function (s, p) { return s + (p.paid | 0); }, 0);
    var held = D.ledger.filter(function (l) { return l.state === "held" || l.state === "frozen"; }).length;
    var flagged = D.ledger.filter(function (l) { return l.flagged; }).length;
    [["Referral sign-ups", signed, KPI ? (KPI.signups_90d | 0) + " in the last 90 days" : "studio-to-studio", ""],
     ["Became paid", paid, Math.round(paid / Math.max(1, signed) * 100) + "% of sign-ups", "good"],
     ["Needs review", review, "fraud checks flagged", review ? "warn" : ""], ["Free months given", granted.length, usd(value) + " at list price", ""],
     ["Partner-code paid", pPaid, D.partners.length + " codes", ""],
     ["Held / frozen", held, flagged ? flagged + " written off (flagged)" : "waiting on the referrer", flagged ? "warn" : ""]]
      .forEach(function (x) { var c = h("div", "kpi" + (x[3] ? " " + x[3] : "")); c.appendChild(h("div", "l", x[0])); c.appendChild(h("div", "v", x[1])); c.appendChild(h("div", "s", x[2])); k.appendChild(c); });
    $("cRef").textContent = signed; $("cRev").textContent = review; $("cRev").hidden = !review;
    $("cLed").textContent = D.ledger.length; $("cPar").textContent = D.partners.length;
  }

  /* ---- referrals ---- */
  var F = { status: "all", q: "" };
  var CHIPS = [["all", "All"], ["progress", "In progress"], ["hold", "Paid, checking"], ["review", "Needs review"], ["qualified", "Earned"], ["not_qualified", "Not qualified"]];
  function chips() {
    var c = $("refChips"); clear(c);
    CHIPS.forEach(function (x) {
      var b = h("button", "chip", x[1]); b.type = "button"; b.setAttribute("aria-pressed", F.status === x[0] ? "true" : "false");
      b.addEventListener("click", function () { F.status = x[0]; chips(); refs(); }); c.appendChild(b);
    });
  }
  function decide(r, ok) {
    if (!REAL) {
      if (ok) { r.status = "qualified"; r.reward = r.referrerState === "paying" ? "scheduled" : r.referrerState === "trial" ? "held" : "frozen"; r.flags = r.flags.concat(["Approved by admin@helm.events"]); }
      else { r.status = "not_qualified"; r.reason = "fraud"; }
      toast((ok ? "Approved " : "Rejected ") + (r.short || r.id) + DEMO_NOTE); kpis(); refs(); return;
    }
    var note = window.prompt(ok ? "Approve " + r.short + " - a short note for the audit log (optional):" : "Reject " + r.short + " - why? (kept in the audit log)", "");
    if (note === null) return;
    err("");
    call("hq_referral_decide", { p_id: r.id, p_approve: !!ok, p_note: note || null })
      .then(function (x) { toast((ok ? "Approved " : "Rejected ") + r.short + " (" + ((x && x.status) || "") + ")."); return loadReal(); })
      .catch(function (e) { err(msg(e)); });
  }
  function refs() {
    var tb = $("refRows"); clear(tb);
    var q = F.q.toLowerCase();
    var list = D.all.filter(function (r) {
      if (F.status === "progress" && !/^(clicked|signed_up|trial|first_month)$/.test(r.status)) return false;
      if (F.status !== "all" && F.status !== "progress" && r.status !== F.status) return false;
      if (q && (r.referrer + " " + r.referee + " " + r.code + " " + r.refereeEmail + " " + (r.short || r.id)).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    list.forEach(function (r) {
      var st = R.STATUS[r.status] || R.STATUS.clicked, tr = h("tr");
      tr.appendChild(td("Referral", null, two(r.short || r.id, (r.partner ? "Partner code" : "Studio link") + (r.via ? " · " + r.via : ""), true)));
      tr.appendChild(td("Referrer", null, two(r.referrer, r.code + (r.referrerState ? " · " + r.referrerState : ""))));
      tr.appendChild(td("New studio", null, two(r.referee, r.refereeEmail || r.city)));
      tr.appendChild(td("Signed up", null, two(fmt(r.signedUp), r.paid ? "Paid " + fmt(r.paid) : "Not paid yet")));
      var stc = h("div"); stc.appendChild(h("span", "pill " + st.tone, st.label));
      if (r.status === "not_qualified" && r.reason) stc.appendChild(h("small", null, R.REASONS[r.reason] || ""));
      if (r.status === "hold" && (r.holdUntil || r.paid)) stc.appendChild(h("small", null, "Confirms on " + fmt(r.holdUntil || r.paid + R.RULES.holdDays * 864e5)));
      if (r.status === "qualified" && r.reward) stc.appendChild(h("small", null, "Referrer: " + ((R.REWARD[r.reward] || {}).label || r.reward)));
      tr.appendChild(td("Status", null, stc));
      var fl = h("div", "flags");
      if (!r.flags.length) fl.appendChild(h("span", "flag none", "No signals"));
      r.flags.forEach(function (f) { fl.appendChild(h("span", "flag", f)); });
      if (r.approved) fl.appendChild(h("span", "flag none", "Approved" + (r.note ? ": " + r.note : "")));
      tr.appendChild(td("Fraud checks", null, fl));
      var acts = h("div", "acts");
      var mayDecide = can("billing.write");
      if (mayDecide && (r.status === "review" || r.status === "hold")) {
        var a = h("button", "btn sm", "Approve"); a.type = "button"; a.addEventListener("click", function () { decide(r, true); });
        acts.appendChild(a);
      }
      if (mayDecide && (r.status === "review" || r.status === "hold" || (REAL && r.status === "qualified"))) {
        var x = h("button", "btn sm danger", "Reject"); x.type = "button"; x.addEventListener("click", function () { decide(r, false); });
        acts.appendChild(x);
      }
      if (!acts.firstChild) acts.appendChild(h("span", "muted", "-"));
      tr.appendChild(td("Actions", "n", acts));
      tb.appendChild(tr);
    });
    if (!list.length) { var e = h("tr"), c = h("td", "empty", "No referrals match."); c.colSpan = 7; e.appendChild(c); tb.appendChild(e); }
    $("refH").textContent = F.status === "review" ? "Needs review" : "All referrals";
  }

  /* ---- ledger ---- */
  function ledger() {
    var tb = $("ledRows"); clear(tb);
    var sum = { applied: 0, scheduled: 0, held: 0 };
    D.ledger.forEach(function (l) {
      var st = R.REWARD[l.state] || R.REWARD.scheduled, v = l.kind === "discount" ? 0 : (l.usd != null && REAL ? l.usd : R.monthValueUsd(l.plan)), tr = h("tr");
      if (sum[l.state] != null) sum[l.state] += v;
      tr.appendChild(td("Reward", null, two(l.short || l.id, l.kind === "discount" ? "Discount" : null, true)));
      tr.appendChild(td("Studio", null, two(l.studio, (R.PLAN_USD[l.plan] || {}).name || "")));
      tr.appendChild(td("Side", null, l.side));
      tr.appendChild(td("From", "m", l.from));
      tr.appendChild(td("Value (USD)", "n", l.kind === "discount" ? "-" : usd(v)));
      tr.appendChild(td("State", null, h("span", "pill " + st.tone, st.label)));
      tr.appendChild(td("Date", null, l.when ? fmt(l.when) : "-"));
      var nt = h("div"); nt.appendChild(h("small", null, l.note));
      if (REAL && can("billing.write")) {
        if (l.kind === "discount" && l.state === "scheduled") nt.appendChild(act("Mark given on the bill", function () { rewardAct(l, "mark_applied"); }));
        if (/^(held|scheduled|frozen)$/.test(l.state)) nt.appendChild(act("Forfeit", function () { rewardAct(l, "forfeit"); }, true));
        if (l.flagged) nt.appendChild(act("Clear flag", function () { rewardAct(l, "clear_flag"); }));
      }
      tr.appendChild(td("Note", null, nt));
      tb.appendChild(tr);
    });
    if (!D.ledger.length) { var e = h("tr"), c = h("td", "empty", "No free months yet."); c.colSpan = 8; e.appendChild(c); tb.appendChild(e); }
    var t = $("ledTot"); clear(t);
    [["Applied", sum.applied], ["Upcoming", sum.scheduled], ["Held", sum.held]].forEach(function (x) { var s = h("span", null, x[0] + ": "); s.appendChild(h("b", null, usd(x[1]))); t.appendChild(s); });
  }
  function act(label, fn, danger) { var b = h("button", "btn sm" + (danger ? " danger" : ""), label); b.type = "button"; b.addEventListener("click", fn); return b; }
  function rewardAct(l, what) {
    var note = window.prompt(what === "forfeit" ? "Forfeit " + l.short + " (rule breaking) - why?" : what === "mark_applied" ? "Which invoice was the discount given on? (note)" : "Note (optional)", "");
    if (note === null) return;
    err("");
    call("hq_referral_reward_action", { p_id: l.id, p_action: what, p_note: note || null })
      .then(function () { toast("Saved " + l.short + "."); return loadReal(); }).catch(function (e) { err(msg(e)); });
  }

  /* ---- partner codes ---- */
  function partners() {
    var tb = $("parRows"); clear(tb);
    D.partners.forEach(function (p) {
      var use = REAL ? { ok: !p.problem } : R.partnerUsable(p, D.now), tr = h("tr");
      tr.appendChild(td("Code", null, two(p.code, p.kind + (p.kind === "Influencer" ? (p.disclosure ? " · labels posts" : " · NO disclosure promise") : ""), true)));
      tr.appendChild(td("Partner", null, two(p.name, "Partner gets: " + (p.partnerReward === "months" ? "1 free month per paying studio" : p.partnerReward === "tracking" ? "tracking only" : "nothing"))));
      tr.appendChild(td("New studio gets", null, R.partnerOffer(p) || "Nothing (tracking only)"));
      tr.appendChild(td("Uses", "n", (p.uses | 0) + (p.maxUses ? " / " + p.maxUses : "")));
      tr.appendChild(td("Sign-ups", "n", p.signups | 0));
      tr.appendChild(td("Paid", "n", p.paid | 0));
      tr.appendChild(td("Conversion", "n", Math.round((p.paid | 0) / Math.max(1, p.signups | 0) * 100) + "%"));
      tr.appendChild(td("Ends", null, p.expiresAt ? fmt(p.expiresAt) : "No end date"));
      var label = use.ok ? "Active" : !p.active ? "Disabled" : (p.problem === "off" ? "Program off" : (p.expiresAt && D.now > p.expiresAt) || p.problem === "expired" ? "Expired" : "Limit reached");
      tr.appendChild(td("Status", null, h("span", "pill " + (use.ok ? "good" : p.active ? "warn" : ""), label)));
      var acts = h("div", "acts"), mayEdit = can("billing.write") || can("inbox.write");
      var cp = act("Copy link", function () { copyLink(p.code); }); acts.appendChild(cp);
      if (REAL) acts.appendChild(act("Sign-ups", function () { signups(p); }));
      if (mayEdit) {
        acts.appendChild(act("Edit", function () { openCode(p); }));
        acts.appendChild(act(p.active ? "Disable" : "Enable", function () { toggle(p); }, p.active));
      }
      tr.appendChild(td("Actions", "n", acts));
      tb.appendChild(tr);
    });
    if (!D.partners.length) { var e = h("tr"), c = h("td", "empty", "No marketing links yet. Create one for a partner, influencer, event or campaign."); c.colSpan = 10; e.appendChild(c); tb.appendChild(e); }
  }
  function linkFor(code) { return (LOCAL ? location.origin : "https://helm.events") + "/r/" + encodeURIComponent(code); }
  function copyLink(code) {
    var l = linkFor(code);
    try { navigator.clipboard.writeText(l).then(function () { toast("Copied " + l); }, function () { window.prompt("Copy this link:", l); }); }
    catch (e) { window.prompt("Copy this link:", l); }
  }
  function toggle(p) {
    if (!REAL) { p.active = !p.active; toast((p.active ? "Enabled " : "Disabled ") + p.code + DEMO_NOTE); partners(); kpis(); return; }
    err("");
    call("hq_partner_code_set_active", { p_code: p.code, p_active: !p.active })
      .then(function () { toast((p.active ? "Disabled " : "Enabled ") + p.code + "."); return loadReal(); }).catch(function (e) { err(msg(e)); });
  }
  function signups(p) {
    err("");
    call("hq_partner_signups", { p_code: p.code }).then(function (x) {
      x = x || {}; $("mSignH").textContent = "Sign-ups through " + p.code + " (" + p.name + ")";
      var sh = $("signShare"); clear(sh); var s = x.share || {};
      [["Link opened", s.clicks], ["Signed up", s.signups], ["Paid", s.paid], ["Confirmed", s.qualified]].forEach(function (k) { var e = h("span", null, k[0] + ": "); e.appendChild(h("b", null, k[1] | 0)); sh.appendChild(e); });
      var names = Array.isArray(s.named_studios) ? s.named_studios : [];
      sh.appendChild(h("span", null, "Studios that agreed to be named: " + (names.length ? names.join(", ") : "none")));
      var tb = $("signRows"); clear(tb);
      (x.signups || []).forEach(function (r) {
        var st = R.STATUS[r.status] || R.STATUS.clicked, tr = h("tr");
        tr.appendChild(td("Studio", null, r.studio || "Removed studio"));
        tr.appendChild(td("Signed up", null, fmt(ms(r.signed_up_at))));
        var sc = h("div"); sc.appendChild(h("span", "pill " + st.tone, st.label)); if (r.reason) sc.appendChild(h("small", null, R.REASONS[r.reason] || "")); tr.appendChild(td("Status", null, sc));
        tr.appendChild(td("Paid", null, r.paid ? "Yes" : "No"));
        tr.appendChild(td("Name may be shared", null, r.consent_name ? "Yes" : "No"));
        tb.appendChild(tr);
      });
      if (!tb.firstChild) { var e = h("tr"), c = h("td", "empty", "Nobody has signed up with this code yet."); c.colSpan = 5; e.appendChild(c); tb.appendChild(e); }
      $("mScrim").hidden = false; $("mSign").hidden = false;
    }).catch(function (e) { err(msg(e)); });
  }

  /* ---- create / edit a marketing link ---- */
  var editing = null;
  function val(id) { return $(id).value; }
  function syncForm() {
    var rw = val("fc_reward");
    $("fc_months_l").hidden = rw !== "months"; $("fc_pct_l").hidden = rw !== "percent"; $("fc_for_l").hidden = rw !== "percent";
    $("fc_disc_l").hidden = val("fc_kind") !== "Influencer";
    $("fc_ps_l").hidden = val("fc_preward") !== "months";
    var p = { reward: rw, months: +val("fc_months"), percent: +val("fc_pct"), forMonths: +val("fc_for") };
    var code = R.normalizeCode(val("fc_code")) || (editing ? editing.code : "MADE-FROM-NAME");
    $("fc_prev").textContent = "Sign-up page will say: “Applied: " + (R.partnerOffer(p) || "code saved (tracking only)") + ".” Link: " + linkFor(code);
  }
  function openCode(p) {
    editing = p || null;
    $("mCodeH").textContent = p ? "Edit " + p.code : "Create marketing link";
    var hint = document.querySelector("#mCode .hint"); if (hint) hint.textContent = REAL ? "Partners get free months, a discount or tracking only - never cash. Partners only ever see counts (and the names of studios that agreed)." : "Demo mode: the code is added to this page only. Nothing is saved.";
    $("fc_code").value = p ? p.code : ""; $("fc_code").disabled = !!p;
    $("fc_name").value = p ? p.name : ""; $("fc_kind").value = p ? p.kind : "Influencer";
    $("fc_reward").value = p ? p.reward : "months"; $("fc_months").value = p && p.months ? p.months : 1;
    $("fc_pct").value = p && p.percent ? p.percent : 20; $("fc_for").value = p && p.forMonths ? p.forMonths : 3;
    $("fc_preward").value = p ? p.partnerReward : "tracking"; $("fc_max").value = p ? p.maxUses : 0;
    $("fc_end").value = p && p.expiresAt ? new Date(p.expiresAt).toISOString().slice(0, 10) : "";
    $("fc_disc").checked = !!(p && p.disclosure);
    $("fc_terms").value = p && p.terms ? p.terms : ""; $("fc_ps").value = p && p.partnerStudio ? p.partnerStudio : "";
    $("fc_code_err").hidden = true;
    $("mScrim").hidden = false; $("mCode").hidden = false; syncForm();
    setTimeout(function () { $("fc_name").focus(); }, 30);
  }
  function closeAll() { $("mScrim").hidden = true; $("mCode").hidden = true; $("mSign").hidden = true; editing = null; }
  function save(e) {
    e.preventDefault();
    var er = $("fc_code_err"), rawCode = val("fc_code").trim(), code = R.normalizeCode(rawCode);
    function bad(t) { er.textContent = t; er.hidden = false; $("fc_code").focus(); }
    if (!editing && rawCode && !code) return bad("Use 3-24 letters, numbers, - or _ (or leave it blank).");
    if (!val("fc_name").trim()) { $("fc_name").focus(); return; }
    if (val("fc_kind") === "Influencer" && !$("fc_disc").checked) { $("fc_disc").focus(); toast("Influencer codes need the disclosure promise first."); return; }
    if (!REAL) {
      if (!editing) {
        if (!code) code = R.personalCode(val("fc_name"));
        if (D.lookup[code] || D.partners.some(function (p) { return p.code === code; })) return bad("That code is already taken (codes are unique, studio codes included).");
      }
      var end = val("fc_end") ? Date.parse(val("fc_end") + "T23:59:59+05:30") : 0;
      var p = editing || { code: code, uses: 0, clicks: 0, signups: 0, paid: 0, active: true, createdAt: Date.now() };
      p.name = val("fc_name").trim(); p.kind = val("fc_kind"); p.reward = val("fc_reward");
      p.months = Math.max(1, Math.min(3, +val("fc_months") || 1)); p.percent = Math.max(5, Math.min(50, +val("fc_pct") || 20)); p.forMonths = Math.max(1, Math.min(12, +val("fc_for") || 3));
      p.partnerReward = val("fc_preward"); p.maxUses = Math.max(0, +val("fc_max") || 0); p.expiresAt = end || 0; p.disclosure = $("fc_disc").checked;
      if (!editing) { D.partners.unshift(p); D.lookup[p.code] = { kind: "partner", partner: p }; }
      toast((editing ? "Saved " : "Added ") + p.code + DEMO_NOTE);
      closeAll(); partners(); kpis(); return;
    }
    var body = { code: editing ? editing.code : (code || ""), name: val("fc_name").trim(), kind: val("fc_kind").toLowerCase(), offer_type: val("fc_reward"),
      offer_months: +val("fc_months") || 0, offer_percent: +val("fc_pct") || 0, offer_for_months: +val("fc_for") || 0, partner_reward: val("fc_preward"),
      partner_studio: val("fc_preward") === "months" ? val("fc_ps").trim() : "", max_uses: Math.max(0, +val("fc_max") || 0), ends_on: val("fc_end") || "",
      terms: val("fc_terms").trim(), disclosure_ack: $("fc_disc").checked };
    if (editing) body.active = editing.active;
    $("fc_save").disabled = true;
    call("hq_partner_code_upsert", { p: body }).then(function (x) {
      closeAll(); toast((x && x.result === "created" ? "Created " : "Saved ") + (x && x.code) + " - link " + linkFor(x && x.code)); return loadReal();
    }).catch(function (e2) { er.textContent = msg(e2); er.hidden = false; }).then(function () { $("fc_save").disabled = false; });
  }

  /* ---- program rules ---- */
  function rules() {
    var RL = R.RULES, s = SETTINGS, kv = $("rulesKv"); clear(kv);
    var n = function (k, d) { return s && s[k] != null ? s[k] : d; };
    [["Program", REAL ? (s && s.program_on ? "ON - studios see their link, codes work at sign-up" : "OFF - switch it on below when you are ready") : "Demo"],
     ["Reward (both sides)", "1 month of the studio's own plan, in its own billing currency. Never cash, not transferable."],
     ["Qualifying event", "New studio's first real (non-zero) payment, then " + n("hold_days", RL.holdDays) + " days with no refund, dispute or cancellation."],
     ["New studio must pay within", n("pay_within_days", RL.payWithinDays) + " days of signing up"],
     ["Link remembered for", n("link_days", RL.linkDays) + " days (last link wins; a typed code beats a link)"],
     ["Code added after sign-up", "Only by support, within " + n("late_code_days", RL.lateCodeDays) + " days and before the first payment"],
     ["Cap per referrer", n("cap_per_year", RL.capPerYear) + " free months in any rolling 12 months"],
     ["Referrer not paying yet", "Reward held up to " + n("held_months", RL.heldMonths) + " months for their first payment"],
     ["Referrer cancels", "Unused months frozen; back if they return within " + n("frozen_months", RL.frozenMonths) + " months"],
     ["Unused months expire", n("expiry_months", RL.expiryMonths) + " months after they were earned"],
     ["Monthly plans", "The renewal that is due is free (the period moves one month); several stack one after another"],
     ["Yearly plans", "Each free month moves the renewal date one month later, at once"],
     ["Refund after a month was used", "Written off - the studio is never charged - and flagged here"],
     ["Review trigger", "Any soft fraud signal; more than " + n("velocity_per_day", RL.velocityPerDay) + " sign-ups on one code in 24 hours"],
     ["Auto-reject", "Same e-mail, phone, payment card / UPI or GSTIN / PAN as the referrer, or 3+ points"]]
      .forEach(function (x) { kv.appendChild(h("dt", null, x[0])); kv.appendChild(h("dd", null, x[1])); });
    var f = $("fSet");
    if (!REAL || !s) { f.hidden = true; return; }
    f.hidden = false;
    var editable = can("settings.write");
    $("st_on").checked = !!s.program_on;
    [["st_hold", "hold_days"], ["st_pay", "pay_within_days"], ["st_link", "link_days"], ["st_late", "late_code_days"], ["st_cap", "cap_per_year"],
     ["st_held", "held_months"], ["st_frozen", "frozen_months"], ["st_exp", "expiry_months"], ["st_vel", "velocity_per_day"]]
      .forEach(function (x) { $(x[0]).value = s[x[1]]; $(x[0]).disabled = !editable; });
    $("st_on").disabled = !editable; $("st_save").hidden = !editable; $("st_tick").hidden = !can("billing.write");
    $("rulesHint").textContent = editable ? "Changes need a fresh two-step code and are written to the HQ audit log." : "Only the HQ Owner / Admin can change these.";
  }
  function saveRules(e) {
    e.preventDefault();
    var body = { program_on: $("st_on").checked };
    [["st_hold", "hold_days"], ["st_pay", "pay_within_days"], ["st_link", "link_days"], ["st_late", "late_code_days"], ["st_cap", "cap_per_year"],
     ["st_held", "held_months"], ["st_frozen", "frozen_months"], ["st_exp", "expiry_months"], ["st_vel", "velocity_per_day"]]
      .forEach(function (x) { var v = parseInt($(x[0]).value, 10); if (isFinite(v)) body[x[1]] = v; });
    $("st_msg").textContent = "";
    call("hq_referral_settings_set", { p: body }).then(function () { $("st_msg").textContent = "Saved."; return loadReal(); })
      .catch(function (x) { $("st_msg").textContent = msg(x); });
  }
  function runTick() {
    $("st_msg").textContent = "Running…";
    call("hq_referral_run_tick").then(function (r) {
      r = r || {}; $("st_msg").textContent = "Done: " + (r.qualified | 0) + " confirmed, " + (r.applied | 0) + " free months used, " + (r.not_paid | 0) + " did not pay, " + (r.expired | 0) + " expired.";
      return loadReal();
    }).catch(function (x) { $("st_msg").textContent = msg(x); });
  }

  function paint() { kpis(); chips(); refs(); ledger(); partners(); rules(); }

  /* ---- tabs + wiring ---- */
  function wire() {
    menu();
    $("refQ").addEventListener("input", function (e) { F.q = e.target.value; refs(); });
    ["fc_reward", "fc_kind", "fc_months", "fc_pct", "fc_for", "fc_code", "fc_preward"].forEach(function (id) { $(id).addEventListener("input", syncForm); $(id).addEventListener("change", syncForm); });
    $("btnNewCode").addEventListener("click", function () { openCode(null); });
    $("btnNewCode2").addEventListener("click", function () { openCode(null); });
    $("fc_cancel").addEventListener("click", closeAll);
    $("signClose").addEventListener("click", closeAll);
    $("mScrim").addEventListener("click", function () { if ($("mCodeOk").hidden) closeAll(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && (!$("mCode").hidden || !$("mSign").hidden)) closeAll(); });
    $("fCode").addEventListener("submit", save);
    $("fSet").addEventListener("submit", saveRules);
    $("st_tick").addEventListener("click", runTick);
    if (REAL && !(can("billing.write") || can("inbox.write"))) { $("btnNewCode").hidden = true; $("btnNewCode2").hidden = true; }
    var tabs = ["t-ref", "t-rev", "t-led", "t-par", "t-set"], panes = { "t-ref": "p-ref", "t-rev": "p-ref", "t-led": "p-led", "t-par": "p-par", "t-set": "p-set" };
    tabs.forEach(function (id) {
      $(id).addEventListener("click", function () {
        tabs.forEach(function (t) { $(t).setAttribute("aria-selected", t === id ? "true" : "false"); });
        ["p-ref", "p-led", "p-par", "p-set"].forEach(function (p) { $(p).hidden = p !== panes[id]; });
        if (id === "t-rev") { F.status = "review"; chips(); refs(); } else if (id === "t-ref") { F.status = "all"; chips(); refs(); }
      });
    });
    var hashTab = { "#review": "t-rev", "#ledger": "t-led", "#partners": "t-par", "#rules": "t-set" }[location.hash];
    if (hashTab) $(hashTab).click();
  }

  if (!R) { notFound(); return; }
  if (!REAL) {
    $("demobar").hidden = false; $("who").textContent = "Demo: admin@helm.events";
    hqLinks(); $("vApp").hidden = false; paint(); wire(); return;
  }
  /* real: the same gate as /hq - signed out / a sign-in step pending / not an operator / no two-step -> never shows data */
  (async function () {
    var B = window.BPStore;
    if (!B || !B.hq) { notFound(); return; }
    try { await B.init(); } catch (e) { notFound(); return; }
    if (!B.auth.enabled() || !B.auth.pendingUser() || B.auth.pendingStep()) { notFound(); return; }
    var step = "unknown";
    try { step = B.auth.mfa && B.auth.mfa.operatorStep ? await B.auth.mfa.operatorStep() : "unknown"; } catch (e) { step = "unknown"; }
    if (step === "none") { notFound(); return; }
    if (step !== "ok") { blocked("Sign in to Helm HQ first", "Open Helm HQ, sign in with your two-step code, then come back to Referrals & partners."); return; }
    try { ME = await B.hq("hq_me"); } catch (e) { ME = null; }
    if (ME && ME.status === "suspended") { blocked("Your Helm HQ access is paused", "Ask the HQ owner if you think this is a mistake."); return; }
    if (ME && !(can("billing.read") || can("inbox.read"))) { blocked("Your HQ role can't open Referrals & partners", "Ask the HQ owner if you need it."); return; }
    try { await loadReal(); } catch (e) { if (S && S.errKind(e)) { blocked("Sign in to Helm HQ again", S.friendly(S.errKind(e)) || msg(e)); return; } notFound(); return; }
    document.title = "Referrals & partners · Helm HQ";
    $("who").textContent = ((B.auth.user() && B.auth.user().email) || "") + (ME && ME.role_label ? " · " + ME.role_label : "");
    hqLinks(); $("vApp").hidden = false;
    wire();
  })();
})();
