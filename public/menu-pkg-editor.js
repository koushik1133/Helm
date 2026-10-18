/* menu-pkg-editor.js - Control Center > Menus & catalog > Menu packages.
 *
 * Each package used to be one textarea of "Category | Dish name | veg|nonveg|special" lines.
 * Now every package shows its dishes grouped by category as removable chips, and dishes are
 * added with two dropdowns: a category (from the studio's dish catalog) and a searchable dish
 * list filtered by that category; veg / non-veg / special is filled in from the catalog.
 * Chips can be dragged (or moved with Alt+Left / Alt+Right) inside their category, and a
 * category can be moved up / down. "Paste as text" keeps the old bulk format for power users.
 *
 * Free trial (0173 lockdown, docs/trial/TRIAL-END-TO-END.md): existing packages can be changed,
 * price AND dish list; dishes can only be added from the studio's dish catalog (no new dish names),
 * and the "active" switch is fixed (a package cannot be removed). Save never sends "active" there.
 * Save sends the dish list only when it was changed, so a price-only save never rewrites the stored
 * dishes (no normalising of old data the owner did not touch).
 *
 * The data shape is unchanged: menu_templates.dishes = [{c: category, n: name, k: kind}] and
 * menu_templates.price_per_plate. Saving goes through the existing BPStore.menuTemplates.update.
 * DOM is built with createElement + textContent only (no HTML strings).
 * The pure helpers (HelmMenuPkg.core) also run in Node for the unit tests.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ pure helpers */
  var KINDS = ["veg", "nonveg", "special"];
  function clean(s, max) {
    return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max || 120);
  }
  function normKind(k) {
    var s = String(k == null ? "" : k).toLowerCase().replace(/[^a-z]/g, "");
    if (s === "nonveg" || s === "nv" || s === "meat" || s === "nonvegetarian") return "nonveg";
    if (s === "special" || s === "sp" || s === "premium") return "special";
    return "veg";
  }
  function lc(s) { return clean(s, 300).toLowerCase(); }
  // A package's price per plate. menu_templates.price_per_plate is the column; the client booklet /
  // package-flow RPCs call the same number per_person. Returns null when no usable number is there
  // (the editor then shows an empty box with a prompt, never a silent 0).
  function priceOf(t) {
    if (!t || typeof t !== "object") return null;
    var keys = ["price_per_plate", "per_person", "pricePerPlate", "price"];
    for (var i = 0; i < keys.length; i++) {
      var v = t[keys[i]];
      if (v === null || v === undefined || v === "") continue;
      var n = typeof v === "number" ? v : Number(String(v).replace(/[,\s\u20b9]/g, ""));
      if (isFinite(n) && n >= 0) return n;
    }
    return null;
  }
  function priceText(n) {
    if (n === null || n === undefined || !isFinite(n)) return "";
    return String(Math.round(n * 100) / 100);
  }
  // [{c,n,k}] from whatever is stored (also tolerates {category,name,kind}); drops blanks + duplicates
  function normDishes(arr) {
    var out = [], seen = {};
    (Array.isArray(arr) ? arr : []).forEach(function (d) {
      if (!d || typeof d !== "object") return;
      // generous caps: stored names longer than the typing limit are kept, not cut, when a package is re-saved
      var n = clean(d.n != null ? d.n : d.name, 300);
      if (!n) return;
      var c = clean(d.c != null ? d.c : d.category, 160) || "Other";
      var key = lc(c) + "\u0001" + lc(n);
      if (seen[key]) return; seen[key] = 1;
      out.push({ c: c, n: n, k: normKind(d.k != null ? d.k : d.kind) });
    });
    return out;
  }
  function toText(dishes) {
    return normDishes(dishes).map(function (d) { return d.c + " | " + d.n + " | " + d.k; }).join("\n");
  }
  // "Category | Dish | kind" per line; "Dish" alone goes to "Other"; "Category | Dish" defaults to veg
  function parseText(text) {
    var rows = String(text == null ? "" : text).split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      var p = l.split("|").map(function (s) { return clean(s); });
      if (p.length === 1) return { c: "Other", n: p[0], k: "veg" };
      return { c: p[0] || "Other", n: p[1] || "", k: p[2] || "veg" };
    });
    return normDishes(rows);
  }
  // categories in first-appearance order, each with its dishes (and their index in the flat list)
  function groups(dishes) {
    var order = [], by = {};
    dishes.forEach(function (d, i) {
      var key = lc(d.c);
      if (!by[key]) { by[key] = { c: d.c, items: [] }; order.push(by[key]); }
      by[key].items.push({ d: d, i: i });
    });
    return order;
  }
  function has(dishes, d) {
    var a = lc(d.c), b = lc(d.n);
    return dishes.some(function (x) { return lc(x.c) === a && lc(x.n) === b; });
  }
  // add after the last dish of the same category (groups stay together), else at the end
  function addDish(dishes, d) {
    var nd = normDishes([d])[0];
    if (!nd) return { ok: false, error: "empty", dishes: dishes };
    if (has(dishes, nd)) return { ok: false, error: "duplicate", dishes: dishes };
    var out = dishes.slice(), at = -1, key = lc(nd.c);
    out.forEach(function (x, i) { if (lc(x.c) === key) at = i; });
    if (at < 0) out.push(nd); else out.splice(at + 1, 0, nd);
    return { ok: true, dishes: out };
  }
  function removeAt(dishes, i) { var out = dishes.slice(); if (i >= 0 && i < out.length) out.splice(i, 1); return out; }
  // move dish `from` to sit before dish `to` (or after, when moving down); same category only
  function moveDish(dishes, from, to) {
    if (from === to || from < 0 || to < 0 || from >= dishes.length || to >= dishes.length) return dishes;
    if (lc(dishes[from].c) !== lc(dishes[to].c)) return dishes;
    var out = dishes.slice(), d = out.splice(from, 1)[0];
    out.splice(to, 0, d);
    return out;
  }
  // nudge a dish one step left / right inside its category
  function stepDish(dishes, i, dir) {
    var g = groups(dishes).filter(function (x) { return x.items.some(function (it) { return it.i === i; }); })[0];
    if (!g) return dishes;
    var pos = -1; g.items.forEach(function (it, j) { if (it.i === i) pos = j; });
    var tgt = g.items[pos + dir];
    return tgt ? moveDish(dishes, i, tgt.i) : dishes;
  }
  // move a whole category block up (-1) or down (+1)
  function moveCategory(dishes, cat, dir) {
    var gs = groups(dishes), key = lc(cat), idx = -1;
    gs.forEach(function (g, j) { if (lc(g.c) === key) idx = j; });
    var j2 = idx + dir;
    if (idx < 0 || j2 < 0 || j2 >= gs.length) return dishes;
    var tmp = gs[idx]; gs[idx] = gs[j2]; gs[j2] = tmp;
    var out = [];
    gs.forEach(function (g) { g.items.forEach(function (it) { out.push(it.d); }); });
    return out;
  }
  // catalog rows {category, name, kind, active} -> sorted category names (+ any used by the package)
  function categories(catalog, dishes) {
    var seen = {}, out = [];
    function add(c) { c = clean(c, 80); if (!c) return; var k = c.toLowerCase(); if (seen[k]) return; seen[k] = 1; out.push(c); }
    (catalog || []).forEach(function (x) { if (x && x.active !== false) add(x.category); });
    (dishes || []).forEach(function (d) { add(d.c); });
    return out.sort(function (a, b) { return a.localeCompare(b); });
  }
  function catalogFor(catalog, cat) {
    var key = lc(cat);
    return (catalog || []).filter(function (x) { return x && x.active !== false && clean(x.name) && (!key || lc(x.category) === key); })
      .slice().sort(function (a, b) { return clean(a.name).localeCompare(clean(b.name)); });
  }
  // the catalog dish a typed name means: same category first, then anywhere
  function findDish(catalog, name, cat) {
    var n = lc(name); if (!n) return null;
    var list = (catalog || []).filter(function (x) { return x && x.active !== false && lc(x.name) === n; });
    if (!list.length) return null;
    var key = lc(cat);
    return list.filter(function (x) { return key && lc(x.category) === key; })[0] || list[0];
  }
  function same(a, b) { return JSON.stringify(normDishes(a)) === JSON.stringify(normDishes(b)); }

  var core = { KINDS: KINDS, clean: clean, normKind: normKind, priceOf: priceOf, priceText: priceText, normDishes: normDishes,
    toText: toText, parseText: parseText, groups: groups, addDish: addDish, removeAt: removeAt, moveDish: moveDish, stepDish: stepDish,
    moveCategory: moveCategory, categories: categories, catalogFor: catalogFor, findDish: findDish, same: same };

  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof document === "undefined") { global.HelmMenuPkg = { core: core }; return; }

  /* ------------------------------------------------------------------ DOM */
  var doc = document, uid = 0;
  function el(tag, cls, text) { var x = doc.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; }
  function btn(cls, text, label) { var b = el("button", cls, text); b.type = "button"; if (label) b.setAttribute("aria-label", label); return b; }
  var DEF_KIND_TEXT = { veg: "Veg", nonveg: "Non-veg", special: "Special" };

  // one package card. st = {t, dishes, price, active, base}
  function card(st, ctx) {
    var t = st.t, trial = ctx.trial(), kt = ctx.kindText, nm = clean(t.name, 200) || "Package", n = ++uid;
    var box = el("div", "tpl mpk"); box.setAttribute("data-id", String(t.id));
    if (trial) box.classList.add("mpk-trialmode");

    // head: name, dish count, price, active
    var head = el("div", "mpk-head");
    var title = el("div", "mpk-title"); title.appendChild(el("strong", "mpk-name", nm));
    var count = el("span", "mpk-count"); title.appendChild(count); head.appendChild(title);
    var pl = el("label", "mpk-plabel", (ctx.symbol || "\u20b9") + "/plate"); pl.htmlFor = "mpk_price_" + n;
    var price = el("input", "tpl_price mpk-price"); price.id = "mpk_price_" + n; price.type = "number"; price.min = "0"; price.step = "1";
    price.setAttribute("inputmode", "numeric"); price.placeholder = "Set price";
    price.autocomplete = "off";                              // no browser form-state restore of a stale (blank) value
    price.setAttribute("aria-label", "Price per plate for " + nm);
    price.value = priceText(st.price);                       // set as a property: always shows the stored number
    var pw = el("div", "mpk-pwrap"); pw.appendChild(pl); pw.appendChild(price); head.appendChild(pw);
    var al = el("label", "mpk-active"); var act = el("input", "tpl_active"); act.type = "checkbox"; act.checked = !!st.active;
    al.appendChild(act); al.appendChild(doc.createTextNode(" Active")); head.appendChild(al);
    if (trial) { act.disabled = true; al.title = "Fixed in the free trial"; }
    box.appendChild(head);

    var body = el("div", "mpk-body"); box.appendChild(body);
    var live = el("div", "sr-only"); live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite"); box.appendChild(live);

    // add-dish row (free trial: catalog dishes only)
    var add = el("div", "mpk-add"), catSel, dishIn, kindSel, dl, addBtn, addMsg;
    var f1 = el("div", "mpk-fld"), l1 = el("label", null, "Category"); catSel = el("select", "mpk-cat-sel"); catSel.id = "mpk_cat_" + n; l1.htmlFor = catSel.id;
    f1.appendChild(l1); f1.appendChild(catSel);
    var f2 = el("div", "mpk-fld mpk-fld-dish"), l2 = el("label", null, "Dish"); dishIn = el("input", "mpk-dish-in"); dishIn.id = "mpk_dish_" + n; l2.htmlFor = dishIn.id;
    dishIn.type = "search"; dishIn.autocomplete = "off"; dishIn.placeholder = "Search dishes\u2026"; dishIn.maxLength = 120;
    dl = el("datalist"); dl.id = "mpk_dl_" + n; dishIn.setAttribute("list", dl.id);
    f2.appendChild(l2); f2.appendChild(dishIn); f2.appendChild(dl);
    var f3 = el("div", "mpk-fld"), l3 = el("label", null, "Type"); kindSel = el("select", "mpk-kind-sel"); kindSel.id = "mpk_kind_" + n; l3.htmlFor = kindSel.id;
    KINDS.forEach(function (k) { var o = el("option", null, kt[k] || DEF_KIND_TEXT[k]); o.value = k; kindSel.appendChild(o); });
    f3.appendChild(l3); f3.appendChild(kindSel);
    addBtn = btn("btn mpk-add-btn", "+ Add dish", "Add this dish to " + nm);
    add.appendChild(f1); add.appendChild(f2); add.appendChild(f3); add.appendChild(addBtn);
    addMsg = el("p", "mpk-addmsg"); addMsg.hidden = true;
    box.appendChild(add); box.appendChild(addMsg);

    // bulk text (not in the free trial: it could add dish names that are not in the catalog)
    var det = null, ta = null, taSynced = "";
    if (!trial) {
      det = el("details", "mpk-text");
      det.appendChild(el("summary", null, "Paste as text (bulk)"));
      var hint = el("p", "mpk-hint", "One dish per line: Category | Dish name | veg / nonveg / special. Apply replaces this package's dish list (nothing is saved until you press Save package).");
      ta = el("textarea", "tpl_dishes mpk-ta"); ta.setAttribute("aria-label", "Dishes in " + nm + ", one per line"); ta.spellcheck = false;
      var ab = btn("btn sm mpk-apply", "Apply text", "Apply the text to " + nm);
      var tb = el("div", "mpk-text-actions"); tb.appendChild(ab);
      det.appendChild(hint); det.appendChild(ta); det.appendChild(tb);
      det.addEventListener("toggle", function () { if (det.open) ta.value = taSynced = toText(st.dishes); });
      ab.addEventListener("click", function () {
        var parsed = applyText();
        say(parsed.length + " dish" + (parsed.length === 1 ? "" : "es") + " from the text. Press Save package to keep them.");
      });
      ta.addEventListener("input", paintState);
      box.appendChild(det);
    }

    var foot = el("div", "mpk-foot");
    var state = el("span", "mpk-state"); foot.appendChild(state);
    if (trial) foot.appendChild(el("span", "mpk-trial", "Free trial: change the price and the dishes (from your Dishes catalog)."));
    var save = btn("btn primary tpl_save", "Save package"); foot.appendChild(save);
    box.appendChild(foot);

    function say(msg) { live.textContent = ""; live.textContent = msg; }
    function addNote(msg, bad) { if (!addMsg) return; addMsg.textContent = msg || ""; addMsg.hidden = !msg; addMsg.classList.toggle("bad", !!bad); }
    // the bulk text box has edits that were not applied to the chips yet
    function textPending() { return !!(ta && det.open && ta.value !== taSynced); }
    function applyText() { var parsed = parseText(ta.value); st.dishes = parsed; taSynced = ta.value; draw(); return parsed; }   // draw() then rewrites the box in the saved format
    function dirty() {
      var p = price.value === "" ? null : Number(price.value);
      return textPending() || !same(st.dishes, st.base.dishes) || (p !== st.base.price && !(p === null && st.base.price === null)) || act.checked !== st.base.active;
    }
    function paintState() {
      var d = dirty(); state.textContent = d ? "Unsaved changes" : ""; box.classList.toggle("mpk-dirty", d);
      count.textContent = st.dishes.length + " dish" + (st.dishes.length === 1 ? "" : "es");
    }

    function fillCats(keep) {
      if (!catSel) return;
      var cur = keep != null ? keep : catSel.value, cats = categories(ctx.catalog(), st.dishes);
      catSel.textContent = "";
      var all = el("option", null, "All categories"); all.value = ""; catSel.appendChild(all);
      cats.forEach(function (c) { var o = el("option", null, c); o.value = c; catSel.appendChild(o); });
      catSel.value = cats.some(function (c) { return c === cur; }) ? cur : "";
    }
    function fillDishes() {
      if (!dl) return;
      dl.textContent = "";
      catalogFor(ctx.catalog(), catSel.value).forEach(function (x) {
        if (has(st.dishes, { c: x.category, n: x.name })) return;           // already in this package
        var o = el("option"); o.value = clean(x.name); o.label = clean(x.category, 80) + " \u00b7 " + (kt[normKind(x.kind)] || DEF_KIND_TEXT[normKind(x.kind)]);
        dl.appendChild(o);
      });
    }
    function syncKind() {
      var m = findDish(ctx.catalog(), dishIn.value, catSel.value);
      if (m) { kindSel.value = normKind(m.kind); kindSel.disabled = true; kindSel.title = "From your dish catalog"; }
      else { kindSel.disabled = false; kindSel.title = ""; }
    }
    function doAdd() {
      var name = clean(dishIn.value);
      if (!name) { addNote("Pick or type a dish first.", true); dishIn.focus(); return; }
      var m = findDish(ctx.catalog(), name, catSel.value), d;
      if (m) d = { c: clean(m.category, 80) || "Other", n: clean(m.name), k: normKind(m.kind) };
      else {
        if (trial) { addNote("In the free trial you can add dishes from your Dishes catalog only. Pick one from the list.", true); dishIn.focus(); return; }
        if (!catSel.value) { addNote("\u201c" + name + "\u201d is not in your dish catalog. Choose a category for it first.", true); catSel.focus(); return; }
        d = { c: catSel.value, n: name, k: normKind(kindSel.value) };
      }
      var r = addDish(st.dishes, d);
      if (!r.ok) { addNote(r.error === "duplicate" ? "\u201c" + d.n + "\u201d is already in this package." : "Pick a dish first.", true); return; }
      st.dishes = r.dishes; dishIn.value = ""; syncKind();
      addNote(m ? "" : "Added \u201c" + d.n + "\u201d (not in your dish catalog; add it under Dishes catalog to reuse it).", false);
      draw(); say("Added " + d.n + " to " + d.c + ".");
      try { dishIn.focus(); } catch (e) {}
    }

    var dragFrom = -1;
    function chip(d, i) {
      var c = el("span", "mpk-chip k-" + d.k);
      c.setAttribute("data-i", String(i));
      c.appendChild(el("i", "mpk-dot"));
      var lab = el("span", "mpk-chip-n", d.n); c.appendChild(lab);
      c.title = d.n + " \u00b7 " + (kt[d.k] || DEF_KIND_TEXT[d.k]);
      c.tabIndex = 0; c.draggable = true;
      c.setAttribute("aria-label", d.n + ", " + (kt[d.k] || DEF_KIND_TEXT[d.k]) + ". Alt+Left or Alt+Right to move, Delete to remove.");
      var x = btn("mpk-x", "\u00d7", "Remove " + d.n + " from " + nm); x.tabIndex = -1;
      x.addEventListener("click", function () { st.dishes = removeAt(st.dishes, i); draw(); say("Removed " + d.n + "."); });
      c.appendChild(x);
      c.addEventListener("keydown", function (e) {
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); st.dishes = removeAt(st.dishes, i); draw(); say("Removed " + d.n + "."); focusChip(Math.min(i, st.dishes.length - 1)); return; }
        if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault(); var before = st.dishes; st.dishes = stepDish(st.dishes, i, e.key === "ArrowLeft" ? -1 : 1);
          if (st.dishes !== before) { draw(); var ni = st.dishes.indexOf(d); focusChip(ni); say("Moved " + d.n + "."); }
        }
      });
      c.addEventListener("dragstart", function (e) { dragFrom = i; c.classList.add("dragging"); try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", d.n); } catch (x2) {} });
      c.addEventListener("dragend", function () { dragFrom = -1; c.classList.remove("dragging"); });
      c.addEventListener("dragover", function (e) { if (dragFrom < 0 || dragFrom === i || !st.dishes[dragFrom] || st.dishes[dragFrom].c.toLowerCase() !== d.c.toLowerCase()) return; e.preventDefault(); c.classList.add("over"); });
      c.addEventListener("dragleave", function () { c.classList.remove("over"); });
      c.addEventListener("drop", function (e) { e.preventDefault(); c.classList.remove("over"); if (dragFrom < 0) return; var moved = st.dishes[dragFrom]; st.dishes = moveDish(st.dishes, dragFrom, i); dragFrom = -1; draw(); if (moved) say("Moved " + moved.n + "."); });
      return c;
    }
    function focusChip(i) { if (i < 0) return; var c = body.querySelector('.mpk-chip[data-i="' + i + '"]'); if (c) try { c.focus(); } catch (e) {} }

    function draw() {
      body.textContent = "";
      var gs = groups(st.dishes);
      if (!gs.length) body.appendChild(el("p", "mpk-empty", "No dishes yet. Pick a category and a dish below to add one."));
      gs.forEach(function (g, gi) {
        var sec = el("div", "mpk-cat"), h = el("div", "mpk-cat-h");
        h.appendChild(el("span", "mpk-cat-n", g.c)); h.appendChild(el("span", "mpk-cat-c", String(g.items.length)));
        if (gs.length > 1) {
          var up = btn("mpk-mv", "\u2191", "Move " + g.c + " up"), dn = btn("mpk-mv", "\u2193", "Move " + g.c + " down");
          up.disabled = gi === 0; dn.disabled = gi === gs.length - 1;
          up.addEventListener("click", function () { st.dishes = moveCategory(st.dishes, g.c, -1); draw(); say(g.c + " moved up."); });
          dn.addEventListener("click", function () { st.dishes = moveCategory(st.dishes, g.c, 1); draw(); say(g.c + " moved down."); });
          var mv = el("span", "mpk-mvs"); mv.appendChild(up); mv.appendChild(dn); h.appendChild(mv);
        }
        sec.appendChild(h);
        var chips = el("div", "mpk-chips"); g.items.forEach(function (it) { chips.appendChild(chip(it.d, it.i)); });
        sec.appendChild(chips); body.appendChild(sec);
      });
      // keep the bulk text in step with the chips, unless the owner is typing there (never overwrite that)
      if (ta && (!det.open || ta.value === taSynced)) ta.value = taSynced = toText(st.dishes);
      fillCats(); fillDishes(); paintState();
    }

    if (catSel) {
      catSel.addEventListener("change", function () { fillDishes(); syncKind(); addNote(""); });
      dishIn.addEventListener("input", function () { syncKind(); addNote(""); });
      dishIn.addEventListener("change", syncKind);
      dishIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
      addBtn.addEventListener("click", doAdd);
    }
    price.addEventListener("input", paintState); act.addEventListener("change", paintState);

    save.addEventListener("click", function () {
      if (textPending()) applyText();                         // pasted text that was not applied yet is saved, not lost
      var raw = String(price.value).trim(), V = global.BPStore && global.BPStore.validate, pp;
      if (raw === "") { ctx.error("Enter the price per plate for " + nm + "."); try { price.focus(); } catch (e) {} return; }
      if (V && V.money) { var r = V.money(raw, { field: "Price / plate" }); if (!r.ok) { ctx.error(r.error); return; } pp = r.value; }
      else { pp = Number(raw); if (!isFinite(pp) || pp < 0) { ctx.error("Enter a price of 0 or more."); return; } }
      // dishes only when changed (a price-only save never rewrites the stored list); free trial: never the switch
      var patch = { price_per_plate: pp };
      if (!same(st.dishes, st.base.dishes)) patch.dishes = normDishes(st.dishes);
      if (!ctx.trial() && act.checked !== st.base.active) patch.active = !!act.checked;
      var run = function () {
        return Promise.resolve(ctx.save(t, patch)).then(function (ok) {
          if (ok === false) return;
          t.price_per_plate = pp; st.price = pp;
          if (patch.dishes) { t.dishes = patch.dishes; st.dishes = patch.dishes.slice(); }
          if ("active" in patch) { t.active = patch.active; st.active = patch.active; }
          st.base = { dishes: st.dishes.slice(), price: pp, active: "active" in patch ? patch.active : st.base.active };
          price.value = priceText(pp); paintState();
        });
      };
      if (global.BPUI && global.BPUI.guard) global.BPUI.guard(save, run); else { save.disabled = true; run().then(function () { save.disabled = false; }, function () { save.disabled = false; }); }
    });

    if (catSel) fillCats("");
    draw();
    box.__mpkRefresh = function () { if (catSel) { fillCats(); fillDishes(); syncKind(); } };
    return box;
  }

  /* render(host, {packages, catalog, trial(): bool, kindText, symbol, save(pkg, patch) -> Promise, error(msg)}) */
  function render(host, opts) {
    if (!host) return null;
    var o = opts || {}, catalog = Array.isArray(o.catalog) ? o.catalog : [];
    var ctx = {
      catalog: function () { return catalog; },
      trial: typeof o.trial === "function" ? o.trial : function () { return !!o.trial; },
      kindText: o.kindText || DEF_KIND_TEXT, symbol: o.symbol || "\u20b9",
      save: o.save || function () { return Promise.resolve(true); },
      error: o.error || function () {}
    };
    var states = (o.packages || []).map(function (t) {
      var dishes = normDishes(t.dishes), price = priceOf(t), active = t.active !== false;
      return { t: t, dishes: dishes, price: price, active: active, base: { dishes: dishes.slice(), price: price, active: active } };
    });
    host.textContent = "";
    if (ctx.trial()) host.appendChild(el("p", "mpk-trialnote", "Free trial: you can change each package's price and dishes. Dishes come from your Dishes catalog; new dishes and packages need an upgrade."));
    var cards = states.map(function (st) { var c = card(st, ctx); host.appendChild(c); return c; });
    return {
      setCatalog: function (list) { catalog = Array.isArray(list) ? list : []; cards.forEach(function (c) { if (c.__mpkRefresh) c.__mpkRefresh(); }); },
      dirty: function () { return cards.some(function (c) { return c.classList.contains("mpk-dirty"); }); }
    };
  }

  global.HelmMenuPkg = { core: core, render: render };
})(typeof window !== "undefined" ? window : globalThis);
