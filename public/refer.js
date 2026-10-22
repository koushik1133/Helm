/* refer.js - r29 studio page "Refer a studio" (PHASE 1 = UI only).
   Demo (localhost + ?demo=1): renders made-up data from referral-demo.js. Anywhere else there is no referral backend yet,
   so the page shows "coming soon" after the normal sign-in gate. No network call of its own, no storage.
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

  function start() {
    if (!R) return;
    if (!D) { boot($("rfSoon")); return; }   /* phase 2: ask the server for this studio's code + referrals */
    $("rfDemo").hidden = false;
    render(D);
    boot($("rfApp"));
  }

  function render(D) {
    var me = D.me, link = R.shareLink(me.code, location.origin.indexOf("localhost") >= 0 || location.hostname === "127.0.0.1" ? location.origin : "https://helm.events");
    $("rfLink").value = link;
    $("rfCode").textContent = me.code;
    var msg = "I run " + me.studio + " on Helm for quotes, layouts and our team. Try it with my link: you get 8 days free, then your first paid month free. " + link;
    $("rfWa").href = "https://wa.me/?text=" + encodeURIComponent(msg);
    $("rfMail").href = "mailto:?subject=" + encodeURIComponent("A month of Helm free, from " + me.studio) + "&body=" + encodeURIComponent(msg);
    $("rfCopyLink").addEventListener("click", function () { copy(link, "Link copied."); });
    $("rfCopyCode").addEventListener("click", function () { copy(me.code, "Code copied."); });
    $("rfCopyMsg").addEventListener("click", function () { copy(msg, "Message copied. Paste it anywhere."); });

    /* numbers */
    var c = { clicked: 0, signed: 0, paid: 0 };
    D.mine.forEach(function (r) { c.clicked++; if (r.status !== "clicked") c.signed++; if (r.status === "qualified") c.paid++; });
    var used = D.myLedger.filter(function (l) { return l.state === "applied"; }).length;
    var up = D.myLedger.filter(function (l) { return l.state === "scheduled"; }).length;
    var stats = $("rfStats"); clear(stats);
    [["Invited", c.clicked, "people opened your link"], ["Signed up", c.signed, "created a Helm account"], ["Became paid", c.paid, "paying studios"],
     ["Free months earned", used + up, "this year (most: " + R.RULES.capPerYear + ")"], ["Used", used, "already billed $0"], ["Upcoming", up, "next renewals free"]]
      .forEach(function (s, i) { var t = h("div", "rf-stat" + (i === 3 ? " good" : "")); t.appendChild(h("span", "l", s[0])); t.appendChild(h("b", "v", s[1])); t.appendChild(h("span", "s", s[2])); stats.appendChild(t); });

    /* next free months */
    var sched = R.freeSchedule({ earned: up, nextRenewalAt: me.nextRenewalAt, interval: me.interval });
    var plan = R.PLAN_USD[me.plan] || R.PLAN_USD.studio;
    $("rfNextBig").textContent = up ? up + " free month" + (up === 1 ? "" : "s") + " coming" : "No free months yet";
    $("rfNextLine").textContent = up ? "Your " + plan.name + " plan ($" + plan.monthly + "/month) is not charged on these renewals. Billing starts again on " + fmt(R.addMonths(me.nextRenewalAt, up)) + "."
      : "Refer a studio to earn your first free month.";
    var ol = $("rfSched"); clear(ol);
    sched.forEach(function (s) { var li = h("li"); li.appendChild(h("b", null, fmt(s.from))); li.appendChild(h("span", null, s.kind === "extend" ? "Renewal moves to " + fmt(s.to) : "Renewal billed $0")); ol.appendChild(li); });
    var li2 = h("li", "after"); li2.appendChild(h("b", null, fmt(R.addMonths(me.nextRenewalAt, up)))); li2.appendChild(h("span", null, "Normal billing resumes ($" + plan.monthly + ")")); ol.appendChild(li2);

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
        td4.textContent = r.status === "not_qualified" ? (R.REASONS[r.reason] || st.help) : r.status === "qualified" ? (r.reward === "applied" ? "You earned 1 free month (already used)." : "You earned 1 free month (upcoming).") : st.help;
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
      var a = h("div"); a.appendChild(h("b", null, l.what)); a.appendChild(h("small", null, l.state === "applied" ? "Billed $0 on " + fmt(l.at) : "Renewal on " + fmt(l.at)));
      li.appendChild(a); li.appendChild(h("span", "rf-pill " + st.tone, st.label)); ul.appendChild(li);
    });

    /* rules */
    var RL = R.RULES, rl = $("rfRules"); clear(rl);
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
