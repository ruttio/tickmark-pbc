// Shared per-item comment thread — used by BOTH the firm Drawer and the client
// row. Presentation only + self-contained inline styles (no tk-/nv- coupling);
// the parent loads `comments` and handles `onSend`.
import React, { useState } from "react";

function fmtWhen(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

const S = {
  list: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflowY: "auto", padding: "2px 0" },
  empty: { color: "#94A3B8", fontSize: 13, textAlign: "center", padding: "14px 8px" },
  row: { display: "flex" },
  bubble: { maxWidth: "82%", borderRadius: 12, padding: "7px 11px", fontSize: 13, lineHeight: 1.45 },
  mine: { background: "rgba(18,179,154,.12)", color: "#0F172A", borderBottomRightRadius: 3 },
  theirs: { background: "#F1F5F9", color: "#0F172A", borderBottomLeftRadius: 3 },
  meta: { fontSize: 10.5, color: "#64748B", marginBottom: 2, fontWeight: 600 },
  body: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
  inputRow: { display: "flex", gap: 8, marginTop: 10, alignItems: "flex-end" },
  input: {
    flex: 1, resize: "none", border: "1px solid #E5E7EB", borderRadius: 10, padding: "9px 11px",
    fontSize: 13, fontFamily: "inherit", lineHeight: 1.4, maxHeight: 120, minHeight: 38, outline: "none",
  },
  send: {
    flex: "none", border: 0, background: "#12B39A", color: "#fff", borderRadius: 10,
    padding: "0 16px", height: 38, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  },
};

// comments: [{ id, by:'Firm'|'Client', author, body, at }] · meSide: which side "I" am.
export function CommentThread({ comments = [], onSend, busy, meSide = "Firm", loading }) {
  const [draft, setDraft] = useState("");
  const send = () => {
    const t = draft.trim();
    if (!t || busy) return;
    onSend(t);
    setDraft("");
  };
  return (
    <div>
      <div style={S.list}>
        {loading ? (
          <div style={S.empty}>กำลังโหลด…</div>
        ) : comments.length === 0 ? (
          <div style={S.empty}>ยังไม่มีความคิดเห็น — เริ่มพูดคุยเกี่ยวกับรายการนี้ได้เลย</div>
        ) : (
          comments.map((c) => {
            const mine = c.by === meSide;
            const who = c.by === "Firm" ? (c.author || "สำนักงาน") : "ลูกค้า";
            return (
              <div key={c.id} style={{ ...S.row, justifyContent: mine ? "flex-end" : "flex-start" }}>
                <div style={{ ...S.bubble, ...(mine ? S.mine : S.theirs) }}>
                  <div style={S.meta}>{who} · {fmtWhen(c.at)}</div>
                  <div style={S.body}>{c.body}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div style={S.inputRow}>
        <textarea
          style={S.input}
          rows={1}
          value={draft}
          placeholder="พิมพ์ข้อความ… (Enter เพื่อส่ง)"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <button style={{ ...S.send, opacity: busy || !draft.trim() ? 0.5 : 1 }} disabled={busy || !draft.trim()} onClick={send}>ส่ง</button>
      </div>
    </div>
  );
}
