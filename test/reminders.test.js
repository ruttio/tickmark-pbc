import { describe, expect, it } from "vitest";
import {
  REMINDER_WINDOW_DAYS,
  bangkokPeriod,
  isUniqueViolation,
  reminderKindFor,
} from "../supabase/functions/_shared/reminders.ts";

describe("bangkokPeriod", () => {
  it("uses the Bangkok-local month, not the UTC month", () => {
    // 2026-06-30T18:00:00Z is 2026-07-01T01:00 in Bangkok (UTC+7) — already July.
    expect(bangkokPeriod(new Date("2026-06-30T18:00:00Z"))).toBe("2026-07");
    // 2026-07-01T16:00:00Z stays July 1 evening in Bangkok — well inside July.
    expect(bangkokPeriod(new Date("2026-07-01T16:00:00Z"))).toBe("2026-07");
  });

  it("does not roll over just before the Bangkok month boundary", () => {
    // 2026-06-30T16:00:00Z is 2026-06-30T23:00 in Bangkok — still June.
    expect(bangkokPeriod(new Date("2026-06-30T16:00:00Z"))).toBe("2026-06");
  });

  it("pads single-digit months", () => {
    expect(bangkokPeriod(new Date("2026-01-15T00:00:00Z"))).toBe("2026-01");
  });
});

describe("isUniqueViolation", () => {
  it("recognizes Postgres error code 23505 and only that code", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe("reminderKindFor", () => {
  const now = new Date("2026-07-20T00:00:00Z");

  it("returns null when there is nothing to nag about", () => {
    expect(reminderKindFor([], now)).toBeNull();
    expect(reminderKindFor(
      [{ status: "accepted", due_date: "2026-07-21" }], now,
    )).toBeNull();
  });

  it("prefers 'returned' over 'reminder' when both apply", () => {
    const items = [
      { status: "returned", due_date: null },
      { status: "outstanding", due_date: "2026-07-21" }, // due soon too
    ];
    expect(reminderKindFor(items, now)).toBe("returned");
  });

  it("ignores archived items entirely, even if returned", () => {
    expect(reminderKindFor(
      [{ status: "returned", due_date: null, archived_at: "2026-07-01T00:00:00Z" }], now,
    )).toBeNull();
  });

  it("flags an outstanding item due within the reminder window", () => {
    const dueInWindow = new Date(now.getTime() + (REMINDER_WINDOW_DAYS - 1) * 86400_000).toISOString();
    expect(reminderKindFor([{ status: "outstanding", due_date: dueInWindow }], now)).toBe("reminder");
  });

  it("flags an outstanding item that is already overdue", () => {
    expect(reminderKindFor([{ status: "outstanding", due_date: "2026-06-01" }], now)).toBe("reminder");
  });

  it("does not flag an outstanding item due well outside the window", () => {
    const dueLater = new Date(now.getTime() + (REMINDER_WINDOW_DAYS + 30) * 86400_000).toISOString();
    expect(reminderKindFor([{ status: "outstanding", due_date: dueLater }], now)).toBeNull();
  });

  it("does not flag an outstanding item with no due date", () => {
    expect(reminderKindFor([{ status: "outstanding", due_date: null }], now)).toBeNull();
  });

  it("ignores items in other statuses (submitted/review/accepted/reopened)", () => {
    const items = [
      { status: "submitted", due_date: "2026-06-01" },
      { status: "review", due_date: "2026-06-01" },
      { status: "reopened", due_date: "2026-06-01" },
    ];
    expect(reminderKindFor(items, now)).toBeNull();
  });
});
