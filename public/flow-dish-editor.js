/* =========================================================================
   HELM — quote flow step 5 dish editor.
   Shows the event's dishes (event_menu_items) grouped by course and lets the
   planner add, rename and remove dishes. It uses the SAME store calls as
   plan.html (BPStore.eventMenu.list/add/remove/setQty, BPStore.dishCatalog),
   so both pages always show the same list.
   - Add: course + name. A name already in the studio's dish catalog is reused;
     a new name is added to the catalog first (needs Control Center edit rights).
   - Rename: adds the new dish first, copies the quantity, then removes the old
     row, so a failure part-way never loses the dish.
   No innerHTML, no inline styles or handlers (CSP). window.HelmDishEditor / require().
   ========================================================================= */
(function (root) {
  "use strict";
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const key = (s) => norm(s).toLowerCase();

  // { course: [items...] } in first-seen order
  function group(items) {
    const out = [], by = {};
    (items || []).forEach((m) => { const c = norm(m && m.category) || "Other";
      if (!by[c]) { by[c] = []; out.push([c, by[c]]); } by[c].push(m); });
    return out;
  }
  // the courses to offer: catalog categories + any already on the event
  function courses(catalog, items) {
    const seen = new Set(), out = [];
    (catalog || []).concat(items || []).forEach((d) => { const c = norm(d && d.category); if (c && !seen.has(key(c))) { seen.add(key(c)); out.push(c); } });
    if (!out.length) ["Starters", "Main course", "Breads", "Rice", "Desserts", "Beverages"].forEach((c) => out.push(c));
    return out;
  }
  // a catalog dish with this name (names are unique per studio)
  function findDish(catalog, name) { const k = key(name); return (catalog || []).find((d) => d && key(d.name) === k) || null; }
  // dish name list (multiset key) — used to tell package dishes from a custom list
  const sig = (names) => names.map(key).filter(Boolean).sort().join("\u0001");
  function isCustom(items, pkg) {
    if (!items || !items.length) return false;
    if (!pkg) return true;
    const pk = (Array.isArray(pkg.dishes) ? pkg.dishes : []).map((d) => d && (d.n || d.dish_name || d.name));
    return sig(items.map((m) => m.dish_name)) !== sig(pk);
  }
  function validName(name) {
    const n = norm(name);
    if (!n) return { ok: false, error: "Type a dish name." };
    if (n.length > 120) return { ok: false, error: "Dish names can be at most 120 characters." };
    if (/[<>]/.test(n)) return { ok: false, error: "Dish names can't contain < or >." };
    return { ok: true, value: n };
  }

  function mount(host, opts) {
    const S = opts.store, UI = opts.ui, doc = host.ownerDocument;
    const qid = opts.quoteId;
    let items = [], catalog = [], editable = !!opts.editable, busy = false, failed = null;
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const toast = (e, action) => { try { UI.toast(typeof e === "string" ? e : UI.friendlyError(e, { action }), { type: "err" }); } catch (_) {} };

    async function resolve(course, name) {
      const hit = findDish(catalog, name); if (hit) return hit;
      const d = await S.dishCatalog.add(course, name, "veg");
      catalog.push(d); return d;
    }
    async function run(btn, action, fn) {
      if (busy || !editable) return; busy = true;
      try { await (UI.guard ? UI.guard(btn || null, fn) : fn()); }
      catch (e) { toast(e, action); }
      finally { busy = false; }
    }
    async function reload() {
      try { items = (await S.eventMenu.list(qid)) || []; failed = null; }
      catch (e) { failed = e; }
      render(); return items;
    }
    async function addDish(course, name, btn) {
      const v = validName(name); if (!v.ok) { toast(v.error); return false; }
      if (items.some((m) => key(m.dish_name) === key(v.value))) { toast("“" + v.value + "” is already on the menu."); return false; }
      let ok = false;
      await run(btn, "add the dish", async () => {
        const d = await resolve(norm(course) || "Other", v.value);
        await S.eventMenu.add(qid, d.id); ok = true; await reload();
      });
      return ok;
    }
    async function removeDish(m, btn) {
      await run(btn, "remove the dish", async () => { await S.eventMenu.remove(m.id); await reload(); });
    }
    async function renameDish(m, name, btn) {
      const v = validName(name); if (!v.ok) { toast(v.error); return false; }
      if (key(v.value) === key(m.dish_name)) return true;
      if (items.some((x) => x.id !== m.id && key(x.dish_name) === key(v.value))) { toast("“" + v.value + "” is already on the menu."); return false; }
      let ok = false;
      await run(btn, "rename the dish", async () => {
        const d = await resolve(norm(m.category) || "Other", v.value);
        const row = await S.eventMenu.add(qid, d.id);           // add first: nothing is lost if a later step fails
        if (m.qty != null && row && row.id) { try { await S.eventMenu.setQty(row.id, m.qty); } catch (_) {} }
        await S.eventMenu.remove(m.id); ok = true; await reload();
      });
      return ok;
    }

    function render() {
      host.textContent = "";
      host.appendChild(el("h3", "dish-h", "Dishes"));
      if (failed) {
        const p = el("p", "dish-err", "The dishes couldn't be loaded. ");
        const b = el("button", "btn sm", "Retry"); b.type = "button"; b.addEventListener("click", () => reload());
        p.appendChild(b); host.appendChild(p); return;
      }
      if (!items.length) host.appendChild(el("p", "dish-empty", "No dishes yet — pick a package above or add dishes below."));
      const list = el("div", "dish-list");
      group(items).forEach(([course, rows]) => {
        const g = el("div", "dish-course"); g.setAttribute("role", "group"); g.setAttribute("aria-label", course);
        g.appendChild(el("div", "dish-c", course));
        const ul = el("ul", "dish-ul");
        rows.forEach((m) => {
          const li = el("li", "dish-row"); li.dataset.id = m.id;
          const name = el("span", "dish-n", m.dish_name); li.appendChild(name);
          if (editable) {
            const rn = el("button", "btn sm ghost dish-rn", "Rename"); rn.type = "button"; rn.setAttribute("aria-label", "Rename " + m.dish_name);
            const rm = el("button", "btn sm ghost dish-rm", "Remove"); rm.type = "button"; rm.setAttribute("aria-label", "Remove " + m.dish_name);
            rn.addEventListener("click", () => startRename(li, m));
            rm.addEventListener("click", () => removeDish(m, rm));
            li.appendChild(rn); li.appendChild(rm);
          }
          ul.appendChild(li);
        });
        g.appendChild(ul); list.appendChild(g);
      });
      host.appendChild(list);
      if (editable) host.appendChild(addForm());
    }
    function startRename(li, m) {
      li.textContent = "";
      const inp = el("input", "dish-in"); inp.type = "text"; inp.value = m.dish_name; inp.maxLength = 120;
      inp.setAttribute("aria-label", "New name for " + m.dish_name); inp.setAttribute("list", "dishCatList");
      const save = el("button", "btn sm primary", "Save"); save.type = "button";
      const cancel = el("button", "btn sm ghost", "Cancel"); cancel.type = "button";
      const done = async () => { if (await renameDish(m, inp.value, save)) return; };
      save.addEventListener("click", done);
      cancel.addEventListener("click", () => render());
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(); } else if (e.key === "Escape") { e.preventDefault(); render(); } });
      li.appendChild(inp); li.appendChild(save); li.appendChild(cancel); inp.focus(); inp.select();
    }
    function addForm() {
      const f = el("div", "dish-add");
      const cid = "dishAddCourse", nid = "dishAddName";
      const lc = el("label", "dish-lbl", "Course"); lc.htmlFor = cid;
      const sel = el("select", "dish-sel"); sel.id = cid;
      courses(catalog, items).forEach((c) => { const o = el("option", null, c); o.value = c; sel.appendChild(o); });
      const ln = el("label", "dish-lbl", "Dish"); ln.htmlFor = nid;
      const inp = el("input", "dish-in"); inp.id = nid; inp.type = "text"; inp.maxLength = 120; inp.placeholder = "e.g. Paneer tikka"; inp.setAttribute("list", "dishCatList");
      const dl = el("datalist"); dl.id = "dishCatList";
      catalog.forEach((d) => { const o = el("option"); o.value = d.name; dl.appendChild(o); });
      const b = el("button", "btn sm", "＋ Add dish"); b.type = "button";
      const go = async () => {
        const hit = findDish(catalog, inp.value);
        if (await addDish(hit ? hit.category : sel.value, inp.value, b)) { const n = doc.getElementById(nid); if (n) n.focus(); }
      };
      b.addEventListener("click", go);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
      [lc, sel, ln, inp, dl, b].forEach((x) => f.appendChild(x));
      return f;
    }

    async function init() {
      try { catalog = (await S.dishCatalog.list()) || []; } catch (_) { catalog = []; }
      return reload();
    }
    return {
      init, reload, render,
      items: () => items.slice(),
      setEditable(on) { editable = !!on; render(); },
      isCustom: (pkg) => isCustom(items, pkg),
      _add: addDish, _remove: removeDish, _rename: renameDish,
    };
  }

  const api = { mount, group, courses, findDish, isCustom, validName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmDishEditor = api;
})(typeof window !== "undefined" ? window : globalThis);
