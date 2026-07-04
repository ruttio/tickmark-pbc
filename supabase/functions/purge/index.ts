// =====================================================================
//  Edge Function: `purge` — nightly cleanup of expired auto-delete portals.
//  Deletes their R2 objects first, then the engagement rows (which cascade
//  items/files/history/members/sessions). Replaces the old pg_cron purge,
//  which only removed DB rows + Supabase-Storage copies (files now live in R2).
//
//  Deploy with --no-verify-jwt; guarded by PURGE_SECRET. Trigger daily
//  (GitHub Actions). POST { secret } -> { portals, files }.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { deleteObjects } from "../_shared/r2.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const body = await req.json().catch(() => ({}));
  if (body?.secret !== Deno.env.get("PURGE_SECRET")) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  }

  // expired, auto-delete portals
  const { data: expired, error } = await admin.from("engagements")
    .select("id").eq("auto_delete", true).not("expires_at", "is", null).lt("expires_at", new Date().toISOString());
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  const ids = (expired || []).map((e) => e.id);

  let files = 0;
  if (ids.length) {
    const { data: fs } = await admin.from("item_files").select("storage_path").in("engagement_id", ids);
    const paths = (fs || []).map((f) => f.storage_path).filter(Boolean);
    if (paths.length) { await deleteObjects(paths); files = paths.length; }
    await admin.from("engagements").delete().in("id", ids);
  }

  return new Response(JSON.stringify({ portals: ids.length, files }), {
    headers: { "Content-Type": "application/json" },
  });
});
