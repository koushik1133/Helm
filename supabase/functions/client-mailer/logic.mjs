// client-mailer pure helpers (no Deno / network) - unit-tested from node and deno.
const clip = (s, n) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function maskEmail(e) {
  const s = String(e || ""), at = s.indexOf("@");
  if (at < 1) return "";
  return s.slice(0, 1) + "***" + s.slice(at);
}

// kind: "approval" | "booklet"; link is built server-side from an allow-listed origin
export function linkEmail(kind, o) {
  const studio = clip(o && o.studio, 60) || "your event planner";
  const name = clip(o && o.client, 60) || "there";
  const link = String((o && o.link) || "");
  if (!/^https:\/\/[^\s"'<>]+$/.test(link) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"'<>]*$/.test(link)) throw new Error("bad link");
  const isAppr = kind === "approval";
  const subject = isAppr ? "Your event proposal from " + studio : "Your event booklet from " + studio;
  const lead = isAppr
    ? "Here is your event proposal and quote. Open the link to review it and approve when you are ready (you will get a one-time code to confirm)."
    : "Here is your event booklet with the plan, layout and details we prepared for you.";
  const cta = isAppr ? "Review & approve" : "Open booklet";
  const text = `Hi ${name},\n\n${lead}\n\n${link}\n\nIf you have questions, just reply to this e-mail.\n\n${studio}`;
  const html = `<p>Hi ${esc(name)},</p><p>${esc(lead)}</p>` +
    `<p><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#1f6f43;color:#fff;border-radius:8px;text-decoration:none">${esc(cta)}</a></p>` +
    `<p style="font-size:12px;color:#555">Or copy this link: ${esc(link)}</p><p>If you have questions, just reply to this e-mail.</p><p>${esc(studio)}</p>`;
  return { subject, text, html };
}
