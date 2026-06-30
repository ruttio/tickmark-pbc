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
  async listEngagements() {
    const { data, error } = await supabase
      .from("engagements")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []).map(mapEngagement);
  },

  // Same list, plus per-engagement progress (total / accepted / by-status / pct)
  // for the firm dashboard. One extra query aggregates item statuses client-side.
  async listEngagementsWithProgress() {
    const list = await this.listEngagements();
    const { data: rows, error } = await supabase
      .from("request_items")
      .select("engagement_id, status");
    if (error) throw error;
    const agg = {};
    (rows || []).forEach((r) => {
      const a = (agg[r.engagement_id] ||= { total: 0, accepted: 0, by: {} });
      a.total++;
      a.by[r.status] = (a.by[r.status] || 0) + 1;
      if (r.status === "accepted") a.accepted++;
    });
    return list.map((e) => {
      const a = agg[e.id] || { total: 0, accepted: 0, by: {} };
      return { ...e, total: a.total, accepted: a.accepted, by: a.by,
        pct: a.total ? Math.round((a.accepted / a.total) * 100) : 0 };
    });
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

    return { ...mapEngagement(eng), items: (items || []).map(mapItem) };
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

  // Delete a portal. NOTE: this removes the DB rows (items/files/history
  // cascade) but NOT the objects in storage — firm staff have SELECT but
  // not DELETE on storage.objects. Add a delete_engagement RPC/Edge action
  // (service role) if you need the files purged immediately; otherwise the
  // nightly purge only covers auto_delete + expired portals.
  async deleteEngagement(engagementId) {
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

  // Recent client activity across the firm's portals, for the notification
  // center. Each is "unread" if it happened after the firm last viewed that
  // portal (engagements.firm_seen_at).
  async listNotifications(limit = 100) {
    const { data, error } = await supabase
      .from("item_history")
      .select("id, at, action, request_items!inner(description, engagement_id, engagements!inner(client, firm_seen_at))")
      .eq("by", "Client")
      .order("at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).map((h) => {
      const it = h.request_items || {};
      const e = it.engagements || {};
      return {
        id: h.id,
        at: toTs(h.at),
        action: h.action,
        itemDescription: it.description || "",
        engagementId: it.engagement_id,
        client: e.client || "",
        unread: !e.firm_seen_at || new Date(h.at) > new Date(e.firm_seen_at),
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

  // Firm-internal note on an item (not exposed to clients).
  async setItemNote(itemId, note) {
    const { error } = await supabase
      .from("request_items").update({ firm_note: note }).eq("id", itemId);
    if (error) throw error;
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
    const { error } = await supabase.from("item_history").insert({ item_id: itemId, by, action });
    if (error) throw error;
  },

  /* ---- files ---- */
  // Private bucket -> short-lived signed URL the firm can open to download.
  async signedDownloadUrl(storagePath, expiresInSeconds = 60) {
    const { data, error } = await supabase.storage
      .from("pbc")
      .createSignedUrl(storagePath, expiresInSeconds);
    if (error) throw error;
    return data.signedUrl;
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
  // (status 401) or throttle lock (status 429).
  async unlock(engagementId, code) {
    const { token, expires_at } = await callPortal("unlock", {
      engagement_id: engagementId,
      code: String(code).replace(/\D/g, ""),
    });
    return { token, expiresAt: toTs(expires_at) };
  },

  // Load this portal's items + files (UI-shaped). No history on the client side.
  async fetchData(token) {
    const { engagement, items } = await callPortal("data", { token });
    return {
      engagement: engagement ? mapEngagement(engagement) : null,
      items: (items || []).map(mapItem),
    };
  },

  // High-level: upload one File for an item, end to end
  // (mint signed URL -> upload bytes -> confirm).
  async uploadDocument(token, itemId, file) {
    const { path, signed } = await callPortal("upload_url", {
      token,
      item_id: itemId,
      filename: file.name,
      type: file.type,
    });

    const { error } = await supabase.storage
      .from("pbc")
      .uploadToSignedUrl(path, signed.token, file);
    if (error) throw error;

    await callPortal("confirm", {
      token,
      item_id: itemId,
      name: file.name,
      size: file.size,
      type: file.type,
      storage_path: path,
    });
    return { storagePath: path };
  },

  // Delete one of the client's uploaded files (allowed until the firm accepts).
  async removeFile(token, itemId, fileId) {
    await callPortal("remove_file", { token, item_id: itemId, file_id: fileId });
  },
};
