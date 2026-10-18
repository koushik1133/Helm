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
  // emoji / pictographs / flags / skin tones / joiners: removed from typed dish names (they break
  // search, printing and the kitchen sheet); the line is kept and the summary says so
  var EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;
  function stripEmoji(s) { return String(s == null ? "" : s).replace(EMOJI, ""); }
  // a typed type word -> veg / nonveg / special, or null when it is not one of them
  function strictKind(k) {
    var s = String(k == null ? "" : k).toLowerCase().replace(/[^a-z]/g, "");
    if (s === "veg" || s === "v" || s === "vegetarian") return "veg";
    if (s === "nonveg" || s === "nv" || s === "meat" || s === "nonvegetarian") return "nonveg";
    if (s === "special" || s === "sp" || s === "premium") return "special";
    return null;
  }
  var NAME_MAX = 120, CAT_MAX = 80, DISH_MAX = 500, PRICE_MAX = 100000;
  var FORMAT = "Use: Category | Dish name | veg / nonveg / special";
  // Bulk text -> {dishes, errors: [{line, text, error}], blank, dupes: [line], emoji: [line]}.
  // "Dish" alone goes to "Other"; "Category | Dish" defaults to veg. Blank lines are skipped, spaces
  // trimmed, repeats dropped, emoji removed (all listed in the summary); anything else that is wrong
  // is a line error and nothing is applied until it is fixed.
  function parseTextReport(text) {
    var out = { dishes: [], errors: [], blank: 0, dupes: [], emoji: [] }, seen = {};
    String(text == null ? "" : text).split(/\r\n|\r|\n/).forEach(function (raw, i) {
      var no = i + 1, line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
      if (!line) { out.blank++; return; }
      var bad = function (msg) { out.errors.push({ line: no, text: line.slice(0, 160), error: msg }); };
      var noEmoji = stripEmoji(line);
      if (noEmoji !== line) out.emoji.push(no);
      var p = noEmoji.split("|").map(function (x) { return x.replace(/\s+/g, " ").trim(); });
      if (p.length > 3) return bad("Too many | separators. " + FORMAT + ".");
      var d;
      if (p.length === 1) d = { c: "Other", n: p[0], k: "veg" };
      else {
        if (!p[0]) return bad("The category is missing. " + FORMAT + ".");
        if (!p[1]) return bad(noEmoji !== line && /\S/.test(line.split("|")[1] || "") ? "The dish name has only emoji. Use letters or numbers." : "The dish name is missing. " + FORMAT + ".");
        var k = "veg";
        if (p.length === 3) {
          if (!p[2]) return bad("The type is missing. Use veg, nonveg or special.");
          k = strictKind(p[2]);
          if (!k) return bad("Unknown type \u201c" + p[2].slice(0, 30) + "\u201d. Use veg, nonveg or special.");
        }
        d = { c: p[0], n: p[1], k: k };
      }
      if (!d.n) return bad(out.emoji.indexOf(no) >= 0 ? "The dish name has only emoji. Use letters or numbers." : "The dish name is empty.");
      if (d.n.length > NAME_MAX) return bad("The dish name is too long (" + d.n.length + " characters, at most " + NAME_MAX + ").");
      if (d.c.length > CAT_MAX) return bad("The category is too long (" + d.c.length + " characters, at most " + CAT_MAX + ").");
      var key = lc(d.c) + "\u0001" + lc(d.n);
      if (seen[key]) { out.dupes.push(no); return; }
      seen[key] = 1; out.dishes.push(d);
    });
    if (out.dishes.length > DISH_MAX) out.errors.push({ line: 0, text: "", error: "A package can have at most " + DISH_MAX + " dishes (this text has " + out.dishes.length + ")." });
    return out;
  }
  function parseText(text) { return normDishes(parseTextReport(text).dishes); }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }
  function lines(a) { return (a.length === 1 ? "line " : "lines ") + a.slice(0, 8).join(", ") + (a.length > 8 ? ", \u2026" : ""); }
  // "12 dishes ready. Skipped 2 blank lines. Removed 1 repeated dish (line 7). Removed emoji from line 3."
  function reportSummary(r) {
    var bits = [plural(r.dishes.length, "dish", "dishes") + " ready."];
    if (r.blank) bits.push("Skipped " + plural(r.blank, "blank line") + ".");
    if (r.dupes.length) bits.push("Removed " + plural(r.dupes.length, "repeated dish", "repeated dishes") + " (" + lines(r.dupes) + ").");
    if (r.emoji.length) bits.push("Removed emoji from " + lines(r.emoji) + ".");
    return bits.join(" ");
  }
  // Price per plate box -> {ok, value, keep, error}. keep = the stored price stays as it is (not sent).
  // o = {active, base (stored price or null), badInput (the browser could not read the box as a number)}
  // An ACTIVE package needs a price above 0. An inactive one may keep its last price, but a price is
  // never cleared or set to 0 by Save.
  function checkPrice(raw, o) {
    o = o || {};
    var base = typeof o.base === "number" && isFinite(o.base) ? o.base : null;
    var hadPrice = base !== null && base > 0;
    var s = String(raw == null ? "" : raw).replace(/[,\s\u20b9]/g, "");
    var lastTxt = hadPrice ? " The last saved price was " + priceText(base) + "." : "";
    if (o.badInput) return { ok: false, error: "Enter a price per plate as a number, for example 650." };
    if (s === "") {
      if (!o.active && !hadPrice) return { ok: true, keep: true, value: base };
      return { ok: false, error: "Enter a price per plate." + (hadPrice ? " A price can't be left empty." + lastTxt : "") };
    }
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return { ok: false, error: "Enter a price per plate as a number, for example 650." };
    var n = Number(s);
    if (!isFinite(n)) return { ok: false, error: "Enter a price per plate as a number, for example 650." };
    if (n < 0) return { ok: false, error: "The price per plate can't be negative." };
    var dec = (s.split(".")[1] || "").replace(/0+$/, "");
    if (dec.length > 2) return { ok: false, error: "Use at most 2 decimal places, for example 650.50." };
    if (n > PRICE_MAX) return { ok: false, error: "The price per plate can be at most 1,00,000." };
    if (n === 0) {
      if (o.active) return { ok: false, error: "An active package needs a price per plate above 0." };
      if (hadPrice) return { ok: false, error: "A price can't be set to 0." + lastTxt + " Enter a price above 0." };
      return { ok: true, keep: true, value: base };
    }
    n = Math.round(n * 100) / 100;
    return { ok: true, keep: base !== null && n === base, value: n };
  }
  // the dish list of a package that is about to be saved
  function checkDishes(dishes, o) {
    var list = Array.isArray(dishes) ? dishes : [];
    if (o && o.active && !list.length) return { ok: false, error: "Add at least one dish. An active package needs at least one dish (or switch it off)." };
    if (list.length > DISH_MAX) return { ok: false, error: "A package can have at most " + DISH_MAX + " dishes." };
    return { ok: true };
  }
  // the package's dishes that are not in the studio's dish catalog (by name, any category)
  function notInCatalog(dishes, catalog) {
    return (dishes || []).filter(function (d) { return d && !findDish(catalog, d.n, d.c); });
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
    moveCategory: moveCategory, categories: categories, catalogFor: catalogFor, findDish: findDish, same: same,
    strictKind: strictKind, stripEmoji: stripEmoji, parseTextReport: parseTextReport, reportSummary: reportSummary,
    checkPrice: checkPrice, checkDishes: checkDishes, notInCatalog: notInCatalog, PRICE_MAX: PRICE_MAX, NAME_MAX: NAME_MAX };

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
    if (t.is_demo) title.appendChild(el("span", "hs-tag hs-solo", "Sample"));   // trial 0185: sample rows stay tagged
    var count = el("span", "mpk-count"); title.appendChild(count); head.appendChild(title);
    var pl = el("label", "mpk-plabel", (ctx.symbol || "\u20b9") + "/plate"); pl.htmlFor = "mpk_price_" + n;
    var price = el("input", "tpl_price mpk-price"); price.id = "mpk_price_" + n; price.type = "number"; price.min = "0"; price.step = "0.01";
    price.max = String(PRICE_MAX); price.setAttribute("inputmode", "decimal"); price.placeholder = "Set price";
    price.autocomplete = "off";                              // no browser form-state restore of a stale (blank) value
    price.setAttribute("aria-label", "Price per plate for " + nm);
    price.value = priceText(st.price);                       // set as a property: always shows the stored number
    // inline message under the price ("Enter a price per plate", "can't be negative", ...)
    var perr = el("p", "mpk-err mpk-perr"); perr.id = "mpk_perr_" + n; perr.hidden = true; perr.setAttribute("role", "alert");
    price.setAttribute("aria-describedby", perr.id);
    var pw = el("div", "mpk-pwrap"); pw.appendChild(pl); pw.appendChild(price);
    var pcol = el("div", "mpk-pcol"); pcol.appendChild(pw); pcol.appendChild(perr); head.appendChild(pcol);
    var al = el("label", "mpk-active"); var act = el("input", "tpl_active"); act.type = "checkbox"; act.checked = !!st.active;
    al.appendChild(act); al.appendChild(doc.createTextNode(" Active")); head.appendChild(al);
    if (trial) { act.disabled = true; al.title = "Fixed in the free trial"; }
    box.appendChild(head);

    var body = el("div", "mpk-body"); box.appendChild(body);
    var derr = el("p", "mpk-err mpk-derr"); derr.id = "mpk_derr_" + n; derr.hidden = true; derr.setAttribute("role", "alert"); box.appendChild(derr);
    var live = el("div", "sr-only"); live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite"); box.appendChild(live);

    // add-dish row (free trial: catalog dishes only)
    var add = null, catSel = null, dishIn = null, kindSel = null, dl = null, addBtn = null, addMsg = null, catNote = null;
    {
      add = el("div", "mpk-add");
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
    }
    // dishes in this package that are not in the dish catalog: offer to add them there
    // (free trial: flagged only - new dishes cannot be added in the trial)
    catNote = el("div", "mpk-catnote"); catNote.hidden = true; box.appendChild(catNote);

    // bulk text (not in the free trial: it could add dish names that are not in the catalog)
    var det = null, ta = null, taSynced = "", terr = null;
    if (!trial) {
      det = el("details", "mpk-text");
      det.appendChild(el("summary", null, "Paste as text (bulk)"));
      var hint = el("p", "mpk-hint", "One dish per line: Category | Dish name | veg / nonveg / special. Apply replaces this package's dish list (nothing is saved until you press Save package).");
      ta = el("textarea", "tpl_dishes mpk-ta"); ta.setAttribute("aria-label", "Dishes in " + nm + ", one per line"); ta.spellcheck = false;
      var ab = btn("btn sm mpk-apply", "Apply text", "Apply the text to " + nm);
      var tb = el("div", "mpk-text-actions"); tb.appendChild(ab);
      terr = el("div", "mpk-terr"); terr.hidden = true; terr.setAttribute("role", "alert"); terr.id = "mpk_terr_" + n;
      ta.setAttribute("aria-describedby", terr.id);
      det.appendChild(hint); det.appendChild(ta); det.appendChild(terr); det.appendChild(tb);
      det.addEventListener("toggle", function () { if (det.open) { ta.value = taSynced = toText(st.dishes); terr.hidden = true; } });
      ab.addEventListener("click", function () { if (st.saving) return; applyText(); });
      ta.addEventListener("input", paintState);
      box.appendChild(det);
    }

    var foot = el("div", "mpk-foot");
    var state = el("span", "mpk-state"); foot.appendChild(state);
    if (trial) foot.appendChild(el("span", "mpk-trial", "Free trial: change the price and the dishes (from your Dishes catalog)."));
    var save = btn("btn primary tpl_save", "Save package"); foot.appendChild(save);
    box.appendChild(foot);

    function say(msg) { live.textContent = ""; live.textContent = msg; }
    function setErr(node, input, msg) {
      node.textContent = msg || ""; node.hidden = !msg;
      if (input) { if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); }
      box.classList.toggle("mpk-invalid", !perr.hidden || !derr.hidden);
    }
    function paintCatNote() {
      if (!catNote) return;
      // an empty / failed catalog load would flag every dish: say nothing then
      var miss = ctx.catalog().length ? notInCatalog(st.dishes, ctx.catalog()) : [];
      catNote.textContent = ""; catNote.hidden = !miss.length;
      if (!miss.length) return;
      var names = miss.slice(0, 6).map(function (d) { return d.n; }).join(", ") + (miss.length > 6 ? ", \u2026" : "");
      catNote.appendChild(el("span", null, plural(miss.length, "dish", "dishes") + " not in your Dishes catalog: " + names + ". "));
      if (ctx.trial()) { catNote.appendChild(el("span", "mpk-catnote-t", "You can't add new dishes in the free trial.")); return; }
      var b = btn("btn sm mpk-catadd", miss.length === 1 ? "Add it to the catalog" : "Add them to the catalog", "Add " + plural(miss.length, "dish", "dishes") + " to the Dishes catalog");
      b.addEventListener("click", function () {
        var run = function () {
          return Promise.resolve(ctx.addToCatalog(miss.map(function (d) { return { c: d.c, n: d.n, k: d.k }; }))).then(function (ok) {
            if (ok !== false) { paintCatNote(); say("Added to the Dishes catalog."); }
          });
        };
        if (global.BPUI && global.BPUI.guard) global.BPUI.guard(b, run); else run();
      });
      catNote.appendChild(b);
    }
    // the bulk text box has edits that were not applied to the chips yet
    function textPending() { return !!(ta && det.open && ta.value !== taSynced); }
    // apply the bulk text (0192 line checks: nothing is applied until every line reads); true when applied
    function applyText() {
      var rep = parseTextReport(ta.value);
      terr.textContent = ""; terr.classList.remove("bad");
      if (rep.errors.length) {
        // line-level errors: nothing is applied until every line reads
        terr.classList.add("bad");
        terr.appendChild(el("p", "mpk-terr-h", "Nothing applied yet. Fix " + plural(rep.errors.length, "line") + ":"));
        var ul = el("ul", "mpk-terr-l");
        rep.errors.slice(0, 20).forEach(function (er) {
          ul.appendChild(el("li", null, (er.line ? "Line " + er.line + ": " : "") + er.error + (er.text ? " (\u201c" + er.text + "\u201d)" : "")));
        });
        if (rep.errors.length > 20) ul.appendChild(el("li", null, "\u2026and " + (rep.errors.length - 20) + " more."));
        terr.appendChild(ul); terr.hidden = false; ta.setAttribute("aria-invalid", "true");
        say(plural(rep.errors.length, "line") + " in the text need fixing. Nothing was applied.");
        try { ta.focus(); } catch (e) {}
        return false;
      }
      ta.removeAttribute("aria-invalid");
      st.dishes = normDishes(rep.dishes); taSynced = ta.value; draw();   // draw() then rewrites the box in the saved format
      var sum = reportSummary(rep) + " Press Save package to keep them.";
      terr.appendChild(el("p", null, sum)); terr.hidden = false; say(sum);
      return true;
    }
    function addNote(msg, bad) { if (!addMsg) return; addMsg.textContent = msg || ""; addMsg.hidden = !msg; addMsg.classList.toggle("bad", !!bad); }
    function dirty() {
      if (price.validity && price.validity.badInput) return true;
      var p = price.value === "" ? null : Number(price.value);
      return textPending() || !same(st.dishes, st.base.dishes) || (p !== st.base.price && !(p === null && st.base.price === null)) || act.checked !== st.base.active;
    }
    function paintState() {
      var d = dirty();
      state.textContent = st.saving ? "Saving\u2026" : st.failed && d ? "Not saved" : d ? "Unsaved changes" : "";
      state.classList.toggle("bad", !!(st.failed && d && !st.saving));
      box.classList.toggle("mpk-dirty", d);
      count.textContent = st.dishes.length + " dish" + (st.dishes.length === 1 ? "" : "es");
      if (!derr.hidden && (st.dishes.length || !act.checked)) setErr(derr, null, "");
      ctx.changed();
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
      if (st.saving) return;
      var name = clean(stripEmoji(dishIn.value));
      if (!name) { addNote(clean(dishIn.value) ? "Use letters or numbers for the dish name (emoji are removed)." : "Pick or type a dish first.", true); dishIn.focus(); return; }
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
      addNote(m ? "" : "Added \u201c" + d.n + "\u201d. It is not in your Dishes catalog yet.", false);
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
      x.addEventListener("click", function () { if (st.saving) return; st.dishes = removeAt(st.dishes, i); draw(); say("Removed " + d.n + "."); });
      c.appendChild(x);
      c.addEventListener("keydown", function (e) {
        if (st.saving) return;
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
      c.addEventListener("drop", function (e) { e.preventDefault(); c.classList.remove("over"); if (dragFrom < 0 || st.saving) return; var moved = st.dishes[dragFrom]; st.dishes = moveDish(st.dishes, dragFrom, i); dragFrom = -1; draw(); if (moved) say("Moved " + moved.n + "."); });
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
          up.addEventListener("click", function () { if (st.saving) return; st.dishes = moveCategory(st.dishes, g.c, -1); draw(); say(g.c + " moved up."); });
          dn.addEventListener("click", function () { if (st.saving) return; st.dishes = moveCategory(st.dishes, g.c, 1); draw(); say(g.c + " moved down."); });
          var mv = el("span", "mpk-mvs"); mv.appendChild(up); mv.appendChild(dn); h.appendChild(mv);
        }
        sec.appendChild(h);
        var chips = el("div", "mpk-chips"); g.items.forEach(function (it) { chips.appendChild(chip(it.d, it.i)); });
        sec.appendChild(chips); body.appendChild(sec);
      });
      // keep the bulk text in step with the chips, unless the owner is typing there (never overwrite that)
      if (ta && (!det.open || ta.value === taSynced)) ta.value = taSynced = toText(st.dishes);
      fillCats(); fillDishes(); paintCatNote(); paintState();
    }

    if (catSel) {
      catSel.addEventListener("change", function () { fillDishes(); syncKind(); addNote(""); });
      dishIn.addEventListener("input", function () { syncKind(); addNote(""); });
      dishIn.addEventListener("change", syncKind);
      dishIn.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
      addBtn.addEventListener("click", doAdd);
    }
    price.addEventListener("input", function () { if (!perr.hidden) setErr(perr, price, ""); paintState(); });
    act.addEventListener("change", function () { if (!perr.hidden) setErr(perr, price, ""); paintState(); });

    // the patch Save would send, or the first problem (shown inline). Only changed fields are sent.
    function build() {
      var on = trial ? !!st.base.active : !!act.checked;
      var pr = checkPrice(price.value, { active: on, base: st.base.price, badInput: !!(price.validity && price.validity.badInput) });
      var dr = checkDishes(st.dishes, { active: on });
      return { pr: pr, dr: dr, on: on };
    }
    function lock(on) {
      Array.prototype.forEach.call(box.querySelectorAll("input,select,textarea,button"), function (x) {
        if (x === save) return;
        if (on) { x.__mpkWas = x.disabled; x.disabled = true; } else if (x.__mpkWas !== undefined) { x.disabled = x.__mpkWas; delete x.__mpkWas; }
      });
      box.classList.toggle("mpk-saving", !!on);
    }
    // after a save, show exactly what the server stored (the returned row), else what was sent
    function adopt(row, patch) {
      var r = row && typeof row === "object" ? row : null;
      if (r) Object.keys(r).forEach(function (k) { t[k] = r[k]; });
      else Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
      st.price = priceOf(t); st.dishes = normDishes(t.dishes); st.active = t.active !== false;
      st.base = { dishes: st.dishes.slice(), price: st.price, active: st.active };
      price.value = priceText(st.price); act.checked = st.active;
      draw();
    }
    save.addEventListener("click", function () {
      if (st.saving) return;                                   // a second click while the first save runs
      if (textPending() && !applyText()) return;               // pasted text that was not applied yet is saved, not lost
      var v = build();
      setErr(perr, price, v.pr.ok ? "" : v.pr.error);
      setErr(derr, null, v.dr.ok ? "" : v.dr.error);
      if (!v.pr.ok || !v.dr.ok) {
        ctx.error((v.pr.ok ? v.dr.error : v.pr.error) + " (" + nm + ")");
        try { (v.pr.ok ? (addBtn ? dishIn : save) : price).focus(); } catch (e) {}
        return;
      }
      // dishes only when changed (a price-only save never rewrites the stored list); free trial: never the switch
      var patch = {};
      if (!v.pr.keep) patch.price_per_plate = v.pr.value;
      if (!same(st.dishes, st.base.dishes)) patch.dishes = normDishes(st.dishes);
      if (!trial && v.on !== st.base.active) patch.active = v.on;
      if (!Object.keys(patch).length) { if (v.pr.keep && price.value !== priceText(st.base.price)) price.value = priceText(st.base.price); paintState(); say("No changes to save."); return; }
      var run = function () {
        st.saving = true; st.failed = false; lock(true); paintState();
        var req; try { req = Promise.resolve(ctx.save(t, patch)); } catch (e) { req = Promise.reject(e); }
        return req.then(function (res) {
          st.saving = false; lock(false);
          if (res === false) { st.failed = true; paintState(); return; }
          adopt(res, patch); say(nm + " saved.");
        }, function (err) { st.saving = false; st.failed = true; lock(false); paintState(); ctx.error(err && err.message ? err.message : "Couldn't save " + nm + "."); });
      };
      if (global.BPUI && global.BPUI.guard) global.BPUI.guard(save, run); else { save.disabled = true; run().then(function () { save.disabled = false; }, function () { save.disabled = false; }); }
    });

    if (catSel) fillCats("");
    draw();
    box.__mpkRefresh = function () { if (catSel) { fillCats(); fillDishes(); syncKind(); } paintCatNote(); };
    return box;
  }

  /* render(host, {packages, catalog, trial(): bool, kindText, symbol, save(pkg, patch) -> Promise, error(msg)}) */
  function render(host, opts) {
    if (!host) return null;
    var o = opts || {}, catalog = Array.isArray(o.catalog) ? o.catalog : [];
    // one shared "leave this page?" warning while any package has unsaved changes (BPUI tracker)
    if (host.__mpkTracker && host.__mpkTracker.dispose) host.__mpkTracker.dispose();
    var tracker = global.BPUI && global.BPUI.trackDirty ? global.BPUI.trackDirty() : null;
    host.__mpkTracker = tracker;
    var cards = [];
    var ctx = {
      catalog: function () { return catalog; },
      trial: typeof o.trial === "function" ? o.trial : function () { return !!o.trial; },
      kindText: o.kindText || DEF_KIND_TEXT, symbol: o.symbol || "\u20b9",
      save: o.save || function () { return Promise.resolve(true); },
      error: o.error || function () {},
      addToCatalog: o.addToCatalog || function () { return Promise.resolve(false); },
      changed: function () {
        if (!tracker) return;
        if (cards.some(function (c) { return c.classList.contains("mpk-dirty"); })) tracker.mark(); else tracker.clean();
      }
    };
    var states = (o.packages || []).map(function (t) {
      var dishes = normDishes(t.dishes), price = priceOf(t), active = t.active !== false;
      return { t: t, dishes: dishes, price: price, active: active, base: { dishes: dishes.slice(), price: price, active: active } };
    });
    host.textContent = "";
    if (ctx.trial()) host.appendChild(el("p", "mpk-trialnote", "Free trial: you can change each package's price and dishes. Dishes come from your Dishes catalog; new dishes and packages need an upgrade."));
    states.forEach(function (st) { var c = card(st, ctx); host.appendChild(c); cards.push(c); });
    ctx.changed();
    return {
      setCatalog: function (list) { catalog = Array.isArray(list) ? list : []; cards.forEach(function (c) { if (c.__mpkRefresh) c.__mpkRefresh(); }); },
      dirty: function () { return cards.some(function (c) { return c.classList.contains("mpk-dirty"); }); },
      saving: function () { return cards.some(function (c) { return c.classList.contains("mpk-saving"); }); }
    };
  }

  global.HelmMenuPkg = { core: core, render: render };
})(typeof window !== "undefined" ? window : globalThis);
