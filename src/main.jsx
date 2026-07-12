import React from "react";
import { createRoot } from "react-dom/client";
import App from "../pbc-portal.jsx";
import { initSentry, ErrorBoundary } from "../lib/sentry.jsx";

initSentry("firm");

function Fallback() {
  return (
    <div style={{ maxWidth: 420, margin: "80px auto", textAlign: "center", fontFamily: "'Inter','IBM Plex Sans Thai',sans-serif", color: "#0F172A" }}>
      <div style={{ fontSize: 40, marginBottom: 8 }}>⚠️</div>
      <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>เกิดข้อผิดพลาดบางอย่าง</h2>
      <p style={{ margin: "0 0 20px", color: "#64748B", fontSize: 14 }}>ระบบได้รับแจ้งปัญหานี้แล้ว ลองรีเฟรชหน้าอีกครั้ง</p>
      <button onClick={() => window.location.reload()} style={{ background: "#12B39A", color: "#fff", border: 0, borderRadius: 10, padding: "10px 20px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
        รีเฟรชหน้า
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary fallback={<Fallback />}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
