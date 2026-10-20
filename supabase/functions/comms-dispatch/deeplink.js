// deeplink.js - the bell deep-link rule (notifLink) for WhatsApp forwards.
// A VERBATIM copy of notifLink() in public/store-api.js: test/comms-automation.test.mjs
// fails when the two drift. Returns a RELATIVE app page ("" = nowhere to go).
export function notifLink(n) {
    if (!n || typeof n !== "object") return "";
    const enc = (v) => encodeURIComponent(String(v));
    const has = (v) => v != null && String(v) !== "";
    if (n.__chat) {
      if (!has(n.conversation_id)) return "chat.html";
      return "chat.html?c=" + enc(n.conversation_id) + (has(n.msg_id) ? "&msg=" + enc(n.msg_id) : "");
    }
    const k0 = String(n.kind || "").toLowerCase().trim();
    const d = (n.detail && typeof n.detail === "object") ? n.detail : {};
    // 0069: package-flow notifications carry their own deep link in detail.path — internal relative pages only
    if (/^pkg_(selected|accepted|declined|payment)$/.test(k0)) {
      const p = typeof d.path === "string" ? d.path.trim() : "";
      if (/^(event|settlement)\.html\?(id|quote)=[0-9a-f-]{36}(#[a-z-]{1,32})?$/i.test(p))
        return k0 === "pkg_payment" ? p.replace(/#.*$/, "") + "#payments" : p.replace(/#.*$/, "") + "#pkg-selections";
      if (!has(n.quote_id) && has(d.quote_id)) n = Object.assign({}, n, { quote_id: d.quote_id });
    }
    const k = k0, q = has(n.quote_id) ? n.quote_id : null;
    if (k === "trial_reminder") return "checkout.html";
    // r21 (0250): security notices are Helm HQ only - an HQ notice opens HQ (Activity log -> Security)
    if (k === "security_alert") return d.hq === true ? (/^(sales_enquiry|suggestion)$/.test(String(d.alert || "")) ? "hq.html#requests" : "hq.html") : "control.html#users";
    // 0078: low stock -> the event's inventory page, the item row highlighted
    if (k === "inventory_low_stock") {
      const it = /^[0-9a-f-]{36}$/i.test(String(d.item_id || "")) ? String(d.item_id) : "";
      if (!q) return it ? "inventory.html?item=" + enc(it) : "inventory.html";
      return "inventory.html?quote=" + enc(q) + (it ? "&item=" + enc(it) : "");
    }
    if (k.indexOf("chat_") === 0) return "chat.html";
    if (k === "studio_identity_changed") return "control.html#general";   // r23 (0257): Helm changed the studio name / link
    if (k.indexOf("nurture_") === 0) return "nurture.html";
    // r24 (0269): a new enquiry from the public form -> the Leads board
    if (k === "lead_new") return "leads.html";
    if (!q) return "";
    // r24 (0269): a run-sheet reminder opens that event's run-sheet
    if (k === "event_reminder" && d.source === "0269") return "runsheet.html?quote=" + enc(q);
    // r22 (0254): a close request / its decision opens the event's Closure page at the request
    if (k === "event_close_request" || k === "event_close_decision") return "closure.html?quote=" + enc(q) + "#close-request";
    // r23 (0261): "Rahul opened the proposal" / "viewed but not approved" -> the event workspace, views timeline open
    if (k === "client_link_viewed" || k === "client_view_followup") return "event.html?id=" + enc(q) + "#link-views";
    // r23 (0262): valid-until reminders / "request a new quote" open the event workspace at the validity line
    if (k === "quote_expiring" || k === "quote_expired" || k === "quote_renew_request") return "event.html?id=" + enc(q) + "#quote-validity";
    if (k.indexOf("task_") === 0) return "ops.html?quote=" + enc(q) + (has(d.task_id) ? "&task=" + enc(d.task_id) : "");
    if (/^(payment_link|payment_reminder|payment_receipt|payment|payment_received|advance_paid|payment_reconcile|pkg_payment)$/.test(k))
      return "settlement.html?quote=" + enc(q) + "#payments";
    if (/^(approval_link|otp|reapproval_required|quote_approved|quote_changed|approved|change_order|client_follow_up)$/.test(k))
      return "quotes.html?focus=" + enc(has(n.event_code) ? n.event_code : q);
    if (k === "price_change") return "flow.html?id=" + enc(q) + "#sec-quote";
    if (k === "invite_site_link") return "invite-studio.html?quote=" + enc(q);
    if (k === "booklet_link") return "event.html?id=" + enc(q);
    if (k.indexOf("design_") === 0) return "design.html?quote=" + enc(q);
    if (/^pkg_(selected|accepted|declined)$/.test(k)) return "event.html?id=" + enc(q) + "#pkg-selections";
    if (k === "pkg_payment") return "settlement.html?quote=" + enc(q) + "#payments";
    return "event.html?id=" + enc(q);
  }

// absolute link on the fixed site origin; only relative app pages are ever joined
export function absoluteLink(origin, n) {
  const rel = notifLink(n);
  if (!rel || !/^[a-z0-9-]+\.html(?:[?#][A-Za-z0-9_.~%&=#?-]*)?$/.test(rel)) return "";
  return String(origin).replace(/\/+$/, "") + "/" + rel;
}
