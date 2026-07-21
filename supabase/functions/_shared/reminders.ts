// =====================================================================
//  Pure logic for automatic reminder eligibility + dedupe bookkeeping.
//  No Deno APIs here (no Deno.env, no fetch, no supabase-js) — same
//  discipline as uploadPolicy.ts — so this module can be unit-tested
//  directly under Vitest/Node, not just inside the Edge Function runtime.
// =====================================================================

export type NotifyKind = "invite" | "returned" | "reminder";

// Bangkok (Asia/Bangkok) has no DST and is always UTC+7, so a fixed offset
// is exact — no timezone database needed in the Deno runtime. This is the
// "month" a send counts against: the dedupe period stored in notify_log.
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

export function bangkokPeriod(date: Date = new Date()): string {
  const bkk = new Date(date.getTime() + BANGKOK_OFFSET_MS);
  const y = bkk.getUTCFullYear();
  const m = String(bkk.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------
//  PARKED — nothing calls the eligibility logic below right now.
//
//  It was written for a scheduled sweep that would decide, on its own, which
//  engagements deserve a reminder email. That sweep was deliberately dropped
//  before shipping: the firm chases clients over LINE by hand, so an emailed
//  nudge duplicates a channel the clients actually read, and letting a cron
//  in meant disabling this function's JWT verification and minding a static
//  shared secret in two places forever. Reminders are sent by a human
//  clicking "แจ้งลูกค้า"; that path scopes itself with fetchOpenPeriods() in
//  notify/index.ts and never consults the rules below.
//
//  Kept rather than deleted because it is pure, fully unit-tested, has zero
//  runtime surface while unreferenced, and is the hard part of reviving the
//  feature. If reminders stay manual for good, delete this block and its
//  tests — git history holds it.
// ---------------------------------------------------------------------

// How many days ahead of a due date an automatic reminder would start
// nagging. Thai monthly filings (ภ.ง.ด./ภ.พ.30) cluster around the 7th and
// 15th; a week's lead time gives the client room to act.
export const REMINDER_WINDOW_DAYS = 7;

export interface ReminderItemRow {
  status: string;
  due_date?: string | null;
  archived_at?: string | null;
  // Which portal period (see 20260720120000_periods.sql) this item belongs
  // to. Optional only so pre-periods call sites/tests don't have to supply
  // it; the automated sweep always populates it post-migration.
  period_id?: string | null;
}

// Given the outstanding/returned items of ONE engagement (already scoped to
// a single period by the caller — see remindersByPeriod below), decide which
// kind (if any) the automated sweep should send. `returned` wins over
// `reminder` when both apply: a client fixing a rejected item is more urgent
// than a nudge about something not due for a few more days.
export function reminderKindFor(
  items: ReminderItemRow[] | null | undefined,
  now: Date = new Date(),
): NotifyKind | null {
  const active = (items || []).filter((i) => !i.archived_at);
  if (active.some((i) => i.status === "returned")) return "returned";

  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 86400_000);
  const dueSoon = active.some((i) => {
    if (i.status !== "outstanding" || !i.due_date) return false;
    return new Date(i.due_date) <= windowEnd;
  });
  return dueSoon ? "reminder" : null;
}

// A portal period (subset of the `periods` table's columns the reminder
// logic needs). `period_key` is the sortable Gregorian machine key
// ('2026-07'); `label` is the Thai display form ('ก.ค. 2569'). Sort/compare
// on `period_key` ONLY — `label` is a display string, not chronological.
export interface PeriodInfo {
  id: string;
  period_key: string;
  label: string;
  status: string; // 'open' | 'closed'
}

export interface PeriodReminder {
  period: PeriodInfo;
  kind: NotifyKind;
}

// Enumerates which (period, kind) pairs the automated sweep should nag a
// SINGLE engagement about, given all of its outstanding/returned items and
// all of its periods.
//
// Rule: a closed period never generates a reminder. The client cannot act
// on it — the portal refuses uploads into a closed period (set_period_status
// in 20260720120000_periods.sql) — so nagging about it is useless at best
// and, because it looks like the firm doesn't know the month is done,
// actively damages trust. Items belonging to a closed (or unrecognized —
// fail safe, never fail open) period are dropped before grouping even
// happens, so an engagement whose only outstanding items live in closed
// periods yields an empty result, i.e. no email at all, rather than an
// empty/confusing one.
//
// Each remaining OPEN period is evaluated independently via reminderKindFor
// and produces its OWN entry (never merged into one cross-period blob).
// This is deliberate: the email this feeds is read by a small-business
// owner, not an accountant, so a list mixing "due this month" and "overdue
// from three months ago" under one undifferentiated heading is exactly the
// ambiguity to avoid. One entry per period lets the caller build one
// unambiguous, period-labelled email (or claim one dedupe slot) per period,
// so two simultaneously-open periods each reliably get their own notice
// instead of the second being silently swallowed by the first's dedupe
// claim (see the notify_log migration 20260720130000 for that failure
// mode in detail).
//
// Sorted oldest-first on `period_key` (never on `label`, which is Thai text
// and does not sort chronologically) for a deterministic, readable order.
export function remindersByPeriod(
  items: ReminderItemRow[] | null | undefined,
  periods: PeriodInfo[] | null | undefined,
  now: Date = new Date(),
): PeriodReminder[] {
  const openPeriods = new Map<string, PeriodInfo>();
  for (const p of periods || []) {
    if (p.status === "open") openPeriods.set(p.id, p);
  }

  const byPeriod = new Map<string, ReminderItemRow[]>();
  for (const it of items || []) {
    if (!it.period_id || !openPeriods.has(it.period_id)) continue; // closed or unknown — never nag
    const list = byPeriod.get(it.period_id) || [];
    list.push(it);
    byPeriod.set(it.period_id, list);
  }

  const out: PeriodReminder[] = [];
  for (const [periodId, periodItems] of byPeriod) {
    const kind = reminderKindFor(periodItems, now);
    if (kind) out.push({ period: openPeriods.get(periodId)!, kind });
  }

  out.sort((a, b) => a.period.period_key.localeCompare(b.period.period_key));
  return out;
}

// Postgres unique_violation. A conflict on notify_log's (engagement_id, kind,
// period) constraint means some other request (a concurrent cron run, a
// double-click, an overlapping retry) already claimed this send — that is a
// SUCCESS outcome ("already sent"), never a 500.
export function isUniqueViolation(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23505";
}
