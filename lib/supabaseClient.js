// =====================================================================
//  Shared Supabase client (browser, anon key).
//
//  Used by BOTH roles, but for different things:
//    • Firm  — authenticated session; RLS scopes every query to the firm.
//    • Client — only for storage.uploadToSignedUrl(); the signed-URL token
//               (minted by the Edge Function) is what authorizes the write.
//               Clients never query tables with this client — RLS denies them.
//
//  Requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).
// =====================================================================
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Whether the app is actually configured to talk to a backend.
export const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

if (!SUPABASE_CONFIGURED) {
  // Warn, but DON'T throw — createClient() throws on an empty URL, and that
  // would crash the whole bundle at import time (white screen) before the UI
  // can even render. Fall back to harmless placeholders so the app mounts;
  // any real network call will then fail with a clear, catchable error.
  console.warn(
    "[supabase] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — " +
      "copy .env.example to .env.local and fill them in. Backend calls will fail until you do."
  );
}

const FALLBACK_URL = "https://placeholder.supabase.co";
const FALLBACK_KEY = "placeholder-anon-key";

export const supabase = createClient(
  SUPABASE_URL || FALLBACK_URL,
  SUPABASE_ANON_KEY || FALLBACK_KEY,
  { auth: { persistSession: true, autoRefreshToken: true } }
);

// The client portal Edge Function endpoint.
export const PORTAL_FN_URL = `${SUPABASE_URL || FALLBACK_URL}/functions/v1/portal`;
