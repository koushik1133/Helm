/* auth-handoff.js (round 19) - login.html, loaded in <head> before anything paints.
   Right after an e-mail confirm link (/auth/confirm sets the one-shot sessionStorage flag bp_confirm_handoff),
   and whenever a signed-in session resumes on the sign-in page, the page shows ONE calm card
   ("Confirming your email…" -> "Setting up your free-trial studio…" -> "Opening your studio…") instead of
   flashing the sign-in / sign-up form while the studio is made. login.html ends it (HelmAuthHandoff.end())
   the moment it shows any real form (two-step code, onboarding, an error, ...). CSS lives in login.html
   (html.auth-handoff). External file: no inline script (hash-based CSP). */
(function (root) {
  "use strict";
  var KEY = "bp_confirm_handoff", MAX_AGE = 2 * 60 * 1000;
  // pure (unit-tested): is the one-shot flag fresh? stored = the flag value, now = Date.now()
  function fresh(stored, now) {
    var t = Number(stored);
    return isFinite(t) && t > 0 && now - t >= 0 && now - t < MAX_AGE;
  }
  var api = { KEY: KEY, MAX_AGE: MAX_AGE, fresh: fresh };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  var doc = root && root.document;
  if (!doc) return;
  var html = doc.documentElement, safety = null;
  function on() { return html.classList.contains("auth-handoff"); }
  function step(title, sub) {
    var a = doc.getElementById("hoTitle"), b = doc.getElementById("hoSub");
    if (a && title) a.textContent = title;
    if (b && sub != null) b.textContent = sub;
  }
  function end() {
    html.classList.remove("auth-handoff");
    if (safety) { clearTimeout(safety); safety = null; }
  }
  // never stuck: if nothing moved on after a minute, the normal page comes back
  function begin(title, sub) {
    html.classList.add("auth-handoff");
    if (title || sub != null) step(title, sub);
    if (safety) clearTimeout(safety);
    safety = setTimeout(end, 60 * 1000);
  }
  var flagged = false;
  try {
    var v = root.sessionStorage.getItem(KEY);
    if (v != null) { root.sessionStorage.removeItem(KEY); flagged = fresh(v, Date.now()); }   // one shot
  } catch (e) {}
  if (flagged) begin();
  api.on = on; api.begin = begin; api.end = end; api.step = step; api.flagged = function () { return flagged; };
  root.HelmAuthHandoff = api;
})(typeof window !== "undefined" ? window : globalThis);
