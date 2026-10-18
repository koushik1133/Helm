// invite-mailer template (migration 0131; 2026-10 redesign). Uses the shared Helm layout
// (_shared/email-layout.mjs: emerald brand, hosted logo PNG, dark-mode aware). No tracking. Every user-entered value (inviter, studio) is cleaned + HTML-escaped. The Join link
// is built here from APP_URL + a hex-only token - nothing else in the e-mail comes from the DB.

import { layout, h1, para, strong, button, fallback, note } from "../_shared/email-layout.mjs";

export const SUPPORT = "support@helm.events";

export const ROLE_LABELS: Record<string, string> = {
  admin: "Admin", manager: "Event manager", planner: "Planner", sales: "Sales",
  coordinator: "Event coordinator", supervisor: "Supervisor", quality: "Quality engineer",
  operations: "Operations", designer: "Designer", crew: "Crew", worker: "Worker",
};

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// trim + strip control chars + collapse whitespace + cap length (names are user-entered)
export const clean = (s: unknown, max = 80) =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// subject lines must not carry CR/LF or angle brackets
const subj = (s: string) => s.replace(/[\r\n<>]/g, " ");

export const TOKEN_RE = /^[0-9a-f]{16,128}$/i;

export function appUrl(): string {
  const v = (Deno.env.get("APP_URL") || "https://www.helm.events").trim().replace(/\/+$/, "");
  try { const u = new URL(v); if (u.protocol === "https:") return u.origin; } catch (_) { /* fall through */ }
  return "https://www.helm.events";
}

export function joinLink(token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  return `${appUrl()}/login?invite=${encodeURIComponent(token)}`;
}

function fmtDate(iso: unknown): string {
  const d = new Date(String(iso ?? ""));
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export type Mail = { subject: string; html: string; text: string };

export function inviteEmail(opts: { token: unknown; inviter?: unknown; studio?: unknown; role?: unknown; expires_at?: unknown }): Mail | null {
  const link = joinLink(String(opts.token ?? ""));
  if (!link) return null;
  const studio = clean(opts.studio) || "a studio";
  const inviter = clean(opts.inviter, 60) || "Your studio admin";
  const roleKey = String(opts.role ?? "");
  const role = ROLE_LABELS[roleKey] || clean(roleKey, 40) || "a team member";
  const expires = fmtDate(opts.expires_at);
  const headline = `${inviter} invited you to join ${studio} on Helm as ${role}`;
  const site = appUrl();

  // layout() escapes title + preheader itself
  const title = `You're invited to ${studio} on Helm`, pre = `Join ${studio} on Helm as ${role}.`;
  const html = layout(title, pre,
    h1(esc(headline)) +
    para(`Hi there, ${strong(esc(inviter))} has invited you to ${strong(esc(studio))}, the team that runs its events on Helm. Create your login with this e-mail address and join as ${strong(esc(role))}.`) +
    button(esc(link), `Join ${esc(studio)}`) +
    (expires ? para(`This invitation expires on ${strong(esc(expires))}. After that, ask ${esc(inviter)} for a new one.`, "0 0 16px") : "") +
    fallback(esc(link)) +
    note(`Didn't expect this? You can ignore this e-mail - nothing happens unless you click the link. Helm will never ask for your password by e-mail. Questions: <a href="mailto:${SUPPORT}" class="lnk" style="color:#0d8a5c;">${SUPPORT}</a>.`),
    { site: esc(site) });

  const text = [
    headline,
    "",
    `Hi there, ${inviter} has invited you to ${studio} on Helm. Open this link to create your login with this e-mail address and join as ${role}:`,
    "",
    link,
    "",
    expires ? `This invitation expires on ${expires}.` : "",
    "Didn't expect this? Ignore this e-mail - nothing happens unless you open the link.",
    `Questions? ${SUPPORT}`,
    "",
    "--",
    "Helm Events · helm.events",
  ].join("\n");

  return { subject: subj(`${inviter} invited you to join ${studio} on Helm`), html, text };
}
