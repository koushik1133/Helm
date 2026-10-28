/* =========================================================================
   HELM - after a free trial upgrades: what happens to the data (0185)
   -------------------------------------------------------------------------
   * The choice (studio admin, once, after the plan is active; my_upgrade_status().pending):
       Keep the sample data      (default) sample rows stay, tagged "Sample"
       Remove the sample data    only the sample rows go (is_demo); own records stay
       Start completely clean    sample rows go + every own record is ARCHIVED (never
                                 deleted). Asked twice: a confirm, then the typed phrase
                                 START CLEAN (the server checks the phrase too).
     Shown on the checkout page right after a verified payment (offer()), on the
     dashboard ([data-tu-auto]) and in Settings ([data-tu-control]) until made.
   * Settings after upgrading: "Delete all sample data" (delete_all_sample_data:
     is_demo rows only) and "Restore archived records" (restore_clean_start).
   * "Sample" badge: on any signed-in studio page of a studio that still has sample
     rows, text that starts with the sample prefix "Demo · " gets a Sample badge.
     The text itself is kept (the prefix is only visually hidden), so copy, search,
     sorting and printing see exactly what they saw before; print shows the old text.
   * CSP: DOM built with createElement/textContent only; runtime CSS via __helmAdoptCss.
   ========================================================================= */
(function (global) {
  "use strict";
  if (global.HelmTrialUpgrade) return;
  const doc = global.document;
  const PHRASE = "START CLEAN";
  const PREFIX = "Demo · ";
  const CSS = [
    ".tu{border:1px solid var(--line,#e5e7eb);background:var(--panel,#fff);border-radius:14px;padding:18px;margin:14px 0}",
    ".tu h3{margin:0 0 4px;font-size:17px}.tu p{margin:0 0 10px;color:var(--ink-2,#3f4a45);font-size:14px;line-height:1.5}",
    ".tu-tag{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent,#0f7a43);background:var(--accent-soft,#e7f6ee);border-radius:999px;padding:2px 8px;margin-bottom:6px}",
    ".tu-opts{display:grid;gap:10px;margin:12px 0;border:0;padding:0}",
    ".tu-opt{position:relative;display:flex;gap:12px;align-items:flex-start;padding:14px;border-radius:12px;border:1.5px solid var(--line,#e5e7eb);background:var(--panel-2,#f8faf9);cursor:pointer}",
    ".tu-opt:hover{border-color:var(--line-strong,#a3aba7)}",
    ".tu-opt.on{border-color:var(--accent,#0f7a43);box-shadow:0 0 0 3px var(--accent-soft,#e7f6ee)}",
    ".tu-opt.off{opacity:.55;cursor:not-allowed}",
    ".tu-opt input{margin:3px 0 0;width:18px;height:18px;flex:0 0 auto;accent-color:var(--accent,#0f7a43)}",
    ".tu-opt b{display:block;font-size:15px;margin-bottom:2px}.tu-opt span{display:block;font-size:13px;line-height:1.45;color:var(--ink-2,#3f4a45)}",
    ".tu-opt .tu-def{display:inline-block;margin-left:6px;font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--accent,#0f7a43)}",
    ".tu-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}",
    ".tu-msg{font-size:13px;color:var(--ink-2,#3f4a45);margin:8px 0 0;min-height:1em}",
    ".tu-sec+.tu-sec{margin-top:16px;padding-top:16px;border-top:1px solid var(--line,#e5e7eb)}",
    ".tu-list{margin:0 0 12px;padding-left:20px;font-size:14px}.tu-list li{margin:2px 0}",
    ".tu-dlg{border:1px solid var(--line,#e5e7eb);border-radius:14px;padding:20px;max-width:460px;width:calc(100vw - 32px);background:var(--panel,#fff);color:var(--ink,#111c17)}",
    ".tu-dlg::backdrop{background:rgba(17,28,23,.45)}.tu-dlg h3{margin:0 0 6px;font-size:17px}.tu-dlg p{margin:0 0 12px;font-size:14px;line-height:1.5;color:var(--ink-2,#3f4a45)}",
    ".tu-dlg .tu-row{justify-content:flex-end;margin-top:6px}",
    ".tu-dlg label{display:block;font-size:13px;font-weight:600;margin:0 0 4px}",
    ".tu-dlg input{width:100%;min-height:42px;padding:0 10px;border:1px solid var(--line-strong,#a3aba7);border-radius:9px;font:inherit;letter-spacing:.06em;background:var(--panel,#fff);color:inherit}",
    ".tu-safe{font-weight:600}.tu-err{color:var(--danger,#b42318);font-size:13px;margin:8px 0 0}",
    ".tu .danger,.tu-dlg .danger{background:var(--danger,#b42318);border-color:var(--danger,#b42318);color:#fff}",
    ".tu-busy{opacity:.7;cursor:progress}",
    // the Sample badge (text kept: the prefix is visually hidden, read by nobody, printed as before)
    ".hs-tag{position:relative;display:inline-block;vertical-align:baseline;margin-right:6px;padding:0 7px;border-radius:999px;font-size:10.5px;font-weight:700;letter-spacing:.04em;line-height:17px;text-transform:uppercase;color:var(--accent,#0f7a43);background:var(--accent-soft,#e7f6ee);white-space:nowrap;text-decoration:none}",
    ".hs-tag::before{content:\"Sample\"}.hs-tag.hs-solo::before{content:none}.hs-tag.hs-solo{margin:0 0 0 6px}",
    ".hs-pfx{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}",
    "@media print{.hs-tag{all:unset}.hs-tag::before{content:none}.hs-pfx{position:static;width:auto;height:auto;margin:0;overflow:visible;clip:auto;clip-path:none}.hs-solo{display:none}}",
  ].join("\n");
  let cssDone = false;
  function css() { if (cssDone || !doc) return; cssDone = true; if (typeof global.__helmAdoptCss === "function") global.__helmAdoptCss(doc, CSS); }
  function el(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function btn(label, cls, onClick) { const b = el("button", cls || "btn", label); b.type = "button"; if (onClick) b.addEventListener("click", onClick); return b; }
  const S = () => global.BPStore;
  function toast(m, type) { try { if (global.BPUI && typeof global.BPUI.toast === "function") global.BPUI.toast(m, { type: type || "ok" }); } catch (e) {} }
  function errMsg(e, action) {
    try { if (global.BPUI && typeof global.BPUI.friendlyError === "function") { const m = global.BPUI.friendlyError(e, { action: action }); if (m) return String(m); } } catch (x) {}
    return (e && e.message) || "Couldn't " + action + " - please try again.";
  }
  function busy(b, label) {
    if (!b) return () => {};
    const prev = b.textContent; b.disabled = true; b.setAttribute("aria-busy", "true"); b.classList.add("tu-busy"); if (label) b.textContent = label;
    return () => { b.disabled = false; b.removeAttribute("aria-busy"); b.classList.remove("tu-busy"); b.textContent = prev; };
  }

  /* ---- pure model (exported for tests) ------------------------------------------------------ */
  const CHOICES = [
    { id: "keep", title: "Keep the sample data", def: true,
      body: "Sample records stay in your studio next to your own, tagged “Sample”. You can delete them any time in Settings." },
    { id: "remove_sample", title: "Remove the sample data",
      body: "Only the sample records go. Everything you added yourself stays exactly as it is." },
    { id: "clean", title: "Start completely clean",
      body: "The sample records go, and every record of your own (events, leads, inventory, vendors, staff, venues, menus, layouts, follow-ups) is archived, not deleted, so your lists start empty. Settings, team, plan and templates stay. You can restore the archive in Settings." },
  ];
  // the 3 options for a status (remove_sample needs sample rows; keep is always the default)
  function options(st) {
    const hasSample = !!(st && st.has_sample === true);
    return CHOICES.map((c) => ({ id: c.id, title: c.title, body: c.body, def: !!c.def,
      disabled: c.id === "remove_sample" && !hasSample, checked: c.id === "keep" }));
  }
  function phraseOk(v) { return String(v == null ? "" : v).trim().replace(/\s+/g, " ").toUpperCase() === PHRASE; }
  // which card: 'choose' (admin, plan active, not chosen yet) | 'manage' (Settings after upgrading) | null
  function cardView(st, place) {
    if (!st || typeof st !== "object" || st.is_admin !== true) return null;
    if (st.pending === true) return "choose";
    if (place === "control" && st.in_trial !== true && (st.has_sample === true || st.can_restore === true)) return "manage";
    return null;
  }
  const LABELS = [["events", "event", "events"], ["leads", "lead", "leads"], ["staff", "staff member", "staff members"],
    ["vendors", "vendor", "vendors"], ["inventory", "inventory item", "inventory items"], ["venues", "venue", "venues"],
    ["packages", "menu package", "menu packages"], ["dishes", "dish", "dishes"], ["layouts", "floor layout", "floor layouts"],
    ["nurture", "follow-up contact", "follow-up contacts"]];
  function countLines(c, word) {
    if (!c || typeof c !== "object") return [];
    const out = [];
    LABELS.forEach((x) => { const n = Math.floor(Number(c[x[0]])); if (isFinite(n) && n > 0) out.push(n + " " + (word ? word + " " : "") + (n === 1 ? x[1] : x[2])); });
    return out;
  }
  function resultText(choice, r) {
    const kept = r && Number(r.kept_in_use) > 0 ? " " + Number(r.kept_in_use) + (Number(r.kept_in_use) === 1 ? " sample event was" : " sample events were") + " kept as yours because it has your own payments, approval or files." : "";
    if (r && r.result === "already") return "This choice was already made for your studio.";
    if (choice === "keep") return "Sample data kept. It stays tagged “Sample”; delete it any time in Settings.";
    if (choice === "remove_sample") return "Sample data removed. Your own records are untouched." + kept;
    if (choice === "clean") return "Your studio starts clean. Your own records are archived, not deleted - restore them in Settings." + kept;
    return "Done.";
  }
  // the text node starts with the sample prefix (leading spaces allowed)
  function sampleText(s) { return typeof s === "string" && /^\s*Demo · /.test(s); }

  /* ---- status ---------------------------------------------------------------------------------- */
  async function status() {
    const st = S(); if (!st || !st.upgrade || typeof st.upgrade.status !== "function") return null;
    try { if (st.init) await st.init(); } catch (e) {}
    try { return await st.upgrade.status(); } catch (e) { return null; }
  }

  /* ---- dialogs ------------------------------------------------------------------------------------ */
  function dialog(build) {
    return new Promise((resolve) => {
      css();
      const dlg = el("dialog", "tu-dlg"); let done = false;
      const close = (v) => { if (done) return; done = true; try { dlg.close(); } catch (e) {} dlg.remove(); resolve(v); };
      build(dlg, close);
      dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); close(false); });
      doc.body.appendChild(dlg);
      try { dlg.showModal(); } catch (e) { dlg.setAttribute("open", ""); }
    });
  }
  function confirmBox(title, lines, safe, okLabel, danger) {
    return dialog((dlg, close) => {
      const h = el("h3", null, title); h.id = "tuDlgT" + Date.now(); dlg.setAttribute("aria-labelledby", h.id); dlg.appendChild(h);
      (lines.p || []).forEach((t) => dlg.appendChild(el("p", null, t)));
      if (lines.list && lines.list.length) { const ul = el("ul", "tu-list"); lines.list.forEach((t) => ul.appendChild(el("li", null, t))); dlg.appendChild(ul); }
      (lines.after || []).forEach((t) => dlg.appendChild(el("p", null, t)));
      if (safe) dlg.appendChild(el("p", "tu-safe", safe));
      const row = el("div", "tu-row");
      const no = btn("Cancel", "btn", () => close(false)); row.appendChild(no);
      row.appendChild(btn(okLabel, "btn primary" + (danger ? " danger" : ""), () => close(true)));
      dlg.appendChild(row); setTimeout(() => { try { no.focus(); } catch (e) {} }, 0);
    });
  }
  // 2nd confirmation for "Start completely clean": type START CLEAN
  function phraseBox() {
    return dialog((dlg, close) => {
      const h = el("h3", null, "Type START CLEAN to confirm"); h.id = "tuPhraseT"; dlg.setAttribute("aria-labelledby", h.id); dlg.appendChild(h);
      dlg.appendChild(el("p", null, "This is the second check. Your own records will be archived (not deleted) and the sample records removed."));
      const l = el("label", null, "Confirmation"); l.htmlFor = "tuPhrase"; dlg.appendChild(l);
      const i = el("input"); i.id = "tuPhrase"; i.type = "text"; i.autocomplete = "off"; i.spellcheck = false; i.placeholder = PHRASE; i.maxLength = 40;
      dlg.appendChild(i);
      const row = el("div", "tu-row");
      row.appendChild(btn("Cancel", "btn", () => close(null)));
      const go = btn("Start completely clean", "btn primary danger", () => { if (phraseOk(i.value)) close(PHRASE); });
      go.disabled = true; row.appendChild(go);
      i.addEventListener("input", () => { go.disabled = !phraseOk(i.value); });
      i.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && phraseOk(i.value)) { ev.preventDefault(); close(PHRASE); } });
      dlg.appendChild(row); setTimeout(() => { try { i.focus(); } catch (e) {} }, 0);
    });
  }
  // confirm twice for clean, once for remove_sample, never for keep -> the phrase (or "") / null = cancelled
  async function confirmChoice(choice, st) {
    if (choice === "keep") return "";
    if (choice === "remove_sample") {
      const ok = await confirmBox("Remove the sample data?", { p: ["This removes only the sample records:"], list: countLines(st && st.sample, "sample") },
        "Everything you added yourself stays exactly as it is. A sample event you recorded your own payments or files on is kept as yours.",
        "Remove sample data", true);
      return ok ? "" : null;
    }
    const own = countLines(st && st.own);
    const ok = await confirmBox("Start completely clean?", {
      p: [own.length ? "These records of your own are archived, so your lists start empty:" : "Your lists start empty."],
      list: own, after: st && st.has_sample ? ["All " + st.sample_total + " sample records are removed."] : [] },
      "Nothing of yours is deleted: it is archived and can be restored from Settings.", "Continue", true);
    if (!ok) return null;
    return await phraseBox();
  }

  /* ---- the choice card --------------------------------------------------------------------------- */
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function renderChoice(host, st, o) {
    o = o || {};
    css(); clear(host); host.hidden = false; host.classList.add("tu");
    host.appendChild(el("span", "tu-tag", "Your plan is active"));
    const h = el("h3", null, "What should happen to your trial data?"); h.id = "tuH_" + (o.place || "x"); host.appendChild(h);
    host.appendChild(el("p", null, st.has_sample ? "Your trial studio has " + st.sample_total + " sample records. Choose once — keeping them is the default."
      : "Choose once — keeping everything is the default."));
    const fs = el("fieldset", "tu-opts"); fs.setAttribute("aria-labelledby", h.id);
    let pick = "keep";
    const labels = [];
    options(st).forEach((c) => {
      const lab = el("label", "tu-opt" + (c.checked ? " on" : "") + (c.disabled ? " off" : ""));
      const inp = el("input"); inp.type = "radio"; inp.name = "tuChoice_" + (o.place || "x"); inp.value = c.id; inp.checked = c.checked; inp.disabled = c.disabled;
      inp.addEventListener("change", () => { if (inp.checked) { pick = c.id; labels.forEach((x) => x.classList.toggle("on", x === lab)); } });
      lab.appendChild(inp);
      const tx = el("div"); const b = el("b", null, c.title); if (c.def) b.appendChild(el("span", "tu-def", "Default")); tx.appendChild(b);
      tx.appendChild(el("span", null, c.disabled ? "No sample records are left in your studio." : c.body));
      lab.appendChild(tx); labels.push(lab); fs.appendChild(lab);
    });
    host.appendChild(fs);
    const row = el("div", "tu-row"); const msg = el("p", "tu-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    const go = btn("Continue", "btn primary", async () => {
      if (go.disabled) return;
      const phrase = await confirmChoice(pick, st);
      if (phrase === null) return;
      const done = busy(go, pick === "keep" ? "Saving…" : pick === "clean" ? "Archiving…" : "Removing…");
      msg.textContent = "";
      let r;
      try { r = await S().upgrade.choose(pick, phrase || null); }
      catch (e) { done(); msg.textContent = errMsg(e, "save your choice"); return; }
      const t = resultText(pick, r); msg.textContent = t; toast(t);
      if (typeof o.onDone === "function") o.onDone(pick, r); else setTimeout(() => { try { global.location.reload(); } catch (e) {} }, 900);
    });
    row.appendChild(go); host.appendChild(row); host.appendChild(msg);
  }

  /* ---- Settings after upgrading: delete sample data / restore archive -------------------- */
  function renderManage(host, st) {
    css(); clear(host); host.hidden = false; host.classList.add("tu");
    if (st.has_sample) {
      const sec = el("div", "tu-sec");
      sec.appendChild(el("h3", null, "Sample data"));
      sec.appendChild(el("p", null, st.sample_total + " sample records are still in your studio, each tagged “Sample”. Your own records are never touched by this."));
      const del = btn("Delete all sample data", "btn danger", async () => {
        const ok = await confirmBox("Delete all sample data?", { p: ["This deletes only the records tagged “Sample”:"], list: countLines(st.sample, "sample") },
          "Anything you added yourself is never touched. A sample event with your own payments, approval or files is kept as yours, and a sample item one of your events uses is switched off instead.",
          "Delete all sample data", true);
        if (!ok) return;
        const done = busy(del, "Deleting…");
        try { const r = await S().upgrade.deleteSample(); toast("Sample data deleted. Your own records are untouched." + (r && Number(r.kept_in_use) > 0 ? " " + Number(r.kept_in_use) + " used sample event(s) kept as yours." : "")); }
        catch (e) { done(); toast(errMsg(e, "delete the sample data"), "err"); return; }
        setTimeout(() => { try { global.location.reload(); } catch (e) {} }, 700);
      });
      sec.appendChild(el("div", "tu-row")).appendChild(del);
      host.appendChild(sec);
    }
    if (st.can_restore) {
      const sec = el("div", "tu-sec");
      sec.appendChild(el("h3", null, "Archived records"));
      sec.appendChild(el("p", null, st.archived + " records were archived when you started clean. Restore puts them all back in your lists."));
      const rs = btn("Restore archived records", "btn", async () => {
        const ok = await confirmBox("Restore archived records?", { p: ["All " + st.archived + " archived records come back into your lists. Records you added since stay as they are."] }, null, "Restore", false);
        if (!ok) return;
        const done = busy(rs, "Restoring…");
        try { const r = await S().upgrade.restore(); toast("Restored " + Number((r && r.restored) || 0) + " records." + (r && Number(r.skipped) > 0 ? " " + Number(r.skipped) + " stayed archived because a newer record has the same name." : "")); }
        catch (e) { done(); toast(errMsg(e, "restore the archived records"), "err"); return; }
        setTimeout(() => { try { global.location.reload(); } catch (e) {} }, 700);
      });
      sec.appendChild(el("div", "tu-row")).appendChild(rs);
      host.appendChild(sec);
    }
  }
  function hide(host) { if (host) { clear(host); host.hidden = true; } }

  /* ---- checkout: right after a verified payment ---------------------------------------------------
     The plan may turn active a moment after the payment is verified: ask a few times. Resolves true
     when the choice card is shown (o.onDone runs after the choice), false when there is nothing to
     choose (the normal redirect runs; the dashboard asks later if the plan is not active yet). */
  async function offer(host, o) {
    if (!host) return false;
    let st = null;
    for (let i = 0; i < 6; i++) {
      st = await status();
      if (st && (st.pending === true || st.converted === true || st.was_trial !== true)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (cardView(st, "checkout") !== "choose") return false;
    if (o && typeof o.before === "function") { try { o.before(); } catch (e) {} }
    renderChoice(host, st, { place: "checkout", onDone: o && o.onDone });
    try { host.scrollIntoView({ block: "center" }); const f = host.querySelector("input:checked"); if (f) f.focus(); } catch (e) {}
    return true;
  }
  // trial-demo.js "Set up your studio" after upgrading: open this flow instead of the trial one
  async function takeOver() {
    const st = await status();
    if (!st || st.in_trial === true || st.is_admin !== true) return false;
    if (st.pending === true) {
      const dash = doc.querySelector("[data-tu-auto]");
      if (dash && !dash.hidden) { try { dash.scrollIntoView({ block: "center" }); const f = dash.querySelector("input:checked"); if (f) f.focus(); } catch (e) {} return true; }
      global.location.assign("dashboard.html"); return true;
    }
    if (st.has_sample === true || st.can_restore === true) { global.location.assign("control.html#tuControl"); return true; }
    return false;
  }

  /* ---- "Sample" badge --------------------------------------------------------------------------- */
  const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, OPTION: 1, OPTGROUP: 1, SELECT: 1, INPUT: 1, TITLE: 1, NOSCRIPT: 1, TEMPLATE: 1, CODE: 1, PRE: 1 };
  function tagNode(node) {
    const v = node.nodeValue;
    if (!v || v.indexOf(PREFIX) < 0) return false;
    const m = /^(\s*)Demo · /.exec(v); if (!m) return false;
    const p = node.parentNode;
    if (!p || p.nodeType !== 1 || SKIP[p.nodeName]) return false;
    if (p.closest && p.closest("svg,[contenteditable],.hs-tag,[data-no-sample-tag]")) return false;
    const tag = doc.createElement("span"); tag.className = "hs-tag";
    const pfx = doc.createElement("span"); pfx.className = "hs-pfx"; pfx.setAttribute("aria-hidden", "true"); pfx.textContent = PREFIX;
    tag.appendChild(pfx);
    if (m[1]) p.insertBefore(doc.createTextNode(m[1]), node);
    p.insertBefore(tag, node);
    node.nodeValue = v.slice(m[0].length);       // textContent of the parent is unchanged
    return true;
  }
  function tagTree(root) {
    if (!root) return 0;
    if (root.nodeType === 3) return tagNode(root) ? 1 : 0;
    if (root.nodeType !== 1 && root.nodeType !== 11) return 0;
    if (root.nodeType === 1 && (SKIP[root.nodeName] || root.nodeName === "svg")) return 0;
    let n = 0; const list = [];
    const w = doc.createTreeWalker(root, 4, null);
    for (let t = w.nextNode(); t; t = w.nextNode()) if (t.nodeValue && t.nodeValue.indexOf(PREFIX) >= 0) list.push(t);
    list.forEach((t) => { if (tagNode(t)) n++; });
    return n;
  }
  let badgesOn = false;
  async function startBadges() {
    if (badgesOn || !doc || !doc.body || typeof MutationObserver === "undefined") return;
    const st = S(); if (!st || !st.demo || typeof st.demo.status !== "function") return;
    let d = null;
    try { if (st.init) await st.init(); d = await st.demo.status(); } catch (e) { return; }
    if (!d || d.has_demo !== true || badgesOn) return;
    badgesOn = true; css();
    tagTree(doc.body);
    let queue = [], timer = 0;
    const flush = () => { timer = 0; const q = queue; queue = []; q.forEach((n) => { try { if (n.isConnected !== false) tagTree(n); } catch (e) {} }); };
    new MutationObserver((muts) => {
      for (const mu of muts) {
        if (mu.type === "characterData") { if (sampleText(mu.target.nodeValue)) queue.push(mu.target); continue; }
        for (const n of mu.addedNodes) if (n.nodeType === 3 ? sampleText(n.nodeValue) : (n.nodeType === 1 && n.textContent && n.textContent.indexOf(PREFIX) >= 0)) queue.push(n);
      }
      if (queue.length && !timer) timer = setTimeout(flush, 40);
    }).observe(doc.body, { childList: true, subtree: true, characterData: true });
  }

  /* ---- mount ------------------------------------------------------------------------------------- */
  async function mount() {
    css();                     // the Sample badge style is also used by pages (packages / dishes in Settings)
    startBadges();
    const dash = doc.querySelector("[data-tu-auto]"), ctl = doc.querySelector("[data-tu-control]");
    if (!dash && !ctl) return;
    const st = await status();
    if (dash) { if (cardView(st, "dashboard") === "choose") renderChoice(dash, st, { place: "dashboard" }); else hide(dash); }
    if (ctl) {
      const v = cardView(st, "control");
      if (v === "choose") renderChoice(ctl, st, { place: "control" }); else if (v === "manage") renderManage(ctl, st); else hide(ctl);
    }
  }

  global.HelmTrialUpgrade = { options: options, phraseOk: phraseOk, cardView: cardView, countLines: countLines, resultText: resultText,
    sampleText: sampleText, tagTree: tagTree, offer: offer, takeOver: takeOver, mount: mount, PHRASE: PHRASE };
  if (doc) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount); else mount(); }
})(typeof window !== "undefined" ? window : globalThis);
