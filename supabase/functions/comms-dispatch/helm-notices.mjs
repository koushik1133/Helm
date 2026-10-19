// helm-notices.mjs - Helm's own notices queued by migration 0244 (helm_notice_outbox), handed out by
// helm_notice_outbox_claim with the recipients resolved in the database (never taken from a row):
//   sales_request  a studio admin pressed "Contact sales" on /checkout or the read-only banner
//                  -> sales@helm.events (plain text, every detail one line each)
//   upgrade_ask    a teammate pressed "Ask my admin to upgrade" -> the studio's admins
//   close_request  (0254) a teammate asked to close an event with checks still open -> the studio's admins,
//                  coordinators and managers (not the requester)
//   close_decision (0254) the request was approved (event closed) or declined -> the requester
//   inbox_digest   (0266) a person's still-unread inbox items (daily digest or instant important) -> that person
// Pure (no I/O); shared by comms-dispatch (Deno) and the node tests. Anything unexpected -> null and
// comms-dispatch marks the row skipped (fails closed). Links are always APP_URL + a fixed path.
const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const block = (v, n) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);
const base = (app) => String(app || "https://www.helm.events").replace(/\/+$/, "");

export const NOTICE_KINDS = ["sales_request", "upgrade_ask", "close_request", "close_decision", "inbox_digest"];
// the footer reason for each kind (transactional: a service message about this account)
export const NOTICE_TX_REASON = {
  sales_request: "a Helm studio asked Helm sales to activate a plan",
  upgrade_ask: "a teammate in your Helm studio asked you to choose a plan",
  close_request: "a teammate in your Helm studio asked to close an event and you can approve it",
  close_decision: "you asked to close an event in your Helm studio",
  inbox_digest: "you have unread notifications in your Helm inbox (change how often on your Inbox page)",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const closureLink = (app, q) => app + "/closure.html?quote=" + String(q).toLowerCase() + "#close-request";

export function helmNoticeEmail(kind, data, appUrl) {
  const d = data && typeof data === "object" ? data : {};
  const app = base(appUrl);
  if (kind === "sales_request") {
    const studio = clip(d.studio, 160), plan = clip(d.plan, 80), email = clip(d.email, 200);
    if (!studio || !plan || !email) return null;
    const iv = d.interval === "yearly" ? "Yearly" : "Monthly";
    const lines = [
      "New plan request from Helm" + (d.source === "read_only_banner" ? " (read-only banner)" : " (plan page)") + ".",
      "",
      "Studio: " + studio + (clip(d.account, 160) && clip(d.account, 160) !== studio ? " (account: " + clip(d.account, 160) + ")" : ""),
      "Name: " + (clip(d.name, 80) || "-"),
      "Email: " + email,
      "Phone: " + (clip(d.phone, 20) || "-"),
      "Plan: " + plan,
      "Billing: " + iv,
      "Subscription now: " + (clip(d.subscription_status, 20) || "-"),
      "",
      "Message:",
      block(d.message, 1000) || "-",
      "",
      "Open HQ -> Requests to mark it contacted, then HQ -> Studios -> Activate plan once paid.",
    ];
    return { subject: "Helm plan request: " + plan + " (" + iv + ") - " + studio.slice(0, 80), text: lines.join("\n") };
  }
  if (kind === "upgrade_ask") {
    const who = clip(d.who, 80) || "A teammate";
    const studio = clip(d.studio, 160);
    return {
      subject: who + " asked you to choose a Helm plan",
      text: [
        "Hi,",
        who + " in " + (studio || "your Helm studio") + " asked you to choose a Helm plan, so the team can keep creating and editing.",
        "Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted.",
        "Choose a plan: " + app + "/checkout",
        "- The Helm team",
      ].join("\n\n"),
    };
  }
  if (kind === "close_request" || kind === "close_decision") {
    if (!UUID.test(String(d.quote_id || ""))) return null;
    const ev = clip(d.event, 120) || "Event", code = clip(d.code, 40), date = clip(d.event_date, 10);
    const label = ev + (code ? " (" + code + ")" : "") + (date ? " - " + date : "");
    const who = clip(d.requested_name, 80) || "A teammate", reason = block(d.reason, 1000);
    const open = (Array.isArray(d.failed) ? d.failed : []).map((x) => clip(x, 120)).filter(Boolean).slice(0, 12);
    const link = closureLink(app, d.quote_id);
    if (kind === "close_request") {
      if (!reason) return null;
      return {
        subject: "Close request: " + label.slice(0, 120) + " - waiting for your approval",
        text: [
          "Hi,",
          who + " asked to close " + label + (clip(d.studio, 160) ? " in " + clip(d.studio, 160) : "") + " while some checks are still open.",
          "Still open:\n" + (open.length ? open.map((x) => "- " + x).join("\n") : "-"),
          "Reason:\n" + reason,
          "Approve (the event closes) or decline with a note on the Closure page: " + link,
          "- The Helm team",
        ].join("\n\n"),
      };
    }
    const by = clip(d.decided_name, 80) || "An approver", note = block(d.note, 1000);
    if (d.status === "approved") {
      return {
        subject: "Close request approved: " + label.slice(0, 120) + " is closed",
        text: ["Hi,", by + " approved your request to close " + label + ". The event is now closed and archived.",
          note ? "Note:\n" + note : "", "Closure page: " + link, "- The Helm team"].filter(Boolean).join("\n\n"),
      };
    }
    if (d.status === "declined") {
      return {
        subject: "Close request declined: " + label.slice(0, 120),
        text: ["Hi,", by + " declined your request to close " + label + ".", "Why:\n" + (note || "-"),
          "Fix the open checks or send a new request on the Closure page: " + link, "- The Helm team"].join("\n\n"),
      };
    }
    return null;
  }
  if (kind === "inbox_digest") {
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, 20).map((x) => {
      const t = clip(x && x.title, 140); if (!t) return "";
      const ev = [clip(x.code, 40), clip(x.event, 120)].filter(Boolean).join(" · ");
      return "- " + t + (ev ? " (" + ev + ")" : "") + (clip(x.at, 24) ? " - " + clip(x.at, 24) : "");
    }).filter(Boolean);
    if (!items.length) return null;
    const instant = d.mode === "instant_important", more = Math.max(0, Number(d.more) || 0), studio = clip(d.studio, 160);
    const n = items.length;
    return {
      subject: instant ? "Helm: " + (n === 1 ? items[0].slice(2, 110) : n + " important updates") + (studio ? " - " + studio.slice(0, 60) : "")
                       : "Helm: " + n + " unread notification" + (n === 1 ? "" : "s") + (studio ? " in " + studio.slice(0, 60) : ""),
      text: [
        "Hi" + (clip(d.name, 40) ? " " + clip(d.name, 40) : "") + ",",
        (instant ? "Something important is waiting in your Helm inbox:" : "Still unread in your Helm inbox:") + "\n" + items.join("\n"),
        more ? "And " + more + " more unread in your inbox." : "",
        "Open your inbox: " + app + "/inbox",
        "Change how often Helm e-mails you (daily, instant for important items, or never): " + app + "/inbox#settings",
        "- The Helm team",
      ].filter(Boolean).join("\n\n"),
    };
  }
  return null;
}
