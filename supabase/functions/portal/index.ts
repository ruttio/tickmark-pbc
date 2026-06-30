// =====================================================================
//  Edge Function: `portal`
//  Deploy:  supabase functions deploy portal --no-verify-jwt
//  (--no-verify-jwt because CLIENTS are not Supabase-authenticated users;
//   we authenticate them ourselves with the 16-digit code + a session token.)
//
//  All client traffic goes through here. The function uses the SERVICE
//  ROLE key, so it can read/write while RLS keeps the anon key locked out.
//
//  Actions (POST JSON { action, ... }):
//    unlock        { engagement_id, code }            -> { token, expires_at }
//    data          { token }                          -> { engagement, items }
//    upload_url    { token, item_id, filename, type } -> { path, signed }
//    confirm       { token, item_id, name, size, type, storage_path }
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const SESSION_HOURS = 8;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  // `apikey` + `x-client-info` are sent by the browser/supabase-js; they must be
  // allowed or the preflight fails (works in curl, blocked in the browser).
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Resolve a session token -> engagement_id (or null if missing/expired).
async function engagementForToken(token: string): Promise<string | null> {
  if (!token) return null;
  const token_hash = await sha256(token);
  const { data } = await admin
    .from("portal_sessions")
    .select("engagement_id, expires_at")
    .eq("token_hash", token_hash)
    .maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return data.engagement_id as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = body?.action;

  try {
    // ---- unlock: verify the 16-digit code, hand back a session token ----
    if (action === "unlock") {
      const engagement_id = String(body.engagement_id || "");
      const code = String(body.code || "").replace(/\D/g, "");
      if (!engagement_id || code.length !== 16) return json({ error: "invalid input" }, 400);

      // throttle check
      const { data: t } = await admin.from("unlock_throttle")
        .select("failed, locked_until").eq("engagement_id", engagement_id).maybeSingle();
      if (t?.locked_until && new Date(t.locked_until) > new Date())
        return json({ error: "too many attempts, try again later" }, 429);

      const { data: ok, error } = await admin.rpc("verify_portal_code", {
        p_engagement: engagement_id, p_code: code,
      });
      if (error) return json({ error: "verify failed" }, 500);

      if (!ok) {
        const failed = (t?.failed ?? 0) + 1;
        const lock = failed >= MAX_FAILS;
        await admin.from("unlock_throttle").upsert({
          engagement_id,
          failed: lock ? 0 : failed,
          locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null,
        });
        return json({ error: "wrong code" }, 401);
      }

      // success: clear throttle, mint session
      await admin.from("unlock_throttle").upsert({ engagement_id, failed: 0, locked_until: null });
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
      const expires_at = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
      await admin.from("portal_sessions").insert({
        token_hash: await sha256(token), engagement_id, expires_at,
      });
      return json({ token, expires_at });
    }

    // Every other action needs a valid session token.
    const engagement_id = await engagementForToken(String(body.token || ""));
    if (!engagement_id) return json({ error: "session expired" }, 401);

    // ---- data: return this portal's items + files only ----
    if (action === "data") {
      const { data: eng } = await admin.from("engagements")
        .select("id, client, template, period_end, expires_at").eq("id", engagement_id).maybeSingle();
      const { data: items } = await admin.from("request_items")
        .select("id, ref, category, description, required, due_date, status, note, firm_note, item_files(*)")
        .eq("engagement_id", engagement_id).order("sort");
      return json({ engagement: eng, items: items ?? [] });
    }

    // ---- upload_url: signed URL so the client can upload one file ----
    if (action === "upload_url") {
      const item_id = String(body.item_id || "");
      const filename = String(body.filename || "file").replace(/[^\w.\-]/g, "_");
      // make sure the item really belongs to this portal
      const { data: item } = await admin.from("request_items")
        .select("id").eq("id", item_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!item) return json({ error: "item not in this portal" }, 403);

      const path = `${engagement_id}/${item_id}/${Date.now()}_${filename}`;
      const { data: signed, error } = await admin.storage.from("pbc").createSignedUploadUrl(path);
      if (error) return json({ error: "could not sign url" }, 500);
      return json({ path, signed });   // client uploads via supabase.storage.from('pbc').uploadToSignedUrl(path, signed.token, file)
    }

    // ---- confirm: record the uploaded file + advance the item ----
    if (action === "confirm") {
      const item_id = String(body.item_id || "");
      const { data: item } = await admin.from("request_items")
        .select("id").eq("id", item_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!item) return json({ error: "item not in this portal" }, 403);

      await admin.from("item_files").insert({
        item_id, engagement_id,
        name: String(body.name || ""), size: Number(body.size || 0),
        type: String(body.type || ""), storage_path: String(body.storage_path || ""),
      });
      await admin.from("request_items").update({ status: "submitted", note: "" }).eq("id", item_id);
      await admin.from("item_history").insert({ item_id, by: "Client", action: "Submitted" });
      return json({ ok: true });
    }

    // ---- remove_file: client deletes one of their uploads (storage + row) ----
    // Allowed while the item is not yet accepted (covers returned / reopened).
    if (action === "remove_file") {
      const item_id = String(body.item_id || "");
      const file_id = String(body.file_id || "");
      const { data: item } = await admin.from("request_items")
        .select("id, status").eq("id", item_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!item) return json({ error: "item not in this portal" }, 403);
      if (item.status === "accepted") return json({ error: "item already accepted" }, 403);

      const { data: file } = await admin.from("item_files")
        .select("id, storage_path").eq("id", file_id).eq("item_id", item_id).maybeSingle();
      if (!file) return json({ error: "file not found" }, 404);

      await admin.storage.from("pbc").remove([file.storage_path]);
      await admin.from("item_files").delete().eq("id", file_id);
      // if that was the last file, send the item back to "outstanding"
      const { count } = await admin.from("item_files")
        .select("id", { count: "exact", head: true }).eq("item_id", item_id);
      if (!count) await admin.from("request_items").update({ status: "outstanding" }).eq("id", item_id);
      await admin.from("item_history").insert({ item_id, by: "Client", action: "Removed a file" });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
