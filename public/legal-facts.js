/* =========================================================================
   legal-facts.js - r21: the ONE place for the company facts shown on the public legal pages
   (grievance, privacy, terms, DPA, refund, cookies, sub-processors, security, SLA, copyright,
   accessibility, AI notice, acceptable use, data deletion).

   OWNER: fill in the values below (plain text; e-mail addresses become mail links). Leave a
   value "" until it is final - the page then shows a small "To be updated" mark in that spot
   (the same wording everywhere, from this file only). Do not guess: these are legal facts.
   "confirm" items are notes on text that is already written on the page (e.g. the SLA target):
   set them to true once you have checked that text, and the mark disappears; or set a string to
   replace the mark with your own wording.
   Every page marks each spot as <span class="lg-ph" data-fact="key">To be updated</span>; without
   JavaScript the visitor sees "To be updated" (never a raw [OWNER TO FILL] placeholder).
   The list of keys (with what each one means) is in docs/security/OWNER-DASHBOARD-STEPS-R21.md, section G.
   ========================================================================= */
(function (root) {
  "use strict";
  var FACTS = {
    // ---- the company -----------------------------------------------------------------------
    legalEntityName: "",          // e.g. "Helm Events Private Limited" (exactly as registered)
    registeredAddress: "",        // full registered office address
    cin: "",                      // Company Identification Number (India) / trade licence no.
    gstin: "",                    // GSTIN shown on tax invoices
    uaeTrn: "",                   // UAE VAT TRN - only if registered, else leave "" and confirm below
    sacCode: "",                  // SAC code on invoices (terms say "e.g. 998314 / 998431"): your SAC, or true to confirm that text
    jurisdictionLaw: "",          // governing law, e.g. "the laws of India"
    jurisdictionSeat: "",         // courts / arbitration seat, e.g. "Hyderabad, India"
    paymentProcessor: "",         // e.g. "Razorpay Software Private Limited"
    hostingRegion: "",            // where the database runs, e.g. "AWS ca-central-1 (Canada)" or "ap-south-1 (Mumbai)"
    // ---- contacts ----------------------------------------------------------------------------
    grievanceOfficerName: "",     // a real person (DPDP Act s. 8(10), IT Rules 2021)
    grievanceOfficerDesignation: "",
    grievanceOfficerEmail: "",
    grievanceOfficerPhone: "",
    grievanceOfficerAddress: "",  // an address IN INDIA
    dpoName: "",                  // Data Protection Officer / privacy contact name
    privacyEmail: "",             // e.g. "privacy@helm.events"
    supportEmail: "",             // e.g. "support@helm.events"
    billingEmail: "",             // e.g. "billing@helm.events"
    legalEmail: "",               // e.g. "legal@helm.events"
    legalNotices: "",             // legal notices e-mail AND postal address (one line)
    securityEmail: "",            // e.g. "security@helm.events" (also in /.well-known/security.txt)
    accessibilityEmail: "",
    euRepresentative: "",         // GDPR Art. 27 - name and address, or "Not required" once confirmed by counsel
    ukRepresentative: "",         // UK GDPR Art. 27 - name and address, or "Not required"
    copyrightAgent: "",           // DMCA designated agent: name, e-mail, postal address
    dmcaDesignation: "",          // US Copyright Office DMCA designation number
    // ---- operations ----------------------------------------------------------------------------
    supportHours: "",             // e.g. "Mon-Sat 10:00-19:00 IST"
    statusPageUrl: "",            // e.g. "https://status.helm.events"
    accessibilityAuditDate: "",   // date of the last accessibility self-assessment, dd/mm/yyyy
    // ---- "confirm" notes on text already on the page (true = confirmed, mark removed) ---------------
    slaTargetConfirmed: "",       // sla: "Helm targets 99.5% Monthly Uptime"
    backupPlanConfirmed: "",      // security: "Daily automated database backups with point-in-time recovery"
    certificationConfirmed: "",   // security: "We do not currently hold a third-party certification"
    aiImportConfirmed: "",        // ai-notice: whether smart import runs locally or through an AI provider
    uaeRulesConfirmed: "",        // grievance: UAE PDPL timeline once the Executive Regulations are in force
    subprocessorsConfirmed: ""    // subprocessors: every provider, entity, region and signed DPA checked
  };
  var EMPTY = "To be updated", UNCONFIRMED = "To be confirmed";
  var CONFIRM = { slaTargetConfirmed: 1, backupPlanConfirmed: 1, certificationConfirmed: 1, aiImportConfirmed: 1, uaeRulesConfirmed: 1, subprocessorsConfirmed: 1, sacCode: 1 };
  var EMAIL = /^[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}$/i;

  function clean(v) { return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) : v; }
  // value for a data-fact spec ("a" or "a,b" = joined with ", "): { text, email, confirmed, missing }
  function resolve(spec, facts) {
    var f = facts || FACTS, keys = String(spec || "").split(",").map(function (k) { return k.trim(); }).filter(Boolean);
    if (!keys.length) return { missing: true, text: EMPTY };
    if (keys.length === 1 && CONFIRM[keys[0]]) {
      var c = f[keys[0]];
      if (c === true) return { confirmed: true, text: "" };
      if (typeof c === "string" && clean(c)) return { text: clean(c) };
      return { missing: true, text: UNCONFIRMED };
    }
    var vals = keys.map(function (k) { return clean(f[k]); }).filter(function (v) { return typeof v === "string" && v; });
    if (!vals.length || !clean(f[keys[0]])) return { missing: true, text: EMPTY };
    var text = vals.join(", ");
    return { text: text, email: keys.length === 1 && EMAIL.test(text) ? text : null };
  }
  function apply(doc, facts) {
    var d = doc || root.document; if (!d || !d.querySelectorAll) return 0;
    var n = 0;
    Array.prototype.forEach.call(d.querySelectorAll("[data-fact]"), function (elx) {
      var r = resolve(elx.getAttribute("data-fact"), facts);
      if (r.missing) { elx.textContent = r.text; elx.classList.add("lg-ph"); return; }
      n++;
      elx.classList.remove("lg-ph");
      if (r.confirmed) { elx.textContent = ""; elx.hidden = true; return; }
      elx.textContent = "";
      if (r.email) { var a = d.createElement("a"); a.href = "mailto:" + r.email; a.textContent = r.email; elx.appendChild(a); }
      else elx.textContent = r.text;
    });
    return n;
  }
  var api = { FACTS: FACTS, resolve: resolve, apply: apply, EMPTY: EMPTY, UNCONFIRMED: UNCONFIRMED, CONFIRM: CONFIRM };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.HelmLegalFacts = api;
    if (root.document) {
      if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", function () { apply(); });
      else apply();
    }
  }
})(typeof window !== "undefined" ? window : this);
