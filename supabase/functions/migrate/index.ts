// =====================================================================
//  One-time migration: copy every stored file from Supabase Storage -> R2.
//  Deploy with --no-verify-jwt; guarded by MIGRATE_SECRET. Call once, then
//  it can be deleted. Idempotent (re-copying overwrites the same key).
//    POST { secret }  ->  { copied, failed, errors }
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { uploadObject } from "../_shared/r2.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  const body = await req.json().catch(() => ({}));
  if (body?.secret !== Deno.env.get("MIGRATE_SECRET")) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
  }

  const { data: files, error } = await admin.from("item_files").select("storage_path, type");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let copied = 0, failed = 0;
  const errors: string[] = [];
  for (const f of files || []) {
    const key = f.storage_path as string;
    try {
      const { data: blob, error: dlErr } = await admin.storage.from("pbc").download(key);
      if (dlErr || !blob) throw new Error(dlErr?.message || "download failed");
      await uploadObject(key, await blob.arrayBuffer(), f.type || "application/octet-stream");
      copied++;
    } catch (e) {
      failed++;
      errors.push(`${key}: ${(e as Error).message}`);
    }
  }
  return new Response(JSON.stringify({ total: (files || []).length, copied, failed, errors }), {
    headers: { "Content-Type": "application/json" },
  });
});
