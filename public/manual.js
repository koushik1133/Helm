/* manual.js — the signed-in User Manual (/manual).
 * The manual is NOT a public file any more: it lives in the private Supabase
 * storage bucket "helm-manual" (migration 0031), readable only with a signed-in
 * session. This page gates on sign-in (same pattern as every app page), downloads
 * USER-MANUAL.html with the user's session, swaps screenshot paths for short-lived
 * signed URLs, strips anything executable and renders it. External file so the
 * strict hash-based CSP needs no new inline-script hash. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  function state(title, text, link) {
    var box = $("#mState"); box.hidden = false; $("#mDoc").hidden = true;
    while (box.firstChild) box.removeChild(box.firstChild);
    var h = document.createElement("h1"); h.textContent = title; box.appendChild(h);
    var p = document.createElement("p"); p.textContent = text; box.appendChild(p);
    if (link) { var a = document.createElement("a"); a.href = link.href; a.textContent = link.text; box.appendChild(a); }
  }
  // Remove anything that could run code or load from elsewhere (defence in depth:
  // only the owner can write to the bucket, but the page must stay safe anyway).
  function sanitize(root) {
    root.querySelectorAll("script,iframe,frame,object,embed,link,meta,base,form,noscript,template").forEach(function (n) { n.remove(); });
    root.querySelectorAll("*").forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (at) {
        var n = at.name.toLowerCase(), v = String(at.value || "").trim().toLowerCase();
        if (n.indexOf("on") === 0 || n === "srcset" || n === "formaction" ||
            ((n === "href" || n === "src" || n === "xlink:href" || n === "action") && /^(javascript|data|vbscript):/.test(v) && !(n === "src" && /^data:image\//.test(v)))) {
          el.removeAttribute(at.name);
        }
      });
    });
  }
  async function render() {
    var res;
    try { res = await BPStore.manual.load(3600); }
    catch (e) {
      if (e && e.code === "manual_missing") {
        state("The manual isn't available yet", "Your studio's copy of the Helm user manual hasn't been published. Please check back soon, or ask your studio admin.", { href: "dashboard", text: "← Back to Helm" });
      } else {
        state("Couldn't load the manual", "Please check your connection and try again.", { href: "manual", text: "Try again" });
      }
      return;
    }
    var doc = new DOMParser().parseFromString(res.html, "text/html");
    var css = Array.prototype.map.call(doc.querySelectorAll("style"), function (s) { return s.textContent; }).join("\n");
    sanitize(doc);
    doc.querySelectorAll("img").forEach(function (img) {
      var src = (img.getAttribute("src") || "").replace(/^\.?\//, "").replace(/^docs\//, "");
      if (res.files[src]) { img.setAttribute("src", res.files[src]); img.setAttribute("referrerpolicy", "no-referrer"); }
      else if (!/^data:image\//.test(src)) img.remove();
    });
    if (css) { var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st); }
    var host = $("#mDoc");
    while (host.firstChild) host.removeChild(host.firstChild);
    Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) { host.appendChild(document.importNode(n, true)); });
    $("#mState").hidden = true; host.hidden = false;
    if (location.hash) { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }
  async function boot() {
    try { await BPStore.init(); } catch (e) {}
    // Same gate as every app page: signed-out visitors go to sign-in, then come back here.
    if (BPStore.auth.enabled() && BPStore.auth.required() && !BPStore.auth.user()) {
      location.replace("login.html?next=" + encodeURIComponent("manual"));
      return;
    }
    if (!BPStore.auth.enabled()) { state("Sign-in required", "The manual is only available to signed-in Helm users.", { href: "login.html?next=manual", text: "Sign in →" }); return; }
    await render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
