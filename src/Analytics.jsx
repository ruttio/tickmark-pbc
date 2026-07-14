// Firm dashboard analytics — completion trend, average turnaround, and request
// aging in three toggleable modes, optionally filtered to one client.
// Self-contained inline styles + SVG (no chart library).
import React, { useEffect, useState } from "react";
import { buildReportHtml, openReport } from "./analyticsReport.js";

const MINT = "#12B39A", SLATE = "#64748B";
const AGE_COLORS = ["#12B39A", "#F59E0B", "#FB923C", "#EF4444"];
const AGE_LABELS = ["0–7 วัน", "7–14 วัน", "14–30 วัน", "30+ วัน"];
const MODES = [
  { key: "requested", label: "ตั้งแต่ขอ", desc: "งานที่ยังไม่ตรวจรับ · นับตั้งแต่วันที่ขอเอกสาร" },
  { key: "waiting", label: "รอเราตรวจ", desc: "งานที่ลูกค้าอัปโหลดแล้ว รอสำนักงานตรวจ · นับตั้งแต่อัปโหลดล่าสุด" },
  { key: "overdue", label: "เกินกำหนด", desc: "งานที่ยังไม่ตรวจรับและเลยกำหนดส่ง · จำนวนวันที่เกิน" },
];
const EMPTY_AGE = { d0_7: 0, d7_14: 0, d14_30: 0, d30: 0 };
const STATUS_DEFS = [
  { key: "outstanding", label: "รอลูกค้าส่ง", color: "#94A3B8" },
  { key: "submitted", label: "รอเราตรวจ", color: "#3B82F6" },
  { key: "review", label: "กำลังตรวจ", color: "#F59E0B" },
  { key: "returned", label: "ส่งกลับแก้ไข", color: "#EF4444" },
  { key: "reopened", label: "เปิดใหม่", color: "#A855F7" },
  { key: "accepted", label: "ตรวจรับแล้ว", color: "#12B39A" },
];
// Submission timing distribution — bins of days-before-due, ordered
// left (submitted early) → right (submitted late). "due" = on the due date.
const TIMING_BINS = [
  { key: "e22", label: "≥22" },
  { key: "e15", label: "15–21" },
  { key: "e8", label: "8–14" },
  { key: "e4", label: "4–7" },
  { key: "e1", label: "1–3" },
  { key: "due", label: "กำหนด", due: true },
  { key: "l1", label: "สาย 1–3" },
  { key: "l4", label: "สาย 4–6" },
  { key: "l7", label: "สาย ≥7" },
];

// Smooth SVG path (Catmull-Rom → cubic bezier) through points for a density curve.
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C ${p1.x + (p2.x - p0.x) / 6} ${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6} ${p2.y - (p3.y - p1.y) / 6} ${p2.x} ${p2.y}`;
  }
  return d;
}
const RT_ROWS = [
  { key: "clientRespond", icon: "🧑‍💼", label: "ลูกค้าตอบสนอง · ขอ → อัปโหลด" },
  { key: "firmReview", icon: "🏢", label: "สำนักงานตรวจ · อัปโหลด → ตรวจรับ" },
  { key: "firmView", icon: "👀", label: "เปิดดูเอกสาร · อัปโหลด → เปิดครั้งแรก" },
  { key: "firmReply", icon: "💬", label: "สำนักงานตอบคอมเมนต์" },
  { key: "clientReply", icon: "💬", label: "ลูกค้าตอบคอมเมนต์" },
];

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
  pdfBtn: { marginLeft: "auto", font: "600 12px 'Inter','IBM Plex Sans Thai',sans-serif", border: "1px solid #E5E7EB", borderRadius: 9, padding: "7px 12px", color: "#0F172A", background: "#fff", cursor: "pointer" },
  err: { fontSize: 11.5, color: "#EF4444" },
};

export function Analytics({ initialData = null, engagements = [], fetchAnalytics, fetchEvidence }) {
  const [client, setClient] = useState("");
  const [mode, setMode] = useState("requested");
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState("");

  // Pull the log rows behind the numbers, then hand the report to the print
  // dialog. Fetched on demand: it is a lot of rows, and most dashboard visits
  // never export.
  async function exportPdf() {
    if (!fetchEvidence) return;
    setExporting(true); setExportErr("");
    try {
      const evidence = await fetchEvidence(client || null);
      const scope = client ? engagements.find((e) => e.id === client)?.client || "ลูกค้าที่เลือก" : "ทุกลูกค้า";
      const ok = openReport(buildReportHtml({ data, evidence, scopeLabel: scope }));
      if (!ok) setExportErr("เบราว์เซอร์บล็อกป๊อปอัป — อนุญาตป๊อปอัปของเว็บนี้แล้วลองใหม่");
    } catch {
      setExportErr("ดึง log ไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setExporting(false);
    }
  }

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

  const sb = data?.statusBreakdown || {};
  const sbTotal = sb.total || 0;
  const acceptedPct = sbTotal ? Math.round(((sb.accepted || 0) / sbTotal) * 100) : 0;
  const aging = (data?.aging || {})[mode] || EMPTY_AGE;
  const ageVals = [aging.d0_7, aging.d7_14, aging.d14_30, aging.d30].map((n) => n || 0);
  const ageTotal = ageVals.reduce((a, b) => a + b, 0);
  const modeMeta = MODES.find((m) => m.key === mode);

  const timing = data?.submissionTiming || {};
  const timingBins = TIMING_BINS.map((b) => ({ ...b, n: timing[b.key] || 0 }));
  const timeTotal = timingBins.reduce((a, b) => a + b.n, 0);
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
        {fetchEvidence && (
          <button style={S.pdfBtn} onClick={exportPdf} disabled={exporting || loading}>
            {exporting ? "กำลังรวบรวม log…" : "📄 ส่งออก PDF (พร้อมวิธีคำนวณ)"}
          </button>
        )}
        {exportErr && <span style={S.err}>{exportErr}</span>}
      </div>

      <div style={S.grid} className="nv-analytics">
        {/* Current status pipeline */}
        <div style={S.card}>
          <p style={S.h}>📋 สรุปสถานะปัจจุบัน ({sbTotal})</p>
          {sbTotal === 0 ? (
            <div style={S.empty}>ยังไม่มีรายการ</div>
          ) : (
            <>
              <div style={{ ...S.stat, marginBottom: 2 }}>{acceptedPct}% <span style={{ fontSize: 14, fontWeight: 700 }}>ตรวจรับแล้ว</span></div>
              <div style={S.statSub}>{sb.accepted || 0} จาก {sbTotal} รายการ</div>
              <div style={{ ...S.agingBar, marginTop: 10 }}>
                {STATUS_DEFS.map((s) => (sb[s.key] || 0) > 0 && (
                  <span key={s.key} title={`${s.label}: ${sb[s.key]}`} style={{ width: `${((sb[s.key] || 0) / sbTotal) * 100}%`, background: s.color }} />
                ))}
              </div>
              {STATUS_DEFS.map((s) => (
                <div key={s.key} style={S.agingRow}>
                  <span style={S.dot(s.color)} />
                  <span style={{ flex: 1 }}>{s.label}</span>
                  <b>{sb[s.key] || 0}</b>
                </div>
              ))}
            </>
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
        {/* Submission timing vs due date — density curve */}
        <div style={S.card}>
          <p style={S.h}>📅 ลูกค้าส่งเอกสารเทียบกำหนดส่ง ({timeTotal})</p>
          {timeTotal === 0 ? (
            <div style={S.empty}>ยังไม่มีข้อมูลการส่ง</div>
          ) : (() => {
            const VW = 360, VH = 150, padL = 14, padR = 14, base = 112, top = 20;
            const maxN = Math.max(1, ...timingBins.map((b) => b.n));
            const plotW = VW - padL - padR;
            const pts = timingBins.map((b, i) => ({ x: padL + (i * plotW) / (timingBins.length - 1), y: base - (b.n / maxN) * (base - top), n: b.n, due: b.due, label: b.label }));
            const dueX = pts.find((p) => p.due)?.x ?? VW / 2;
            const curve = smoothPath(pts);
            const area = `${curve} L ${pts[pts.length - 1].x} ${base} L ${pts[0].x} ${base} Z`;
            return (
              <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" height="150" preserveAspectRatio="xMidYMid meet" role="img" aria-label="การกระจายเวลาส่งเทียบกำหนดส่ง">
                <defs>
                  <linearGradient id="tmg" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#12B39A" stopOpacity="0.85" />
                    <stop offset="55%" stopColor="#F59E0B" stopOpacity="0.8" />
                    <stop offset="100%" stopColor="#EF4444" stopOpacity="0.85" />
                  </linearGradient>
                </defs>
                <line x1={padL} y1={base} x2={VW - padR} y2={base} stroke="#E5E7EB" strokeWidth="1" />
                <path d={area} fill="url(#tmg)" opacity="0.28" />
                <path d={curve} fill="none" stroke="url(#tmg)" strokeWidth="2.5" />
                {/* due-date marker */}
                <line x1={dueX} y1={top - 6} x2={dueX} y2={base} stroke="#EF4444" strokeWidth="1.3" strokeDasharray="3 3" />
                <text x={dueX} y={top - 9} textAnchor="middle" fontSize="9" fontWeight="700" fill="#EF4444">กำหนดส่ง</text>
                {pts.map((p, i) => (
                  <g key={i}>
                    <circle cx={p.x} cy={p.y} r={p.n > 0 ? 2.6 : 0} fill="#fff" stroke="#0F172A" strokeWidth="1.2" />
                    {p.n > 0 && <text x={p.x} y={p.y - 6} textAnchor="middle" fontSize="8" fontWeight="700" fill="#0F172A">{p.n}</text>}
                    <text x={p.x} y={base + 12} textAnchor="middle" fontSize="7.5" fill="#94A3B8">{p.label}</text>
                  </g>
                ))}
                <text x={padL} y={VH - 3} textAnchor="start" fontSize="8.5" fill="#12B39A" fontWeight="600">← ส่งล่วงหน้า</text>
                <text x={VW - padR} y={VH - 3} textAnchor="end" fontSize="8.5" fill="#EF4444" fontWeight="600">ส่งสาย →</text>
              </svg>
            );
          })()}
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
