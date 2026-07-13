import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Analytics } from "../src/Analytics.jsx";

const data = {
  weekly: [{ week: "2026-06-01", n: 3 }, { week: "2026-06-08", n: 5 }],
  avgTurnaround: 4.2,
  turnaroundCount: 8,
  aging: {
    requested: { d0_7: 2, d7_14: 1, d14_30: 0, d30: 3 },
    waiting: { d0_7: 1, d7_14: 0, d14_30: 0, d30: 0 },
    overdue: { d0_7: 0, d7_14: 0, d14_30: 0, d30: 0 },
  },
  submissionTiming: { early15: 1, d8_14: 2, d4_7: 0, d1_3: 3, late: 4 },
  responseTimes: {
    clientRespond: { avg: 2.5, n: 10 },
    firmReview: { avg: 1.2, n: 8 },
    firmView: { avg: 0.5, n: 6 },
    firmReply: { avg: 0.8, n: 4 },
    clientReply: { avg: 3.1, n: 3 },
  },
};
// Static render → useEffect doesn't fire, so initialData is shown as-is.
const render = (props) =>
  renderToStaticMarkup(React.createElement(Analytics, { initialData: data, engagements: [], fetchAnalytics: async () => data, ...props }));

describe("Analytics", () => {
  it("renders trend bars + turnaround stat", () => {
    const out = render();
    expect(out).toContain("<rect");
    expect(out).toContain("4.2");
    expect(out).toContain("8 รายการ");
  });

  it("shows the aging mode toggle (3 modes)", () => {
    const out = render();
    expect(out).toContain("ตั้งแต่ขอ");
    expect(out).toContain("รอเราตรวจ");
    expect(out).toContain("เกินกำหนด");
  });

  it("renders aging buckets for the default (requested) mode", () => {
    const out = render();
    expect(out).toContain("0–7 วัน");
    expect(out).toContain("30+ วัน");
  });

  it("renders submission timing + response-time rows", () => {
    const out = render();
    expect(out).toContain("ตรง/สายกว่ากำหนด");
    expect(out).toContain("เวลาตอบสนองเฉลี่ย");
    expect(out).toContain("2.5 วัน"); // clientRespond avg
    expect(out).toContain("เปิดดูเอกสาร");
  });

  it("renders a client filter with the given engagements", () => {
    const out = render({ engagements: [{ id: "e1", client: "บริษัท เอบีซี", template: "Audit" }] });
    expect(out).toContain("ทุกลูกค้า");
    expect(out).toContain("บริษัท เอบีซี");
  });

  it("shows empty states when there is no activity", () => {
    const out = render({
      initialData: { weekly: [], avgTurnaround: null, turnaroundCount: 0, aging: { requested: { d0_7: 0, d7_14: 0, d14_30: 0, d30: 0 } } },
    });
    expect(out).toContain("ยังไม่มีข้อมูลการตรวจรับ");
    expect(out).toContain("ไม่มีงานค้าง");
  });
});
