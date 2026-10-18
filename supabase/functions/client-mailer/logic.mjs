// client-mailer pure helpers (no Deno / network) - unit-tested from node and deno.
import { layout, h1, para, strong, button, fallback, escHtml, TEXT_FOOTER } from "../_shared/email-layout.mjs";
import { DEFAULT_POSTAL_ADDRESS, TX_REASONS } from "../_shared/email-compliance.mjs";
const clip = (s, n) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function maskEmail(e) {
  const s = String(e || ""), at = s.indexOf("@");
  if (at < 1) return "";
  return s.slice(0, 1) + "***" + s.slice(at);
}

// kind: "approval" | "booklet"; link is built server-side from an allow-listed origin.
// o.brand: "helm" (default) signs off "Helm Events"; "studio" signs off with the studio name.
// o.address: postal address for the compliance footer (email-compliance.mjs postalAddress()).
export function linkEmail(kind, o) {
  const studio = clip(o && o.studio, 60) || "your event planner";
  const name = clip(o && o.client, 60) || "there";
  const link = String((o && o.link) || "");
  if (!/^https:\/\/[^\s"'<>]+$/.test(link) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"'<>]*$/.test(link)) throw new Error("bad link");
  const isAppr = kind === "approval";
  const signoff = o && o.brand === "studio" ? studio : "Helm Events";
  const subject = isAppr ? "Your event proposal from " + studio : "Your event booklet from " + studio;
  const lead = isAppr
    ? "Here is your event proposal and quote from " + studio + ". Open the link to review it and approve when you are ready (you will get a one-time code to confirm)."
    : "Here is your event booklet from " + studio + " with the plan, layout and details prepared for you.";
  const cta = isAppr ? "Review & approve" : "Open booklet";
  const title = isAppr ? "Your event proposal" : "Your event booklet";
  const preheader = isAppr ? "Review your proposal and approve it when you are ready." : "Your event plan, layout and details are ready to view.";
  const text = `Hi ${name},\n\n${lead}\n\n${cta}: ${link}\n\nIf you have questions, just reply to this e-mail.\n\n${signoff}` + TEXT_FOOTER;
  const href = escHtml(link);
  const html = layout(title, preheader,
    h1(escHtml(title)) +
    para(`Hi ${escHtml(name)},`, "0 0 12px") +
    para(escHtml(lead)) +
    button(href, escHtml(cta)) + fallback(href) +
    para("If you have questions, just reply to this e-mail.", "0 0 12px") +
    para(strong(escHtml(signoff)), "0 0 4px"),
    { sub: "", reason: TX_REASONS.client_link, address: (o && o.address) || DEFAULT_POSTAL_ADDRESS });
  return { subject, text, html };
}
