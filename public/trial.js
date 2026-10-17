/* =========================================================================
   HELM — "Demo N" free-trial strip (0116)
   -------------------------------------------------------------------------
   Loaded by store-api.js on studio pages. Asks my_trial_org(); shows nothing
   unless this studio was made by start_trial().
     • in trial  → "Free trial · N days left" + "Choose a plan" (admins)
     • ended     → "Trial ended — read-only. Your data is safe." + "Choose a plan"
     • 0120: admins see a reminder card once per day on day 5 / 7 / 8 (3 days left /
       ends tomorrow / ends today, in the studio's zone) — "Choose a plan" / "Remind me later"
       (the database refuses edits; nothing is hidden or deleted)
   CSP: createElement/textContent only; CSS through __helmAdoptCss.
   ========================================================================= */
(function (global) {
  "use strict";

  // Pure (unit-tested): my_trial_org() answer → strip spec, or null.
  function bannerSpec(t) {
    if (!t || typeof t !== "object" || t.is_trial_org !== true) return null;
    var admin = t.is_admin === true;
    if (t.ended === true || t.locked === true) {
      return { tone: "ended", locked: t.locked !== false,
        title: "Your free trial has ended — this studio is read-only.",
        body: admin ? "Your data is safe. Choose a plan to keep editing." : "Your data is safe. Ask your studio admin to choose a plan.",
        cta: admin ? "Choose a plan" : null };
    }
    // calendar days to the last trial day in the studio's zone — the same count the reminder card uses
    var cal = null;
    try { var e0 = Date.parse(t.ends_at); if (isFinite(e0) && e0 > Date.now()) cal = dayNo(ymdIn(e0 - 1, t.timezone)) - dayNo(ymdIn(Date.now(), t.timezone)); } catch (e) { cal = null; }
    var n = Math.max(0, cal != null && isFinite(cal) ? cal : Math.floor(Number(t.days_left)));
    if (!isFinite(n)) return null;
    var left = n === 0 ? "ends today" : n === 1 ? "1 day left" : n + " days left";
    return { tone: n <= 2 ? "soon" : "", locked: false,
      title: "Free trial · " + left,
      body: t.trial_mode === "own" ? "Everything in Helm is open to you — no card needed." : "You're exploring sample data. Everything marked “Demo ·” is fictional.",
      cta: admin ? "Choose a plan" : null,
      // 0123: exploring samples -> one clear "start my own studio" action; "Choose a plan" offers it first
      fresh: admin && t.trial_mode === "demo" ? "Start my own studio" : null };
  }

  // Pure (unit-tested): where "Choose a plan" goes. In demo mode it first offers to remove the samples.
  function planHref(t, pageName) {
    if (t && t.is_admin === true && t.trial_mode === "demo" && t.ended !== true && t.locked !== true)
      return "dashboard.html?demo=fresh&then=checkout";
    return "checkout.html?next=" + encodeURIComponent((pageName || "dashboard") + ".html");
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

  // ---- 0120: day 5 / 7 / 8 reminder card (mirror of _trial_reminder_milestone) ----
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

  // 'd5' (3 days left) | 'd7' (ends tomorrow) | 'd8' (ends today) | null — calendar days in the studio's zone
  function reminderMilestone(endsAt, nowMs, tz) {
    var end = Date.parse(endsAt), now = Number(nowMs);
    if (!isFinite(end) || !isFinite(now) || end <= now) return null;
    var left = dayNo(ymdIn(end - 1, tz)) - dayNo(ymdIn(now, tz));
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
      after: "After that your studio becomes view-only — nothing is deleted, and everything unlocks again as soon as you choose a plan.",
      cta: "Choose a plan", later: "Remind me later",
      key: "helm_trial_reminder:" + m + ":" + ymdIn(nowMs, tz) };
  }

  // ---- 0126: trial staff + after-trial access ----
  // my_trial_access() answer -> Staff-page note spec, or null (active trial only)
  function staffNoteSpec(a) {
    if (!a || typeof a !== "object" || a.is_trial_org !== true) return null;
    if (a.ended === true || a.locked === true) return { tone: "ended",
      text: "Trial ended: staff can't sign in to this studio until it's on a plan. Their accounts are kept and come back the moment you subscribe." };
    var when = endsLabel(a.ends_at, a.timezone || null);
    return { tone: "", text: "Trial: staff access ends when the trial ends" + (when ? " on " + when : "") +
      ". Invite your real team now; if you choose a plan, they keep working without being re-invited." };
  }
  // my_trial_access() answer -> full-page "trial ended" screen for a blocked (non-owner) member, or null
  function blockedSpec(a) {
    if (!a || typeof a !== "object" || a.is_trial_org !== true || a.blocked !== true || a.is_owner === true) return null;
    return { title: "This studio's trial has ended",
      body: "Ask the studio owner to subscribe" + (a.name ? " to " + a.name : "") + ". Nothing has been deleted, and your access comes back automatically as soon as they choose a plan.",
      cta: "Sign out" };
  }

  var api = { staffNoteSpec: staffNoteSpec, blockedSpec: blockedSpec, bannerSpec: bannerSpec, planHref: planHref, nextDemoNumber: nextDemoNumber, reminderMilestone: reminderMilestone,
              reminderSpec: reminderSpec, endsLabel: endsLabel, ymdIn: ymdIn, REMINDER_TITLES: REMINDER_TITLES };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!global || !global.document) return;
  global.HelmTrial = api;

  var doc = global.document;
  var CSS = [
    ".htr{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;justify-content:center;padding:8px 16px;font-size:13.5px;line-height:1.4;background:var(--accent-soft,#efe9ff);color:var(--ink,#1b1930);border-bottom:1px solid var(--line,#e8e3db)}",
    ".htr.soon{background:#fff4e0}.htr.ended{background:#fde8e8}",
    ".htr b{font-weight:700}.htr span{color:var(--ink-2,#4b475f)}",
    ".htr a{display:inline-block;padding:4px 12px;border-radius:999px;background:var(--accent,#6d28d9);color:#fff;font-weight:600;text-decoration:none}",
    ".htr a.htr-fresh{background:transparent;color:var(--accent,#6d28d9);border:1px solid var(--accent,#6d28d9)}",
    "html[data-theme=dark] .htr a.htr-fresh{color:#d9ccff;border-color:#8b7bd8}",
    ".htr a:focus-visible{outline:2px solid var(--ink,#1b1930);outline-offset:2px}",
    ".htrm{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(20,16,40,.45)}",
    ".htrm-c{max-width:440px;width:100%;background:var(--card,#fff);color:var(--ink,#1b1930);border-radius:16px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.25);font-size:14.5px;line-height:1.5}",
    ".htrm-c .k{display:inline-block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--accent,#6d28d9);margin-bottom:6px}",
    ".htrm-c h2{margin:0 0 10px;font-size:20px;line-height:1.3}.htrm-c p{margin:0 0 10px;color:var(--ink-2,#4b475f)}",
    ".htrm-a{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px}",
    ".htrm-a a,.htrm-a button{font:inherit;font-weight:600;padding:9px 16px;border-radius:999px;cursor:pointer;text-decoration:none;border:1px solid transparent}",
    ".htrm-a a{background:var(--accent,#6d28d9);color:#fff}.htrm-a button{background:transparent;border-color:var(--line,#d9d3c9);color:var(--ink,#1b1930)}",
    ".htrm-a a:focus-visible,.htrm-a button:focus-visible{outline:2px solid var(--ink,#1b1930);outline-offset:2px}",
    "html[data-theme=dark] .htrm-c{background:#1f1a33;color:#f3f0ff}html[data-theme=dark] .htrm-c p{color:#cfc8e8}html[data-theme=dark] .htrm-a button{color:#f3f0ff;border-color:#4a4363}",
    "html[data-theme=dark] .htr{background:#2a2340;color:#f3f0ff}html[data-theme=dark] .htr span{color:#cfc8e8}html[data-theme=dark] .htr.soon{background:#3a2d12}html[data-theme=dark] .htr.ended{background:#3d1c1c}",
    ".htb{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--bg,#f7f5f1)}",
    ".htb-c{max-width:460px;width:100%;background:var(--card,#fff);color:var(--ink,#1b1930);border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.18);font-size:15px;line-height:1.55;text-align:center}",
    ".htb-c h2{margin:0 0 10px;font-size:21px}.htb-c p{margin:0 0 18px;color:var(--ink-2,#4b475f)}",
    ".htb-c button{padding:9px 18px;border-radius:999px;border:0;background:var(--accent,#6d28d9);color:#fff;font-weight:600;cursor:pointer}",
    ".htb-c button:focus-visible{outline:2px solid var(--ink,#1b1930);outline-offset:2px}",
    ".htsn{margin:0 0 14px;padding:10px 14px;border-radius:10px;font-size:13.5px;line-height:1.45;background:var(--accent-soft,#efe9ff);color:var(--ink,#1b1930);border:1px solid var(--line,#e8e3db)}",
    ".htsn.ended{background:#fde8e8}",
    "html[data-theme=dark] .htb{background:#14111f}html[data-theme=dark] .htb-c{background:#1f1a33;color:#f3f0ff}html[data-theme=dark] .htb-c p{color:#cfc8e8}html[data-theme=dark] .htsn{background:#2a2340;color:#f3f0ff;border-color:#4a4363}html[data-theme=dark] .htsn.ended{background:#3d1c1c}"
  ].join("");

  function page() { try { return (location.pathname.split("/").pop() || "dashboard").replace(/\.html$/, "") || "dashboard"; } catch (e) { return "dashboard"; } }

  var lastT = null;
  function render(spec) {
    if (!spec || doc.getElementById("helmTrialStrip")) return;
    if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS);
    var bar = doc.createElement("div");
    bar.id = "helmTrialStrip";
    bar.className = "htr" + (spec.tone ? " " + spec.tone : "");
    bar.setAttribute("role", spec.locked ? "alert" : "status");
    var b = doc.createElement("b"); b.textContent = spec.title; bar.appendChild(b);
    var s = doc.createElement("span"); s.textContent = spec.body; bar.appendChild(s);
    if (spec.cta) {
      var a = doc.createElement("a");
      a.href = planHref(lastT, page());
      a.textContent = spec.cta;
      bar.appendChild(a);
    }
    if (spec.fresh) {
      var f = doc.createElement("a");
      f.href = "dashboard.html?demo=fresh"; f.className = "htr-fresh";
      f.textContent = spec.fresh;
      bar.appendChild(f);
    }
    doc.body.insertBefore(bar, doc.body.firstChild);
    if (spec.locked) doc.documentElement.classList.add("helm-trial-locked");
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
    var a = doc.createElement("a"); a.href = planHref(lastT, page()); a.textContent = spec.cta;
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
    st.trialOrg.status().then(function (t) { lastT = t; render(bannerSpec(t)); renderReminder(reminderSpec(t, Date.now())); }).catch(function () {});
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
      if (page() === "staff") renderStaffNote(staffNoteSpec(a));
    }).catch(function () {});
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", run); else run();
})(typeof window !== "undefined" ? window : globalThis);
