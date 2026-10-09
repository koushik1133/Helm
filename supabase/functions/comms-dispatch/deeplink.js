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
    if (k === "security_alert") return "control.html#users";
    // 0078: low stock -> the event's inventory page, the item row highlighted
    if (k === "inventory_low_stock") {
      const it = /^[0-9a-f-]{36}$/i.test(String(d.item_id || "")) ? String(d.item_id) : "";
      if (!q) return it ? "inventory.html?item=" + enc(it) : "inventory.html";
      return "inventory.html?quote=" + enc(q) + (it ? "&item=" + enc(it) : "");
    }
    if (k.indexOf("chat_") === 0) return "chat.html";
    if (k.indexOf("nurture_") === 0) return "nurture.html";
    if (!q) return "";
    if (k.indexOf("task_") === 0) return "ops.html?quote=" + enc(q) + (has(d.task_id) ? "&task=" + enc(d.task_id) : "");
    if (/^(payment_link|payment_reminder|payment_receipt|payment|payment_received|advance_paid|payment_reconcile|pkg_payment)$/.test(k))
      return "settlement.html?quote=" + enc(q) + "#payments";
    if (/^(approval_link|otp|reapproval_required|quote_approved|quote_changed|approved|change_order|client_follow_up)$/.test(k))
      return "quotes.html?focus=" + enc(has(n.event_code) ? n.event_code : q);
    if (k === "price_change") return "flow.html?id=" + enc(q) + "#sec-quote";
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
