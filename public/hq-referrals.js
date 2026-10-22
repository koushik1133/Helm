/* hq-referrals.js - r29 HQ "Referrals & partners" PHASE 1 preview (UI only).
   Data ONLY in the localhost demo (referral-demo.js, ?demo=1). Anywhere else: a short notice, no data, no network.
   Approve / Reject / Disable / New code change this page's in-memory copy only ("Demo mode - nothing is saved").
   Phase 2: the same screens read/write HQ-only RPCs (hq_referrals_list, hq_referral_decide, hq_partner_code_upsert),
   every decision written to the HQ audit log. DOM via createElement / textContent only. */
(function () {
  "use strict";
  var R = window.HelmReferral;
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(location.hostname || ""));
  var D = LOCAL ? window.HelmReferralDemo || null : null;
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function fmt(ts) {
    if (!ts) return "-";
    try { return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(ts)); } catch (e) { return new Date(ts).toISOString().slice(0, 10); }
  }
  function usd(n) { return "$" + Number(n || 0).toLocaleString("en-US"); }
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { el.hidden = true; }, 3200); }
  function td(label, cls, child) { var c = h("td", cls); c.setAttribute("data-label", label); if (child != null) { if (typeof child === "object") c.appendChild(child); else c.textContent = String(child); } return c; }
  function two(a, b, mono) { var f = document.createDocumentFragment(); f.appendChild(h("b", mono ? "m" : null, a)); if (b) f.appendChild(h("small", null, b)); return f; }

  if (!R || !D) { $("vSoon").hidden = false; return; }
  $("vApp").hidden = false;

  /* ---- menu (phones) ---- */
  var hq = $("vApp"), scrim = $("navScrim"), menu = $("btnMenu");
  function nav(open) { hq.classList.toggle("nav-open", open); scrim.hidden = !open; menu.setAttribute("aria-expanded", open ? "true" : "false"); }
  menu.addEventListener("click", function () { nav(!hq.classList.contains("nav-open")); });
  scrim.addEventListener("click", function () { nav(false); });

  /* ---- KPIs ---- */
  function kpis() {
    var all = D.all, signed = all.length, paid = all.filter(function (r) { return r.status === "qualified"; }).length;
    var review = all.filter(function (r) { return r.status === "review"; }).length;
    var granted = D.ledger.filter(function (l) { return l.state === "applied" || l.state === "scheduled"; });
    var value = granted.reduce(function (s, l) { return s + R.monthValueUsd(l.plan); }, 0);
    var pPaid = D.partners.reduce(function (s, p) { return s + (p.paid | 0); }, 0);
    var k = $("kpis"); clear(k);
    [["Referral sign-ups", signed, "studio-to-studio", ""], ["Became paid", paid, Math.round(paid / Math.max(1, signed) * 100) + "% of sign-ups", "good"],
     ["Needs review", review, "fraud checks flagged", review ? "warn" : ""], ["Free months given", granted.length, usd(value) + " at list price", ""],
     ["Partner-code paid", pPaid, D.partners.length + " codes", ""], ["Held / frozen", D.ledger.filter(function (l) { return l.state === "held" || l.state === "frozen"; }).length, "waiting on the referrer", ""]]
      .forEach(function (x) { var c = h("div", "kpi" + (x[3] ? " " + x[3] : "")); c.appendChild(h("div", "l", x[0])); c.appendChild(h("div", "v", x[1])); c.appendChild(h("div", "s", x[2])); k.appendChild(c); });
    $("cRef").textContent = signed; $("cRev").textContent = review; $("cRev").hidden = !review;
    $("cLed").textContent = D.ledger.length; $("cPar").textContent = D.partners.length;
  }

  /* ---- referrals ---- */
  var F = { status: "all", q: "", reviewOnly: false };
  var CHIPS = [["all", "All"], ["progress", "In progress"], ["hold", "Paid, checking"], ["review", "Needs review"], ["qualified", "Earned"], ["not_qualified", "Not qualified"]];
  function chips() {
    var c = $("refChips"); clear(c);
    CHIPS.forEach(function (x) {
      var b = h("button", "chip", x[1]); b.type = "button"; b.setAttribute("aria-pressed", F.status === x[0] ? "true" : "false");
      b.addEventListener("click", function () { F.status = x[0]; chips(); refs(); }); c.appendChild(b);
    });
  }
  function decide(r, ok) {
    if (ok) { r.status = "qualified"; r.reward = r.referrerState === "paying" ? "scheduled" : r.referrerState === "trial" ? "held" : "frozen"; r.flags = r.flags.concat(["Approved by admin@helm.events"]); }
    else { r.status = "not_qualified"; r.reason = "fraud"; }
    toast((ok ? "Approved " : "Rejected ") + r.id + ". Demo mode - nothing is saved.");
    kpis(); refs();
  }
  function refs() {
    var tb = $("refRows"); clear(tb);
    var q = F.q.toLowerCase();
    var list = D.all.filter(function (r) {
      if (F.status === "progress" && !/^(clicked|signed_up|trial|first_month)$/.test(r.status)) return false;
      if (F.status !== "all" && F.status !== "progress" && r.status !== F.status) return false;
      if (q && (r.referrer + " " + r.referee + " " + r.code + " " + r.refereeEmail + " " + r.id).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    list.forEach(function (r) {
      var st = R.STATUS[r.status] || R.STATUS.clicked, tr = h("tr");
      tr.appendChild(td("Referral", null, two(r.id, r.partner ? "Partner code" : "Studio link", true)));
      tr.appendChild(td("Referrer", null, two(r.referrer, r.code + " · " + (r.referrerState === "paying" ? "paying" : r.referrerState === "trial" ? "on trial" : "cancelled"))));
      tr.appendChild(td("New studio", null, two(r.referee, r.refereeEmail)));
      tr.appendChild(td("Signed up", null, two(fmt(r.signedUp), r.paid ? "Paid " + fmt(r.paid) : "Not paid yet")));
      var stc = h("div"); stc.appendChild(h("span", "pill " + st.tone, st.label));
      if (r.status === "not_qualified" && r.reason) stc.appendChild(h("small", null, R.REASONS[r.reason] || ""));
      if (r.status === "hold" && r.paid) stc.appendChild(h("small", null, "Confirms on " + fmt(r.paid + R.RULES.holdDays * 864e5)));
      tr.appendChild(td("Status", null, stc));
      var fl = h("div", "flags");
      if (!r.flags.length) fl.appendChild(h("span", "flag none", "No signals"));
      r.flags.forEach(function (f) { fl.appendChild(h("span", "flag", f)); });
      tr.appendChild(td("Fraud checks", null, fl));
      var acts = h("div", "acts");
      if (r.status === "review" || r.status === "hold") {
        var a = h("button", "btn sm", "Approve"); a.type = "button"; a.addEventListener("click", function () { decide(r, true); });
        var x = h("button", "btn sm danger", "Reject"); x.type = "button"; x.addEventListener("click", function () { decide(r, false); });
        acts.appendChild(a); acts.appendChild(x);
      } else acts.appendChild(h("span", "muted", "-"));
      tr.appendChild(td("Actions", "n", acts));
      tb.appendChild(tr);
    });
    if (!list.length) { var e = h("tr"), c = h("td", "empty", "No referrals match."); c.colSpan = 7; e.appendChild(c); tb.appendChild(e); }
    $("refH").textContent = F.status === "review" ? "Needs review" : "All referrals";
  }
  $("refQ").addEventListener("input", function (e) { F.q = e.target.value; refs(); });

  /* ---- ledger ---- */
  function ledger() {
    var tb = $("ledRows"); clear(tb);
    var sum = { applied: 0, scheduled: 0, held: 0 };
    D.ledger.forEach(function (l) {
      var st = R.REWARD[l.state] || R.REWARD.scheduled, v = R.monthValueUsd(l.plan), tr = h("tr");
      if (sum[l.state] != null) sum[l.state] += v;
      tr.appendChild(td("Reward", null, two(l.id, null, true)));
      tr.appendChild(td("Studio", null, two(l.studio, (R.PLAN_USD[l.plan] || {}).name || "")));
      tr.appendChild(td("Side", null, l.side));
      tr.appendChild(td("From", "m", l.from));
      tr.appendChild(td("Value (USD)", "n", usd(v)));
      tr.appendChild(td("State", null, h("span", "pill " + st.tone, st.label)));
      tr.appendChild(td("Date", null, l.when ? fmt(l.when) : "-"));
      tr.appendChild(td("Note", null, h("small", null, l.note)));
      tb.appendChild(tr);
    });
    var t = $("ledTot"); clear(t);
    [["Applied", sum.applied], ["Upcoming", sum.scheduled], ["Held", sum.held]].forEach(function (x) { var s = h("span", null, x[0] + ": "); s.appendChild(h("b", null, usd(x[1]))); t.appendChild(s); });
  }

  /* ---- partner codes ---- */
  function partners() {
    var tb = $("parRows"); clear(tb);
    D.partners.forEach(function (p) {
      var use = R.partnerUsable(p, D.now), tr = h("tr");
      tr.appendChild(td("Code", null, two(p.code, p.kind + (p.kind === "Influencer" ? (p.disclosure ? " · labels posts" : " · NO disclosure promise") : ""), true)));
      tr.appendChild(td("Partner", null, two(p.name, "Partner gets: " + (p.partnerReward === "months" ? "1 free month per paying studio" : p.partnerReward === "tracking" ? "tracking only" : "nothing"))));
      tr.appendChild(td("New studio gets", null, R.partnerOffer(p) || "Nothing (tracking only)"));
      tr.appendChild(td("Uses", "n", (p.uses | 0) + (p.maxUses ? " / " + p.maxUses : "")));
      tr.appendChild(td("Sign-ups", "n", p.signups | 0));
      tr.appendChild(td("Paid", "n", p.paid | 0));
      tr.appendChild(td("Conversion", "n", Math.round((p.paid | 0) / Math.max(1, p.signups | 0) * 100) + "%"));
      tr.appendChild(td("Ends", null, p.expiresAt ? fmt(p.expiresAt) : "No end date"));
      tr.appendChild(td("Status", null, h("span", "pill " + (use.ok ? "good" : p.active ? "warn" : ""), use.ok ? "Active" : !p.active ? "Disabled" : p.expiresAt && D.now > p.expiresAt ? "Expired" : "Limit reached")));
      var acts = h("div", "acts");
      var ed = h("button", "btn sm", "Edit"); ed.type = "button"; ed.addEventListener("click", function () { openCode(p); });
      var tg = h("button", "btn sm" + (p.active ? " danger" : ""), p.active ? "Disable" : "Enable"); tg.type = "button";
      tg.addEventListener("click", function () { p.active = !p.active; toast((p.active ? "Enabled " : "Disabled ") + p.code + ". Demo mode - nothing is saved."); partners(); kpis(); });
      acts.appendChild(ed); acts.appendChild(tg);
      tr.appendChild(td("Actions", "n", acts));
      tb.appendChild(tr);
    });
  }

  /* ---- new / edit code ---- */
  var editing = null;
  function val(id) { return $(id).value; }
  function syncForm() {
    var rw = val("fc_reward");
    $("fc_months_l").hidden = rw !== "months"; $("fc_pct_l").hidden = rw !== "percent"; $("fc_for_l").hidden = rw !== "percent";
    $("fc_disc_l").hidden = val("fc_kind") !== "Influencer";
    var p = { reward: rw, months: +val("fc_months"), percent: +val("fc_pct"), forMonths: +val("fc_for") };
    var code = R.normalizeCode(val("fc_code")) || "CODE";
    $("fc_prev").textContent = "Sign-up page will say: “Applied: " + (R.partnerOffer(p) || "code saved (tracking only)") + ".” Link: " + location.origin + "/signup?ref=" + code;
  }
  function openCode(p) {
    editing = p || null;
    $("mCodeH").textContent = p ? "Edit " + p.code : "New partner code";
    $("fc_code").value = p ? p.code : ""; $("fc_code").disabled = !!p;
    $("fc_name").value = p ? p.name : ""; $("fc_kind").value = p ? p.kind : "Influencer";
    $("fc_reward").value = p ? p.reward : "months"; $("fc_months").value = p && p.months ? p.months : 1;
    $("fc_pct").value = p && p.percent ? p.percent : 20; $("fc_for").value = p && p.forMonths ? p.forMonths : 3;
    $("fc_preward").value = p ? p.partnerReward : "tracking"; $("fc_max").value = p ? p.maxUses : 0;
    $("fc_end").value = p && p.expiresAt ? new Date(p.expiresAt).toISOString().slice(0, 10) : "";
    $("fc_disc").checked = !!(p && p.disclosure);
    $("fc_code_err").hidden = true;
    $("mScrim").hidden = false; $("mCode").hidden = false; syncForm();
    setTimeout(function () { (p ? $("fc_name") : $("fc_code")).focus(); }, 30);
  }
  function closeCode() { $("mScrim").hidden = true; $("mCode").hidden = true; editing = null; }
  ["fc_reward", "fc_kind", "fc_months", "fc_pct", "fc_for", "fc_code"].forEach(function (id) { $(id).addEventListener("input", syncForm); $(id).addEventListener("change", syncForm); });
  $("btnNewCode").addEventListener("click", function () { openCode(null); });
  $("btnNewCode2").addEventListener("click", function () { openCode(null); });
  $("fc_cancel").addEventListener("click", closeCode);
  $("mScrim").addEventListener("click", closeCode);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !$("mCode").hidden) closeCode(); });
  $("fCode").addEventListener("submit", function (e) {
    e.preventDefault();
    var err = $("fc_code_err"), code = R.normalizeCode(val("fc_code"));
    function bad(t) { err.textContent = t; err.hidden = false; $("fc_code").focus(); }
    if (!editing) {
      if (!code) return bad("Use 3-24 letters, numbers, - or _.");
      if (D.lookup[code] || D.partners.some(function (p) { return p.code === code; })) return bad("That code is already taken (codes are unique, studio codes included).");
    }
    if (!val("fc_name").trim()) { $("fc_name").focus(); return; }
    if (val("fc_kind") === "Influencer" && !$("fc_disc").checked) { $("fc_disc").focus(); toast("Influencer codes need the disclosure promise first."); return; }
    var end = val("fc_end") ? Date.parse(val("fc_end") + "T23:59:59+05:30") : 0;
    var p = editing || { code: code, uses: 0, clicks: 0, signups: 0, paid: 0, active: true, createdAt: Date.now() };
    p.name = val("fc_name").trim(); p.kind = val("fc_kind"); p.reward = val("fc_reward");
    p.months = Math.max(1, Math.min(3, +val("fc_months") || 1)); p.percent = Math.max(5, Math.min(50, +val("fc_pct") || 20)); p.forMonths = Math.max(1, Math.min(12, +val("fc_for") || 3));
    p.partnerReward = val("fc_preward"); p.maxUses = Math.max(0, +val("fc_max") || 0); p.expiresAt = end || 0; p.disclosure = $("fc_disc").checked;
    if (!editing) { D.partners.unshift(p); D.lookup[p.code] = { kind: "partner", partner: p }; }
    toast((editing ? "Saved " : "Added ") + p.code + ". Demo mode - nothing is saved.");
    closeCode(); partners(); kpis();
  });

  /* ---- program rules ---- */
  function rules() {
    var RL = R.RULES, kv = $("rulesKv"); clear(kv);
    [["Reward (both sides)", "1 month of the studio's own plan. Never cash, not transferable."],
     ["Qualifying event", "New studio's first real (non-zero) payment, then " + RL.holdDays + " days with no refund, dispute or cancellation."],
     ["New studio must pay within", RL.payWithinDays + " days of signing up"],
     ["Link remembered for", RL.linkDays + " days (last link wins; a typed code beats a link)"],
     ["Code added after sign-up", "Only by support, within " + RL.lateCodeDays + " days and before the first payment"],
     ["Cap per referrer", RL.capPerYear + " free months in any rolling 12 months"],
     ["Referrer not paying yet", "Reward held up to " + RL.heldMonths + " months for their first payment"],
     ["Referrer cancels", "Unused months frozen; back if they return within " + RL.frozenMonths + " months"],
     ["Unused months expire", RL.expiryMonths + " months after they were earned"],
     ["Yearly plans", "Each free month moves the renewal date one month later"],
     ["Review trigger", "Any fraud signal; more than " + RL.velocityPerDay + " sign-ups on one code in 24 hours"],
     ["Auto-reject", "Same e-mail, phone, payment card / UPI or GSTIN as the referrer"]]
      .forEach(function (x) { kv.appendChild(h("dt", null, x[0])); kv.appendChild(h("dd", null, x[1])); });
  }

  /* ---- tabs ---- */
  var tabs = ["t-ref", "t-rev", "t-led", "t-par", "t-set"], panes = { "t-ref": "p-ref", "t-rev": "p-ref", "t-led": "p-led", "t-par": "p-par", "t-set": "p-set" };
  tabs.forEach(function (id) {
    $(id).addEventListener("click", function () {
      tabs.forEach(function (t) { $(t).setAttribute("aria-selected", t === id ? "true" : "false"); });
      ["p-ref", "p-led", "p-par", "p-set"].forEach(function (p) { $(p).hidden = p !== panes[id]; });
      if (id === "t-rev") { F.status = "review"; chips(); refs(); } else if (id === "t-ref") { F.status = "all"; chips(); refs(); }
    });
  });
  var hashTab = { "#review": "t-rev", "#ledger": "t-led", "#partners": "t-par", "#rules": "t-set" }[location.hash];

  kpis(); chips(); refs(); ledger(); partners(); rules();
  if (hashTab) $(hashTab).click();
})();
