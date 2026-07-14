import { describe, expect, it } from "vitest";
import { dateOnlyKey, isPastDueDate, localDateKey } from "../lib/dateUtils.js";

describe("date-only due dates", () => {
  const noonInBangkok = new Date(2026, 6, 14, 12).getTime();

  it("does not mark the current calendar date overdue after midnight", () => {
    expect(isPastDueDate("2026-07-14", noonInBangkok)).toBe(false);
    expect(isPastDueDate(new Date("2026-07-14").getTime(), noonInBangkok)).toBe(false);
  });

  it("marks only an earlier calendar date overdue", () => {
    expect(isPastDueDate("2026-07-13", noonInBangkok)).toBe(true);
    expect(isPastDueDate("2026-07-15", noonInBangkok)).toBe(false);
  });

  it("handles SQL date strings, nulls, and invalid values safely", () => {
    expect(dateOnlyKey("2026-07-14T23:59:59Z")).toBe("2026-07-14");
    expect(dateOnlyKey(null)).toBe(null);
    expect(dateOnlyKey("not-a-date")).toBe(null);
    expect(localDateKey(noonInBangkok)).toBe("2026-07-14");
    expect(isPastDueDate(null, noonInBangkok)).toBe(false);
  });
});
