const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

function pad2(value) {
  return String(value).padStart(2, "0");
}

// Database due dates are SQL `date` values. Keep their calendar label instead
// of comparing the UTC-midnight timestamp with the current time of day.
export function dateOnlyKey(value) {
  if (typeof value === "string") {
    const match = value.match(DATE_ONLY);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function localDateKey(value = Date.now()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function isPastDueDate(dueDate, now = Date.now()) {
  const due = dateOnlyKey(dueDate);
  const today = localDateKey(now);
  return Boolean(due && today && due < today);
}
