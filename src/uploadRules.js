// Upload rules mirrored on the client for instant UX feedback. The portal Edge
// Function enforces the same rules authoritatively (client checks are advisory).
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
export const ALLOWED_EXT = [
  "pdf", "jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic",
  "xlsx", "xls", "xlsm", "csv", "docx", "doc", "pptx", "ppt", "txt", "zip",
];

export function extOf(name) {
  return String(name || "").includes(".") ? String(name).split(".").pop().toLowerCase() : "";
}

// Returns a Thai error message if the file is not allowed, else null.
export function fileError(file) {
  if (!ALLOWED_EXT.includes(extOf(file?.name))) return "ชนิดไฟล์นี้ไม่รองรับ (รองรับ PDF, รูป, Excel, Word, ZIP)";
  if ((file?.size || 0) > MAX_FILE_BYTES) return "ไฟล์ใหญ่เกิน 50 MB";
  return null;
}
