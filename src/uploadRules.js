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

// Returns an error message if the file is not allowed, else null. `lang`
// picks the message language for the client portal ('en' for a foreign
// client); defaults to Thai, which is what the firm side and any other
// caller want.
const FILE_ERR = {
  th: { type: "ชนิดไฟล์นี้ไม่รองรับ (รองรับ PDF, รูป, Excel, Word, ZIP)", big: "ไฟล์ใหญ่เกิน 50 MB" },
  en: { type: "This file type is not supported (PDF, images, Excel, Word, ZIP allowed)", big: "File is larger than 50 MB" },
};
export function fileError(file, lang = "th") {
  const m = FILE_ERR[lang] || FILE_ERR.th;
  if (!ALLOWED_EXT.includes(extOf(file?.name))) return m.type;
  if ((file?.size || 0) > MAX_FILE_BYTES) return m.big;
  return null;
}
