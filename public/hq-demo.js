/* hq-demo.js - r28 HQ v2: a CLICK-THROUGH DEMO of Helm HQ with made-up data, for the owner's own computer only.
   Loaded by hq.js only when the page is on localhost / 127.0.0.1 / [::1] AND the address has ?demo=1. It checks the
   host again here and does nothing anywhere else. It is never deployed (.vercelignore).
   It swaps window.BPStore for an in-browser fake: no network call, no Supabase, no sign-in. Every name, e-mail, phone
   and amount below is invented. Changes are refused with a plain sentence ("Demo mode - nothing is saved").
   Preview a role: hq.html?demo=1&role=sales (owner | admin | sales | security | support | viewer). */
(function () {
  "use strict";
  var host = String((location && location.hostname) || "");
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host)) return;
  if (!/(^|[?&])demo=1(&|$)/.test(String(location.search || "").replace(/^\?/, ""))) return;

  var DAY = 864e5, now = Date.now();
  function ago(d) { return new Date(now - d * DAY).toISOString(); }
  function ahead(d) { return new Date(now + d * DAY).toISOString(); }
  function day(d) { return new Date(now + d * DAY).toISOString().slice(0, 10); }
  function uuid(n) { var h = ("00000000" + n.toString(16)).slice(-8); return h + "-0000-4000-8000-00000000" + ("0000" + n.toString(16)).slice(-4); }
  var roleQ = /(?:^|[?&])role=([a-z]+)/.exec(String(location.search || "")), ROLE = roleQ ? roleQ[1] : "owner";
  var S = window.HelmHqStaff || null;
  if (!S || !S.ROLE_PERMS[ROLE]) ROLE = "owner";
  var ME_EMAIL = ROLE === "owner" ? "admin@helm.events" : ROLE + "@helm.events";

  var PLANS = [
    { code: "starter", name: "Starter", price_monthly: 1499, currency: "INR", active: true, studios: 4 },
    { code: "studio", name: "Studio", price_monthly: 3999, currency: "INR", active: true, studios: 5 },
    { code: "enterprise", name: "Enterprise", price_monthly: 9999, currency: "INR", active: true, studios: 1 },
    { code: "legacy", name: "Legacy 2025", price_monthly: 999, currency: "INR", active: false, studios: 0 }];
  var PLAN_BY = {}; PLANS.forEach(function (p) { PLAN_BY[p.code] = p; });
  // [name, slug, city, state, contact, email, phone, status, plan, people, paid, lastDays, joinedDays]
  var RAW = [
    ["Shaadi Squad Events", "shaadisquad", "Hyderabad", "Telangana", "Kavya Iyer", "kavya@shaadisquad.in", "+91 98490 11223", "active", "studio", 9, 47988, 0, 210],
    ["Mehndi & Co.", "mehndi-co", "Jaipur", "Rajasthan", "Arjun Mehta", "arjun@mehndico.in", "+91 99280 44551", "active", "starter", 4, 17988, 1, 160],
    ["Utsav Collective", "utsav", "Pune", "Maharashtra", "Neha Kulkarni", "neha@utsavcollective.com", "+91 98220 67810", "active", "enterprise", 23, 119988, 0, 300],
    ["Baraat Bureau", "baraat-bureau", "Lucknow", "Uttar Pradesh", "Rohit Srivastava", "rohit@baraatbureau.in", "+91 94150 90876", "past_due", "studio", 7, 31992, 12, 190],
    ["Gulmohar Weddings", "gulmohar", "Bengaluru", "Karnataka", "Ananya Rao", "ananya@gulmoharweddings.in", "+91 99000 31415", "trial", "", 3, 0, 0, 5],
    ["Marigold Moments", "marigold", "Chennai", "Tamil Nadu", "Karthik Subramaniam", "karthik@marigoldmoments.in", "+91 98400 27182", "trial", "", 2, 0, 2, 7],
    ["Desert Rose Events", "desert-rose", "Dubai", "Dubai", "Fatima Al Mansoori", "fatima@desertrose.ae", "+971 50 123 4567", "active", "studio", 6, 357, 3, 120],
    ["Rangoli Studio", "rangoli", "Ahmedabad", "Gujarat", "Hetal Shah", "hetal@rangolistudio.in", "+91 98250 88990", "active", "starter", 3, 8994, 21, 140],
    ["Sangeet Sutra", "sangeet-sutra", "Kolkata", "West Bengal", "Ishita Banerjee", "ishita@sangeetsutra.in", "+91 98300 55667", "suspended", "starter", 2, 4497, 45, 260],
    ["Royal Mandap", "royal-mandap", "Udaipur", "Rajasthan", "Vikram Singh", "vikram@royalmandap.com", "+91 94141 23456", "active", "studio", 11, 63984, 0, 330],
    ["Haldi House", "haldi-house", "Kochi", "Kerala", "Meera Nair", "meera@haldihouse.in", "+91 98470 14141", "trial", "", 1, 0, 4, 9],
    ["Phoolon Ki Baat", "phoolon", "Delhi", "Delhi", "Sana Qureshi", "sana@phoolonkibaat.in", "+91 98110 76543", "cancelled", "starter", 2, 2998, 70, 280],
    ["Tamarind Tales", "tamarind", "Goa", "Goa", "Leon D'Souza", "leon@tamarindtales.com", "+91 98220 33445", "active", "studio", 5, 23994, 6, 100],
    ["Kesar Celebrations", "kesar", "Indore", "Madhya Pradesh", "Pooja Jain", "pooja@kesarcelebrations.in", "+91 98260 12121", "trial", "", 2, 0, 1, 3]];
  var STUDIOS = RAW.map(function (r, i) {
    var p = PLAN_BY[r[8]] || null, st = r[7];
    return { org_id: uuid(100 + i), name: r[0], slug: r[1], city: r[2], state: r[3], country: r[2] === "Dubai" ? "AE" : "IN",
      primary_contact_name: r[4], primary_contact_email: r[5], primary_contact_phone: r[6], owner_email: r[5], status: st,
      plan_code: p ? p.code : null, plan_name: p ? p.name : null, users_count: r[9], total_paid: r[10], last_activity: ago(r[11]),
      created_at: ago(r[12]), current_period_end: st === "active" ? day(8 + i * 2) : st === "past_due" ? day(-12) : null,
      trial_ends_at: st === "trial" ? ahead(8 - Math.min(7, Math.floor(r[12] / 1.2))) : null,
      billing_currency: r[2] === "Dubai" ? "USD" : "INR", paid_currency: r[2] === "Dubai" ? "USD" : "INR",
      referral: { code: r[1].toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) + "26", referred_by: i % 4 === 1 ? "SHAADI26 (Shaadi Squad Events)" : i % 5 === 2 ? "Partner: WedPlanners India" : null,
        referred_count: [3, 0, 1, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 0][i], credits: [3 * 1499, 0, 1499, 0, 0, 0, 2 * 1499, 0, 0, 1499, 0, 0, 0, 0][i], credits_currency: "INR" },
      active_days_30d: [27, 18, 29, 9, 5, 4, 15, 6, 0, 24, 3, 0, 12, 2][i], sign_ins_30d: [142, 37, 311, 22, 9, 6, 48, 7, 0, 96, 4, 0, 30, 3][i] };
  });
  var BY_ORG = {}; STUDIOS.forEach(function (s) { BY_ORG[s.org_id] = s; });
  function count(st) { return STUDIOS.filter(function (s) { return s.status === st; }).length; }
  var FIRST = ["Priya", "Rahul", "Aisha", "Dev", "Simran", "Nikhil", "Tara", "Kabir", "Riya", "Aman", "Zoya", "Varun"];
  var USERS = [];
  STUDIOS.forEach(function (s, i) {
    var dom = s.primary_contact_email.split("@")[1];
    for (var k = 0; k < Math.min(s.users_count, 4); k++) {
      var nm = k === 0 ? s.primary_contact_name : FIRST[(i * 3 + k) % FIRST.length];
      USERS.push({ user_id: uuid(1000 + USERS.length), email: k === 0 ? s.primary_contact_email : nm.toLowerCase() + "@" + dom, studio: s.name, org_id: s.org_id,
        role: k === 0 ? "admin" : ["planner", "coordinator", "sales"][k % 3], created_at: ago(30 + i * 9 + k), last_sign_in_at: ago((i + k) % 9),
        email_confirmed: k !== 3, mfa_enabled: (i + k) % 3 !== 0, display_name: nm });
    }
  });
  var PAYMENTS = [];
  STUDIOS.filter(function (s) { return s.total_paid > 0; }).forEach(function (s, i) {
    var p = PLAN_BY[s.plan_code] || PLANS[0], months = Math.max(1, Math.round(s.total_paid / (p.price_monthly * 1.18 || 1)));
    for (var m = 0; m < Math.min(months, 3); m++) {
      var amt = Math.round(p.price_monthly * 1.18), d = -(m * 30 + i * 2 + 1);
      PAYMENTS.push({ id: uuid(5000 + PAYMENTS.length), org_id: s.org_id, studio: s.name, paid_on: day(d), invoice_no: "HELM-2026-" + String(140 - PAYMENTS.length).padStart(4, "0"),
        method: ["upi", "bank", "upi", "card"][(i + m) % 4], period_start: day(d), period_end: day(d + 29), amount: s.country === "AE" ? 119 : amt,
        currency: s.country === "AE" ? "USD" : "INR", net_amount: s.country === "AE" ? 119 : p.price_monthly, gst_amount: s.country === "AE" ? 0 : amt - p.price_monthly,
        reference: "UTR" + (412000000000 + PAYMENTS.length * 7919), voided: false, tax_regime: s.country === "AE" ? "EXPORT_LUT" : "IN_GST_INTRA" });
    }
  });
  PAYMENTS.sort(function (a, b) { return a.paid_on < b.paid_on ? 1 : -1; });
  var AUDIT = [
    { at: ago(0.01), actor_email: "admin@helm.events", action: "hq.payment.record", entity: "quote_payment", entity_id: "HELM-2026-0139" },
    { at: ago(0.2), actor_email: "security@helm.events", action: "hq.reveal", entity: "studio", entity_id: STUDIOS[3].org_id, changed: { field: "phone" } },
    { at: ago(0.3), actor_email: "sales@helm.events", action: "hq.sales_enquiry.update", entity: "sales_enquiry", entity_id: uuid(7001) },
    { at: ago(1.1), actor_email: "admin@helm.events", action: "hq.trial.extend", entity: "organization", entity_id: STUDIOS[4].org_id },
    { at: ago(1.4), actor_email: "admin@helm.events", action: "hq.view", entity: "hq_studios", entity_id: null },
    { at: ago(2.2), actor_email: "security@helm.events", action: "hq.mfa.reset", entity: "user", entity_id: uuid(1004) },
    { at: ago(3.5), actor_email: "admin@helm.events", action: "hq.studio.suspend", entity: "organization", entity_id: STUDIOS[8].org_id },
    { at: ago(2), actor_email: "admin@helm.events", action: "hq.staff.invite", entity: "platform_admin", entity_id: "support@helm.events" },
    { at: ago(6), actor_email: "admin@helm.events", action: "hq.staff.invite", entity: "platform_admin", entity_id: "sales@helm.events" }];

  function list(v) { return v; }
  function page(rows, args) { var off = Number(args.p_offset) || 0, lim = Number(args.p_limit) || 25, out = rows.slice(off, off + lim); out.forEach(function (r) { r.total_count = rows.length; }); return out; }
  function match(q, fields) { q = String(q || "").toLowerCase(); return !q || fields.some(function (f) { return String(f || "").toLowerCase().indexOf(q) >= 0; }); }
  function inr(n) { return [{ amount: n, currency: "INR" }]; }
  var mrr = STUDIOS.filter(function (s) { return s.status === "active" || s.status === "past_due"; }).reduce(function (a, s) { return a + (s.country === "AE" ? 0 : (PLAN_BY[s.plan_code] || { price_monthly: 0 }).price_monthly); }, 0);

  var H = {
    hq_me: function () { return { email: ME_EMAIL, role: ROLE, role_label: S ? S.roleLabel(ROLE) : ROLE, perms: S ? S.ROLE_PERMS[ROLE] : ["*"], status: "active", has_2step: true, needs_2step: false, idle_minutes: 30 }; },
    hq_heartbeat: function () { return { ok: true }; },
    hq_my_session: function () { var st = new Date(now - 47 * 60000).toISOString(); return { sid: "3f9a1c2e", started_at: st, last_seen_at: new Date().toISOString(), idle_minutes: 30, max_hours: 12,
      expires_at: new Date(now + 30 * 60000).toISOString(), hard_end_at: new Date(Date.parse(st) + 12 * 3600000).toISOString() }; },
    hq_studio_credits: function (a) {
      var s = BY_ORG[a.p_org] || {}, n = (s.referral && s.referral.referred_count) || 0, list = [];
      for (var k = 0; k < n; k++) list.push({ id: uuid(9000 + k), kind: "referral", months: 1, reason: "Referred a studio that paid (demo " + (k + 1) + ")", granted_by: "admin@helm.events", granted_at: ago(20 + k * 15) });
      return { credits: list, months_total: n };
    },
    hq_log_reveal: function (a) { AUDIT.unshift({ at: new Date().toISOString(), actor_email: ME_EMAIL, action: "hq.reveal", entity: a.p_entity, entity_id: a.p_entity_id, changed: { field: a.p_field } }); return { ok: true }; },
    hq_overview: function () {
      return { studios: { total: STUDIOS.length, new_7d: 3, new_30d: 5, by_status: { trial: count("trial"), active: count("active"), past_due: count("past_due"), suspended: count("suspended"), cancelled: count("cancelled"), none: 0 } },
        users: { total: USERS.length + 41, active_7d: 38 }, billing: { mrr: [{ amount: mrr, currency: "INR" }, { amount: 119, currency: "USD" }], paid_this_month: inr(38160), past_due_count: count("past_due"), reminders_pending: 2, suspended_count: count("suspended") },
        mfa: { pct: 64, users_with_mfa: 52, users_total: 81 }, auth_logins_7d: 212 };
    },
    hq_metrics: function () {
      var weeks = [], months = [];
      for (var w = 11; w >= 0; w--) weeks.push({ week: day(-w * 7 - ((new Date().getUTCDay() + 6) % 7)), studios: [1, 0, 2, 1, 3, 1, 2, 4, 2, 3, 5, 3][11 - w] });
      for (var m = 5; m >= 0; m--) { var d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m); months.push({ month: d.toISOString().slice(0, 7), mrr: [21000, 26500, 31000, 36500, 41990, mrr][5 - m], collected: [19800, 25100, 33600, 35400, 44300, 38160][5 - m] }); }
      return { studios: { total: STUDIOS.length, active_30d: 12, paying: count("active"), past_due: count("past_due"), suspended: count("suspended"), trial: count("trial"), new_30d: 5, new_prev_30d: 3 },
        conversion: { pct: 42, converted: 5, trials_ended: 12 },
        attention: { new_plan_requests: 2, new_sales_enquiries: 3, new_suggestions: 1, trials_ending_count: 2,
          past_due: [{ org_id: STUDIOS[3].org_id, name: STUDIOS[3].name, period_end: day(-12) }],
          trials_ending: [{ org_id: STUDIOS[4].org_id, name: STUDIOS[4].name, ends_at: STUDIOS[4].trial_ends_at }, { org_id: STUDIOS[5].org_id, name: STUDIOS[5].name, ends_at: STUDIOS[5].trial_ends_at }],
          at_risk: [{ org_id: STUDIOS[7].org_id, name: STUDIOS[7].name, last_sign_in: ago(21) }] },
        health: { queues: [{ name: "notice", label: "Helm notices (e-mail)", waiting: 0, failed_7d: 0, sent_24h: 14 }, { name: "client", label: "Studio e-mails to clients", waiting: 2, failed_7d: 1, sent_24h: 63, oldest_waiting: ago(0.004) },
            { name: "wa", label: "WhatsApp messages", waiting: 0, failed_7d: 0, sent_24h: 0 }],
          cron: { readable: true, jobs: [{ name: "billing-refresh", last_run: ago(0.02), last_status: "succeeded", failed_24h: 0 }, { name: "trial-reminders", last_run: ago(0.3), last_status: "succeeded", failed_24h: 0 }, { name: "outbox-sweep", last_run: ago(0.001), last_status: "succeeded", failed_24h: 0 }] } },
        signups_weekly: weeks, mrr_monthly: months,
        plan_mix: [{ plan: "Studio", studios: 5 }, { plan: "Starter", studios: 3 }, { plan: "Enterprise", studios: 1 }],
        funnel: { signed_up: 18, on_trial: 4, added_team: 11, paid: 6 },
        top_usage: STUDIOS.filter(function (s) { return s.status !== "cancelled"; }).slice(0, 6).map(function (s, i) { return { org_id: s.org_id, name: s.name, status: s.status, plan: s.plan_name, active_30d: Math.max(1, s.users_count - i % 3), people: s.users_count, last_sign_in: s.last_activity }; }) };
    },
    hq_studios: function (a) {
      var rows = STUDIOS.filter(function (s) { return (!a.p_status || s.status === a.p_status) && match(a.p_search, [s.name, s.slug, s.owner_email, s.primary_contact_name]); })
        .map(function (s) { return Object.assign({}, s); });
      return page(rows, a);
    },
    hq_studio_detail: function (a) {
      var s = BY_ORG[a.p_org]; if (!s) return null; var p = PLAN_BY[s.plan_code] || null;
      return { org_id: s.org_id, name: s.name, slug: s.slug, created_at: s.created_at, users_count: s.users_count, owner_email: s.owner_email, total_paid: s.total_paid, status: s.status,
        billing_currency: s.billing_currency, paid_currency: s.paid_currency, last_active_at: s.last_activity, referral: s.referral,
        subscription: { status: s.status, plan_name: s.plan_name, plan_code: s.plan_code, price_monthly: p ? p.price_monthly : null, currency: "INR", current_period_end: s.current_period_end,
          trial_ends_at: s.trial_ends_at, suspended_at: s.status === "suspended" ? ago(3.5) : null, suspend_reason: s.status === "suspended" ? "Payment pending for 30 days - studio asked for time" : null },
        account: { primary_contact_name: s.primary_contact_name, primary_contact_email: s.primary_contact_email, primary_contact_phone: s.primary_contact_phone,
          billing_contact_email: "accounts@" + s.primary_contact_email.split("@")[1], city: s.city, state: s.state, country: s.country, legal_business_name: s.name + " LLP",
          gstin: s.country === "IN" ? "36ABCDE1234F1Z5" : null, pan: s.country === "IN" ? "ABCDE1234F" : null, website: "https://" + s.primary_contact_email.split("@")[1], timezone: s.country === "AE" ? "Asia/Dubai" : "Asia/Kolkata", team_size_band: "6-15", billing_currency: s.billing_currency, referral_code: s.referral.code, referred_by: s.referral.referred_by },
        members: USERS.filter(function (u) { return u.org_id === s.org_id; }).map(function (u) { return { display_name: u.display_name, email: u.email, role: u.role, active: true, last_sign_in_at: u.last_sign_in_at, mfa_enabled: u.mfa_enabled }; }),
        payments: PAYMENTS.filter(function (x) { return x.org_id === s.org_id; }) };
    },
    hq_studio_usage: function (a) {
      var s = BY_ORG[a.p_org] || {}, pays = PAYMENTS.filter(function (x) { return x.org_id === a.p_org; });
      return { active_days_30d: s.active_days_30d, sign_ins_30d: s.sign_ins_30d, people: s.users_count, people_active_7d: Math.max(1, (s.users_count || 1) - 2), people_active_30d: s.users_count, last_sign_in: s.last_activity, payments_to_helm: pays.length,
        last_payment_on: pays[0] ? pays[0].paid_on : null, hq_changes: AUDIT.filter(function (x) { return x.entity_id === a.p_org && x.action !== "hq.view"; }) };
    },
    hq_trial_info: function (a) {
      var s = BY_ORG[a.p_org] || {};
      return { status: s.status, trial_ends_at: s.trial_ends_at, timezone: s.country === "AE" ? "Asia/Dubai" : "Asia/Kolkata", locked: s.status === "suspended", trial_mode: s.status === "trial" ? "demo" : null,
        extension: null, can_extend: s.status === "trial", why_not: s.status === "trial" ? null : "Only a studio on its free trial can get an extension." };
    },
    hq_studio_link_check: function (a) { return { ok: !/^(helm|admin|hq)/.test(String(a.p_slug || "")), reason: "reserved" }; },
    hq_plans: function () { return PLANS.map(function (p) { return Object.assign({}, p); }); },
    hq_plan_checkout: function () {
      return PLANS.filter(function (p) { return p.active; }).map(function (p) { return { code: p.code, name: p.name, description: p.name + " plan for event studios", features: ["Quotes & invoices", "Floor-plan builder", "Team chat"].slice(0, p.code === "starter" ? 2 : 3),
        prices: [{ currency: "INR", monthly: p.price_monthly, yearly: p.price_monthly * 10, razorpay_plan_id_monthly: "plan_DEMO" + p.code.toUpperCase() + "M", razorpay_plan_id_yearly: null }, { currency: "USD", monthly: Math.round(p.price_monthly / 83), yearly: Math.round(p.price_monthly / 8.3) }] }; });
    },
    hq_tax_rules: function () { return [{ country: "IN", region: null, regime: "IN_GST_INTRA", rate: 18, effective_from: "2025-04-01", effective_to: null, active: true, invoice_note: "" },
      { country: "AE", region: null, regime: "NO_TAX", rate: 0, effective_from: "2025-04-01", effective_to: null, active: true, invoice_note: "Export of services under LUT - IGST not charged" }]; },
    hq_users: function (a) { return page(USERS.filter(function (u) { return match(a.p_search, [u.email, u.studio]); }).map(function (u) { return Object.assign({}, u); }), a); },
    hq_billing: function (a) {
      var f = a.p_from || day(-30), t = a.p_to || day(0), rows = PAYMENTS.filter(function (p) { return p.paid_on >= f && p.paid_on <= t; });
      var tot = {}; rows.forEach(function (p) { tot[p.currency] = (tot[p.currency] || 0) + p.amount; });
      return { from: f, to: t, collected: Object.keys(tot).map(function (c) { return { amount: tot[c], currency: c }; }), payments_count: rows.length, voided_count: 0,
        mrr: [{ amount: mrr, currency: "INR" }, { amount: 119, currency: "USD" }], payments: rows,
        past_due: [{ name: STUDIOS[3].name, plan_code: "studio", current_period_end: day(-12), days_overdue: 12 }],
        reminders: [{ studio: STUDIOS[3].name, kind: "past_due", period_end: day(-12), sent_at: ago(10), channel: "email" }, { studio: STUDIOS[4].name, kind: "trial_ending", period_end: day(2), sent_at: null }] };
    },
    hq_unrealised_exports: function () { return PAYMENTS.filter(function (p) { return p.currency === "USD"; }).slice(0, 1); },
    hq_mfa_readiness: function () { return { hq_require_mfa: true, operators: [{ email: "admin@helm.events", has_login: true, has_2step: true, is_me: ROLE === "owner" }, { email: "support@helm.events", has_login: false, has_2step: false },
      { email: "security@helm.events", has_login: true, has_2step: true, is_me: ROLE === "security" }, { email: "sales@helm.events", has_login: true, has_2step: true, is_me: ROLE === "sales" }], studio_admins: { total: 14, with_2step: 9 } }; },
    hq_sales_requests: function (a) {
      var rows = [{ id: uuid(6001), created_at: ago(0.1), studio: STUDIOS[4].name, org_id: STUDIOS[4].org_id, subscription_status: "trial", source: "plan_page", contact_name: STUDIOS[4].primary_contact_name,
          contact_email: STUDIOS[4].primary_contact_email, contact_phone: STUDIOS[4].primary_contact_phone, plan_name: "Studio", billing_interval: "yearly", message: "We loved the floor-plan builder. Can we pay yearly by bank transfer? Our accountant needs a GST invoice.", status: "new" },
        { id: uuid(6002), created_at: ago(1.2), studio: STUDIOS[10].name, org_id: STUDIOS[10].org_id, subscription_status: "trial", source: "read_only_banner", contact_name: STUDIOS[10].primary_contact_name,
          contact_email: STUDIOS[10].primary_contact_email, contact_phone: STUDIOS[10].primary_contact_phone, plan_name: "Starter", billing_interval: "monthly", message: "Trial ended in the middle of a wedding season - please help us continue.", status: "new" },
        { id: uuid(6003), created_at: ago(9), studio: STUDIOS[12].name, org_id: STUDIOS[12].org_id, subscription_status: "active", source: "plan_page", contact_name: STUDIOS[12].primary_contact_name,
          contact_email: STUDIOS[12].primary_contact_email, contact_phone: null, plan_name: "Studio", billing_interval: "monthly", message: "Upgrade from Starter.", status: "won", hq_note: "Paid by UPI, activated", handled_at: ago(8) }];
      return { counts: { new: 2, contacted: 0, won: 1, lost: 0 }, rows: rows.filter(function (r) { return !a.p_status || r.status === a.p_status; }) };
    },
    hq_sales_enquiries: function (a) {
      var rows = [{ id: uuid(7001), created_at: ago(0.05), company: "Navratri Nights", city: "Vadodara", source: "contact", name: "Jignesh Patel", email: "jignesh@navratrinights.in", phone: "+91 98980 45612", plan: "studio", team_size: "6-15", events_per_year: "40", message: "We run 40 garba events a year. Do you support seating plans for 2,000 guests?", status: "new" },
        { id: uuid(7002), created_at: ago(0.8), company: "Coastal Vows", city: "Mangaluru", source: "home", name: "Divya Shetty", email: "divya@coastalvows.com", phone: "+91 99018 22334", plan: "not_sure", team_size: "2-5", events_per_year: "12", message: "Is there a discount for a small team?", status: "new" },
        { id: uuid(7003), created_at: ago(2), company: "Emirates Galas", city: "Abu Dhabi", source: "contact", name: "Omar Haddad", email: "omar@emiratesgalas.ae", phone: "+971 55 987 6543", plan: "enterprise", team_size: "16-50", events_per_year: "120", message: "Need USD invoices and an SLA.", status: "new" }];
      return { counts: { new: 3, contacted: 1, won: 0, lost: 1 }, settings: { notify_email: "notifications@helm.events", auto_reply: true, form_open: true }, rows: rows.filter(function (r) { return !a.p_status || r.status === a.p_status; }) };
    },
    hq_suggestions: function (a) {
      var rows = [{ id: uuid(8001), created_at: ago(0.4), who: "Priya (Shaadi Squad Events)", studio: STUDIOS[0].name, email: "priya@shaadisquad.in", source: "app", page: "builder", category: "idea", message: "Let us copy a floor plan from one event to another.", status: "new" }];
      return { counts: { new: 1, reviewed: 3, done: 7 }, rows: rows.filter(function (r) { return !a.p_status || r.status === a.p_status; }) };
    },
    hq_billing_settings: function () { return { legal_name: "Helm Events Technologies Pvt Ltd", gstin: "36AAACH1234M1Z2", address: "Hitech City, Hyderabad 500081", seller_state: "Telangana", seller_country: "IN",
      lut_number: "AD360326000123X", lut_valid_from: "2026-04-01", lut_valid_to: "2027-03-31", gst_rate: 18, invoice_prefix: "HELM-", online_payments_live: false, allow_trial_bypass: false, terms_version: "2026-10" }; },
    hq_invoice: function (a) {
      var p = PAYMENTS.filter(function (x) { return x.id === a.p_payment_id; })[0] || PAYMENTS[0], s = BY_ORG[p.org_id] || {};
      return { invoice_no: p.invoice_no, paid_on: p.paid_on, amount: p.amount, net_amount: p.net_amount, gst_amount: p.gst_amount, gst_rate: p.currency === "INR" ? 18 : 0, currency: p.currency, method: p.method, reference: p.reference,
        period_start: p.period_start, period_end: p.period_end, plan_name: s.plan_name, seller: { legal_name: "Helm Events Technologies Pvt Ltd (DEMO)", gstin: "36AAACH1234M1Z2", address: "Hyderabad", state: "Telangana", country: "IN" },
        buyer: { legal_name: s.name, state: s.state, country: s.country } };
    },
    hq_audit: function () { return { rows: AUDIT.slice() }; },
    hq_security_alerts: function () {
      return { total: 9, by_studio: [{ label: "Sign-in locked after failed passwords", type: "lockout", studio: STUDIOS[1].name, count: 3, latest: ago(0.6) },
          { label: "Upload rejected (not an image)", type: "upload", studio: STUDIOS[0].name, count: 2, latest: ago(1.5) },
          { label: "Member removed", type: "member_removed", studio: STUDIOS[2].name, count: 1, latest: ago(2.1) },
          { label: "Studio suspended by Helm", type: "suspend", studio: STUDIOS[8].name, count: 1, latest: ago(3.5) }],
        latest: [{ at: ago(0.6), label: "Sign-in locked after failed passwords", studio: STUDIOS[1].name, subject_name: "Aman" },
          { at: ago(1.5), label: "Upload rejected (not an image)", studio: STUDIOS[0].name, actor_name: "Riya" },
          { at: ago(3.5), label: "Studio suspended by Helm", studio: STUDIOS[8].name, actor_name: "Helm HQ" }] };
    },
    hq_staff_list: function () {
      var mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36", iph = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1";
      return { staff: [
          { email: "admin@helm.events", name: "Helm Admin", role: "owner", role_label: "Owner", status: "active", is_me: ROLE === "owner", has_login: true, last_sign_in_at: ago(0.02), has_2step: true, last_active_at: ago(0.001), views_7d: 64,
            sessions: [{ sid: "3f9a1c2e", device: mac, ip: "49.36.x.x", since: ago(0.03), seen: ago(0.001), hq_last: ago(0.001), current: ROLE === "owner" }, { sid: "b71e04d9", device: iph, ip: "106.51.x.x", since: ago(1), seen: ago(0.5), hq_last: ago(0.5) }], recent: [{ at: ago(0.01), action: "hq.payment.record" }, { at: ago(1.1), action: "hq.trial.extend" }] },
          { email: "support@helm.events", name: "Support", role: "owner", role_label: "Owner", status: "invited", has_login: false, has_2step: false, views_7d: 0, sessions: [], recent: [], invited_at: ago(2), invited_by: "admin@helm.events" },
          { email: "security@helm.events", name: "Security team", role: "security", role_label: "Security", status: "active", is_me: ROLE === "security", has_login: true, last_sign_in_at: ago(0.3), has_2step: true, last_active_at: ago(0.2), views_7d: 18,
            sessions: [{ sid: "5c0d77a1", device: mac, ip: "103.21.x.x", since: ago(0.3), seen: ago(0.2), hq_last: ago(0.2) }], recent: [{ at: ago(0.2), action: "hq.reveal" }, { at: ago(2.2), action: "hq.mfa.reset" }] },
          { email: "sales@helm.events", name: "Sales team", role: "sales", role_label: "Sales", status: "active", is_me: ROLE === "sales", has_login: true, last_sign_in_at: ago(0.4), has_2step: true, last_active_at: ago(0.3), views_7d: 27, sessions: [], recent: [{ at: ago(0.3), action: "hq.sales_enquiry.update" }] }],
        settings: { idle_minutes: 30, max_hours: 12, reauth_minutes: 15, ip_allowlist_on: false, ip_allowlist: [], my_ip: "49.36.x.x" },
        events: [{ kind: "invited", email: "support@helm.events", role: "owner", by: "admin@helm.events", at: ago(2) }, { kind: "invited", email: "sales@helm.events", role: "sales", by: "admin@helm.events", at: ago(6) }, { kind: "activated", email: "sales@helm.events", at: ago(5) }, { kind: "settings", by: "admin@helm.events", at: ago(4) }] };
    },
    hq_staff_access: function () {
      return { domains: [{ domain: "helm.events", include_subdomains: true, builtin: true }, { domain: "helm-events.com", include_subdomains: true, builtin: false, note: "look-alike", added_at: ago(20) }],
        allowlist: [{ email: "admin@helm.events", is_platform_admin: true, has_login: true }, { email: "sales@helm.events", is_platform_admin: true, has_login: true }, { email: "support@helm.events", is_platform_admin: true, has_login: false, note: "Support (Owner, invited)" }],
        accounts: [{ email: "admin@helm.events", studio: null, created_at: ago(300), last_sign_in_at: ago(0.02), allowlisted: true, is_platform_admin: true }, { email: "test@helm.events", studio: "Demo Studio", role: "admin", created_at: ago(200), last_sign_in_at: ago(90), allowlisted: false }] };
    },
    hq_operators: function () { return []; }
  };
  function refuse() { return Promise.reject(new Error("Demo mode - nothing is saved. On the real HQ this change would be made now.")); }
  function hq(fn, args) {
    if (!/^hq_[a-z_]+$/.test(String(fn))) return Promise.reject(new Error("bad call"));
    var h = H[fn];
    if (!h) return refuse();
    try { return Promise.resolve(JSON.parse(JSON.stringify(list(h(args || {}))))); } catch (e) { return Promise.reject(e); }
  }
  var user = { id: uuid(1), email: ME_EMAIL };
  window.BPStore = {
    __helmHqDemo: true,   // r42: hq.js runs the demo only when this fake store is the one in place
    init: function () { return Promise.resolve(); },
    hq: hq,
    auth: {
      enabled: function () { return true; }, required: function () {}, pendingUser: function () { return user; }, pendingStep: function () { return null; },
      user: function () { return user; }, signOut: function () { return Promise.resolve(); },
      mfa: { operatorStep: function () { return Promise.resolve("ok"); }, challenge: function () { return Promise.resolve(true); } }
    }
  };
  window.HelmHqDemo = { role: ROLE };
})();
