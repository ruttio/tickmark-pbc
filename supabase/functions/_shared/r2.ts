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

// Total stored bytes + object count for the whole bucket (shared across all
// firms). S3 ListObjectsV2, paginated. Used for the "bucket overall" figure so
// a firm can see how much of the 10 GB free tier is actually left.
export async function bucketUsage(): Promise<{ bytes: number; count: number }> {
  let bytes = 0, count = 0, token: string | undefined;
  do {
    const u = new URL(`${ENDPOINT}/`);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("max-keys", "1000");
    if (token) u.searchParams.set("continuation-token", token);
    const res = await aws.fetch(u.toString(), { method: "GET" });
    if (!res.ok) throw new Error(`R2 list failed (${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Size>(\d+)<\/Size>/g)) { bytes += Number(m[1]); count++; }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]?.replace(/&amp;/g, "&")
      : undefined;
  } while (token);
  return { bytes, count };
}

// Upload bytes server-side (used by the one-time migration).
export async function uploadObject(key: string, body: ArrayBuffer | Uint8Array | Blob, contentType?: string): Promise<void> {
  const res = await aws.fetch(objUrl(key), {
    method: "PUT",
    body,
    headers: contentType ? { "Content-Type": contentType } : {},
  });
  if (!res.ok) throw new Error(`R2 put ${key} failed (${res.status})`);
}
