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

// RFC 5987 / RFC 6266 Content-Disposition. `filename*=UTF-8''…` is what
// carries Thai filenames — the plain `filename=` fallback is ASCII-only, so
// without the starred form a browser that ignores it would land on mojibake.
// Quotes and backslashes are stripped from the fallback rather than escaped:
// it is a last resort for old clients, and a broken quote there breaks the
// whole header.
function contentDisposition(disposition: string, filename?: string): string {
  if (!filename) return disposition;
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// Presigned GET (download), valid for `expiresIn` seconds.
// opts.disposition ("inline" | "attachment") + opts.contentType are baked into
// the signed query (S3 response-* overrides) so the browser can render a PDF /
// image in-page instead of forcing a download.
//
// opts.filename sets the name the browser saves under. Without it the browser
// falls back to the last segment of the object key, which in this bucket is a
// storage path like `1784625369175_TB_for_LB_25.xlsx` — the upload timestamp
// we prepend to keep keys unique. That leaked into the firm's own archives,
// and worse, back into the portal when a downloaded file was re-uploaded as a
// correction. Offline archiving is this product's retention story, so the
// name a file lands under is not cosmetic.
export async function presignGet(
  key: string,
  expiresIn = 120,
  opts: { disposition?: string; contentType?: string; filename?: string } = {},
): Promise<string> {
  const u = new URL(objUrl(key));
  u.searchParams.set("X-Amz-Expires", String(expiresIn));
  const disposition = opts.disposition || (opts.filename ? "attachment" : "");
  if (disposition) {
    u.searchParams.set("response-content-disposition", contentDisposition(disposition, opts.filename));
  }
  if (opts.contentType) u.searchParams.set("response-content-type", opts.contentType);
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

// HEAD an object → its REAL size / content-type / etag (checksum). null if absent.
// Used to verify a client actually uploaded, and to trust server-side metadata
// instead of client-declared values.
export async function headObject(
  key: string,
): Promise<{ size: number; contentType: string; etag: string } | null> {
  const res = await aws.fetch(objUrl(key), { method: "HEAD" });
  if (!res.ok) { await res.body?.cancel?.(); return null; }
  return {
    size: Number(res.headers.get("content-length") || 0),
    contentType: res.headers.get("content-type") || "",
    etag: (res.headers.get("etag") || "").replace(/"/g, ""),
  };
}

// Delete objects (signed request, server-side). Throws if ANY object survives:
// callers delete the DB rows that hold storage_path right after this, and those
// rows are the only record an object exists — a silent failure here orphans the
// object in the bucket forever. 404 counts as success (S3 delete is idempotent).
export async function deleteObjects(keys: string[]): Promise<void> {
  const failed: string[] = [];
  await Promise.all(keys.map(async (k) => {
    const res = await aws.fetch(objUrl(k), { method: "DELETE" });
    await res.body?.cancel?.();
    if (!res.ok && res.status !== 404) failed.push(`${k} (${res.status})`);
  }));
  if (failed.length) {
    throw new Error(`R2 delete failed for ${failed.length}/${keys.length} object(s): ${failed.join(", ")}`);
  }
}

// Every object in the bucket, with key + size + last-modified. Same paginated
// ListObjectsV2 as bucketUsage, but keeps the keys so callers can reconcile the
// bucket against the DB. Shared bucket: this returns EVERY firm's objects.
export async function listObjects(): Promise<{ key: string; size: number; lastModified: number }[]> {
  const out: { key: string; size: number; lastModified: number }[] = [];
  let token: string | undefined;
  do {
    const u = new URL(`${ENDPOINT}/`);
    u.searchParams.set("list-type", "2");
    u.searchParams.set("max-keys", "1000");
    if (token) u.searchParams.set("continuation-token", token);
    const res = await aws.fetch(u.toString(), { method: "GET" });
    if (!res.ok) throw new Error(`R2 list failed (${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const c = m[1];
      const key = c.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      if (!key) continue;
      out.push({
        key: key.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
        size: Number(c.match(/<Size>(\d+)<\/Size>/)?.[1] || 0),
        lastModified: Date.parse(c.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] || "") || 0,
      });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]?.replace(/&amp;/g, "&")
      : undefined;
  } while (token);
  return out;
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
