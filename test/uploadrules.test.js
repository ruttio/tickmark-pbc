import { describe, it, expect } from "vitest";
import { fileError, extOf, MAX_FILE_BYTES } from "../src/uploadRules.js";

describe("uploadRules", () => {
  it("extOf pulls the lowercased extension", () => {
    expect(extOf("Statement.PDF")).toBe("pdf");
    expect(extOf("noext")).toBe("");
  });

  it("accepts allowed types under the size limit", () => {
    expect(fileError({ name: "tb.xlsx", size: 1000 })).toBeNull();
    expect(fileError({ name: "scan.pdf", size: MAX_FILE_BYTES })).toBeNull();
  });

  it("rejects disallowed extensions", () => {
    expect(fileError({ name: "malware.exe", size: 10 })).toMatch(/ไม่รองรับ/);
    expect(fileError({ name: "script.js", size: 10 })).toMatch(/ไม่รองรับ/);
  });

  it("rejects files over 50 MB", () => {
    expect(fileError({ name: "big.pdf", size: MAX_FILE_BYTES + 1 })).toMatch(/50 MB/);
  });
});
