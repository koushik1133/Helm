/* marketing-loader.js - Emerald blueprint intro, first visit per session only, <=800 ms, never blocks content.
 * Built with createElementNS (no innerHTML: CSP/injection-safe). MARK = Helm mark paths (viewBox 0 0 48 48,
 * same as shell-b-loader-mark.svg) - swap here to change the mark. */
(function () {
  try {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (sessionStorage.getItem("helm.mk.intro") === "1") return;
    sessionStorage.setItem("helm.mk.intro", "1");
  } catch (e) { return; }
  var MARK = ["M16 12.5a6.5 6.5 0 0 1 6.5 6.5v10a6.5 6.5 0 0 1-13 0v-10a6.5 6.5 0 0 1 6.5-6.5z", "M32 12.5a6.5 6.5 0 0 1 6.5 6.5v10a6.5 6.5 0 0 1-13 0v-10a6.5 6.5 0 0 1 6.5-6.5z"];
  var NS = "http://www.w3.org/2000/svg", d = document.createElement("div"), st = document.createElement("div");
  function el(n, a, p) { var e = document.createElementNS(NS, n); for (var k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; }
  d.id = "mk-ld"; d.setAttribute("aria-hidden", "true"); st.className = "mkl-stage"; d.appendChild(st);
  var s = el("svg", { viewBox: "-12 -12 72 72", focusable: "false" }, st), g = el("g", { "class": "mkl-grid" }, s);
  for (var i = -12; i <= 60; i += 6) { el("line", { x1: i, y1: -12, x2: i, y2: 60 }, g); el("line", { x1: -12, y1: i, x2: 60, y2: i }, g); }
  el("path", { "class": "mkl-dim", pathLength: 1, d: "M6 52v4M42 52v4M6 54h36M52 3h4M52 45h4M54 3v42" }, s);
  el("path", { "class": "mkl-mark", pathLength: 1, "stroke-width": 3.2, transform: "rotate(-20 24 24)", d: MARK[0] }, s);
  el("path", { "class": "mkl-mark", pathLength: 1, "stroke-width": 3.2, transform: "rotate(-20 24 24)", d: MARK[1] }, s);
  document.documentElement.appendChild(d);
  setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 820);
})();
