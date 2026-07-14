import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_PORTAL_BYTES,
  exceedsPortalQuota,
  isAllowedUploadName,
  storedBytes,
  uploadExtension,
} from "../supabase/functions/_shared/uploadPolicy.ts";

describe("authoritative upload policy", () => {
  it("normalizes extensions and rejects unsupported names", () => {
    expect(uploadExtension("Trial.Balance.XLSX")).toBe("xlsx");
    expect(isAllowedUploadName("evidence.PDF")).toBe(true);
    expect(isAllowedUploadName("payload.exe")).toBe(false);
    expect(isAllowedUploadName("no-extension")).toBe(false);
  });

  it("sums only finite positive stored sizes", () => {
    expect(storedBytes([{ size: "12" }, { size: 8 }, { size: -4 }, { size: "bad" }])).toBe(20);
  });

  it("allows the exact portal limit and rejects one byte over it", () => {
    const rows = [{ size: MAX_PORTAL_BYTES - MAX_FILE_BYTES }];
    expect(exceedsPortalQuota(rows, MAX_FILE_BYTES)).toBe(false);
    expect(exceedsPortalQuota(rows, MAX_FILE_BYTES + 1)).toBe(true);
  });

  it("rejects invalid authoritative object sizes", () => {
    expect(exceedsPortalQuota([], Number.NaN)).toBe(true);
    expect(exceedsPortalQuota([], -1)).toBe(true);
  });
});
