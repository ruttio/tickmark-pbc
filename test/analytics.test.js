import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Analytics } from "../src/Analytics.jsx";

const render = (data) => renderToStaticMarkup(React.createElement(Analytics, { data }));

describe("Analytics", () => {
  const data = {
    weekly: [{ week: "2026-06-01", n: 3 }, { week: "2026-06-08", n: 5 }],
    avgTurnaround: 4.2,
    turnaroundCount: 8,
    aging: { d0_7: 2, d7_14: 1, d14_30: 0, d30: 3 },
  };

  it("renders bars for each week + the turnaround stat", () => {
    const out = render(data);
    expect(out).toContain("<rect"); // trend bars
    expect(out).toContain("4.2");   // avg turnaround
    expect(out).toContain("8 รายการ");
  });

  it("renders the aging buckets with counts", () => {
    const out = render(data);
    expect(out).toContain("0–7 วัน");
    expect(out).toContain("30+ วัน");
  });

  it("returns nothing without data", () => {
    expect(render(null)).toBe("");
  });

  it("shows empty states when there is no activity", () => {
    const out = render({ weekly: [], avgTurnaround: null, turnaroundCount: 0, aging: { d0_7: 0, d7_14: 0, d14_30: 0, d30: 0 } });
    expect(out).toContain("ยังไม่มีข้อมูลการตรวจรับ");
    expect(out).toContain("ไม่มีงานค้าง");
  });
});
