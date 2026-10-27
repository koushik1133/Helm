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

// R32 AUTH-1: `key` = the invitation's mail key (hex, minted per e-mail - mintMailKey). It rides ONLY in the
// e-mailed link (&k=), so opening the e-mail - not holding the token the studio can copy - is what lets
// invite-signup make the login already confirmed.
export const MAIL_KEY_RE = /^[0-9a-f]{32,128}$/;
export function joinLink(token: string, key?: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  const k = key && MAIL_KEY_RE.test(key) ? `&k=${key}` : "";
  return `${appUrl()}/login?invite=${encodeURIComponent(token)}${k}`;
}
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// a fresh mail key for one invitation e-mail: the e-mail gets the key, the database only its SHA-256
// (invite_mail_key_set, 0282, service role). "" = not stored (0282 not applied / error) - the e-mail then
// goes out without &k= and invite-signup answers { fallback: true } (normal confirm-by-e-mail sign-up).
// deno-lint-ignore no-explicit-any
export async function mintMailKey(admin: any, token: string): Promise<string> {
  try {
    if (!TOKEN_RE.test(token)) return "";
    const b = crypto.getRandomValues(new Uint8Array(24));
    const key = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    const { data, error } = await admin.rpc("invite_mail_key_set", { p_token: token, p_hash: await sha256Hex(key) });
    return !error && data === true ? key : "";
  } catch (_) { return ""; }
}

function fmtDate(iso: unknown): string {
  const d = new Date(String(iso ?? ""));
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export type Mail = { subject: string; html: string; text: string };

export function roleLabel(role: unknown): string {
  const k = String(role ?? "");
  return ROLE_LABELS[k] || clean(k, 40) || "a team member";
}

// 0205: the SAME invitation for every invitee (brand-new address, existing account, re-invite):
// "Join <Studio> on Helm" - "<Inviter> invited you as <Role>" - [Accept invitation] -> /login?invite=<token>.
// The Supabase Auth fallback templates (docs/ops/email-templates invite-user + magic-link) use the same words.
export function inviteEmail(opts: { token: unknown; inviter?: unknown; studio?: unknown; role?: unknown; expires_at?: unknown; key?: string }): Mail | null {
  const link = joinLink(String(opts.token ?? ""), opts.key);
  if (!link) return null;
  const studio = clean(opts.studio) || "your studio";
  const inviter = clean(opts.inviter, 60) || "Your studio admin";
  const role = roleLabel(opts.role);
  const expires = fmtDate(opts.expires_at);
  const headline = `Join ${studio} on Helm`;
  const line = `${inviter} invited you as ${role}`;
  const site = appUrl();

  // layout() escapes title + preheader itself
  const title = `Join ${studio} on Helm`, pre = `${line}.`;
  const html = layout(title, pre,
    h1(esc(headline)) +
    para(`${strong(esc(inviter))} invited you as ${strong(esc(role))}. Accept below with this e-mail address: you choose your password (or sign in, if you already use Helm) and land straight in ${strong(esc(studio))}.`) +
    button(esc(link), "Accept invitation") +
    (expires ? para(`This invitation expires on ${strong(esc(expires))}. After that, ask ${esc(inviter)} for a new one.`, "0 0 16px") : "") +
    fallback(esc(link)) +
    note(`Didn't expect this? You can ignore this e-mail - nothing happens unless you click the link. Helm will never ask for your password by e-mail. Questions: <a href="mailto:${SUPPORT}" class="lnk" style="color:#0d8a5c;">${SUPPORT}</a>.`),
    { site: esc(site) });

  const text = [
    headline,
    "",
    `${line}. Open this link to accept with this e-mail address - you choose your password (or sign in, if you already use Helm) and land straight in ${studio}:`,
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

  return { subject: subj(headline), html, text };
}

// 0205 (invite-signup "Email me a new link"): the invitation already made a login with no password and
// its one-time link is gone. `link` is the Supabase sign-in link (generateLink) that lands on
// /login?invite=<token> signed in → "Set your password" → the studio. Same look as the invitation.
export function newLinkEmail(opts: { link: unknown; studio?: unknown; inviter?: unknown; role?: unknown }): Mail | null {
  const link = String(opts.link ?? "");
  let ok = false; try { const u = new URL(link); ok = u.protocol === "https:"; } catch (_) { ok = false; }
  if (!ok || link.length > 4000) return null;
  const studio = clean(opts.studio) || "your studio";
  const inviter = clean(opts.inviter, 60) || "Your studio admin";
  const role = roleLabel(opts.role);
  const headline = `Join ${studio} on Helm`;
  const html = layout(headline, "Your new link to set your password.",
    h1(esc(headline)) +
    para(`${strong(esc(inviter))} invited you as ${strong(esc(role))}. Here is the new link you asked for: open it in the same browser, choose your password and you land straight in ${strong(esc(studio))}.`) +
    button(esc(link), "Set my password") +
    para("This link works once, within 24 hours.", "0 0 16px") +
    fallback(esc(link)) +
    note(`Didn't ask for this? Ignore this e-mail - nothing happens unless you open the link. Helm will never ask for your password by e-mail. Questions: <a href="mailto:${SUPPORT}" class="lnk" style="color:#0d8a5c;">${SUPPORT}</a>.`),
    { site: esc(appUrl()) });
  const text = [headline, "", `${inviter} invited you as ${role}. Open this new link in the same browser to choose your password and join ${studio}:`, "", link, "",
    "This link works once, within 24 hours.", "Didn't ask for this? Ignore this e-mail.", `Questions? ${SUPPORT}`, "", "--", "Helm Events · helm.events"].join("\n");
  return { subject: subj(headline), html, text };
}
