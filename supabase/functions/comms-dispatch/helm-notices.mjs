// helm-notices.mjs - Helm's own notices queued by migration 0244 (helm_notice_outbox), handed out by
// helm_notice_outbox_claim with the recipients resolved in the database (never taken from a row):
//   sales_request  a studio admin pressed "Contact sales" on /checkout or the read-only banner
//                  -> sales@helm.events (plain text, every detail one line each)
//   upgrade_ask    a teammate pressed "Ask my admin to upgrade" -> the studio's admins
// Pure (no I/O); shared by comms-dispatch (Deno) and the node tests. Anything unexpected -> null and
// comms-dispatch marks the row skipped (fails closed). Links are always APP_URL + a fixed path.
const clip = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const block = (v, n) => String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, n);
const base = (app) => String(app || "https://www.helm.events").replace(/\/+$/, "");

export const NOTICE_KINDS = ["sales_request", "upgrade_ask"];
// the footer reason for each kind (transactional: a service message about this account)
export const NOTICE_TX_REASON = {
  sales_request: "a Helm studio asked Helm sales to activate a plan",
  upgrade_ask: "a teammate in your Helm studio asked you to choose a plan",
};

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
  return null;
}
