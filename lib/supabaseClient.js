// =====================================================================
//  Shared Supabase client (browser, public anon key).
//
//  Every environment supplies its own project URL and anon key through Vite.
//  This keeps local and preview builds away from production data. Never put a
//  service-role key, database password, or provider secret in a VITE_* value.
// =====================================================================
import { createClient } from "@supabase/supabase-js";

const configuredUrl = String(import.meta.env.VITE_SUPABASE_URL || "").trim();
const configuredAnonKey = String(import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();

export const SUPABASE_CONFIGURED =
  /^https:\/\/[^\s]+\.supabase\.co\/?$/i.test(configuredUrl) && configuredAnonKey.length > 20;

// createClient requires a syntactically valid URL even while the first-run
// setup screen is rendered. Production builds are guarded by verify-env.mjs.
export const SUPABASE_URL = SUPABASE_CONFIGURED
  ? configuredUrl.replace(/\/$/, "")
  : "https://unconfigured.supabase.co";
export const SUPABASE_ANON_KEY = SUPABASE_CONFIGURED ? configuredAnonKey : "unconfigured-anon-key";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const PORTAL_FN_URL = `${SUPABASE_URL}/functions/v1/portal`;
