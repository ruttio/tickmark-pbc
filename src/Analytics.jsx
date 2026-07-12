// Firm dashboard analytics — completion trend, request aging, avg turnaround.
// Self-contained inline styles + SVG (no chart library). Data comes from the
// firm_analytics() RPC.
import React from "react";

const MINT = "#12B39A", SLATE = "#64748B";
const AGE_COLORS = ["#12B39A", "#F59E0B", "#FB923C", "#EF4444"];
const AGE_LABELS = ["0–7 วัน", "7–14 วัน", "14–30 วัน", "30+ วัน"];

function fmtWeek(iso) {
  const d = new Date(iso);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

const S = {
  grid: { display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14 },
  card: { background: "#fff", border: "1px solid #E5E7EB", borderRadius: 12, padding: "13px 15px" },
  h: { font: "700 12.5px 'Inter','IBM Plex Sans Thai',sans-serif", color: "#0F172A", margin: "0 0 10px" },
  empty: { color: "#94A3B8", fontSize: 12, padding: "18px 0", textAlign: "center" },
  stat: { font: "800 30px 'Inter',sans-serif", color: MINT, lineHeight: 1 },
  statSub: { font: "400 11.5px 'Inter','IBM Plex Sans Thai',sans-serif", color: SLATE, marginTop: 4 },
  agingRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 7, fontSize: 11.5, color: "#334155" },
  dot: (c) => ({ width: 9, height: 9, borderRadius: 3, background: c, flex: "none" }),
  agingBar: { display: "flex", height: 12, borderRadius: 6, overflow: "hidden", background: "#F1F5F9", marginBottom: 4 },
};

export function Analytics({ data }) {
  if (!data) return null;
  const weekly = data.weekly || [];
  const aging = data.aging || { d0_7: 0, d7_14: 0, d14_30: 0, d30: 0 };
  const ageVals = [aging.d0_7, aging.d7_14, aging.d14_30, aging.d30].map((n) => n || 0);
  const ageTotal = ageVals.reduce((a, b) => a + b, 0);
  const maxN = Math.max(1, ...weekly.map((w) => w.n));
  const W = Math.max(weekly.length, 1) * 42;

  return (
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
          {data.turnaroundCount ? (
            <>
              <div style={S.stat}>{data.avgTurnaround} <span style={{ fontSize: 15, fontWeight: 700 }}>วัน</span></div>
              <div style={S.statSub}>เฉลี่ยจาก {data.turnaroundCount} รายการที่ตรวจรับแล้ว</div>
            </>
          ) : (
            <div style={S.empty}>ยังไม่มีรายการที่ตรวจรับ</div>
          )}
        </div>

        <div style={S.card}>
          <p style={S.h}>⏳ อายุงานที่ยังค้าง ({ageTotal})</p>
          {ageTotal === 0 ? (
            <div style={S.empty}>ไม่มีงานค้าง 🎉</div>
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
  );
}
