import { describe, it, expect } from "vitest";
import {
  parsePBC,
  mapImportStatus,
  parseYearEnd,
  findMeta,
  cellStr,
  initialsOf,
  fmtSize,
  isOverdue,
  onlyDigits,
  groupDigits,
  notifMeta,
  timeAgo,
  isMultiPeriod,
  nextPhaseKey,
} from "../pbc-portal.jsx";

// ---------------------------------------------------------------------------
// Excel (PBC template) parsing — the highest-value, most bug-prone logic:
// it turns an arbitrary firm-supplied spreadsheet into request items.
// ---------------------------------------------------------------------------
describe("parsePBC", () => {
  const grid = [
    ["Client:", "ACME Co"],
    [],
    ["Year-End:", "31/12/2024"],
    [],
    ["No.", "Description", "Status", "Remark"],
    ["1", "Bank statements", "", "urgent"],
    ["2", "Trial balance", "received", ""],
  ];

  it("extracts one item per body row with text/status/remark", () => {
    const { items } = parsePBC(grid);
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe("Bank statements");
    expect(items[0].status).toBe("outstanding");
    expect(items[0].remark).toBe("urgent");
    expect(items[1].text).toBe("Trial balance");
    expect(items[1].status).toBe("accepted"); // "received" → accepted
  });

  it("pulls client + year-end out of the meta block", () => {
    const { meta } = parsePBC(grid);
    expect(meta.client).toBe("ACME Co");
    expect(meta.yearEnd).toBe("31/12/2024");
  });

  it("uses a dedicated category column when present", () => {
    const withCat = [
      ["No.", "Process", "Description", "Status"],
      ["1", "Cash", "Bank statements", ""],
      ["2", "Cash", "Petty cash count", ""],
      ["3", "Revenue", "Sales ledger", ""],
    ];
    const { items } = parsePBC(withCat);
    expect(items.map((i) => i.category)).toEqual(["Cash", "Cash", "Revenue"]);
  });

  // The firm's real YE template: "Description" carries the section name (set
  // once on the first row of each group, blank on the rest), "Requested
  // Document" is a running number, and the actual document text sits one column
  // to its right. Categories must come from Description — never all "General".
  it("reads the grouped-Description template (text one column right of Requested Document)", () => {
    const grid = [
      ["No.", "Description", "Requested Document", null, "Status", "Remark"],
      [1, "เงินกู้ยืมระยะสั้น", 1, "สัญญาเงินกู้", "ค้างรับ", "x"],
      [null, null, 2, "หนังสือยืนยันยอดจากสถาบันการเงิน", "ค้างรับ", "x"],
      [2, "เงินสด", 1, "Bank statement ทุกบัญชี", "ได้รับแล้ว", ""],
      [null, null, 2, "งบกระทบยอดเงินฝากธนาคาร", "ค้างรับ", ""],
    ];
    const { items } = parsePBC(grid);
    expect(items.map((i) => i.text)).toEqual([
      "สัญญาเงินกู้", "หนังสือยืนยันยอดจากสถาบันการเงิน", "Bank statement ทุกบัญชี", "งบกระทบยอดเงินฝากธนาคาร",
    ]);
    expect(items.map((i) => i.category)).toEqual([
      "เงินกู้ยืมระยะสั้น", "เงินกู้ยืมระยะสั้น", "เงินสด", "เงินสด",
    ]);
    expect(items.every((i) => i.category !== "General")).toBe(true);
  });
});

describe("mapImportStatus", () => {
  it("maps received-like words to accepted", () => {
    expect(mapImportStatus("received")).toBe("accepted");
    expect(mapImportStatus("ได้รับแล้ว")).toBe("accepted");
    expect(mapImportStatus("Done")).toBe("accepted");
  });
  it("defaults blank / unknown to outstanding", () => {
    expect(mapImportStatus("")).toBe("outstanding");
    expect(mapImportStatus(null)).toBe("outstanding");
    expect(mapImportStatus("pending")).toBe("outstanding");
  });
});

describe("parseYearEnd", () => {
  it("parses DD-MM-YYYY and YYYY-MM-DD", () => {
    expect(parseYearEnd("31/12/2024")).toBe(new Date(2024, 11, 31).getTime());
    expect(parseYearEnd("2024-06-15")).toBe(new Date(2024, 5, 15).getTime());
  });
  it("passes a Date through", () => {
    const d = new Date(2023, 0, 1);
    expect(parseYearEnd(d)).toBe(d.getTime());
  });
  it("falls back to 31 Dec of last year on garbage", () => {
    const expected = new Date(new Date().getFullYear() - 1, 11, 31).getTime();
    expect(parseYearEnd("not a date")).toBe(expected);
  });
});

describe("findMeta / cellStr", () => {
  it("finds a labelled value to the right", () => {
    expect(findMeta([["Client:", "ACME"]], ["client"])).toBe("ACME");
  });
  it("returns '' for missing labels", () => {
    expect(findMeta([["Foo", "Bar"]], ["client"])).toBe("");
  });
  it("cellStr trims and null-guards", () => {
    expect(cellStr(["  x  ", null], 0)).toBe("x");
    expect(cellStr(["a"], 5)).toBe("");
    expect(cellStr(null, 0)).toBe("");
  });
});

describe("small pure helpers", () => {
  it("initialsOf", () => {
    expect(initialsOf("Acme Corp")).toBe("AC");
    expect(initialsOf("Google")).toBe("GO");
    expect(initialsOf("   ")).toBe("•");
  });
  it("fmtSize picks the right unit", () => {
    expect(fmtSize(500)).toBe("500 B");
    expect(fmtSize(2048)).toBe("2 KB");
    expect(fmtSize(1572864)).toBe("1.5 MB");
    expect(fmtSize(2 * 1073741824)).toBe("2.00 GB");
  });
  it("isOverdue only for past-due, not-accepted items", () => {
    const now = new Date(2026, 6, 14, 12).getTime();
    const yesterday = new Date("2026-07-13").getTime();
    const today = new Date("2026-07-14").getTime();
    const tomorrow = new Date("2026-07-15").getTime();
    expect(isOverdue({ status: "outstanding", dueDate: yesterday }, now)).toBe(true);
    expect(isOverdue({ status: "accepted", dueDate: yesterday }, now)).toBe(false);
    expect(isOverdue({ status: "outstanding", dueDate: today }, now)).toBe(false);
    expect(isOverdue({ status: "outstanding", dueDate: tomorrow }, now)).toBe(false);
    expect(isOverdue({ status: "outstanding", dueDate: null })).toBeFalsy();
  });
  it("onlyDigits / groupDigits", () => {
    expect(onlyDigits("12ab34-56")).toBe("123456");
    expect(onlyDigits("1".repeat(30))).toHaveLength(16);
    expect(groupDigits("1234123412341234")).toBe("1234 1234 1234 1234");
  });
});

// ---------------------------------------------------------------------------
// Activity-feed labelling — guards the client/firm feed we just reworked.
// ---------------------------------------------------------------------------
describe("notifMeta", () => {
  it("maps known actions to label + tone", () => {
    expect(notifMeta("removed_file")).toMatchObject({ tone: "slate", label: "ลบไฟล์ที่อัปไว้" });
    expect(notifMeta("accepted")).toMatchObject({ tone: "mint", label: "ตรวจรับ" });
    expect(notifMeta("returned")).toMatchObject({ tone: "amber", label: "ส่งกลับแก้ไข" });
    expect(notifMeta("Renamed")).toMatchObject({ label: "แก้ไขชื่อรายการ" });
  });
  it("falls back to the raw action for unknown types", () => {
    expect(notifMeta("weird_action")).toEqual({ icon: "doc", tone: "slate", label: "weird_action" });
  });
});

describe("timeAgo", () => {
  it("formats recent / minute / empty", () => {
    expect(timeAgo(Date.now() - 1000)).toBe("เมื่อสักครู่");
    expect(timeAgo(Date.now() - 2 * 60000)).toBe("2 นาทีที่แล้ว");
    expect(timeAgo(0)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Audit phases — the period switcher and per-period scoping turn on for both
// bookkeeping months and audit phases; phase keys must stay sortable.
// ---------------------------------------------------------------------------
describe("isMultiPeriod", () => {
  it("is true for monthly and phased, false for once/unknown", () => {
    expect(isMultiPeriod("monthly")).toBe(true);
    expect(isMultiPeriod("phased")).toBe(true);
    expect(isMultiPeriod("once")).toBe(false);
    expect(isMultiPeriod(undefined)).toBe(false);
  });
});

describe("nextPhaseKey", () => {
  it("starts at phase-0001 when there are no phase keys yet", () => {
    expect(nextPhaseKey([])).toBe("phase-0001");
    // a portal upgraded once->phased still has its month-keyed first period
    expect(nextPhaseKey([{ periodKey: "2026-12" }])).toBe("phase-0001");
  });
  it("increments past the highest existing phase, zero-padded so it sorts", () => {
    const periods = [{ periodKey: "2026-12" }, { periodKey: "phase-0001" }, { periodKey: "phase-0002" }];
    expect(nextPhaseKey(periods)).toBe("phase-0003");
    // numeric max, not string max: phase-0010 must beat phase-0009
    expect(nextPhaseKey([{ periodKey: "phase-0009" }, { periodKey: "phase-0010" }])).toBe("phase-0011");
  });
});
