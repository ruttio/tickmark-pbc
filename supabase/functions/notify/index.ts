// =====================================================================
//  Edge Function: `notify`  — sends client notification emails (via Resend).
//  Deploy:  supabase functions deploy notify   (JWT verification ON — only
//           authenticated firm staff may trigger emails)
//
//  Secrets needed (supabase secrets set ...):
//    RESEND_API_KEY   - from resend.com
//    NOTIFY_FROM      - e.g. "Tickmark PBC <noreply@tickmark-pbc.com>" (optional)
//    APP_URL          - e.g. "https://tickmark-pbc.com" (optional)
//
//  Body: { engagement_id, kind: 'invite' | 'returned', item_id? }
//  The caller's JWT identifies the firm user; we verify they own the
//  engagement before sending. The 16-digit code is never emailed (share it
//  out of band).
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // identify the firm user from their JWT
  const userClient = createClient(SUPABASE_URL, ANON, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const engagement_id = String(body.engagement_id || "");
  const kind = String(body.kind || "");

  // authorize: the engagement must belong to the caller's (approved) firm
  const { data: prof } = await admin.from("profiles").select("firm_id, approved").eq("id", user.id).maybeSingle();
  if (!prof || !prof.approved) return json({ error: "not approved" }, 403);
  const { data: eng } = await admin.from("engagements")
    .select("id, client, client_email, template, firm_id").eq("id", engagement_id).maybeSingle();
  if (!eng || eng.firm_id !== prof.firm_id) return json({ error: "engagement not found" }, 404);
  if (!eng.client_email) return json({ error: "no client email on this portal" }, 400);

  const portalUrl = `${APP_URL}/client.html?e=${eng.id}`;
  const replyTo = user.email || undefined;
  const foot = "เข้าพอร์ทัลด้วยรหัส 16 หลักที่สำนักงานแจ้งให้ทางช่องทางอื่น · หากไม่ได้คาดหวังอีเมลนี้ โปรดละเว้น";

  let subject: string, html: string;
  if (kind === "invite") {
    subject = `เอกสารที่ต้องจัดเตรียม — ${eng.client}`;
    html = shell(`เรียน ${eng.client}`,
      `สำนักงานได้เปิดพอร์ทัลสำหรับงาน <b>${eng.template}</b> และมีรายการเอกสารที่ต้องจัดเตรียม โปรดเข้าพอร์ทัลเพื่ออัปโหลดเอกสาร`,
      portalUrl, "เข้าพอร์ทัลเพื่ออัปโหลด", foot);
  } else if (kind === "returned") {
    const item_id = String(body.item_id || "");
    let itemDesc = "";
    if (item_id) {
      const { data: it } = await admin.from("request_items")
        .select("description").eq("id", item_id).eq("engagement_id", eng.id).maybeSingle();
      itemDesc = it?.description || "";
    }
    subject = `มีเอกสารที่ต้องแก้ไข — ${eng.client}`;
    html = shell("มีเอกสารที่ต้องแก้ไข",
      `สำนักงานได้ส่งกลับเอกสาร${itemDesc ? ` “<b>${itemDesc}</b>”` : ""} เพื่อให้แก้ไข/ส่งใหม่ โปรดเข้าพอร์ทัลเพื่อดูหมายเหตุและอัปโหลดอีกครั้ง`,
      portalUrl, "เปิดดูและแก้ไข", foot);
  } else {
    return json({ error: "unknown kind" }, 400);
  }

  try {
    await sendEmail(eng.client_email, subject, html, replyTo);
    return json({ ok: true, to: eng.client_email });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
