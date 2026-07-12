// =====================================================================
//  Edge Function: `firmfiles` — firm-side R2 storage operations.
//  Deploy WITH jwt verification (only signed-in firm staff).
//
//  Actions (POST JSON, firm JWT in Authorization):
//    download { storage_path }                       -> { url }      (presigned GET)
//    upload   { engagement_id, item_id, filename, type } -> { path, put_url }
//    delete   { storage_paths: [...] }               -> { ok }
//
//  Every op is authorized against portal_members (the caller must belong to
//  the portal that owns the folder = storage_path's first segment).
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { presignGet, presignPut, deleteObjects, bucketUsage } from "../_shared/r2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...cors } });

const engOf = (path: string) => String(path || "").split("/")[0];

async function isMember(userId: string, engagementId: string): Promise<boolean> {
  if (!engagementId) return false;
  const { data } = await admin.from("portal_members")
    .select("user_id").eq("engagement_id", engagementId).eq("user_id", userId).maybeSingle();
  return !!data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body?.action;

  try {
    if (action === "download") {
      const path = String(body.storage_path || "");
      if (!(await isMember(user.id, engOf(path)))) return json({ error: "forbidden" }, 403);
      // inline (+ content type) so the firm can preview a PDF/image in-page.
      const opts = body.inline
        ? { disposition: "inline", contentType: body.content_type || undefined }
        : undefined;
      return json({ url: await presignGet(path, 300, opts) });
    }

    if (action === "upload") {
      const engagement_id = String(body.engagement_id || "");
      const item_id = String(body.item_id || "");
      const filename = String(body.filename || "file").replace(/[^\w.\-]/g, "_");
      if (!(await isMember(user.id, engagement_id))) return json({ error: "forbidden" }, 403);
      // make sure the item belongs to this portal
      const { data: item } = await admin.from("request_items")
        .select("id").eq("id", item_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!item) return json({ error: "item not in this portal" }, 403);
      const path = `${engagement_id}/${item_id}/sample_${Date.now()}_${filename}`;
      return json({ path, put_url: await presignPut(path) });
    }

    if (action === "delete") {
      const paths: string[] = Array.isArray(body.storage_paths) ? body.storage_paths : [];
      for (const p of paths) {
        if (!(await isMember(user.id, engOf(p)))) return json({ error: "forbidden" }, 403);
      }
      if (paths.length) await deleteObjects(paths);
      return json({ ok: true });
    }

    // Aggregate size of the whole (shared) bucket — bytes + object count only,
    // no keys or contents. Any approved firm user may read it to gauge how much
    // of the 10 GB free tier is left.
    if (action === "usage") {
      const { data: prof } = await admin.from("profiles").select("approved").eq("id", user.id).maybeSingle();
      if (!prof?.approved) return json({ error: "not approved" }, 403);
      return json(await bucketUsage());
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
