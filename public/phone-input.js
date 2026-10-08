/* =========================================================================
   HelmPhone — international phone input (flag + country search + live format).

   HelmPhone.attach(input, {country, mobile}) turns any <input type="tel"> into:
     [🇮🇳 ▾ +91][ 98765 43210            ]
   with a searchable, keyboard-accessible country list (flag, name, dial code).
   The input KEEPS its id / label / aria, and its .value getter returns E.164
   ("+919876543210", or "" when empty), so every page that reads $("#x").value keeps
   working. Setting .value accepts E.164, "+44 7700 900123", "09876543210", etc.

   Rules (also used by HelmValidate + unit tests, no DOM needed):
     • digits only while typing (spaces, -, (, ), + are allowed and re-formatted);
     • a leading "+code" (or "00code") picks the country automatically;
     • 7–15 digits including the country code (E.164); per-country lengths for the
       countries in FORMATS; India mobile = 10 digits starting 6–9.
   Default country: opts.country → data-country → studio country (Control Center,
   cached in localStorage helm_org_country) → India.
   Builds DOM with createElement + textContent only. CSS lives in theme.css.
   ========================================================================= */
(function (global) {
  "use strict";

  // ISO|Name|dial — ~245 countries & territories. NANP islands carry their area code
  // (e.g. Jamaica 1876) so "+1 876…" resolves to Jamaica, plain "+1" to the USA.
  var RAW = "AF|Afghanistan|93;AX|Åland Islands|35818;AL|Albania|355;DZ|Algeria|213;AS|American Samoa|1684;AD|Andorra|376;AO|Angola|244;" +
    "AI|Anguilla|1264;AG|Antigua and Barbuda|1268;AR|Argentina|54;AM|Armenia|374;AW|Aruba|297;AC|Ascension Island|247;AU|Australia|61;" +
    "AT|Austria|43;AZ|Azerbaijan|994;BS|Bahamas|1242;BH|Bahrain|973;BD|Bangladesh|880;BB|Barbados|1246;BY|Belarus|375;BE|Belgium|32;" +
    "BZ|Belize|501;BJ|Benin|229;BM|Bermuda|1441;BT|Bhutan|975;BO|Bolivia|591;BA|Bosnia and Herzegovina|387;BW|Botswana|267;BR|Brazil|55;" +
    "IO|British Indian Ocean Territory|246;VG|British Virgin Islands|1284;BN|Brunei|673;BG|Bulgaria|359;BF|Burkina Faso|226;BI|Burundi|257;" +
    "KH|Cambodia|855;CM|Cameroon|237;CA|Canada|1;CV|Cape Verde|238;BQ|Caribbean Netherlands|599;KY|Cayman Islands|1345;" +
    "CF|Central African Republic|236;TD|Chad|235;CL|Chile|56;CN|China|86;CX|Christmas Island|6189164;CC|Cocos (Keeling) Islands|6189162;" +
    "CO|Colombia|57;KM|Comoros|269;CG|Congo|242;CD|Congo (DRC)|243;CK|Cook Islands|682;CR|Costa Rica|506;CI|Côte d’Ivoire|225;" +
    "HR|Croatia|385;CU|Cuba|53;CW|Curaçao|5999;CY|Cyprus|357;CZ|Czechia|420;DK|Denmark|45;DJ|Djibouti|253;DM|Dominica|1767;" +
    "DO|Dominican Republic|1809;EC|Ecuador|593;EG|Egypt|20;SV|El Salvador|503;GQ|Equatorial Guinea|240;ER|Eritrea|291;EE|Estonia|372;" +
    "SZ|Eswatini|268;ET|Ethiopia|251;FK|Falkland Islands|500;FO|Faroe Islands|298;FJ|Fiji|679;FI|Finland|358;FR|France|33;" +
    "GF|French Guiana|594;PF|French Polynesia|689;GA|Gabon|241;GM|Gambia|220;GE|Georgia|995;DE|Germany|49;GH|Ghana|233;GI|Gibraltar|350;" +
    "GR|Greece|30;GL|Greenland|299;GD|Grenada|1473;GP|Guadeloupe|590;GU|Guam|1671;GT|Guatemala|502;GG|Guernsey|441481;GN|Guinea|224;" +
    "GW|Guinea-Bissau|245;GY|Guyana|592;HT|Haiti|509;HN|Honduras|504;HK|Hong Kong|852;HU|Hungary|36;IS|Iceland|354;IN|India|91;" +
    "ID|Indonesia|62;IR|Iran|98;IQ|Iraq|964;IE|Ireland|353;IM|Isle of Man|441624;IL|Israel|972;IT|Italy|39;JM|Jamaica|1876;JP|Japan|81;" +
    "JE|Jersey|441534;JO|Jordan|962;KZ|Kazakhstan|76;KE|Kenya|254;KI|Kiribati|686;XK|Kosovo|383;KW|Kuwait|965;KG|Kyrgyzstan|996;LA|Laos|856;" +
    "LV|Latvia|371;LB|Lebanon|961;LS|Lesotho|266;LR|Liberia|231;LY|Libya|218;LI|Liechtenstein|423;LT|Lithuania|370;LU|Luxembourg|352;" +
    "MO|Macao|853;MG|Madagascar|261;MW|Malawi|265;MY|Malaysia|60;MV|Maldives|960;ML|Mali|223;MT|Malta|356;MH|Marshall Islands|692;" +
    "MQ|Martinique|596;MR|Mauritania|222;MU|Mauritius|230;YT|Mayotte|262269;MX|Mexico|52;FM|Micronesia|691;MD|Moldova|373;MC|Monaco|377;" +
    "MN|Mongolia|976;ME|Montenegro|382;MS|Montserrat|1664;MA|Morocco|212;MZ|Mozambique|258;MM|Myanmar|95;NA|Namibia|264;NR|Nauru|674;" +
    "NP|Nepal|977;NL|Netherlands|31;NC|New Caledonia|687;NZ|New Zealand|64;NI|Nicaragua|505;NE|Niger|227;NG|Nigeria|234;NU|Niue|683;" +
    "NF|Norfolk Island|672;KP|North Korea|850;MK|North Macedonia|389;MP|Northern Mariana Islands|1670;NO|Norway|47;OM|Oman|968;" +
    "PK|Pakistan|92;PW|Palau|680;PS|Palestine|970;PA|Panama|507;PG|Papua New Guinea|675;PY|Paraguay|595;PE|Peru|51;PH|Philippines|63;" +
    "PL|Poland|48;PT|Portugal|351;PR|Puerto Rico|1787;QA|Qatar|974;RE|Réunion|262;RO|Romania|40;RU|Russia|7;RW|Rwanda|250;" +
    "BL|Saint Barthélemy|590;SH|Saint Helena|290;KN|Saint Kitts and Nevis|1869;LC|Saint Lucia|1758;MF|Saint Martin|590;" +
    "PM|Saint Pierre and Miquelon|508;VC|Saint Vincent and the Grenadines|1784;WS|Samoa|685;SM|San Marino|378;ST|São Tomé and Príncipe|239;" +
    "SA|Saudi Arabia|966;SN|Senegal|221;RS|Serbia|381;SC|Seychelles|248;SL|Sierra Leone|232;SG|Singapore|65;SX|Sint Maarten|1721;" +
    "SK|Slovakia|421;SI|Slovenia|386;SB|Solomon Islands|677;SO|Somalia|252;ZA|South Africa|27;KR|South Korea|82;SS|South Sudan|211;" +
    "ES|Spain|34;LK|Sri Lanka|94;SD|Sudan|249;SR|Suriname|597;SJ|Svalbard and Jan Mayen|4779;SE|Sweden|46;CH|Switzerland|41;SY|Syria|963;" +
    "TW|Taiwan|886;TJ|Tajikistan|992;TZ|Tanzania|255;TH|Thailand|66;TL|Timor-Leste|670;TG|Togo|228;TK|Tokelau|690;TO|Tonga|676;" +
    "TT|Trinidad and Tobago|1868;TA|Tristan da Cunha|2908;TN|Tunisia|216;TR|Turkey|90;TM|Turkmenistan|993;TC|Turks and Caicos Islands|1649;" +
    "TV|Tuvalu|688;VI|U.S. Virgin Islands|1340;UG|Uganda|256;UA|Ukraine|380;AE|United Arab Emirates|971;GB|United Kingdom|44;" +
    "US|United States|1;UY|Uruguay|598;UZ|Uzbekistan|998;VU|Vanuatu|678;VA|Vatican City|3906698;VE|Venezuela|58;VN|Vietnam|84;" +
    "WF|Wallis and Futuna|681;EH|Western Sahara|212;YE|Yemen|967;ZM|Zambia|260;ZW|Zimbabwe|263;BV|Bouvet Island|47;" +
    "HM|Heard and McDonald Islands|672;GS|South Georgia|500;UM|U.S. Outlying Islands|1;AQ|Antarctica|672;PN|Pitcairn Islands|64;" +
    "TF|French Southern Territories|262;KZ2|Kazakhstan|77";
  // where several countries share a dial code, the one "+code" alone resolves to
  var PRIMARY = { "1": "US", "7": "RU", "44": "GB", "47": "NO", "61": "AU", "262": "RE", "590": "GP", "599": "BQ", "212": "MA", "672": "NF", "500": "FK", "64": "NZ" };

  var COUNTRIES = [], BY_ISO = {};
  RAW.split(";").forEach(function (row) {
    var p = row.split("|"); var iso = p[0].slice(0, 2);
    if (p[0].length > 2) { if (BY_ISO[iso]) BY_ISO[iso].alt = (BY_ISO[iso].alt || []).concat([p[2]]); return; }
    var c = { iso: iso, name: p[1], dial: p[2] };
    COUNTRIES.push(c); BY_ISO[iso] = c;
  });
  // "Display" dial code (+1 for Jamaica, +44 for Jersey, +61 for Christmas Island …)
  var SHORT = { "1": 1, "7": 1, "44": 1, "61": 1, "47": 1, "358": 1, "262": 1, "39": 1, "599": 1, "290": 1 };
  function shortDial(c) {
    for (var k in SHORT) if (c.dial.indexOf(k) === 0 && c.dial.length > k.length && SHORT[k]) return k;
    return c.dial;
  }
  COUNTRIES.forEach(function (c) { c.code = shortDial(c); });
  COUNTRIES.sort(function (a, b) { return a.name.localeCompare(b.name); });

  // Per-country national-number patterns (x = digit), keyed by national length.
  // mobile: a regexp the national number must match when the field is a MOBILE field.
  var FORMATS = {
    IN: { len: [10], pat: { 10: "xxxxx xxxxx" }, mobile: /^[6-9]/, mobileMsg: "Indian mobile numbers are 10 digits starting with 6, 7, 8 or 9.", ex: "98765 43210" },
    US: { len: [10], pat: { 10: "(xxx) xxx-xxxx" }, ex: "(201) 555-0123" },
    CA: { len: [10], pat: { 10: "(xxx) xxx-xxxx" }, ex: "(506) 234-5678" },
    GB: { len: [10], pat: { 10: "xxxx xxxxxx" }, ex: "7400 123456" },
    AE: { len: [8, 9], pat: { 8: "x xxx xxxx", 9: "xx xxx xxxx" }, ex: "50 123 4567" },
    SG: { len: [8], pat: { 8: "xxxx xxxx" }, ex: "8123 4567" },
    AU: { len: [9], pat: { 9: "xxx xxx xxx" }, ex: "412 345 678" },
    SA: { len: [9], pat: { 9: "xx xxx xxxx" }, ex: "51 234 5678" },
    QA: { len: [8], pat: { 8: "xxxx xxxx" }, ex: "3312 3456" },
    KW: { len: [8], pat: { 8: "xxxx xxxx" }, ex: "5001 2345" },
    OM: { len: [8], pat: { 8: "xxxx xxxx" }, ex: "9212 3456" },
    BH: { len: [8], pat: { 8: "xxxx xxxx" }, ex: "3600 1234" },
    MY: { len: [9, 10], pat: { 9: "xx-xxx xxxx", 10: "xx-xxxx xxxx" }, ex: "12-345 6789" },
    NP: { len: [8, 10], pat: { 8: "x-xxxxxxx", 10: "xxx-xxxxxxx" }, ex: "984-1234567" },
    LK: { len: [9], pat: { 9: "xx xxx xxxx" }, ex: "71 234 5678" },
    BD: { len: [10], pat: { 10: "xxxx-xxxxxx" }, ex: "1812-345678" },
    PK: { len: [10], pat: { 10: "xxx xxxxxxx" }, ex: "301 2345678" },
    FR: { len: [9], pat: { 9: "x xx xx xx xx" }, ex: "6 12 34 56 78" },
    ZA: { len: [9], pat: { 9: "xx xxx xxxx" }, ex: "71 123 4567" },
    NZ: { len: [8, 9, 10], pat: { 8: "xx xxx xxx", 9: "xx xxx xxxx", 10: "xx xxxx xxxx" }, ex: "21 123 4567" },
    DE: { len: [10, 11], pat: { 10: "xxxx xxxxxx", 11: "xxx xxxxxxxx" }, ex: "1512 3456789" },
  };
  var KEEP_ZERO = { IT: 1, SM: 1, VA: 1, CI: 1, CG: 1, GA: 1 };   // the leading 0 is part of the number

  var defaultIso = "IN";
  try { var saved = global.localStorage && global.localStorage.getItem("helm_org_country"); if (saved && BY_ISO[saved]) defaultIso = saved; } catch (e) {}

  function flag(iso) {
    iso = String(iso || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(iso)) return "";
    return String.fromCodePoint(0x1F1E6 + iso.charCodeAt(0) - 65, 0x1F1E6 + iso.charCodeAt(1) - 65);
  }
  function country(iso) { return BY_ISO[String(iso || "").toUpperCase()] || null; }
  function digits(s) { return String(s == null ? "" : s).replace(/\D/g, ""); }

  // longest dial-code prefix of a digit string → country (prefers `prefer` when it shares it)
  function matchDial(d, prefer) {
    var cands = [], bestLen = 0;
    for (var i = 0; i < COUNTRIES.length; i++) {
      var c = COUNTRIES[i], codes = [c.dial].concat(c.alt || []);
      for (var j = 0; j < codes.length; j++) {
        var k = codes[j];
        if (d.indexOf(k) !== 0) continue;
        if (k.length > bestLen) { bestLen = k.length; cands = [{ c: c, k: k }]; }
        else if (k.length === bestLen) cands.push({ c: c, k: k });
      }
    }
    if (!cands.length) return null;
    var pick = cands[0];
    for (var a = 0; a < cands.length; a++) if (cands[a].c.iso === prefer) { pick = cands[a]; break; }
    if (pick.c.iso !== prefer) for (var b = 0; b < cands.length; b++) if (PRIMARY[cands[b].k] === cands[b].c.iso) { pick = cands[b]; break; }
    // short display code (+1 / +44 …): the national number starts after the SHORT code
    return { country: pick.c, code: pick.c.code, national: d.slice(pick.c.code.length) };
  }

  // parse("…", "IN") → {iso, code, national}  (national = digits after the country code)
  function parse(raw, fallbackIso) {
    var s = String(raw == null ? "" : raw).trim();
    var fb = country(fallbackIso) || country(defaultIso) || BY_ISO.IN;
    if (!s) return { iso: fb.iso, code: fb.code, national: "" };
    var d = digits(s), intl = false;
    if (s.charAt(0) === "+") intl = true;
    else if (d.indexOf("00") === 0 && d.length > 6) { intl = true; d = d.slice(2); }
    if (intl) {
      var m = matchDial(d, fb.iso);
      if (m) return { iso: m.country.iso, code: m.code, national: m.national };
      return { iso: fb.iso, code: fb.code, national: d, unknown: true };
    }
    var f = FORMATS[fb.iso], max = f ? Math.max.apply(null, f.len) : 0;
    // "919876543210" typed into an India field: drop the repeated country code
    if (max && d.length === fb.code.length + max && d.indexOf(fb.code) === 0) d = d.slice(fb.code.length);
    if (d.charAt(0) === "0" && !KEEP_ZERO[fb.iso]) d = d.replace(/^0+/, "");
    return { iso: fb.iso, code: fb.code, national: d };
  }

  function applyPattern(d, pat) {
    var out = "", i = 0;
    for (var p = 0; p < pat.length && i < d.length; p++) {
      if (pat.charAt(p) === "x") out += d.charAt(i++);
      else out += pat.charAt(p);
    }
    if (i < d.length) out += d.slice(i);
    return out;
  }
  // as-you-type national formatting
  function format(national, iso) {
    var d = digits(national); if (!d) return "";
    var f = FORMATS[String(iso || "").toUpperCase()];
    if (f) {
      var lens = f.len.slice().sort(function (a, b) { return a - b; }), L = lens[lens.length - 1];
      for (var i = 0; i < lens.length; i++) if (d.length <= lens[i]) { L = lens[i]; break; }
      if (d.length <= L) return applyPattern(d, f.pat[L]);
      return d;   // longer than any valid length: show raw so the error is obvious
    }
    if (d.length <= 4) return d;
    var parts = []; for (var j = 0; j < d.length; j += 3) parts.push(d.slice(j, j + 3));
    if (parts.length > 1 && parts[parts.length - 1].length === 1) { var last = parts.pop(); parts[parts.length - 1] += last; }
    return parts.join(" ");
  }

  function toE164(iso, national) {
    var c = country(iso); var d = digits(national);
    if (!c || !d) return "";
    if (d.charAt(0) === "0" && !KEEP_ZERO[c.iso]) d = d.replace(/^0+/, "");
    return "+" + c.code + d;
  }
  // "+919876543210" → "+91 98765 43210"
  function display(e164, fallbackIso) {
    if (!e164) return "";
    var p = parse(e164, fallbackIso);
    return "+" + p.code + " " + format(p.national, p.iso);
  }

  // validate(value, {mobile, required, country}) → {ok, e164, error, empty}
  function validate(value, opts) {
    var o = opts || {};
    var p = (value && typeof value === "object") ? value : parse(value, o.country);
    var c = country(p.iso) || BY_ISO.IN, nat = digits(p.national);
    if (!nat) return o.required ? { ok: false, empty: true, error: o.requiredMsg || "Please enter a phone number." } : { ok: true, empty: true, e164: "" };
    if (p.unknown) return { ok: false, error: "We don't recognise that country code. Pick your country from the list." };
    var total = c.code.length + nat.length;
    var f = FORMATS[c.iso];
    if (f) {
      if (f.len.indexOf(nat.length) < 0) {
        var want = f.len.length === 1 ? f.len[0] + "-digit" : f.len.join(" or ") + "-digit";
        return { ok: false, error: (nat.length < Math.min.apply(null, f.len) ? "That number looks too short. " : "That number looks too long. ") + "Enter a " + want + " number for " + c.name + "." };
      }
      if (o.mobile && f.mobile && !f.mobile.test(nat)) return { ok: false, error: f.mobileMsg };
    } else {
      if (total < 7 || nat.length < 4) return { ok: false, error: "That number looks too short. Phone numbers have 7–15 digits including the country code." };
      if (total > 15) return { ok: false, error: "That number looks too long. Phone numbers have 7–15 digits including the country code." };
    }
    if (total > 15) return { ok: false, error: "That number looks too long. Phone numbers have 7–15 digits including the country code." };
    return { ok: true, e164: toE164(c.iso, nat) };
  }
  function setDefaultCountry(iso) { if (country(iso)) defaultIso = country(iso).iso; }
  function example(iso) { var f = FORMATS[iso]; return f ? f.ex : "123 456 7890"; }

  var API = {
    COUNTRIES: COUNTRIES, FORMATS: FORMATS, flag: flag, country: country, parse: parse, format: format,
    toE164: toE164, display: display, validate: validate, setDefaultCountry: setDefaultCountry,
    defaultCountry: function () { return defaultIso; }, example: example,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof document === "undefined") { global.HelmPhone = API; return; }

  /* ------------------------------------------------------------------ DOM */
  var doc = document, uid = 0;
  var NATIVE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function svgChevron() {
    var ns = "http://www.w3.org/2000/svg", s = doc.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "hp-chev");
    var p = doc.createElementNS(ns, "path"); p.setAttribute("d", "M4 6l4 4 4-4"); p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.8"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    s.appendChild(p); return s;
  }
  var openInst = null;
  doc.addEventListener("mousedown", function (e) { if (openInst && !openInst.wrap.contains(e.target)) openInst.close(false); }, true);

  function attach(input, opts) {
    if (!input || input.tagName !== "INPUT") return null;
    if (input.helmPhone) return input.helmPhone;
    var o = opts || {};
    var n = ++uid;
    var iso = (country(o.country || input.getAttribute("data-country")) || country(defaultIso) || BY_ISO.IN).iso;
    var userPicked = false;
    var mobile = o.mobile != null ? !!o.mobile : input.getAttribute("data-phone-mobile") === "1";
    var initial = NATIVE.get.call(input);

    var wrap = el("div", "hp");
    var btn = el("button", "hp-cc"); btn.type = "button";
    btn.setAttribute("aria-haspopup", "listbox"); btn.setAttribute("aria-expanded", "false");
    var fl = el("span", "hp-flag"); fl.setAttribute("aria-hidden", "true");
    var dl = el("span", "hp-dial"); dl.setAttribute("aria-hidden", "true");
    btn.appendChild(fl); btn.appendChild(svgChevron()); btn.appendChild(dl);
    var pop = el("div", "hp-pop"); pop.hidden = true;
    var sid = "hp" + n + "_s", lid = "hp" + n + "_l";
    var search = el("input", "hp-search"); search.type = "text"; search.id = sid;
    search.setAttribute("role", "combobox"); search.setAttribute("aria-controls", lid); search.setAttribute("aria-expanded", "true");
    search.setAttribute("aria-autocomplete", "list"); search.setAttribute("autocomplete", "off"); search.setAttribute("spellcheck", "false");
    search.setAttribute("placeholder", "Search country or code"); search.setAttribute("aria-label", "Search countries");
    search.setAttribute("data-no-validate", "1");
    var list = el("ul", "hp-list"); list.id = lid; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Countries");
    var empty = el("p", "hp-empty", "No country matches."); empty.hidden = true;
    pop.appendChild(search); pop.appendChild(list); pop.appendChild(empty);

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(btn); wrap.appendChild(input); wrap.appendChild(pop);
    input.classList.add("hp-num");
    input.setAttribute("type", "tel"); input.setAttribute("inputmode", "tel");
    if (!input.getAttribute("autocomplete") || input.getAttribute("autocomplete") === "off") input.setAttribute("autocomplete", "tel-national");
    input.setAttribute("maxlength", "24");
    input.setAttribute("data-phone-hardened", "1"); input.removeAttribute("data-no-country");

    function nat() { return digits(NATIVE.get.call(input)); }
    function paint() {
      var c = country(iso);
      fl.textContent = flag(c.iso); dl.textContent = "+" + c.code;
      btn.setAttribute("aria-label", "Country code: " + c.name + " +" + c.code + ". Change country");
      btn.title = c.name + " (+" + c.code + ")";
      if (!input.hasAttribute("data-ph-own")) input.setAttribute("placeholder", example(c.iso));
    }
    function show(nationalDigits) {
      var f = format(nationalDigits, iso);
      if (NATIVE.get.call(input) !== f) NATIVE.set.call(input, f);
    }
    // untouched values set by the page come back EXACTLY as given (never rewritten or
    // blanked just by being displayed — zero-data-loss); typing or picking a country
    // switches the field to E.164.
    var pristine = "", dirty = false;
    function setFrom(raw, byUser) {
      if (!byUser) { pristine = String(raw == null ? "" : raw).trim(); dirty = false; } else dirty = true;
      var p = parse(raw, iso);
      if (String(raw || "").trim()) iso = p.iso;
      paint(); show(p.national);
    }
    // keep author placeholders that aren't the old "+91…" hints
    var ph = input.getAttribute("placeholder") || "";
    if (ph && !/^\+?\d|…|\.\.\./.test(ph)) input.setAttribute("data-ph-own", "1");

    Object.defineProperty(input, "value", {
      configurable: true,
      get: function () { if (!dirty && pristine) return pristine; var r = NATIVE.get.call(input), d = digits(r); if (!d) return ""; return /^\s*\+/.test(r) ? "+" + d : toE164(iso, d); },
      set: function (v) { setFrom(v == null ? "" : String(v)); },
    });

    // live typing: allow digits, spaces, - ( ) and a leading +; re-format; keep the caret
    input.addEventListener("input", function () {
      dirty = true;
      var raw = NATIVE.get.call(input);
      var caret = input.selectionStart == null ? raw.length : input.selectionStart;
      var before = digits(raw.slice(0, caret)).length;
      if (/^\s*(\+|00)/.test(raw)) {
        var dd = digits(raw.replace(/^\s*00/, "+"));
        var m = dd ? matchDial(dd, iso) : null;
        if (m) {
          iso = m.country.iso; userPicked = true; paint(); show(m.national.slice(0, 15));
          try { var L = NATIVE.get.call(input).length; if (doc.activeElement === input) input.setSelectionRange(L, L); } catch (e) {}
        } else if (raw !== "+" + dd.slice(0, 4)) NATIVE.set.call(input, "+" + dd.slice(0, 4));
        return;
      }
      var d = digits(raw);
      if (d.charAt(0) === "0" && !KEEP_ZERO[iso] && d.length > 1) { d = d.replace(/^0+/, ""); before = Math.max(0, before - 1); }
      show(d.slice(0, 15));
      var shown = NATIVE.get.call(input), pos = 0, seen = 0;
      while (pos < shown.length && seen < before) { if (/\d/.test(shown.charAt(pos))) seen++; pos++; }
      try { if (doc.activeElement === input) input.setSelectionRange(pos, pos); } catch (e) {}
    });
    input.addEventListener("keydown", function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      if (!/[\d\s\-()+]/.test(e.key)) e.preventDefault();
    });
    input.addEventListener("paste", function (e) {
      var t = (e.clipboardData || global.clipboardData);
      var txt = t && t.getData ? t.getData("text") : "";
      if (!txt) return;
      e.preventDefault();
      setFrom(/^\s*(\+|00)/.test(txt) ? txt : NATIVE.get.call(input) + txt, true);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // ---- country list
    var built = false, items = [], active = -1, shownItems = [];
    function build() {
      if (built) return; built = true;
      var frag = doc.createDocumentFragment();
      COUNTRIES.forEach(function (c, i) {
        var li = el("li", "hp-opt"); li.id = "hp" + n + "_o" + i; li.setAttribute("role", "option");
        li.setAttribute("data-iso", c.iso);
        var f = el("span", "hp-oflag", flag(c.iso)); f.setAttribute("aria-hidden", "true");
        li.appendChild(f); li.appendChild(el("span", "hp-oname", c.name)); li.appendChild(el("span", "hp-ocode", "+" + c.code));
        li.addEventListener("mousedown", function (e) { e.preventDefault(); });
        li.addEventListener("click", function () { choose(c.iso); });
        items.push({ c: c, li: li, key: (c.name + " " + c.iso + " +" + c.code + " " + c.dial).toLowerCase() });
        frag.appendChild(li);
      });
      list.appendChild(frag);
    }
    function filter() {
      var q = search.value.trim().toLowerCase().replace(/^\+/, "");
      var qd = digits(q);
      shownItems = [];
      items.forEach(function (it) {
        var ok = !q || it.key.indexOf(q) >= 0 || (qd && qd === q && (it.c.code.indexOf(qd) === 0 || it.c.dial.indexOf(qd) === 0));
        if (q && !qd && ok) ok = it.c.name.toLowerCase().split(/[\s(]+/).some(function (w) { return w.indexOf(q) === 0; }) || it.c.iso.toLowerCase() === q || it.c.name.toLowerCase().indexOf(q) >= 0;
        it.li.hidden = !ok; if (ok) shownItems.push(it);
      });
      empty.hidden = shownItems.length > 0;
      setActive(shownItems.length ? 0 : -1);
    }
    function setActive(i) {
      if (active >= 0 && shownItems[active]) shownItems[active].li.classList.remove("is-active");
      active = i;
      if (i >= 0 && shownItems[i]) {
        var li = shownItems[i].li; li.classList.add("is-active");
        search.setAttribute("aria-activedescendant", li.id);
        var top = li.offsetTop, bot = top + li.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top; else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight;
      } else search.removeAttribute("aria-activedescendant");
    }
    function open() {
      if (input.disabled || input.readOnly) return;
      if (openInst && openInst !== inst) openInst.close(false);
      build();
      items.forEach(function (it) { it.li.setAttribute("aria-selected", it.c.iso === iso ? "true" : "false"); });
      search.value = ""; filter();
      pop.hidden = false; btn.setAttribute("aria-expanded", "true"); wrap.classList.add("is-open");
      var r = wrap.getBoundingClientRect(), vh = global.innerHeight || 800;
      wrap.classList.toggle("hp-up", r.bottom + 330 > vh && r.top > 330);
      for (var i = 0; i < shownItems.length; i++) if (shownItems[i].c.iso === iso) { setActive(i); break; }
      openInst = inst;
      setTimeout(function () { try { search.focus(); } catch (e) {} }, 0);
    }
    function close(refocus) {
      if (pop.hidden) return;
      pop.hidden = true; btn.setAttribute("aria-expanded", "false"); wrap.classList.remove("is-open");
      if (openInst === inst) openInst = null;
      if (refocus) try { btn.focus(); } catch (e) {}
    }
    function choose(newIso) {
      var d = nat();
      iso = newIso; userPicked = true; dirty = true; paint(); show(d);
      close(false);
      try { input.focus(); } catch (e) {}
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    btn.addEventListener("click", function () { if (pop.hidden) open(); else close(true); });
    btn.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
    });
    search.addEventListener("input", filter);
    search.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (shownItems.length) setActive(Math.min(shownItems.length - 1, active + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); if (shownItems.length) setActive(Math.max(0, active - 1)); }
      else if (e.key === "Home") { e.preventDefault(); setActive(shownItems.length ? 0 : -1); }
      else if (e.key === "End") { e.preventDefault(); setActive(shownItems.length - 1); }
      else if (e.key === "Enter") { e.preventDefault(); if (active >= 0 && shownItems[active]) choose(shownItems[active].c.iso); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "Tab") close(false);
    });

    var inst = {
      wrap: wrap, input: input, close: close, open: open,
      country: function () { return iso; },
      setCountry: function (c) { if (country(c)) { iso = country(c).iso; dirty = true; paint(); show(nat()); } },
      setDefault: function (c) { if (!userPicked && !nat() && country(c)) { iso = country(c).iso; paint(); } },
      national: nat,
      e164: function () { var d = nat(); return d ? toE164(iso, d) : ""; },
      validate: function (extra) { var x = extra || {}; return validate({ iso: iso, national: nat() }, { mobile: x.mobile != null ? x.mobile : mobile, required: x.required != null ? x.required : (input.required || input.getAttribute("aria-required") === "true") }); },
      display: function () { var d = nat(); return d ? "+" + country(iso).code + " " + format(d, iso) : ""; },
    };
    input.helmPhone = inst;
    insts.push(inst);
    setFrom(initial);
    return inst;
  }
  var insts = [];
  API.attach = attach;
  // studio country arrived (Control Center): untouched empty fields follow it
  API.setDefaultCountry = function (iso) { setDefaultCountry(iso); insts.forEach(function (i) { i.setDefault(defaultIso); }); };
  global.HelmPhone = API;
})(typeof window !== "undefined" ? window : globalThis);
