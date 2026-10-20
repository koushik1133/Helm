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
  // r22: <style> too - its CSS was already read (adopted as a constructable sheet); an imported <style> element
  // would be refused by style-src-elem (no 'unsafe-inline') and log a CSP violation.
  // Remove anything that could run code or load from elsewhere (defence in depth:
  // only the owner can write to the bucket, but the page must stay safe anyway).
  function sanitize(root) {
    root.querySelectorAll("script,style,iframe,frame,object,embed,link,meta,base,form,noscript,template").forEach(function (n) { n.remove(); });
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
    // R19: a "Screenshot to add" box (<div class="shot-todo" data-shot="name.png">) becomes the picture as soon
    // as the owner has uploaded screenshots/name.png to the bucket; until then the box + caption stay.
    doc.querySelectorAll("[data-shot]").forEach(function (box) {
      var name = String(box.getAttribute("data-shot") || "");
      var url = /^[\w.-]+\.(webp|png|jpe?g)$/i.test(name) ? res.files["screenshots/" + name] : null;
      if (!url) return;
      var img = doc.createElement("img");
      img.className = "screen"; img.setAttribute("src", url); img.setAttribute("referrerpolicy", "no-referrer");
      img.setAttribute("alt", String(box.getAttribute("data-alt") || "")); img.setAttribute("loading", "lazy"); img.setAttribute("decoding", "async");
      box.parentNode.replaceChild(img, box);
    });
    if (css) __helmAdoptCss(document, css);
    var host = $("#mDoc");
    while (host.firstChild) host.removeChild(host.firstChild);
    Array.prototype.slice.call(doc.body.childNodes).forEach(function (n) { host.appendChild(document.importNode(n, true)); });
    try { await filterForRole(host); } catch (e) {}   // per-role chapters; on any error everything stays visible
    $("#mState").hidden = true; host.hidden = false;
    if (location.hash) { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
  }
  // r23: PER-ROLE manual. A chapter heading <h2 data-areas="quotes,leads"> is shown only when the signed-in role can
  // view at least one of those areas (the same live Roles & access matrix the app uses); "admin" = studio admin only;
  // no data-areas = everyone. Admins see every chapter. A hidden chapter also drops out of the sidebar + contents.
  // If the role can't be read, nothing is hidden (the manual is help text, not data - the pages keep their own gates).
  function chapterRun(h2) {
    var sec = h2.parentNode && h2.parentNode.classList && h2.parentNode.classList.contains("mch") ? h2.parentNode : null;
    if (sec) return [sec];
    var run = [h2], n = h2.nextElementSibling;
    while (n && n.tagName !== "H2" && !(n.classList && n.classList.contains("mch")) && n.tagName !== "FOOTER") { run.push(n); n = n.nextElementSibling; }
    return run;
  }
  async function filterForRole(host) {
    var role = null; try { role = await BPStore.auth.role(); } catch (e) { role = null; }
    if (!role || role === "admin") return 0;
    var cache = {};
    async function can(a) {
      if (a === "admin") return false;
      if (!Object.prototype.hasOwnProperty.call(cache, a)) { try { cache[a] = !!(await BPStore.auth.canView(a)); } catch (e) { cache[a] = true; } }
      return cache[a];
    }
    var hidden = 0;
    var heads = Array.prototype.slice.call(host.querySelectorAll("h2[data-areas]"));
    for (var i = 0; i < heads.length; i++) {
      var h2 = heads[i], areas = String(h2.getAttribute("data-areas") || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
      var ok = !areas.length;
      for (var k = 0; k < areas.length && !ok; k++) ok = await can(areas[k]);
      if (ok) continue;
      hidden++;
      chapterRun(h2).forEach(function (el) { el.hidden = true; });
      if (h2.id) host.querySelectorAll('a[href="#' + h2.id + '"]').forEach(function (a) {
        var li = a.parentNode && a.parentNode.tagName === "LI" ? a.parentNode : null;
        if (a.closest("nav")) a.hidden = true; else if (li && li.closest(".toc")) li.hidden = true;
      });
    }
    // a sidebar group heading with no visible link under it goes too
    host.querySelectorAll("nav .grp").forEach(function (g) {
      var n = g.nextElementSibling, any = false;
      while (n && !(n.classList && n.classList.contains("grp"))) { if (n.tagName === "A" && !n.hidden) any = true; n = n.nextElementSibling; }
      if (!any) g.hidden = true;
    });
    var ver = host.querySelector(".ver");
    if (ver && hidden) {
      var label = role; try { label = (BPStore.auth.admin && BPStore.auth.admin.roleLabel) ? BPStore.auth.admin.roleLabel(role) : role; } catch (e) {}
      var note = document.createElement("p"); note.className = "rolenote"; note.id = "mRoleNote";
      note.textContent = "Showing the chapters for your role (" + label + "). Parts of Helm your role can't open are left out - ask your studio admin if you need more access.";
      ver.parentNode.insertBefore(note, ver.nextSibling);
    }
    return hidden;
  }
  // r20 coord (e): the user manual is hidden for now (config.js HELM_FEATURES.manual). While it is off the page
  // only shows a calm "coming soon" note: no sign-in round trip, no storage fetch (the private bucket used to 400).
  function manualEnabled() { var f = window.HELM_FEATURES && window.HELM_FEATURES.manual; return f === true || f === "admin"; }
  function comingSoon() {
    state("The user manual is coming soon.", "We're still writing it. Everything in Helm works as usual in the meantime.", { href: "dashboard", text: "← Back to the dashboard" });
  }
  async function boot() {
    if (!manualEnabled()) { comingSoon(); return; }
    try { await BPStore.init(); } catch (e) {}
    // Same gate as every app page: signed-out visitors go to sign-in, then come back here.
    if (BPStore.auth.enabled() && BPStore.auth.required() && !BPStore.auth.user()) {
      location.replace("login.html?next=" + encodeURIComponent("manual"));
      return;
    }
    if (!BPStore.auth.enabled()) { state("Sign-in required", "The manual is only available to signed-in Helm users.", { href: "login.html?next=manual", text: "Sign in →" }); return; }
    // r20 coord: "admin" = only the studio admin loads the file; everyone else sees "coming soon" (no storage fetch)
    if (window.HELM_FEATURES && window.HELM_FEATURES.manual === "admin") {
      var r = null; try { r = await BPStore.auth.role(); } catch (e) { r = null; }
      if (r !== "admin") { comingSoon(); return; }
    }
    await render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

/* CSP: style-src-elem carries no 'unsafe-inline', so runtime CSS goes through a
   constructable stylesheet (CSSOM — not an inline <style>, not governed by CSP).
   Falls back to a <style> element only on browsers without adoptedStyleSheets. */
function __helmAdoptCss(doc, css) {
  try {
    var W = doc.defaultView || window;
    if (W.CSSStyleSheet && "adoptedStyleSheets" in doc && "replaceSync" in W.CSSStyleSheet.prototype) {
      var sh = new W.CSSStyleSheet(); sh.replaceSync(css);
      doc.adoptedStyleSheets = Array.prototype.slice.call(doc.adoptedStyleSheets).concat([sh]);
      return true;
    }
  } catch (e) {}
  var st = doc.createElement("style"); st.textContent = css;
  (doc.head || doc.documentElement).appendChild(st);
  return true;
}
