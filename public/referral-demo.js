/* referral-demo.js - r29 referral program PHASE 1: made-up data for the click-through demo, on the owner's own computer only.
   Runs ONLY when the page is on localhost / 127.0.0.1 / [::1] AND the address has ?demo=1. Anywhere else it does nothing.
   Never deployed (.vercelignore). No network call, no storage, no sign-in. Every studio, person and number is invented.
   Exposes window.HelmReferralDemo (studio view + HQ view + partner codes) and, for the studio page's sidebar only,
   a tiny stand-in for window.BPStore (read-only, "Demo mode - nothing is saved"). */
(function () {
  "use strict";
  var host = String((location && location.hostname) || "");
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host)) return;
  if (!/(^|[?&])demo=1(&|$)/.test(String(location.search || "").replace(/^\?/, ""))) return;

  var DAY = 864e5, now = Date.now();
  function ago(d) { return now - d * DAY; }
  function ahead(d) { return now + d * DAY; }

  /* ---- the signed-in studio (the referrer) ---- */
  var me = {
    studio: "Shaadi Squad Events", owner: "Kavya Iyer", plan: "studio", interval: "monthly", status: "active",
    code: "SHAADISQ-7K2Q", nextRenewalAt: ahead(9), paidSince: ago(96)
  };
  /* [who (shown only with their consent, else a masked name), status, days ago signed up, reason?, flags?] */
  var mine = [
    { who: "Marigold Moments", city: "Chennai", status: "qualified", signedUp: ago(71), paid: ago(33), reward: "applied" },
    { who: "Royal Mandap", city: "Udaipur", status: "qualified", signedUp: ago(52), paid: ago(19), reward: "scheduled" },
    { who: "Utsav Collective", city: "Pune", status: "qualified", signedUp: ago(44), paid: ago(15), reward: "scheduled" },
    { who: "A studio in Jaipur", city: "Jaipur", status: "hold", signedUp: ago(40), paid: ago(6), masked: true },
    { who: "Gulmohar Weddings", city: "Bengaluru", status: "first_month", signedUp: ago(12) },
    { who: "A studio in Kochi", city: "Kochi", status: "trial", signedUp: ago(3), masked: true },
    { who: "Rangoli Studio", city: "Ahmedabad", status: "not_qualified", signedUp: ago(80), reason: "refunded" },
    { who: "A studio in Hyderabad", city: "Hyderabad", status: "not_qualified", signedUp: ago(30), reason: "self_referral", masked: true },
    { who: "Someone opened your link", city: "", status: "clicked", signedUp: ago(1), masked: true },
    { who: "Someone opened your link", city: "", status: "clicked", signedUp: ago(2), masked: true }
  ];
  /* free-month ledger for this studio */
  var myLedger = [
    { month: "September 2026", what: "Free month from Marigold Moments", state: "applied", at: ago(20) },
    { month: "Next renewal", what: "Free month from Royal Mandap", state: "scheduled", at: ahead(9) },
    { month: "The renewal after", what: "Free month from Utsav Collective", state: "scheduled", at: ahead(39) }
  ];

  /* ---- partner / marketing codes (HQ) ---- */
  var partners = [
    { code: "INSTA_PRIYA", name: "Priya Weds (Instagram creator)", kind: "Influencer", reward: "months", months: 2, percent: 0, forMonths: 0,
      partnerReward: "tracking", active: true, expiresAt: ahead(70), maxUses: 200, uses: 64, clicks: 1840, signups: 64, paid: 19, disclosure: true, createdAt: ago(40) },
    { code: "MKT-DIWALI", name: "Diwali 2026 campaign", kind: "Campaign", reward: "percent", months: 0, percent: 30, forMonths: 3,
      partnerReward: "none", active: true, expiresAt: ahead(18), maxUses: 0, uses: 112, clicks: 5210, signups: 112, paid: 27, disclosure: false, createdAt: ago(25) },
    { code: "EXPO-HYD", name: "Hyderabad Wedding Expo stall", kind: "Event", reward: "months", months: 1, percent: 0, forMonths: 0,
      partnerReward: "none", active: true, expiresAt: ahead(5), maxUses: 150, uses: 148, clicks: 0, signups: 148, paid: 31, disclosure: false, createdAt: ago(60) },
    { code: "YT-RAHULPLANS", name: "Rahul Plans (YouTube)", kind: "Influencer", reward: "months", months: 1, percent: 0, forMonths: 0,
      partnerReward: "months", active: false, expiresAt: ahead(120), maxUses: 0, uses: 9, clicks: 410, signups: 9, paid: 1, disclosure: true, createdAt: ago(90) },
    { code: "WEDEXPO25", name: "Wedding Expo 2025", kind: "Event", reward: "none", months: 0, percent: 0, forMonths: 0,
      partnerReward: "none", active: true, expiresAt: ago(220), maxUses: 0, uses: 41, clicks: 0, signups: 41, paid: 6, disclosure: false, createdAt: ago(400) }
  ];

  /* ---- every referral on the platform (HQ). flags = fraud signals in plain words ---- */
  var all = [
    { id: "RF-1042", referrer: "Shaadi Squad Events", referrerPlan: "studio", referrerState: "paying", code: "SHAADISQ-7K2Q", referee: "Marigold Moments", refereeEmail: "karthik@marigoldmoments.in", signedUp: ago(71), paid: ago(33), status: "qualified", flags: [], reward: "applied" },
    { id: "RF-1051", referrer: "Shaadi Squad Events", referrerPlan: "studio", referrerState: "paying", code: "SHAADISQ-7K2Q", referee: "Royal Mandap", refereeEmail: "vikram@royalmandap.com", signedUp: ago(52), paid: ago(19), status: "qualified", flags: [], reward: "scheduled" },
    { id: "RF-1058", referrer: "Shaadi Squad Events", referrerPlan: "studio", referrerState: "paying", code: "SHAADISQ-7K2Q", referee: "Utsav Collective", refereeEmail: "neha@utsavcollective.com", signedUp: ago(44), paid: ago(15), status: "qualified", flags: [], reward: "scheduled" },
    { id: "RF-1063", referrer: "Shaadi Squad Events", referrerPlan: "studio", referrerState: "paying", code: "SHAADISQ-7K2Q", referee: "Pink City Decor", refereeEmail: "meera@pinkcitydecor.in", signedUp: ago(40), paid: ago(6), status: "hold", flags: [], reward: "" },
    { id: "RF-1066", referrer: "Shaadi Squad Events", referrerPlan: "studio", referrerState: "paying", code: "SHAADISQ-7K2Q", referee: "Squad Events Hyd", refereeEmail: "kavya.iyer@gmail.com", signedUp: ago(30), paid: ago(2), status: "review",
      flags: ["Same device", "Same internet address", "Same phone number"], reward: "" },
    { id: "RF-1070", referrer: "Mehndi & Co.", referrerPlan: "starter", referrerState: "paying", code: "MEHNDICO-3HQX", referee: "Henna House", refereeEmail: "arjun@mehndico.in", signedUp: ago(9), paid: 0, status: "not_qualified", flags: ["Same company e-mail domain (mehndico.in)", "Same payment card or UPI"], reason: "self_referral", reward: "" },
    { id: "RF-1072", referrer: "Gulmohar Weddings", referrerPlan: "", referrerState: "trial", code: "GULMOHAR-8TPV", referee: "Lotus Lane Events", refereeEmail: "rhea@lotuslane.in", signedUp: ago(28), paid: ago(17), status: "qualified", flags: [], reward: "held" },
    { id: "RF-1075", referrer: "Baraat Bureau", referrerPlan: "studio", referrerState: "cancelled", code: "BARAATBU-5MKD", referee: "Awadh Affairs", refereeEmail: "sana@awadhaffairs.in", signedUp: ago(66), paid: ago(30), status: "qualified", flags: [], reward: "frozen" },
    { id: "RF-1077", referrer: "Utsav Collective", referrerPlan: "enterprise", referrerState: "paying", code: "INSTA_PRIYA", referee: "Saffron Stories", refereeEmail: "dev@saffronstories.in", signedUp: ago(20), paid: 0, status: "first_month", flags: [], reward: "", partner: true },
    { id: "RF-1079", referrer: "Desert Rose Events", referrerPlan: "studio", referrerState: "paying", code: "DESERTRO-2WJN", referee: "Oasis Occasions", refereeEmail: "omar@oasisoccasions.ae", signedUp: ago(25), paid: ago(5), status: "review",
      flags: ["Many sign-ups on this code in 24 hours (7)", "Throw-away e-mail service"], reward: "" },
    { id: "RF-1081", referrer: "Rangoli Studio", referrerPlan: "starter", referrerState: "paying", code: "RANGOLIS-9BCE", referee: "Garba Nights", refereeEmail: "nisha@garbanights.in", signedUp: ago(75), paid: 0, status: "not_qualified", flags: [], reason: "no_payment", reward: "" },
    { id: "RF-1083", referrer: "Shaadi Squad Events", referrerPlan: "studio", referrerState: "paying", code: "SHAADISQ-7K2Q", referee: "Rangoli Studio", refereeEmail: "hetal@rangolistudio.in", signedUp: ago(80), paid: ago(50), status: "not_qualified", flags: [], reason: "refunded", reward: "reversed" },
    { id: "RF-1086", referrer: "Royal Mandap", referrerPlan: "studio", referrerState: "paying", code: "ROYALMAN-6RTY", referee: "Sangeet Sutra", refereeEmail: "ishita@sangeetsutra.in", signedUp: ago(4), paid: 0, status: "not_qualified", flags: [], reason: "existing", reward: "" },
    { id: "RF-1088", referrer: "Royal Mandap", referrerPlan: "studio", referrerState: "paying", code: "ROYALMAN-6RTY", referee: "Thar Tales", refereeEmail: "kunal@thartales.in", signedUp: ago(2), paid: 0, status: "trial", flags: [], reward: "" }
  ];
  /* rewards ledger (HQ): one line per free month, both sides */
  var ledger = [
    { id: "RW-301", studio: "Shaadi Squad Events", side: "Referrer", from: "RF-1042", plan: "studio", state: "applied", when: ago(20), note: "September renewal billed $0" },
    { id: "RW-302", studio: "Marigold Moments", side: "New studio", from: "RF-1042", plan: "starter", state: "applied", when: ago(63), note: "Renewal after the first payment billed $0" },
    { id: "RW-303", studio: "Shaadi Squad Events", side: "Referrer", from: "RF-1051", plan: "studio", state: "scheduled", when: ahead(9), note: "Next renewal" },
    { id: "RW-304", studio: "Royal Mandap", side: "New studio", from: "RF-1051", plan: "studio", state: "applied", when: ago(49), note: "Renewal after the first payment billed $0" },
    { id: "RW-305", studio: "Shaadi Squad Events", side: "Referrer", from: "RF-1058", plan: "studio", state: "scheduled", when: ahead(39), note: "Stacked after the next free month" },
    { id: "RW-306", studio: "Gulmohar Weddings", side: "Referrer", from: "RF-1072", plan: "studio", state: "held", when: 0, note: "Referrer still on trial: waits for their first payment (up to 6 months)" },
    { id: "RW-307", studio: "Baraat Bureau", side: "Referrer", from: "RF-1075", plan: "studio", state: "frozen", when: 0, note: "Referrer cancelled: back if they return within 6 months" },
    { id: "RW-308", studio: "Shaadi Squad Events", side: "Referrer", from: "RF-1083", plan: "studio", state: "reversed", when: ago(36), note: "New studio refunded inside 14 days: never applied" },
    { id: "RW-309", studio: "Lotus Lane Events", side: "New studio", from: "RF-1072", plan: "starter", state: "applied", when: ago(25), note: "Renewal after the first payment billed $0" }
  ];

  /* codes the sign-up page recognises in the demo */
  var lookup = {
    "DEMO123": { kind: "referral", studio: "Shaadi Squad Events" },
    "SHAADISQ-7K2Q": { kind: "referral", studio: "Shaadi Squad Events" }
  };
  partners.forEach(function (p) { lookup[p.code] = { kind: "partner", partner: p }; });

  window.HelmReferralDemo = { me: me, mine: mine, myLedger: myLedger, partners: partners, all: all, ledger: ledger, lookup: lookup, now: now };

  /* sidebar stand-in for the studio page only (the real BPStore never loads in the demo) */
  if (/\/refer(\.html)?$/.test(location.pathname)) {
    var AREAS = [
      { key: "crm", label: "Clients", page: "crm.html", group: "Manage" }, { key: "staff", label: "Staff", page: "staff.html", group: "Manage" },
      { key: "inventory", label: "Inventory", page: "inventory.html", group: "Manage" }, { key: "vendors", label: "Vendors", page: "vendors.html", group: "Manage" },
      { key: "controls", label: "Settings", page: "control.html", group: "Admin" }, { key: "reports", label: "Reports", page: "reports.html", group: "Admin" }];
    window.HelmReferralDemo.store = { demo: true, auth: {
      areas: function () { return AREAS; }, canView: function () { return Promise.resolve(true); }, canEditArea: function () { return Promise.resolve(false); },
      user: function () { return { email: "kavya@shaadisquad.in", user_metadata: { full_name: me.owner } }; },
      role: function () { return "admin"; }, ready: function () { return Promise.resolve(); }
    } };   /* refer.js puts this in place of window.BPStore after store-api.js has loaded */
  }
})();
