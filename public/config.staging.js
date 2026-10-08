/* =========================================================================
   Helm Events — STAGING runtime configuration (NON-PRODUCTION HOSTS ONLY).
   Loaded by config.js only when the page is NOT on a production host
   (localhost / LAN, Vercel branch previews, allow-listed staging hosts).
   Production hosts never request this file, and vercel.json 404s it there,
   so the staging project URL/key never ship to production visitors.
   ========================================================================= */
// ---------------------------------------------------------------------------
// STAGING project (PUBLIC values only — same posture as the prod anon key above,
// which is public-by-design and RLS-protected). The staging anon/publishable key
// and URL are safe to commit. NEVER put the elevated service-role key, DB password, OAuth
// client secret, or any provider secret here — those live only in Supabase/Vercel
// dashboards. Leave BLANK until the staging project is created; blank = "no
// staging configured", which makes staging hosts and localhost fail closed rather
// than ever touching production.
// ---------------------------------------------------------------------------
window.SUPABASE_STAGING = {
  url: "https://xizehqgeyjcfpzrdymly.supabase.co",   // Helm-staging project (isolated from prod)
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhpemVocWdleWpjZnB6cmR5bWx5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxOTAyNTMsImV4cCI6MjEwNTc2NjI1M30.KvL6N-N7iIY7GzsxglWJRmP3JVZuXrHDeqQX1GWaZFo",  // staging ANON/publishable key (public-by-design, RLS-protected — never the elevated key)
  hosts: []       // EXACT staging frontend hostname(s) — add the Vercel staging host at deploy time, e.g. ["helm-staging.vercel.app"]
};

// Hand control back to config.js's host router (it deferred routing until now).
try { if (typeof window.__helmRouteEnv === 'function') window.__helmRouteEnv(); } catch (e) {}
