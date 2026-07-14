// Printable analytics report: the dashboard's numbers, the method behind each
// one, and the log rows they were computed from.
//
// The point of the report is that a reader never has to trust it. Every figure
// is recomputed here, in the browser, from the raw evidence rows returned by
// firm_analytics_evidence() — then checked against what firm_analytics()
// reported. The two are independent implementations of the same definitions, so
// a mismatch means one of them is wrong, and the report says so out loud
// instead of quietly showing the prettier number.
//
// recompute() therefore has to mirror 20260713000300_analytics.sql exactly.
// Change one, change the other.

const DAY_MS = 86400000;

// ---------------------------------------------------------------- definitions
// Bucket edges and labels, shared by recompute() and the rendered tables so the
// report can never describe a boundary it didn't actually use.
const AGE_BUCKETS = [
  { key: "d0_7", label: "0–7 วัน", test: (d) => d < 7 },
  { key: "d7_14", label: "7–14 วัน", test: (d) => d >= 7 && d < 14 },
  { key: "d14_30", label: "14–30 วัน", test: (d) => d >= 14 && d < 30 },
  { key: "d30", label: "30+ วัน", test: (d) => d >= 30 },
];
const AGE_MODES = [
  { key: "requested", label: "ตั้งแต่ขอ", rule: "งานที่ยังไม่ตรวจรับ (ไม่นับที่เก็บเข้าคลัง) · นับอายุจาก “ขอเอกสาร” ถึงเวลาออกรายงาน" },
  { key: "waiting", label: "รอเราตรวจ", rule: "งานสถานะ submitted/review · นับอายุจาก “อัปโหลดล่าสุด” ถึงเวลาออกรายงาน" },
  { key: "overdue", label: "เกินกำหนด", rule: "งานที่ยังไม่ตรวจรับและกำหนดส่งผ่านมาแล้ว · นับจำนวนวันที่เลยกำหนด" },
];
const TIMING_BINS = [
  { key: "e22", label: "≥22 วัน", test: (d) => d >= 22 },
  { key: "e15", label: "15–21 วัน", test: (d) => d >= 15 && d <= 21 },
  { key: "e8", label: "8–14 วัน", test: (d) => d >= 8 && d <= 14 },
  { key: "e4", label: "4–7 วัน", test: (d) => d >= 4 && d <= 7 },
  { key: "e1", label: "1–3 วัน", test: (d) => d >= 1 && d <= 3 },
  { key: "due", label: "ตรงกำหนด", test: (d) => d === 0 },
  { key: "l1", label: "สาย 1–3 วัน", test: (d) => d >= -3 && d <= -1 },
  { key: "l4", label: "สาย 4–6 วัน", test: (d) => d >= -6 && d <= -4 },
  { key: "l7", label: "สาย ≥7 วัน", test: (d) => d <= -7 },
];
// Colors mirror the dashboard exactly — the report is the same picture on paper,
// so a reader can hold them side by side. Both ramps clear CVD separation but sit
// under 3:1 against white, which means color may never be the only cue: every
// segment and point below carries its count as text, and the tables repeat them.
const STATUSES = [
  { key: "outstanding", label: "รอลูกค้าส่ง", color: "#94A3B8" },
  { key: "submitted", label: "รอเราตรวจ", color: "#3B82F6" },
  { key: "review", label: "กำลังตรวจ", color: "#F59E0B" },
  { key: "returned", label: "ส่งกลับแก้ไข", color: "#EF4444" },
  { key: "reopened", label: "เปิดใหม่", color: "#A855F7" },
  { key: "accepted", label: "ตรวจรับแล้ว", color: "#12B39A" },
];
const AGE_COLORS = ["#12B39A", "#F59E0B", "#FB923C", "#EF4444"];

// Each averaged metric, with the column it reads, how it is defined, and what
// disqualifies a row. `field` is null for the two comment metrics, which come
// from the reply pairs rather than the item rows.
const METRICS = [
  {
    key: "turnaround", field: "turnaroundDays", source: "items", label: "เวลาเฉลี่ยจนตรวจรับ",
    formula: "(เวลาตรวจรับครั้งแรก − เวลาขอเอกสาร) ÷ 86400 วินาที",
    logs: "item_history: แถวแรกสุดของงาน = เวลาขอ · แถว action ที่มีคำว่า “accept” แถวแรก = เวลาตรวจรับ",
    skip: "ไม่นับงานที่ยังไม่ตรวจรับ และงานที่เวลาตรวจรับอยู่ก่อนเวลาขอ (log ผิดลำดับ)",
  },
  {
    key: "clientRespond", field: "clientRespondDays", source: "items", label: "ลูกค้าตอบสนอง · ขอ → อัปโหลด",
    formula: "(อัปโหลดครั้งแรก − เวลาขอเอกสาร) ÷ 86400 วินาที",
    logs: "item_history: แถวแรกสุด = เวลาขอ · แถว action ที่มีคำว่า “submit” แถวแรก = อัปโหลดครั้งแรก",
    skip: "ไม่นับงานที่ลูกค้ายังไม่เคยอัปโหลด และงานที่อัปโหลดอยู่ก่อนเวลาขอ",
  },
  {
    key: "firmReview", field: "firmReviewDays", source: "items", label: "สำนักงานตรวจ · อัปโหลด → ตรวจรับ",
    formula: "(เวลาตรวจรับครั้งแรก − อัปโหลดครั้งล่าสุด) ÷ 86400 วินาที",
    logs: "item_history: แถว “submit” แถวล่าสุด = อัปโหลดล่าสุด · แถว “accept” แถวแรก = เวลาตรวจรับ",
    skip: "ไม่นับงานที่ยังไม่ตรวจรับ และงานที่ตรวจรับก่อนอัปโหลดล่าสุด (เช่น ตรวจรับแล้วลูกค้าอัปโหลดเพิ่ม)",
  },
  {
    key: "firmView", field: "firmViewDays", source: "items", label: "เปิดดูเอกสาร · อัปโหลด → เปิดครั้งแรก",
    formula: "(เวลาที่สำนักงานเปิด/ดาวน์โหลดไฟล์ครั้งแรก − อัปโหลดครั้งแรก) ÷ 86400 วินาที",
    logs: "item_files.firm_downloaded_at ค่าน้อยสุดของงาน · item_history แถว “submit” แถวแรก",
    skip: "ไม่นับงานที่สำนักงานยังไม่เคยเปิดไฟล์",
  },
  {
    key: "firmReply", field: null, source: "replies", label: "สำนักงานตอบคอมเมนต์",
    formula: "(เวลาคอมเมนต์ของสำนักงาน − เวลาคอมเมนต์ก่อนหน้าของลูกค้า) ÷ 86400 วินาที",
    logs: "item_comments เรียงตามเวลาในแต่ละงาน แล้วจับคู่เฉพาะจังหวะที่ ลูกค้า → สำนักงาน",
    skip: "ไม่นับคอมเมนต์ที่ต่อจากฝ่ายเดียวกันเอง และคอมเมนต์แรกของกระทู้",
  },
  {
    key: "clientReply", field: null, source: "replies", label: "ลูกค้าตอบคอมเมนต์",
    formula: "(เวลาคอมเมนต์ของลูกค้า − เวลาคอมเมนต์ก่อนหน้าของสำนักงาน) ÷ 86400 วินาที",
    logs: "item_comments เรียงตามเวลาในแต่ละงาน แล้วจับคู่เฉพาะจังหวะที่ สำนักงาน → ลูกค้า",
    skip: "ไม่นับคอมเมนต์ที่ต่อจากฝ่ายเดียวกันเอง และคอมเมนต์แรกของกระทู้",
  },
];

// ------------------------------------------------------------------- helpers
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// avg + n over the non-null values, rounded the way the SQL rounds: average at
// full precision first, round once at the end.
function avgOf(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  if (!nums.length) return { avg: null, n: 0, sum: 0 };
  const sum = nums.reduce((a, b) => a + b, 0);
  return { avg: round1(sum / nums.length), n: nums.length, sum };
}

const bucketOf = (defs, value) => defs.find((b) => b.test(value))?.key ?? null;
const zeros = (defs) => Object.fromEntries(defs.map((d) => [d.key, 0]));

// Server clock at query time. Aging is measured against it, not the browser's,
// so the report ages every row against the instant the RPC actually used.
const asOf = (evidence) => new Date(evidence?.now || Date.now());

const dateStr = (d) => d.toISOString().slice(0, 10);  // UTC, to match Postgres current_date

// ------------------------------------------------------------------ recompute
// Re-derive every dashboard figure from the raw log rows. Mirrors
// supabase/migrations/20260713000300_analytics.sql.
export function recompute(evidence) {
  const items = evidence?.items || [];
  const replies = evidence?.replies || [];
  const now = asOf(evidence);
  const today = dateStr(now);

  // statusBreakdown + aging ignore archived items; the averages below do not.
  const live = items.filter((i) => !i.archived);

  const statusBreakdown = { total: live.length };
  for (const s of STATUSES) statusBreakdown[s.key] = live.filter((i) => i.status === s.key).length;

  const ageDays = (ts) => (now - new Date(ts)) / DAY_MS;
  const agingRows = {
    requested: live.filter((i) => i.status !== "accepted" && i.requestedAt).map((i) => ({ item: i, days: ageDays(i.requestedAt) })),
    waiting: live.filter((i) => ["submitted", "review"].includes(i.status) && i.lastSubmit).map((i) => ({ item: i, days: ageDays(i.lastSubmit) })),
    overdue: live.filter((i) => i.status !== "accepted" && i.dueDate && i.dueDate < today).map((i) => ({ item: i, days: ageDays(`${i.dueDate}T00:00:00Z`) })),
  };
  const aging = {};
  for (const [mode, rows] of Object.entries(agingRows)) {
    aging[mode] = zeros(AGE_BUCKETS);
    for (const r of rows) aging[mode][bucketOf(AGE_BUCKETS, r.days)]++;
  }

  const submissionTiming = zeros(TIMING_BINS);
  const timingRows = items.filter((i) => i.daysBeforeDue != null);
  for (const i of timingRows) submissionTiming[bucketOf(TIMING_BINS, i.daysBeforeDue)]++;

  const turnaround = avgOf(items.map((i) => i.turnaroundDays));
  const responseTimes = {};
  for (const m of METRICS) {
    if (m.key === "turnaround") continue;
    responseTimes[m.key] = m.source === "items"
      ? avgOf(items.map((i) => i[m.field]))
      : avgOf(replies.filter((r) => r.by === (m.key === "firmReply" ? "Firm" : "Client")).map((r) => r.days));
  }

  return {
    statusBreakdown,
    avgTurnaround: turnaround.avg,
    turnaroundCount: turnaround.n,
    turnaroundSum: turnaround.sum,
    aging,
    agingRows,
    submissionTiming,
    timingRows,
    responseTimes,
    now,
  };
}

// Rows for the reconciliation table: dashboard figure vs the one recomputed
// from the logs. `ok` false means the two disagree and the report flags it.
export function reconcile(data, mine) {
  const sb = data?.statusBreakdown || {};
  const rt = data?.responseTimes || {};
  const rows = [
    { label: "จำนวนงานทั้งหมด (ไม่นับคลัง)", dash: sb.total ?? 0, mine: mine.statusBreakdown.total },
    { label: "ตรวจรับแล้ว", dash: sb.accepted ?? 0, mine: mine.statusBreakdown.accepted },
    { label: "เวลาเฉลี่ยจนตรวจรับ (วัน)", dash: data?.avgTurnaround ?? null, mine: mine.avgTurnaround },
    { label: "จำนวนงานที่เข้าค่าเฉลี่ยข้างต้น", dash: data?.turnaroundCount ?? 0, mine: mine.turnaroundCount },
  ];
  for (const m of METRICS) {
    if (m.key === "turnaround") continue;
    rows.push({ label: `${m.label} (วัน)`, dash: rt[m.key]?.avg ?? null, mine: mine.responseTimes[m.key].avg });
    rows.push({ label: `— จำนวนที่เข้าค่าเฉลี่ย`, dash: rt[m.key]?.n ?? 0, mine: mine.responseTimes[m.key].n });
  }
  for (const mode of AGE_MODES) {
    const dashB = (data?.aging || {})[mode.key] || {};
    const total = (k) => AGE_BUCKETS.reduce((a, b) => a + (k[b.key] || 0), 0);
    rows.push({ label: `อายุงาน · ${mode.label} (รวม)`, dash: total(dashB), mine: total(mine.aging[mode.key]) });
  }
  const tTotal = (t) => TIMING_BINS.reduce((a, b) => a + (t[b.key] || 0), 0);
  rows.push({ label: "การส่งเทียบกำหนด (รวม)", dash: tTotal(data?.submissionTiming || {}), mine: tTotal(mine.submissionTiming) });

  return rows.map((r) => ({ ...r, ok: (r.dash ?? null) === (r.mine ?? null) }));
}

// ------------------------------------------------------------------ insights
// Section numbers live here so a cross-reference in prose can never drift from
// the heading it points at.
const SEC = { summary: 1, advice: 2, check: 3, method: 4, items: 5, replies: 6, aging: 7, timing: 8 };

// Below these counts an average is a coincidence, not a finding. Rules that
// compare two averages stay silent until both sides clear MIN_N; the section as
// a whole carries a caveat while the portal is this young.
const MIN_N = 3;
const THIN_EVIDENCE = 5;

const SEVERITIES = {
  high: { label: "ด่วน", color: "#EF4444" },
  mid: { label: "ควรทำ", color: "#F59E0B" },
  low: { label: "เก็บงาน", color: "#3B82F6" },
  info: { label: "วางแผน", color: "#12B39A" },
};
const RANK = { high: 0, mid: 1, low: 2, info: 3 };

const names = (rows, n = 3) => rows.slice(0, n).map((r) => `${r.item.client} — ${r.item.description} (${Math.round(r.days)} วัน)`).join(" · ")
  + (rows.length > n ? ` · และอีก ${rows.length - n} รายการ` : "");

// Turn the recomputed figures into things to actually do. Every rule cites the
// numbers that triggered it and the section they can be checked in — a reader
// who disagrees with a recommendation can go audit the row it came from.
//
// Rules only fire on evidence that is actually in the report. There is no
// benchmark, no industry average, and no rule that fires on an empty portal:
// saying nothing is better than manufacturing an insight.
export function buildInsights(mine, evidence) {
  const items = (evidence?.items || []).filter((i) => !i.archived);
  const { statusBreakdown: sb, responseTimes: rt, agingRows, submissionTiming: st } = mine;
  const found = [];
  const daysSince = (ts) => (mine.now - new Date(ts)) / DAY_MS;

  // — เอกสารมาถึงแล้วแต่ฝั่งเรายังไม่ขยับ: the one failure the client can see and we cannot excuse.
  const unopened = items.filter((i) => i.firstSubmit && !i.viewedAt && ["submitted", "review"].includes(i.status));
  if (unopened.length) {
    const rows = unopened.map((i) => ({ item: i, days: daysSince(i.lastSubmit || i.firstSubmit) })).sort((a, b) => b.days - a.days);
    found.push({
      when: "now", sev: rows[0].days >= 7 ? "high" : "mid",
      title: `ลูกค้าส่งเอกสารแล้ว แต่เรายังไม่เปิดดูเลย ${unopened.length} รายการ`,
      finding: `ค้างนานสุด ${Math.round(rows[0].days)} วันนับจากอัปโหลด — ${names(rows)}`,
      action: "เปิดตรวจรายการเหล่านี้ก่อนงานอื่น เพราะลูกค้าทำส่วนของตัวเองเสร็จแล้วและกำลังรอเราอยู่",
      ref: SEC.items,
    });
  }

  // — เกินกำหนดแล้ว: rank by how far past due, not by how old the request is.
  const overdue = agingRows.overdue.slice().sort((a, b) => b.days - a.days);
  if (overdue.length) {
    found.push({
      when: "now", sev: overdue.some((r) => r.days >= 30) ? "high" : "mid",
      title: `งานเกินกำหนดส่ง ${overdue.length} รายการ`,
      finding: `เลยกำหนดมากสุด ${Math.round(overdue[0].days)} วัน — ${names(overdue)}`,
      action: "ทวงตามลำดับนี้ก่อน และรายการที่รู้อยู่แล้วว่าไม่ทัน ให้เลื่อนกำหนดส่งใหม่พร้อมแจ้งเหตุผล จะได้ไม่ค้างอยู่ในสถิติเกินกำหนดไปเรื่อย ๆ",
      ref: SEC.aging,
    });
  }

  // — ขอไปนานแล้วแต่เงียบ: distinct from overdue, these may have no due date at all.
  const silent = agingRows.requested.filter((r) => r.item.status === "outstanding" && !r.item.firstSubmit && r.days >= 30);
  if (silent.length) {
    found.push({
      when: "now", sev: "mid",
      title: `ขอเอกสารไปเกิน 30 วันแล้วแต่ลูกค้ายังไม่อัปโหลดอะไรเลย ${silent.length} รายการ`,
      finding: names(silent.slice().sort((a, b) => b.days - a.days)),
      action: "ยกหูโทรหาแทนการรอในระบบ — งานที่เงียบเกินหนึ่งเดือนมักไม่ได้ติดที่ความช้า แต่ติดที่ลูกค้าไม่เข้าใจว่าต้องส่งอะไร หรือหาเอกสารไม่เจอ",
      ref: SEC.aging,
    });
  }

  // — ใครคือคอขวด: only speak when both sides have enough rows to compare.
  if (rt.clientRespond.n >= MIN_N && rt.firmReview.n >= MIN_N) {
    const firmSlower = rt.firmReview.avg > rt.clientRespond.avg;
    found.push({
      when: "now", sev: "mid",
      title: firmSlower ? "คอขวดอยู่ที่ฝั่งสำนักงาน ไม่ใช่ลูกค้า" : "คอขวดอยู่ที่ฝั่งลูกค้า",
      finding: `ลูกค้าใช้เวลาส่งเฉลี่ย ${rt.clientRespond.avg} วัน (จาก ${rt.clientRespond.n} รายการ) · สำนักงานใช้เวลาตรวจรับเฉลี่ย ${rt.firmReview.avg} วัน (จาก ${rt.firmReview.n} รายการ)`,
      action: firmSlower
        ? "เอกสารมาถึงเร็วกว่าที่เราตรวจทัน — กันเวลาตรวจไว้เป็นรอบประจำ (เช่น เช้าวันจันทร์) จะได้ผลกว่าการเร่งลูกค้า เพราะเร่งลูกค้าให้เร็วขึ้นก็ไปกองรอเราอยู่ดี"
        : "ฝั่งเราตรวจเร็วกว่าที่เอกสารเข้ามา — ควรไปลงแรงที่การทวงและการอธิบายรายการให้ชัดตั้งแต่ต้น มากกว่าเร่งทีมตรวจ",
      ref: SEC.items,
    });
  }

  // — เปิดดูช้า: the firm sits on files even when it does eventually review them.
  if (rt.firmView.n >= MIN_N && rt.firmView.avg >= 2) {
    found.push({
      when: "now", sev: "low",
      title: `กว่าจะเปิดดูไฟล์ที่ลูกค้าส่งมา ใช้เวลาเฉลี่ย ${rt.firmView.avg} วัน`,
      finding: `วัดจาก ${rt.firmView.n} รายการ (อัปโหลดครั้งแรก → สำนักงานเปิดไฟล์ครั้งแรก)`,
      action: "ตั้งรอบเช็กงานเข้าใหม่ทุกวันทำการ การเปิดดูเร็วไม่ได้แปลว่าต้องตรวจเสร็จเร็ว แต่ทำให้จับได้เร็วว่าลูกค้าส่งผิดไฟล์หรือส่งไม่ครบ",
      ref: SEC.items,
    });
  }

  // — ไม่มีกำหนดส่ง: invisible to every deadline metric in this report.
  const noDue = items.filter((i) => !i.dueDate && i.status !== "accepted");
  if (noDue.length) {
    found.push({
      when: "now", sev: "low",
      title: `ยังไม่ได้ตั้งกำหนดส่ง ${noDue.length} รายการ`,
      finding: noDue.slice(0, 3).map((i) => `${i.client} — ${i.description}`).join(" · ") + (noDue.length > 3 ? ` · และอีก ${noDue.length - 3} รายการ` : ""),
      action: "ตั้งกำหนดส่งให้ครบ — รายการที่ไม่มีกำหนดจะไม่ถูกนับว่าเกินกำหนด ไม่เข้ากราฟหัวข้อ " + SEC.timing + " และไม่มีอะไรมาเตือน มันจึงเงียบหายได้โดยไม่มีใครรู้",
      ref: SEC.items,
    });
  }

  // — ส่งสายเป็นระบบ: a pattern, not a person. Fix the schedule, not the client.
  const late = st.l1 + st.l4 + st.l7;
  const timed = mine.timingRows.length;
  if (timed >= MIN_N && late / timed >= 0.3) {
    const lead = Math.ceil(rt.clientRespond.avg ?? 0);
    found.push({
      when: "next", sev: "mid",
      title: `ลูกค้าส่งสาย ${Math.round((late / timed) * 100)}% ของรายการที่มีกำหนดส่ง (${late} จาก ${timed})`,
      finding: `การส่งกระจุกอยู่ฝั่งขวาของเส้นกำหนดส่งในหัวข้อ ${SEC.timing}`,
      action: lead
        ? `นี่เป็นปัญหาตารางเวลา ไม่ใช่ปัญหาลูกค้าคนใดคนหนึ่ง — จากสถิติ ลูกค้าใช้เวลาราว ${lead} วันกว่าจะส่งหลังถูกขอ รอบหน้าจึงควรขอเอกสารล่วงหน้าอย่างน้อย ${lead} วันก่อนวันที่ต้องใช้จริง แทนที่จะขอแล้วตั้งกำหนดสั้น ๆ`
        : "รอบหน้าควรขอเอกสารล่วงหน้ามากขึ้น และตั้งเตือนก่อนถึงกำหนด ไม่ใช่หลังเลยกำหนดแล้ว",
      ref: SEC.timing,
    });
  }

  // — ตีกลับบ่อย: rework means the request itself was unclear.
  const rework = (sb.returned || 0) + (sb.reopened || 0);
  if (sb.total >= THIN_EVIDENCE && rework / sb.total >= 0.15) {
    found.push({
      when: "next", sev: "mid",
      title: `งานถูกส่งกลับแก้ไข/เปิดใหม่ ${rework} จาก ${sb.total} รายการ (${Math.round((rework / sb.total) * 100)}%)`,
      finding: `ดูสัดส่วนสถานะในหัวข้อ ${SEC.summary}`,
      action: "การตีกลับแปลว่าลูกค้าไม่รู้ตั้งแต่แรกว่าเราต้องการอะไร รอบหน้าให้ใส่คำอธิบายและแนบไฟล์ตัวอย่างในรายการที่ถูกตีกลับบ่อย ต้นทุนตอนเขียนคำขอถูกกว่าตีกลับหนึ่งรอบเสมอ",
      ref: SEC.summary,
    });
  }

  // — วางแผนรอบหน้าจากเวลาจริง: the number to actually plan the next cycle with.
  if (rt.clientRespond.n >= MIN_N && rt.firmReview.n >= 1) {
    const lead = Math.ceil((rt.clientRespond.avg || 0) + (rt.firmReview.avg || 0));
    found.push({
      when: "next", sev: "info",
      title: `รอบหน้า เผื่อเวลาต่อหนึ่งรายการไว้ประมาณ ${lead} วัน`,
      finding: `ลูกค้าส่งเฉลี่ย ${rt.clientRespond.avg} วัน + สำนักงานตรวจรับเฉลี่ย ${rt.firmReview.avg} วัน (ค่าเฉลี่ย ไม่ใช่กรณีแย่สุด)`,
      action: `ตั้งวันขอเอกสารให้ห่างจากวันที่ต้องใช้จริงอย่างน้อย ${lead} วัน และเผื่อเพิ่มสำหรับรายการที่เคยถูกตีกลับ ตัวเลขนี้คือค่าเฉลี่ย แปลว่าประมาณครึ่งหนึ่งของรายการจะใช้เวลานานกว่านี้`,
      ref: SEC.items,
    });
  }

  found.sort((a, b) => (a.when === b.when ? RANK[a.sev] - RANK[b.sev] : a.when === "now" ? -1 : 1));
  return found;
}

// ---------------------------------------------------------------- rendering
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (n, dp = 2) => (n == null || !Number.isFinite(Number(n)) ? "—" : (dp === 2 ? round2(Number(n)) : round1(Number(n))).toFixed(dp));

// Timestamps print in the browser's timezone, spelled out in the header so a
// reader in another zone knows what they are looking at.
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
const fmtTs = (ts) => (!ts ? "—" : new Date(ts).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" }));
const fmtDate = (d) => (!d ? "—" : new Date(`${d}T00:00:00Z`).toLocaleDateString("th-TH", { dateStyle: "short" }));

const CSS = `
@page { size: A4 landscape; margin: 12mm; }
* { box-sizing: border-box; }
/* This is a paper document: it is light in every viewer, whatever theme the
   reader's browser or file previewer is in. Without color-scheme + explicit
   surfaces, a dark-themed viewer paints the page black and the dark ink on it
   disappears. Nothing here follows prefers-color-scheme — that is deliberate. */
html { color-scheme: light; background:#fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin:0; padding:16px; background:#fff; font:400 10px 'Inter','IBM Plex Sans Thai',system-ui,sans-serif; color:#0F172A; }
@media print { body { padding:0; } }
figure { margin:0 0 10px; }
figcaption { font-size:9px; color:#64748B; margin-top:4px; }
.legend { display:flex; flex-wrap:wrap; gap:4px 12px; margin-top:6px; font-size:9px; }
.legend span { display:inline-flex; align-items:center; gap:4px; }
.legend i { width:8px; height:8px; border-radius:2px; display:inline-block; }
.bar { display:flex; gap:2px; border-radius:4px; overflow:hidden; }
.bar span { display:flex; align-items:center; justify-content:center; color:#fff; font-size:9.5px; font-weight:700; }
h1 { font-size:19px; margin:0 0 4px; color:#0F172A; }
h2 { font-size:13px; margin:0 0 8px; padding-bottom:5px; border-bottom:2px solid #0F172A; color:#0F172A; }
section { margin-bottom:20px; break-inside:avoid; }
section.long { break-inside:auto; }
.sub { color:#64748B; font-size:10px; }
.meta { display:flex; gap:22px; flex-wrap:wrap; margin:10px 0 22px; padding:9px 12px; background:#F8FAFC; border:1px solid #E5E7EB; border-radius:8px; }
.meta > div { font-size:10px; }
.meta b { display:block; font-size:9px; color:#64748B; font-weight:600; text-transform:uppercase; letter-spacing:.4px; margin-bottom:2px; }
table { width:100%; border-collapse:collapse; font-size:9.5px; background:#fff; }
th, td { border:1px solid #E5E7EB; padding:4px 6px; text-align:left; vertical-align:top; background:#fff; color:#0F172A; }
th { background:#F1F5F9; font-weight:700; font-size:9px; }
thead { display:table-header-group; }
tr { break-inside:avoid; }
td.n, th.n { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
tfoot td { background:#F8FAFC; font-weight:700; border-top:2px solid #0F172A; }
.ok { color:#0F766E; font-weight:700; }
.bad { color:#B91C1C; font-weight:700; }
.muted { color:#94A3B8; }
.kpi { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
/* Direct children only — the nested caption div must not inherit the card's box. */
.kpi > div { flex:1; min-width:120px; background:#fff; border:1px solid #E5E7EB; border-radius:8px; padding:8px 10px; }
.kpi span { display:block; font-size:9px; color:#64748B; margin-bottom:3px; }
.kpi b { font-size:17px; color:#12B39A; }
.note { font-size:9px; color:#64748B; margin-top:6px; line-height:1.5; }
.note.warn { background:#FEF3C7; color:#92400E; padding:6px 9px; border-radius:6px; }
h3 { font-size:11px; margin:12px 0 6px; color:#0F172A; }
.sev { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; font-weight:700; }
.sev i { width:8px; height:8px; border-radius:2px; display:inline-block; flex:none; }
.flag { display:inline-block; font-size:8px; padding:0 4px; border-radius:3px; background:#FEF3C7; color:#92400E; font-weight:700; }
@media print { .noprint { display:none; } }
.noprint { position:fixed; top:10px; right:10px; }
.noprint button { font:600 12px 'Inter',sans-serif; padding:8px 16px; border-radius:8px; border:0; background:#0F172A; color:#fff; cursor:pointer; }
`;

// ------------------------------------------------------------------- charts
// Static SVG, no library and no hover — on paper a tooltip is worth nothing, so
// every value that a tooltip would have carried is printed on the mark itself.

// Stacked proportion bar, built from flex divs the way the dashboard builds its
// own — it fills whatever width the page gives it without the aspect-ratio games
// an SVG of fixed height would need. A 2px gap keeps adjacent fills from
// touching; a segment only carries its count when it is wide enough to hold it,
// and the legend below carries the rest.
function stackedBar(parts, total, { h = 22 } = {}) {
  if (!total) return "";
  const segs = parts.filter((p) => p.n > 0).map((p) => {
    const pct = (p.n / total) * 100;
    const label = pct >= 5 ? `<b>${p.n}</b>` : "";
    return `<span style="width:${round2(pct)}%;background:${p.color}" title="${esc(p.label)}: ${p.n}">${label}</span>`;
  }).join("");
  return `<div class="bar" style="height:${h}px">${segs}</div>`;
}

const legend = (parts) => `<div class="legend">${parts.filter((p) => p.n > 0)
  .map((p) => `<span><i style="background:${p.color}"></i>${esc(p.label)} · <b>${p.n}</b></span>`).join("")}</div>`;

// Smooth path through the points (Catmull-Rom → cubic bezier), same curve the
// dashboard draws so the printed shape matches the screen.
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C ${round2(p1.x + (p2.x - p0.x) / 6)} ${round2(p1.y + (p2.y - p0.y) / 6)} ${round2(p2.x - (p3.x - p1.x) / 6)} ${round2(p2.y - (p3.y - p1.y) / 6)} ${round2(p2.x)} ${round2(p2.y)}`;
  }
  return d;
}

// Density curve of how early or late clients submitted, with the due date as the
// zero line: mass to its left is early, to its right is late.
function timingCurve(counts) {
  const bins = TIMING_BINS.map((b) => ({ ...b, n: counts[b.key] || 0 }));
  const total = bins.reduce((a, b) => a + b.n, 0);
  if (!total) return "";
  const W = 700, H = 170, padL = 30, padR = 30, base = 120, top = 26;
  const maxN = Math.max(1, ...bins.map((b) => b.n));
  const plotW = W - padL - padR;
  const pts = bins.map((b, i) => ({
    x: padL + (i * plotW) / (bins.length - 1),
    y: base - (b.n / maxN) * (base - top),
    n: b.n, label: b.label, due: b.key === "due",
  }));
  const curve = smoothPath(pts);
  const dueX = round2(pts.find((p) => p.due).x);
  // No height attribute: the curve scales with the page width instead of drawing
  // at its native size marooned in the middle of it.
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="การกระจายเวลาส่งเทียบกำหนดส่ง">
    <defs><linearGradient id="tmg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#12B39A" stop-opacity="0.85"/>
      <stop offset="55%" stop-color="#F59E0B" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#EF4444" stop-opacity="0.85"/>
    </linearGradient></defs>
    <line x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}" stroke="#E5E7EB" stroke-width="1"/>
    <path d="${curve} L ${round2(pts[pts.length - 1].x)} ${base} L ${round2(pts[0].x)} ${base} Z" fill="url(#tmg)" opacity="0.28"/>
    <path d="${curve}" fill="none" stroke="url(#tmg)" stroke-width="2.5"/>
    <line x1="${dueX}" y1="${top - 8}" x2="${dueX}" y2="${base}" stroke="#EF4444" stroke-width="1.3" stroke-dasharray="3 3"/>
    <text x="${dueX}" y="${top - 11}" text-anchor="middle" font-size="9" font-weight="700" fill="#EF4444">กำหนดส่ง</text>
    ${pts.map((p) => `<g>
      ${p.n > 0 ? `<circle cx="${round2(p.x)}" cy="${round2(p.y)}" r="3" fill="#fff" stroke="#0F172A" stroke-width="1.3"/>
      <text x="${round2(p.x)}" y="${round2(p.y) - 7}" text-anchor="middle" font-size="9" font-weight="700" fill="#0F172A">${p.n}</text>` : ""}
      <text x="${round2(p.x)}" y="${base + 13}" text-anchor="middle" font-size="8" fill="#64748B">${esc(p.label)}</text>
    </g>`).join("")}
    <text x="${padL}" y="${H - 4}" text-anchor="start" font-size="9" fill="#12B39A" font-weight="600">← ส่งล่วงหน้า</text>
    <text x="${W - padR}" y="${H - 4}" text-anchor="end" font-size="9" fill="#EF4444" font-weight="600">ส่งสาย →</text>
  </svg>`;
}

function kpiSection(mine) {
  const sb = mine.statusBreakdown;
  const pct = sb.total ? Math.round((sb.accepted / sb.total) * 100) : 0;
  return `<section>
    <h2>${SEC.summary}. สรุปผล</h2>
    <div class="kpi">
      <div><span>ตรวจรับแล้ว</span><b>${pct}%</b><div class="sub">${sb.accepted} จาก ${sb.total} รายการ</div></div>
      <div><span>เวลาเฉลี่ยจนตรวจรับ</span><b>${mine.avgTurnaround ?? "—"} วัน</b><div class="sub">จาก ${mine.turnaroundCount} รายการที่ตรวจรับแล้ว</div></div>
      ${METRICS.filter((m) => m.key !== "turnaround").map((m) => {
        const v = mine.responseTimes[m.key];
        return `<div><span>${esc(m.label.split(" · ")[0])}</span><b>${v.avg ?? "—"} วัน</b><div class="sub">จาก ${v.n} ครั้ง</div></div>`;
      }).join("")}
    </div>
    <figure>
      ${stackedBar(STATUSES.map((s) => ({ ...s, n: sb[s.key] })), sb.total)}
      ${legend(STATUSES.map((s) => ({ ...s, n: sb[s.key] })))}
      <figcaption>สัดส่วนสถานะของงานทั้งหมด ${sb.total} รายการ — กราฟเดียวกับแถบสถานะบนแดชบอร์ด</figcaption>
    </figure>
    <table><thead><tr><th>สถานะปัจจุบัน</th>${STATUSES.map((s) => `<th class="n">${s.label}</th>`).join("")}<th class="n">รวม</th></tr></thead>
    <tbody><tr><td>จำนวนงาน</td>${STATUSES.map((s) => `<td class="n">${sb[s.key]}</td>`).join("")}<td class="n"><b>${sb.total}</b></td></tr></tbody></table>
    <p class="note">นับเฉพาะงานที่ไม่ได้เก็บเข้าคลัง (archived) — ตรงกับที่แสดงบนแดชบอร์ด</p>
  </section>`;
}

// The only section that tells the reader what to do rather than what happened.
// It stays honest about that: each row shows the numbers it fired on and the
// section to go verify them in, and when the portal is too young for an average
// to mean anything, it says so at the top instead of pretending otherwise.
function adviceSection(mine, evidence) {
  const found = buildInsights(mine, evidence);
  const thin = mine.statusBreakdown.total < THIN_EVIDENCE || mine.turnaroundCount < THIN_EVIDENCE;
  const block = (when, heading, blank) => {
    const rows = found.filter((f) => f.when === when);
    return `<h3>${heading}</h3>${rows.length === 0 ? `<p class="note">${blank}</p>` : `
      <table style="margin-bottom:12px"><thead><tr>
        <th style="width:8%">ความสำคัญ</th><th style="width:26%">ข้อสังเกต</th><th style="width:30%">ตัวเลขที่ทำให้บอกแบบนี้</th><th style="width:36%">ควรทำอะไร</th>
      </tr></thead><tbody>
      ${rows.map((f) => `<tr>
        <td><span class="sev"><i style="background:${SEVERITIES[f.sev].color}"></i>${SEVERITIES[f.sev].label}</span></td>
        <td><b>${esc(f.title)}</b></td>
        <td>${esc(f.finding)} <span class="sub">(ตรวจได้ที่หัวข้อ ${f.ref})</span></td>
        <td>${esc(f.action)}</td>
      </tr>`).join("")}
      </tbody></table>`}`;
  };

  return `<section class="long">
    <h2>${SEC.advice}. วิเคราะห์และข้อเสนอแนะ</h2>
    ${thin ? `<p class="note warn"><b>ข้อมูลยังน้อย</b> — ตอนนี้มี ${mine.statusBreakdown.total} รายการ และตรวจรับไปแล้ว ${mine.turnaroundCount} รายการ ค่าเฉลี่ยจากตัวอย่างเท่านี้ยังแกว่งง่าย ให้อ่านข้อเสนอแนะด้านล่างเป็น “ข้อสังเกตที่ควรไปดู” มากกว่า “ข้อสรุป”</p>` : ""}
    ${block("now", "ทำได้ตอนนี้", "ไม่มีงานค้าง ไม่มีงานเกินกำหนด และไม่มีเอกสารที่ส่งมาแล้วเรายังไม่เปิดดู 🎉")}
    ${block("next", "รอบหน้า", "ยังไม่มีรูปแบบปัญหาที่ซ้ำจนควรเปลี่ยนวิธีทำงาน")}
    <p class="note">ข้อเสนอแนะทุกข้อสร้างจากตัวเลขในรายงานนี้เท่านั้น ไม่มีการเทียบกับค่ามาตรฐานอุตสาหกรรมหรือสำนักงานอื่น · ข้อไหนที่ไม่เห็นด้วย ให้ตามไปดูแถว log ที่หัวข้อที่อ้างถึงได้เลย</p>
  </section>`;
}

function checkSection(rows) {
  const bad = rows.filter((r) => !r.ok).length;
  return `<section>
    <h2>${SEC.check}. ตรวจสอบความถูกต้อง — ตัวเลขบนแดชบอร์ด เทียบกับที่คำนวณใหม่จาก log ในรายงานนี้</h2>
    <table><thead><tr><th>ตัวเลข</th><th class="n">แดชบอร์ด (firm_analytics)</th><th class="n">คำนวณใหม่จาก log</th><th class="n">ผล</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${r.dash ?? "—"}</td><td class="n">${r.mine ?? "—"}</td><td class="n ${r.ok ? "ok" : "bad"}">${r.ok ? "✓ ตรงกัน" : "⚠ ไม่ตรง"}</td></tr>`).join("")}
    </tbody></table>
    <p class="note">${bad === 0
      ? `ทุกตัวเลขบนแดชบอร์ดสร้างซ้ำได้จากตาราง log ในหัวข้อ ${SEC.items}–${SEC.timing} ของรายงานนี้`
      : `<span class="bad">มี ${bad} ตัวเลขที่ไม่ตรงกัน</span> — อาจเกิดจากมี log เข้ามาใหม่ระหว่างที่ดึงข้อมูลสองรอบ หากไม่ตรงซ้ำ ๆ ให้แจ้งผู้ดูแลระบบ`}</p>
  </section>`;
}

function methodSection() {
  return `<section class="long">
    <h2>${SEC.method}. วิธีคำนวณ</h2>
    <table><thead><tr><th style="width:16%">ตัวเลข</th><th style="width:24%">สูตร</th><th style="width:36%">log ที่ใช้</th><th style="width:24%">เกณฑ์ที่ตัดออกจากค่าเฉลี่ย</th></tr></thead><tbody>
    ${METRICS.map((m) => `<tr><td><b>${esc(m.label)}</b></td><td>${esc(m.formula)}</td><td>${esc(m.logs)}</td><td>${esc(m.skip)}</td></tr>`).join("")}
    </tbody></table>
    <p class="note">
      ค่าเฉลี่ย = ผลรวมของวันทั้งหมด ÷ จำนวนรายการที่เข้าเกณฑ์ ปัดเศษเป็นทศนิยม 1 ตำแหน่งครั้งเดียวตอนท้าย (ไม่ปัดรายรายการก่อนรวม)<br>
      ค่าเฉลี่ยและเวลาตอบสนอง <b>นับรวมงานที่เก็บเข้าคลังแล้ว</b> ส่วนสรุปสถานะและอายุงาน <b>ไม่นับ</b> — เป็นพฤติกรรมเดียวกับแดชบอร์ด งานที่เก็บเข้าคลังมีเครื่องหมาย <span class="flag">คลัง</span> กำกับในตาราง<br>
      1 วัน = 86,400 วินาที คิดเป็นทศนิยม (เช่น 0.5 วัน = 12 ชั่วโมง) ไม่ตัดวันหยุดหรือนอกเวลาทำการออก
    </p>
  </section>`;
}

// The evidence table: one row per request item, every timestamp the metrics read
// and every day-count derived from them. Column totals at the foot are the
// averages in section 1 — this is where they come from.
function itemsSection(items) {
  const cols = METRICS.filter((m) => m.source === "items");
  const sums = cols.map((m) => avgOf(items.map((i) => i[m.field])));
  return `<section class="long">
    <h2>${SEC.items}. log รายรายการ (${items.length} รายการ) — ที่มาของค่าเฉลี่ยในหัวข้อ ${SEC.summary}</h2>
    <table>
      <thead><tr>
        <th>ลูกค้า</th><th>รายการ</th><th>สถานะ</th><th class="n">กำหนดส่ง</th>
        <th class="n">ขอเอกสาร</th><th class="n">อัปโหลดแรก</th><th class="n">อัปโหลดล่าสุด</th><th class="n">เปิดดูครั้งแรก</th><th class="n">ตรวจรับ</th>
        ${cols.map((m) => `<th class="n">${esc(m.label.split(" · ")[0])}<br>(วัน)</th>`).join("")}
        <th class="n">ส่งก่อนกำหนด<br>(วัน)</th>
      </tr></thead>
      <tbody>${items.map((i) => `<tr>
        <td>${esc(i.client)}</td>
        <td>${esc(i.ref ? `${i.ref} · ` : "")}${esc(i.description)}${i.archived ? ' <span class="flag">คลัง</span>' : ""}</td>
        <td>${esc(i.status)}</td>
        <td class="n">${fmtDate(i.dueDate)}</td>
        <td class="n">${fmtTs(i.requestedAt)}</td>
        <td class="n">${fmtTs(i.firstSubmit)}</td>
        <td class="n">${fmtTs(i.lastSubmit)}</td>
        <td class="n">${fmtTs(i.viewedAt)}</td>
        <td class="n">${fmtTs(i.acceptedAt)}</td>
        ${cols.map((m) => `<td class="n ${i[m.field] == null ? "muted" : ""}">${num(i[m.field])}</td>`).join("")}
        <td class="n ${i.daysBeforeDue == null ? "muted" : ""}">${i.daysBeforeDue ?? "—"}</td>
      </tr>`).join("")}</tbody>
      <tfoot>
        <tr><td colspan="9">ผลรวมของวัน (Σ) — เฉพาะรายการที่เข้าเกณฑ์</td>${sums.map((s) => `<td class="n">${num(s.sum)}</td>`).join("")}<td class="n"></td></tr>
        <tr><td colspan="9">จำนวนรายการที่เข้าเกณฑ์ (n)</td>${sums.map((s) => `<td class="n">${s.n}</td>`).join("")}<td class="n"></td></tr>
        <tr><td colspan="9">ค่าเฉลี่ย = Σ ÷ n</td>${sums.map((s) => `<td class="n">${s.avg ?? "—"}</td>`).join("")}<td class="n"></td></tr>
      </tfoot>
    </table>
    <p class="note">ช่อง “—” คือรายการที่ไม่เข้าเกณฑ์ของตัวเลขนั้น (ดูหัวข้อ ${SEC.method}) จึงไม่ถูกนับทั้งใน Σ และ n · ค่าในคอลัมน์วันแสดงทศนิยม 2 ตำแหน่ง แต่ Σ และค่าเฉลี่ยคำนวณจากค่าเต็มความละเอียด</p>
  </section>`;
}

function repliesSection(replies) {
  if (!replies.length) {
    return `<section><h2>${SEC.replies}. log คอมเมนต์–ตอบกลับ</h2><p class="note">ยังไม่มีคู่คอมเมนต์ที่ตอบกลับข้ามฝ่าย จึงไม่มีค่าเฉลี่ยเวลาตอบคอมเมนต์</p></section>`;
  }
  const firm = avgOf(replies.filter((r) => r.by === "Firm").map((r) => r.days));
  const client = avgOf(replies.filter((r) => r.by === "Client").map((r) => r.days));
  return `<section class="long">
    <h2>${SEC.replies}. log คอมเมนต์–ตอบกลับ (${replies.length} คู่) — ที่มาของ “เวลาตอบคอมเมนต์”</h2>
    <table>
      <thead><tr><th>ลูกค้า</th><th>รายการ</th><th>คอมเมนต์ก่อนหน้า (ฝ่าย)</th><th class="n">เวลา</th><th>ผู้ตอบ</th><th class="n">เวลาที่ตอบ</th><th class="n">ห่างกัน (วัน)</th></tr></thead>
      <tbody>${replies.map((r) => `<tr>
        <td>${esc(r.client)}</td><td>${esc(r.description)}</td>
        <td>${r.prevBy === "Firm" ? "สำนักงาน" : "ลูกค้า"}</td><td class="n">${fmtTs(r.prevAt)}</td>
        <td>${r.by === "Firm" ? "สำนักงาน" : "ลูกค้า"}</td><td class="n">${fmtTs(r.at)}</td>
        <td class="n">${num(r.days)}</td>
      </tr>`).join("")}</tbody>
      <tfoot>
        <tr><td colspan="6">สำนักงานตอบคอมเมนต์ — Σ ${num(firm.sum)} ÷ n ${firm.n}</td><td class="n">${firm.avg ?? "—"}</td></tr>
        <tr><td colspan="6">ลูกค้าตอบคอมเมนต์ — Σ ${num(client.sum)} ÷ n ${client.n}</td><td class="n">${client.avg ?? "—"}</td></tr>
      </tfoot>
    </table>
  </section>`;
}

function agingSection(mine) {
  return `<section class="long">
    <h2>${SEC.aging}. อายุงาน — ที่มาของกราฟ “อายุงาน” ทั้ง 3 โหมด</h2>
    ${AGE_MODES.map((mode) => {
      const rows = mine.agingRows[mode.key];
      const parts = AGE_BUCKETS.map((b, i) => ({ label: b.label, color: AGE_COLORS[i], n: mine.aging[mode.key][b.key] }));
      return `${rows.length ? `<figure>${stackedBar(parts, rows.length, { h: 18 })}${legend(parts)}</figure>` : ""}
      <table style="margin-bottom:10px">
        <thead>
          <tr><th colspan="${AGE_BUCKETS.length + 2}">โหมด “${mode.label}” — ${esc(mode.rule)}</th></tr>
          <tr><th>ช่วงอายุ</th>${AGE_BUCKETS.map((b) => `<th class="n">${b.label}</th>`).join("")}<th class="n">รวม</th></tr>
        </thead>
        <tbody>
          <tr><td>จำนวนงาน</td>${AGE_BUCKETS.map((b) => `<td class="n">${mine.aging[mode.key][b.key]}</td>`).join("")}<td class="n"><b>${rows.length}</b></td></tr>
          <tr><td>งานที่นับ</td><td colspan="${AGE_BUCKETS.length + 1}">${rows.length === 0 ? '<span class="muted">ไม่มีงานเข้าเกณฑ์</span>' : rows.map((r) => `${esc(r.item.description)} <span class="sub">(${num(r.days, 1)} วัน)</span>`).join(" · ")}</td></tr>
        </tbody>
      </table>`;
    }).join("")}
    <p class="note">อายุงานคิดถึงเวลาที่ออกรายงาน (${fmtTs(mine.now)}) โดยใช้นาฬิกาของเซิร์ฟเวอร์ — งานหนึ่งอาจถูกนับได้มากกว่าหนึ่งโหมด</p>
  </section>`;
}

function timingSection(mine) {
  const total = mine.timingRows.length;
  return `<section class="long">
    <h2>${SEC.timing}. การส่งเทียบกำหนดส่ง — ที่มาของกราฟการกระจาย (${total} รายการ)</h2>
    ${total ? `<figure>${timingCurve(mine.submissionTiming)}<figcaption>เส้นการกระจายเดียวกับบนแดชบอร์ด · ตัวเลขบนจุดคือจำนวนรายการในช่วงนั้น</figcaption></figure>` : ""}
    <table>
      <thead><tr><th>ช่วง</th>${TIMING_BINS.map((b) => `<th class="n">${b.label}</th>`).join("")}<th class="n">รวม</th></tr></thead>
      <tbody><tr><td>จำนวนรายการ</td>${TIMING_BINS.map((b) => `<td class="n">${mine.submissionTiming[b.key]}</td>`).join("")}<td class="n"><b>${total}</b></td></tr></tbody>
    </table>
    <p class="note">ส่งก่อนกำหนด (วัน) = วันที่กำหนดส่ง − วันที่ลูกค้าอัปโหลดครั้งแรก (นับเป็นวันปฏิทิน) · ค่าบวก = ส่งล่วงหน้า, 0 = ตรงกำหนด, ค่าลบ = ส่งสาย · นับเฉพาะรายการที่มีทั้งกำหนดส่งและการอัปโหลดแล้ว (ดูคอลัมน์สุดท้ายของหัวข้อ 4)</p>
  </section>`;
}

// Full standalone HTML document. Pure — no window access — so tests can assert
// on the numbers it prints.
export function buildReportHtml({ data, evidence, scopeLabel = "ทุกลูกค้า" }) {
  const mine = recompute(evidence);
  const items = evidence?.items || [];
  const replies = evidence?.replies || [];
  const printedAt = new Date();

  return `<!doctype html><html lang="th"><head><meta charset="utf-8">
<title>รายงาน Analytics — ${esc(scopeLabel)}</title><style>${CSS}</style></head><body>
<div class="noprint"><button onclick="window.print()">พิมพ์ / บันทึกเป็น PDF</button></div>
<h1>รายงานสถิติภาพรวม (Analytics)</h1>
<div class="sub">พร้อมวิธีคำนวณและ log จริงที่ใช้คำนวณทุกตัวเลขในรายงานนี้</div>
<div class="meta">
  <div><b>ขอบเขต</b>${esc(scopeLabel)}</div>
  <div><b>ออกรายงานเมื่อ</b>${fmtTs(printedAt)} (${esc(tz())})</div>
  <div><b>ข้อมูล ณ เวลา (เซิร์ฟเวอร์)</b>${fmtTs(mine.now)}</div>
  <div><b>งานในรายงาน</b>${items.length} รายการ · ${replies.length} คู่คอมเมนต์</div>
  <div><b>แหล่งข้อมูล</b>item_history · item_files · item_comments · request_items</div>
</div>
${kpiSection(mine)}
${adviceSection(mine, evidence)}
${checkSection(reconcile(data, mine))}
${methodSection()}
${itemsSection(items)}
${repliesSection(replies)}
${agingSection(mine)}
${timingSection(mine)}
</body></html>`;
}

// Open the report in a new tab and hand it to the browser's print dialog, where
// the user picks "Save as PDF". Returns false if a popup blocker got in the way,
// so the caller can say so instead of appearing to do nothing.
export function openReport(html, win = window) {
  const w = win.open("", "_blank");
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  // Let layout settle before the dialog snapshots the page.
  w.addEventListener("load", () => w.setTimeout(() => w.print(), 150));
  return true;
}
