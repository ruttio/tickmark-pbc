// =====================================================================
//  portalApi.js — the data layer between the React UI and Supabase.
//
//  Two namespaces, because the two roles authenticate differently:
//
//    firmApi   — for signed-in firm staff. Uses supabase-js directly;
//                Row Level Security scopes every read/write to the firm.
//    clientApi — for clients (no login). Everything tunnels through the
//                `portal` Edge Function with a 16-digit code + session token.
//
//  `map*` helpers convert the backend's snake_case rows into the camelCase
//  shape the prototype's components already expect (periodEnd, dueDate,
//  files[], …) so the UI can stay largely as-is.
//
//  Nothing here imports React — it's plain async functions, easy to test.
// =====================================================================
import { supabase, PORTAL_FN_URL, SUPABASE_ANON_KEY } from "./supabaseClient.js";

/* ---------- date helpers ----------------------------------------------- */
const toTs = (v) => (v ? new Date(v).getTime() : null); // ISO/date string -> ms epoch
const toDateOnly = (ts) =>
  ts == null ? null : new Date(ts).toISOString().slice(0, 10); // ms -> 'YYYY-MM-DD'

/* ---------- row mappers (backend -> UI shape) -------------------------- */
export function mapFile(row) {
  return {
    id: row.id,
    name: row.name,
    size: Number(row.size ?? 0),
    type: row.type || "",
    storagePath: row.storage_path,
    uploadedAt: toTs(row.uploaded_at),
    downloadedAt: toTs(row.firm_downloaded_at),
    rejected: !!row.rejected,
    isSample: !!row.is_sample,
  };
}

export function mapHistory(row) {
  return { at: toTs(row.at), by: row.by, action: row.action };
}

export function mapItem(row) {
  return {
    id: row.id,
    ref: row.ref,
    category: row.category || "General",
    description: row.description,
    required: !!row.required,
    dueDate: toTs(row.due_date),
    status: row.status,
    note: row.note || "",                // return reason (client-visible)
    firmNote: row.firm_note || "",       // firm-internal note
    archivedAt: toTs(row.archived_at),
    sort: row.sort ?? 0,
    files: (row.item_files || []).map(mapFile),
    history: (row.item_history || []).map(mapHistory),
  };
}

export function mapEngagement(row) {
  return {
    id: row.id,
    client: row.client,
    clientEmail: row.client_email || "",
    template: row.template,
    periodEnd: toTs(row.period_end),
    expiresAt: toTs(row.expires_at),
    autoDelete: !!row.auto_delete,
    firmSeenAt: toTs(row.firm_seen_at),
    createdAt: toTs(row.created_at),
    groupId: row.group_id || null,
  };
}

/* =====================================================================
   FIRM API — authenticated staff. RLS does the per-firm scoping.
   ===================================================================== */
export const firmApi = {
  /* ---- auth ---- */
  async signUp({ email, password, firmName, fullName }) {
    // firm_name / full_name land in user metadata; the handle_new_user
    // trigger provisions a firm + profile from them.
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { firm_name: firmName, full_name: fullName } },
    });
    if (error) throw error;
    return data;
  },

  async signIn({ email, password }) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  },

  // Subscribe to auth changes; returns an unsubscribe function.
  // cb receives (event, session) — event 'PASSWORD_RECOVERY' means the user
  // arrived via a reset link and should be shown a "set new password" form.
  onAuthChange(cb) {
    const { data } = supabase.auth.onAuthStateChange((event, session) => cb(event, session));
    return () => data.subscription.unsubscribe();
  },

  // Email a password-reset link (lands back on the app with a recovery token).
  async requestPasswordReset(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    });
    if (error) throw error;
  },

  // Set a new password (called during a PASSWORD_RECOVERY session).
  async updatePassword(password) {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
  },

  async getSession() {
    const { data } = await supabase.auth.getSession();
    return data.session;
  },

  // The signed-in user's profile, incl. the `approved` gate. `select("*")`
  // (not "approved") so this still works before the approval migration is
  // applied; we then default a missing `approved` column to true so existing
  // users aren't locked out until the admin enables the gate.
  async getProfile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data, error } = await supabase
      .from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { ...data, approved: data.approved ?? true };
  },

  /* ---- engagements (portals) ---- */

  // List this firm's portals (RLS-scoped). Returns UI-shaped engagements.
  // My role (owner/member) per engagement across all my portals. Defaults to
  // owner when there's no membership row (permissive / pre-sharing-migration).
  async listMyRoles() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return {};
    const { data, error } = await supabase
      .from("portal_members").select("engagement_id, role, can_delete").eq("user_id", user.id);
    if (error) return {};
    return Object.fromEntries((data || []).map((m) => [m.engagement_id, { role: m.role, canDelete: m.can_delete }]));
  },

  async listEngagements() {
    const { data, error } = await supabase
      .from("engagements")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    const roles = await this.listMyRoles();
    return (data || []).map((r) => {
      const m = roles[r.id];
      return { ...mapEngagement(r), myRole: m?.role || "owner", myCanDelete: m?.canDelete ?? true };
    });
  },

  // Same list, plus per-engagement progress (total / accepted / by-status / pct)
  // for the firm dashboard. One extra query aggregates item statuses client-side.
  async listEngagementsWithProgress() {
    const list = await this.listEngagements();
    const { data: rows, error } = await supabase
      .from("request_items")
      .select("engagement_id, status, due_date, archived_at");
    if (error) throw error;
    const today = Date.now();
    const agg = {};
    (rows || []).forEach((r) => {
      if (r.archived_at) return; // archived items don't count toward progress
      const a = (agg[r.engagement_id] ||= { total: 0, accepted: 0, overdue: 0, by: {} });
      a.total++;
      a.by[r.status] = (a.by[r.status] || 0) + 1;
      if (r.status === "accepted") a.accepted++;
      if (r.status !== "accepted" && r.due_date && new Date(r.due_date).getTime() < today) a.overdue++;
    });
    return list.map((e) => {
      const a = agg[e.id] || { total: 0, accepted: 0, overdue: 0, by: {} };
      return { ...e, total: a.total, accepted: a.accepted, overdue: a.overdue, by: a.by,
        pct: a.total ? Math.round((a.accepted / a.total) * 100) : 0 };
    });
  },

  // Open follow-up items across the firm's portals for the dashboard panel:
  // still-open (not accepted / not archived) items with their due date + status.
  // RLS scopes this to the caller's own engagements, same as the queries above.
  async listFollowUps() {
    const { data, error } = await supabase
      .from("request_items")
      .select("id, engagement_id, description, due_date, status, archived_at")
      .neq("status", "accepted")
      .is("archived_at", null);
    if (error) throw error;
    return (data || []).map((r) => ({
      id: r.id,
      engagementId: r.engagement_id,
      description: r.description,
      dueDate: r.due_date ? new Date(r.due_date).getTime() : null,
      status: r.status,
    }));
  },

  // Full detail for one portal: engagement + items + files + history.
  async getEngagement(engagementId) {
    const { data: eng, error: e1 } = await supabase
      .from("engagements")
      .select("*")
      .eq("id", engagementId)
      .maybeSingle();
    if (e1) throw e1;
    if (!eng) return null;

    const { data: items, error: e2 } = await supabase
      .from("request_items")
      .select("*, item_files(*), item_history(*)")
      .eq("engagement_id", engagementId)
      .order("sort");
    if (e2) throw e2;

    // My role/permission on this portal (permissive default so the app still
    // works before the sharing migration is applied).
    let myRole = "owner", myCanDelete = true;
    try {
      const { data: perms, error } = await supabase.rpc("my_portal_perms", { p_engagement: engagementId });
      if (!error && perms && perms.length) { myRole = perms[0].role; myCanDelete = perms[0].can_delete; }
    } catch { /* pre-migration */ }

    // Hide archived (soft-deleted) items from the main list — filtered client-
    // side so this still works before the archived_at migration is applied.
    const mapped = (items || []).map(mapItem).filter((it) => !it.archivedAt);
    return { ...mapEngagement(eng), items: mapped, myRole, myCanDelete };
  },

  // Soft-delete an item into the Archived box.
  async archiveItem(itemId) {
    const { error } = await supabase.from("request_items").update({ archived_at: new Date().toISOString() }).eq("id", itemId);
    if (error) throw error;
    await this._logHistory(itemId, "Firm", "Archived");
  },
  async restoreItem(itemId) {
    const { error } = await supabase.from("request_items").update({ archived_at: null }).eq("id", itemId);
    if (error) throw error;
    await this._logHistory(itemId, "Firm", "Restored");
  },
  async listArchived(engagementId) {
    const { data, error } = await supabase
      .from("request_items").select("*, item_files(*), item_history(*)")
      .eq("engagement_id", engagementId).not("archived_at", "is", null).order("sort");
    if (error) throw error;
    return (data || []).map(mapItem);
  },
  // Permanently delete an item + its storage objects (owner/can_delete gated in UI).
  async purgeItem(itemId) {
    const { data: files } = await supabase.from("item_files").select("storage_path").eq("item_id", itemId);
    const paths = (files || []).map((f) => f.storage_path).filter(Boolean);
    if (paths.length) await supabase.functions.invoke("firmfiles", { body: { action: "delete", storage_paths: paths } });
    const { error } = await supabase.from("request_items").delete().eq("id", itemId);
    if (error) throw error;
  },

  /* ---- LINE notifications (firm-level) ---- */
  async lineStatus() {
    const { data, error } = await supabase.rpc("line_status");
    if (error) throw error;
    return (data && data[0]) || { linked: false, code: null };
  },
  async lineGenerateCode() {
    const { data, error } = await supabase.rpc("line_generate_code");
    if (error) throw error;
    return data;
  },
  async lineUnlink() {
    const { error } = await supabase.rpc("line_unlink");
    if (error) throw error;
  },

  /* ---- portal sharing (members) ---- */
  async listPortalMembers(engagementId) {
    const { data, error } = await supabase.rpc("list_portal_members", { p_engagement: engagementId });
    if (error) throw error;
    return (data || []).map((m) => ({ userId: m.user_id, email: m.email, role: m.role, canDelete: m.can_delete }));
  },
  async addPortalMember(engagementId, email, role) {
    const { error } = await supabase.rpc("add_portal_member", { p_engagement: engagementId, p_email: email, p_role: role });
    if (error) throw error;
  },
  async setPortalMember(engagementId, userId, role, canDelete) {
    const { error } = await supabase.rpc("set_portal_member", { p_engagement: engagementId, p_user: userId, p_role: role, p_can_delete: canDelete });
    if (error) throw error;
  },
  async removePortalMember(engagementId, userId) {
    const { error } = await supabase.rpc("remove_portal_member", { p_engagement: engagementId, p_user: userId });
    if (error) throw error;
  },

  /* ---- client groups (share several portals via one link + code) ---- */
  async listClientGroups() {
    const { data, error } = await supabase
      .from("client_groups").select("id, name, created_at").order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map((g) => ({ id: g.id, name: g.name, createdAt: toTs(g.created_at) }));
  },
  async createClientGroup({ name, code }) {
    const { data, error } = await supabase.rpc("create_client_group", {
      p_name: name || "", p_code: String(code).replace(/\D/g, ""),
    });
    if (error) throw error;
    return data; // new group id
  },
  async setGroupCode(groupId, code) {
    const { error } = await supabase.rpc("set_group_code", { p_group: groupId, p_code: String(code).replace(/\D/g, "") });
    if (error) throw error;
  },
  // Assign an engagement to a group (pass null to un-assign).
  async setEngagementGroup(engagementId, groupId) {
    const { error } = await supabase.rpc("set_engagement_group", { p_engagement: engagementId, p_group: groupId || null });
    if (error) throw error;
  },
  async deleteClientGroup(groupId) {
    const { error } = await supabase.from("client_groups").delete().eq("id", groupId);
    if (error) throw error;
  },

  // Create a portal from a template.
  //   meta  = { client, template, periodEnd (ms|null), code, retentionDays, autoDelete }
  //   items = [{ ref, category, description, required, dueDate (ms|null), status?, note?, sort? }]
  // The RPC hashes the code in the DB and returns the new engagement id;
  // we then bulk-insert the request_items (the template lives in the UI,
  // not the backend).
  async createEngagement(meta, items = []) {
    const { data: engagementId, error } = await supabase.rpc("create_engagement", {
      p_client: meta.client,
      p_template: meta.template,
      p_period_end: toDateOnly(meta.periodEnd),
      p_code: String(meta.code).replace(/\D/g, ""),
      p_retention_days: meta.retentionDays ?? null,
      p_auto_delete: meta.autoDelete ?? true,
    });
    if (error) throw error;

    if (meta.clientEmail) {
      await supabase.from("engagements")
        .update({ client_email: meta.clientEmail.trim() }).eq("id", engagementId);
    }

    if (items.length) {
      const rows = items.map((it, i) => ({
        engagement_id: engagementId,
        ref: it.ref ?? String(i + 1).padStart(2, "0"),
        category: it.category || "General",
        description: it.description,
        required: it.required ?? true,
        due_date: toDateOnly(it.dueDate),
        status: it.status || "outstanding",
        note: it.note || "",
        sort: it.sort ?? i,
      }));
      const { error: e2 } = await supabase.from("request_items").insert(rows);
      if (e2) throw e2;
    }
    return engagementId;
  },

  // Update the client contact email (where notifications are sent).
  async setClientEmail(engagementId, email) {
    const { error } = await supabase
      .from("engagements").update({ client_email: email.trim() || null }).eq("id", engagementId);
    if (error) throw error;
  },

  // Trigger a client email via the `notify` Edge Function (firm-authenticated).
  // kind: 'invite' | 'returned'. opts may include { item_id, portal_url }.
  async notify(engagementId, kind, opts = {}) {
    const { data, error } = await supabase.functions.invoke("notify", {
      body: { engagement_id: engagementId, kind, ...opts },
    });
    if (error) throw error;
    return data;
  },

  // Change the 16-digit code (hashing happens in the DB).
  async setPortalCode(engagementId, code) {
    const { error } = await supabase.rpc("set_portal_code", {
      p_engagement: engagementId,
      p_code: String(code).replace(/\D/g, ""),
    });
    if (error) throw error;
  },

  // Update retention/expiry. expiresAt is ms-epoch or null (= never expires).
  async setRetention(engagementId, { expiresAt, autoDelete }) {
    const { error } = await supabase
      .from("engagements")
      .update({
        expires_at: expiresAt == null ? null : new Date(expiresAt).toISOString(),
        auto_delete: !!autoDelete,
      })
      .eq("id", engagementId);
    if (error) throw error;
  },

  // Delete a portal. First purge its R2 objects (while the caller is still a
  // member, so firmfiles authorises the delete), THEN drop the DB rows
  // (items/files/history cascade). Without the R2 step, storage objects would
  // orphan and inflate the bucket beyond what the DB reports.
  async deleteEngagement(engagementId) {
    try {
      const { data: files } = await supabase.from("item_files")
        .select("storage_path").eq("engagement_id", engagementId);
      const paths = (files || []).map((f) => f.storage_path).filter(Boolean);
      if (paths.length) {
        await supabase.functions.invoke("firmfiles", { body: { action: "delete", storage_paths: paths } });
      }
    } catch (_) { /* best-effort: still remove the DB rows below */ }
    const { error } = await supabase.from("engagements").delete().eq("id", engagementId);
    if (error) throw error;
  },

  /* ---- request items ---- */
  async addItem(engagementId, item, sort = 0) {
    const { data, error } = await supabase
      .from("request_items")
      .insert({
        engagement_id: engagementId,
        ref: item.ref,
        category: item.category || "General",
        description: item.description,
        required: item.required ?? true,
        due_date: toDateOnly(item.dueDate),
        status: item.status || "outstanding",
        note: item.note || "",
        sort,
      })
      .select("*, item_files(*), item_history(*)")
      .single();
    if (error) throw error;
    await this._logHistory(data.id, "Firm", "Requested");
    return mapItem(data);
  },

  async deleteItem(itemId) {
    const { error } = await supabase.from("request_items").delete().eq("id", itemId);
    if (error) throw error;
  },

  // Partial return: flag specific files rejected / clear the rest.
  async setItemFileRejections(rejectedIds, okIds) {
    if (rejectedIds && rejectedIds.length) {
      const { error } = await supabase.from("item_files").update({ rejected: true }).in("id", rejectedIds);
      if (error) throw error;
    }
    if (okIds && okIds.length) {
      const { error } = await supabase.from("item_files").update({ rejected: false }).in("id", okIds);
      if (error) throw error;
    }
  },

  // Edit an item's description and/or per-item due date (ms epoch | null).
  async updateItem(itemId, patch) {
    // read current values so we only log fields that actually changed
    const { data: cur } = await supabase.from("request_items").select("description, due_date").eq("id", itemId).maybeSingle();
    const row = {};
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.dueDate !== undefined) row.due_date = toDateOnly(patch.dueDate);
    const { error } = await supabase.from("request_items").update(row).eq("id", itemId);
    if (error) throw error;
    if (patch.description !== undefined && cur && patch.description !== cur.description) await this._logHistory(itemId, "Firm", "Renamed");
    if (patch.dueDate !== undefined && cur && toDateOnly(patch.dueDate) !== cur.due_date) await this._logHistory(itemId, "Firm", "Rescheduled");
  },

  // Total bytes stored across the firm's files (RLS-scoped via item_files).
  async getStorageUsage() {
    const { data, error } = await supabase.from("item_files").select("size");
    if (error) throw error;
    return (data || []).reduce((n, r) => n + Number(r.size || 0), 0);
  },

  // Aggregate size of the whole shared R2 bucket (bytes + object count) so the
  // dashboard can show overall usage vs the 10 GB quota. Needs the firmfiles
  // `usage` action deployed; callers should tolerate a failure (older deploy).
  async getBucketUsage() {
    const { data, error } = await supabase.functions.invoke("firmfiles", { body: { action: "usage" } });
    if (error) throw error;
    return data; // { bytes, count }
  },

  // Recent client activity across the firm's portals, for the notification
  // center. Each is "unread" if it happened after the firm last viewed that
  // portal (engagements.firm_seen_at).
  async listNotifications(limit = 100) {
    const { data, error } = await supabase
      .from("item_history")
      .select("id, at, action, by, actor, request_items!inner(description, engagement_id, engagements!inner(client, firm_seen_at))")
      .order("at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map((h) => {
      const it = h.request_items || {};
      const e = it.engagements || {};
      const isClient = h.by === "Client";
      return {
        id: h.id,
        at: toTs(h.at),
        action: h.action,
        by: h.by,
        actor: h.actor || null,
        itemDescription: it.description || "",
        engagementId: it.engagement_id,
        client: e.client || "",
        // Only client activity counts as "unread" for the firm's bell.
        unread: isClient && (!e.firm_seen_at || new Date(h.at) > new Date(e.firm_seen_at)),
      };
    });
  },

  // Mark a portal as seen now (clears its unread notifications).
  async markEngagementSeen(engagementId) {
    const { error } = await supabase
      .from("engagements").update({ firm_seen_at: new Date().toISOString() }).eq("id", engagementId);
    if (error) throw error;
  },

  // Mark every portal seen (RLS scopes the update to this firm).
  async markAllSeen() {
    const { error } = await supabase
      .from("engagements").update({ firm_seen_at: new Date().toISOString() }).not("id", "is", null);
    if (error) throw error;
  },

  // Who is acting (firm member display name) — set once after sign-in so
  // item_history can record it. See setActor below.
  _actor: null,
  setActor(name) { this._actor = name || null; },

  // Firm-internal note on an item (not exposed to clients). Logged so the
  // activity feed shows "· {actor} เพิ่มโน้ต".
  async setItemNote(itemId, note) {
    const { error } = await supabase
      .from("request_items").update({ firm_note: note }).eq("id", itemId);
    if (error) throw error;
    if (note && note.trim()) await this._logHistory(itemId, "Firm", "Note");
  },

  // ---- per-item comment thread (firm ⇄ client) ----
  async listComments(itemId) {
    const { data, error } = await supabase
      .from("item_comments").select("id, by, author, body, created_at").eq("item_id", itemId).order("created_at");
    if (error) throw error;
    return (data || []).map((c) => ({ id: c.id, by: c.by, author: c.author, body: c.body, at: toTs(c.created_at) }));
  },
  async addComment(itemId, engagementId, body) {
    const text = (body || "").trim();
    if (!text) return;
    const { error } = await supabase.from("item_comments")
      .insert({ item_id: itemId, engagement_id: engagementId, by: "Firm", author: this._actor, body: text.slice(0, 2000) });
    if (error) throw error;
    await this._logHistory(itemId, "Firm", "Commented");
  },

  // Firm review transitions. `note` is only used for "returned".
  async setItemStatus(itemId, status, action, note) {
    const patch = { status };
    if (note !== undefined) patch.note = note;
    const { error } = await supabase.from("request_items").update(patch).eq("id", itemId);
    if (error) throw error;
    if (action) await this._logHistory(itemId, "Firm", action);
  },

  startReview: (id) => firmApi.setItemStatus(id, "review", "Started review"),
  acceptItem: (id) => firmApi.setItemStatus(id, "accepted", "Accepted"),
  returnItem: (id, note) => firmApi.setItemStatus(id, "returned", "Returned", note),
  reopenItem: (id) => firmApi.setItemStatus(id, "outstanding", "Reopened", ""),

  async _logHistory(itemId, by, action) {
    const row = { item_id: itemId, by, action };
    if (by === "Firm" && this._actor) row.actor = this._actor;
    const { error } = await supabase.from("item_history").insert(row);
    if (error) throw error;
  },

  /* ---- files ---- */
  // Mark files as downloaded by the firm (RLS-scoped via item_files).
  async markFilesDownloaded(fileIds) {
    if (!fileIds || !fileIds.length) return;
    const { error } = await supabase
      .from("item_files").update({ firm_downloaded_at: new Date().toISOString() }).in("id", fileIds);
    if (error) throw error;
  },

  // Firm uploads a sample/reference file to an item (visible to the client).
  // Presigned PUT via the firmfiles function -> PUT to R2 -> record the row.
  async uploadSample(engagementId, itemId, file) {
    const { data, error } = await supabase.functions.invoke("firmfiles", {
      body: { action: "upload", engagement_id: engagementId, item_id: itemId, filename: file.name, type: file.type },
    });
    if (error) throw error;
    const res = await fetch(data.put_url, {
      method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
    const { error: e2 } = await supabase.from("item_files").insert({
      item_id: itemId, engagement_id: engagementId,
      name: file.name, size: file.size, type: file.type, storage_path: data.path, is_sample: true,
    });
    if (e2) throw e2;
  },

  async removeSample(fileId, storagePath) {
    await supabase.functions.invoke("firmfiles", { body: { action: "delete", storage_paths: [storagePath] } });
    const { error } = await supabase.from("item_files").delete().eq("id", fileId);
    if (error) throw error;
  },

  // Short-lived R2 download URL (presigned via the firmfiles function).
  // Pass { inline:true, contentType } to get an in-page preview URL instead.
  async signedDownloadUrl(storagePath, opts = {}) {
    const { data, error } = await supabase.functions.invoke("firmfiles", {
      body: {
        action: "download",
        storage_path: storagePath,
        inline: opts.inline || false,
        content_type: opts.contentType || null,
      },
    });
    if (error) throw error;
    return data.url;
  },
};

/* =====================================================================
   CLIENT API — no login. Everything goes through the `portal` Edge
   Function with the 16-digit code, then a session token (8h).
   ===================================================================== */
async function callPortal(action, payload = {}) {
  const res = await fetch(PORTAL_FN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.error || `portal ${action} failed (${res.status})`);
    err.status = res.status; // e.g. 401 wrong code, 429 throttled, 403 wrong item
    throw err;
  }
  return body;
}

export const clientApi = {
  // Verify the 16-digit code -> { token, expiresAt }. Throws on wrong code
  // (status 401), throttle lock (status 429), or a grouped portal (status 409).
  async unlock(engagementId, code) {
    const { token, expires_at } = await callPortal("unlock", {
      engagement_id: engagementId,
      code: String(code).replace(/\D/g, ""),
    });
    return { token, expiresAt: toTs(expires_at) };
  },

  // Verify a GROUP code -> a group session token that can reach every portal
  // in the group (one engagement at a time via engagementId below).
  async groupUnlock(groupId, code) {
    const { token, expires_at } = await callPortal("group_unlock", {
      group_id: groupId,
      code: String(code).replace(/\D/g, ""),
    });
    return { token, expiresAt: toTs(expires_at) };
  },

  // The group's companies + progress summary (for the client group dashboard).
  async groupData(token) {
    const { group, companies } = await callPortal("group_data", { token });
    return {
      group: group || null,
      companies: (companies || []).map((c) => ({
        id: c.id, client: c.client, template: c.template, periodEnd: toTs(c.period_end),
        total: c.total, accepted: c.accepted, pct: c.pct, by: c.by || {},
      })),
    };
  },

  // Load one portal's items + files (UI-shaped). `engagementId` is required
  // for a group session, ignored for a single-portal session.
  async fetchData(token, engagementId) {
    const { engagement, items } = await callPortal("data", { token, engagement_id: engagementId });
    return {
      engagement: engagement ? mapEngagement(engagement) : null,
      items: (items || []).map(mapItem),
    };
  },

  // High-level: upload one File for an item, end to end
  // (mint signed URL -> upload bytes -> confirm).
  async uploadDocument(token, itemId, file, engagementId) {
    const { path, put_url } = await callPortal("upload_url", {
      token,
      engagement_id: engagementId,
      item_id: itemId,
      filename: file.name,
      type: file.type,
    });

    const res = await fetch(put_url, {
      method: "PUT",
      body: file,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);

    await callPortal("confirm", {
      token,
      engagement_id: engagementId,
      item_id: itemId,
      name: file.name,
      size: file.size,
      type: file.type,
      storage_path: path,
    });
    return { storagePath: path };
  },

  // Delete one of the client's uploaded files (allowed until the firm accepts).
  async removeFile(token, itemId, fileId, engagementId) {
    await callPortal("remove_file", { token, engagement_id: engagementId, item_id: itemId, file_id: fileId });
  },

  // Signed URL to download a firm-provided sample file in this portal.
  async sampleUrl(token, fileId, engagementId) {
    const { url } = await callPortal("sample_url", { token, engagement_id: engagementId, file_id: fileId });
    return url;
  },

  // Inline presigned URL to PREVIEW any file in this portal (own upload or sample).
  async fileUrl(token, fileId, engagementId) {
    const { url } = await callPortal("file_url", { token, engagement_id: engagementId, file_id: fileId });
    return url;
  },

  // ---- per-item comment thread ----
  async listComments(token, itemId, engagementId) {
    const { comments } = await callPortal("list_comments", { token, engagement_id: engagementId, item_id: itemId });
    return (comments || []).map((c) => ({ id: c.id, by: c.by, author: c.author, body: c.body, at: toTs(c.created_at) }));
  },
  async addComment(token, itemId, engagementId, body) {
    await callPortal("add_comment", { token, engagement_id: engagementId, item_id: itemId, body });
  },
};
