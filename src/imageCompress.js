// Client-side downscale/recompress for photographed receipts, run right
// before upload. Why this exists: the portal has a 2GB/portal quota
// (MAX_PORTAL_BYTES, supabase/functions/_shared/uploadPolicy.ts) and clients
// on the monthly-bookkeeping workflow photograph paper receipts with their
// phones — 3-8MB per shot, dozens a month. Left uncompressed a single client
// chews through the quota in a few months. No new dependency is allowed here
// (Windows-generated package-lock breaks the Cloudflare build — see repo
// notes), so this leans entirely on browser-native createImageBitmap +
// <canvas> + canvas.toBlob.
//
// Tuning, chosen for "a photographed A4 receipt must stay readable enough
// for an accountant to key data off it":
//   MAX_DIMENSION = 2000px on the long edge. A4 at 2000px long-edge is
//   comfortably sharper than what's needed to read a thermal-printed
//   receipt's smallest line items, and well below the 4000-6000px modern
//   phone cameras natively shoot at — which is where most of the bloat in
//   a 3-8MB photo actually lives (resolution far past what a receipt needs).
//   JPEG_QUALITY = 0.82. Receipts are high-contrast text on a plain
//   background; JPEG block artifacts start fuzzing glyph edges well before
//   0.82, and digits (3 vs 8, 1 vs 7) are exactly what an accountant keys
//   off, so we don't push quality lower chasing marginal extra savings.
import { extOf } from "./uploadRules.js";

export const MAX_DIMENSION = 2000;
export const JPEG_QUALITY = 0.82;

// Raster formats canvas can realistically decode + re-encode.
//   - "svg" is vector, not a photo — compressing it is meaningless (and
//     would rasterize it), so it's treated as non-image here.
//   - "gif" is excluded even though it's a raster format: canvas flattens
//     multi-frame GIFs to a single frame, which is a silent content change
//     rather than a compression, so a GIF upload goes through untouched.
//   - "heic" is included (clients' phones default to it) but most browsers
//     cannot decode HEIC via createImageBitmap yet; that failure is caught
//     below and falls back to uploading the original file untouched.
const RASTER_EXT = new Set(["jpg", "jpeg", "png", "webp", "bmp", "heic"]);

export function isCompressibleImage(file) {
  return RASTER_EXT.has(extOf(file?.name));
}

// Re-encoding always produces JPEG bytes, so the extension has to follow or we
// hand the firm a file whose name lies about its contents — `bill.png` (or
// `bill.heic`) holding a JPEG. Preview survives that, because the portal
// presigns with the stored MIME type, but the ZIP export writes files by NAME,
// so the firm would end up opening mislabelled files on their desktop.
export function toJpegName(name) {
  const text = String(name || "image");
  const dot = text.lastIndexOf(".");
  // Leave a dotless name alone apart from appending the extension.
  return (dot > 0 ? text.slice(0, dot) : text) + ".jpg";
}

// Downscale + recompress `file` to JPEG when that yields a strictly smaller
// result. Never throws: any failure (unsupported decode, canvas error) or a
// non-improvement falls back to returning the original `file` unchanged, so
// callers can always do `const toSend = await compressImage(f)` and upload
// `toSend` without a try/catch of their own.
export async function compressImage(file, { maxDimension = MAX_DIMENSION, quality = JPEG_QUALITY } = {}) {
  if (!isCompressibleImage(file)) return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Most likely HEIC/HEIF on a browser without native decode support.
    return file;
  }

  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // Fill white first: JPEG has no alpha channel, so a transparent PNG
    // (e.g. a screenshotted digital invoice) would otherwise re-encode with
    // black where it used to be transparent.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size <= 0 || blob.size >= file.size) return file; // never make it bigger
    return new File([blob], toJpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap.close?.();
  }
}
