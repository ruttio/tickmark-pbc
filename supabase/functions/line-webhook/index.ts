// =====================================================================
//  Edge Function: `line-webhook` — receives LINE Messaging API events.
//  Deploy with --no-verify-jwt (LINE calls it). Set this function's URL as the
//  channel's Webhook URL in the LINE Developers console.
//
//  Linking: a firm shows a one-time code in the app, adds the Tickmark bot as a
//  friend (or to a group), and sends the code. We match firms.line_link_code and
//  store the source (userId/groupId) as firms.line_target -> future uploads push
//  there.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyLineSignature, lineReply } from "../_shared/line.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok"); // LINE "Verify" button
  const bodyText = await req.text();
  const sig = req.headers.get("x-line-signature") || "";
  if (!(await verifyLineSignature(bodyText, sig))) return new Response("bad signature", { status: 401 });

  let body: any;
  try { body = JSON.parse(bodyText || "{}"); } catch { return new Response("ok"); }

  for (const ev of body.events || []) {
    const src = ev.source || {};
    const target = src.groupId || src.roomId || src.userId;
    if (ev.type === "message" && ev.message?.type === "text") {
      const text = String(ev.message.text || "").trim();
      const { data: firm } = await admin.from("firms").select("id").eq("line_link_code", text).maybeSingle();
      if (firm && target) {
        await admin.from("firms").update({ line_target: target, line_link_code: null }).eq("id", firm.id);
        await lineReply(ev.replyToken, "✅ เชื่อมต่อ Tickmark สำเร็จ! จะแจ้งเตือนที่นี่เมื่อลูกค้าอัปโหลดเอกสาร");
      } else if (/^(link|connect|เชื่อม|ผูก)/i.test(text)) {
        await lineReply(ev.replyToken, "ส่ง “รหัสเชื่อมต่อ” ที่ได้จากหน้าตั้งค่าในแอป Tickmark มาที่แชตนี้เพื่อผูกบัญชีครับ");
      }
    }
  }
  return new Response("ok");
});
