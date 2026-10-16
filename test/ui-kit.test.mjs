// HelmUI kit: API shape, behaviour in a stub DOM, and CSP safety.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8");
const JS = read("ui-kit.js"), CSS = read("ui-kit.css");

function stubDom() {
  const listeners = [];
  const mk = (tag) => {
    const n = { tagName: tag.toUpperCase(), children: [], parentNode: null, className: "", textContent: "", attrs: {}, handlers: {},
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      addEventListener(t, f) { (this.handlers[t] ||= []).push(f); },
      click() { (this.handlers.click || []).forEach((f) => f({})); },
      focus() { doc.activeElement = this; },
      querySelectorAll() { const out = []; const walk = (x) => x.children.forEach((c) => { if (c.tagName === "BUTTON") out.push(c); walk(c); }); walk(this); return out; } };
    return n;
  };
  const doc = { body: mk("body"), activeElement: null, createElement: mk,
    addEventListener(t, f) { listeners.push(f); }, removeEventListener(t, f) { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
    key(k) { listeners.slice().forEach((f) => f({ key: k, preventDefault() {}, stopPropagation() {} })); } };
  const win = { document: doc, setTimeout, clearTimeout, Promise, Object, Array, String, Math };
  vm.runInNewContext(JS, win);
  return { win, doc, find: (cls) => { const out = []; const walk = (x) => x.children.forEach((c) => { if ((" " + c.className + " ").includes(" " + cls + " ")) out.push(c); walk(c); }); walk(doc.body); return out; } };
}

test("API shape", () => {
  const { win } = stubDom();
  for (const k of ["confirm", "toast", "undoable", "statusPill", "emptyState"]) assert.equal(typeof win.HelmUI[k], "function");
});

test("CSP safety: no innerHTML / inline style / eval", () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|\.style\.|setAttribute\(\s*["']style|eval\(|new Function/.test(JS));
});

test("confirm resolves true on confirm, false on Esc", async () => {
  const { win, doc, find } = stubDom();
  const p = win.HelmUI.confirm({ title: "Archive?", body: "x", confirmLabel: "Archive", danger: true });
  find("hs-btn-danger")[0].click();
  assert.equal(await p, true);
  assert.equal(find("hs-overlay").length, 0);
  const p2 = win.HelmUI.confirm({ title: "t" });
  doc.key("Escape");
  assert.equal(await p2, false);
});

test("toast uses a single stack and textContent", () => {
  const { win, find } = stubDom();
  win.HelmUI.toast("<b>hi</b>", { type: "success", timeout: 0 });
  win.HelmUI.toast("two", { type: "error", timeout: 0 });
  assert.equal(find("hs-toasts").length, 1);
  assert.equal(find("hs-toast").length, 2);
  assert.equal(find("hs-toast-msg")[0].textContent, "<b>hi</b>");
});

test("undoable defer: Undo prevents run; timeout runs it", async () => {
  const { win, find } = stubDom();
  let ran = 0;
  const p = win.HelmUI.undoable({ message: "Archived", run: () => ran++, ms: 20 });
  find("hs-toast-act")[0].click();
  assert.deepEqual({ ...(await p) }, { undone: true });
  assert.equal(ran, 0);
  await win.HelmUI.undoable({ message: "Archived", run: () => ran++, ms: 10 });
  assert.equal(ran, 1);
});

test("undoable immediate: runs now, Undo calls undo", async () => {
  const { win, find } = stubDom();
  let ran = 0, und = 0;
  const p = win.HelmUI.undoable({ mode: "immediate", run: () => ran++, undo: () => und++, ms: 1000 });
  assert.equal(ran, 1);
  find("hs-toast-act")[0].click();
  await p;
  assert.equal(und, 1);
});

test("statusPill + emptyState", () => {
  const { win } = stubDom();
  const p = win.HelmUI.statusPill("Overdue");
  assert.equal(p.className, "hs-pill hs-overdue");
  assert.equal(p.textContent, "Overdue");
  assert.equal(win.HelmUI.statusPill("weird").className, "hs-pill hs-draft");
  let hit = 0;
  const e = win.HelmUI.emptyState({ icon: "+", title: "No leads yet", text: "Add one", actionLabel: "Add lead", onAction: () => hit++ });
  e.children.find((c) => c.tagName === "BUTTON").click();
  assert.equal(hit, 1);
});

test("CSS defines all pill classes and uses --hb-* with fallbacks", () => {
  for (const c of ["draft", "sent", "confirmed", "paid", "overdue", "archived"]) assert.match(CSS, new RegExp("\\.hs-" + c + "\\{"));
  assert.match(CSS, /var\(--hb-bg,var\(--panel/);
  assert.match(CSS, /data-theme="dark"/);
});
