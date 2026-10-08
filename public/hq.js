/* hq.js — Helm HQ, the private platform-owner dashboard (migrations 0029 + 0045).
   Not linked from anywhere. Signed out → sign-in page. Signed in but not a
   platform operator → an ordinary "page not found" (the route never confirms it
   exists). The real control is in the database: every hq_* RPC is SECURITY
   DEFINER and refuses (42501) anyone not in public.platform_admins; every HQ
   write also needs a two-step (aal2) session and is audit-logged.
   0045: HQ shows NO studio business data — only studios, their people and what
   each studio paid Helm (subscription billing).
   External file — no inline script, so the hash-based CSP needs no change.
   All values are written with textContent / createElement (never parsed as HTML). */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var PAGE = 25, sOff = 0, uOff = 0, sTimer = null, uTimer = null, plans = [], lastBilling = null;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") e.textContent = attrs[k]; else if (k === "cls") e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function int(v) { return num(v).toLocaleString("en-IN"); }
  function money(v, cur) {
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: cur || "INR", maximumFractionDigits: 2 }).format(num(v)); }
    catch (e) { return (cur || "INR") + " " + num(v).toFixed(2); }
  }
  function moneyList(list) {
    list = Array.isArray(list) ? list : [];
    return list.length ? list.map(function (m) { return money(m.amount, m.currency); }).join(" + ") : money(0);
  }
  function date(v) { if (!v) return "—"; var d = new Date(v); return isNaN(d) ? "—" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); }
  function ago(v) {
    if (!v) return "never"; var d = (Date.now() - new Date(v).getTime()) / 864e5;
    if (!isFinite(d)) return "—"; if (d < 1) return "today"; if (d < 2) return "yesterday"; return Math.floor(d) + " days ago";
  }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function notFound() {
    document.title = "Page not found — Helm";
    $("#vLoading").hidden = true; $("#vApp").hidden = true; $("#vNotFound").hidden = false;
  }
  function showErr(e) { var b = $("#err"); b.textContent = "Couldn’t complete that: " + ((e && e.message) || "unknown error"); b.hidden = false; }
  function okMsg(t) { var b = $("#ok"); b.textContent = t; b.hidden = false; setTimeout(function () { b.hidden = true; }, 4000); }
  function call(fn, args) { return BPStore.hq(fn, args); }
  function statusPill(s) {
    var tone = { active: "ok", trial: "", past_due: "warn", suspended: "bad", cancelled: "", none: "" }[s || "none"];
    return el("span", { cls: "pill " + (tone || ""), text: (s || "none").replace("_", " ") });
  }
  function ask(text, def) { var r = window.prompt(text, def || ""); return r == null ? null : String(r).trim(); }
  function openInvoice(fn, id) {
    call(fn, { p_payment_id: id }).then(function (data) {
      if (window.HelmInvoice && typeof window.HelmInvoice.open === "function") window.HelmInvoice.open(data);
      else showErr(new Error("Invoice viewer not loaded"));
    }).catch(showErr);
  }

  /* ---------------- tabs ---------------- */
  var TABS = ["overview", "studios", "billing", "plans", "people", "activity"];
  function showTab(name) {
    TABS.forEach(function (t) {
      var p = $("#pane-" + t), b = $("#tab-" + t);
      if (p) p.hidden = t !== name;
      if (b) b.setAttribute("aria-pressed", t === name ? "true" : "false");
    });
  }

  /* ---------------- overview ---------------- */
  function kpi(label, value, sub, tone) {
    return el("div", { cls: "kpi" + (tone ? " " + tone : "") }, [el("div", { cls: "l", text: label }), el("div", { cls: "v", text: value }), sub ? el("div", { cls: "s", text: sub }) : null]);
  }
  function renderOverview(o) {
    o = o || {};
    var s = o.studios || {}, u = o.users || {}, b = o.billing || {}, bs = s.by_status || {};
    var k = clear($("#kpis"));
    k.appendChild(kpi("Studios", int(s.total), "+" + int(s.new_7d) + " in 7d · +" + int(s.new_30d) + " in 30d"));
    k.appendChild(kpi("MRR", moneyList(b.mrr), "active + past-due plans"));
    k.appendChild(kpi("Paid this month", moneyList(b.paid_this_month), "Helm subscription payments"));
    k.appendChild(kpi("Past due", int(b.past_due_count), int(b.reminders_pending) + " reminders queued", num(b.past_due_count) > 0 ? "warn" : ""));
    k.appendChild(kpi("Suspended", int(b.suspended_count), "read-only studios", num(b.suspended_count) > 0 ? "bad" : ""));
    k.appendChild(kpi("Users", int(u.total), int(u.active_7d) + " active in 7 days"));
    if (o.auth_logins_7d != null) k.appendChild(kpi("Sign-ins", int(o.auth_logins_7d), "last 7 days"));
    var st = clear($("#byStatus"));
    ["trial", "active", "past_due", "suspended", "cancelled", "none"].forEach(function (key) {
      st.appendChild(el("li", null, [statusPill(key), el("span", { cls: "muted", text: int(bs[key] || 0) + " studios" })]));
    });
    var mf = clear($("#mfa"));
    if (o.mfa) {
      var pct = Math.max(0, Math.min(100, num(o.mfa.pct)));
      mf.appendChild(el("div", null, [el("strong", { text: pct + "%" }), " of users (" + int(o.mfa.users_with_mfa) + " / " + int(o.mfa.users_total) + ")"]));
      var bar = el("div", { cls: "bar" }); var fill = el("i"); fill.style.width = pct + "%"; bar.appendChild(fill); mf.appendChild(bar);
    } else mf.appendChild(el("div", { cls: "empty", text: "Not available on this database." }));
  }

  /* ---------------- studios ---------------- */
  function pager(node, off, total, go) {
    clear(node);
    var from = total ? off + 1 : 0, to = Math.min(off + PAGE, total);
    node.appendChild(el("span", { text: from + "–" + to + " of " + total }));
    var prev = el("button", { cls: "btn", type: "button", text: "‹ Prev" }); prev.disabled = off <= 0;
    var next = el("button", { cls: "btn", type: "button", text: "Next ›" }); next.disabled = off + PAGE >= total;
    prev.addEventListener("click", function () { go(Math.max(0, off - PAGE)); });
    next.addEventListener("click", function () { go(off + PAGE); });
    node.appendChild(prev); node.appendChild(next);
  }
  async function loadStudios(off) {
    sOff = off || 0;
    var rows = await call("hq_studios", { p_search: $("#qStudios").value || null, p_status: $("#fStatus").value || null, p_limit: PAGE, p_offset: sOff });
    var tb = clear($("#tStudios")); rows = Array.isArray(rows) ? rows : [];
    rows.forEach(function (r) {
      var tr = el("tr", { cls: "click", tabindex: "0" }, [
        el("td", null, [el("strong", { text: r.name || "—" }), r.slug ? el("div", { cls: "muted", text: r.slug }) : null]),
        el("td", null, [r.primary_contact_name || r.owner_email || "—", el("div", { cls: "muted", text: [r.primary_contact_email, r.primary_contact_phone].filter(Boolean).join(" · ") })]),
        el("td", { text: [r.state, r.country].filter(Boolean).join(", ") || "—" }), el("td", { text: r.plan_name || "—" }), el("td", null, [statusPill(r.status)]),
        el("td", { text: date(r.current_period_end) }), el("td", { cls: "n", text: int(r.users_count) }),
        el("td", { cls: "n", text: money(r.total_paid) }), el("td", { text: ago(r.last_activity) })]);
      var open = function () { loadDetail(r.org_id).catch(showErr); };
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
      tb.appendChild(tr);
    });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "9", cls: "empty", text: "No studios match." })]));
    pager($("#pStudios"), sOff, rows.length ? num(rows[0].total_count) : 0, function (o) { loadStudios(o).catch(showErr); });
  }
  function field(label, input) { return el("label", { cls: "fld" }, [el("span", { text: label }), input]); }
  function paymentRows(tbody, list, withStudio, invoiceFn) {
    clear(tbody);
    (list || []).forEach(function (p) {
      var inv = el("button", { cls: "btn sm", type: "button", text: "Invoice" });
      inv.addEventListener("click", function () { openInvoice(invoiceFn || "hq_invoice", p.id); });
      var acts = el("td", null, [inv]);
      if (!p.voided) {
        var v = el("button", { cls: "btn sm danger", type: "button", text: "Void" });
        v.addEventListener("click", function () {
          var why = ask("Void payment " + (p.invoice_no || "") + " of " + money(p.amount, p.currency) + "? The row and invoice number are kept. Reason:");
          if (!why) return;
          call("hq_void_payment", { p_id: p.id, p_reason: why }).then(function () { okMsg("Payment voided."); refreshAfterWrite(p.org_id); }).catch(showErr);
        });
        acts.appendChild(v);
      }
      tbody.appendChild(el("tr", { cls: p.voided ? "void" : "" }, [
        el("td", { text: date(p.paid_on) }), withStudio ? el("td", { text: p.studio || "—" }) : null,
        el("td", { cls: "m", text: p.invoice_no || "—" }), el("td", { text: p.method || "—" }),
        el("td", { text: (p.period_start ? date(p.period_start) + " – " + date(p.period_end) : "—") }),
        el("td", { cls: "n", text: money(p.amount, p.currency) }),
        el("td", null, [p.voided ? el("span", { cls: "pill bad", text: "void" }) : el("span", { cls: "pill ok", text: "paid" })]), acts]));
    });
    if (!tbody.firstChild) tbody.appendChild(el("tr", null, [el("td", { colspan: withStudio ? "8" : "7", cls: "empty", text: "No payments." })]));
  }
  var openOrg = null;
  function refreshAfterWrite(org) {
    if (org && openOrg === org) loadDetail(org).catch(showErr);
    loadStudios(sOff).catch(showErr); loadBilling().catch(showErr); call("hq_overview").then(renderOverview).catch(showErr);
  }
  async function loadDetail(org) {
    var d = await call("hq_studio_detail", { p_org: org }); var box = clear($("#studioDetail"));
    if (!d) return; openOrg = org;
    var sub = d.subscription || {};
    var wrap = el("div", { cls: "detail" }, [el("h2", { text: d.name || "Studio" }),
      el("div", { cls: "muted", text: [d.slug, "created " + date(d.created_at), int(d.users_count) + " people"].filter(Boolean).join(" · ") })]);

    // subscription
    wrap.appendChild(el("h3", { text: "Subscription" }));
    wrap.appendChild(el("div", null, [statusPill(sub.status || d.status), " ", (sub.plan_name || "No plan"),
      sub.price_monthly != null ? " · " + money(sub.price_monthly, sub.currency) + "/month" : "",
      sub.current_period_end ? " · period ends " + date(sub.current_period_end) : "",
      sub.trial_ends_at ? " · trial ends " + date(sub.trial_ends_at) : ""]));
    if (sub.status === "suspended") wrap.appendChild(el("div", { cls: "muted", text: "Suspended " + date(sub.suspended_at) + " — " + (sub.suspend_reason || "") }));
    var selPlan = el("select", { "aria-label": "Plan" }); selPlan.appendChild(el("option", { value: "", text: "(keep plan)" }));
    plans.filter(function (p) { return p.active; }).forEach(function (p) { selPlan.appendChild(el("option", { value: p.code, text: p.name + " · " + money(p.price_monthly, p.currency) })); });
    var selSt = el("select", { "aria-label": "Status" });
    [["", "(keep status)"], ["trial", "trial"], ["active", "active"], ["past_due", "past due"], ["cancelled", "cancelled"]].forEach(function (o) { selSt.appendChild(el("option", { value: o[0], text: o[1] })); });
    var ps = el("input", { type: "date" }), pe = el("input", { type: "date" }), te = el("input", { type: "date" });
    var save = el("button", { cls: "btn primary", type: "button", text: "Save subscription" });
    save.addEventListener("click", function () {
      save.disabled = true;
      call("hq_set_subscription", { p_org: org, p_plan_code: selPlan.value || null, p_status: selSt.value || null, p_trial_ends_at: te.value || null,
        p_period_start: ps.value || null, p_period_end: pe.value || null, p_notes: null })
        .then(function () { okMsg("Subscription saved."); refreshAfterWrite(org); }).catch(showErr).then(function () { save.disabled = false; });
    });
    wrap.appendChild(el("div", { cls: "form" }, [field("Plan", selPlan), field("Status", selSt), field("Period start", ps), field("Period end", pe), field("Trial ends", te), save]));
    var sus = el("button", { cls: "btn " + (sub.status === "suspended" ? "" : "danger"), type: "button", text: sub.status === "suspended" ? "Reactivate studio" : "Suspend (read-only)…" });
    sus.addEventListener("click", function () {
      if (sub.status === "suspended") {
        if (!window.confirm("Reactivate " + (d.name || "this studio") + "? Members can create and change data again.")) return;
        call("hq_reactivate_studio", { p_org: org }).then(function () { okMsg("Studio reactivated."); refreshAfterWrite(org); }).catch(showErr);
      } else {
        var why = ask("Suspend " + (d.name || "this studio") + "? Members can still sign in, view and export, but cannot create, change or delete anything. No data is touched. Reason:");
        if (!why) return;
        call("hq_suspend_studio", { p_org: org, p_reason: why }).then(function () { okMsg("Studio suspended (read-only)."); refreshAfterWrite(org); }).catch(showErr);
      }
    });
    wrap.appendChild(el("div", { cls: "actions" }, [sus]));

    // account profile (business account data only)
    var acc = d.account || {};
    wrap.appendChild(el("h3", { text: "Account" }));
    var AF = [["legal_business_name", "Legal name"], ["gstin", "GSTIN"], ["country", "Country (ISO-2)"], ["state", "State"], ["city", "City"],
      ["billing_address", "Billing address"], ["website", "Website"], ["timezone", "Timezone"], ["primary_contact_name", "Primary contact"],
      ["primary_contact_email", "Primary e-mail"], ["primary_contact_phone", "Primary phone"], ["secondary_contact_name", "Secondary contact"],
      ["secondary_contact_email", "Secondary e-mail"], ["secondary_contact_phone", "Secondary phone"], ["billing_contact_email", "Billing e-mail"],
      ["team_size_band", "Team size (1, 2-5, 6-15, 16-50, 51+)"], ["signup_source", "Signup source"],
      ["business_type", "Business type"], ["is_business", "Business (true/false)"], ["tax_id_type", "Tax ID type"], ["tax_id", "Tax ID"], ["pan", "PAN (India)"],
      ["billing_currency", "Billing currency"], ["payment_mandate_ref", "Mandate reference"], ["referral_code", "Referral code"], ["referred_by", "Referred by"]];
    var inputs = {};
    var af = el("div", { cls: "form" });
    AF.forEach(function (f) { var i = el("input", { type: /_phone$/.test(f[0]) ? "tel" : (/_email$/.test(f[0]) ? "email" : "text") }); i.value = acc[f[0]] == null ? "" : String(acc[f[0]]); inputs[f[0]] = i; af.appendChild(field(f[1], i)); });
    var asave = el("button", { cls: "btn", type: "button", text: "Save account" });
    asave.addEventListener("click", function () {
      var patch = {}; AF.forEach(function (f) { var v = String(inputs[f[0]].value || "").trim(); if (v !== (acc[f[0]] == null ? "" : String(acc[f[0]]))) patch[f[0]] = v; });
      call("hq_set_studio_account", { p_org: org, p_account: patch }).then(function () { okMsg("Account saved."); refreshAfterWrite(org); }).catch(showErr);
    });
    af.appendChild(asave); wrap.appendChild(af);

    // members (no phone, no client data)
    wrap.appendChild(el("h3", { text: "People" }));
    var mt = el("tbody");
    (d.members || []).forEach(function (m) {
      mt.appendChild(el("tr", null, [el("td", { text: m.display_name || "—" }), el("td", { cls: "m", text: m.email || "—" }), el("td", { text: m.role || "—" }),
        el("td", null, [el("span", { cls: "pill " + (m.active ? "ok" : "bad"), text: m.active ? "active" : "inactive" })]),
        el("td", { text: ago(m.last_sign_in_at) }), el("td", null, [el("span", { cls: "pill " + (m.mfa_enabled ? "ok" : ""), text: m.mfa_enabled ? "on" : "off" })])]));
    });
    wrap.appendChild(el("div", { cls: "scroll" }, [el("table", null, [el("thead", null, [el("tr", null, ["Name", "E-mail", "Role", "Status", "Last sign-in", "2-step"].map(function (h) { return el("th", { text: h }); }))]), mt])]));

    // payments
    wrap.appendChild(el("h3", { text: "Payments to Helm" }));
    var pt = el("tbody"); paymentRows(pt, d.payments, false);
    wrap.appendChild(el("div", { cls: "scroll" }, [el("table", null, [el("thead", null, [el("tr", null, ["Paid on", "Invoice", "Method", "Period", "Amount", "Status", ""].map(function (h) { return el("th", { text: h }); }))]), pt])]));
    var rec = el("button", { cls: "btn", type: "button", text: "Record a payment for this studio" });
    rec.addEventListener("click", function () { showTab("billing"); $("#rOrg").value = org; $("#rOrgName").textContent = d.name || ""; });
    var cl = el("button", { cls: "btn", type: "button", text: "Close" }); cl.addEventListener("click", function () { openOrg = null; clear(box); });
    wrap.appendChild(el("div", { cls: "actions" }, [rec, cl]));
    box.appendChild(wrap); try { wrap.scrollIntoView({ block: "nearest" }); } catch (e) {}
  }

  /* ---------------- people ---------------- */
  async function loadUsers(off) {
    uOff = off || 0;
    var rows = await call("hq_users", { p_search: $("#qUsers").value || null, p_limit: PAGE, p_offset: uOff });
    var tb = clear($("#tUsers")); rows = Array.isArray(rows) ? rows : [];
    rows.forEach(function (r) {
      tb.appendChild(el("tr", null, [el("td", { cls: "m", text: r.email || "—" }), el("td", { text: r.studio || "—" }), el("td", { text: r.role || "—" }),
        el("td", { text: date(r.created_at) }), el("td", { text: ago(r.last_sign_in_at) }),
        el("td", null, [el("span", { cls: "pill " + (r.email_confirmed ? "ok" : "warn"), text: r.email_confirmed ? "yes" : "no" })]),
        el("td", null, [el("span", { cls: "pill " + (r.mfa_enabled ? "ok" : ""), text: r.mfa_enabled ? "on" : "off" })])]));
    });
    if (!rows.length) tb.appendChild(el("tr", null, [el("td", { colspan: "7", cls: "empty", text: "No users match." })]));
    pager($("#pUsers"), uOff, rows.length ? num(rows[0].total_count) : 0, function (o) { loadUsers(o).catch(showErr); });
  }

  /* ---------------- billing ---------------- */
  async function loadBilling() {
    var r = await call("hq_billing", { p_from: $("#bFrom").value || null, p_to: $("#bTo").value || null });
    r = r && !Array.isArray(r) ? r : {}; lastBilling = r;
    var k = clear($("#bKpis"));
    k.appendChild(kpi("Collected", moneyList(r.collected), int(r.payments_count) + " payments · " + int(r.voided_count) + " void"));
    k.appendChild(kpi("MRR", moneyList(r.mrr), "active + past-due"));
    k.appendChild(kpi("Past due", int((r.past_due || []).length), "studios", (r.past_due || []).length ? "warn" : ""));
    paymentRows(clear($("#tPay")), r.payments, true);
    var pd = clear($("#pastDue"));
    (r.past_due || []).forEach(function (x) { pd.appendChild(el("li", null, [el("span", { text: x.name || "—" }), el("span", { cls: "muted", text: (x.plan_code || "") + " · ended " + date(x.current_period_end) + " · " + int(x.days_overdue) + " days" })])); });
    if (!pd.firstChild) pd.appendChild(el("li", { cls: "empty", text: "No studio is past due." }));
    var rm = clear($("#reminders"));
    (r.reminders || []).slice(0, 30).forEach(function (x) { rm.appendChild(el("li", null, [el("span", { text: (x.studio || "—") + " · " + String(x.kind || "").replace("_", " ") }), el("span", { cls: "muted", text: "period " + date(x.period_end) + " · " + (x.sent_at ? "sent " + date(x.sent_at) + " (" + (x.channel || "") + ")" : "queued") })])); });
    if (!rm.firstChild) rm.appendChild(el("li", { cls: "empty", text: "No reminders." }));
    var ux = await call("hq_unrealised_exports"); ux = Array.isArray(ux) ? ux : [];
    var ul = clear($("#unrealised"));
    ux.forEach(function (p) {
      var b = el("button", { cls: "btn sm", type: "button", text: "Mark realised" });
      b.addEventListener("click", function () {
        var ref = ask("FIRA / FIRC reference for " + (p.invoice_no || "") + ":"); if (!ref) return;
        var on = ask("Realised on (YYYY-MM-DD):", iso(new Date())); if (!on) return;
        call("hq_record_realisation", { p_id: p.id, p_fira_firc_ref: ref, p_realised_on: on }).then(function () { okMsg("Realisation recorded."); loadBilling().catch(showErr); }).catch(showErr);
      });
      ul.appendChild(el("li", null, [el("span", { text: (p.studio || "—") + " · " + (p.invoice_no || "") + " · " + money(p.amount, p.currency) }), el("span", { cls: "muted", text: (p.tax_regime || "") + " · " + date(p.paid_on) }), b]));
    });
    if (!ul.firstChild) ul.appendChild(el("li", { cls: "empty", text: "Every export payment is realised." }));
  }
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;           // spreadsheet formula injection guard
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function exportCsv() {
    var r = lastBilling || {}, rows = [["paid_on", "studio", "invoice_no", "amount", "currency", "net_amount", "gst_amount", "method", "reference", "period_start", "period_end", "status", "void_reason"]];
    (r.payments || []).forEach(function (p) {
      rows.push([p.paid_on, p.studio, p.invoice_no, p.amount, p.currency, p.net_amount, p.gst_amount, p.method, p.reference, p.period_start, p.period_end, p.voided ? "void" : "paid", p.void_reason]);
    });
    var csv = rows.map(function (x) { return x.map(csvCell).join(","); }).join("\r\n");
    var url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    var a = el("a", { href: url, download: "helm-billing-" + (r.from || "") + "-to-" + (r.to || "") + ".csv" });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function recordPayment() {
    var org = $("#rOrg").value;
    if (!org) { showErr(new Error("Open a studio (Studios tab) and choose “Record a payment”, or paste its id.")); return; }
    var amt = Number($("#rAmount").value);
    if (!(amt > 0)) { showErr(new Error("Amount must be more than 0")); return; }
    var b = $("#btnRecord"); b.disabled = true;
    call("hq_record_payment", { p_org: org, p_amount: amt, p_paid_on: $("#rPaidOn").value || iso(new Date()), p_method: $("#rMethod").value,
      p_currency: ($("#rCur").value || "INR").toUpperCase(), p_fx_rate_to_inr: $("#rFx").value ? Number($("#rFx").value) : null, p_period_start: $("#rPs").value || null, p_period_end: $("#rPe").value || null, p_reference: $("#rRef").value || null })
      .then(function (p) { okMsg("Payment recorded" + (p && p.invoice_no ? " — invoice " + p.invoice_no : "") + "."); $("#rAmount").value = ""; $("#rRef").value = ""; refreshAfterWrite(org); })
      .catch(showErr).then(function () { b.disabled = false; });
  }
  async function loadSettings() {
    var s = await call("hq_billing_settings"); s = s && !Array.isArray(s) ? s : {};
    $("#sName").value = s.legal_name || ""; $("#sGstin").value = s.gstin || ""; $("#sAddr").value = s.address || "";
    $("#sState").value = s.seller_state || ""; $("#sCountry").value = s.seller_country || "IN";
    $("#sLut").value = s.lut_number || ""; $("#sLutFrom").value = s.lut_valid_from || ""; $("#sLutTo").value = s.lut_valid_to || "";
    $("#sRate").value = s.gst_rate != null ? s.gst_rate : 18; $("#sPrefix").value = s.invoice_prefix != null ? s.invoice_prefix : "HELM-";
  }
  function saveSettings() {
    call("hq_set_billing_settings", { p_legal_name: $("#sName").value, p_gstin: $("#sGstin").value || null, p_address: $("#sAddr").value || null,
      p_gst_rate: Number($("#sRate").value), p_invoice_prefix: $("#sPrefix").value })
      .then(function () { return call("hq_set_seller_tax", { p_seller_country: $("#sCountry").value || "IN", p_seller_state: $("#sState").value || null,
        p_lut_number: $("#sLut").value || null, p_lut_valid_from: $("#sLutFrom").value || null, p_lut_valid_to: $("#sLutTo").value || null }); }).then(function () { okMsg("Invoice settings saved — used for new payments."); }).catch(showErr);
  }

  /* ---------------- plans ---------------- */
  async function loadPlans() {
    var r = await call("hq_plans"); plans = Array.isArray(r) ? r : [];
    var tb = clear($("#tPlans"));
    plans.forEach(function (p) {
      var edit = el("button", { cls: "btn sm", type: "button", text: "Edit" });
      edit.addEventListener("click", function () { $("#plCode").value = p.code; $("#plName").value = p.name; $("#plPrice").value = p.price_monthly; $("#plActive").checked = !!p.active; });
      tb.appendChild(el("tr", null, [el("td", { cls: "m", text: p.code }), el("td", { text: p.name }), el("td", { cls: "n", text: money(p.price_monthly, p.currency) }),
        el("td", null, [el("span", { cls: "pill " + (p.active ? "ok" : ""), text: p.active ? "active" : "hidden" })]), el("td", { cls: "n", text: int(p.studios) }), el("td", null, [edit])]));
    });
    var tr = await call("hq_tax_rules"); tr = Array.isArray(tr) ? tr : [];
    var tt = clear($("#tTax"));
    tr.forEach(function (x) { tt.appendChild(el("tr", null, [el("td", { text: x.country + (x.region ? " · " + x.region : "") }), el("td", { cls: "m", text: x.regime }),
      el("td", { cls: "n", text: num(x.rate) + "%" }), el("td", { text: date(x.effective_from) + " – " + (x.effective_to ? date(x.effective_to) : "open") }),
      el("td", null, [el("span", { cls: "pill " + (x.active ? "ok" : ""), text: x.active ? "active" : "off" })]), el("td", { text: x.invoice_note || "" })])); });
    if (!plans.length) tb.appendChild(el("tr", null, [el("td", { colspan: "6", cls: "empty", text: "No plans yet — add one below." })]));
  }
  function saveTaxRule() {
    call("hq_upsert_tax_rule", { p_country: $("#txCountry").value, p_region: $("#txRegion").value || null, p_regime: $("#txRegime").value,
      p_rate: Number($("#txRate").value), p_invoice_note: $("#txNote").value || null, p_effective_from: $("#txFrom").value || null,
      p_effective_to: $("#txTo").value || null, p_active: $("#txActive").checked }).then(function () { okMsg("Tax rule saved."); loadPlans().catch(showErr); }).catch(showErr);
  }
  function savePlan() {
    call("hq_upsert_plan", { p_code: $("#plCode").value, p_name: $("#plName").value, p_price_monthly: Number($("#plPrice").value), p_currency: "INR", p_active: $("#plActive").checked })
      .then(function () { okMsg("Plan saved."); loadPlans().catch(showErr); }).catch(showErr);
  }

  /* ---------------- activity + operators ---------------- */
  async function loadAudit() {
    var r = await call("hq_audit", { p_from: $("#aFrom").value || null, p_to: $("#aTo").value || null }); r = r && !Array.isArray(r) ? r : {};
    var tb = clear($("#tAudit")), writesOnly = $("#aWrites").checked;
    (r.rows || []).filter(function (x) { return !writesOnly || x.action !== "hq.view"; }).slice(0, 500).forEach(function (x) {
      tb.appendChild(el("tr", null, [el("td", { text: x.at ? new Date(x.at).toLocaleString("en-IN") : "—" }), el("td", { cls: "m", text: x.actor_email || "system" }),
        el("td", { cls: "m", text: x.action || "" }), el("td", { text: (x.entity || "") + (x.entity_id ? " · " + x.entity_id : "") })]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "No HQ activity in this range." })]));
  }
  // 0054: cross-studio security feed (operators only; names, no e-mails)
  async function loadSecurity() {
    var r = await call("hq_security_alerts", { p_from: $("#aFrom").value || null, p_to: $("#aTo").value || null }); r = r && !Array.isArray(r) ? r : {};
    $("#secTotal").textContent = int(r.total) + " event" + (num(r.total) === 1 ? "" : "s");
    var tb = clear($("#tSec"));
    (r.by_studio || []).forEach(function (x) {
      tb.appendChild(el("tr", null, [el("td", { text: "🛡️ " + (x.label || x.type || "") }), el("td", { text: x.studio || "—" }),
        el("td", { cls: "n", text: int(x.count) }), el("td", { text: x.latest ? new Date(x.latest).toLocaleString("en-IN") : "—" })]));
    });
    if (!tb.firstChild) tb.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "No security events in this range." })]));
    var tl = clear($("#tSecLatest"));
    (r.latest || []).slice(0, 100).forEach(function (x) {
      var who = [x.actor_name ? "by " + x.actor_name : "", x.subject_name || ""].filter(Boolean).join(" · ");
      tl.appendChild(el("tr", null, [el("td", { text: x.at ? new Date(x.at).toLocaleString("en-IN") : "—" }), el("td", { text: x.label || x.type || "" }),
        el("td", { text: x.studio || "—" }), el("td", { text: who || "—" })]));
    });
    if (!tl.firstChild) tl.appendChild(el("tr", null, [el("td", { colspan: "4", cls: "empty", text: "Nothing yet." })]));
  }
  async function loadOperators() {
    var r = await call("hq_operators"); r = Array.isArray(r) ? r : [];
    var ul = clear($("#operators"));
    r.forEach(function (o) {
      var right = el("span", { cls: "muted", text: (o.mfa_enabled ? "2-step on" : "2-step off") + " · " + ago(o.last_sign_in_at) + (o.is_me ? " · you" : "") });
      var li = el("li", null, [el("span", { cls: "m", text: o.email }), right]);
      if (!o.is_me) {
        var rm = el("button", { cls: "btn sm danger", type: "button", text: "Remove" });
        rm.addEventListener("click", function () {
          if (!window.confirm("Remove " + o.email + " from Helm HQ?")) return;
          call("hq_remove_operator", { p_email: o.email }).then(function () { okMsg("Operator removed."); loadOperators().catch(showErr); }).catch(showErr);
        });
        li.appendChild(rm);
      }
      ul.appendChild(li);
    });
  }
  function addOperator() {
    var e = String($("#opEmail").value || "").trim(); if (!e) return;
    if (!window.confirm("Give " + e + " full Helm HQ access? They must sign in with two-step verification.")) return;
    call("hq_add_operator", { p_email: e }).then(function () { $("#opEmail").value = ""; okMsg("Operator added."); loadOperators().catch(showErr); }).catch(showErr);
  }

  async function loadAll() {
    $("#err").hidden = true;
    var r = await Promise.all([call("hq_overview"), loadPlans(), loadStudios(0), loadUsers(0), loadBilling()]);
    renderOverview(r[0] || {});
  }

  // Who may see HQ, decided BEFORE any hq_* data is requested:
  //   signed out / a sign-in step pending (incl. the two-step code) → sign-in page
  //   not a platform operator                                         → ordinary 404
  //   operator without a verified authenticator, or session < aal2    → sign-in page,
  //     which forces set-up / the code (no skip); "unknown" fails closed the same way
  //   operator at aal2                                                → HQ
  // Authenticators are only looked at after is_platform_admin() said yes.
  async function gate() {
    if (!BPStore.auth.pendingUser()) return "login";
    if (BPStore.auth.pendingStep()) return "login";
    var step = BPStore.auth.mfa && BPStore.auth.mfa.operatorStep ? await BPStore.auth.mfa.operatorStep() : "unknown";
    if (step === "none") return "notfound";
    return step === "ok" ? "hq" : "login";
  }

  function on(id, ev, fn) { var n = $(id); if (n) n.addEventListener(ev, fn); }
  async function start() {
    try { await BPStore.init(); } catch (e) { notFound(); return; }
    if (!BPStore.auth.enabled()) { notFound(); return; }
    BPStore.auth.required();
    var g = "notfound";
    try { g = await gate(); } catch (e) { g = "notfound"; }
    if (g === "login") { location.replace("login.html"); return; }
    if (g !== "hq") { notFound(); return; }
    var today = new Date(), month = new Date(today.getFullYear(), today.getMonth(), 1), past = new Date(Date.now() - 30 * 864e5);
    $("#bFrom").value = iso(month); $("#bTo").value = iso(today); $("#aFrom").value = iso(past); $("#aTo").value = iso(today); $("#rPaidOn").value = iso(today);
    try { await loadAll(); }
    catch (e) { notFound(); return; }   // any failure on first load looks like a missing page — never reveal HQ exists
    document.title = "Helm HQ";
    $("#who").textContent = (BPStore.auth.user() && BPStore.auth.user().email) || "";
    $("#vLoading").hidden = true; $("#vApp").hidden = false;
    showTab("overview");

    TABS.forEach(function (t) { on("#tab-" + t, "click", function () {
      showTab(t);
      if (t === "activity") { loadAudit().catch(showErr); loadSecurity().catch(showErr); loadOperators().catch(showErr); }
      if (t === "billing") loadSettings().catch(showErr);
    }); });
    on("#btnRefresh", "click", function () { loadAll().catch(showErr); });
    on("#btnOut", "click", function () { Promise.resolve(BPStore.auth.signOut && BPStore.auth.signOut()).finally(function () { location.replace("login.html"); }); });
    on("#btnBill", "click", function () { loadBilling().catch(showErr); });
    on("#btnCsv", "click", exportCsv);
    on("#btnRecord", "click", recordPayment);
    on("#btnSettings", "click", saveSettings);
    on("#btnPlan", "click", savePlan);
    on("#btnTax", "click", saveTaxRule);
    on("#btnAudit", "click", function () { loadAudit().catch(showErr); loadSecurity().catch(showErr); });
    on("#aWrites", "change", function () { loadAudit().catch(showErr); });
    on("#btnOp", "click", addOperator);
    on("#btnRefreshBilling", "click", function () { call("hq_refresh_billing_status").then(function (r) { okMsg("Billing status refreshed: " + int(r && r.past_due_set) + " now past due, " + int(r && r.reminders_queued) + " reminders queued."); refreshAfterWrite(null); }).catch(showErr); });
    on("#fStatus", "change", function () { loadStudios(0).catch(showErr); });
    on("#qStudios", "input", function () { clearTimeout(sTimer); sTimer = setTimeout(function () { loadStudios(0).catch(showErr); }, 300); });
    on("#qUsers", "input", function () { clearTimeout(uTimer); uTimer = setTimeout(function () { loadUsers(0).catch(showErr); }, 300); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
