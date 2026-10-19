/* delivery-status.js - /delivery?t=<64 hex> (0241). The person responsible for a delivery / arrival answers in one
   tap without signing in: On the way, Arrived, Delayed (+ new time + note) or Problem (+ note). Talks only to the two
   public RPCs delivery_link_get / delivery_link_update (the token is the only key; the database keeps only its hash,
   scopes it to one delivery and expires it). Text only (textContent), no inline script. */
(function () {
  "use strict";
  var TOKEN_RE = /^[0-9a-f]{64}$/;
  var LABEL = { scheduled: "Scheduled", reminded: "Waiting for your reply", confirmed: "On the way", arrived: "Arrived", delayed: "Delayed",
    issue: "Problem reported", cancelled: "Cancelled" };
  var $ = function (id) { return document.getElementById(id); };
  var token = String(new URLSearchParams(location.search).get("t") || "").trim().toLowerCase();
  var cfg = window.SUPABASE_CONFIG || {};
  var base = String(cfg.url || "").replace(/\/+$/, "");
  var D = window.HelmDelivery || {};
  var cur = null, pending = null;

  function rpc(fn, body) {
    if (!base || !cfg.anonKey) return Promise.resolve({ ok: false, error: "config" });
    return fetch(base + "/rest/v1/rpc/" + fn, { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true, data: j } : { ok: false, error: String((j && j.message) || "") }; }, function () { return { ok: false, error: "" }; }); })
      .catch(function () { return { ok: false, error: "network" }; });
  }
  function fact(dl, k, v) { if (!v) return; var dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.appendChild(dt); dl.appendChild(dd); }
  function bad(title, msg) { $("ds-title").textContent = title; $("ds-msg").textContent = msg; $("ds-facts").hidden = true; $("ds-actions").hidden = true; $("ds-more").hidden = true; $("ds-now").hidden = true; }
  function render(d) {
    if (!d || d.ok !== true) {
      if (d && d.reason === "cancelled") return bad("This event has been cancelled", "This delivery link is no longer active - there is nothing more to do. Thank you.");   // r23-0260
      if (d && d.reason === "rate") return bad("Please wait a moment", "Too many tries from this link. Try again in a few minutes.");
      return bad("Link not valid", "This status link is not valid or has expired. Use the link in the latest reminder e-mail, or reply to it.");
    }
    cur = d;
    var item = String(d.what || "") + (Number(d.qty) > 0 ? " × " + Number(d.qty).toLocaleString("en-IN") : "");
    $("ds-title").textContent = item || "Delivery";
    $("ds-msg").textContent = "For " + (d.studio || "your event planner") + (d.party_name ? " · " + d.party_name : "");
    var dl = $("ds-facts"); while (dl.firstChild) dl.removeChild(dl.firstChild);
    fact(dl, "Event", (d.event || "") + (d.event_date ? " on " + d.event_date : ""));
    fact(dl, "Venue", d.venue || "");
    fact(dl, "Due", d.due_text || "");
    if (d.status === "delayed") fact(dl, "New time", d.eta_text || "");
    dl.hidden = false;
    $("ds-now").textContent = "Status now: " + (LABEL[d.status] || d.status);
    $("ds-now").hidden = false;
    var can = d.can_update === true;
    $("ds-actions").hidden = !can; $("ds-more").hidden = true;
    if (!can) $("ds-now").textContent += d.status === "cancelled" ? " - this delivery was cancelled, nothing more to do." : " - this link can no longer be updated.";
  }
  function more(status) {
    pending = status; $("ds-err").hidden = true;
    var delayed = status === "delayed", issue = status === "issue";
    $("ds-eta-l").hidden = !delayed; $("ds-eta").hidden = !delayed; $("ds-eta").value = "";
    $("ds-note-l").textContent = issue ? "What is the problem? (required)" : delayed ? "Reason (optional)" : "Note (optional)";
    $("ds-note").value = ""; $("ds-actions").hidden = true; $("ds-more").hidden = false;
    $("ds-send").textContent = status === "confirmed" ? "Confirm: on the way" : status === "arrived" ? "Confirm: arrived" : "Send";
    setTimeout(function () { (delayed ? $("ds-eta") : $("ds-note")).focus(); }, 0);
  }
  // hh:mm in the studio's zone -> the next such moment (today, or tomorrow when it is already more than an hour past)
  function etaIso(hm, tz) {
    if (!/^\d{2}:\d{2}$/.test(hm) || !D.zonedToIso || !D.isoToZoned) return null;
    var today = D.isoToZoned(new Date().toISOString(), tz).date, iso = D.zonedToIso(today, hm, tz);
    if (iso && Date.parse(iso) < Date.now() - 3600000) iso = new Date(Date.parse(iso) + 86400000).toISOString();
    return iso || null;
  }
  function send(ev) {
    if (ev) ev.preventDefault();
    var note = $("ds-note").value.trim(), eta = null;
    if (pending === "issue" && !note) { $("ds-err").textContent = "Please say what the problem is."; $("ds-err").hidden = false; $("ds-note").focus(); return; }
    if (pending === "delayed" && $("ds-eta").value) eta = etaIso($("ds-eta").value, (cur && cur.timezone) || "Asia/Kolkata");
    $("ds-send").disabled = true;
    rpc("delivery_link_update", { p_token: token, p_status: pending, p_note: note || null, p_eta: eta }).then(function (r) {
      $("ds-send").disabled = false;
      if (!r.ok) { $("ds-err").textContent = /new time/i.test(r.error) ? "Pick a time within the next 7 days." : "Could not save that just now. Please try again."; $("ds-err").hidden = false; return; }
      render(r.data);
      if (r.data && r.data.ok) { $("ds-now").textContent = "Thank you - " + (LABEL[r.data.status] || "update") + " sent to " + (r.data.studio || "the studio") + "."; }
    });
  }
  function start() {
    Array.prototype.forEach.call(document.querySelectorAll("#ds-actions [data-s]"), function (b) { b.addEventListener("click", function () { more(b.getAttribute("data-s")); }); });
    $("ds-more").addEventListener("submit", send);
    $("ds-back").addEventListener("click", function () { $("ds-more").hidden = true; $("ds-actions").hidden = false; });
    if (!TOKEN_RE.test(token)) return render(null);
    rpc("delivery_link_get", { p_token: token }).then(function (r) {
      if (!r.ok) return bad("Something went wrong", "We could not load this link just now. Please try again in a minute.");
      render(r.data);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
