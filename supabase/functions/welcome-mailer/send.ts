// R119 (0327): one welcome batch - claim, render, send through the SHARED mailer (_shared/mailer.ts: SMTP first when
// it is set up, else Resend - the same path the invitation and trial-reminder e-mails already use), mark.
// Used by comms-dispatch (runs every few minutes already) and by welcome-mailer (its own cron, optional).
//
// Safety (the database decides, this file double-checks):
//   * welcome_email_switch() must answer true (one row, default OFF; APPLY-0327-WELCOME-ON.sql turns it on). A database
//     without 0327 has no such function -> error -> nothing is claimed, nothing is sent.
//   * the 0327 claim hands out only rows queued in the last 48 hours, re-checked (studio / member / trial ended / dup)
//     and marked safe = "r119-0327"; a row without that marker (an older claim body) is released, never sent.
// Logs carry only counts and SQLSTATE codes - never an address or a name.
import { sendMail, EMAIL_RE, type SmtpSend } from "../_shared/mailer.ts";
import { render } from "./templates.ts";

export const SAFE_MARK = "r119-0327";
const UUIDISH = /^[0-9a-f-]{36}$/i;
// why the recipient got it (compliance footer, _shared/email-compliance.mjs)
export const WELCOME_TX_REASON: Record<string, string> = {
  studio_owner: "welcome",
  member: "you joined a studio's team on Helm",
};

export type WelcomeCounts = { sent: number; skipped: number; failed: number; invalid: number };
type Env = (k: string) => string | undefined;

// deno-lint-ignore no-explicit-any
export async function runWelcomeBatch(admin: any, batch: number, opts: { env?: Env; smtp?: SmtpSend } = {}):
  Promise<{ counts: WelcomeCounts; off?: boolean; error?: unknown }> {
  const counts: WelcomeCounts = { sent: 0, skipped: 0, failed: 0, invalid: 0 };
  const sw = await admin.rpc("welcome_email_switch");
  if (sw?.error) return { counts, error: sw.error };   // no 0327 -> never claim with an older (unsafe) body
  if (sw?.data !== true) return { counts, off: true };
  const { data: rows, error } = await admin.rpc("welcome_email_outbox_claim", { p_limit: batch });
  if (error) return { counts, error };
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const id = String(r?.id ?? "");
    if (!UUIDISH.test(id)) { counts.invalid++; continue; }
    let status: "sent" | "skipped" | "retry";
    if (r?.safe !== SAFE_MARK) status = "retry";   // not re-checked by 0327 -> release, never send
    else {
      const kind = String(r?.kind ?? ""), to = String(r?.to ?? "").trim();
      const mail = render(kind, { name: r?.name, studio: r?.studio, trial: r?.trial === true, trialEndsAt: r?.trial_ends_at });
      if (!mail || !EMAIL_RE.test(to)) status = "skipped";
      else {
        const res = await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, studio: null, txReason: WELCOME_TX_REASON[kind] },
          { prefer: "smtp", ...(opts.env ? { env: opts.env } : {}), ...(opts.smtp ? { smtp: opts.smtp } : {}) });
        status = res.status === "sent" ? "sent" : res.status === "not_configured" ? "skipped" : "retry";
      }
    }
    const { error: mErr } = await admin.rpc("welcome_email_outbox_mark", { p_id: id, p_status: status });
    if (mErr) { counts.failed++; continue; }
    if (status === "retry") counts.failed++; else counts[status]++;
  }
  return { counts };
}
