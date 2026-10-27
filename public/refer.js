/* refer.js - r29 studio page "Refer a studio".
   Real data (phase 2, SQL 0279): BPStore.referral.mine() -> my_referral (studio owner / admin only; the server decides
   everything: the code, the statuses, the free months). Program switched off in HQ -> "coming soon". Not the admin ->
   a plain notice. Referred studios show their name only if they agreed at sign-up (else their city).
   Demo (localhost + ?demo=1): renders made-up data from referral-demo.js.
   DOM via createElement / textContent only (CSP + Trusted Types). Rules text comes from referral-rules.js. */
(function () {
  "use strict";
  var R = window.HelmReferral, D = window.HelmReferralDemo || null;
  var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(location.hostname || ""));
  if (!LOCAL) D = null;
  if (D && D.store) window.BPStore = D.store;   /* demo only: the sidebar reads this read-only stand-in */
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  /* dd/mm/yyyy in India time (the studio formatters' style) */
  function fmt(ts) {
    if (!ts) return "";
    try { return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(ts)); }
    catch (e) { var d = new Date(ts); return ("0" + d.getDate()).slice(-2) + "/" + ("0" + (d.getMonth() + 1)).slice(-2) + "/" + d.getFullYear(); }
  }
  function toast(msg) { var t = $("rfToast"); if (!t) return; t.textContent = msg; clearTimeout(toast.t); toast.t = setTimeout(function () { t.textContent = ""; }, 3200); }
  function copy(text, done) {
    function fallback() {
      var ta = h("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.className = "sr-only"; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast(done); } catch (e) { toast("Select the text and copy it."); } document.body.removeChild(ta);
    }
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(function () { toast(done); }, fallback); return; } } catch (e) {}
    fallback();
  }
  function boot(show) { var b = $("boot"); if (b) b.hidden = true; show.hidden = false; }

  function day(v) { if (!v) return 0; var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 6) : Date.parse(v) || 0; }
  /* the server's answer -> the shape render() draws (the same as the demo data) */
  function fromServer(r) {
    var sub = r.subscription || {}, rw = Array.isArray(r.rewards) ? r.rewards : [], refs = Array.isArray(r.referrals) ? r.referrals : [];
    var mineR = rw.filter(function (l) { return l.side !== "referred"; });
    var end = day(sub.current_period_end);
    return {
      real: true,
      me: { studio: r.studio || "", plan: sub.plan_code || "studio", interval: sub.interval || "monthly", status: sub.status || "",
            code: r.code, nextRenewalAt: sub.paying && end ? end + 864e5 : 0, paying: !!sub.paying },
      mine: refs.map(function (x) {
        return { who: x.label || "A studio", city: x.city || "", masked: x.masked !== false, status: x.status, reason: x.reason || "",
                 signedUp: day(x.signed_up_at), paid: day(x.first_paid_at), holdUntil: day(x.hold_until), reward: x.reward_state || "" };
      }),
      myLedger: rw.map(function (l) {
        return { what: l.side === "referred" ? (l.kind === "discount" ? l.percent + "% off for " + l.for_months + " months (welcome offer)" : "Welcome month (you were referred)")
                       : "Free month from " + (l.from || "a studio"),
                 state: l.state, at: day(l.applied_at) || day(l.held_until) || day(l.expires_at), applied: !!l.applied_at,
                 from: day(l.applied_from), to: day(l.applied_to) };
      }),
      stats: { invited: Number(r.clicks) || 0, signed: refs.length, paid: refs.filter(function (x) { return x.status === "qualified"; }).length,
               earned: Number(r.earned_12m) || 0, used: mineR.filter(function (l) { return l.state === "applied"; }).length,
               up: mineR.filter(function (l) { return l.state === "scheduled"; }).length,
               held: mineR.filter(function (l) { return l.state === "held"; }).length },
      rules: r.rules || null
    };
  }
  function start() {
    if (!R) return;
    if (D) { $("rfDemo").hidden = false; render(D); boot($("rfApp")); return; }
    var S = window.BPStore;
    if (!S || !S.referral) { boot($("rfSoon")); return; }
    Promise.resolve(S.init ? S.init() : null).catch(function () {}).then(function () {
      if (S.auth && S.auth.enabled && S.auth.enabled() && !(S.auth.user && S.auth.user())) return null;   /* the sign-in gate takes over */
      return S.referral.mine();
    }).then(function (r) {
      if (r == null) return;
      if (!r || r.program_on === false || !r.code) { boot($("rfSoon")); return; }
      render(fromServer(r)); boot($("rfApp"));
    }).catch(function (e) {
      var c = String((e && e.code) || ""), m = String((e && e.message) || "");
      var soon = $("rfSoon");
      if (c === "42501" || /not authorized/i.test(m)) {
        $("rfSoonH").textContent = "Only the studio owner or admin can see this";
        soon.querySelector("p").textContent = "Ask your studio owner or admin for your studio's referral link.";
      } else if (!(c === "PGRST202" || c === "42883")) {
        $("rfSoonH").textContent = "Couldn't load your referrals";
        soon.querySelector("p").textContent = "Please refresh the page in a moment.";
      }
      boot(soon);
    });
  }

  function render(D) {
    var me = D.me, link = R.shareLink(me.code, location.origin.indexOf("localhost") >= 0 || location.hostname === "127.0.0.1" ? location.origin : "https://helm.events");
    var RL = (D.rules && D.rules.hold_days != null) ? { holdDays: D.rules.hold_days, capPerYear: D.rules.cap_per_year, heldMonths: D.rules.held_months } : R.RULES;
    $("rfLink").value = link;
    $("rfCode").textContent = me.code;
    var msg = "I run " + me.studio + " on Helm for quotes, layouts and our team. Try it with my link: you get 8 days free, then 1 free month after your first payment. " + link;
    $("rfWa").href = "https://wa.me/?text=" + encodeURIComponent(msg);
    $("rfMail").href = "mailto:?subject=" + encodeURIComponent("A month of Helm free, from " + me.studio) + "&body=" + encodeURIComponent(msg);
    $("rfCopyLink").addEventListener("click", function () { copy(link, "Link copied."); });
    $("rfCopyCode").addEventListener("click", function () { copy(me.code, "Code copied."); });
    $("rfCopyMsg").addEventListener("click", function () { copy(msg, "Message copied. Paste it anywhere."); });

    /* numbers */
    var c = { clicked: 0, signed: 0, paid: 0 };
    D.mine.forEach(function (r) { c.clicked++; if (r.status !== "clicked") c.signed++; if (r.status === "qualified") c.paid++; });
    var used = D.myLedger.filter(function (l) { return l.state === "applied"; }).length;
    var up = D.myLedger.filter(function (l) { return l.state === "scheduled"; }).length, earned = used + up;
    if (D.stats) { c.clicked = D.stats.invited; c.signed = D.stats.signed; c.paid = D.stats.paid; used = D.stats.used; up = D.stats.up; earned = D.stats.earned; }
    var stats = $("rfStats"); clear(stats);
    [["Invited", c.clicked, "times your link was opened"], ["Signed up", c.signed, "created a Helm account"], ["Became paid", c.paid, "paying studios"],
     ["Free months earned", earned, "in 12 months (most: " + RL.capPerYear + ")"], ["Used", used, D.real ? "renewals that were free" : "already billed $0"], ["Upcoming", up, "next renewals free"]]
      .forEach(function (s, i) { var t = h("div", "rf-stat" + (i === 3 ? " good" : "")); t.appendChild(h("span", "l", s[0])); t.appendChild(h("b", "v", s[1])); t.appendChild(h("span", "s", s[2])); stats.appendChild(t); });

    /* next free months */
    var sched = R.freeSchedule({ earned: up, nextRenewalAt: me.nextRenewalAt, interval: me.interval });
    var plan = R.PLAN_USD[me.plan] || R.PLAN_USD.studio, held = D.stats ? D.stats.held : 0;
    $("rfNextBig").textContent = up ? up + " free month" + (up === 1 ? "" : "s") + " coming" : held ? held + " free month" + (held === 1 ? "" : "s") + " waiting" : "No free months yet";
    var ol = $("rfSched"); clear(ol);
    if (up && me.nextRenewalAt) {
      $("rfNextLine").textContent = D.real
        ? (me.interval === "yearly" ? "Each free month moves your yearly renewal one month later. Your renewal moves to " + fmt(R.addMonths(me.nextRenewalAt, up)) + "."
           : "Your " + plan.name + " plan is not charged on these renewals. Billing starts again on " + fmt(R.addMonths(me.nextRenewalAt, up)) + ".")
        : "Your " + plan.name + " plan ($" + plan.monthly + "/month) is not charged on these renewals. Billing starts again on " + fmt(R.addMonths(me.nextRenewalAt, up)) + ".";
      sched.forEach(function (s) { var li = h("li"); li.appendChild(h("b", null, fmt(s.from))); li.appendChild(h("span", null, s.kind === "extend" ? "Renewal moves to " + fmt(s.to) : D.real ? "Renewal free" : "Renewal billed $0")); ol.appendChild(li); });
      var li2 = h("li", "after"); li2.appendChild(h("b", null, fmt(R.addMonths(me.nextRenewalAt, up)))); li2.appendChild(h("span", null, D.real ? "Normal billing resumes" : "Normal billing resumes ($" + plan.monthly + ")")); ol.appendChild(li2);
    } else {
      $("rfNextLine").textContent = held ? "You earned them while on your free trial. They start with your first payment (they wait up to " + (RL.heldMonths || 6) + " months)."
        : up ? "They are used on your next renewals." : "Refer a studio to earn your first free month.";
    }

    /* referral list */
    var filter = "all";
    function rows() {
      var tb = $("rfRows"); clear(tb);
      D.mine.filter(function (r) {
        if (filter === "all") return true;
        if (filter === "progress") return r.status !== "qualified" && r.status !== "not_qualified";
        return r.status === filter;
      }).forEach(function (r) {
        var st = R.STATUS[r.status] || R.STATUS.clicked, tr = h("tr");
        var td1 = h("td"); td1.setAttribute("data-l", "Studio"); td1.appendChild(h("b", r.masked ? "masked" : null, r.who)); if (r.city && !r.masked) td1.appendChild(h("small", null, r.city)); tr.appendChild(td1);
        var td2 = h("td", "n"); td2.setAttribute("data-l", "Date"); td2.textContent = fmt(r.signedUp); tr.appendChild(td2);
        var td3 = h("td"); td3.setAttribute("data-l", "Status"); td3.appendChild(h("span", "rf-pill " + st.tone, st.label)); tr.appendChild(td3);
        var td4 = h("td", "why"); td4.setAttribute("data-l", "What it means");
        td4.textContent = r.status === "not_qualified" ? (R.REASONS[r.reason] || st.help)
          : r.status === "qualified" ? (r.reward === "applied" ? "You earned 1 free month (already used)." : r.reward === "held" ? "You earned 1 free month (starts with your first payment)."
            : r.reward === "capped" ? "They became a paying studio. You already have the most free months allowed this year." : r.reward === "frozen" ? "You earned 1 free month (frozen while your plan is cancelled)."
            : r.reward === "expired" ? "You earned 1 free month (it expired unused)." : "You earned 1 free month (upcoming).")
          : r.status === "hold" && r.holdUntil ? "Paid their first bill. Your month is confirmed on " + fmt(r.holdUntil) + " if there is no refund." : st.help;
        tr.appendChild(td4); tb.appendChild(tr);
      });
      if (!tb.firstChild) { var e = h("tr"), td = h("td", "empty", "Nothing here yet."); td.colSpan = 4; e.appendChild(td); tb.appendChild(e); }
    }
    Array.prototype.forEach.call(document.querySelectorAll(".rf-chip"), function (b) {
      b.addEventListener("click", function () {
        filter = b.getAttribute("data-f");
        Array.prototype.forEach.call(document.querySelectorAll(".rf-chip"), function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); });
        rows();
      });
    });
    rows();

    /* ledger */
    var ul = $("rfLedger"); clear(ul);
    D.myLedger.forEach(function (l) {
      var st = R.REWARD[l.state] || R.REWARD.scheduled, li = h("li");
      var when = D.real
        ? (l.state === "applied" ? (l.from ? "Free from " + fmt(l.from) + " to " + fmt(l.to) : "Given on " + fmt(l.at)) : l.state === "held" ? "Waits for your first payment (until " + fmt(l.at) + ")"
           : l.state === "scheduled" ? "Used on your next renewal" + (l.at ? " (expires " + fmt(l.at) + " if unused)" : "") : "")
        : (l.state === "applied" ? "Billed $0 on " + fmt(l.at) : "Renewal on " + fmt(l.at));
      var a = h("div"); a.appendChild(h("b", null, l.what)); if (when) a.appendChild(h("small", null, when));
      li.appendChild(a); li.appendChild(h("span", "rf-pill " + st.tone, st.label)); ul.appendChild(li);
    });

    if (!D.myLedger.length) { var e0 = h("li"); e0.appendChild(h("div", null, "No free months yet.")); ul.appendChild(e0); }

    /* rules */
    var rl = $("rfRules"); clear(rl);
    ["The studio must be new to Helm and sign up with your link or code. One code per studio.",
     "You earn your month after their first real payment, plus " + RL.holdDays + " days with no refund or dispute.",
     "Each free month covers your next renewal. Several referrals stack as free months in a row, up to " + RL.capPerYear + " in any 12 months.",
     "On a yearly plan, each free month moves your renewal date one month later.",
     "Still on your trial? Your earned months wait (up to " + RL.heldMonths + " months) until you start paying.",
     "Referring yourself, a second account or a business you own does not count.",
     "A free month is one month of your plan. It has no cash value and cannot be swapped for money."]
      .forEach(function (t) { rl.appendChild(h("li", null, t)); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
