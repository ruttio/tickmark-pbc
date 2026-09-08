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
//    data          { token, period_id? }              -> { engagement, period_id, items }
//    periods       { token }                          -> { periods }
//    upload_url    { token, item_id, filename, type } -> { path, signed }
//    confirm       { token, item_id, name, size, type, storage_path }
//    deliverables         { token, period_id? }       -> { deliverables }
//    deliverable_file_url { token, file_id }          -> { url }
//    ack_deliverable      { token, deliverable_id }
//
//  Periods: a portal now spans many monthly periods (an annual audit portal
//  is simply one). `data`/`upload_url`/`confirm` all resolve/respect a
//  period; see supabase/migrations/20260720120000_periods.sql.
//
//  Deliverables: firm -> client OUTPUT files (filed returns, statements,
//  receipts). A `draft` deliverable is the firm's work-in-progress and must
//  NEVER be visible to a client — every deliverable-reading action below
//  filters it out unconditionally. See 20260720120100_deliverables.sql.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { presignGet, presignPut, deleteObjects, headObject } from "../_shared/r2.ts";
import { linePush } from "../_shared/line.ts";
import {
  MAX_FILE_BYTES,
  exceedsPortalQuota,
  isAllowedUploadName,
} from "../_shared/uploadPolicy.ts";

// ---- Upload guardrails ----
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

// Bin an upload we are about to reject. Unlike every other deleteObjects call
// site there is no DB row to protect here (none was written yet), so a failure
// must not turn an honest 413 into a 500 — the orphan sweep reclaims leftovers.
async function binRejected(storagePath: string): Promise<void> {
  try { await deleteObjects([storagePath]); }
  catch (e) { console.error("binRejected: R2 delete failed", storagePath, String(e)); }
}

// LINE-push every firm member of a portal who has linked their account.
// `build` is only called once we know someone is actually listening, so the
// message's own lookups are skipped when nobody has LINE linked.
//
// Fire-and-forget by construction: a notification must never turn a
// successful client action into an error. The caller has already committed
// its write by the time this runs.
async function notifyFirm(engagementId: string, build: () => Promise<string>): Promise<void> {
  try {
    const { data: members } = await admin.from("portal_members")
      .select("user_id").eq("engagement_id", engagementId);
    const userIds = (members || []).map((m: any) => m.user_id);
    if (!userIds.length) return;
    const { data: profs } = await admin.from("profiles")
      .select("line_target").in("id", userIds).not("line_target", "is", null);
    const targets = [...new Set((profs || []).map((p: any) => p.line_target).filter(Boolean))];
    if (!targets.length) return;
    const msg = await build();
    await Promise.all(targets.map((t) => linePush(t as string, msg)));
  } catch (_) { /* never block a client action on a notification */ }
}

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

  // Read-only deployment smoke test. It intentionally touches no database or
  // secret-backed provider so CI can verify routing after every deployment.
  if (action === "health") return json({ ok: true, service: "portal" });

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

    // ---- data: return this portal's items + files, scoped to ONE period ----
    // An annual audit portal has exactly one period, so this keeps behaving
    // exactly as before for it. A monthly portal has many; the client picks
    // one via the `periods` action and passes it back here.
    if (action === "data") {
      const { data: eng } = await admin.from("engagements")
        .select("id, client, template, period_end, expires_at, cadence, language").eq("id", engagement_id).maybeSingle();

      const { data: periodRows } = await admin.from("periods")
        .select("id, period_key, status").eq("engagement_id", engagement_id).order("sort");
      const periods = periodRows ?? [];

      // A body-supplied period_id must belong to THIS engagement's own period
      // list — never trust it outright, same rule as every file_id/item_id
      // lookup below. If it's missing or doesn't resolve, default to the
      // newest OPEN period, falling back to the newest period overall (e.g.
      // every period has since been closed).
      const requested = String(body.period_id || "");
      let period = periods.find((p: any) => p.id === requested);
      if (!period) {
        const bySort = [...periods].sort((a: any, b: any) => (a.period_key < b.period_key ? 1 : -1));
        period = bySort.find((p: any) => p.status === "open") || bySort[0];
      }
      const period_id = period?.id || null;

      let itemsQuery = admin.from("request_items")
        .select("id, ref, category, description, required, due_date, status, note, firm_note, item_files(id, name, size, type, storage_path, uploaded_at, rejected, is_sample), item_comments(count)")
        .eq("engagement_id", engagement_id)
        .order("sort");
      // Defensive only: a portal created before the periods migration ran its
      // backfill (or with the backfill somehow skipped) has no periods yet —
      // fall back to the pre-periods behaviour of returning every item.
      if (period_id) itemsQuery = itemsQuery.eq("period_id", period_id);
      const { data: items } = await itemsQuery;

      // Latest FIRM comment per item → lets the client show an unread-comment card.
      const { data: fc } = await admin.from("item_comments")
        .select("item_id, created_at").eq("engagement_id", engagement_id).eq("by", "Firm");
      const lastFirm: Record<string, string> = {};
      (fc || []).forEach((c: any) => {
        if (!lastFirm[c.item_id] || c.created_at > lastFirm[c.item_id]) lastFirm[c.item_id] = c.created_at;
      });
      const withMeta = (items ?? []).map((it: any) => ({ ...it, last_firm_comment_at: lastFirm[it.id] || null }));
      return json({ engagement: eng, period_id, items: withMeta });
    }

    // ---- periods: list this portal's periods (so the client can switch months) ----
    if (action === "periods") {
      const { data: periods } = await admin.from("periods")
        .select("id, period_key, label, period_end, due_date, status, closed_at, sort")
        .eq("engagement_id", engagement_id).order("sort");
      return json({ periods: periods ?? [] });
    }

    // ---- upload_url: signed URL so the client can upload one file ----
    if (action === "upload_url") {
      const item_id = String(body.item_id || "");
      const filename = String(body.filename || "file").replace(/[^\w.\-]/g, "_");
      const size = Number(body.size || 0);
      const { data: item } = await admin.from("request_items")
        .select("id, status, period_id").eq("id", item_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!item) return json({ error: "item not in this portal" }, 403);
      if (item.status === "accepted") return json({ error: "รายการนี้ตรวจรับแล้ว อัปโหลดเพิ่มไม่ได้" }, 409);
      // A closed period is read-only for the client — checked next to the
      // "already accepted" guard above since both are the same kind of
      // "this item can no longer be touched" gate, just at different scopes
      // (item vs. whole month). Items with no period (pre-migration/ad-hoc)
      // skip this check entirely.
      if (item.period_id) {
        const { data: period } = await admin.from("periods")
          .select("status").eq("id", item.period_id).eq("engagement_id", engagement_id).maybeSingle();
        if (period?.status === "closed") return json({ error: "งวดนี้ปิดแล้ว อัปโหลดเพิ่มเติมไม่ได้" }, 409);
      }
      if (!Number.isFinite(size) || size < 0) return json({ error: "ขนาดไฟล์ไม่ถูกต้อง" }, 400);
      if (!isAllowedUploadName(filename)) return json({ error: "ชนิดไฟล์นี้ไม่รองรับ" }, 415);
      if (size > MAX_FILE_BYTES) return json({ error: "ไฟล์ใหญ่เกิน 50 MB" }, 413);
      // Per-portal storage quota.
      const { data: existing } = await admin.from("item_files").select("size").eq("engagement_id", engagement_id);
      if (exceedsPortalQuota(existing, size)) return json({ error: "พื้นที่จัดเก็บของพอร์ทัลเต็ม" }, 413);

      const path = `${engagement_id}/${item_id}/${Date.now()}_${filename}`;
      const put_url = await presignPut(path);   // client PUTs the file bytes to this R2 URL
      return json({ path, put_url });
    }

    // ---- confirm: record the uploaded file + advance the item ----
    if (action === "confirm") {
      const item_id = String(body.item_id || "");
      const storage_path = String(body.storage_path || "");
      const { data: item } = await admin.from("request_items")
        .select("id, status, period_id").eq("id", item_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!item) return json({ error: "item not in this portal" }, 403);
      if (item.status === "accepted") return json({ error: "รายการนี้ตรวจรับแล้ว" }, 409);
      // Same closed-period gate as upload_url — a period can close between a
      // client minting the signed PUT URL and calling confirm, so this must
      // be re-checked here too, not just at upload_url.
      if (item.period_id) {
        const { data: period } = await admin.from("periods")
          .select("status").eq("id", item.period_id).eq("engagement_id", engagement_id).maybeSingle();
        if (period?.status === "closed") return json({ error: "งวดนี้ปิดแล้ว อัปโหลดเพิ่มเติมไม่ได้" }, 409);
      }
      // The path must live inside THIS item's folder — never trust a client path elsewhere.
      if (!storage_path.startsWith(`${engagement_id}/${item_id}/`)) return json({ error: "invalid path" }, 400);
      if (!isAllowedUploadName(storage_path)) return json({ error: "ชนิดไฟล์นี้ไม่รองรับ" }, 415);

      // Retrying confirm must not create duplicate rows/history for one object.
      const { data: recorded, error: recordedError } = await admin.from("item_files")
        .select("id").eq("storage_path", storage_path).maybeSingle();
      if (recordedError) throw recordedError;
      if (recorded) return json({ ok: true });

      // Authoritative check: read the REAL object from R2 (verifies it exists +
      // gives trustworthy size/type/checksum instead of client-declared values).
      const meta = await headObject(storage_path);
      if (!meta) return json({ error: "ไม่พบไฟล์ที่อัปโหลด ลองใหม่อีกครั้ง" }, 404);
      // Rejected uploads: bin the object, but never let a failed R2 delete mask
      // WHY the upload was rejected. No item_files row is ever written for these,
      // so a leftover object is unreferenced by construction — the `purge`
      // function's orphan sweep is the backstop that reclaims it.
      if (meta.size > MAX_FILE_BYTES) { await binRejected(storage_path); return json({ error: "ไฟล์ใหญ่เกิน 50 MB" }, 413); }

      // Re-check using the authoritative R2 size. The browser-declared size in
      // upload_url is advisory and can be stale or deliberately falsified.
      const { data: existing, error: existingError } = await admin.from("item_files")
        .select("size").eq("engagement_id", engagement_id);
      if (existingError) throw existingError;
      if (exceedsPortalQuota(existing, meta.size)) {
        await binRejected(storage_path);
        return json({ error: "พื้นที่จัดเก็บของพอร์ทัลเต็ม" }, 413);
      }

      const { error: insertError } = await admin.from("item_files").insert({
        item_id, engagement_id,
        name: String(body.name || "").slice(0, 255),
        size: meta.size,
        type: meta.contentType || String(body.type || ""),
        storage_path,
        checksum: meta.etag,
      });
      if (insertError) throw insertError;
      const { error: itemError } = await admin.from("request_items")
        .update({ status: "submitted", note: "" }).eq("id", item_id);
      if (itemError) throw itemError;
      const { error: historyError } = await admin.from("item_history")
        .insert({ item_id, by: "Client", action: "Submitted" });
      if (historyError) throw historyError;

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

    // ---- deliverables: this portal's firm -> client outputs, optionally by period ----
    // `draft` is the firm still assembling the deliverable — work in progress
    // the client must never see. Filtered out unconditionally below, no matter
    // what period_id was asked for; this is the one guarantee this action
    // exists to protect (see 20260720120100_deliverables.sql's header).
    if (action === "deliverables") {
      const period_id = body.period_id ? String(body.period_id) : null;
      const { data: rows } = await admin.from("deliverables")
        .select(
          "id, period_id, category, title, note, status, due_date, delivered_at, viewed_at, acknowledged_at, sort, revision, revision_note, deliverable_files(id, name, size, type, uploaded_at, revision)",
        )
        .eq("engagement_id", engagement_id)
        .order("sort");
      const deliverables = (rows ?? [])
        .filter((d: any) => d.status !== "draft")
        .filter((d: any) => !period_id || d.period_id === period_id)
        // Files above the RELEASED revision are the firm mid-way through
        // assembling a correction (see 20260721090000_deliverable_revisions).
        // Same guarantee as hiding a draft: unreleased work never goes out.
        .map((d: any) => ({
          ...d,
          deliverable_files: (d.deliverable_files || []).filter(
            (f: any) => (f.revision ?? 1) <= (d.revision ?? 1),
          ),
        }));
      return json({ deliverables });
    }

    // ---- deliverable_file_url: inline presigned GET for one deliverable file ----
    // Scoped by the resolved engagement, exactly like `file_url` below. This is
    // also where `viewed_at` gets stamped: fetching the file is the first
    // moment we can prove the client actually looked at it. Set once, never
    // overwritten — it's evidence, and the FIRST view is the fact that matters.
    if (action === "deliverable_file_url") {
      const file_id = String(body.file_id || "");
      const { data: file } = await admin.from("deliverable_files")
        .select("id, deliverable_id, storage_path, type, revision, name")
        .eq("id", file_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!file) return json({ error: "file not found" }, 404);

      // A draft's files must stay invisible even if a file_id somehow leaked
      // (e.g. a stale/bookmarked link) — same guarantee as the list above.
      const { data: deliverable } = await admin.from("deliverables")
        .select("id, status, viewed_at, revision").eq("id", file.deliverable_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!deliverable || deliverable.status === "draft") return json({ error: "file not found" }, 404);
      // Likewise for a file staged for a revision the firm hasn't released:
      // the list already hides it, and a leaked id must not be a way around that.
      if ((file.revision ?? 1) > (deliverable.revision ?? 1)) return json({ error: "file not found" }, 404);

      if (!deliverable.viewed_at) {
        await admin.from("deliverables")
          .update({ viewed_at: new Date().toISOString() })
          .eq("id", deliverable.id).eq("engagement_id", engagement_id);
      }

      return json({
        url: await presignGet(file.storage_path, 120, { disposition: "inline", contentType: file.type || undefined, filename: file.name || undefined }),
      });
    }

    // ---- sample_url: signed URL for a firm-provided sample file in this portal ----
    if (action === "sample_url") {
      const file_id = String(body.file_id || "");
      const { data: file } = await admin.from("item_files")
        .select("id, storage_path, is_sample, name").eq("id", file_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!file || !file.is_sample) return json({ error: "sample not found" }, 404);
      return json({ url: await presignGet(file.storage_path, 120, { filename: file.name || undefined }) });
    }

    // ---- file_url: inline presigned URL to PREVIEW any file in this portal ----
    // (the client's own uploads or a firm sample). Isolation via engagement_id.
    if (action === "file_url") {
      const file_id = String(body.file_id || "");
      const { data: file } = await admin.from("item_files")
        .select("id, storage_path, type, name").eq("id", file_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!file) return json({ error: "file not found" }, 404);
      return json({ url: await presignGet(file.storage_path, 120, { disposition: "inline", contentType: file.type || undefined, filename: file.name || undefined }) });
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

    // ---- ack_deliverable: client confirms receipt ----
    // Idempotent (re-acking a already-acknowledged deliverable is a no-op, so
    // a retried request never clobbers the original acknowledged_at — that
    // timestamp is evidence). Refuses a draft outright: there is nothing to
    // acknowledge if the firm hasn't released it yet, and a client should
    // never even be able to name a draft's id (it's excluded from `deliverables`),
    // but this is checked again here in case an id leaked some other way.
    if (action === "ack_deliverable") {
      const deliverable_id = String(body.deliverable_id || "");
      const { data: deliverable } = await admin.from("deliverables")
        .select("id, status").eq("id", deliverable_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!deliverable) return json({ error: "deliverable not found" }, 404);
      if (deliverable.status === "draft") return json({ error: "ยังไม่มีการส่งรายการนี้ให้ลูกค้า ตรวจรับไม่ได้" }, 409);
      if (deliverable.status === "acknowledged") return json({ ok: true }); // already acked

      const { error } = await admin.from("deliverables")
        .update({ status: "acknowledged", acknowledged_at: new Date().toISOString() })
        .eq("id", deliverable_id).eq("engagement_id", engagement_id);
      if (error) throw error;
      return json({ ok: true });
    }

    // ---- request_deliverable_revision: the client says "this isn't right" ----
    // The mirror of the firm returning a request item with a reason. Without
    // it the client's only recourse was to leave the portal and phone in.
    if (action === "request_deliverable_revision") {
      const deliverable_id = String(body.deliverable_id || "");
      const note = String(body.note || "").trim();
      if (!note) return json({ error: "โปรดระบุสิ่งที่ต้องการให้แก้ไข" }, 400);
      const { error } = await admin.rpc("request_deliverable_revision", {
        p_deliverable: deliverable_id, p_engagement: engagement_id, p_note: note.slice(0, 2000),
      });
      if (error) return json({ error: "ไม่พบรายการนี้ หรือยังไม่ได้ส่งให้ลูกค้า" }, 404);

      await notifyFirm(engagement_id, async () => {
        const { data: d } = await admin.from("deliverables")
          .select("title").eq("id", deliverable_id).maybeSingle();
        const { data: eng } = await admin.from("engagements")
          .select("client").eq("id", engagement_id).maybeSingle();
        return `↩ ${eng?.client} ขอให้แก้ไขงานส่งมอบ\n• ${d?.title || ""}\n"${note.slice(0, 120)}"`;
      });
      return json({ ok: true });
    }

    // ---- deliverable comments: the same two-way thread the request items have ----
    if (action === "list_deliverable_comments") {
      const deliverable_id = String(body.deliverable_id || "");
      const { data: d } = await admin.from("deliverables")
        .select("id, status").eq("id", deliverable_id).eq("engagement_id", engagement_id).maybeSingle();
      // Never confirm a draft exists, let alone hand over its thread.
      if (!d || d.status === "draft") return json({ error: "deliverable not found" }, 404);
      const { data: comments } = await admin.from("deliverable_comments")
        .select("id, by, author, body, created_at").eq("deliverable_id", deliverable_id).order("created_at");
      return json({ comments: comments ?? [] });
    }

    if (action === "add_deliverable_comment") {
      const deliverable_id = String(body.deliverable_id || "");
      const text = String(body.body || "").trim();
      if (!text) return json({ error: "empty comment" }, 400);
      const { data: d } = await admin.from("deliverables")
        .select("id, status, title").eq("id", deliverable_id).eq("engagement_id", engagement_id).maybeSingle();
      if (!d || d.status === "draft") return json({ error: "deliverable not found" }, 404);

      const { error } = await admin.from("deliverable_comments")
        .insert({ deliverable_id, engagement_id, by: "Client", body: text.slice(0, 2000) });
      if (error) throw error;

      await notifyFirm(engagement_id, async () => {
        const { data: eng } = await admin.from("engagements")
          .select("client").eq("id", engagement_id).maybeSingle();
        return `💬 ${eng?.client} แสดงความคิดเห็นในงานส่งมอบ\n• ${d.title || ""}\n"${text.slice(0, 120)}"`;
      });
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
