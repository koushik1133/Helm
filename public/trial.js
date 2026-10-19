/* =========================================================================
   HELM — "Demo N" free-trial strip (0116)
   -------------------------------------------------------------------------
   Loaded by store-api.js on studio pages. Asks my_trial_org(); shows nothing
   unless this studio was made by start_trial().
     • in trial  → "Free trial · N days left" + "Choose a plan" (admins) — 0180: nothing else
                   (no sample-data text / badge / "Start my own studio"); the plan link goes
                   straight to /checkout
     • ended     → 0183: "Your trial has ended. Your data is preserved and available in read-only
                   mode. Upgrade now to continue creating and editing records." + "Upgrade" (admins);
                   the same strip for invited members (read-only too), who are told an admin upgrades
     • 0120: admins see a reminder card once per day 3 days before the trial's end day, the day
       before it and on the end day (3 days left / ends tomorrow / ends today) — "Choose a plan" /
       "Remind me later" (the database refuses edits; nothing is hidden or deleted)
     • L9: every trial date is the STUDIO's calendar day of the end moment (endDay / daysLeft /
       endDayText): the strip, the reminder card, the Staff note and Plan & billing all count the same way
       (a trial that ends 27 Oct 03:30 IST ends on 27 Oct, never the UTC day 26 Oct)
   CSP: createElement/textContent only; CSS through __helmAdoptCss.
   ========================================================================= */
(function (global) {
  "use strict";

  // r21: the ONE retention promise (same words in the trial e-mails, billing-reminder and the policy pages). The
  // deletion switch (helm_trial_retention.delete_enabled) stays OFF until the owner turns it on.
  var RETENTION_PROMISE = "Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted.";

  // Pure (unit-tested): my_trial_org() answer → strip spec, or null.
  // r21: an ended trial also offers "Talk to us" (admins: the plan page opens Contact sales) and "Ask my admin to
  // upgrade" (teammates: one bell notice + e-mail to the admins, 0244 ask_admin_upgrade), plus the retention promise.
  function bannerSpec(t) {
    if (!t || typeof t !== "object" || t.is_trial_org !== true) return null;
    var admin = t.is_admin === true;
    // 0183 (post-trial policy 1 / 6 / 10): the trial ended unpaid -> the studio is READ-ONLY for everyone
    // (owner + invited members). Same words for all; only an admin gets the Upgrade button.
    if (t.read_only === true || t.locked === true) {
      return { tone: "ended", locked: true,
        title: "Your trial has ended.",
        body: "Your data is preserved and available in read-only mode. Upgrade now to continue creating and editing records.",
        cta: admin ? "Upgrade" : null,
        note: admin ? null : "Only a studio admin can upgrade.",
        talk: admin ? "Talk to us" : null,
        ask: admin ? null : "Ask my admin to upgrade",
        keep: "Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted." };   // = RETENTION_PROMISE (self-contained: tests run this function alone)
    }
    // trial date passed but the studio is not read-only (paid / extended on an older server answer): no strip
    if (t.ended === true) return null;
    // calendar days to the last trial day in the studio's zone — the same count the reminder card uses (L9: daysLeft)
    var cal = null;
    try { cal = daysLeft(t.ends_at, Date.now(), t.timezone); } catch (e) { cal = null; }
    var n = Math.max(0, cal != null && isFinite(cal) ? cal : Math.floor(Number(t.days_left)));
    if (!isFinite(n)) return null;
    var left = n === 0 ? "ends today" : n === 1 ? "1 day left" : n + " days left";
    // 0180: the strip is only "Free trial · N days left" + "Choose a plan" (admins): no body text,
    // no "Sample data" badge and no "Start my own studio" link any more
    return { tone: n <= 2 ? "soon" : "", locked: false,
      title: "Free trial · " + left,
      body: null,
      cta: admin ? "Choose a plan" : null };
  }

  // QA B2 (pure, unit-tested): a studio on its free trial that my_trial_org() does not cover (is_trial_org false:
  // the trial was not made by start_trial(), e.g. organizations.trial_ends_at is empty) still gets the ONE strip,
  // from my_trial_status() (s): {state 'trial', ends_at = the LAST trial day "YYYY-MM-DD", days_left, is_admin}.
  // Days left are counted in the studio's zone (calendar days, never shifted by UTC). Running trial only: an ended
  // one keeps auth-ui.js's "Your trial has ended" notice. o = the my_trial_org() answer (null / not a trial org).
  function subscriptionStrip(s, o, nowMs, tz) {
    if (o && o.is_trial_org === true) return null;
    if (!s || typeof s !== "object" || s.state !== "trial") return null;
    var zone = s.timezone || tz || "Asia/Kolkata", left = null;
    // L9 / 0223: the exact end (ends_at_exact) counted in the studio's zone when the server sends it
    if (s.ends_at_exact) { try { left = daysLeft(s.ends_at_exact, nowMs == null ? Date.now() : nowMs, zone); } catch (e) { left = null; } }
    var m = left == null ? /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s.ends_at || "")) : null;
    if (m) { try { left = dayNo(m[1] + "-" + m[2] + "-" + m[3]) - dayNo(ymdIn(nowMs == null ? Date.now() : nowMs, zone)); } catch (e) { left = null; } }
    if (left == null || !isFinite(left)) left = Math.floor(Number(s.days_left));
    if (!isFinite(left) || left < 0) return null;
    return { is_trial_org: true, from_subscription: true, is_admin: s.is_admin === true, days_left: left, timezone: zone };
  }

  // Pure (unit-tested): where "Choose a plan" goes - 0180: always straight to the plan / checkout page
  // (it no longer offers to remove the samples first; t is kept for callers)
  // r22: a pretty studio path ("/<slug>/events/SMP-1001") is passed as-is (checkout's safeNext re-builds it from its
  // parsed parts); a plain page name gets ".html" (was: "SMP-1001.html" on an event page)
  function planHref(t, pageName) {
    return "checkout.html?next=" + encodeURIComponent(String(pageName || "").charAt(0) === "/" ? String(pageName) : (pageName || "dashboard") + ".html");
  }
  // r21 (pure): "Talk to us" = the plan page with the Contact sales form open, from the read-only banner
  function talkHref(pageName) { return planHref(null, pageName) + "&sales=banner"; }
  // r21 (pure): ask_admin_upgrade() answer -> the line shown next to the button
  function askResultText(r) {
    if (r && r.sent === true) return "Done - your studio admin has been asked to choose a plan.";
    if (r && r.already === true) return "Your studio admin has already been asked today.";
    return "We couldn't send that just now. Please ask your studio admin directly.";
  }

  // Pure (unit-tested) mirror of _trial_next_demo_number(): next free "Demo N".
  function nextDemoNumber(names, slugs) {
    var max = 0, takenN = {}, takenS = {};
    (names || []).forEach(function (raw) {
      var s = String(raw == null ? "" : raw);
      var m = /^Demo ([0-9]{1,9})$/.exec(s);
      if (m) max = Math.max(max, Number(m[1]));
      takenN[s.trim().toLowerCase()] = 1;
    });
    (slugs || []).forEach(function (s) { takenS[String(s)] = 1; });
    var n = max + 1, i = 0;
    while (takenN["demo " + n] || takenS["demo-" + n]) { n++; if (++i > 1000) throw new Error("could not pick a demo studio name"); }
    return n;
  }

  // ---- 0120: reminder card 3 days / 1 day / 0 days before the end day (mirror of _trial_reminder_milestone) ----
  // YYYY-MM-DD of a moment in a time zone (bad zone -> Asia/Kolkata, then UTC)
  function ymdIn(ms, tz) {
    var zones = [tz || "Asia/Kolkata", "Asia/Kolkata"];
    for (var i = 0; i < zones.length; i++) {
      try {
        var p = new Intl.DateTimeFormat("en-CA", { timeZone: zones[i], year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
        var o = {}; p.forEach(function (x) { o[x.type] = x.value; });
        if (o.year && o.month && o.day) return o.year + "-" + o.month + "-" + o.day;
      } catch (e) {}
    }
    return new Date(ms).toISOString().slice(0, 10);
  }
  function dayNo(ymd) { return Math.round(Date.parse(ymd + "T00:00:00Z") / 86400000); }

  // L9 (live QA): ONE way to say when the trial ends, everywhere. The end is an exact moment (sign-up + 8 days,
  // e.g. 2026-10-26T22:00Z = 27 Oct 03:30 IST). Its day is the STUDIO's calendar day of that moment (an end at
  // exactly midnight belongs to the day before) - never the UTC day. A bare "YYYY-MM-DD" is already a day.
  function endDay(endsAt, tz) {
    var s = String(endsAt == null ? "" : endsAt).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var e = Date.parse(s);
    return isFinite(e) ? ymdIn(e - 1, tz) : null;
  }
  // calendar days from today (studio zone) to the end day; null when unknown or already over
  function daysLeft(endsAt, nowMs, tz) {
    var d = endDay(endsAt, tz), now = nowMs == null ? Date.now() : Number(nowMs);
    if (!d || !isFinite(now)) return null;
    var s = String(endsAt).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) && !(Date.parse(s) > now)) return null;
    var n = dayNo(d) - dayNo(ymdIn(now, tz));
    return isFinite(n) && n >= 0 ? n : null;
  }
  // "27 Oct 2026" (India format) for the end day in the studio's zone
  function endDayText(endsAt, tz) {
    var d = endDay(endsAt, tz); if (!d) return "";
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    try { return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }); }
    catch (e) { return d; }
  }

  // 'd5' (3 days left) | 'd7' (ends tomorrow) | 'd8' (ends today) | null — calendar days in the studio's zone
  // (the ids d5 / d7 / d8 are kept: the database ledger + e-mail copy use them; they mean 3 / 1 / 0 days left)
  function reminderMilestone(endsAt, nowMs, tz) {
    var end = Date.parse(endsAt), now = Number(nowMs);
    if (!isFinite(end) || !isFinite(now) || end <= now) return null;
    var left = daysLeft(endsAt, now, tz);
    return left === 3 ? "d5" : left === 1 ? "d7" : left === 0 ? "d8" : null;
  }

  function endsLabel(endsAt, tz) {
    var d = new Date(endsAt);
    if (isNaN(d.getTime())) return "";
    try { return new Intl.DateTimeFormat("en-GB", { timeZone: tz || "Asia/Kolkata", weekday: "long", day: "numeric", month: "long",
      hour: "numeric", minute: "2-digit", hour12: true }).format(d); } catch (e) { return ""; }
  }

  var REMINDER_TITLES = { d5: "3 days left in your free trial", d7: "Your free trial ends tomorrow", d8: "Your trial ends today" };
  // my_trial_org() answer + now -> card spec, or null (admins of an active, unlocked trial only)
  function reminderSpec(t, nowMs) {
    if (!t || typeof t !== "object" || t.is_trial_org !== true || t.is_admin !== true) return null;
    if (t.ended === true || t.locked === true) return null;
    var tz = t.timezone || null;
    var m = reminderMilestone(t.ends_at, nowMs, tz);
    if (!m) return null;
    var when = endsLabel(t.ends_at, tz);
    var left = m === "d5" ? "3 days left" : m === "d7" ? "Ends tomorrow" : "Last day";
    return { milestone: m, title: REMINDER_TITLES[m], left: left,
      body: "Your 8-day free trial (no card required) ends" + (when ? " on " + when : "") + ".",
      after: "After that your studio becomes view-only. " + RETENTION_PROMISE + " Everything unlocks again as soon as you choose a plan.",
      cta: "Choose a plan", later: "Remind me later",
      key: "helm_trial_reminder:" + m + ":" + ymdIn(nowMs, tz) };
  }

  // ---- 0126 / 0183: trial staff + after-trial access ----
  // my_trial_access() answer -> Staff-page note spec, or null (active trial only)
  // r20 coord (d): isAdmin === false -> teammate wording (a teammate can't invite or choose a plan);
  // the studio admin (or an older caller that passes nothing) keeps the owner wording.
  function staffNoteSpec(a, isAdmin) {
    if (!a || typeof a !== "object" || a.is_trial_org !== true) return null;
    var mate = isAdmin === false;
    if (a.read_only === true || a.locked === true) return { tone: "ended", text: mate
      ? "Your studio's free trial has ended. You can still sign in and view everything in read-only mode; creating and editing come back when your studio admin chooses a plan."
      : "Trial ended: everyone in this studio, including invited staff, can still sign in and view everything in read-only mode. Upgrade to continue creating and editing records." };
    if (a.ended === true) return null;
    var when = endsLabel(a.ends_at, a.timezone || null);
    if (mate) return { tone: "", text: "Your studio is on a free trial" + (when ? " until " + when : "") +
      ". If it ends before a plan is chosen, you can still sign in and view everything. " + RETENTION_PROMISE };
    return { tone: "", text: "Trial: when the trial ends" + (when ? " on " + when : "") +
      ", your staff keep read-only access until you upgrade. Invite your real team now; if you choose a plan, they keep working without being re-invited." };
  }
  // my_trial_access() answer -> full-page "trial ended" screen for a blocked (non-owner) member, or null.
  // 0183: the server no longer blocks anyone (blocked is always false); kept for a database without 0183.
  function blockedSpec(a) {
    if (!a || typeof a !== "object" || a.is_trial_org !== true || a.blocked !== true || a.is_owner === true) return null;
    return { title: "This studio's trial has ended",
      body: "Ask the studio owner to subscribe" + (a.name ? " to " + a.name : "") + ". Nothing has been deleted, and your access comes back automatically as soon as they choose a plan.",
      cta: "Sign out" };
  }

  var api = { RETENTION_PROMISE: RETENTION_PROMISE, talkHref: talkHref, askResultText: askResultText, subscriptionStrip: subscriptionStrip, staffNoteSpec: staffNoteSpec, blockedSpec: blockedSpec, bannerSpec: bannerSpec, planHref: planHref, nextDemoNumber: nextDemoNumber, reminderMilestone: reminderMilestone,
              reminderSpec: reminderSpec, endsLabel: endsLabel, ymdIn: ymdIn, REMINDER_TITLES: REMINDER_TITLES,
              endDay: endDay, daysLeft: daysLeft, endDayText: endDayText };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!global || !global.document) return;
  global.HelmTrial = api;

  var doc = global.document;
  var CSS = [
    ".htr{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:center;padding:8px 16px;font-size:13.5px;line-height:1.4;background:var(--accent-soft,#e3f4ed);color:var(--ink,#1b1930);border-bottom:1px solid var(--line,#e8e3db)}",
    ".htr.soon{background:#fff4e0}.htr.ended{background:#fde8e8}",
    ".htr b{font-weight:700}.htr span{color:var(--ink-2,#4b475f)}.htr span.htr-note{font-weight:600}",
    // 0183 read-only studio: create / compose controls that are not gated by the page's own edit check
    "html.helm-read-only #composer,html.helm-read-only #sendBtn,html.helm-read-only #newBtn,html.helm-read-only #createBtn,html.helm-read-only [data-requires-edit]{display:none!important}",
    ".htr a{display:inline-block;padding:4px 12px;border-radius:999px;background:var(--accent,#047857);color:#fff;font-weight:600;text-decoration:none}",
    ".htr a:focus-visible{outline:2px solid var(--ink,#1b1930);outline-offset:2px}",
    // r21: "Talk to us" (outline pill next to Upgrade), "Ask my admin to upgrade" (teammates), the retention line
    ".htr a.htr-talk{background:transparent;color:var(--accent,#047857);border:1px solid var(--accent,#047857);padding:3px 11px}",
    ".htr button.htr-ask{font:inherit;font-weight:600;padding:4px 12px;border-radius:999px;border:1px solid var(--accent,#047857);background:var(--accent,#047857);color:#fff;cursor:pointer;min-height:28px}",
    ".htr button.htr-ask:disabled{opacity:.6;cursor:default}.htr button.htr-ask:focus-visible{outline:2px solid var(--ink,#1b1930);outline-offset:2px}",
    ".htr span.htr-askmsg:empty{display:none}.htr span.htr-askmsg{font-weight:600}",
    ".htr span.htr-keep{flex-basis:100%;text-align:center;font-size:12.5px}",
    ".htrm{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(20,16,40,.45)}",
    ".htrm-c{max-width:440px;width:100%;background:var(--card,#fff);color:var(--ink,#1b1930);border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.25);font-size:14.5px;line-height:1.5}",
    ".htrm-c .k{display:inline-block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--accent,#047857);margin-bottom:6px}",
    ".htrm-c h2{margin:0 0 10px;font-size:20px;line-height:1.3}.htrm-c p{margin:0 0 10px;color:var(--ink-2,#4b475f)}",
    ".htrm-a{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}",
    ".htrm-a a,.htrm-a button{font:inherit;font-weight:600;padding:9px 16px;border-radius:999px;cursor:pointer;text-decoration:none;border:1px solid transparent}",
    ".htrm-a a{background:var(--accent,#047857);color:#fff}.htrm-a button{background:transparent;border-color:var(--line,#d9d3c9);color:var(--ink,#1b1930)}",
    ".htrm-a a:focus-visible,.htrm-a button:focus-visible{outline:2px solid var(--ink,#1b1930);outline-offset:2px}",
    "html[data-theme=dark] .htrm-c{background:#1f1a33;color:#f3f0ff}html[data-theme=dark] .htrm-c p{color:#cfc8e8}html[data-theme=dark] .htrm-a button{color:#f3f0ff;border-color:#4a4363}",
    "html[data-theme=dark] .htr{background:#2a2340;color:#f3f0ff}html[data-theme=dark] .htr span{color:#cfc8e8}html[data-theme=dark] .htr.soon{background:#3a2d12}html[data-theme=dark] .htr.ended{background:#3d1c1c}",
    ".htb{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg,#f7f5f1)}",
    ".htb-c{max-width:460px;width:100%;background:var(--card,#fff);color:var(--ink,#1b1930);border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.18);font-size:15px;line-height:1.55;text-align:center}",
    ".htb-c h2{margin:0 0 10px;font-size:21px}.htb-c p{margin:0 0 18px;color:var(--ink-2,#4b475f)}",
    ".htb-c button{padding:9px 18px;border-radius:999px;border:0;background:var(--accent,#047857);color:#fff;font-weight:600;cursor:pointer}",
    ".htb-c button:focus-visible{outline:2px solid var(--ink,#1b1930);outline-offset:2px}",
    ".htsn{margin:0 0 14px;padding:10px 14px;border-radius:10px;font-size:13.5px;line-height:1.45;background:var(--accent-soft,#e3f4ed);color:var(--ink,#1b1930);border:1px solid var(--line,#e8e3db)}",
    ".htsn.ended{background:#fde8e8}",
    "html[data-theme=dark] .htb{background:#14111f}html[data-theme=dark] .htb-c{background:#1f1a33;color:#f3f0ff}html[data-theme=dark] .htb-c p{color:#cfc8e8}html[data-theme=dark] .htsn{background:#2a2340;color:#f3f0ff;border-color:#4a4363}html[data-theme=dark] .htsn.ended{background:#3d1c1c}"
  ].join("");

  function page() { try { return (location.pathname.split("/").pop() || "dashboard").replace(/\.html$/, "") || "dashboard"; } catch (e) { return "dashboard"; } }
  // r22: where "Choose a plan" returns to - the pretty path on /<slug>/... pages, else the page name
  function hereRef() { try { var U = global.HelmUrl; if (U && U.route && U.route()) return U.here().split("#")[0]; } catch (e) {} return page(); }

  var lastT = null;
  function render(spec) {
    if (!spec || doc.getElementById("helmTrialStrip")) return;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
    var bar = doc.createElement("div");
    bar.id = "helmTrialStrip";
    bar.className = "htr" + (spec.tone ? " " + spec.tone : "");
    bar.setAttribute("role", spec.locked ? "alert" : "status");
    var b = doc.createElement("b"); b.textContent = spec.title; bar.appendChild(b);
    if (spec.body) { var s = doc.createElement("span"); s.textContent = spec.body; bar.appendChild(s); }
    if (spec.cta) {
      var a = doc.createElement("a");
      a.href = planHref(lastT, hereRef());
      a.textContent = spec.cta;
      bar.appendChild(a);
    }
    if (spec.talk) {
      var tk = doc.createElement("a"); tk.className = "htr-talk"; tk.href = talkHref(hereRef()); tk.textContent = spec.talk; bar.appendChild(tk);
    }
    if (spec.note) { var nt = doc.createElement("span"); nt.className = "htr-note"; nt.textContent = spec.note; bar.appendChild(nt); }
    if (spec.ask) {
      var ab = doc.createElement("button"); ab.type = "button"; ab.className = "htr-ask"; ab.textContent = spec.ask;
      var am = doc.createElement("span"); am.className = "htr-askmsg"; am.setAttribute("role", "status"); am.setAttribute("aria-live", "polite");
      ab.addEventListener("click", function () {
        var st = global.BPStore;
        if (ab.disabled || !st || !st.trialOrg || typeof st.trialOrg.askAdmin !== "function") return;
        ab.disabled = true; ab.setAttribute("aria-busy", "true");
        Promise.resolve(st.trialOrg.askAdmin()).then(function (r) {
          am.textContent = askResultText(r);
          if (!(r && (r.sent === true || r.already === true))) ab.disabled = false;
        }, function () { am.textContent = askResultText(null); ab.disabled = false; })
          .then(function () { ab.removeAttribute("aria-busy"); });
      });
      bar.appendChild(ab); bar.appendChild(am);
    }
    if (spec.keep) { var kp = doc.createElement("span"); kp.className = "htr-keep"; kp.textContent = spec.keep; bar.appendChild(kp); }
    doc.body.insertBefore(bar, doc.body.firstChild);
    // 0183: read-only studio -> html.helm-read-only hides the few create / compose controls a page does not gate itself
    if (spec.locked) { doc.documentElement.classList.add("helm-trial-locked"); doc.documentElement.classList.add("helm-read-only"); }
  }

  function seen(key) { try { return global.localStorage.getItem(key) === "1"; } catch (e) { return false; } }
  function markSeen(key) { try { global.localStorage.setItem(key, "1"); } catch (e) {} }

  // once per milestone per (studio-zone) day; "Remind me later" / Esc / backdrop just close it for today
  function renderReminder(spec) {
    if (!spec || seen(spec.key) || doc.getElementById("helmTrialReminder")) return;
    markSeen(spec.key);
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
    var prev = doc.activeElement;
    var wrap = doc.createElement("div"); wrap.id = "helmTrialReminder"; wrap.className = "htrm";
    var card = doc.createElement("div"); card.className = "htrm-c";
    card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "helmTrialReminderT");
    var k = doc.createElement("span"); k.className = "k"; k.textContent = "Free trial · " + spec.left; card.appendChild(k);
    var h = doc.createElement("h2"); h.id = "helmTrialReminderT"; h.textContent = spec.title; card.appendChild(h);
    var p1 = doc.createElement("p"); p1.textContent = spec.body; card.appendChild(p1);
    var p2 = doc.createElement("p"); p2.textContent = spec.after; card.appendChild(p2);
    var row = doc.createElement("div"); row.className = "htrm-a";
    var a = doc.createElement("a"); a.href = planHref(lastT, hereRef()); a.textContent = spec.cta;
    var later = doc.createElement("button"); later.type = "button"; later.textContent = spec.later;
    row.appendChild(a); row.appendChild(later); card.appendChild(row); wrap.appendChild(card);
    function close() {
      doc.removeEventListener("keydown", onKey, true);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      try { if (prev && prev.focus) prev.focus(); } catch (e) {}
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    later.addEventListener("click", close);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    doc.addEventListener("keydown", onKey, true);
    doc.body.appendChild(wrap);
    try { a.focus(); } catch (e) {}
  }

  function run() {
    var st = global.BPStore;
    if (!st || !st.trialOrg || !st.auth || !st.auth.user || !st.auth.user()) return;
    if (page() === "checkout" || page() === "login") return;
    st.trialOrg.status().then(function (t) {
      lastT = t; render(bannerSpec(t)); renderReminder(reminderSpec(t, Date.now()));
      // QA B2: a trial studio my_trial_org() does not cover gets the same strip from the subscription's answer
      if (!(t && t.is_trial_org === true) && st.subscription && typeof st.subscription.trial === "function") {
        Promise.resolve(st.subscription.trial()).then(function (s) {
          var tz; try { tz = typeof st.studioTimezone === "function" ? st.studioTimezone() : undefined; } catch (e) { tz = undefined; }
          render(bannerSpec(subscriptionStrip(s, t, Date.now(), tz)));
        }).catch(function () {});
      }
    }).catch(function () {});
    runAccess(st);
  }

  // 0126: blocked member -> "trial ended" screen; owner/staff on the Staff page -> access note
  function renderBlocked(spec, st) {
    if (!spec || doc.getElementById("helmTrialBlocked")) return;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
    var wrap = doc.createElement("div"); wrap.id = "helmTrialBlocked"; wrap.className = "htb";
    var card = doc.createElement("div"); card.className = "htb-c";
    card.setAttribute("role", "alertdialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "helmTrialBlockedT");
    var h = doc.createElement("h2"); h.id = "helmTrialBlockedT"; h.textContent = spec.title; card.appendChild(h);
    var p = doc.createElement("p"); p.textContent = spec.body; card.appendChild(p);
    var b = doc.createElement("button"); b.type = "button"; b.textContent = spec.cta;
    b.addEventListener("click", function () {
      var go = function () { location.href = "login.html"; };
      try { var r = st.auth.signOut && st.auth.signOut(); if (r && r.then) r.then(go, go); else go(); } catch (e) { go(); }
    });
    card.appendChild(b); wrap.appendChild(card);
    doc.body.appendChild(wrap);
    doc.documentElement.classList.add("helm-trial-blocked");
    try { b.focus(); } catch (e) {}
  }
  function renderStaffNote(spec) {
    if (!spec || doc.getElementById("helmTrialStaffNote")) return;
    var main = doc.getElementById("main");
    if (!main) return;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
    var n = doc.createElement("p"); n.id = "helmTrialStaffNote";
    n.className = "htsn" + (spec.tone ? " " + spec.tone : "");
    n.setAttribute("role", "note"); n.textContent = spec.text;
    main.insertBefore(n, main.firstChild);
  }
  function runAccess(st) {
    if (!st.trialOrg.access) return;
    st.trialOrg.access().then(function (a) {
      var blk = blockedSpec(a);
      if (blk) { renderBlocked(blk, st); return; }
      if (page() !== "staff") return;
      // the owner wording ("Invite your real team now...") is for the studio admin only
      var roleP; try { roleP = Promise.resolve(st.auth.role ? st.auth.role() : null); } catch (e) { roleP = Promise.resolve(null); }
      roleP.catch(function () { return null; }).then(function (r) {
        renderStaffNote(staffNoteSpec(a, r === "admin" || a.is_owner === true));
      });
    }).catch(function () {});
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", run); else run();
})(typeof window !== "undefined" ? window : globalThis);
