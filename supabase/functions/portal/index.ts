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
import { presignGet, presignPut, deleteObjects } from "../_shared/r2.ts";
import { linePush } from "../_shared/line.ts";

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

// Resolve a session token -> { engagement_id?, group_id? } (or null).
// A single-portal session pins engagement_id; a group session sets group_id.
async function sessionForToken(
  token: string,
): Promise<{ engagement_id: string | null; group_id: string | null } | null> {
  if (!token) return null;
  const token_hash = await sha256(token);
  const { data } = await admin
    .from("portal_sessions")
    .select("engagement_id, group_id, expires_at")
    .eq("token_hash", token_hash)
    .maybeSingle();
  if (!data || new Date(data.expires_at) < new Date()) return null;
  return { engagement_id: data.engagement_id ?? null, group_id: data.group_id ?? null };
}

// Which engagement does this call target? Single sessions are pinned to one;
// group sessions accept an explicit engagement_id — but ONLY if that
// engagement belongs to the session's group (this is the isolation guard).
async function resolveEngagement(
  session: { engagement_id: string | null; group_id: string | null },
  body: any,
): Promise<string | null> {
  if (session.engagement_id) return session.engagement_id;
  if (!session.group_id) return null;
  const eid = String(body?.engagement_id || "");
  if (!eid) return null;
  const { data } = await admin.from("engagements").select("group_id").eq("id", eid).maybeSingle();
  if (!data || data.group_id !== session.group_id) return null; // not part of this group
  return eid;
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

      // grouped portals are reached only through their group link
      const { data: engRow } = await admin.from("engagements").select("group_id").eq("id", engagement_id).maybeSingle();
      if (engRow?.group_id) return json({ error: "portal is accessed via its group link", grouped: true }, 409);

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

    // ---- group_unlock: verify the group code, hand back a GROUP session token ----
    if (action === "group_unlock") {
      const group_id = String(body.group_id || "");
      const code = String(body.code || "").replace(/\D/g, "");
      if (!group_id || code.length !== 16) return json({ error: "invalid input" }, 400);

      const { data: t } = await admin.from("group_unlock_throttle")
        .select("failed, locked_until").eq("group_id", group_id).maybeSingle();
      if (t?.locked_until && new Date(t.locked_until) > new Date())
        return json({ error: "too many attempts, try again later" }, 429);

      const { data: ok, error } = await admin.rpc("verify_group_code", { p_group: group_id, p_code: code });
      if (error) return json({ error: "verify failed" }, 500);

      if (!ok) {
        const failed = (t?.failed ?? 0) + 1;
        const lock = failed >= MAX_FAILS;
        await admin.from("group_unlock_throttle").upsert({
          group_id,
          failed: lock ? 0 : failed,
          locked_until: lock ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null,
        });
        return json({ error: "wrong code" }, 401);
      }

      await admin.from("group_unlock_throttle").upsert({ group_id, failed: 0, locked_until: null });
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
      const expires_at = new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString();
      await admin.from("portal_sessions").insert({ token_hash: await sha256(token), group_id, expires_at });
      return json({ token, expires_at });
    }

    // Every other action needs a valid session token (single-portal or group).
    const session = await sessionForToken(String(body.token || ""));
    if (!session) return json({ error: "session expired" }, 401);

    // ---- group_data: the group's companies + progress (group session only) ----
    if (action === "group_data") {
      if (!session.group_id) return json({ error: "not a group session" }, 403);
      const { data: grp } = await admin.from("client_groups")
        .select("id, name").eq("id", session.group_id).maybeSingle();
      const { data: engs } = await admin.from("engagements")
        .select("id, client, template, period_end, request_items(status, archived_at)")
        .eq("group_id", session.group_id);
      const companies = (engs || []).map((e: any) => {
        const items = (e.request_items || []).filter((i: any) => !i.archived_at);
        const total = items.length;
        const accepted = items.filter((i: any) => i.status === "accepted").length;
        const by: Record<string, number> = {};
        items.forEach((i: any) => { by[i.status] = (by[i.status] || 0) + 1; });
        return {
          id: e.id, client: e.client, template: e.template, period_end: e.period_end,
          total, accepted, pct: total ? Math.round((accepted / total) * 100) : 0, by,
        };
      });
      return json({ group: grp, companies });
    }

    // Resolve the target engagement for the remaining (per-portal) actions.
    const engagement_id = await resolveEngagement(session, body);
    if (!engagement_id) return json({ error: "forbidden" }, 403);

    // ---- data: return this portal's items + files only ----
    if (action === "data") {
      const { data: eng } = await admin.from("engagements")
        .select("id, client, template, period_end, expires_at").eq("id", engagement_id).maybeSingle();
      const { data: items } = await admin.from("request_items")
        .select("id, ref, category, description, required, due_date, status, note, firm_note, item_files(id, name, size, type, storage_path, uploaded_at, rejected, is_sample), item_comments(count)")
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
      const put_url = await presignPut(path);   // client PUTs the file bytes to this R2 URL
      return json({ path, put_url });
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

      // LINE notify every portal member who has linked LINE (fire-and-forget)
      try {
        const { data: eng } = await admin.from("engagements").select("client").eq("id", engagement_id).maybeSingle();
        const { data: members } = await admin.from("portal_members").select("user_id").eq("engagement_id", engagement_id);
        const userIds = (members || []).map((m: any) => m.user_id);
        if (userIds.length) {
          const { data: profs } = await admin.from("profiles")
            .select("line_target").in("id", userIds).not("line_target", "is", null);
          const targets = [...new Set((profs || []).map((p: any) => p.line_target).filter(Boolean))];
          if (targets.length) {
            const { data: it } = await admin.from("request_items").select("description").eq("id", item_id).maybeSingle();
            const msg = `📤 ${eng?.client} อัปโหลดเอกสารใหม่\n• ${it?.description || ""}\n(${String(body.name || "")})`;
            await Promise.all(targets.map((t) => linePush(t as string, msg)));
          }
        }
      } catch (_) { /* never block the upload on a notification */ }

      return json({ ok: true });
    }

    // ---- sample_url: signed URL for a firm-provided sample file in this portal ----
    if (action === "sample_url") {
      const file_id = String(body.file_id || "");
      const { data: file } = await admin.from("item_files")
        .select("id, storage_path, is_sample").eq("id", file_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!file || !file.is_sample) return json({ error: "sample not found" }, 404);
      return json({ url: await presignGet(file.storage_path, 120) });
    }

    // ---- file_url: inline presigned URL to PREVIEW any file in this portal ----
    // (the client's own uploads or a firm sample). Isolation via engagement_id.
    if (action === "file_url") {
      const file_id = String(body.file_id || "");
      const { data: file } = await admin.from("item_files")
        .select("id, storage_path, type").eq("id", file_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!file) return json({ error: "file not found" }, 404);
      return json({ url: await presignGet(file.storage_path, 120, { disposition: "inline", contentType: file.type || undefined }) });
    }

    // ---- list_comments: the conversation thread for one item ----
    if (action === "list_comments") {
      const item_id = String(body.item_id || "");
      const { data: item } = await admin.from("request_items")
        .select("id").eq("id", item_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!item) return json({ error: "item not in this portal" }, 403);
      const { data: comments } = await admin.from("item_comments")
        .select("id, by, author, body, created_at").eq("item_id", item_id).order("created_at");
      return json({ comments: comments ?? [] });
    }

    // ---- add_comment: the client posts a message on one item ----
    if (action === "add_comment") {
      const item_id = String(body.item_id || "");
      const text = String(body.body || "").trim();
      if (!text) return json({ error: "empty comment" }, 400);
      const { data: item } = await admin.from("request_items")
        .select("id, description").eq("id", item_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!item) return json({ error: "item not in this portal" }, 403);

      await admin.from("item_comments").insert({ item_id, engagement_id, by: "Client", body: text.slice(0, 2000) });
      await admin.from("item_history").insert({ item_id, by: "Client", action: "Commented" });

      // LINE notify linked portal members (fire-and-forget)
      try {
        const { data: eng } = await admin.from("engagements").select("client").eq("id", engagement_id).maybeSingle();
        const { data: members } = await admin.from("portal_members").select("user_id").eq("engagement_id", engagement_id);
        const userIds = (members || []).map((m: any) => m.user_id);
        if (userIds.length) {
          const { data: profs } = await admin.from("profiles")
            .select("line_target").in("id", userIds).not("line_target", "is", null);
          const targets = [...new Set((profs || []).map((p: any) => p.line_target).filter(Boolean))];
          if (targets.length) {
            const msg = `💬 ${eng?.client} แสดงความคิดเห็น\n• ${item.description || ""}\n"${text.slice(0, 120)}"`;
            await Promise.all(targets.map((t) => linePush(t as string, msg)));
          }
        }
      } catch (_) { /* never block on a notification */ }

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
        .select("id, storage_path, is_sample").eq("id", file_id).eq("item_id", item_id).maybeSingle();
      if (!file || file.is_sample) return json({ error: "file not found" }, 404);

      await deleteObjects([file.storage_path]);
      await admin.from("item_files").delete().eq("id", file_id);
      // if that was the last file, send the item back to "outstanding"
      const { count } = await admin.from("item_files")
        .select("id", { count: "exact", head: true }).eq("item_id", item_id).eq("is_sample", false);
      if (!count) await admin.from("request_items").update({ status: "outstanding" }).eq("id", item_id);
      await admin.from("item_history").insert({ item_id, by: "Client", action: "Removed a file" });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
