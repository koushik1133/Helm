/* shell-b-style.js — icon swap (emoji -> line SVG) + loading skeletons for the new shell. */
(function () {
  "use strict";
  var p = location.pathname.toLowerCase();
  if (p.indexOf("builder") !== -1 || p.indexOf("floor-plan") !== -1) return;

  var NS = "http://www.w3.org/2000/svg";
  var P = {
    plus: "M12 5v14M5 12h14",
    cal: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
    doc: "M6 3h9l4 4v14H6zM14 3v5h5",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
    users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 3a4 4 0 0 1 0 8M22 21a7 7 0 0 0-4-6.3",
    box: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10",
    money: "M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    chat: "M4 5h16v11H8l-4 4z",
    search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
    // r26: the cog is the rail's Control Center icon (one icon set app-wide; the old polygon gear looked off)
    gear: "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
    // r26: operations = clipboard with a tick (quotes list "Ops", rail Operations)
    ops: "M9 3h6a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2M9 14l2 2 4-4",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14",
    venue: "M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6",
    ticket: "M4 7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v3a2 2 0 0 0 0 4v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a2 2 0 0 0 0-4zM14 6v12",
    lifebuoy: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6",
    mic: "M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3",
    sliders: "M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4",
    card: "M3 6h18v12H3zM3 10h18M7 15h3",
    puzzle: "M10 4a2 2 0 0 1 4 0v2h4v4h-2a2 2 0 0 0 0 4h2v4h-4v-2a2 2 0 0 0-4 0v2H6v-4h2a2 2 0 0 0 0-4H6V6h4z",
    gate: "M9 3h6a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM12 7.5h.01M12 12h.01M12 16.5h.01",
    chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    mail: "M3 5h18v14H3zM3 6l9 7 9-7",
    phone: "M5 3h4l2 5-3 2a11 11 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z",
    pin: "M12 21s-7-6-7-12a7 7 0 0 1 14 0c0 6-7 12-7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    check: "M5 12l5 5 9-11",
    edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
    print: "M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z",
    bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4",
    link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
    sparkle: "M12 3v6M12 15v6M3 12h6M15 12h6",
    folder: "M3 6h7l2 2h9v11H3z",
    send: "M3 11l18-8-8 18-2-8z",
    clip: "M21 11l-9 9a5 5 0 0 1-7-7l9-9a3 3 0 0 1 4 4l-9 9a1 1 0 0 1-2-2l8-8",
    inbox: "M3 13l3-9h12l3 9v7H3zM3 13h5l1 3h6l1-3h5",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
    home: "M3 11l9-7 9 7M5 10v10h14V10",
    hand: "M8 12l3-3 3 2 4-4M3 12l5 5 3-1 5 4 5-6-5-5",
    clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
    helmet: "M4 16a8 8 0 0 1 16 0zM2 16h20v3H2zM12 8V5",
    mobile: "M7 2h10v20H7zM11 18h2",
    save: "M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7",
    lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
    key: "M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM11 11h10M18 11v3M15 11v2",
    camera: "M3 8h4l2-3h6l2 3h4v12H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    truck: "M2 6h12v10H2zM14 10h4l4 4v2h-8M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
    tool: "M3 8h18v12H3zM9 8V5h6v3M3 13h18",
    ruler: "M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2",
    book: "M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-7v16h7z",
    megaphone: "M3 10v4h4l8 5V5L7 10zM18 9a4 4 0 0 1 0 6",
    image: "M3 5h18v14H3zM3 16l5-5 5 5 3-3 5 5M15 9h.01",
    copy: "M8 8h12v12H8zM4 16V4h12",
    undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
    refresh: "M20 11a8 8 0 0 0-15-3M4 4v4h4M4 13a8 8 0 0 0 15 3M20 20v-4h-4",
    play: "M7 4l13 8-13 8z",
    x: "M6 6l12 12M18 6L6 18",
    alert: "M12 3l10 18H2zM12 10v5M12 18h.01"
  };
  var MAP = {
    "➕": "plus", "📅": "cal", "🗓": "cal", "📄": "doc", "📝": "edit", "🧾": "doc", "📋": "doc",
    "👤": "user", "👥": "users", "📦": "box", "💰": "money", "💵": "money", "💳": "card",
    "💬": "chat", "🔍": "search", "🔎": "search", "⚙": "gear", "📊": "chart", "📈": "chart",
    "✉": "mail", "📧": "mail", "📞": "phone", "📍": "pin", "✅": "check", "✔": "check",
    "✏": "edit", "🗑": "trash", "🖨": "print", "🔔": "bell", "🔗": "link", "✨": "sparkle",
    "📁": "folder", "📂": "folder", "📤": "send", "📎": "clip", "📭": "inbox", "📥": "inbox",
    "👁": "eye", "🎯": "target", "🏠": "home", "🤝": "hand", "🕘": "clock", "👷": "helmet", "🧑": "user",
    "📱": "mobile", "💾": "save", "🔒": "lock", "🔑": "key", "📸": "camera", "📷": "camera", "🚚": "truck",
    "🧰": "tool", "📏": "ruler", "📐": "ruler", "📖": "book", "📣": "megaphone", "🖼": "image", "🗄": "folder",
    "⧉": "copy", "↩": "undo", "↶": "undo", "↻": "refresh", "⟳": "refresh", "▶": "play", "⚠": "alert", "✦": "sparkle",
    "✎": "edit", "✓": "check",
    // r26: the remaining emoji seen in app buttons, so every button icon comes from this one line set
    "↺": "undo", "↧": "download", "⬇": "download", "✕": "x", "✗": "x", "💲": "money", "🏛": "venue",
    "🎫": "ticket", "🛟": "lifebuoy", "🎨": "ruler", "🎙": "mic", "⏱": "clock", "🛠": "tool", "🔧": "tool",
    "🎛": "sliders", "🧩": "puzzle", "🚦": "gate"
  };
  // leading emoji (+ optional VS16) followed by whitespace or end
  var RE = /^\s*([\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u27F0-\u27FF\u2900-\u29FF\u2B00-\u2BFF]|[\uD83C-\uD83E][\uDC00-\uDFFF])️?(\s+|$)/;

  function svg(name) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "sb-ico"); s.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(NS, "path"); path.setAttribute("d", P[name]); s.appendChild(path);
    return s;
  }
  // never touch user data
  var UNSAFE = "input, textarea, select, [contenteditable], .msg, .message, .chat-msg, .bubble, .viewport, [data-no-icon]";
  // only known decorative containers
  var ICON_SEL = ".btn, button, .tab, .gs-ico, .gs-icon, .ico, .icon, .empty, .emptystate, .emptylist, .colempty, .card-ico, .tile-ico, .hss-oi, .mod .h > .ic";   /* r26: + event workspace card icons */
  // table cells are user data except for buttons inside them (row actions)
  var BTN = "button, .btn, [role=button], .hss-oi";

  function swapIcon(el) {
    if (el.__sbIco || el.closest(UNSAFE)) return;
    if (el.closest("td") && !el.matches(BTN)) return;
    // r26: an explicit icon (data-ico="ops") for buttons whose meaning has no good emoji
    var di = el.getAttribute && el.getAttribute("data-ico");
    if (di && P[di]) { el.__sbIco = 1; el.insertBefore(svg(di), el.firstChild); return; }
    var t = el.firstChild;
    if (!t || t.nodeType !== 3) return;
    var m = RE.exec(t.nodeValue);
    if (!m) return;
    var name = MAP[m[1]];
    if (!name) return;
    el.__sbIco = 1;
    var rest = t.nodeValue.slice(m[0].length);
    t.nodeValue = rest ? (el.matches(".hss-oi") ? rest : " " + rest) : "";
    el.insertBefore(svg(name), t);
  }

  var LOAD_RE = /^\s*Loading(\s+[\w ]{0,24})?\s*(…|\.\.\.)\s*$/i;
  function skel(el) {
    if (el.closest(".viewport")) return;
    var isLoading = LOAD_RE.test(el.textContent || "") && el.children.length <= 1;
    if (isLoading) {
      if (!el.classList.contains("sb-skel")) {
        el.classList.add("sb-skel");
        if (el.tagName === "TD" || el.tagName === "SPAN" || el.tagName === "P" || el.offsetHeight < 40) el.classList.add("sb-skel-sm");
        el.setAttribute("aria-busy", "true");
        // the page later replaces the text in place - drop the skeleton as soon as it isn't "Loading..." any more
        try { var mo = new MutationObserver(function () { if (!LOAD_RE.test(el.textContent || "") || el.children.length > 1) { el.classList.remove("sb-skel", "sb-skel-sm"); el.removeAttribute("aria-busy"); mo.disconnect(); } });
          mo.observe(el, { childList: true, characterData: true, subtree: true }); } catch (e) {}
      }
    } else if (el.classList.contains("sb-skel")) {
      el.classList.remove("sb-skel", "sb-skel-sm"); el.removeAttribute("aria-busy");
    }
  }
  var SKEL_SEL = ".empty, .loading, .muted, td, .card, .bpui-loading, .layoutloading, p, div";

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    try {
      if (root.matches(ICON_SEL)) swapIcon(root);
      root.querySelectorAll(ICON_SEL).forEach(swapIcon);
      var cands = [];
      if (root.matches(SKEL_SEL)) cands.push(root);
      root.querySelectorAll(".sb-skel, .empty, .loading, .muted, td, .bpui-loading, .layoutloading, p").forEach(function (e) { cands.push(e); });
      // plain divs: only leaf-ish ones whose text is exactly "Loading…"
      root.querySelectorAll("div").forEach(function (d) { if (d.children.length <= 1 && LOAD_RE.test(d.textContent || "")) cands.push(d); });
      cands.forEach(skel);
    } catch (e) { /* never break the page */ }
  }

  var queued = new Set(), raf = 0;
  function flush() {
    raf = 0;
    queued.forEach(function (n) { scan(n); });
    queued.clear();
  }
  function start() {
    scan(document.body);
    new MutationObserver(function (muts) {
      // only newly added elements are scanned (not every text change); the rail / top bar are ours and skipped
      muts.forEach(function (m) {
        m.addedNodes && m.addedNodes.forEach(function (n) {
          if (n.nodeType === 1 && !(n.closest && n.closest("#hbRail, header.hb-header, #hbTabs"))) queued.add(n);
          else if (n.nodeType === 3 && n.parentElement) queued.add(n.parentElement);
        });
      });
      if (queued.size && !raf) raf = requestAnimationFrame(flush);
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
