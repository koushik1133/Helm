// 0212 free-trial client e-mail: the database marks a free-trial studio's outbox row payload.trial_email = true
// only for the invitation / booklet link BY E-MAIL of an ACTIVE trial (capped). Checked once more in the
// dispatcher: a trial-marked row that is anything else (WhatsApp, another purpose, a forged mark) is skipped.
// Unmarked rows (paid studios, everything before 0212) are unaffected.
export const TRIAL_EMAIL_PURPOSES = new Set(["invite_site", "booklet_link"]);
export function trialRowAllowed(purpose, channel, payload) {
  const marked = !!payload && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "trial_email");
  if (!marked) return true;
  return payload.trial_email === true && channel === "email" && TRIAL_EMAIL_PURPOSES.has(String(purpose));
}
