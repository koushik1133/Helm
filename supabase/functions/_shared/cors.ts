// Shared CORS headers for the browser-called Edge Functions.
export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// HTML-escape a value before interpolating it into an email body.
export const escHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// Log the real error server-side; return a generic message to the caller so
// internal details (SQL, provider responses) are not leaked to the browser.
export const serverError = (e: unknown) => {
  console.error(e);
  return json({ error: "internal error" }, 500);
};
