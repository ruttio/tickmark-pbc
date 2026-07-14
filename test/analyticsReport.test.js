import { describe, it, expect } from "vitest";
import { recompute, reconcile, buildInsights, buildReportHtml } from "../src/analyticsReport.js";

// Four items with hand-checkable durations. Item D is archived and item C was
// never submitted — the two cases where the dashboard's own rules diverge, so
// they carry most of the weight here.
const evidence = {
  now: "2026-07-15T00:00:00Z",
  items: [
    { // accepted 4 days after it was requested
      client: "ABC", ref: "A1", description: "งบทดลอง", status: "accepted", archived: false,
      dueDate: "2026-07-01",
      requestedAt: "2026-06-01T00:00:00Z", firstSubmit: "2026-06-03T00:00:00Z", lastSubmit: "2026-06-03T00:00:00Z",
      viewedAt: "2026-06-04T00:00:00Z", acceptedAt: "2026-06-05T00:00:00Z",
      turnaroundDays: 4, clientRespondDays: 2, firmReviewDays: 2, firmViewDays: 1, daysBeforeDue: 28,
    },
    { // uploaded, not yet reviewed → no turnaround, no firm-review time
      client: "ABC", ref: "A2", description: "ลูกหนี้", status: "submitted", archived: false,
      dueDate: "2026-07-20",
      requestedAt: "2026-07-10T00:00:00Z", firstSubmit: "2026-07-14T00:00:00Z", lastSubmit: "2026-07-14T00:00:00Z",
      viewedAt: null, acceptedAt: null,
      turnaroundDays: null, clientRespondDays: 4, firmReviewDays: null, firmViewDays: null, daysBeforeDue: 6,
    },
    { // never submitted, past due → counts in aging only
      client: "XYZ", ref: "B1", description: "หนังสือรับรองธนาคาร", status: "outstanding", archived: false,
      dueDate: "2026-06-30",
      requestedAt: "2026-05-01T00:00:00Z", firstSubmit: null, lastSubmit: null,
      viewedAt: null, acceptedAt: null,
      turnaroundDays: null, clientRespondDays: null, firmReviewDays: null, firmViewDays: null, daysBeforeDue: null,
    },
    { // archived → out of the status/aging counts, still in the averages
      client: "XYZ", ref: "B2", description: "งานปีก่อน", status: "accepted", archived: true,
      dueDate: null,
      requestedAt: "2026-01-01T00:00:00Z", firstSubmit: "2026-01-02T00:00:00Z", lastSubmit: "2026-01-02T00:00:00Z",
      viewedAt: null, acceptedAt: "2026-01-11T00:00:00Z",
      turnaroundDays: 10, clientRespondDays: 1, firmReviewDays: 9, firmViewDays: null, daysBeforeDue: null,
    },
  ],
  replies: [
    { client: "ABC", description: "งบทดลอง", prevBy: "Client", prevAt: "2026-06-01T00:00:00Z", by: "Firm", at: "2026-06-02T00:00:00Z", days: 1 },
    { client: "ABC", description: "งบทดลอง", prevBy: "Firm", prevAt: "2026-06-02T00:00:00Z", by: "Client", at: "2026-06-05T00:00:00Z", days: 3 },
    { client: "ABC", description: "ลูกหนี้", prevBy: "Client", prevAt: "2026-07-01T00:00:00Z", by: "Firm", at: "2026-07-03T00:00:00Z", days: 2 },
  ],
};

// What firm_analytics() reports for the same logs.
const data = {
  statusBreakdown: { outstanding: 1, submitted: 1, review: 0, accepted: 1, returned: 0, reopened: 0, total: 3 },
  avgTurnaround: 7, turnaroundCount: 2,
  aging: {
    requested: { d0_7: 1, d7_14: 0, d14_30: 0, d30: 1 },
    waiting: { d0_7: 1, d7_14: 0, d14_30: 0, d30: 0 },
    overdue: { d0_7: 0, d7_14: 0, d14_30: 1, d30: 0 },
  },
  submissionTiming: { e22: 1, e15: 0, e8: 0, e4: 1, e1: 0, due: 0, l1: 0, l4: 0, l7: 0 },
  responseTimes: {
    clientRespond: { avg: 2.3, n: 3 },
    firmReview: { avg: 5.5, n: 2 },
    firmView: { avg: 1, n: 1 },
    firmReply: { avg: 1.5, n: 2 },
    clientReply: { avg: 3, n: 1 },
  },
};

describe("recompute", () => {
  const mine = recompute(evidence);

  it("counts status only over non-archived items", () => {
    expect(mine.statusBreakdown).toMatchObject({ outstanding: 1, submitted: 1, accepted: 1, total: 3 });
  });

  it("averages turnaround over accepted items, archived included", () => {
    expect(mine.turnaroundCount).toBe(2);   // items A + D
    expect(mine.turnaroundSum).toBe(14);
    expect(mine.avgTurnaround).toBe(7);
  });

  it("rounds the average once at the end, not per row", () => {
    // (2 + 4 + 1) / 3 = 2.333… → 2.3
    expect(mine.responseTimes.clientRespond).toMatchObject({ avg: 2.3, n: 3 });
  });

  it("skips rows that miss the metric's end timestamp", () => {
    expect(mine.responseTimes.firmReview).toMatchObject({ avg: 5.5, n: 2 });   // B, C have no accept
    expect(mine.responseTimes.firmView).toMatchObject({ avg: 1, n: 1 });       // only A was opened
  });

  it("pairs comments across sides for the reply times", () => {
    expect(mine.responseTimes.firmReply).toMatchObject({ avg: 1.5, n: 2 });
    expect(mine.responseTimes.clientReply).toMatchObject({ avg: 3, n: 1 });
  });

  it("ages open items against the server clock, not the browser's", () => {
    expect(mine.aging.requested).toMatchObject({ d0_7: 1, d30: 1 });  // B is 5 days old, C is 75
    expect(mine.aging.waiting).toMatchObject({ d0_7: 1 });
    expect(mine.aging.overdue).toMatchObject({ d14_30: 1 });          // C is 15 days past due
  });

  it("bins submission timing around the due date", () => {
    expect(mine.submissionTiming).toMatchObject({ e22: 1, e4: 1, due: 0, l7: 0 });
    expect(mine.timingRows).toHaveLength(2);   // C and D have no due date + upload pair
  });
});

describe("reconcile", () => {
  it("passes every figure when the dashboard agrees with the logs", () => {
    const rows = reconcile(data, recompute(evidence));
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });

  it("flags a dashboard figure the logs do not support", () => {
    const wrong = { ...data, avgTurnaround: 2.1 };
    const bad = reconcile(wrong, recompute(evidence)).filter((r) => !r.ok);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ label: "เวลาเฉลี่ยจนตรวจรับ (วัน)", dash: 2.1, mine: 7 });
  });
});

describe("buildInsights", () => {
  const titles = (ev) => buildInsights(recompute(ev), ev).map((f) => f.title);

  it("flags files the client sent that the firm never opened", () => {
    // Item A2 was submitted on 2026-07-14, viewedAt is null, status submitted.
    const found = buildInsights(recompute(evidence), evidence);
    const hit = found.find((f) => f.title.includes("ยังไม่เปิดดู"));
    expect(hit).toBeTruthy();
    expect(hit.when).toBe("now");
    expect(hit.finding).toContain("ลูกหนี้");
  });

  it("ranks the overdue work by how far past due it is", () => {
    const hit = buildInsights(recompute(evidence), evidence).find((f) => f.title.includes("เกินกำหนดส่ง"));
    expect(hit.finding).toContain("หนังสือรับรองธนาคาร");   // 15 days past due
    expect(hit.finding).toContain("15");
  });

  it("puts what to do now before what to change next round", () => {
    const found = buildInsights(recompute(evidence), evidence);
    const firstNext = found.findIndex((f) => f.when === "next");
    const lastNow = found.map((f) => f.when).lastIndexOf("now");
    expect(lastNow).toBeLessThan(firstNext);
  });

  it("stays silent about the bottleneck until both sides have enough rows", () => {
    // clientRespond n=3, firmReview n=2 in the fixture → not enough to compare.
    expect(titles(evidence).some((t) => t.includes("คอขวด"))).toBe(false);
  });

  it("names the slower side once both sides have enough rows", () => {
    // Add a third accepted item so firmReview reaches n=3, firm slower than client.
    const more = {
      ...evidence,
      items: [...evidence.items, {
        client: "ABC", ref: "A3", description: "สินค้าคงเหลือ", status: "accepted", archived: false, dueDate: null,
        requestedAt: "2026-03-01T00:00:00Z", firstSubmit: "2026-03-02T00:00:00Z", lastSubmit: "2026-03-02T00:00:00Z",
        viewedAt: null, acceptedAt: "2026-03-20T00:00:00Z",
        turnaroundDays: 19, clientRespondDays: 1, firmReviewDays: 18, firmViewDays: null, daysBeforeDue: null,
      }],
    };
    const hit = buildInsights(recompute(more), more).find((f) => f.title.includes("คอขวด"));
    expect(hit.title).toContain("สำนักงาน");     // firm avg (9.7) > client avg (2)
    expect(hit.finding).toMatch(/จาก 3 รายการ/);
  });

  it("recommends a lead time built from the measured durations", () => {
    const hit = buildInsights(recompute(evidence), evidence).find((f) => f.when === "next" && f.sev === "info");
    expect(hit.title).toContain("8 วัน");   // ceil(2.3958… + 5.53…) = 8
  });

  it("invents nothing when there is no evidence", () => {
    const empty = { now: evidence.now, items: [], replies: [] };
    expect(buildInsights(recompute(empty), empty)).toEqual([]);
  });
});

describe("buildReportHtml", () => {
  const html = buildReportHtml({ data, evidence, scopeLabel: "ทุกลูกค้า" });

  it("shows the method behind each number", () => {
    expect(html).toContain("วิธีคำนวณ");
    expect(html).toContain("86400");                 // the day formula
    expect(html).toContain("เกณฑ์ที่ตัดออกจากค่าเฉลี่ย");
  });

  it("prints the log rows the averages came from, with Σ ÷ n = average", () => {
    expect(html).toContain("งบทดลอง");
    expect(html).toContain("หนังสือรับรองธนาคาร");
    expect(html).toContain("ค่าเฉลี่ย = Σ ÷ n");
    expect(html).toContain("14.00");                 // Σ turnaround days
  });

  it("marks archived items rather than hiding them from the averages", () => {
    expect(html).toContain("งานปีก่อน");
    expect(html).toContain("คลัง");
  });

  it("says out loud when the sample is too small to conclude from", () => {
    expect(html).toContain("ข้อมูลยังน้อย");   // 3 items, 2 accepted
  });

  it("reports the reconciliation result against the dashboard", () => {
    expect(html).toContain("✓ ตรงกัน");
    expect(html).not.toContain("⚠ ไม่ตรง");
  });

  it("says so loudly when a figure cannot be reproduced from the logs", () => {
    const out = buildReportHtml({ data: { ...data, avgTurnaround: 2.1 }, evidence, scopeLabel: "ทุกลูกค้า" });
    expect(out).toContain("⚠ ไม่ตรง");
    expect(out).toContain("มี 1 ตัวเลขที่ไม่ตรงกัน");
  });

  it("draws the dashboard's charts in the dashboard's palette", () => {
    expect(html).toContain('<div class="bar"');                    // status + aging bars
    expect(html).toContain('<svg viewBox="0 0 700 170"');          // submission-timing curve
    expect(html).toContain("<path");                                // the density curve itself
    expect(html).toContain("#12B39A");                              // dashboard mint, not a new hue
  });

  it("lets the charts fill the page instead of drawing at native size", () => {
    // A fixed height attribute would letterbox the curve into the middle of the
    // page; the bars size themselves from the flex row.
    expect(html).toContain('style="width:100%;height:auto"');
    expect(html).not.toMatch(/<svg[^>]*height="\d/);
  });

  it("stays a light document even in a dark-themed viewer", () => {
    // It is paper. A viewer that forces dark would otherwise paint the page black
    // and leave the dark ink on it unreadable.
    expect(html).toContain("color-scheme: light");
    expect(html).toContain("background:#fff");
    expect(html).not.toMatch(/@media\s*\(prefers-color-scheme/);   // no dark variant, by design
  });

  it("keeps the fills when the page is printed", () => {
    // Chrome strips fills from printed pages without this — the charts would
    // come out of the PDF as empty outlines.
    expect(html).toContain("print-color-adjust: exact");
  });

  it("labels the marks, so color is never the only cue", () => {
    // The palette is under 3:1 against white; counts must survive without it.
    expect(html).toMatch(/<span style="width:[\d.]+%;background:#12B39A"[^>]*><b>1<\/b><\/span>/);
    expect(html).toContain('<i style="background:#12B39A"');       // legend swatch + label + count
  });

  it("omits a chart rather than drawing an empty one", () => {
    const bare = { now: evidence.now, items: [], replies: [] };
    const out = buildReportHtml({ data, evidence: bare, scopeLabel: "ทุกลูกค้า" });
    expect(out).not.toContain("<svg");
    expect(out).not.toContain('<div class="bar"');
  });

  it("escapes client-supplied text", () => {
    const evil = { ...evidence, items: [{ ...evidence.items[0], description: '<img src=x onerror="alert(1)">' }] };
    const out = buildReportHtml({ data, evidence: evil, scopeLabel: "ทุกลูกค้า" });
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;img src=x");
  });
});
