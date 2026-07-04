// =====================================================================
//  LINE Messaging API helpers (push / reply / webhook signature).
//  Secrets: LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET
//  Push/reply fail soft (log, don't throw) so they never break the caller.
// =====================================================================
const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";

export async function linePush(to: string, text: string): Promise<void> {
  if (!TOKEN || !to) return; // not configured / no linked target -> skip
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) console.error("line push failed:", res.status, await res.text());
}

export async function lineReply(replyToken: string, text: string): Promise<void> {
  if (!TOKEN || !replyToken) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  }).catch(() => {});
}

// Verify the X-Line-Signature header (base64 HMAC-SHA256 of the raw body).
export async function verifyLineSignature(bodyText: string, signature: string): Promise<boolean> {
  const secret = Deno.env.get("LINE_CHANNEL_SECRET") || "";
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return b64 === signature;
}
