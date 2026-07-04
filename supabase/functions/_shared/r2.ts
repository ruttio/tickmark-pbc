// =====================================================================
//  Cloudflare R2 helpers (S3-compatible) — presigned URLs + delete.
//  Files live in R2, not Supabase Storage. Credentials stay server-side.
//
//  Secrets: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// =====================================================================
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID")!;
const BUCKET = Deno.env.get("R2_BUCKET") || "pbc";
const ENDPOINT = `https://${ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`;

const aws = new AwsClient({
  accessKeyId: Deno.env.get("R2_ACCESS_KEY_ID")!,
  secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY")!,
  region: "auto",
  service: "s3",
});

const objUrl = (key: string) =>
  `${ENDPOINT}/${key.split("/").map(encodeURIComponent).join("/")}`;

// Presigned GET (download), valid for `expiresIn` seconds.
export async function presignGet(key: string, expiresIn = 120): Promise<string> {
  const u = new URL(objUrl(key));
  u.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signed = await aws.sign(u.toString(), { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

// Presigned PUT (upload) — the browser PUTs the file bytes to this URL.
export async function presignPut(key: string, expiresIn = 600): Promise<string> {
  const u = new URL(objUrl(key));
  u.searchParams.set("X-Amz-Expires", String(expiresIn));
  const signed = await aws.sign(u.toString(), { method: "PUT", aws: { signQuery: true } });
  return signed.url;
}

// Delete objects (signed request, server-side).
export async function deleteObjects(keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => aws.fetch(objUrl(k), { method: "DELETE" })));
}
