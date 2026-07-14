export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PORTAL_BYTES = 2 * 1024 * 1024 * 1024;

export const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  "pdf", "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic",
  "xlsx", "xls", "xlsm", "csv", "docx", "doc", "pptx", "ppt", "txt", "zip",
]);

export function uploadExtension(name: string): string {
  const text = String(name || "");
  return text.includes(".") ? text.split(".").pop()!.toLowerCase() : "";
}

export function isAllowedUploadName(name: string): boolean {
  return ALLOWED_UPLOAD_EXTENSIONS.has(uploadExtension(name));
}

export function storedBytes(rows: Array<{ size?: unknown }> | null | undefined): number {
  return (rows || []).reduce((total, row) => {
    const size = Number(row?.size || 0);
    return total + (Number.isFinite(size) && size > 0 ? size : 0);
  }, 0);
}

export function exceedsPortalQuota(
  rows: Array<{ size?: unknown }> | null | undefined,
  incomingBytes: unknown,
): boolean {
  const incoming = Number(incomingBytes);
  return !Number.isFinite(incoming) || incoming < 0 || storedBytes(rows) + incoming > MAX_PORTAL_BYTES;
}
