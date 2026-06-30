// =====================================================================
//  Shared Supabase client (browser, anon key).
//
//  The URL + anon key are hardcoded here on purpose. The anon key is PUBLIC
//  by design — it's gated by Row Level Security and already ships inside the
//  built bundle — so there's no secret to protect. Hardcoding also avoids a
//  whole class of deploy bug: a stray newline pasted into a hosting provider's
//  env var corrupted the key and produced "fetch: Invalid value". These exact
//  strings are known-good. To point at a different Supabase project, edit them.
//
//  Used by BOTH roles, but differently:
//    • Firm  — authenticated session; RLS scopes every query to the firm.
//    • Client — only for storage.uploadToSignedUrl(); the signed-URL token
//               (minted by the Edge Function) authorizes the write. Clients
//               never query tables with this client — RLS denies them.
// =====================================================================
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://pmekiinkzfpmrzikmhmo.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtZWtpaW5remZwbXJ6aWttaG1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI3ODQwMDUsImV4cCI6MjA5ODM2MDAwNX0.9zsKl7HduPWtfSGs8d3OOJAwVgEw4DPYC7NVRdQs89E";

// Always configured now (no env dependency). Kept for the UI's setup hint.
export const SUPABASE_CONFIGURED = true;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// The client portal Edge Function endpoint.
export const PORTAL_FN_URL = `${SUPABASE_URL}/functions/v1/portal`;
