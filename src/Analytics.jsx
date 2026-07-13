// Firm dashboard analytics — completion trend, average turnaround, and request
// aging in three toggleable modes, optionally filtered to one client.
// Self-contained inline styles + SVG (no chart library).
import React, { useEffect, useState } from "react";

const MINT = "#12B39A", SLATE = "#64748B";
const AGE_COLORS = ["#12B39A", "#F59E0B", "#FB923C", "#EF4444"];
const AGE_LABELS = ["0–7 วัน", "7–14 วัน", "14–30 วัน", "30+ วัน"];
const MODES = [
  { key: "requested", label: "ตั้งแต่ขอ", desc: "งานที่ยังไม่ตรวจรับ · นับตั้งแต่วันที่ขอเอกสาร" },
  { key: "waiting", label: "รอเราตรวจ", desc: "งานที่ลูกค้าอัปโหลดแล้ว รอสำนักงานตรวจ · นับตั้งแต่อัปโหลดล่าสุด" },
  { key: "overdue", label: "เกินกำหนด", desc: "งานที่ยังไม่ตรวจรับและเลยกำหนดส่ง · จำนวนวันที่เกิน" },
];
const EMPTY_AGE = { d0_7: 0, d7_14: 0, d14_30: 0, d30: 0 };
const TIME_LABELS = ["ล่วงหน้า >14 วัน", "8–14 วัน", "4–7 วัน", "1–3 วัน (ชิดเส้น)", "ตรง/สายกว่ากำหนด"];
const TIME_COLORS = ["#12B39A", "#5EB38F", "#F59E0B", "#FB923C", "#EF4444"];
const RT_ROWS = [
  { key: "clientRespond", icon: "🧑‍💼", label: "ลูกค้าตอบสนอง · ขอ → อัปโหลด" },
  { key: "firmReview", icon: "🏢", label: "สำนักงานตรวจ · อัปโหลด → ตรวจรับ" },
  { key: "firmView", icon: "👀", label: "เปิดดูเอกสาร · อัปโหลด → เปิดครั้งแรก" },
  { key: "firmReply", icon: "💬", label: "สำนักงานตอบคอมเมนต์" },
  { key: "clientReply", icon: "💬", label: "ลูกค้าตอบคอมเมนต์" },
];

function fmtWeek(iso) { const d = new Date(iso); return `${d.getDate()}/${d.getMonth() + 1}`; }

const S = {
  toolbar: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" },
  tlabel: { font: "600 12px 'Inter','IBM Plex Sans Thai',sans-serif", color: "#334155", display: "inline-flex", alignItems: "center", gap: 6 },
  select: { font: "500 12.5px 'Inter','IBM Plex Sans Thai',sans-serif", border: "1px solid #E5E7EB", borderRadius: 9, padding: "6px 9px", color: "#0F172A", background: "#fff", maxWidth: 260 },
  loading: { fontSize: 11.5, color: SLATE },
  grid: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 },
  card: { background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "13px 15px" },
  h: { font: "700 12.5px 'Inter','IBM Plex Sans Thai',sans-serif", color: "#0F172A", margin: "0 0 10px" },
  empty: { color: "#94A3B8", fontSize: 12, padding: "18px 0", textAlign: "center" },
  stat: { font: "800 30px 'Inter',sans-serif", color: MINT, lineHeight: 1 },
  statSub: { font: "400 11.5px 'Inter','IBM Plex Sans Thai',sans-serif", color: SLATE, marginTop: 4 },
  seg: { display: "inline-flex", background: "#F1F5F9", borderRadius: 9, padding: 2, marginBottom: 6, gap: 2 },
  segBtn: { border: 0, background: "transparent", color: SLATE, font: "600 11px 'Inter','IBM Plex Sans Thai',sans-serif", padding: "5px 9px", borderRadius: 7, cursor: "pointer" },
  segOn: { background: "#fff", color: "#0F172A", boxShadow: "0 1px 3px rgba(8,26,52,.12)" },
  modeDesc: { font: "400 10.5px 'Inter','IBM Plex Sans Thai',sans-serif", color: SLATE, margin: "2px 0 10px" },
  agingRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 7, fontSize: 11.5, color: "#334155" },
  dot: (c) => ({ width: 9, height: 9, borderRadius: 3, background: c, flex: "none" }),
  agingBar: { display: "flex", height: 12, borderRadius: 6, overflow: "hidden", background: "#F1F5F9", marginBottom: 4 },
  rtRow: { display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid #F1F5F9", fontSize: 12, color: "#334155" },
  rtVal: { font: "800 13px 'Inter',sans-serif", color: "#0F172A" },
  rtN: { fontSize: 10.5, color: SLATE, width: 34, textAlign: "right" },
};

export function Analytics({ initialData = null, engagements = [], fetchAnalytics }) {
  const [client, setClient] = useState("");
  const [mode, setMode] = useState("requested");
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!fetchAnalytics) return;
    let live = true; setLoading(true);
    fetchAnalytics(client || null)
      .then((d) => { if (live) setData(d); })
      .catch(() => {})
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const weekly = data?.weekly || [];
  const aging = (data?.aging || {})[mode] || EMPTY_AGE;
  const ageVals = [aging.d0_7, aging.d7_14, aging.d14_30, aging.d30].map((n) => n || 0);
  const ageTotal = ageVals.reduce((a, b) => a + b, 0);
  const maxN = Math.max(1, ...weekly.map((w) => w.n));
  const W = Math.max(weekly.length, 1) * 42;
  const modeMeta = MODES.find((m) => m.key === mode);

  const timing = data?.submissionTiming || {};
  const timeVals = [timing.early15, timing.d8_14, timing.d4_7, timing.d1_3, timing.late].map((n) => n || 0);
  const timeTotal = timeVals.reduce((a, b) => a + b, 0);
  const rt = data?.responseTimes || {};

  return (
    <div>
      <div style={S.toolbar}>
        <label style={S.tlabel}>ลูกค้า:
          <select style={S.select} value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">ทุกลูกค้า</option>
            {engagements.map((e) => (
              <option key={e.id} value={e.id}>{e.client}{e.template ? ` · ${e.template}` : ""}</option>
            ))}
          </select>
        </label>
        {loading && <span style={S.loading}>กำลังโหลด…</span>}
      </div>

      <div style={S.grid} className="nv-analytics">
        {/* Completion trend */}
        <div style={S.card}>
          <p style={S.h}>📈 รายการที่ตรวจรับ · 8 สัปดาห์ล่าสุด</p>
          {weekly.length === 0 ? (
            <div style={S.empty}>ยังไม่มีข้อมูลการตรวจรับ</div>
          ) : (
            <svg viewBox={`0 0 ${W} 104`} width="100%" height="120" preserveAspectRatio="xMidYMid meet" role="img" aria-label="รายการที่ตรวจรับต่อสัปดาห์">
              {weekly.map((w, i) => {
                const h = Math.round((w.n / maxN) * 68);
                const x = i * 42 + 9;
                return (
                  <g key={i}>
                    <rect x={x} y={82 - h} width={24} height={h || 2} rx={3} fill={MINT} />
                    <text x={x + 12} y={Math.max(10, 82 - h - 4)} textAnchor="middle" fontSize="9" fontWeight="700" fill="#0F172A">{w.n}</text>
                    <text x={x + 12} y={97} textAnchor="middle" fontSize="8" fill={SLATE}>{fmtWeek(w.week)}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>

        {/* Turnaround + aging */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={S.card}>
            <p style={S.h}>⚡ เวลาเฉลี่ยจนตรวจรับ</p>
            {data?.turnaroundCount ? (
              <>
                <div style={S.stat}>{data.avgTurnaround} <span style={{ fontSize: 15, fontWeight: 700 }}>วัน</span></div>
                <div style={S.statSub}>เฉลี่ยจาก {data.turnaroundCount} รายการที่ตรวจรับแล้ว</div>
              </>
            ) : (
              <div style={S.empty}>ยังไม่มีรายการที่ตรวจรับ</div>
            )}
          </div>

          <div style={S.card}>
            <p style={S.h}>⏳ อายุงาน ({ageTotal})</p>
            <div style={S.seg}>
              {MODES.map((m) => (
                <button key={m.key} style={{ ...S.segBtn, ...(mode === m.key ? S.segOn : {}) }} onClick={() => setMode(m.key)}>{m.label}</button>
              ))}
            </div>
            <div style={S.modeDesc}>{modeMeta.desc}</div>
            {ageTotal === 0 ? (
              <div style={S.empty}>{mode === "overdue" ? "ไม่มีงานเกินกำหนด 🎉" : "ไม่มีงานค้าง 🎉"}</div>
            ) : (
              <>
                <div style={S.agingBar}>
                  {ageVals.map((n, i) => n > 0 && (
                    <span key={i} title={`${AGE_LABELS[i]}: ${n}`} style={{ width: `${(n / ageTotal) * 100}%`, background: AGE_COLORS[i] }} />
                  ))}
                </div>
                {ageVals.map((n, i) => (
                  <div key={i} style={S.agingRow}>
                    <span style={S.dot(AGE_COLORS[i])} />
                    <span style={{ flex: 1 }}>{AGE_LABELS[i]}</span>
                    <b>{n}</b>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ ...S.grid, marginTop: 14 }} className="nv-analytics">
        {/* Submission timing vs due date */}
        <div style={S.card}>
          <p style={S.h}>📅 ลูกค้าส่งเอกสารเทียบกำหนดส่ง ({timeTotal})</p>
          {timeTotal === 0 ? (
            <div style={S.empty}>ยังไม่มีข้อมูลการส่ง</div>
          ) : (
            <>
              <div style={S.agingBar}>
                {timeVals.map((n, i) => n > 0 && (
                  <span key={i} title={`${TIME_LABELS[i]}: ${n}`} style={{ width: `${(n / timeTotal) * 100}%`, background: TIME_COLORS[i] }} />
                ))}
              </div>
              {timeVals.map((n, i) => (
                <div key={i} style={S.agingRow}>
                  <span style={S.dot(TIME_COLORS[i])} />
                  <span style={{ flex: 1 }}>{TIME_LABELS[i]}</span>
                  <b>{n}</b>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Response times by side */}
        <div style={S.card}>
          <p style={S.h}>⏱️ เวลาตอบสนองเฉลี่ย (วัน)</p>
          {RT_ROWS.map((r) => {
            const v = rt[r.key] || {};
            return (
              <div key={r.key} style={S.rtRow}>
                <span>{r.icon}</span>
                <span style={{ flex: 1 }}>{r.label}</span>
                <span style={S.rtVal}>{v.avg != null ? `${v.avg} วัน` : "—"}</span>
                <span style={S.rtN}>{v.n ? `(${v.n})` : ""}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
