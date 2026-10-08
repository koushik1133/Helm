/* ============================================================================
 * trusted-types.js — Trusted Types policies for every Helm page.
 * Loaded as the FIRST script on each page (before telemetry/config/store-api).
 *
 * What it does
 *   - `default` policy: every string that reaches an HTML sink (innerHTML,
 *     outerHTML, insertAdjacentHTML, document.write) is run through a small
 *     built-in ALLOWLIST sanitizer (no dependency): only known HTML/SVG tags and
 *     attributes survive; on* handlers, <script>/<iframe>/<object>/<style>,
 *     srcdoc and javascript:/vbscript:/non-image data: URLs are removed.
 *     Script URLs are allowed only for this origin and the exact CDN
 *     directories the CSP allows; string-to-code (eval, new Function,
 *     setTimeout("…")) is refused.
 *   - `helm` policy: private to this file (used to parse into an inert
 *     <template>); never exposed on window.
 *
 * Enforcement is OFF by default. The browser only consults these policies once
 * the CSP carries  require-trusted-types-for 'script'; trusted-types helm default
 * which scripts/csp-hashes.cjs adds when TRUSTED_TYPES_ENFORCE = true (or, for
 * the local server only, HELM_TRUSTED_TYPES=1 node server.js). Turn it on only
 * after a logged-in pass over every page shows zero violations.
 * Known item to handle before enforcing: the print preview in quotes.html /
 * flow.html calls w.document.write() on a new about:blank window, whose realm has
 * no default policy — route it through this window's policy first.
 * ========================================================================== */
(function () {
  'use strict';
  var TT = window.trustedTypes;
  if (!TT || !TT.createPolicy) return;            // browsers without Trusted Types: nothing to do

  var TAGS = ('a abbr article aside audio b blockquote br button caption code col colgroup dd del details dfn div dl dt em ' +
    'fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i img input ins kbd label legend li main mark meter nav ' +
    'ol optgroup option output p picture pre progress q s samp section select small source span strong sub summary sup ' +
    'table tbody td textarea tfoot th thead time tr track u ul var video wbr ' +
    // SVG (lower-cased by the HTML parser's tagName for our purposes)
    'svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop clippath title desc'
  ).split(' ');
  var DROP_WITH_CONTENT = { script: 1, style: 1, iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1, applet: 1,
    template: 1, noscript: 1, base: 1, link: 1, meta: 1, math: 1, foreignobject: 1, use: 1, animate: 1, set: 1, image: 1 };
  var ATTRS = ('id class style title role tabindex hidden lang dir name type value placeholder for checked selected disabled ' +
    'readonly required min max step minlength maxlength pattern autocomplete multiple rows cols colspan rowspan scope headers ' +
    'alt width height loading decoding href src srcset sizes target rel download datetime open draggable controls muted loop ' +
    'preload playsinline poster accept inputmode spellcheck autofocus novalidate label kind srclang start reversed ' +
    'viewbox fill stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity d x y ' +
    'x1 y1 x2 y2 cx cy r rx ry points transform focusable opacity fill-opacity fill-rule clip-rule font-size font-weight ' +
    'text-anchor dominant-baseline xmlns offset stop-color stop-opacity gradientunits gradienttransform preserveaspectratio clip-path'
  ).split(' ');
  var TAG_OK = {}, ATTR_OK = {};
  TAGS.forEach(function (t) { TAG_OK[t] = 1; });
  ATTRS.forEach(function (a) { ATTR_OK[a] = 1; });
  var URL_ATTR = { href: 1, src: 1, poster: 1, srcset: 1, action: 1, formaction: 1, 'xlink:href': 1 };
  var SAFE_URL = /^(?:(?:https?|mailto|tel|blob):|[^a-z]|[a-z0-9+.\-]+(?:[^a-z0-9+.\-:]|$))/i;
  var SAFE_DATA_IMG = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+\/=\s]+$/i;

  function urlOk(name, v) {
    var s = String(v).replace(/[\u0000- \u007f-\u009f]/g, '');
    if (/^data:/i.test(s)) return name !== 'href' && SAFE_DATA_IMG.test(s);
    return SAFE_URL.test(s) && !/^(?:javascript|vbscript):/i.test(s);
  }

  function clean(node) {
    var kids = node.childNodes;
    for (var i = kids.length - 1; i >= 0; i--) {
      var el = kids[i];
      if (el.nodeType === 8) { node.removeChild(el); continue; }      // comments
      if (el.nodeType !== 1) continue;
      var tag = el.localName.toLowerCase();
      if (DROP_WITH_CONTENT[tag]) { node.removeChild(el); continue; }
      clean(el);
      if (!TAG_OK[tag]) {                                            // unknown element → keep its children only
        while (el.firstChild) node.insertBefore(el.firstChild, el);
        node.removeChild(el); continue;
      }
      for (var j = el.attributes.length - 1; j >= 0; j--) {
        var a = el.attributes[j], n = a.name.toLowerCase();
        var keep = (ATTR_OK[n] || /^data-[\w.\-]+$/.test(n) || /^aria-[a-z]+$/.test(n)) && n.slice(0, 2) !== 'on';
        if (keep && URL_ATTR[n]) keep = urlOk(n, a.value);
        if (!keep) el.removeAttribute(a.name);
      }
    }
  }

  // Private identity policy: only ever fed into an inert <template> below.
  var raw = TT.createPolicy('helm', { createHTML: function (s) { return s; } });

  function sanitize(html) {
    var t = document.createElement('template');
    t.innerHTML = raw.createHTML(String(html));
    clean(t.content);
    return t.innerHTML;
  }

  var SCRIPT_PREFIXES = [
    'https://browser.sentry-cdn.com/8.35.0/',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/',
    'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/',
    'https://challenges.cloudflare.com/turnstile/',
    'https://checkout.razorpay.com/v1/checkout.js'   // /checkout only (CSP limits it to that page)
  ];
  // config.js loads the staging config with document.write on non-prod hosts.
  var CONFIG_WRITE = /^<script src="\/config\.staging\.js\?v=[\w.\-]+"><\/script>$/;

  try {
    TT.createPolicy('default', {
      createHTML: function (s) { s = String(s); return CONFIG_WRITE.test(s) ? s : sanitize(s); },
      createScriptURL: function (s) {
        var u; try { u = new URL(String(s), location.href); } catch (e) { return null; }
        if (u.origin === location.origin) return u.href;
        for (var i = 0; i < SCRIPT_PREFIXES.length; i++) if (u.href.indexOf(SCRIPT_PREFIXES[i]) === 0) return u.href;
        return null;                                                  // → blocked + reported
      },
      createScript: function () { return null; }                     // no string → code
    });
  } catch (e) { /* a default policy already exists (should not happen) */ }

  // Exposed for tests / tooling only: the sanitizer itself (returns a plain string).
  window.HelmSanitize = sanitize;
})();
