// =====================================================================
//  Edge Function: `notify`  — sends client notification emails (via Resend).
//  Deploy:  supabase functions deploy notify
//  (verify_jwt = true — every caller is a signed-in firm user. There is
//   deliberately no machine/cron entry point here; see below.)
//
//  Secrets needed (supabase secrets set ...):
//    RESEND_API_KEY   - from resend.com
//    NOTIFY_FROM      - e.g. "Tickmark PBC <noreply@tickmark-pbc.com>" (optional)
//    APP_URL          - e.g. "https://tickmark-pbc.com" (optional)
//
//  One request shape — human-triggered, firm-authenticated:
//       { engagement_id, kind: 'invite' | 'returned' | 'reminder', force? }
//  The caller's JWT identifies the firm user; we verify they are an approved
//  member of the engagement before sending. The 16-digit code is never emailed.
//
//  WHY NO AUTOMATIC REMINDER: a scheduled sweep was built and deliberately
//  dropped. The firm chases clients over LINE by hand, so an emailed reminder
//  duplicates a channel the clients actually read — and the only way to let a
//  cron in was to disable this function's JWT verification and guard it with a
//  static shared secret living in two places with no rotation path. That is a
//  real cost for automating a button click. If it is ever revived, prefer
//  scheduling from inside Supabase so no credential has to leave it, and note
//  that scripts/verify-deployment.mjs pins notify's verify_jwt to true on
//  purpose — that tripwire has to be changed consciously.
//
//  Dedupe: every actual send is logged to notify_log, keyed on
//  (engagement_id, kind, Bangkok-local send month, portal period_key) with a
//  DB UNIQUE constraint (migrations 20260715000200 + 20260720130000) — so a
//  double-click cannot email the client twice for the same thing. The log row
//  is written BEFORE the email is sent (claiming the slot): if two requests
//  race, only one wins the insert and only that one emails; if the send then
//  fails, the claim is released so a later retry can actually succeed instead
//  of being silently swallowed as "already sent" forever.
//
//  A human can pass `force: true` to bypass the dedupe gate and resend
//  regardless of what already went out (e.g. the client says they never
//  received it). A forced send still refreshes notify_log afterwards.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { bangkokPeriod, isUniqueViolation, type NotifyKind } from "../_shared/reminders.ts";

// The subset of a `periods` row the email-building/dedupe code needs.
type PeriodRef = { id: string; period_key: string; label: string };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM = Deno.env.get("NOTIFY_FROM") || "Tickmark PBC <noreply@tickmark-pbc.com>";
const APP_URL = Deno.env.get("APP_URL") || "https://tickmark-pbc.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...cors } });

const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function sendEmail(to: string, subject: string, html: string, replyTo?: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, reply_to: replyTo }),
  });
  if (!res.ok) throw new Error("resend: " + (await res.text()));
  return res.json();
}

const shell = (title: string, intro: string, url: string, cta: string, foot: string) => `
<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;color:#16241f">
  <div style="background:#16241f;color:#f3f5ef;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:600">
    ✓ Tickmark <span style="opacity:.6;font-size:12px">PBC portal</span>
  </div>
  <div style="border:1px solid #d9dcd2;border-top:0;border-radius:0 0 12px 12px;padding:22px 20px">
    <h2 style="font-family:Georgia,serif;margin:0 0 10px;font-size:20px">${title}</h2>
    <p style="font-size:14px;line-height:1.6;color:#4b5b53;margin:0 0 18px">${intro}</p>
    <a href="${url}" style="display:inline-block;background:#115e4a;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:8px">${cta}</a>
    <p style="font-size:12px;color:#8a988f;margin:18px 0 0;line-height:1.6">${foot}</p>
  </div>
</div>`;

const FOOT = "เข้าเว็บไซต์ด้วยรหัส 16 หลักที่สำนักงานแจ้งให้ทางช่องทางอื่น · หากไม่ได้คาดหวังอีเมลนี้ โปรดละเว้น";

type BuiltEmail = { subject: string; html: string; itemCount: number | null };

// Builds the subject/html for one (engagement, kind) send. `periods` is the
// (already-resolved, always open) set of portal periods this send covers —
// ignored for 'invite', which is portal-level and has no period dimension.
//
// Every item is rendered under an explicit heading naming its period via
// `periods.label` (the Thai display form, e.g. 'ก.ค. 2569') — NEVER
// `period_key` (the sortable machine key, e.g. '2026-07'), which means
// nothing to a client and would read as a typo or an internal ID leaking
// through. This keeps the list unambiguous even in the rare case where more
// than one period is covered in the same email (see sendKind), and costs
// nothing in the common single-period case.
async function buildEmailForKind(
  eng: { id: string; client: string; template?: string | null },
  kind: NotifyKind,
  periods: PeriodRef[],
): Promise<BuiltEmail | { error: string }> {
  const portalUrl = `${APP_URL}/client.html?e=${eng.id}`;

  if (kind === "invite") {
    const subject = `เอกสารที่ต้องจัดเตรียม — ${eng.client}`;
    const html = shell(`เรียน ${eng.client}`,
      `สำนักงานได้เปิดเว็บไซต์สำหรับงาน <b>${eng.template}</b> และมีรายการเอกสารที่ต้องจัดเตรียม โปรดเข้าเว็บไซต์เพื่ออัปโหลดเอกสาร`,
      portalUrl, "เข้าเว็บไซต์เพื่ออัปโหลด", FOOT);
    return { subject, html, itemCount: null };
  }

  // 'returned' | 'reminder' — one email, scoped to the given (open) periods
  // only. `periods` never contains a closed period — the caller resolved
  // that already — so a closed month's items can never reach this query.
  const wantStatus = kind === "returned" ? "returned" : "outstanding";
  const periodIds = periods.map((p) => p.id);
  const { data: its } = await admin.from("request_items")
    .select("ref, description, period_id")
    .eq("engagement_id", eng.id).eq("status", wantStatus)
    .in("period_id", periodIds.length > 0 ? periodIds : ["00000000-0000-0000-0000-000000000000"])
    .order("sort");
  if (!its || its.length === 0) {
    return { error: kind === "returned" ? "ไม่มีรายการที่ส่งกลับให้แก้ไข" : "ไม่มีรายการที่ยังค้างอยู่" };
  }

  const byPeriod = new Map<string, any[]>();
  for (const i of its) {
    const list = byPeriod.get(i.period_id) || [];
    list.push(i);
    byPeriod.set(i.period_id, list);
  }
  // `periods` is caller-sorted by period_key (chronological, oldest first —
  // see remindersByPeriod); iterate in that order so sections read
  // oldest-month-first, never alphabetically on the Thai label.
  const sections = periods
    .filter((p) => (byPeriod.get(p.id) || []).length > 0)
    .map((p) => {
      const rows = byPeriod.get(p.id)!;
      const heading = `<p style="font-size:13px;font-weight:600;color:#115e4a;margin:16px 0 4px">${p.label}</p>`;
      const ul = `<ul style="font-size:14px;line-height:1.7;color:#16241f;margin:4px 0 6px;padding-left:20px">` +
        rows.map((i: any) => `<li>${i.ref ? i.ref + ". " : ""}${i.description}</li>`).join("") + `</ul>`;
      return heading + ul;
    }).join("");

  // Single-period sends (the common case) also get the month named in the
  // subject line, not just the body.
  const monthTag = periods.length === 1 ? ` — ${periods[0].label}` : "";

  if (kind === "returned") {
    const subject = `มีเอกสารที่ต้องแก้ไข (${its.length})${monthTag} — ${eng.client}`;
    const html = shell("มีเอกสารที่ต้องแก้ไข",
      `สำนักงานได้ส่งกลับเอกสารต่อไปนี้เพื่อให้แก้ไข/ส่งใหม่:${sections}โปรดเข้าเว็บไซต์เพื่อดูหมายเหตุและอัปโหลดอีกครั้ง`,
      portalUrl, "เปิดดูและแก้ไข", FOOT);
    return { subject, html, itemCount: its.length };
  }
  const subject = `เอกสารที่ยังรอจัดเตรียม (${its.length})${monthTag} — ${eng.client}`;
  const html = shell("ยังมีเอกสารที่รอจัดเตรียม",
    `รายการต่อไปนี้ยังไม่ได้รับ โปรดจัดเตรียมและอัปโหลด:${sections}`,
    portalUrl, "เข้าเว็บไซต์เพื่ออัปโหลด", FOOT);
  return { subject, html, itemCount: its.length };
}

// Every currently-open period for an engagement, sorted oldest-first on the
// sortable machine key (never on `label`). Used as the fallback scope for a
// human-triggered send that doesn't specify a period_id — today's firm UI
// (pbc-portal.jsx) has no period picker yet, so "no period given" means
// "everything currently open".
async function fetchOpenPeriods(engagementId: string): Promise<PeriodRef[]> {
  const { data } = await admin.from("periods")
    .select("id, period_key, label")
    .eq("engagement_id", engagementId).eq("status", "open")
    .order("period_key");
  return data || [];
}

// Sends one (engagement, kind) email covering the given period(s), gated by
// notify_log unless `force`. Returns an HTTP-shaped result.
//
// `opts.periods`:
//   - kind === 'invite': ignored entirely (never period-scoped).
//   - kind !== 'invite' and periods given (a future firm-UI period picker
//     would pass exactly one): scoped to precisely those.
//   - kind !== 'invite' and periods omitted (today's firm UI — pbc-portal.jsx
//     has no period picker yet): falls back to every currently-open period,
//     bundled into ONE email so a single button click still produces a
//     single result, exactly like before this migration.
//
// Dedupe claims one notify_log row PER covered period (period_key = '' for
// 'invite', which has no period). If ANY covered period's slot is already
// claimed this month, the whole send is treated as "already sent" and NONE
// of the slots are consumed — a half-email covering only the periods that
// happened to still be free would be more confusing than useful. `force` is
// the escape hatch when the firm genuinely needs to re-send.
async function sendKind(
  eng: { id: string; client: string; client_email: string; template?: string | null },
  kind: NotifyKind,
  opts: { replyTo?: string; force?: boolean; sentBy?: string | null; periods?: PeriodRef[] },
): Promise<{ status: number; body: any }> {
  let periods: PeriodRef[] = [];
  if (kind !== "invite") {
    periods = opts.periods ?? await fetchOpenPeriods(eng.id);
    if (periods.length === 0) {
      return { status: 400, body: { error: "ไม่มีช่วงเวลาที่เปิดอยู่ในพอร์ทัลนี้" } };
    }
  }

  const built = await buildEmailForKind(eng, kind, periods);
  if ("error" in built) return { status: 400, body: { error: built.error } };

  const sendMonth = bangkokPeriod();
  const sentBy = opts.sentBy ?? null;
  const force = opts.force === true;
  const claimKeys = kind === "invite" ? [""] : periods.map((p) => p.period_key);
  const claimedIds: string[] = [];

  if (!force) {
    // Claim every covered period's slot BEFORE sending: each INSERT is the
    // race guard for that period. If a concurrent request already claimed
    // (engagement_id, kind, period, period_key), the UNIQUE constraint
    // rejects THIS row with 23505 — that is success ("already sent"), not a
    // server error, but it means the combined email can't proceed cleanly
    // (see function comment), so roll back whatever we did claim so far.
    for (const periodKey of claimKeys) {
      const { data, error } = await admin.from("notify_log")
        .insert({ engagement_id: eng.id, kind, period: sendMonth, period_key: periodKey, sent_by: sentBy, item_count: built.itemCount })
        .select("id").single();
      if (error) {
        if (claimedIds.length) await admin.from("notify_log").delete().in("id", claimedIds);
        if (isUniqueViolation(error)) {
          return { status: 200, body: { ok: true, already_sent: true, to: eng.client_email } };
        }
        return { status: 500, body: { error: error.message } };
      }
      claimedIds.push(data!.id);
    }
  }

  try {
    await sendEmail(eng.client_email, built.subject, built.html, opts.replyTo);
  } catch (e) {
    // The send failed — release every claim so a retry (this month is still
    // open) can actually go out, instead of being permanently blocked by log
    // rows that recorded a send that never happened.
    if (claimedIds.length) await admin.from("notify_log").delete().in("id", claimedIds);
    return { status: 500, body: { error: String((e as Error)?.message || e) } };
  }

  if (force) {
    // Record/refresh the ledger for every covered period so a later
    // non-forced click doesn't send a redundant copy in the same month.
    // Try an update first (there may already be a row from an earlier
    // non-forced send or an earlier force); if nothing matched, insert one.
    // A concurrent insert racing this one is fine either way — the goal is
    // just "a row exists for this period", not attributing it to a sender.
    const nowIso = new Date().toISOString();
    for (const periodKey of claimKeys) {
      const { data: updated } = await admin.from("notify_log")
        .update({ sent_at: nowIso, sent_by: sentBy, item_count: built.itemCount })
        .eq("engagement_id", eng.id).eq("kind", kind).eq("period", sendMonth).eq("period_key", periodKey)
        .select("id");
      if (!updated || updated.length === 0) {
        await admin.from("notify_log")
          .insert({ engagement_id: eng.id, kind, period: sendMonth, period_key: periodKey, sent_by: sentBy, item_count: built.itemCount });
      }
    }
  }

  return { status: 200, body: { ok: true, to: eng.client_email } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }

  // ---- human-triggered: identify the firm user from their JWT ----
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  const engagement_id = String(body.engagement_id || "");
  const kind = String(body.kind || "");

  // authorize: caller must be an approved user AND a member of this portal
  const { data: prof } = await admin.from("profiles").select("approved").eq("id", user.id).maybeSingle();
  if (!prof || !prof.approved) return json({ error: "not approved" }, 403);
  const { data: mem } = await admin.from("portal_members")
    .select("role").eq("engagement_id", engagement_id).eq("user_id", user.id).maybeSingle();
  if (!mem) return json({ error: "not a member of this portal" }, 403);
  const { data: eng } = await admin.from("engagements")
    .select("id, client, client_email, template").eq("id", engagement_id).maybeSingle();
  if (!eng) return json({ error: "engagement not found" }, 404);
  if (!eng.client_email) return json({ error: "no client email on this portal" }, 400);
  // same precedence as before this migration: kind is validated last, after
  // the auth/membership/engagement checks above.
  if (!["invite", "returned", "reminder"].includes(kind)) return json({ error: "unknown kind" }, 400);

  const replyTo = user.email || undefined;
  const force = body.force === true;

  const { status, body: respBody } = await sendKind(eng, kind as NotifyKind, { replyTo, force, sentBy: user.id });
  return json(respBody, status);
});
