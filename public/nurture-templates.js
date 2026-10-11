/* =========================================================================
   HelmNurtureTemplates — ready-to-use, editable nurture / follow-up messages.

   Every occasion has a SHORT variant (WhatsApp-sized) and a LONG variant (email:
   subject + body). Placeholders use double braces:
     {{client_name}} {{studio_name}} {{event_date}} {{planner_name}} {{phone}}
     {{years}} {{occasion}} {{last_event}}
   (The older names {{name}} / {{studio}} still work.) Single braces ({client_name})
   are accepted too when a studio types them by hand.

   Occasions with `auto` are the ones the automatic greeting job can send (the
   server fills only name / studio / years / occasion / last_event), so their
   texts never use event_date / planner_name / phone. 0105 seeds those into
   nurture_templates fill-only (a studio's own edits are never overwritten).

   Country-aware: `countries` limits an occasion to the studios it fits (IN / AE /
   US); no prices or currency symbols anywhere; neutral tone, no promises.
   Pure functions, no DOM. Browser: window.HelmNurtureTemplates; Node: require().
   ========================================================================= */
(function (root) {
  "use strict";

  var L = [
    // ---- personal dates ----------------------------------------------------
    { key: "birthday", label: "Birthday", emoji: "🎂", group: "Personal dates", auto: "birthday", needsDate: "birthday",
      short: "Happy birthday, {{client_name}}! Warm wishes from all of us at {{studio_name}} - have a wonderful year ahead.",
      subject: "Happy birthday, {{client_name}}!",
      body: "Hi {{client_name}},\n\nHappy birthday from everyone at {{studio_name}}! We still smile when we think of {{last_event}}, and we hope this year brings you plenty to celebrate.\n\nHave a lovely day.\n\nWarm wishes,\n{{studio_name}}" },
    { key: "anniversary", label: "Wedding anniversary", emoji: "💐", group: "Personal dates", auto: "anniversary", needsDate: "anniversary",
      short: "Happy anniversary, {{client_name}}! {{years}} years already - wishing you both many more happy ones. Love from {{studio_name}}.",
      subject: "Happy anniversary, {{client_name}}!",
      body: "Hi {{client_name}},\n\nHappy {{years}}-year anniversary! It was a privilege to be part of {{last_event}}, and we hope the years since have been full of joy.\n\nIf you ever plan a celebration, we would be glad to help.\n\nWith love,\n{{studio_name}}" },

    // ---- corporate ----------------------------------------------------------
    { key: "corporate_annual_day", label: "Corporate annual day - invite to plan", emoji: "🏢", group: "Corporate", auto: "corporate_annual_day",
      short: "Hi {{client_name}}, your annual day is coming up again. Would you like us to start planning this year's edition? Happy to share ideas whenever suits you. - {{studio_name}}",
      subject: "Planning this year's annual day, {{client_name}}?",
      body: "Hi {{client_name}},\n\nYour annual day is around the corner again. We enjoyed working on {{last_event}}, and we would be happy to help plan this year's edition - fresh themes, a smooth run of show and less work for your team.\n\nShall we set up a short call to discuss dates and ideas?\n\nBest regards,\n{{studio_name}}" },
    { key: "annual_day_wishes", label: "Corporate annual day - wishes", emoji: "🎉", group: "Corporate", auto: "annual_day_wishes",
      short: "Warm wishes to the whole {{client_name}} team on your annual day! - {{studio_name}}",
      subject: "Happy annual day, {{client_name}}!",
      body: "Hi {{client_name}} team,\n\nWarm wishes on your annual day! Here's to another year of growth and good work together.\n\nBest regards,\n{{studio_name}}" },
    { key: "client_anniversary", label: "Client relationship anniversary - thank you", emoji: "🤝", group: "Corporate", auto: "client_anniversary",
      short: "Hi {{client_name}}, it's {{years}} years since we started working together - thank you for your trust! - {{studio_name}}",
      subject: "{{years}} years together - thank you, {{client_name}}",
      body: "Hi {{client_name}},\n\nToday marks {{years}} years since we first worked together. Thank you for trusting us with your events - it has been a pleasure every time.\n\nWe look forward to many more.\n\nWarm regards,\n{{studio_name}}" },

    // ---- festivals / seasons (country-aware) ---------------------------------
    { key: "new_year", label: "New Year", emoji: "🎆", group: "Festivals & seasons", auto: "new_year",
      short: "Happy New Year, {{client_name}}! Wishing you a joyful and successful year ahead. - {{studio_name}}",
      subject: "Happy New Year, {{client_name}}!",
      body: "Hi {{client_name}},\n\nHappy New Year from all of us at {{studio_name}}! Thank you for being part of our year. We wish you health, happiness and many good reasons to celebrate.\n\nWarm wishes,\n{{studio_name}}" },
    { key: "diwali", label: "Diwali", emoji: "🪔", group: "Festivals & seasons", auto: "diwali", countries: ["IN", "AE", "US"],
      short: "Happy Diwali, {{client_name}}! May the festival of lights bring joy and prosperity to you and your family. - {{studio_name}}",
      subject: "Happy Diwali, {{client_name}}!",
      body: "Hi {{client_name}},\n\nWishing you and your family a very happy Diwali! May the festival of lights fill your home with joy, warmth and prosperity.\n\nWarm wishes,\n{{studio_name}}" },
    { key: "holi", label: "Holi", emoji: "🎨", group: "Festivals & seasons", auto: "holi", countries: ["IN"],
      short: "Happy Holi, {{client_name}}! Wishing you a colourful, joyful celebration. - {{studio_name}}",
      subject: "Happy Holi, {{client_name}}!",
      body: "Hi {{client_name}},\n\nHappy Holi! May this festival of colours bring you and your loved ones plenty of joy.\n\nWarm wishes,\n{{studio_name}}" },
    { key: "raksha_bandhan", label: "Raksha Bandhan", emoji: "🧵", group: "Festivals & seasons", auto: "raksha_bandhan", countries: ["IN"], optional: true,
      short: "Happy Raksha Bandhan, {{client_name}}! Warm wishes to you and your family. - {{studio_name}}",
      subject: "Happy Raksha Bandhan, {{client_name}}!",
      body: "Hi {{client_name}},\n\nWarm wishes on Raksha Bandhan to you and your family. May the bond you share keep growing stronger.\n\nWarm wishes,\n{{studio_name}}" },
    { key: "dussehra", label: "Dussehra", emoji: "🏹", group: "Festivals & seasons", auto: "dussehra", countries: ["IN"], optional: true,
      short: "Happy Dussehra, {{client_name}}! Wishing you success and happiness. - {{studio_name}}",
      subject: "Happy Dussehra, {{client_name}}!",
      body: "Hi {{client_name}},\n\nHappy Dussehra! May this festival bring you success and happiness in everything you do.\n\nWarm wishes,\n{{studio_name}}" },
    { key: "ramadan", label: "Ramadan Kareem", emoji: "🌙", group: "Festivals & seasons", auto: "ramadan", countries: ["AE", "IN", "US"],
      short: "Ramadan Kareem, {{client_name}}! Wishing you and your family a peaceful and blessed month. - {{studio_name}}",
      subject: "Ramadan Kareem, {{client_name}}",
      body: "Hi {{client_name}},\n\nRamadan Kareem! Wishing you and your family a peaceful, blessed month.\n\nWarm regards,\n{{studio_name}}" },
    { key: "eid", label: "Eid al-Fitr", emoji: "🌙", group: "Festivals & seasons", auto: "eid", countries: ["AE", "IN", "US"],
      short: "Eid Mubarak, {{client_name}}! Wishing you and your loved ones joy and peace. - {{studio_name}}",
      subject: "Eid Mubarak, {{client_name}}!",
      body: "Hi {{client_name}},\n\nEid Mubarak! May this special day bring you and your family happiness, peace and togetherness.\n\nWarm wishes,\n{{studio_name}}" },
    { key: "christmas", label: "Christmas", emoji: "🎄", group: "Festivals & seasons", auto: "christmas",
      short: "Merry Christmas, {{client_name}}! Wishing you a warm and happy holiday season. - {{studio_name}}",
      subject: "Merry Christmas, {{client_name}}!",
      body: "Hi {{client_name}},\n\nMerry Christmas from all of us at {{studio_name}}! Wishing you a warm, happy holiday season with the people you love.\n\nWarm wishes,\n{{studio_name}}" },
    { key: "uae_national_day", label: "UAE National Day", emoji: "🇦🇪", group: "Festivals & seasons", auto: "uae_national_day", countries: ["AE"],
      short: "Happy UAE National Day, {{client_name}}! Warm wishes from {{studio_name}}.",
      subject: "Happy UAE National Day, {{client_name}}!",
      body: "Hi {{client_name}},\n\nHappy UAE National Day! Warm wishes to you and your family as the nation celebrates.\n\nBest regards,\n{{studio_name}}" },
    { key: "wedding_season", label: "Wedding season - planning nudge", emoji: "💍", group: "Festivals & seasons",
      short: "Hi {{client_name}}, wedding season is coming up. If you or someone close is planning a celebration, {{planner_name}} would be happy to talk dates - {{phone}}. - {{studio_name}}",
      subject: "Wedding season is coming up",
      body: "Hi {{client_name}},\n\nWedding season is nearly here and good dates tend to fill early. If you, your family or friends are planning a celebration, we would be glad to help with ideas, venues and a clear plan.\n\nReply here or call {{planner_name}} on {{phone}} whenever it suits you.\n\nWarm regards,\n{{studio_name}}" },

    // ---- follow-ups (manual: copy / WhatsApp) -------------------------------
    { key: "post_event_thanks", label: "Post-event thank you", emoji: "🙏", group: "Follow-ups",
      short: "Hi {{client_name}}, thank you for letting us be part of your event on {{event_date}}. It was a pleasure! - {{planner_name}}, {{studio_name}}",
      subject: "Thank you, {{client_name}}",
      body: "Hi {{client_name}},\n\nThank you for trusting {{studio_name}} with your event on {{event_date}}. It was a pleasure working with you, and we hope you and your guests enjoyed every moment.\n\nWe will share the photos as soon as they are ready.\n\nWarm regards,\n{{planner_name}}\n{{studio_name}}" },
    { key: "feedback_request", label: "Feedback / review request", emoji: "⭐", group: "Follow-ups",
      short: "Hi {{client_name}}, how did we do on {{event_date}}? A line of feedback (or a short review) would mean a lot to us. Thank you! - {{studio_name}}",
      subject: "How did we do, {{client_name}}?",
      body: "Hi {{client_name}},\n\nWe hope your event on {{event_date}} went the way you imagined. We would really value your feedback - what worked, and what we could do better.\n\nIf you were happy with us, a short review helps other families and teams find us. Thank you!\n\nWarm regards,\n{{planner_name}}\n{{studio_name}}" },
    { key: "quote_followup", label: "Quote follow-up (no reply yet)", emoji: "📄", group: "Follow-ups",
      short: "Hi {{client_name}}, just checking you received our proposal for {{event_date}}. Happy to adjust anything or answer questions - {{planner_name}}, {{phone}}.",
      subject: "Your event proposal - any questions?",
      body: "Hi {{client_name}},\n\nI wanted to check that you received our proposal for your event on {{event_date}}. If anything needs changing - guest count, menu, decor or budget - we can adjust it.\n\nFeel free to reply here or call me on {{phone}}.\n\nBest regards,\n{{planner_name}}\n{{studio_name}}" },
    { key: "payment_reminder", label: "Payment reminder (friendly)", emoji: "🧾", group: "Follow-ups",
      short: "Hi {{client_name}}, a gentle reminder that the next payment for your event on {{event_date}} is due. Please ignore this if it's already done - thank you! - {{studio_name}}",
      subject: "A gentle payment reminder",
      body: "Hi {{client_name}},\n\nA gentle reminder that the next payment for your event on {{event_date}} is now due. If you have already paid, please ignore this message - and thank you!\n\nIf you have any questions about the amount or the payment details, just reply here or call {{planner_name}} on {{phone}}.\n\nBest regards,\n{{studio_name}}" },
    { key: "referral_request", label: "Referral request", emoji: "💬", group: "Follow-ups",
      short: "Hi {{client_name}}, if a friend or colleague is planning an event, we'd be grateful for an introduction. Thank you for thinking of us! - {{studio_name}}",
      subject: "Know someone planning an event?",
      body: "Hi {{client_name}},\n\nIt was a pleasure working with you. Most of our work comes from recommendations, so if a friend, relative or colleague is planning an event, we would be grateful for an introduction.\n\nThey can reach {{planner_name}} on {{phone}}.\n\nThank you for thinking of us,\n{{studio_name}}" },
    { key: "re_engagement", label: "Re-engagement - planning anything?", emoji: "👋", group: "Follow-ups",
      short: "Hi {{client_name}}, hope all is well! Planning anything this season? We'd love to help - {{planner_name}}, {{studio_name}}.",
      subject: "Planning anything this season, {{client_name}}?",
      body: "Hi {{client_name}},\n\nIt has been a while - we hope all is well! If you have a celebration or a company event on the horizon this season, we would love to help plan it.\n\nReply here or call {{planner_name}} on {{phone}} for a no-obligation chat.\n\nWarm regards,\n{{studio_name}}" },
  ];

  // server-side auto-greeting only fills these
  var SERVER_KEYS = ["name", "studio", "years", "occasion", "last_event", "client_name", "studio_name"];
  var ALIAS = { name: "client_name", studio: "studio_name" };

  function forCountry(cc) {
    var c = String(cc || "IN").toUpperCase();
    return L.filter(function (t) { return !t.countries || t.countries.indexOf(c) >= 0; });
  }
  function get(key) { for (var i = 0; i < L.length; i++) if (L[i].key === key) return L[i]; return null; }
  function placeholders(text) {
    var out = [], re = /\{\{?\s*([a-z_]+)\s*\}?\}/g, m;
    while ((m = re.exec(String(text || "")))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
    return out;
  }
  // fill {{x}} / {x}; unknown placeholders are left as typed so the user sees them
  function render(text, data) {
    var d = data || {};
    return String(text == null ? "" : text).replace(/\{\{\s*([a-z_]+)\s*\}\}|\{\s*([a-z_]+)\s*\}/g, function (all, a, b) {
      var k = a || b, key = ALIAS[k] || k;
      var v = d[key] != null && d[key] !== "" ? d[key] : (d[k] != null && d[k] !== "" ? d[k] : null);
      return v == null ? all : String(v);
    });
  }
  // the text the server's greeting job understands ({{name}} / {{studio}})
  function toServer(text) {
    return String(text || "").replace(/\{\{\s*client_name\s*\}\}/g, "{{name}}").replace(/\{\{\s*studio_name\s*\}\}/g, "{{studio}}");
  }
  function serverSafe(t) {
    return [t.subject, t.body].every(function (s) { return placeholders(s).every(function (k) { return SERVER_KEYS.indexOf(k) >= 0; }); });
  }
  // test data for previews (never a real client)
  function sample(cc, extra) {
    var c = String(cc || "IN").toUpperCase();
    var phone = c === "AE" ? "+971 50 123 4567" : c === "US" ? "+1 (201) 555-0123" : "+91 98765 43210";
    var d = new Date(); d.setDate(d.getDate() + 21);
    var base = { client_name: "Test client", studio_name: "Your studio", planner_name: "Your planner", phone: phone,
      event_date: d.toLocaleDateString(c === "US" ? "en-US" : "en-GB", { day: "numeric", month: "short", year: "numeric" }),
      years: "5", occasion: "special day", last_event: "your celebration with us" };
    if (extra) for (var k in extra) if (extra[k] != null && extra[k] !== "") base[k] = extra[k];
    return base;
  }
  // next yearly occurrence of a YYYY-MM-DD date on/after today (Feb 29 -> Feb 28 in other years)
  function nextOccurrence(iso, today) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); if (!m) return null;
    var t = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(today || "")); if (!t) return null;
    var y = +t[1], mo = +m[2], da = +m[3];
    function mk(yy) { var dd = da; if (mo === 2 && dd === 29 && !((yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0)) dd = 28;
      return yy + "-" + String(mo).padStart(2, "0") + "-" + String(dd).padStart(2, "0"); }
    var s = mk(y); if (s < t[0]) s = mk(y + 1);
    return { date: s, years: +s.slice(0, 4) - +m[1] };
  }
  function daysBetween(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
  // rows with birthday / anniversary (YYYY-MM-DD) -> occasions in the next `days` days, soonest first
  function upcoming(rows, today, days) {
    var n = days == null ? 30 : +days, out = [];
    (rows || []).forEach(function (r) {
      [["birthday", "birthday"], ["anniversary", "anniversary"]].forEach(function (p) {
        var v = r && r[p[0]]; if (!v) return;
        var nx = nextOccurrence(v, today); if (!nx) return;
        var inDays = daysBetween(today, nx.date);
        if (inDays >= 0 && inDays <= n) out.push({ id: r.id, name: r.name, phone: r.phone || "", email: r.email || "", kind: p[1], date: nx.date, years: nx.years, inDays: inDays });
      });
    });
    return out.sort(function (a, b) { return a.inDays - b.inDays || String(a.name).localeCompare(String(b.name)); });
  }

  var api = { LIBRARY: L, forCountry: forCountry, get: get, render: render, placeholders: placeholders, toServer: toServer,
    serverSafe: serverSafe, sample: sample, nextOccurrence: nextOccurrence, upcoming: upcoming, SERVER_KEYS: SERVER_KEYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmNurtureTemplates = api;
})(typeof window !== "undefined" ? window : this);
