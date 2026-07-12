// Shared in-portal file preview — used by BOTH the firm app (pbc-portal.jsx)
// and the client portal (ClientPortal.jsx). Styles are inline + self-contained
// so it doesn't depend on either app's CSS scoping (tk- vs nv-).
import React from "react";

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];

function extOf(name) {
  return String(name || "").split(".").pop().toLowerCase();
}

// What kind of viewer (if any) can render this file inline.
export function previewKind(file) {
  const t = (file?.type || "").toLowerCase();
  const ext = extOf(file?.name);
  if (t.startsWith("image/") || IMAGE_EXT.includes(ext)) return "image";
  if (t === "application/pdf" || ext === "pdf") return "pdf";
  return "other";
}

// Only images + PDFs can be previewed in-browser without extra libraries.
export function isPreviewable(file) {
  return previewKind(file) !== "other";
}

const S = {
  overlay: {
    position: "fixed", inset: 0, zIndex: 9999, background: "rgba(8,15,30,.62)",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
  },
  panel: {
    background: "#fff", borderRadius: 14, width: "min(920px, 100%)", height: "min(88vh, 100%)",
    display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 60px rgba(8,26,52,.35)",
    fontFamily: "'Inter','IBM Plex Sans Thai',sans-serif",
  },
  head: {
    display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
    borderBottom: "1px solid #E5E7EB", flex: "none",
  },
  name: { fontWeight: 600, fontSize: 14, color: "#0F172A", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 },
  link: { fontSize: 13, color: "#12B39A", textDecoration: "none", fontWeight: 600, flex: "none" },
  close: { border: 0, background: "#F1F5F9", color: "#334155", borderRadius: 8, width: 30, height: 30, fontSize: 15, cursor: "pointer", flex: "none" },
  body: { flex: 1, minHeight: 0, background: "#F8FAFC", display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" },
  img: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
  iframe: { width: "100%", height: "100%", border: 0 },
  other: { color: "#64748B", fontSize: 14, textAlign: "center", padding: 24 },
};

// file: { name, type }  ·  url: resolved presigned URL  ·  onClose: () => void
export function FilePreviewModal({ file, url, onClose }) {
  const kind = previewKind(file);
  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.panel} onClick={(e) => e.stopPropagation()}>
        <div style={S.head}>
          <span style={S.name}>{file?.name}</span>
          {url && <a style={S.link} href={url} target="_blank" rel="noreferrer">เปิดแท็บใหม่ ↗</a>}
          <button style={S.close} onClick={onClose} aria-label="ปิด">✕</button>
        </div>
        <div style={S.body}>
          {!url ? (
            <div style={S.other}>กำลังโหลด…</div>
          ) : kind === "image" ? (
            <img style={S.img} src={url} alt={file?.name} />
          ) : kind === "pdf" ? (
            <iframe style={S.iframe} src={url} title={file?.name} />
          ) : (
            <div style={S.other}>
              ไฟล์นี้ดูตัวอย่างในหน้าไม่ได้<br />
              <a style={S.link} href={url} target="_blank" rel="noreferrer">ดาวน์โหลดเพื่อเปิด</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
