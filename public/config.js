/* =========================================================================
   Helm Events — runtime configuration.
   With these Supabase credentials set, layouts are stored in Supabase.
   (The anon/public key is safe in client code — Row Level Security protects the data.)
   Leave url/anonKey blank to fall back to the Node backend, then localStorage.

   Schema: run supabase/schema.sql in the Supabase SQL editor (already done).
   ========================================================================= */
window.SUPABASE_CONFIG = {
  url: "https://nqltzgiwznphugcfhmbm.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xbHR6Z2l3em5waHVnY2ZobWJtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzOTg5NDYsImV4cCI6MjEwNDk3NDk0Nn0.UWainTYBaCr8dNaugqWkCuLVh2H0TkiG6ZIFH6ZPKIQ",
  table: "layouts",
  // Live channels — flip a flag to true only AFTER that channel's Edge Function
  // is deployed and its secrets are set. false = the app simulates the channel
  // (no external calls), so everything keeps working without it configured.
  liveChannels: {
    sms: false,       // send-otp        → MSG91
    pay: false,       // create-payment-link → Razorpay
    whatsapp: false   // send-whatsapp   → your self-hosted Evolution API (set EVOLUTION_* secrets first)
  }
};
