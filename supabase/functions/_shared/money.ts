// Country-aware money for server-sent messages (0092 country templates).
// INR keeps the Indian grouping (1,00,000); AED uses en-AE, USD en-US. Never hardcodes a symbol
// for a quote in another currency. Pure functions - unit-tested by test/country-templates.test.mjs.
const LOCALE: Record<string, string> = { INR: "en-IN", AED: "en-AE", USD: "en-US" };

export function curCode(cur: unknown, fallback = "INR"): string {
  const c = String(cur ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : fallback;
}
export function localeFor(cur: unknown): string { return LOCALE[curCode(cur)] || "en-US"; }

/** "INR 1,00,000" / "AED 12,500" / "USD 12,500" - whole units (pkg-client-notify style) */
export function codeMoney(n: unknown, cur: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const c = curCode(cur);
  return `${c} ${Math.round(v).toLocaleString(localeFor(c))}`;
}

/** "₹1,00,000" (India, unchanged) / "AED 12,500.50" / "$12,500.50" */
export function symMoney(n: unknown, cur: unknown): string {
  const v = Number(n || 0), c = curCode(cur);
  if (c === "INR") return "₹" + v.toLocaleString("en-IN");
  const s = v.toLocaleString(localeFor(c), { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  return c === "USD" ? "$" + s : c + " " + s;
}

/** the quote's own currency snapshot (0089/0091), else INR */
type QLike = { currency?: unknown; tax_snapshot?: { currency?: unknown } | null; pricing?: { currency?: unknown } | null };
export function quoteCur(q: QLike | null | undefined): string {
  return curCode(q?.currency, curCode(q?.tax_snapshot?.currency, curCode(q?.pricing?.currency, "INR")));
}

/** Razorpay Payment Links are used for INR only (see docs/INTEGRATIONS-WHATSAPP-RAZORPAY.md) */
export const razorpaySupports = (cur: unknown) => curCode(cur) === "INR";

/** country dial code (digits) for a studio country: IN 91 / AE 971 / US 1 */
export function dialFor(country: unknown): string {
  const c = String(country ?? "").toUpperCase();
  return c === "AE" ? "971" : c === "US" ? "1" : "91";
}
