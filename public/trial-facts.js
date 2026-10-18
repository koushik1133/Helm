/* =========================================================================
   HELM — free-trial facts: the ONE source of the trial terms (0207)
   -------------------------------------------------------------------------
   Every number and rule shown to a person about the free trial comes from here, so the
   sign-up box (trial-signup.js), the first welcome step "Your 8-day free trial" and the
   one-time terms modal (trial-demo.js) can never drift apart.
   Sources: docs/trial/TRIAL-END-TO-END.md, docs/trial/POST-TRIAL-POLICY.md, migrations
   0166-0205 (sample counts verified on a real trial clone of the sample manifest: 0202).
   VERSION must equal public._trial_terms_version() (0207): accept_trial_terms() refuses
   any other version, so a stale cached page cannot record agreement to old terms.
   0212 (owner decision): e-mail to clients WORKS in the trial (capped: EMAIL_PER_DAY a day per studio,
   EMAIL_PER_RECIPIENT a day to one address); WhatsApp, SMS and online payment links unlock on a paid plan.
   New wording -> new VERSION (= _trial_terms_version() in 0212): trial owners are asked once more.
   CSP: DOM built with createElement / textContent only; styles in trial-terms.css.
   ========================================================================= */
(function (global) {
  "use strict";
  var VERSION = "trial-2026-10-19";
  var DAYS = 8, KEEP_DAYS = 60, TEAM_EXTRA = 2, CREATE_CAP = 2, EXTENSION_DAYS = 7;
  var DELETE_WARN_DAYS = [30, 7, 1];
  var EMAIL_PER_DAY = 30, EMAIL_PER_RECIPIENT = 5;   // 0212 trial client e-mail caps (trial_email_settings)
  var REGION = { currency: "INR", symbol: "₹", timezone: "Asia/Kolkata", tz: "IST" };

  // the sample studio every trial starts with (counts of one trial clone of the current manifest)
  var SAMPLE = [
    { k: "leads", n: 16, one: "lead (client)", many: "leads (clients)" },
    { k: "events", n: 7, one: "event with its quote", many: "events with quotes", s: "in every stage, some confirmed with a simulated advance" },
    { k: "requirements", n: 41, one: "client requirement", many: "client requirements", s: "Must-have / Nice-to-have, across the sample events" },
    { k: "inventory", n: 165, one: "inventory item", many: "inventory items", s: "a full rental price list" },
    { k: "vendors", n: 16, one: "vendor", many: "vendors" },
    { k: "staff", n: 12, one: "staff member", many: "staff" },
    { k: "venues", n: 4, one: "venue", many: "venues" },
    { k: "menus", n: 6, one: "menu package", many: "menu packages", s: "Standard, Gold and Premium, each Veg and Non-veg" },
    { k: "dishes", n: 145, one: "dish", many: "dishes" },
    { k: "layouts", n: 3, one: "layout template", many: "layout templates", s: "ready-made floor plans for the 2D/3D builder" },
    { k: "coupons", n: 3, one: "coupon", many: "coupons" }
  ];
  // the lists the server caps at CREATE_CAP new rows each (0173 / 0181: leads, quotes, inventory_items,
  // vendors, crew_members, venues); a lead IS the client record
  var CAP_LISTS = ["leads / clients", "events & quotes", "inventory items", "vendors", "staff", "venues"];

  function count(k) { for (var i = 0; i < SAMPLE.length; i++) if (SAMPLE[i].k === k) return SAMPLE[i].n; return 0; }
  function label(x) { return x.n + " " + (x.n === 1 ? x.one : x.many); }
  function joinList(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  var SAMPLE_SHORT = joinList(SAMPLE.filter(function (x) { return x.k !== "requirements" && x.k !== "coupons" && x.k !== "dishes"; }).map(label));

  // ---- the full terms (welcome step 1 + one-time modal) ------------------------------------------
  var SECTIONS = [
    { id: "included", icon: "gift", title: "What’s included",
      lead: "Free for " + DAYS + " days, no card needed. Your studio is set up for India (prices in " + REGION.symbol + " " + REGION.currency + ", times in " + REGION.tz + ") and starts with this sample data:",
      tiles: SAMPLE,
      foot: "All of it is sample data, marked “Demo ·” and tagged “Sample”. Sample contacts are not real people." },
    { id: "can", icon: "check", title: "What you can do",
      items: [
        { t: "Add up to " + CREATE_CAP + " new records in each list", s: "Leads (clients), events & quotes, inventory items, vendors, staff and venues. " + CREATE_CAP + " in total per list for the studio: sample records do not count, and deleting a record does not free a slot." },
        { t: "Edit the sample data", s: "Open, change and re-price any sample record to try your own way of working." },
        { t: "Change menu prices", s: "Price per plate, chair and plate prices. Dishes and menu packages cannot be added, renamed or removed in the trial." },
        { t: "Invite up to " + TEAM_EXTRA + " teammates", s: "You + " + TEAM_EXTRA + " people. Open invitations count toward the " + TEAM_EXTRA + "." },
        { t: "E-mail your clients", s: "Approval (quote) links, booklet and invitation links and the approval code by e-mail really reach your client: up to " + EMAIL_PER_DAY + " e-mails a day, " + EMAIL_PER_RECIPIENT + " a day to one address. Sample (demo) events are never e-mailed." },
        { t: "Plan layouts in 2D and 3D", s: "Start from the " + count("layouts") + " layout templates, a blank floor or a past event." },
        { t: "Set pricing, coupons and rules", s: "Pricing & coupons, layout rules, and roles & access are all editable." }
      ] },
    { id: "locked", icon: "lock", title: "Locked in the trial",
      items: [
        { t: "Studio setup and branding", s: "Helm sets up your studio from the welcome step; logo, studio account and client link name unlock on a plan." },
        { t: "Imports", s: "Excel / CSV import, custom fields and builder layout import." },
        { t: "Data export and every download or print", s: "PDF, CSV, studio archive, run sheet print and builder image / file downloads." },
        { t: "Photo renders", s: null },
        { t: "Notification settings and client link auto-expire", s: null },
        { t: "Your own templates and the activity log", s: "Saving layout or checklist templates, the Templates page and the audit (activity) log." },
        { t: "WhatsApp, SMS and online payment links", s: "They unlock on a paid plan. Approval codes go by e-mail only, and your client can also confirm with Test mode - confirm. Payments are recorded by hand." }
      ] },
    { id: "after", icon: "clock", title: "After the trial",
      items: [
        { t: "Read-only after " + DAYS + " days", s: "For everyone, including invited teammates: you can sign in and look, but nobody can add, change or delete anything until you choose a plan." },
        { t: "Data kept " + KEEP_DAYS + " days, then permanently deleted", s: "We e-mail you " + joinList(DELETE_WARN_DAYS.map(String)) + " day before the deletion date." },
        { t: "Reminders before it ends", s: "3 days before, 1 day before, on the last day, and 7 days after the trial ends." },
        { t: "Choose a plan anytime", s: "When you upgrade you choose: keep the sample data, remove the sample data and keep your own records, or start completely clean." },
        { t: "One free trial per person", s: "One free trial per person and e-mail address. Helm may approve one extension of up to " + EXTENSION_DAYS + " days." }
      ] }
  ];
  var AGREE_LABEL = "I have read and agree to the free-trial terms, the Terms of Service and the Privacy Policy";
  var LINKS = [{ href: "/terms#trial", text: "Terms of Service (free trial)" }, { href: "/privacy", text: "Privacy Policy" }];

  // ---- the short read-only notice for an invited teammate (no agreement needed) -------------------
  var NOTICE = [
    "This studio is on Helm’s " + DAYS + "-day free trial. It runs on sample data marked “Demo ·” / “Sample”.",
    "E-mail works: approval, booklet and invitation links (and the approval code) e-mailed from this studio really reach clients (up to " + EMAIL_PER_DAY + " a day). WhatsApp, SMS and payment links unlock on a paid plan.",
    "Downloads, prints, imports and photo renders unlock when the studio chooses a plan.",
    "The studio can add up to " + CREATE_CAP + " new records in each list (shared by the whole team).",
    "When the trial ends the studio becomes read-only for everyone until it chooses a plan."
  ];

  // ---- the sign-up box (trial-signup.js): KEY = 4 lines always visible, ALL = "See all trial rules" ----
  var SIGNUP_KEY = [
    { t: DAYS + " days free, no card", s: "An India studio: prices in " + REGION.symbol + ", times in " + REGION.tz + "." },
    { t: "Ready-made sample data", s: SAMPLE_SHORT + ", all marked “Demo”." },
    { t: "You + up to " + TEAM_EXTRA + " teammates", s: "E-mail to your clients works (up to " + EMAIL_PER_DAY + " a day); WhatsApp and SMS unlock on a plan." },
    { t: "After " + DAYS + " days: read-only", s: "Your data is kept " + KEEP_DAYS + " days, then deleted (we remind you first). Choose a plan anytime to keep everything." }
  ];
  var SIGNUP_ALL = [
    DAYS + " days free. No card needed to start.",
    "Your trial studio is set up for India: prices in " + REGION.symbol + " (" + REGION.currency + "), times in " + REGION.tz + " (" + REGION.timezone + ").",
    "It starts with ready-made sample data: " + joinList(SAMPLE.map(label)) + ". Every sample record is marked “Demo”.",
    "You plus up to " + TEAM_EXTRA + " teammates can use the trial studio (open invitations count).",
    "You can add up to " + CREATE_CAP + " new records of each kind (" + joinList(CAP_LISTS) + "). Sample records do not count, and deleting a record does not free a slot.",
    "Menu prices are editable. New dishes, menu packages, chair or plate types cannot be added during the trial.",
    "E-mail to your clients works during the trial: approval (quote) links, booklet and invitation links and approval codes by e-mail are really sent, up to " + EMAIL_PER_DAY + " e-mails a day per studio and " + EMAIL_PER_RECIPIENT + " a day to one address. Sample (demo) events are never e-mailed.",
    "WhatsApp messages, SMS approval codes and online payment links are not sent during the trial; they unlock on a paid plan.",
    "Downloads (PDF, CSV, prints), imports and photo renders unlock on a paid plan.",
    "After " + DAYS + " days the studio becomes read-only: you and your teammates can still look, but nobody can add or change anything until you choose a plan.",
    "Your trial data is kept for " + KEEP_DAYS + " days after the trial ends, then permanently deleted. We e-mail you reminders before that (" + joinList(DELETE_WARN_DAYS.map(String)) + " day before).",
    "One free trial per e-mail address. Helm may approve one extension of up to " + EXTENSION_DAYS + " days.",
    "Choose a plan anytime to keep everything and carry on where you left off."
  ];

  var api = { VERSION: VERSION, DAYS: DAYS, KEEP_DAYS: KEEP_DAYS, TEAM_EXTRA: TEAM_EXTRA, CREATE_CAP: CREATE_CAP,
    EXTENSION_DAYS: EXTENSION_DAYS, DELETE_WARN_DAYS: DELETE_WARN_DAYS, EMAIL_PER_DAY: EMAIL_PER_DAY, EMAIL_PER_RECIPIENT: EMAIL_PER_RECIPIENT, REGION: REGION, SAMPLE: SAMPLE, CAP_LISTS: CAP_LISTS,
    SECTIONS: SECTIONS, AGREE_LABEL: AGREE_LABEL, LINKS: LINKS, NOTICE: NOTICE, SIGNUP_KEY: SIGNUP_KEY, SIGNUP_ALL: SIGNUP_ALL,
    count: count, joinList: joinList };

  /* ---- DOM (browser only) ------------------------------------------------------------------------ */
  var SVGNS = "http://www.w3.org/2000/svg";
  var ICONS = {
    gift: ["M3 8h18v4H3z", "M5 12v8h14v-8", "M12 8v12", "M12 8c-1.6-3-5-3.4-5-1.2C7 8 9.5 8 12 8z", "M12 8c1.6-3 5-3.4 5-1.2C17 8 14.5 8 12 8z"],
    check: ["M4 12.5l5 5L20 6.5"],
    lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
    clock: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 7.5V12l3 2"],
    tick: ["M3.5 8.5l3 3 6-7"],
    dot: ["M8 5.25a2.75 2.75 0 1 0 0 5.5a2.75 2.75 0 1 0 0-5.5z"],
    info: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 11v5", "M12 7.6v.1"]
  };
  function icon(doc, name, vb) {
    var s = doc.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", vb || (name === "tick" || name === "dot" ? "0 0 16 16" : "0 0 24 24"));
    s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    (ICONS[name] || []).forEach(function (d) { var p = doc.createElementNS(SVGNS, "path"); p.setAttribute("d", d); s.appendChild(p); });
    return s;
  }
  function el(doc, tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function link(doc, l) { var a = el(doc, "a", null, l.text); a.href = l.href; a.target = "_blank"; a.rel = "noopener"; return a; }

  // The full terms: 4 sections (included / can / locked / after) + links. idp: unique id prefix.
  function panel(doc, idp) {
    idp = idp || "tw";
    var root = el(doc, "div", "tw-terms");
    SECTIONS.forEach(function (sec) {
      var box = el(doc, "section", "tw-sec tw-" + sec.id); box.setAttribute("aria-labelledby", idp + "-" + sec.id);
      var h = el(doc, "h4", "tw-sh"); h.id = idp + "-" + sec.id;
      var ic = el(doc, "span", "tw-sic"); ic.appendChild(icon(doc, sec.icon)); h.appendChild(ic);
      h.appendChild(doc.createTextNode(sec.title)); box.appendChild(h);
      if (sec.lead) box.appendChild(el(doc, "p", "tw-lead", sec.lead));
      if (sec.tiles) {
        var ul = el(doc, "ul", "tw-tiles");
        sec.tiles.forEach(function (x) {
          var li = el(doc, "li", "tw-tile");
          li.appendChild(el(doc, "b", null, String(x.n)));
          li.appendChild(el(doc, "span", null, x.n === 1 ? x.one : x.many));
          if (x.s) li.title = x.s;
          ul.appendChild(li);
        });
        box.appendChild(ul);
      }
      if (sec.items) {
        var list = el(doc, "ul", "tw-list");
        sec.items.forEach(function (it) {
          var li = el(doc, "li"); var m = el(doc, "span", "tw-mk"); m.appendChild(icon(doc, sec.id === "locked" ? "lock" : sec.id === "after" ? "dot" : "tick", sec.id === "locked" ? "0 0 24 24" : "0 0 16 16"));
          li.appendChild(m);
          var tx = el(doc, "span"); tx.appendChild(el(doc, "b", null, it.t)); if (it.s) tx.appendChild(el(doc, "span", null, it.s));
          li.appendChild(tx); list.appendChild(li);
        });
        box.appendChild(list);
      }
      if (sec.foot) box.appendChild(el(doc, "p", "tw-foot", sec.foot));
      root.appendChild(box);
    });
    var lk = el(doc, "p", "tw-links"); lk.appendChild(doc.createTextNode("Read the full "));
    lk.appendChild(link(doc, LINKS[0])); lk.appendChild(doc.createTextNode(" and our "));
    lk.appendChild(link(doc, LINKS[1])); lk.appendChild(doc.createTextNode(" (open in a new tab)."));
    root.appendChild(lk);
    return root;
  }
  // The required "I agree" tick. onChange(checked). Returns { box, input }.
  function agreeBox(doc, id, onChange) {
    var box = el(doc, "div", "tw-agree");
    var i = el(doc, "input"); i.type = "checkbox"; i.id = id; i.required = true;
    var l = el(doc, "label", null, AGREE_LABEL + "."); l.htmlFor = id;
    box.appendChild(i); box.appendChild(l);
    i.addEventListener("change", function () { box.classList.toggle("on", i.checked); if (onChange) onChange(i.checked); });
    return { box: box, input: i };
  }
  // The short teammate notice (read-only, no agreement)
  function notice(doc) {
    var root = el(doc, "div", "tw-notice");
    var ul = el(doc, "ul", "tw-list");
    NOTICE.forEach(function (t) { var li = el(doc, "li"); var m = el(doc, "span", "tw-mk"); m.appendChild(icon(doc, "tick")); li.appendChild(m); li.appendChild(el(doc, "span", null, t)); ul.appendChild(li); });
    root.appendChild(ul);
    var lk = el(doc, "p", "tw-links"); lk.appendChild(doc.createTextNode("Full rules: ")); lk.appendChild(link(doc, LINKS[0]));
    lk.appendChild(doc.createTextNode(" · ")); lk.appendChild(link(doc, LINKS[1])); root.appendChild(lk);
    return root;
  }
  api.panel = panel; api.agreeBox = agreeBox; api.notice = notice; api.icon = icon;

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global) global.HelmTrialFacts = api;
})(typeof window !== "undefined" ? window : globalThis);
