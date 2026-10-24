// Where the app talks to its API.
// - On GitHub Pages (static hosting) it uses the Supabase Edge Function.
// - Anywhere else (local `npm start`, Railway, a VPS) it uses the same origin.
// The Supabase URL and anon key are public values, safe to ship in the page.
window.PF_CONFIG = location.hostname.endsWith('github.io')
  ? { apiBase: 'https://npobptbcnxsonbevfgrr.supabase.co/functions/v1' }
  : {};
