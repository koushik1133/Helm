// Free-trial outbound guard for edge functions that send DIRECTLY (not through an outbox table).
// Same rule as public._sample_outbound_blocked (0166), which already turns comms_outbox /
// pkg_outbox / assign_notify_outbox rows of a trial studio into 'skipped': a studio in its
// free trial (or the sample master studio) sends nothing real.
// 0212: client-mailer asks trialEmailGate (_shared/trial-guard.ts) first - an ACTIVE trial may e-mail its
// clients under caps; this rule is the fallback for a database without 0212 (a trial then sends nothing).
//
// Order: ask the database function (service role); if it can't be called (older database,
// no grant) use the same table rule (studio_subscriptions.status = 'trial'). If neither
// answers it FAILS CLOSED (blocked, unknown: true) - a trial must never send a real message.
export const TEST_MODE_TEXT = "Test mode - in the free trial we don't send real messages; copy the link instead";

export async function outboundBlocked(admin: any, orgId: string, recipient = ""): Promise<{ blocked: boolean; unknown?: boolean }> {
  if (!orgId) return { blocked: true, unknown: true };
  try {
    const { data, error } = await admin.rpc("_sample_outbound_blocked", { p_org: orgId, p_recipient: recipient || null });
    if (!error) return { blocked: data === true };
  } catch (_) { /* fall through to the table rule */ }
  try {
    const { data, error } = await admin.from("studio_subscriptions").select("status")
      .eq("org_id", orgId).eq("status", "trial").limit(1).maybeSingle();
    if (!error) return { blocked: !!data };
  } catch (_) { /* fail closed below */ }
  return { blocked: true, unknown: true };
}
