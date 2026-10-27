// r19 live QA: L3 dashboard "Continue" button contrast, L4 short-window sidebar, L5 privacy mode money inputs.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";

const r = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8");
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("ok - " + name); } catch (e) { fail++; console.log("FAIL - " + name + "\n  " + (e && e.message)); } }

/* ---------------- L3 ---------------- */
const style = r("shell-b-style.css"), studio = r("shell-b-theme-studio.css"), luxe = r("shell-b-theme-luxe.css"), dash = r("shell-b-dash.css");
t("L3 the main/card link colour rules skip a.hd-btn (link colour no longer beats .hd-btn.hd-primary)", () => {
  const rule = /html\[data-shell="b"\] main a:not\(\.btn\)[^,{]*,\s*html\[data-shell="b"\] \.card a:not\(\.btn\)[^{]*\{ color: var\(--hb-acc-text\)/.exec(style);
  assert.ok(rule, "link colour rule present");
  assert.equal((rule[0].match(/:not\(\.hd-btn\)/g) || []).length, 2, "both selectors exclude .hd-btn");
  const hover = style.split("\n").find((l) => /main a:not\(\.btn\).*:hover/.test(l));
  assert.ok(hover && (hover.match(/:not\(\.hd-btn\)/g) || []).length === 2, "hover underline skips .hd-btn too");
});
t("L3 explicit on-accent ink for a.hd-btn.hd-primary in main", () => {
  assert.match(style, /html\[data-shell="b"\] main a\.hd-btn\.hd-primary, html\[data-shell="b"\] main a\.hd-btn\.hd-primary:hover \{ color: var\(--hd-acc-ink, var\(--hb-acc-ink, #fff\)\); text-decoration: none; \}/);
  assert.match(dash, /\.hd-btn\.hd-primary \{ background: var\(--hd-acc\); color: var\(--hd-acc-ink\)/);
});
t("L3 Studio / Luxe theme link colours skip a.hd-btn too", () => {
  assert.match(studio, /data-hb-theme="studio"\] a:not\(\.btn\)[^{]*:not\(\.hd-btn\) \{ color:var\(--c8-ac\); \}/);
  assert.match(luxe, /data-hb-theme="luxe"\] a:not\(\.btn\):not\(\[class\*="hb-"\]\):not\(\.hd-btn\) \{ color:inherit;/);
});
t("L3 flow-resume renders the dashboard Continue link as hd-btn hd-primary", () => {
  assert.match(r("flow-resume.js"), /primary: "hd-btn hd-primary"/);
});

/* ---------------- L4 ---------------- */
const shellJs = r("shell-b.js"), shellCss = r("shell-b.css");
t("L4 rail footer tools keep their own variable (the header's `var tools` no longer hijacks placeTools on resize)", () => {
  assert.match(shellJs, /var ftools = el\("div", "hb-group hb-ftools"\); scroll\.appendChild\(ftools\);/);
  const pt = /function placeTools\(\) \{[\s\S]*?\n    \}/.exec(shellJs);
  assert.ok(pt, "placeTools found");
  assert.match(pt[0], /var host = short \? ftools : bottom;/);
  assert.match(pt[0], /ftools\.hidden = !short;/);
  assert.doesNotMatch(pt[0], /(^|[^f])\btools\b/, "placeTools never touches the header's tools row");
  assert.equal((shellJs.match(/^\s*var tools\b/gm) || []).length, 1, "only the header declares `tools`");
});
t("L4 the rail is a strict column: nav takes the free space and scrolls, top + footer never shrink", () => {
  const blk = shellCss.slice(shellCss.indexOf("r19 L4"));
  assert.ok(blk.length > 50, "r19 L4 block present");
  assert.match(blk, /\.hb-rail \{ display: flex; flex-direction: column; height: 100vh; height: 100dvh;/);
  assert.match(blk, /\.hb-rail > \.hb-top, html\[data-shell="b"\] \.hb-rail > \.hb-bottom \{ flex: none; \}/);
  assert.match(blk, /\.hb-rail > \.hb-scroll \{ flex: 1 1 0; min-height: 0; overflow-y: auto;/);
  assert.match(blk, /\.hb-bottom > \.hb-slot \{ flex: none; \}/);
  assert.match(blk, /\.hb-rail > \.hb-bottom \{ position: relative; z-index: 1; background: inherit; \}/);
});

/* ---------------- L5 ---------------- */
const pj = r("shell-b-privacy.js"), pc = r("shell-b-privacy.css");
t("L5 every money input is masked (hbp-mi) - by id/name, label text, or a currency sign beside it", () => {
  assert.match(pj, /function moneyInput\(i\)/);
  assert.match(pj, /var lt = labelText\(i\);\s*return MONEY_INPUT\.test\(lt\) \|\| CUR_RE\.test\(lt\) \|\| curBeside\(i\);/);
  assert.match(pj, /i\.classList\.add\("hbp-in"\);\s*if \(i\.type !== "search"\) i\.classList\.add\("hbp-mi"\);/);
  assert.match(pj, /i\.closest\("#hbpModal, \.hbp-skip"\)/, "the PIN box is never touched");
});
t("L5 focus shows + selects the real value; blur hides it again; no typing into transparent text", () => {
  assert.match(pj, /t\.classList\.add\("hbp-rv"\);/);
  assert.match(pj, /t\.select\(\); selectOnUp = t;/);
  assert.match(pj, /t\.readOnly \|\| t\.disabled\) return;/, "a read-only amount stays masked");
  assert.match(pj, /document\.addEventListener\("focusin", onFocusIn, true\);/);
  assert.match(pj, /document\.addEventListener\("focusout", onFocusOut, true\);/);
  assert.match(pj, /document\.addEventListener\("mouseup", onMouseUp, true\);/);
  assert.match(pc, /:is\(input\.hbp-mi, input\[data-pl-est\], input\[data-pl-quoted\], input\[data-pl-act\]\):not\(:focus\):not\(\.hbp-rv\) \{\s*color: transparent !important;/);
  assert.match(pc, /:is\(input\.hbp-mi, input\[data-pl-est\], input\[data-pl-quoted\], input\[data-pl-act\]\):is\(:focus, \.hbp-rv\) \{ color: var\(--hb-ink, inherit\) !important; -webkit-text-fill-color: var\(--hb-ink, currentColor\) !important;/);
});
t("L5 the masking never changes an input's value", () => {
  const body = pj.slice(pj.indexOf("function moneyInput"), pj.indexOf("function onMouseUp"));
  assert.doesNotMatch(body, /\.value\s*=[^=]/);
});
t("L5 lead Budget, Settings default prices and item prices carry hbp-mi in their markup", () => {
  assert.match(r("leads.html"), /<input id="f_budget" type="number" min="0" max="10000000000"[^>]* class="hbp-mi">/);
  const cc = r("control.html");
  for (const id of ["p_chair", "p_plate", "p_layout"]) assert.match(cc, new RegExp('<input id="' + id + '" type="number" min="0" step="0\\.01"[^>]* class="hbp-mi">'), id);
  assert.match(r("asset-price-grid.js"), /var inp = el\("input", "hbp-mi"\); inp\.id = id; inp\.type = "number";/);
});
t("L5 label / currency-sign detection: money labels match, other numbers do not", () => {
  const src = ["CUR", "CUR_RE", "CUR_ONLY", "MONEY_INPUT"].map((n) => {
    const m = new RegExp("var " + n + " = [^\\n]*;").exec(pj); assert.ok(m, n); return m[0].replace(/\s*\/\/.*$/, "");
  }).join("\n");
  const ctx = {}; vm.runInNewContext(src + "\nthis.CUR_RE = CUR_RE; this.CUR_ONLY = CUR_ONLY; this.MONEY_INPUT = MONEY_INPUT;", ctx);
  const money = (l) => ctx.MONEY_INPUT.test(l) || ctx.CUR_RE.test(l);
  for (const l of ["Budget (₹)", "Price / chair (₹)", "Layout & setup fee (₹)", "Estimated ₹", "Rate in AED"]) assert.ok(money(l), l);
  for (const l of ["Max guests", "Venue booking gap (hours)", "Max round tables", "Hours", "RSVPs"]) assert.ok(!money(l), l);
  for (const s of ["₹", "(₹)", "AED", "$"]) assert.ok(ctx.CUR_ONLY.test(s), s);
  for (const s of ["₹1,500", "Default", "per plate"]) assert.ok(!ctx.CUR_ONLY.test(s), s);
});

/* ---------------- pins ---------------- */
t("pins: SHELL_V bumped past 129 and shell-proto past v=29", () => {
  const sv = +/var SHELL_V = "(\d+)"/.exec(r("shell-proto.js"))[1]; assert.ok(sv >= 130, "SHELL_V " + sv);
  const sp = +/shell-proto\.js\?v=(\d+)/.exec(r("store-api.js"))[1]; assert.ok(sp >= 30, "shell-proto pin " + sp);
});

console.log(`r19-live-shell-chrome-privacy: ${pass} passed${fail ? ", " + fail + " FAILED" : ""}`);
if (fail) process.exit(1);
