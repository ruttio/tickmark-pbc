import { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { firmApi } from "./lib/portalApi.js";
import { SUPABASE_CONFIGURED } from "./lib/supabaseClient.js";
import { FilePreviewModal, isPreviewable } from "./src/FilePreview.jsx";
import { CommentThread } from "./src/CommentThread.jsx";
import { Analytics } from "./src/Analytics.jsx";
import { Icon } from "./src/icons.jsx";
import { isPastDueDate } from "./lib/dateUtils.js";
import "./src/portal.css"; // shared stylesheet (also used by the client portal)

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/* =========================================================================
   Tickmark — a Prepared-By-Client (PBC) request portal (prototype)
   Two roles in one screen so you can see both sides of the workflow:
     • Firm   — generate a request list from a template, review uploads,
                accept or return items, export the list as CSV.
     • Client — see the request list, upload documents per item, track status.
   Persists to window.storage so refreshes keep your data. File contents are
   not stored (metadata only) — in production this hits your own backend.
   ========================================================================= */

const STORE_KEY = "pbc:state:v1";

/* ---------- Status model ------------------------------------------------ */
const STATUS = {
  outstanding: { label: "Awaiting upload", glyph: "○", tone: "neutral" },
  submitted:   { label: "Submitted",       glyph: "↑", tone: "amber" },
  review:      { label: "Under review",    glyph: "◐", tone: "amberDeep" },
  accepted:    { label: "Accepted",        glyph: "✓", tone: "pine" },
  returned:    { label: "Returned",        glyph: "↩", tone: "rust" },
  reopened:    { label: "Reopened",        glyph: "↻", tone: "amber" },
};
const STATUS_ORDER = ["outstanding", "submitted", "review", "accepted", "returned", "reopened"];

/* ---------- PBC template libraries (the "PBC function") ----------------- */
const TEMPLATES = [
  {
    key: "audit",
    name: "Annual Financial Statement Audit",
    blurb: "Full-scope request list across the financial statement areas.",
    groups: [
      ["General", [
        ["Signed engagement letter", true],
        ["Final trial balance (year-end)", true],
        ["General ledger detail (full year)", true],
        ["Prior-year financial statements", true],
        ["Board / shareholder meeting minutes", false],
      ]],
      ["Cash & Bank", [
        ["Bank statements — all accounts, year-end", true],
        ["Bank reconciliations — all accounts", true],
        ["Signed bank confirmation authorizations", true],
      ]],
      ["Receivables", [
        ["Accounts receivable aging at year-end", true],
        ["AR subledger reconciled to GL", true],
        ["Allowance for doubtful accounts analysis", false],
      ]],
      ["Inventory", [
        ["Inventory listing at year-end (qty × cost)", true],
        ["Physical count sheets", false],
        ["Obsolescence / lower-of-cost analysis", false],
      ]],
      ["Fixed Assets", [
        ["Fixed asset register", true],
        ["Additions & disposals support", true],
        ["Depreciation schedule", true],
      ]],
      ["Payables & Accruals", [
        ["Accounts payable aging at year-end", true],
        ["Accrued liabilities schedule", true],
        ["Subsequent payments listing (search)", false],
      ]],
      ["Debt & Equity", [
        ["Loan agreements & amortization schedules", true],
        ["Covenant compliance calculations", false],
        ["Share register / cap table", true],
      ]],
      ["Revenue & Payroll", [
        ["Revenue by month with cutoff support", true],
        ["Payroll register & tax filings", true],
      ]],
      ["Tax", [
        ["Income tax provision calculation", true],
        ["Filed tax returns", false],
      ]],
    ],
  },
  {
    key: "tax",
    name: "Tax Return Preparation",
    blurb: "Source documents needed to prepare the return.",
    groups: [
      ["Income", [
        ["Annual financial statements", true],
        ["Bank & investment income summaries", true],
        ["Capital gains / disposals detail", false],
      ]],
      ["Expenses", [
        ["Expense ledger by category", true],
        ["Fixed asset additions for the year", false],
        ["Vehicle & travel logs", false],
      ]],
      ["Prior & Compliance", [
        ["Prior-year tax return", true],
        ["Tax assessment notices", false],
        ["Estimated payments made", true],
      ]],
    ],
  },
  {
    key: "review",
    name: "Quarterly Review",
    blurb: "Lighter request set for an interim review.",
    groups: [
      ["Core", [
        ["Quarter-end trial balance", true],
        ["Bank statements & reconciliations", true],
        ["AR & AP aging", true],
        ["Significant journal entries listing", false],
        ["Management commentary on variances", false],
      ]],
    ],
  },
  {
    key: "bookkeeping",
    name: "ทำบัญชี + ยื่นภาษีรายเดือน",
    blurb: "เอกสารสำหรับบันทึกบัญชีและยื่นภาษีประจำเดือน (ประเทศไทย)",
    groups: [
      ["รายได้ / ขาย", [
        ["ใบกำกับภาษีขาย (ทุกใบในเดือน)", true],
        ["รายงานภาษีขาย", true],
        ["ใบเสร็จรับเงิน / ใบแจ้งหนี้", false],
      ]],
      ["ค่าใช้จ่าย / ซื้อ", [
        ["ใบกำกับภาษีซื้อ (ทุกใบในเดือน)", true],
        ["รายงานภาษีซื้อ", true],
        ["บิล / ใบเสร็จค่าใช้จ่ายอื่นๆ", true],
      ]],
      ["ธนาคาร", [
        ["Bank statement ทุกบัญชี (ทั้งเดือน)", true],
        ["หลักฐานการโอน / ชำระเงิน", false],
      ]],
      ["เงินเดือน / พนักงาน", [
        ["รายการจ่ายเงินเดือน (payroll)", true],
        ["หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ)", false],
      ]],
      ["ภาษี", [
        ["ภ.พ.30 (VAT) เดือนก่อน", false],
        ["ภ.ง.ด.1 (หัก ณ ที่จ่ายเงินเดือน)", false],
        ["ภ.ง.ด.3 / ภ.ง.ด.53 (หัก ณ ที่จ่าย)", false],
        ["ใบเสร็จการชำระภาษี", false],
      ]],
      ["อื่นๆ", [
        ["สต็อกสินค้าคงเหลือ (ถ้ามี)", false],
        ["ใบสำคัญรับ / จ่าย", false],
      ]],
    ],
  },
  {
    key: "blank",
    name: "กำหนดรายการเอง (เริ่มจากศูนย์)",
    blurb: "เริ่มจากรายการว่าง แล้วเพิ่มรายการเอกสารที่ต้องการเองทั้งหมด",
    groups: [],
  },
];

/* ---------- Small helpers ---------------------------------------------- */
const uid = () => Math.random().toString(36).slice(2, 10);
const DAY = 86400000;

/* ---------- Passcode helpers (16-digit per-portal access code) ---------- */
const DEMO_CODE = "1234123412341234"; // demo engagement only — see lock screen hint
// Hash the code so we never persist the raw passcode (SHA-256 via Web Crypto).
async function hashCode(code) {
  try {
    const data = new TextEncoder().encode("tickmark:pbc:" + code);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // fallback for non-secure contexts (still avoids storing the raw code)
    let h = 0; const s = "tickmark:" + code;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return "fb" + h.toString(16);
  }
}
export const onlyDigits = (s) => s.replace(/\D+/g, "").slice(0, 16);
export const groupDigits = (s) => s.replace(/(.{4})/g, "$1 ").trim();
const genCode = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join("");
// Initials for a group avatar: first letters of up to two words (or first 2 chars).
export const initialsOf = (name = "") => {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return (w.length >= 2 ? w[0][0] + w[1][0] : (name.trim().slice(0, 2))).toUpperCase() || "•";
};

/* ---------- Retention / expiry (auto-delete portals) -------------------- */
const RETENTION_OPTIONS = [
  { label: "ไม่หมดอายุ", days: null },
  { label: "30 วัน", days: 30 },
  { label: "60 วัน", days: 60 },
  { label: "90 วัน", days: 90 },
  { label: "180 วัน", days: 180 },
  { label: "1 ปี", days: 365 },
];
const expiryFromDays = (days, base = Date.now()) => (days == null ? null : base + days * DAY);
// Returns { state: 'none'|'active'|'soon'|'expired', daysLeft }
function engExpiry(eng) {
  if (!eng || !eng.expiresAt) return { state: "none", daysLeft: null };
  const left = eng.expiresAt - Date.now();
  if (left <= 0) return { state: "expired", daysLeft: 0 };
  const daysLeft = Math.ceil(left / DAY);
  return { state: daysLeft <= 7 ? "soon" : "active", daysLeft };
}

function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}
export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}
export function isOverdue(item, now = Date.now()) {
  return item.status !== "accepted" && isPastDueDate(item.dueDate, now);
}
function buildItems(template, baseDue) {
  const items = [];
  template.groups.forEach(([category, rows]) => {
    rows.forEach(([description, required]) => {
      items.push({
        id: uid(),
        ref: String(items.length + 1).padStart(2, "0"),
        category,
        description,
        required,
        dueDate: baseDue,
        status: "outstanding",
        files: [],
        note: "",
        history: [{ at: Date.now(), by: "Firm", action: "Requested" }],
      });
    });
  });
  return items;
}

/* ---------- Excel (PBC template) parser --------------------------------- */
const RECEIVED_WORDS = ["ได้รับแล้ว", "received", "complete", "done", "ตรวจแล้ว", "ครบ", "ok"];

export function cellStr(row, i) {
  const v = row ? row[i] : undefined;
  return v == null ? "" : String(v).trim();
}
export function mapImportStatus(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s) return "outstanding";
  if (RECEIVED_WORDS.some((w) => s.includes(w.toLowerCase()))) return "accepted";
  return "outstanding";
}
function toDateInput(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function parseYearEnd(raw) {
  if (raw instanceof Date) return raw.getTime();
  const s = String(raw || "").trim();
  let m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);   // DD-MM-YYYY
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
  m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);        // YYYY-MM-DD
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  const d = new Date(s);
  if (!isNaN(d)) return d.getTime();
  return new Date(new Date().getFullYear() - 1, 11, 31).getTime();
}
export function findMeta(aoa, labels) {
  for (let r = 0; r < aoa.length; r++) {
    const row = aoa[r] || [];
    for (let c = 0; c < row.length; c++) {
      const v = cellStr(row, c).toLowerCase().replace(/:$/, "").trim();
      if (labels.includes(v)) {
        const below = cellStr(aoa[r + 1], c);
        if (below) return below;
        const right = cellStr(row, c + 1);
        if (right) return right;
      }
    }
  }
  return "";
}
// Reads an array-of-arrays grid and returns { meta, items }
export function parsePBC(aoa) {
  let hr = -1;
  for (let r = 0; r < aoa.length; r++) {
    const cells = (aoa[r] || []).map((x) => String(x == null ? "" : x).trim().toLowerCase());
    const hasKey = cells.some((x) => /status|requested|description|process/.test(x));
    const hasAnchor = cells.some((x) => x === "no." || x === "no") || cells.some((x) => /status/.test(x));
    if (hasKey && hasAnchor) { hr = r; break; }
  }
  if (hr < 0) hr = 0;
  const head = (aoa[hr] || []).map((x) => String(x == null ? "" : x).trim().toLowerCase());
  const find = (re) => head.findIndex((x) => re.test(x));
  const noCol = find(/^no\.?$/);
  // Dedicated category column ("Process" / "Category" / "Section" / "หมวด").
  // Many PBC templates put the section name here on EVERY row, not in the
  // description column — so detect it explicitly instead of inferring.
  const catCol = find(/process|category|section|cycle|area|หมวด|กระบวนการ|วงจร/);
  const descCol = find(/description|document|particular|รายการ|เอกสาร/);
  const reqCol = find(/requested|request/);
  const statusCol = find(/status|สถานะ/);
  const remarkCol = find(/remark|note|หมายเหตุ/);

  // The actual document text often sits one column to the right of the
  // "Requested Document" header (which labels a running number). Among the
  // sensible candidate columns, pick the one with the most long text in the
  // body — robust across templates.
  const skip = new Set([noCol, catCol, statusCol, remarkCol].filter((c) => c >= 0));
  const candidates = [...new Set([
    reqCol >= 0 ? reqCol + 1 : -1, descCol >= 0 ? descCol : -1,
    reqCol >= 0 ? reqCol : -1, descCol >= 0 ? descCol + 1 : -1,
  ])].filter((c) => c >= 0 && !skip.has(c));
  const score = (c) => {
    let n = 0;
    for (let r = hr + 1; r < aoa.length; r++) {
      const v = cellStr(aoa[r], c);
      if (v && isNaN(Number(v)) && v.length >= 5) n++;
    }
    return n;
  };
  let textCol = -1, best = -1;
  for (const c of candidates) { const s = score(c); if (s > best) { best = s; textCol = c; } }
  if (textCol < 0) textCol = descCol >= 0 ? descCol : reqCol;

  const items = [];
  let cat = "General";
  for (let r = hr + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    // Category: prefer the dedicated column (filled on every row). With no such
    // column, fall back to treating a description-only row as a section header.
    if (catCol >= 0) {
      const c = cellStr(row, catCol);
      if (c) cat = c;
    }
    let text = textCol >= 0 ? cellStr(row, textCol) : "";
    if (!text && reqCol >= 0 && reqCol !== textCol) {
      const rq = cellStr(row, reqCol);
      if (rq && isNaN(Number(rq))) text = rq;
    }
    if (catCol < 0 && descCol >= 0) {
      const d = cellStr(row, descCol);
      if (d && !text) { cat = d; continue; }
    }
    if (!text) continue;
    items.push({
      id: uid(), category: cat || "General", text,
      status: mapImportStatus(statusCol >= 0 ? cellStr(row, statusCol) : ""),
      remark: remarkCol >= 0 ? cellStr(row, remarkCol) : "", include: true,
    });
  }
  return {
    meta: {
      client: findMeta(aoa, ["client", "customer"]),
      yearEnd: findMeta(aoa, ["year-end", "year end", "period end", "period-end"]),
      preparedBy: findMeta(aoa, ["prepared by"]),
      wpRef: findMeta(aoa, ["w/p reference", "wp reference", "reference"]),
    },
    items,
  };
}

/* ---------- Seed data so the prototype isn't empty ---------------------- */
function seedState() {
  const t = TEMPLATES[0];
  const items = buildItems(t, Date.now() + 14 * DAY);
  // dramatize a few statuses + a couple of dates for the demo
  if (items[0]) {
    items[0].status = "accepted";
    items[0].files = [{ name: "Engagement_Letter_signed.pdf", size: 184320, type: "application/pdf", uploadedAt: Date.now() - 6 * DAY }];
    items[0].history.push({ at: Date.now() - 6 * DAY, by: "Client", action: "Submitted" }, { at: Date.now() - 5 * DAY, by: "Firm", action: "Accepted" });
  }
  if (items[1]) {
    items[1].status = "submitted";
    items[1].files = [{ name: "TB_FY25_final.xlsx", size: 51200, type: "application/vnd.ms-excel", uploadedAt: Date.now() - DAY }];
    items[1].history.push({ at: Date.now() - DAY, by: "Client", action: "Submitted" });
  }
  if (items[2]) {
    items[2].status = "returned";
    items[2].note = "This export is missing the closing entries — please re-run after the year-end close.";
    items[2].history.push({ at: Date.now() - 3 * DAY, by: "Client", action: "Submitted" }, { at: Date.now() - 2 * DAY, by: "Firm", action: "Returned" });
  }
  if (items[5]) items[5].dueDate = Date.now() - 2 * DAY; // overdue example
  return {
    engagements: [{
      id: uid(),
      client: "Northwind Trading Co.",
      template: t.name,
      periodEnd: new Date(new Date().getFullYear() - 1, 11, 31).getTime(),
      createdAt: Date.now() - 7 * DAY,
      expiresAt: Date.now() + 21 * DAY,   // demo: shows "เหลือ 21 วัน"
      autoDelete: false,                  // demo never auto-purges
      items,
    }],
    currentId: null,
  };
}

/* ======================================================================= */
export default function App() {
  const [session, setSession] = useState(undefined); // undefined = checking, null = signed out
  const [recovery, setRecovery] = useState(() =>
    typeof window !== "undefined" && window.location.hash.includes("type=recovery")); // arrived via reset link
  const [profile, setProfile] = useState(undefined); // undefined = loading, then { approved, ... } | null
  const [engagements, setEngagements] = useState([]); // summary list (no items)
  const [currentId, setCurrentId] = useState(null);
  const [eng, setEng] = useState(null);               // detail of currentId (items + files + history)
  const [openItem, setOpenItem] = useState(null);     // item id for drawer
  const [unreadC, setUnreadC] = useState({});         // { itemId: unread client-comment count } in the open engagement
  const [modal, setModal] = useState(null);           // 'generate' | 'add' | 'import' | 'settings'
  const [rollSource, setRollSource] = useState(null); // roll-forward: prefill GenerateModal from a prior portal
  const [importDraft, setImportDraft] = useState(null);
  const importRef = useRef(null);
  const [statusSel, setStatusSel] = useState([]);     // engagement-detail status filters (empty = all; may include "overdue")
  const [itemQ, setItemQ] = useState("");             // engagement-detail text search
  const [catSel, setCatSel] = useState([]);           // engagement-detail category filters (empty = all)
  const [busy, setBusy] = useState(false);            // a backend mutation is in flight
  const [err, setErr] = useState("");
  const [view, setView] = useState("dashboard");      // 'dashboard' | 'engagement'
  const [dash, setDash] = useState(null);             // engagements + progress for the dashboard
  const [notifs, setNotifs] = useState([]);           // recent client activity (notification center)
  const [followups, setFollowups] = useState([]);     // open items to follow up (overdue / due-soon / to-review)
  const [storage, setStorage] = useState(null);       // this firm's referenced bytes (RLS-scoped)
  const [bucketUsage, setBucketUsage] = useState(null); // whole shared bucket { bytes, count }
  const [analytics, setAnalytics] = useState(null);     // dashboard analytics (firm_analytics RPC)

  /* ---- auth session ---- */
  useEffect(() => {
    let alive = true;
    firmApi.getSession().then((s) => { if (alive) setSession(s); });
    const unsub = firmApi.onAuthChange((event, s) => {
      if (!alive) return;
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession(s);
    });
    return () => { alive = false; unsub(); };
  }, []);

  const saveNewPassword = (pw) =>
    run(async () => {
      await firmApi.updatePassword(pw);
      setRecovery(false);
      history.replaceState(null, "", window.location.pathname + window.location.search); // drop the token from the URL
      alert("ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว");
    });

  /* ---- load the signed-in user's profile (for the approval gate) ---- */
  useEffect(() => {
    let alive = true;
    if (!session) { setProfile(undefined); firmApi.setActor(null); return; }
    firmApi.getProfile()
      .then((p) => { if (alive) { setProfile(p); firmApi.setActor(p?.full_name || session.user?.email || null); } })
      .catch(() => { if (alive) setProfile(null); });
    return () => { alive = false; };
  }, [session]);

  /* ---- load the firm's portals once signed in (RLS scopes to this firm) ---- */
  const reloadList = async (selectId) => {
    setErr("");
    try {
      const list = await firmApi.listEngagements();
      setEngagements(list);
      setCurrentId((cur) => selectId ?? (list.find((e) => e.id === cur)?.id || list[0]?.id || null));
    } catch (e) { setErr(e.message || "โหลดรายการพอร์ทัลไม่สำเร็จ"); }
  };
  useEffect(() => {
    if (session) reloadList();
    else { setEngagements([]); setCurrentId(null); setEng(null); }
  }, [session]);

  /* ---- dashboard: all portals + their progress ---- */
  const loadDashboard = async () => {
    setErr("");
    try {
      const [d, n, s, f, b, a] = await Promise.all([
        firmApi.listEngagementsWithProgress(),
        firmApi.listNotifications().catch(() => []),
        firmApi.getStorageUsage().catch(() => null),
        firmApi.listFollowUps().catch(() => []),
        firmApi.getBucketUsage().catch(() => null),
        firmApi.getAnalytics().catch(() => null),
      ]);
      setDash(d); setNotifs(n); setStorage(s); setFollowups(f); setBucketUsage(b); setAnalytics(a);
    } catch (e) { setErr(e.message || "โหลดภาพรวมไม่สำเร็จ"); }
  };
  useEffect(() => {
    if (session && profile?.approved && view === "dashboard") loadDashboard();
  }, [session, profile, view]);

  // navigation between the dashboard and a single engagement
  const openEngagement = (id) => {
    setCurrentId(id); setOpenItem(null); setView("engagement");
    firmApi.markEngagementSeen(id).catch(() => {}); // clear its unread badge
  };
  // Open a portal AND jump straight to a specific item (its drawer opens once
  // the engagement loads). Used by the dashboard status drill-in.
  const openItemInEngagement = (engId, itemId) => {
    setCurrentId(engId); setView("engagement");
    firmApi.markEngagementSeen(engId).catch(() => {});
    openItemDrawer(itemId);
  };
  // Open an item's drawer; if it has unread client comments, mark them read
  // (optimistically drop it from the unread card) so the notification clears.
  const openItemDrawer = (itemId) => {
    setOpenItem(itemId);
    setUnreadC((prev) => { if (!prev[itemId]) return prev; const n = { ...prev }; delete n[itemId]; return n; });
    firmApi.markItemRead(itemId).catch(() => {});
  };
  const goDashboard = () => { setOpenItem(null); setView("dashboard"); };
  // Open the Generate modal fresh, or pre-filled from a prior portal (roll-forward).
  const openGenerate = (src = null) => { setRollSource(src); setModal("generate"); };
  const buildRollSource = (e) => ({
    client: e.client, template: e.template, periodEnd: e.periodEnd,
    clientEmail: e.clientEmail, groupId: e.groupId || "",
    items: (e.items || []).filter((it) => !it.archivedAt).map((it) => ({ category: it.category, description: it.description, required: it.required })),
  });
  const markAllRead = () => run(() => firmApi.markAllSeen(), loadDashboard);

  /* ---- load the selected portal's detail when it changes ---- */
  const reloadDetail = async () => {
    if (!currentId) { setEng(null); return; }
    setErr("");
    try { setEng(await firmApi.getEngagement(currentId)); }
    catch (e) { setErr(e.message || "โหลดพอร์ทัลไม่สำเร็จ"); }
    firmApi.listUnreadComments(currentId).then(setUnreadC).catch(() => {});
  };
  useEffect(() => {
    if (session && currentId) reloadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, session]);

  // Run a backend mutation with a busy flag + error surfacing, then refresh.
  const run = async (fn, after) => {
    setBusy(true); setErr("");
    try { await fn(); if (after) await after(); }
    catch (e) { setErr(e.message || "ดำเนินการไม่สำเร็จ"); alert(e.message || "ดำเนินการไม่สำเร็จ"); }
    finally { setBusy(false); }
  };

  const signOut = () => run(() => firmApi.signOut());

  /* ---- mutations: every one hits the backend, then refreshes ---- */
  const setStatus = (itemId, status, _by, action, extra = {}) =>
    run(() => firmApi.setItemStatus(itemId, status, action, extra.note), reloadDetail);

  // Return an item, optionally flagging specific files (partial return).
  const returnItem = (itemId, note, rejectedIds, okIds) =>
    run(async () => {
      if ((rejectedIds && rejectedIds.length) || (okIds && okIds.length))
        await firmApi.setItemFileRejections(rejectedIds, okIds);
      await firmApi.setItemStatus(itemId, "returned", "Returned", note);
    }, reloadDetail);

  const generateEngagement = ({ client, template, periodEnd, baseDue, code, retDays, autoDelete, clientEmail, sendInvite, items, groupId }) =>
    run(async () => {
      const id = await firmApi.createEngagement(
        { client, template, periodEnd, code, retentionDays: retDays, autoDelete, clientEmail },
        items.map((it, i) => ({
          ref: String(i + 1).padStart(2, "0"), category: it.category || "General",
          description: it.description, required: it.required ?? true, dueDate: baseDue, status: "outstanding", sort: i,
        }))
      );
      if (groupId) { try { await firmApi.setEngagementGroup(id, groupId); } catch (_) { /* keep the portal even if grouping fails */ } }
      setModal(null);
      await reloadList(id);
      setView("engagement");
      if (sendInvite) {
        try { await firmApi.notify(id, "invite"); }
        catch (e) { alert("สร้างพอร์ทัลสำเร็จ แต่ส่งอีเมลไม่สำเร็จ: " + (e.message || e)); }
      }
    });

  const importEngagement = ({ client, periodEnd, baseDue, items, code, retDays, autoDelete, clientEmail, sendInvite }) =>
    run(async () => {
      const id = await firmApi.createEngagement(
        { client, template: "นำเข้าจาก Excel (PBC)", periodEnd, code, retentionDays: retDays, autoDelete, clientEmail },
        items.map((it, i) => ({
          ref: String(i + 1).padStart(2, "0"), category: it.category || "General",
          description: it.text, required: true, dueDate: baseDue, status: it.status, sort: i,
        }))
      );
      setModal(null); setImportDraft(null); setOpenItem(null);
      await reloadList(id);
      setView("engagement");
      if (sendInvite) {
        try { await firmApi.notify(id, "invite"); }
        catch (e) { alert("สร้างพอร์ทัลสำเร็จ แต่ส่งอีเมลไม่สำเร็จ: " + (e.message || e)); }
      }
    });

  const addItem = ({ category, description, required, dueDate }) =>
    run(async () => {
      const sort = eng?.items?.length || 0;
      await firmApi.addItem(eng.id, { ref: String(sort + 1).padStart(2, "0"), category, description, required, dueDate }, sort);
      setModal(null);
    }, reloadDetail);

  // "Delete" an item = move it to the Archived box (soft delete).
  const deleteItem = (itemId) =>
    run(() => firmApi.archiveItem(itemId), async () => { setOpenItem(null); await reloadDetail(); });

  const saveItemNote = (itemId, note) => run(() => firmApi.setItemNote(itemId, note), reloadDetail);
  const updateItem = (itemId, patch) => run(() => firmApi.updateItem(itemId, patch), reloadDetail);
  const uploadSample = (itemId, fileList) =>
    run(async () => { for (const f of Array.from(fileList)) await firmApi.uploadSample(eng.id, itemId, f); }, reloadDetail);
  const removeSample = (f) => run(() => firmApi.removeSample(f.id, f.storagePath), reloadDetail);

  const setEngPasscode = (id, code) => run(() => firmApi.setPortalCode(id, code));
  const setEngRetention = (id, days, autoDelete) =>
    run(() => firmApi.setRetention(id, { expiresAt: expiryFromDays(days, eng?.createdAt || Date.now()), autoDelete }), reloadDetail);
  const extendEng = (id, days) =>
    run(() => firmApi.setRetention(id, { expiresAt: Math.max(Date.now(), eng?.expiresAt || Date.now()) + days * DAY, autoDelete: eng?.autoDelete }), reloadDetail);
  const deleteEng = (id) =>
    run(() => firmApi.deleteEngagement(id), async () => { setOpenItem(null); setModal(null); setView("dashboard"); await reloadList(); });

  // Private bucket -> short-lived signed URL, opened in a new tab.
  const downloadFile = (f) =>
    run(async () => {
      const url = await firmApi.signedDownloadUrl(f.storagePath, 60);
      window.open(url, "_blank");
      await firmApi.markFilesDownloaded([f.id]);
      await reloadDetail();
    });

  // Zip this engagement's files (foldered by category). onlyNew = skip files
  // the firm already downloaded. Marks the included files downloaded afterwards.
  const downloadZip = (onlyNew) =>
    run(async () => {
      if (!eng) return;
      let files = eng.items.flatMap((it) => it.files.map((f) => ({ ...f, category: it.category, ref: it.ref })));
      if (onlyNew) files = files.filter((f) => !f.downloadedAt);
      if (files.length === 0) { alert(onlyNew ? "ไม่มีไฟล์ใหม่ที่ยังไม่ได้โหลด" : "ยังไม่มีไฟล์ให้ดาวน์โหลด"); return; }
      setModal(null);
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const safe = (s) => String(s || "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
      for (const f of files) {
        const url = await firmApi.signedDownloadUrl(f.storagePath, 300);
        const res = await fetch(url);
        if (!res.ok) continue;
        zip.file(`${safe(f.category)}/${f.ref ? f.ref + "_" : ""}${safe(f.name)}`, await res.blob());
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `PBC_${safe(eng.client)}${onlyNew ? "_new" : ""}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
      await firmApi.markFilesDownloaded(files.map((f) => f.id));
      await reloadDetail();
    });

  const notifyClient = () => {
    if (!eng?.clientEmail) { alert("ยังไม่มีอีเมลลูกค้า — เพิ่มได้ที่ ⚙ ตั้งค่าพอร์ทัล"); return; }
    setModal("notify");
  };
  // Send exactly one email of the chosen kind ('invite' | 'returned' | 'reminder').
  const sendNotify = (kind) =>
    run(async () => { await firmApi.notify(eng.id, kind); setModal(null); alert("ส่งอีเมลแล้ว → " + eng.clientEmail); });

  /* ---- Excel import: read file -> draft -> preview (pure client-side parse) ---- */
  const handleImportFile = async (file) => {
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
      const draft = parsePBC(aoa);
      if (!draft.items.length) { alert("ไม่พบรายการเอกสารในไฟล์นี้ — โปรดตรวจสอบว่ามีหัวคอลัมน์ Status / Description"); return; }
      setImportDraft(draft); setModal("import");
    } catch (err) { console.error(err); alert("อ่านไฟล์ไม่สำเร็จ: " + err.message); }
  };

  /* ---- derived ---- */
  const stats = useMemo(() => {
    const items = eng?.items || [];
    const by = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    items.forEach((it) => { by[it.status]++; });
    const overdue = items.filter(isOverdue).length;
    const pct = items.length ? Math.round((by.accepted / items.length) * 100) : 0;
    return { total: items.length, by, overdue, pct };
  }, [eng]);

  const grouped = useMemo(() => {
    const items = (eng?.items || []).filter((it) =>
      statusSel.length === 0 ? true : statusSel.some((s) => (s === "overdue" ? isOverdue(it) : it.status === s)));
    const map = new Map();
    items.forEach((it) => { if (!map.has(it.category)) map.set(it.category, []); map.get(it.category).push(it); });
    return [...map.entries()];
  }, [eng, statusSel]);

  // Engagement-detail (3e) left panel: category list (all items) + the grouped
  // list further narrowed by the category filter and the text search.
  const detailCats = useMemo(() => {
    const arr = []; const m = new Map();
    (eng?.items || []).forEach((it) => {
      let c = m.get(it.category);
      if (!c) { c = { cat: it.category, count: 0, overdue: 0 }; m.set(it.category, c); arr.push(c); }
      c.count++; if (isOverdue(it)) c.overdue++;
    });
    return arr;
  }, [eng]);
  const viewGroups = useMemo(() => {
    const q = itemQ.trim().toLowerCase();
    return grouped
      .filter(([cat]) => catSel.length === 0 || catSel.includes(cat))
      .map(([cat, items]) => [cat, items.filter((it) => !q || `${it.ref} ${it.description}`.toLowerCase().includes(q))])
      .filter(([, items]) => items.length > 0);
  }, [grouped, catSel, itemQ]);

  const exportCSV = () => {
    if (!eng) return;
    const head = ["Ref", "Category", "Description", "Required", "Due date", "Status", "Files"];
    const rows = eng.items.map((it) => [
      it.ref, it.category, it.description, it.required ? "Required" : "Optional",
      it.dueDate ? new Date(it.dueDate).toISOString().slice(0, 10) : "",
      STATUS[it.status].label, it.files.map((f) => f.name).join(" | "),
    ]);
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [head, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = `PBC_${eng.client.replace(/\s+/g, "_")}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const drawerItem = eng?.items.find((it) => it.id === openItem) || null;

  if (session === undefined) return <div className="tk-boot">Loading…</div>;
  if (recovery) return <SetNewPasswordScreen busy={busy} onSave={saveNewPassword} onSignOut={signOut} />;
  if (!session) return <AuthScreen />;
  if (profile === undefined) return <div className="tk-boot">Loading…</div>;
  if (!profile || !profile.approved)
    return <PendingApprovalScreen email={session.user?.email} onSignOut={signOut} />;

  return (
    <div className="tk-root">
      {/* Top bar (engagement view only; the dashboard renders its own navy top bar) */}
      {err && (
        <div className="tk-purge">{err}<button onClick={() => setErr("")}>✕</button></div>
      )}

      {view === "dashboard" ? (
        <FirmDashboard dash={dash} notifs={notifs} followups={followups} storage={storage} bucketUsage={bucketUsage} analytics={analytics} session={session} onOpen={openEngagement} onOpenItem={openItemInEngagement}
          onNew={() => openGenerate()} onGroups={() => setModal("groups")} onMarkAllRead={markAllRead} onSignOut={signOut} />
      ) : !eng ? (
        <div className="tk-boot">กำลังโหลดพอร์ทัล…</div>
      ) : engExpiry(eng).state === "expired" ? (
        <ExpiredScreen key={eng.id} eng={eng} role="firm"
          onExtend={(days) => extendEng(eng.id, days)}
          onDelete={() => deleteEng(eng.id)} />
      ) : (
        <div className="nv">
          {/* navy top bar */}
          <div className="nv-top">
            <div className="nv-brand"><span className="mk"><Tick size={17} /></span><span className="wd">Tickmark</span><span className="nv-pill">PBC Portal · Firm</span></div>
            <div className="nv-top-right">
              <button className="nv-tbtn" onClick={goDashboard}>← ภาพรวม</button>
              {engagements.length > 0 && (
                <select className="nv-sel" value={currentId || ""} onChange={(e) => openEngagement(e.target.value)}>
                  {engagements.map((e) => {
                    const ex = engExpiry(e);
                    const tag = ex.state === "expired" ? " · หมดอายุ" : ex.state === "soon" ? ` · เหลือ ${ex.daysLeft} วัน` : "";
                    return <option key={e.id} value={e.id}>{e.client}{tag}</option>;
                  })}
                </select>
              )}
              <button className="nv-cta" onClick={() => openGenerate()}>+ New portal</button>
              <span className="nv-email">{session.user?.email}</span>
              <span className="nv-icon" title="ออกจากระบบ" onClick={signOut}>⎋</span>
            </div>
          </div>

          <div className="nv-page">
            {/* compact engagement header */}
            <div className="nv-eh">
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <span className="nv-eh-name">{eng.client}</span>
                  <span className="nv-eh-type">{eng.template}</span>
                  {eng.myRole && <span className={`nv-role ${eng.myRole === "owner" ? "own" : "mem"}`}>{eng.myRole === "owner" ? "เจ้าของ" : "สมาชิก"}</span>}
                </div>
                <div className="nv-eh-meta">
                  งวดสิ้นสุด <b>{fmtDate(eng.periodEnd)}</b> · {stats.total} รายการ
                  {stats.overdue > 0 && <> · <span className="od">{stats.overdue} เกินกำหนด</span></>}
                  {(() => {
                    const x = engExpiry(eng);
                    if (x.state === "none") return null;
                    return <> &nbsp;·&nbsp; หมดอายุ {fmtDate(eng.expiresAt)} · เหลือ {x.daysLeft} วัน{eng.autoDelete && " · ลบอัตโนมัติ"}</>;
                  })()}
                </div>
              </div>
              <div className="nv-eh-right">
                <div className="nv-eh-pct"><div><b>{stats.pct}</b><i>%</i></div><span>{stats.by.accepted} of {stats.total} accepted</span></div>
                <div className="nv-dots" aria-hidden="true">
                  {eng.items.map((it) => (
                    <span key={it.id} className={it.status === "accepted" ? "done" : isOverdue(it) ? "od" : it.status === "outstanding" ? "" : "wip"} />
                  ))}
                </div>
              </div>
            </div>

            {/* two-column: left filter panel (dropdowns) + document list */}
            <div className="nv-work">
              {/* LEFT: search, alert, status + category dropdown filters */}
              <aside className="nv-aside">
                <div className="nv-isearch"><span>⌕</span><input value={itemQ} onChange={(e) => setItemQ(e.target.value)} placeholder="ค้นหาเอกสาร…" /></div>
                {stats.overdue > 0 && (
                  <div className="nv-alert" onClick={() => { setStatusSel(["overdue"]); setCatSel([]); }}>
                    <span className="ic"><Icon name="alert" size={14} /></span>
                    <span>มี <b>{stats.overdue}</b> รายการเกินกำหนดส่ง{(() => { const f = eng.items.find(isOverdue); return f ? ` — ${f.description}` : ""; })()} · คลิกเพื่อดู</span>
                  </div>
                )}
                {(() => {
                  const ids = Object.keys(unreadC);
                  if (!ids.length) return null;
                  const total = ids.reduce((n, id) => n + (unreadC[id] || 0), 0);
                  const first = eng.items.find((it) => unreadC[it.id]);
                  return (
                    <div className="nv-alert cmt" onClick={() => first && openItemDrawer(first.id)}>
                      <span className="ic"><Icon name="chat" size={14} /></span>
                      <span>มี <b>{total}</b> ความคิดเห็นใหม่จากลูกค้า{first ? ` — ${first.description}` : ""} · คลิกเพื่ออ่าน</span>
                    </div>
                  );
                })()}
                <MultiFilter label="สถานะ" placeholder={`ทุกสถานะ · ${stats.total}`} selected={statusSel} onChange={setStatusSel}
                  options={[
                    ...STATUS_ORDER.map((s) => ({ value: s, label: STATUS[s].label, count: stats.by[s], dot: STATUS_DOT[s] })),
                    { value: "overdue", label: "Overdue", count: stats.overdue, dot: "#EF4444" },
                  ]} />
                {detailCats.length > 0 && (
                  <MultiFilter label="หมวดเอกสาร" placeholder={`ทุกหมวด · ${stats.total}`} selected={catSel} onChange={setCatSel}
                    options={detailCats.map((c) => ({ value: c.cat, label: c.cat, count: c.count }))} />
                )}
              </aside>

              {/* RIGHT: toolbar + document list */}
              <div>
                <div className="nv-tools">
                  <NvMenu label="+ เพิ่มรายการ" variant="mint">
                    <button className="nv-mitem" onClick={() => openGenerate()}>✓ สร้างรายการคำขอ</button>
                    <button className="nv-mitem" onClick={() => setModal("add")}>＋ เพิ่มรายการเดี่ยว</button>
                    <button className="nv-mitem" onClick={() => importRef.current?.click()}>↓ นำเข้าจาก Excel</button>
                  </NvMenu>
                  <NvMenu label={<><Icon name="users" size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />แชร์กับลูกค้า</>} variant="light">
                    <button className="nv-mitem" onClick={() => {
                      const link = `${location.origin}/client.html?e=${eng.id}`;
                      navigator.clipboard?.writeText(link).catch(() => {});
                      alert("คัดลอกลิงก์สำหรับลูกค้าแล้ว (ส่งรหัส 16 หลักแยกช่องทาง):\n\n" + link);
                    }}><Icon name="link" size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} />คัดลอกลิงก์ลูกค้า</button>
                    <button className="nv-mitem" onClick={notifyClient}><Icon name="mail" size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} />แจ้งลูกค้า</button>
                  </NvMenu>
                  <button className="nv-btn" onClick={() => setModal("zip")}>↓ โหลดไฟล์ (.zip)</button>
                  {busy && <span className="nv-search-note">กำลังบันทึก…</span>}
                  <div style={{ marginLeft: "auto" }}>
                    <NvMenu label="เพิ่มเติม" variant="dark" align="right">
                      <button className="nv-mitem" onClick={() => openGenerate(buildRollSource(eng))}><Icon name="repeat" size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} />สร้างพอร์ทัลปีถัดไป</button>
                      <button className="nv-mitem" onClick={exportCSV}><Icon name="doc" size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} />Export CSV</button>
                      {(eng.myRole === "owner" || eng.myCanDelete) && <button className="nv-mitem" onClick={() => setModal("archived")}><Icon name="archive" size={14} style={{ verticalAlign: "-2px", marginRight: 7 }} />Archived</button>}
                      <div className="nv-msep" />
                      {eng.myRole === "owner" && <button className="nv-mitem" onClick={() => setModal("share")}>＋ เชิญสมาชิก / แชร์</button>}
                      <button className="nv-mitem" onClick={() => setModal("settings")}>⚙ ตั้งค่าพอร์ทัล</button>
                    </NvMenu>
                  </div>
                  <input ref={importRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files[0]; if (f) handleImportFile(f); e.target.value = ""; }} />
                </div>

                {viewGroups.length === 0 ? (
                  <div className="nv-list"><div style={{ padding: "32px 16px", textAlign: "center", color: "#64748B", fontSize: 13 }}>ไม่พบรายการที่ตรงกับตัวกรอง</div></div>
                ) : viewGroups.map(([cat, items]) => (
                  <div key={cat}>
                    <div className="nv-ghead"><span className="gt">{cat}</span><span className="gline" /><span className="gn">{items.filter((i) => i.status === "accepted").length}/{items.length}</span></div>
                    <div className="nv-list">
                      {items.map((it, idx) => {
                        const od = isOverdue(it);
                        const rowCls = it.status === "accepted" ? "acc" : od ? "od" : "";
                        const stTone = od ? "red" : STATUS_ST[it.status];
                        const stLabel = od ? "⚠ Overdue" : `${STATUS[it.status].glyph} ${STATUS[it.status].label}`;
                        return (
                          <button key={it.id} className={`nv-doc ${rowCls}`} onClick={() => openItemDrawer(it.id)}>
                            <span className="nv-doc-no">{String(idx + 1).padStart(2, "0")}</span>
                            <div className="nv-doc-main">
                              <div className="nv-doc-name">{it.description}{it.required && <span className="req" title="Required">•</span>}</div>
                              <div className="nv-doc-sub">
                                {it.files.length > 0 && <span className="f">{it.files.length} file{it.files.length > 1 ? "s" : ""}</span>}
                                {it.commentCount > 0 && <span className="cmt"><Icon name="chat" size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} />{it.commentCount}</span>}
                                {it.firmNote && <span className="note" title={it.firmNote}>โน้ต</span>}
                                <span className={`due ${od ? "od" : ""}`}>Due {fmtDate(it.dueDate)}</span>
                              </div>
                            </div>
                            <span className={`nv-st ${stTone}`}>{stLabel}</span>
                            <span className="nv-doc-chev">›</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <p className="nv-foot">Firm workspace · {eng.items.length} items · backed by Supabase (RLS-scoped)</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Item drawer */}
      {drawerItem && (
        <Drawer key={drawerItem.id} item={drawerItem} role="firm" busy={busy} onClose={() => setOpenItem(null)}
          onSetStatus={setStatus} onDelete={deleteItem} onDownload={downloadFile} onSaveNote={saveItemNote}
          onPreviewUrl={(f) => firmApi.signedDownloadUrl(f.storagePath, { inline: true, contentType: f.type })}
          onListComments={(itemId) => firmApi.listComments(itemId)}
          onAddComment={(itemId, body) => firmApi.addComment(itemId, eng.id, body)}
          onUpdateItem={updateItem} onReturn={returnItem}
          onUploadSample={uploadSample} onRemoveSample={removeSample}
          canDelete={eng.myRole === "owner" || eng.myCanDelete} />
      )}

      {/* Modals */}
      {modal === "generate" && <GenerateModal busy={busy} source={rollSource} onClose={() => { setModal(null); setRollSource(null); }} onCreate={generateEngagement} />}
      {modal === "groups" && <ClientGroupsModal onClose={() => setModal(null)} onChanged={loadDashboard} />}
      {modal === "add" && eng && <AddItemModal eng={eng} onClose={() => setModal(null)} onAdd={addItem} />}
      {modal === "import" && importDraft && (
        <ImportModal draft={importDraft} onClose={() => { setModal(null); setImportDraft(null); }} onImport={importEngagement} />
      )}
      {modal === "settings" && eng && (
        <PortalSettingsModal eng={eng} onClose={() => setModal(null)}
          onSavePasscode={(code) => setEngPasscode(eng.id, code)}
          onSaveRetention={(days, autoDelete) => setEngRetention(eng.id, days, autoDelete)}
          onSaveClientEmail={(email) => run(() => firmApi.setClientEmail(eng.id, email), reloadDetail)}
          onDelete={() => deleteEng(eng.id)} />
      )}
      {modal === "notify" && eng && (
        <NotifyModal eng={eng} busy={busy} onClose={() => setModal(null)} onSend={sendNotify} />
      )}
      {modal === "zip" && eng && (
        <ZipModal eng={eng} busy={busy} onClose={() => setModal(null)} onDownload={downloadZip} />
      )}
      {modal === "share" && eng && (
        <ShareModal eng={eng} onClose={() => setModal(null)} />
      )}
      {modal === "archived" && eng && (
        <ArchivedModal eng={eng} canManage={eng.myRole === "owner" || eng.myCanDelete}
          onClose={() => setModal(null)} onChanged={reloadDetail} />
      )}
    </div>
  );
}

/* ---------- Auth surfaces ---------------------------------------------- */
function AuthBrandPanel() {
  return (
    <div className="nv-authL">
      <span className="c1" /><span className="c2" />
      <div className="inner">
        <div className="logo"><span className="mk"><Tick size={24} /></span>Tickmark</div>
        <span className="pill">PBC Portal · Firm</span>
        <h2>พื้นที่ทำงานของสำนักงาน</h2>
        <p className="lead">จัดการพอร์ทัลลูกค้า คำขอเอกสาร และติดตามสถานะการส่งของงานตรวจสอบบัญชี</p>
        <ul>
          <li><i>▦</i>พอร์ทัลลูกค้าทั้งหมด</li>
          <li><i>↑</i>คำขอเอกสารและสถานะการส่ง</li>
          <li><i>♪</i>การแจ้งเตือนและกิจกรรมล่าสุด</li>
        </ul>
        <div className="foot">TICKMARK PBC · FIRM WORKSPACE</div>
      </div>
    </div>
  );
}

function AuthFrame({ children }) {
  return (
    <div className="nv-authpage">
      <div className="nv-authcard">
        <AuthBrandPanel />
        <div className="nv-authR"><div className="form">{children}</div></div>
      </div>
    </div>
  );
}

/* ---------- Firm auth (Supabase Auth: email + password) ---------------- */
function AuthScreen() {
  const [mode, setMode] = useState("signin"); // 'signin' | 'signup'
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firmName, setFirmName] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);

  const ready = mode === "reset"
    ? !!email.trim()
    : email.trim() && password.length >= 6 && (mode === "signin" || firmName.trim());

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setErr(""); setInfo("");
    try {
      if (mode === "reset") {
        await firmApi.requestPasswordReset(email.trim());
        setInfo("ส่งลิงก์รีเซ็ตรหัสผ่านไปที่อีเมลแล้ว — เปิดลิงก์ในอีเมลเพื่อตั้งรหัสใหม่ (เช็ค spam ด้วย)");
      } else if (mode === "signup") {
        const data = await firmApi.signUp({ email: email.trim(), password, firmName: firmName.trim(), fullName: fullName.trim() });
        // If "Confirm email" is on, no session is returned until the user confirms.
        if (!data.session) setInfo("สมัครสำเร็จ — ถ้าเปิด Confirm email ไว้ โปรดยืนยันทางอีเมลก่อน แล้วเข้าสู่ระบบ");
      } else {
        await firmApi.signIn({ email: email.trim(), password });
      }
      // On success, the onAuthStateChange listener in App swaps to the workspace.
    } catch (e) {
      setErr(e.message || "ไม่สำเร็จ");
    } finally { setBusy(false); }
  };

  return (
    <div className="tk-root nv">
      <AuthFrame>
        <div className="kick">{mode === "signin" ? "เข้าสู่ระบบสำนักงาน" : mode === "signup" ? "สมัครสำนักงานใหม่" : "รีเซ็ตรหัสผ่าน"}</div>
        <h1>{mode === "signin" ? "เข้าสู่ระบบ" : mode === "signup" ? "สมัครสำนักงาน" : "ลืมรหัสผ่าน"}</h1>
        <p className="sub">
          {mode === "signin" ? "สำหรับพนักงานสำนักงาน — เห็นเฉพาะงานของสำนักงานคุณ"
            : mode === "signup" ? "สร้างบัญชีสำนักงานของคุณเพื่อเริ่มสร้างพอร์ทัล"
              : "ใส่อีเมลที่ใช้สมัคร เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ให้"}
        </p>

        {mode === "signup" && (
          <>
            <label className="nv-field"><span>ชื่อสำนักงาน (Firm)</span>
              <div className="nv-input"><input value={firmName} onChange={(e) => setFirmName(e.target.value)} placeholder="เช่น Tickmark & Co." /></div></label>
            <label className="nv-field"><span>ชื่อผู้ใช้ (ไม่บังคับ)</span>
              <div className="nv-input"><input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="เช่น Jane CPA" /></div></label>
          </>
        )}
        <label className="nv-field"><span>อีเมล</span>
          <div className="nv-input"><input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@firm.com" /></div></label>
        {mode !== "reset" && (
          <label className="nv-field"><span>รหัสผ่าน (≥ 6 ตัว)</span>
            <div className="nv-input">
              <input type={showPw ? "text" : "password"} autoComplete={mode === "signin" ? "current-password" : "new-password"}
                value={password} onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="••••••••" />
              <button type="button" className="eye" title={showPw ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"} onClick={() => setShowPw((s) => !s)}>{showPw ? "◎" : "◉"}</button>
            </div></label>
        )}

        {mode === "signin" && (
          <div className="nv-authrow">
            <span className="nv-check" onClick={() => setRemember((r) => !r)}>
              <span className={`bx ${remember ? "" : "off"}`}>✓</span>จดจำการเข้าสู่ระบบ
            </span>
            <button type="button" className="nv-authlink" onClick={() => { setMode("reset"); setErr(""); setInfo(""); }}>ลืมรหัสผ่าน?</button>
          </div>
        )}

        {err && <p className="nv-err">{err}</p>}
        {info && <p className="nv-info">{info}</p>}

        <button className="nv-authcta" disabled={!ready || busy} onClick={submit}>
          {busy ? "กำลังดำเนินการ…" : mode === "signin" ? "เข้าสู่ระบบ" : mode === "signup" ? "สมัครและเริ่มใช้งาน" : "ส่งลิงก์รีเซ็ตรหัสผ่าน"}
        </button>

        <div className="nv-authfoot">
          {mode === "reset" ? (
            <button type="button" className="nv-authlink" onClick={() => { setMode("signin"); setErr(""); setInfo(""); }}>← กลับเข้าสู่ระบบ</button>
          ) : (
            <>
              {mode === "signin" ? "ยังไม่มีบัญชี? " : "มีบัญชีแล้ว? "}
              <button type="button" className="nv-authlink" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setErr(""); setInfo(""); }}>
                {mode === "signin" ? "สมัครสำนักงานใหม่" : "เข้าสู่ระบบ"}
              </button>
            </>
          )}
        </div>
        {!SUPABASE_CONFIGURED && <p className="nv-authwarn">⚠ ยังไม่ได้ตั้งค่า backend (.env.local)</p>}
      </AuthFrame>
    </div>
  );
}

/* ---------- Set a new password (password recovery) --------------------- */
function SetNewPasswordScreen({ busy, onSave, onSignOut }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const ok = pw.length >= 6 && pw === pw2;
  return (
    <div className="tk-root tk-auth-root">
      <AuthFrame role="firm">
        <div className="tk-lock">
          <div className="tk-lock-card tk-auth-card tk-auth-firm-card" style={{ textAlign: "left" }}>
            <div className="tk-lock-icon" style={{ textAlign: "center" }}><Icon name="key" size={30} /></div>
            <h2 style={{ textAlign: "center" }}>ตั้งรหัสผ่านใหม่</h2>
            <p className="tk-muted" style={{ textAlign: "center", marginBottom: 18 }}>กรอกรหัสผ่านใหม่สำหรับบัญชีของคุณ</p>
            <label className="tk-field"><span>รหัสผ่านใหม่ (≥ 6 ตัว)</span>
              <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" /></label>
            <label className="tk-field"><span>ยืนยันรหัสผ่านใหม่</span>
              <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ok && onSave(pw)} placeholder="••••••••" /></label>
            {pw2 && pw !== pw2 && <p className="tk-lock-err">รหัสผ่านไม่ตรงกัน</p>}
            <button className="tk-btn primary full" disabled={!ok || busy} onClick={() => onSave(pw)}>
              {busy ? "กำลังบันทึก…" : "บันทึกรหัสผ่านใหม่"}
            </button>
            <button type="button" className="tk-link" style={{ display: "block", margin: "12px auto 0" }} onClick={onSignOut}>ยกเลิก / ออกจากระบบ</button>
          </div>
        </div>
      </AuthFrame>
    </div>
  );
}

/* ---------- Account pending approval ----------------------------------- */
function PendingApprovalScreen({ email, onSignOut }) {
  return (
    <div className="tk-root tk-auth-root">
      <AuthFrame role="firm">
        <div className="tk-lock">
          <div className="tk-lock-card tk-auth-card tk-auth-firm-card">
            <div className="tk-lock-icon"><Icon name="hourglass" size={30} /></div>
            <h2>บัญชีรอการอนุมัติ</h2>
            <p className="tk-muted">
              สมัครสำเร็จแล้ว — บัญชี <b>{email}</b> กำลังรอผู้ดูแลระบบอนุมัติ
              เมื่อได้รับอนุมัติแล้วจึงจะเริ่มสร้างพอร์ทัลได้
            </p>
            <p className="tk-lock-foot">โปรดติดต่อผู้ดูแลระบบ หรือลองเข้าสู่ระบบใหม่อีกครั้งภายหลัง</p>
            <button className="tk-btn full" onClick={onSignOut}>ออกจากระบบ</button>
          </div>
        </div>
      </AuthFrame>
    </div>
  );
}

/* ---------- Firm dashboard: all portals + progress + search + notifs ---- */
export function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "เมื่อสักครู่";
  const m = Math.floor(s / 60); if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} ชม.ที่แล้ว`;
  return `${Math.floor(h / 24)} วันที่แล้ว`;
}
// Icon + colour tone + Thai label for an item_history action (client + firm).
export function notifMeta(action) {
  const a = action || "";
  if (/remove/i.test(a)) return { icon: "trash", tone: "slate", label: "ลบไฟล์ที่อัปไว้" };
  if (/submit/i.test(a)) return { icon: "upload", tone: "info", label: "อัปโหลดเอกสาร" };
  if (/accept/i.test(a)) return { icon: "check", tone: "mint", label: "ตรวจรับ" };
  if (/return/i.test(a)) return { icon: "return", tone: "amber", label: "ส่งกลับแก้ไข" };
  if (/reopen/i.test(a)) return { icon: "reopen", tone: "amber", label: "เปิดใหม่" };
  if (/review/i.test(a)) return { icon: "eye", tone: "info", label: "เริ่มตรวจ" };
  if (/comment/i.test(a)) return { icon: "chat", tone: "info", label: "แสดงความคิดเห็น" };
  if (/note/i.test(a)) return { icon: "note", tone: "amber", label: "เพิ่มโน้ต" };
  if (/renam/i.test(a)) return { icon: "note", tone: "slate", label: "แก้ไขชื่อรายการ" };
  if (/reschedul/i.test(a)) return { icon: "calendar", tone: "amber", label: "แก้ไขกำหนดส่ง" };
  if (/archiv/i.test(a)) return { icon: "archive", tone: "slate", label: "ย้ายไปที่เก็บถาวร" };
  if (/restor/i.test(a)) return { icon: "restore", tone: "info", label: "กู้คืนจากที่เก็บ" };
  if (/request/i.test(a)) return { icon: "plus", tone: "info", label: "เพิ่มรายการ" };
  return { icon: "doc", tone: "slate", label: a };
}
const notifLabel = (a) => notifMeta(a).label;
const notifIcon = (a) => notifMeta(a).icon;

const STORAGE_LIMIT = 10 * 1073741824; // 10 GB — Cloudflare R2 free tier (beyond it: ~$0.015/GB/mo, egress free).

// Navy/mint status accents for the engagement-detail (3e) filter list + chips.
const STATUS_DOT = { outstanding: "#64748B", submitted: "#3B82F6", review: "#F59E0B", accepted: "#12B39A", returned: "#F59E0B", reopened: "#64748B" };
const STATUS_ST  = { outstanding: "slate", submitted: "info", review: "amber", accepted: "mint", returned: "amber", reopened: "slate" };

// A toolbar button that opens a dropdown menu; closes on item click or backdrop.
function NvMenu({ label, variant = "dark", align = "left", children }) {
  const [open, setOpen] = useState(false);
  const cls = variant === "mint" ? "nv-cta" : variant === "light" ? "nv-btn" : "nv-btn dark";
  return (
    <div className="nv-mwrap">
      <button className={cls} onClick={() => setOpen((o) => !o)}>{label} <span style={{ fontSize: 10, opacity: 0.85 }}>▾</span></button>
      {open && (
        <>
          <div className="nv-backdrop" onClick={() => setOpen(false)} />
          <div className={`nv-menu ${align === "right" ? "right" : ""}`} onClick={() => setOpen(false)}>{children}</div>
        </>
      )}
    </div>
  );
}

// Multi-select filter card (status / category) with a clear button in its header.
function MultiFilter({ label, placeholder, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const has = selected.length > 0;
  const summary = !has ? placeholder
    : selected.length === 1 ? (options.find((o) => o.value === selected[0])?.label || "1 รายการ")
      : `เลือก ${selected.length} รายการ`;
  const toggle = (v) => {
    const s = new Set(selected);
    if (s.has(v)) s.delete(v); else s.add(v);
    onChange([...s]);
  };
  return (
    <div className="nv-asf">
      <div className="nv-asf-h">
        <label className="nv-asf-l">{label}</label>
        {has && <button className="nv-asf-clear" onClick={() => onChange([])}>ล้าง ✕</button>}
      </div>
      <div className="nv-msf">
        <button className={`nv-msf-btn ${has ? "on" : ""}`} onClick={() => setOpen((o) => !o)}>
          <span className="nv-msf-val">{summary}</span>
          <span className="nv-msf-cv">▾</span>
        </button>
        {open && (
          <>
            <div className="nv-backdrop" onClick={() => setOpen(false)} />
            <div className="nv-msf-panel">
              {options.map((o) => (
                <button key={o.value} className={`nv-msf-opt ${selected.includes(o.value) ? "on" : ""}`} onClick={() => toggle(o.value)}>
                  <span className="nv-msf-ck">{selected.includes(o.value) ? "✓" : ""}</span>
                  {o.dot && <span className="nv-msf-dot" style={{ background: o.dot }} />}
                  <span className="nv-msf-opt-lb">{o.label}</span>
                  <span className="nv-msf-opt-ct">{o.count}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function KpiCard({ tone, icon, label, num, sub, numTone, subTone }) {
  return (
    <div className="nv-kpi">
      <span className={`nv-kpi-ic ${tone}`}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div className="nv-kpi-label">{label}</div>
        <div className={`nv-kpi-num ${numTone || ""}`}>{num}</div>
        <div className={`nv-kpi-delta ${subTone || ""}`}>{sub}</div>
      </div>
    </div>
  );
}

function FirmDashboard({ dash, notifs, followups, storage, bucketUsage, analytics, session, onOpen, onOpenItem, onNew, onGroups, onMarkAllRead, onSignOut }) {
  const [q, setQ] = useState("");
  const [showNotifs, setShowNotifs] = useState(false);
  const [showLine, setShowLine] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showReminder, setShowReminder] = useState(false);
  const [sortBy, setSortBy] = useState("recent");     // recent | name | progress
  const [viewMode, setViewMode] = useState("grid");   // grid | list
  const [scope, setScope] = useState("all");          // all | group
  const [actFilter, setActFilter] = useState("all");  // activity feed: all | client | firm
  const [statusView, setStatusView] = useState(null); // "overdue" | "soon" | "review" — today-panel drill-in
  const [clientGroups, setClientGroups] = useState([]);
  const [openGroup, setOpenGroup] = useState(null);   // group id whose detail view is showing
  useEffect(() => { firmApi.listClientGroups().then(setClientGroups).catch(() => {}); }, [dash]);
  const hasGroups = clientGroups.length > 0;

  const sortEngs = (arr) => {
    const a = [...arr];
    if (sortBy === "name") a.sort((x, y) => (x.client || "").localeCompare(y.client || ""));
    else if (sortBy === "progress") a.sort((x, y) => (y.pct || 0) - (x.pct || 0));
    else a.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    return a;
  };
  const matchQ = (e) => { const s = q.trim().toLowerCase(); return !s || `${e.client} ${e.template}`.toLowerCase().includes(s); };

  // standalone portals (no group)
  const singles = useMemo(() => sortEngs((dash || []).filter((e) => !e.groupId && matchQ(e))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dash, q, sortBy]);

  // one rolled-up record per group (with its member engagements + aggregates)
  const groupsData = useMemo(() => {
    const byId = new Map();
    (dash || []).forEach((e) => { if (e.groupId) { if (!byId.has(e.groupId)) byId.set(e.groupId, []); byId.get(e.groupId).push(e); } });
    const s = q.trim().toLowerCase();
    const out = [];
    (clientGroups || []).forEach((g) => {
      const nameHit = !s || g.name.toLowerCase().includes(s);
      const members = sortEngs((byId.get(g.id) || []).filter((e) => nameHit || matchQ(e)));
      if (!members.length) return;
      const sum = (f) => members.reduce((n, e) => n + f(e), 0);
      const total = sum((e) => e.total || 0), accepted = sum((e) => e.accepted || 0);
      out.push({
        id: g.id, name: g.name, initials: initialsOf(g.name), members,
        total, accepted, pct: total ? Math.round((accepted / total) * 100) : 0,
        overdue: sum((e) => e.overdue || 0),
        review: sum((e) => (e.by?.submitted || 0) + (e.by?.review || 0)),
        upload: sum((e) => (e.by?.outstanding || 0) + (e.by?.reopened || 0)),
      });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dash, clientGroups, q, sortBy]);

  const groupPortals = groupsData.reduce((n, g) => n + g.members.length, 0);
  const feedCount = scope === "group" ? groupsData.length : groupsData.length + singles.length;
  const detailGroup = openGroup ? groupsData.find((g) => g.id === openGroup) : null;

  const kpi = useMemo(() => {
    const list = dash || [];
    return {
      portals: list.length,
      awaiting: list.reduce((n, e) => n + (e.by?.outstanding || 0) + (e.by?.reopened || 0), 0),
      accepted: list.reduce((n, e) => n + (e.accepted || 0), 0),
      overdue: list.reduce((n, e) => n + (e.overdue || 0), 0),
    };
  }, [dash]);

  const unreadByEng = useMemo(() => {
    const m = {};
    (notifs || []).forEach((n) => { if (n.unread && n.engagementId) m[n.engagementId] = (m[n.engagementId] || 0) + 1; });
    return m;
  }, [notifs]);
  const totalUnread = useMemo(() => (notifs || []).filter((n) => n.unread).length, [notifs]);

  // Follow-up panel: open items grouped into overdue / due-soon / to-review.
  const follow = useMemo(() => {
    const clientOf = (id) => (dash || []).find((e) => e.id === id)?.client || "—";
    const now = Date.now(); const DAY = 86400000; const SOON = 7 * DAY;
    const overdue = [], soon = [], reviewItems = [], reviewBy = new Map();
    (followups || []).forEach((it) => {
      const row = { ...it, client: clientOf(it.engagementId) };
      if (it.status === "submitted") {
        reviewItems.push(row);
        const g = reviewBy.get(it.engagementId) || { engagementId: it.engagementId, client: row.client, count: 0 };
        g.count++; reviewBy.set(it.engagementId, g);
      }
      if (it.dueDate == null) return;
      if (it.dueDate < now) overdue.push({ ...row, days: Math.max(1, Math.floor((now - it.dueDate) / DAY)) });
      else if (it.dueDate - now <= SOON) soon.push({ ...row, days: Math.max(1, Math.ceil((it.dueDate - now) / DAY)) });
    });
    overdue.sort((a, b) => b.days - a.days);
    soon.sort((a, b) => a.days - b.days);
    const review = [...reviewBy.values()].sort((a, b) => b.count - a.count);
    const reviewTotal = review.reduce((n, g) => n + g.count, 0);
    return { overdue, soon, review, reviewItems, reviewTotal, empty: !overdue.length && !soon.length && !review.length };
  }, [followups, dash]);

  // Bulk-reminder candidates: per-engagement counts of items the CLIENT still
  // has to upload (status "outstanding"), split by overdue / due-soon, plus the
  // client email so the modal can flag portals with no email on file.
  const reminderCandidates = useMemo(() => {
    const now = Date.now(); const SOON = 7 * 86400000;
    const od = {}, sn = {};
    (followups || []).forEach((it) => {
      if (it.status !== "outstanding" || it.dueDate == null) return;
      if (it.dueDate < now) od[it.engagementId] = (od[it.engagementId] || 0) + 1;
      else if (it.dueDate - now <= SOON) sn[it.engagementId] = (sn[it.engagementId] || 0) + 1;
    });
    return (dash || [])
      .map((e) => ({ id: e.id, client: e.client, clientEmail: e.clientEmail || "",
        outstanding: e.by?.outstanding || 0, overdue: od[e.id] || 0, soon: sn[e.id] || 0 }))
      .filter((c) => c.outstanding > 0);
  }, [dash, followups]);

  const groups = useMemo(() => {
    const byEng = new Map();
    (notifs || []).forEach((n) => {
      let g = byEng.get(n.engagementId);
      if (!g) { g = { engagementId: n.engagementId, client: n.client, items: [], unread: 0, latest: 0 }; byEng.set(n.engagementId, g); }
      g.items.push(n);
      if (n.unread) g.unread++;
      if (n.at > g.latest) g.latest = n.at;
    });
    return [...byEng.values()].sort((a, b) => (b.unread > 0) - (a.unread > 0) || b.latest - a.latest);
  }, [notifs]);

  if (dash === null) return <div className="nv"><div className="tk-boot" style={{ color: "#64748B" }}>กำลังโหลดภาพรวม…</div></div>;

  const email = session?.user?.email || "";
  const initials = (email.slice(0, 2) || "NF").toUpperCase();
  const renderTodayVariant = (variantClass, subtitle) => {
    const uniq = (a) => [...new Set(a)];
    const join = (a) => a.slice(0, 2).join(" · ") + (a.length > 2 ? ` +${a.length - 2}` : "");
    const card = (tone, ic, label, count, names, kind) => (
      <button className={`nv-tc ${tone}`} disabled={!count} aria-label={`${label} ${count}`} onClick={() => count && setStatusView(kind)}>
        <span className="nv-tc-ic"><Icon name={ic} size={16} /></span>
        <div className="nv-tc-main"><div className="nv-tc-t">{label} <b>{count}</b></div><div className="nv-tc-sub">{names.length ? join(names) : "ไม่มี"}</div></div>
        <span className="nv-tc-chev">›</span>
      </button>
    );
    return (
      <div className={`nv-today nv-today-summary ${variantClass}`}>
        <div className="nv-today-head"><div><h3>สิ่งที่ต้องจัดการวันนี้</h3><div className="sub">{subtitle}</div></div></div>
        <div className="nv-today-cards">
          {card("red", "alert", "เกินกำหนด", follow.overdue.length, uniq(follow.overdue.map((x) => x.client)), "overdue")}
          {card("amber", "clock", "ใกล้ครบกำหนด", follow.soon.length, uniq(follow.soon.map((x) => x.client)), "soon")}
          {card("mint", "inbox", "รอตรวจ", follow.reviewTotal, uniq(follow.reviewItems.map((x) => x.client)), "review")}
        </div>
      </div>
    );
  };

  return (
    <div className="nv">
      {/* navy top bar */}
      <div className="nv-top">
        <div className="nv-brand"><span className="mk"><Tick size={17} /></span><span className="wd">Tickmark</span><span className="nv-pill">PBC Portal · Firm</span></div>
        <div className="nv-search"><span>⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาลูกค้า / engagement…" /></div>
        <div className="nv-top-right">
          <button className="nv-tbtn" onClick={() => setShowAnalytics(true)}><Icon name="chart" size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />Analytics</button>
          <button className="nv-tbtn" onClick={() => setShowLine(true)}><Icon name="line" size={15} style={{ verticalAlign: "-3px", marginRight: 6 }} />LINE</button>
          <div style={{ position: "relative" }}>
            <span className="nv-icon" onClick={() => setShowNotifs((s) => !s)}><Icon name="bell" size={18} />{totalUnread > 0 && <span className="nv-cbadge">{totalUnread}</span>}</span>
            {showNotifs && (
              <div className="tk-notif-panel">
                <div className="tk-notif-head">
                  <span>การแจ้งเตือนล่าสุด</span>
                  {totalUnread > 0 && <button className="tk-link" onClick={onMarkAllRead}>อ่านทั้งหมด</button>}
                </div>
                {groups.length === 0 ? (
                  <p className="tk-muted" style={{ padding: "12px 14px", margin: 0 }}>ยังไม่มีการแจ้งเตือน</p>
                ) : (
                  <ul className="tk-notif-list">
                    {groups.map((g) => (
                      <li key={g.engagementId} className={`tk-notif-group ${g.unread ? "unread" : ""}`}
                        onClick={() => { setShowNotifs(false); onOpen(g.engagementId); }}>
                        <div className="tk-notif-grp-head">
                          <b>{g.client}</b>
                          {g.unread > 0 && <span className="tk-notif-count">{g.unread} ใหม่</span>}
                          <em>{timeAgo(g.latest)}</em>
                        </div>
                        <ul className="tk-notif-sub">
                          {g.items.slice(0, 3).map((n) => (
                            <li key={n.id} className={n.unread ? "unread" : ""}>
                              <span><Icon name={notifIcon(n.action)} size={14} /></span>
                              <span>{notifLabel(n.action)} · <i>{n.itemDescription}</i></span>
                            </li>
                          ))}
                          {g.items.length > 3 && <li className="tk-notif-more">+ อีก {g.items.length - 3} รายการ</li>}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          <button className="nv-tbtn" onClick={onSignOut}>ออกจากระบบ</button>
          <span className="nv-avatar" title={email}>{initials}</span>
        </div>
      </div>

      {showLine && <LineModal onClose={() => setShowLine(false)} />}
      {showAnalytics && (
        <Modal title="📊 สถิติภาพรวม" onClose={() => setShowAnalytics(false)} wide>
          <Analytics initialData={analytics} engagements={dash || []} fetchAnalytics={(id) => firmApi.getAnalytics(id)} />
        </Modal>
      )}
      {showReminder && <ReminderModal candidates={reminderCandidates} onClose={() => setShowReminder(false)} />}
      {statusView && (
        <StatusListModal
          kind={statusView}
          items={statusView === "overdue" ? follow.overdue : statusView === "soon" ? follow.soon : follow.reviewItems}
          onClose={() => setStatusView(null)}
          onOpenItem={(engId, itemId) => { setStatusView(null); onOpenItem(engId, itemId); }} />
      )}

      <div className="nv-page">
        <div className="nv-phead">
          <div>
            <h2>Engagements</h2>
            <div className="sub">ภาพรวมพอร์ทัล คำขอเอกสาร และสถานะล่าสุดของลูกค้า{q && ` · พบ ${feedCount} จาก ${dash.length}`}</div>
          </div>
          <div className="nv-phead-actions">
            <button className="nv-btn" onClick={onGroups}><Icon name="users" size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />กลุ่มลูกค้า</button>
            <button className="nv-btn nv-reminder-btn" disabled={reminderCandidates.length === 0}
              title={reminderCandidates.length ? `ส่ง Reminder ${reminderCandidates.length} รายการ` : "ไม่มีรายการที่ต้องส่ง Reminder"}
              onClick={() => setShowReminder(true)}><Icon name="send" size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />ส่ง Reminder{reminderCandidates.length > 0 && <span className="nv-reminder-count">{reminderCandidates.length}</span>}</button>
            <button className="nv-cta" onClick={onNew}>+ สร้างพอร์ทัลใหม่</button>
          </div>
        </div>

        {renderTodayVariant("nv-today-live-c", "ติดตามรายการสำคัญในวันนี้")}

        {dash.length === 0 ? (
          <div className="nv-empty">
            <Tick size={40} />
            <h3>ยังไม่มีพอร์ทัล</h3>
            <p>สร้างพอร์ทัลแรกจาก template เพื่อเริ่มงาน</p>
            <button className="nv-cta" style={{ marginTop: 12 }} onClick={onNew}>+ สร้างพอร์ทัลใหม่</button>
          </div>
        ) : (
          <div className="nv-cols">
            <div>
              {openGroup && detailGroup ? (
                <GroupDetail g={detailGroup} unreadByEng={unreadByEng} onBack={() => setOpenGroup(null)} onOpen={onOpen} />
              ) : (
                <>
                  <div className="nv-colhead">
                    <span className="t">Engagement ที่กำลังดำเนินการ <span>· {feedCount}</span></span>
                    <div className="nv-colhead-r">
                      {hasGroups && (
                        <div className="nv-seg">
                          <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>ทั้งหมด</button>
                          <button className={scope === "group" ? "on" : ""} onClick={() => setScope("group")}>เฉพาะกลุ่ม</button>
                        </div>
                      )}
                      <label className="nv-sortsel-w">จัดเรียง:
                        <select className="nv-sortsel" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                          <option value="recent">ล่าสุด</option>
                          <option value="name">ชื่อลูกค้า</option>
                          <option value="progress">ความคืบหน้า</option>
                        </select>
                      </label>
                      <div className="nv-vtoggle">
                        <button className={viewMode === "grid" ? "on" : ""} title="ตาราง" onClick={() => setViewMode("grid")}>▦</button>
                        <button className={viewMode === "list" ? "on" : ""} title="รายการ" onClick={() => setViewMode("list")}>☰</button>
                      </div>
                    </div>
                  </div>
                  {feedCount === 0 ? (
                    <p className="tk-none" style={{ color: "#64748B" }}>{scope === "group" ? "ยังไม่มีพอร์ทัลในกลุ่ม" : `ไม่พบพอร์ทัลที่ตรงกับ “${q}”`}</p>
                  ) : (
                    <>
                      <div className={`nv-eng-grid ${viewMode === "list" ? "list" : ""}`}>
                        {groupsData.map((g) => (
                          <GroupCard key={g.id} g={g} onOpen={() => setOpenGroup(g.id)} />
                        ))}
                        {scope !== "group" && singles.map((e) => (
                          <EngagementCard key={e.id} e={e} unread={unreadByEng[e.id] || 0} onOpen={() => onOpen(e.id)} />
                        ))}
                      </div>
                      <p className="nv-grid-foot">
                        {scope === "group" ? `แสดง ${groupsData.length} กลุ่ม · ${groupPortals} พอร์ทัล` : `แสดง ${feedCount} รายการ`}
                      </p>
                    </>
                  )}
                </>
              )}
            </div>
            <div className="nv-rail">
              {storage != null && (() => {
                const bkt = bucketUsage?.bytes;                       // whole shared bucket (null if unavailable)
                const total = bkt != null ? bkt : storage;           // what counts toward the 10 GB quota
                const pct = Math.min(100, Math.round((total / STORAGE_LIMIT) * 100));
                const tone = pct >= 90 ? "over" : pct >= 70 ? "soon" : "";
                const minePct = Math.max(0, Math.min(100, (storage / STORAGE_LIMIT) * 100));
                const otherPct = Math.max(0, Math.min(100 - minePct, (total - storage) / STORAGE_LIMIT * 100));
                return (
                  <div className="nv-panel nv-store-c">
                    <div className="nv-store-c-top">
                      <span className="ic">◱</span>
                      <span className="t">พื้นที่จัดเก็บ · R2</span>
                      <span className={`p ${tone}`}>{pct}%</span>
                    </div>
                    <div className={`nv-bar nv-bar2 ${tone === "over" ? "red" : tone === "soon" ? "amber" : ""}`}>
                      <span className="mine" style={{ width: `${minePct}%` }} />
                      {bkt != null && <span className="other" style={{ width: `${otherPct}%` }} />}
                    </div>
                    <div className="nv-store-c-sub">
                      ของคุณ <b>{fmtSize(storage)}</b>
                      {bkt != null && <> · รวมทั้ง firm {fmtSize(bkt)}</>}
                      {" "}/ 10 GB · เหลือ {fmtSize(Math.max(0, STORAGE_LIMIT - total))}
                    </div>
                  </div>
                );
              })()}
              <div className="nv-panel" id="nv-followup">
                <div className="nv-panel-head"><span className="t">กิจกรรมล่าสุด</span>{totalUnread > 0 && <span className="more" onClick={onMarkAllRead}>อ่านทั้งหมด</span>}</div>
                <div className="nv-seg sm" style={{ marginBottom: 12 }}>
                  <button className={actFilter === "all" ? "on" : ""} onClick={() => setActFilter("all")}>ทั้งหมด</button>
                  <button className={actFilter === "client" ? "on" : ""} onClick={() => setActFilter("client")}>ลูกค้า</button>
                  <button className={actFilter === "firm" ? "on" : ""} onClick={() => setActFilter("firm")}>สำนักงาน</button>
                </div>
                {(() => {
                  const feed = (notifs || []).filter((n) => actFilter === "all" ? true : actFilter === "client" ? n.by === "Client" : n.by === "Firm");
                  if (feed.length === 0) return <p className="tk-muted" style={{ margin: 0, color: "#64748B" }}>{actFilter === "client" ? "ยังไม่มีกิจกรรมจากลูกค้า" : actFilter === "firm" ? "ยังไม่มีกิจกรรมจากสำนักงาน" : "ยังไม่มีกิจกรรม"}</p>;
                  return (
                    <ul className="nv-act-list">
                      {feed.slice(0, 8).map((n) => {
                        const m = notifMeta(n.action);
                        return (
                          <li key={n.id} className={`nv-act ${n.by === "Client" ? "cli" : "firm"}`} onClick={() => onOpen(n.engagementId)}>
                            <span className={`nv-act-ic ${m.tone}`}><Icon name={m.icon} size={15} /></span>
                            <div className="nv-act-body">
                              <div className="tx"><b>{n.client}</b> {n.actor && <>· {n.actor} </>}{m.label}{n.itemDescription && <span style={{ color: "#64748B" }}> · {n.itemDescription}</span>}</div>
                              <div className="ts"><span className="side">{n.by === "Client" ? "ลูกค้า" : "สำนักงาน"}</span> · {timeAgo(n.at)}</div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        <footer className="nv-pagefoot">
          © 2025 Tickmark, Inc. All rights reserved. <span>·</span> นโยบายความเป็นส่วนตัว <span>·</span> ข้อกำหนดการให้บริการ <span>·</span> ศูนย์ช่วยเหลือ
        </footer>
      </div>
    </div>
  );
}

function groupChips(g) {
  const tags = [];
  if (g.overdue > 0) tags.push({ tone: "red", txt: `⚠ เกินกำหนด ${g.overdue}` });
  if (g.review > 0) tags.push({ tone: "amber", txt: `รอตรวจ ${g.review}` });
  if (g.accepted > 0) tags.push({ tone: "mint", txt: `ตรวจรับ ${g.accepted}` });
  if (g.upload > 0) tags.push({ tone: "slate", txt: `รออัปโหลด ${g.upload}` });
  return tags;
}

// Group card (2a) — same footprint as an EngagementCard, with a purple accent
// (top ribbon + purple border + progress bar). Clicking it opens the detail.
function GroupCard({ g, onOpen }) {
  const [copied, setCopied] = useState(false);
  const chips = groupChips(g);

  const handleCopyLink = async (e) => {
    e.stopPropagation();
    const url = new URL(window.location);
    url.pathname = '/client.html';
    url.search = `?g=${g.id}`;
    const result = await copyToClipboard(url.toString());
    if (result) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className="nv-card nv-cardg"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="nv-gc-top">
        <div className="nv-gc-id">
          <span className="nv-gc-av">{g.initials}</span>
          <div style={{ minWidth: 0 }}>
            <div className="nv-gc-nl"><span className="nv-gc-name">{g.name}</span><span className="nv-gc-badge">GROUP</span></div>
            <div className="nv-gc-sub">{g.members.length} พอร์ทัล · ตรวจรับ {g.accepted}/{g.total}</div>
          </div>
        </div>
        <div className="nv-card-pct"><b>{g.pct}</b><i>%</i></div>
      </div>
      <div className="nv-bar"><span style={{ width: `${Math.max(3, g.pct)}%` }} /></div>
      <div className="nv-tags">
        {chips.length ? chips.map((t, i) => <span key={i} className={`nv-tag2 ${t.tone}`}>{t.txt}</span>)
          : <span className="nv-tag2 slate">ยังไม่มีรายการ</span>}
      </div>
      <div className="nv-card-foot nv-group-card-foot">
        <span className="nv-group-copy-icon">
          <button
            className="nv-copy-link nv-group-copy-button"
            title={copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์กลุ่ม"}
            aria-label={copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์กลุ่ม"}
            onClick={handleCopyLink}
            style={{ color: copied ? "#12B39A" : undefined }}
          >
            <Icon name="link" size={16} />
          </button>
        </span>
        <span className="open nv-group-open">เปิดกลุ่ม <span aria-hidden="true">→</span></span>
      </div>
    </div>
  );
}

// Group detail: a purple header card (rolled-up stats) + the member portals.
function GroupDetail({ g, unreadByEng, onBack, onOpen }) {
  return (
    <>
      <button className="nv-gd-back" onClick={onBack}>← กลับไปทั้งหมด</button>
      <div className="nv-gd">
        <div className="nv-gd-hd">
          <span className="nv-gd-av">{g.initials}</span>
          <div style={{ minWidth: 0 }}>
            <div className="nv-gc-nl"><span className="nv-gd-name">{g.name}</span><span className="nv-gc-badge">GROUP</span></div>
            <div className="nv-gc-sub">{g.members.length} พอร์ทัลในกลุ่ม · ตรวจรับ {g.accepted}/{g.total}</div>
          </div>
          <div className="nv-gd-pct"><b>{g.pct}%</b><span>ความคืบหน้ารวม</span></div>
        </div>
        <div className="nv-gd-bar"><span style={{ width: `${Math.max(3, g.pct)}%` }} /></div>
        <div className="nv-gd-stats">
          <div className="nv-gd-stat"><b style={{ color: "#EF4444" }}>{g.overdue}</b><span>เกินกำหนด</span></div>
          <div className="nv-gd-stat"><b style={{ color: "#b9821f" }}>{g.review}</b><span>รอตรวจ</span></div>
          <div className="nv-gd-stat"><b style={{ color: "#0F172A" }}>{g.upload}</b><span>รออัปโหลด</span></div>
        </div>
      </div>
      <div className="nv-gd-sec">พอร์ทัลในกลุ่มนี้ <span>· {g.members.length}</span></div>
      <div className="nv-eng-grid">
        {g.members.map((e) => (
          <EngagementCard key={e.id} e={e} unread={unreadByEng[e.id] || 0} onOpen={() => onOpen(e.id)} />
        ))}
      </div>
    </>
  );
}

function EngagementCard({ e, onOpen, unread, groupName }) {
  const [copied, setCopied] = useState(false);
  const x = engExpiry(e);
  const tags = [];
  if (e.overdue > 0) tags.push({ tone: "red", txt: `⚠ เกินกำหนด ${e.overdue}` });
  const rev = (e.by?.review || 0) + (e.by?.submitted || 0);
  if (rev > 0) tags.push({ tone: "amber", txt: `รอตรวจ ${rev}` });
  if (e.accepted > 0) tags.push({ tone: "mint", txt: `ตรวจรับ ${e.accepted}` });
  const awaiting = (e.by?.outstanding || 0) + (e.by?.reopened || 0);
  if (awaiting > 0) tags.push({ tone: "slate", txt: `รออัปโหลด ${awaiting}` });
  const done = e.pct >= 100 && e.total > 0;

  const handleCopyLink = async (evt) => {
    evt.stopPropagation();
    const url = new URL(window.location);
    url.pathname = '/client.html';
    url.search = `?e=${e.id}`;
    const result = await copyToClipboard(url.toString());
    if (result) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      className="nv-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {(unread > 0 || e.overdue > 0) && <span className="nv-card-bang" title={unread > 0 ? `${unread} การแจ้งเตือนใหม่` : "มีรายการเกินกำหนด"}>!</span>}
      <div>
        <div className="nv-card-top">
          <div style={{ minWidth: 0 }}>
            <div className="nv-card-type">{e.template}{groupName && <span style={{ marginLeft: 6, color: "#123563", textTransform: "none", letterSpacing: 0 }}>· 👥 {groupName}</span>}</div>
            <div className="nv-card-name">{e.client}{e.myRole && <span className={`nv-role ${e.myRole === "owner" ? "own" : "mem"}`}>{e.myRole === "owner" ? "เจ้าของ" : "สมาชิก"}</span>}</div>
          </div>
          <div className={`nv-card-pct ${done ? "done" : ""}`}><b>{e.pct}</b><i>%</i></div>
        </div>
        <div className="nv-card-sub">งวดสิ้นสุด {fmtDate(e.periodEnd)}{x.state !== "none" && ` · ${x.state === "expired" ? "หมดอายุ" : `เหลือ ${x.daysLeft} วัน`}`}</div>
      </div>
      <div className="nv-bar"><span style={{ width: `${e.pct}%` }} /></div>
      <div className="nv-tags">
        {tags.length ? tags.map((t, i) => <span key={i} className={`nv-tag2 ${t.tone}`}>{t.txt}</span>)
          : done ? <span className="nv-tag2 mint">✓ ตรวจรับครบทุกรายการ</span> : <span className="nv-tag2 slate">ยังไม่มีรายการ</span>}
      </div>
      <div className="nv-card-foot nv-portal-card-foot">
        <button
          className="nv-copy-link nv-portal-icon-action"
          title={copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์พอร์ทัล"}
          aria-label={copied ? "คัดลอกแล้ว" : "คัดลอกลิงก์พอร์ทัล"}
          onClick={handleCopyLink}
          style={{ color: copied ? "#12B39A" : undefined }}
        >
          <Icon name="link" size={16} />
        </button>
        <span className="nv-portal-open">เปิดพอร์ทัล <span aria-hidden="true">→</span></span>
        <span className="nv-portal-more" aria-hidden="true">⋯</span>
      </div>
    </div>
  );
}

/* ---------- Pieces ------------------------------------------------------ */
function Tick({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="tk-glyph">
      <path d="M3 13.5l5.2 5.5L21 4.5" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Pill({ status }) {
  const s = STATUS[status];
  return <span className={`tk-pill ${s.tone}`}><span className="g">{s.glyph}</span>{s.label}</span>;
}

function Chip({ label, n, tone, glyph, active, onClick }) {
  return (
    <button className={`tk-chip ${tone} ${active ? "active" : ""}`} onClick={onClick}>
      {glyph && <span className="g">{glyph}</span>}{label}<b>{n}</b>
    </button>
  );
}

function Empty({ onGenerate }) {
  return (
    <div className="tk-empty">
      <Tick size={40} />
      <h2>No engagements yet</h2>
      <p>Generate a request list from a template to get started.</p>
      <button className="tk-btn primary" onClick={onGenerate}>Generate request list</button>
    </div>
  );
}

/* ---------- Passcode gate ---------------------------------------------- */
function PasscodeInput({ value, onChange, autoFocus, onEnter }) {
  return (
    <input
      className="tk-code-input"
      inputMode="numeric"
      autoComplete="off"
      autoFocus={autoFocus}
      value={groupDigits(value)}
      placeholder="0000 0000 0000 0000"
      onKeyDown={(e) => { if (e.key === "Enter" && onEnter) onEnter(); }}
      onChange={(e) => onChange(onlyDigits(e.target.value))}
    />
  );
}

function LockScreen({ eng, role, onUnlock, onSetPasscode }) {
  const needsSetup = !eng.passcodeHash;
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (code.length !== 16 || busy) return;
    setBusy(true); setErr("");
    try {
      if (needsSetup) { await onSetPasscode(code); return; }
      const h = await hashCode(code);
      if (h === eng.passcodeHash) onUnlock();
      else { setErr("รหัสไม่ถูกต้อง — กรุณาลองใหม่อีกครั้ง"); setCode(""); }
    } finally { setBusy(false); }
  };

  // Portal has no code yet and the viewer is the client → nothing to enter.
  if (needsSetup && role === "client") {
    return (
      <div className="tk-lock">
        <div className="tk-lock-card">
          <div className="tk-lock-icon"><Icon name="lock" size={30} /></div>
          <h2>พอร์ทัลนี้ยังไม่ได้ตั้งรหัส</h2>
          <p className="tk-muted">โปรดติดต่อทางสำนักงาน (Firm) เพื่อให้ตั้งรหัสเข้าพอร์ทัลก่อนใช้งาน</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tk-lock">
      <div className="tk-lock-card">
        <div className="tk-lock-icon"><Icon name="lock" size={30} /></div>
        <p className="tk-lock-eyebrow">{eng.template}</p>
        <h2>{eng.client}</h2>
        <p className="tk-muted">
          {needsSetup ? "ตั้งรหัส 16 หลักเพื่อป้องกันพอร์ทัลนี้" : "กรอกรหัส 16 หลักเพื่อเข้าพอร์ทัลนี้"}
        </p>
        <PasscodeInput value={code} onChange={(v) => { setCode(v); setErr(""); }} autoFocus onEnter={submit} />
        {needsSetup && role === "firm" && (
          <button type="button" className="tk-link" onClick={() => setCode(genCode())}>สุ่มรหัสให้</button>
        )}
        {err && <p className="tk-lock-err">{err}</p>}
        <button className="tk-btn primary full" disabled={code.length !== 16 || busy} onClick={submit}>
          {busy ? "กำลังตรวจสอบ…" : needsSetup ? "ตั้งรหัสและเข้าใช้งาน" : "ปลดล็อกเข้าพอร์ทัล"}
        </button>
        {eng.isDemo && !needsSetup && (
          <p className="tk-lock-demo">โหมดสาธิต · รหัสตัวอย่าง <b>1234 1234 1234 1234</b></p>
        )}
        <p className="tk-lock-foot">ปลดล็อกเฉพาะเซสชันนี้ · รีเฟรชหน้าแล้วต้องกรอกรหัสใหม่</p>
      </div>
    </div>
  );
}

function ExpiredScreen({ eng, role, onExtend, onDelete }) {
  return (
    <div className="tk-lock">
      <div className="tk-lock-card">
        <div className="tk-lock-icon">⏳</div>
        <p className="tk-lock-eyebrow">{eng.template}</p>
        <h2>{eng.client}</h2>
        <p className="tk-muted">พอร์ทัลนี้หมดอายุแล้วเมื่อ {fmtDate(eng.expiresAt)}</p>
        {role === "firm" ? (
          <>
            <p className="tk-expired-hint">ขยายเวลาเพื่อเปิดใช้งานต่อ หรือลบพอร์ทัลนี้ทิ้งเพื่อลดพื้นที่จัดเก็บ</p>
            <div className="tk-expired-actions">
              <button className="tk-btn" onClick={() => onExtend(30)}>+30 วัน</button>
              <button className="tk-btn" onClick={() => onExtend(60)}>+60 วัน</button>
              <button className="tk-btn" onClick={() => onExtend(90)}>+90 วัน</button>
            </div>
            {eng.myRole === "owner" && (
              <button className="tk-btn danger full"
                onClick={() => { if (confirm("ลบพอร์ทัลนี้และเอกสารทั้งหมดอย่างถาวร?")) onDelete(); }}>
                ลบพอร์ทัลนี้ถาวร
              </button>
            )}
          </>
        ) : (
          <p className="tk-muted">โปรดติดต่อทางสำนักงาน (Firm) หากยังต้องการส่งเอกสารเพิ่มเติม</p>
        )}
      </div>
    </div>
  );
}

function PortalSettingsModal({ eng, onClose, onSavePasscode, onSaveRetention, onSaveClientEmail, onDelete }) {
  const base = eng.createdAt || Date.now();
  const currentDays = eng.expiresAt ? Math.round((eng.expiresAt - base) / DAY) : null;
  const matched = RETENTION_OPTIONS.find((o) => o.days === currentDays);
  const [days, setDays] = useState(matched ? matched.days : null);
  const [autoDelete, setAutoDelete] = useState(!!eng.autoDelete);
  const [showPass, setShowPass] = useState(false);
  const [code, setCode] = useState("");
  const [clientEmail, setClientEmail] = useState(eng.clientEmail || "");
  const x = engExpiry(eng);

  return (
    <Modal title="ตั้งค่าพอร์ทัล" onClose={onClose}>
      <p className="tk-block-h">อายุพอร์ทัล (retention)</p>
      <p className="tk-tplblurb" style={{ marginTop: 0 }}>
        {x.state === "none"
          ? "พอร์ทัลนี้ไม่มีกำหนดหมดอายุ"
          : `ปัจจุบันหมดอายุ ${fmtDate(eng.expiresAt)} · เหลือ ${x.daysLeft} วัน`}
      </p>
      <div className="tk-field-row">
        <label className="tk-field"><span>กำหนดอายุ (นับจากวันสร้าง)</span>
          <select value={String(days)} onChange={(e) => setDays(e.target.value === "null" ? null : Number(e.target.value))}>
            {RETENTION_OPTIONS.map((o) => <option key={String(o.days)} value={String(o.days)}>{o.label}</option>)}
          </select>
        </label>
        <label className="tk-check"><input type="checkbox" checked={autoDelete} onChange={(e) => setAutoDelete(e.target.checked)} /> ลบอัตโนมัติเมื่อหมดอายุ</label>
      </div>
      <button className="tk-btn primary full" onClick={() => { onSaveRetention(days, autoDelete); onClose(); }}>บันทึกอายุพอร์ทัล</button>

      <div style={{ height: 18 }} />
      <p className="tk-block-h">อีเมลลูกค้า (สำหรับแจ้งเตือน)</p>
      <label className="tk-field">
        <input type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} placeholder="client@company.com" />
      </label>
      <button className="tk-btn full" disabled={clientEmail === (eng.clientEmail || "")}
        onClick={() => { onSaveClientEmail(clientEmail); onClose(); }}>บันทึกอีเมลลูกค้า</button>

      <div style={{ height: 18 }} />
      <p className="tk-block-h">รหัสเข้าพอร์ทัล</p>
      {!showPass ? (
        <button className="tk-btn full" onClick={() => setShowPass(true)}>เปลี่ยนรหัส 16 หลัก</button>
      ) : (
        <>
          <label className="tk-field"><span>รหัสใหม่ (16 หลัก)</span>
            <PasscodeInput value={code} onChange={setCode} autoFocus onEnter={() => code.length === 16 && (onSavePasscode(code), onClose())} />
            <button type="button" className="tk-link" onClick={() => setCode(genCode())}>สุ่มรหัสให้</button>
          </label>
          <button className="tk-btn primary full" disabled={code.length !== 16} onClick={() => { onSavePasscode(code); onClose(); }}>บันทึกรหัสใหม่</button>
        </>
      )}

      {eng.myRole === "owner" && (
        <>
          <div style={{ height: 18 }} />
          <p className="tk-block-h">ลบพอร์ทัล</p>
          <button className="tk-btn danger full"
            onClick={() => { if (confirm(`ลบพอร์ทัลของ ${eng.client} และเอกสารทั้งหมดอย่างถาวร?`)) onDelete(); }}>
            ลบพอร์ทัลนี้ถาวร
          </button>
        </>
      )}
    </Modal>
  );
}

function Drawer({ item, role, onClose, onUpload, onRemoveFile, onSetStatus, onDelete, onDownload, onPreviewUrl, onListComments, onAddComment, onSaveNote, onUpdateItem, onReturn, onUploadSample, onRemoveSample, canDelete, busy }) {
  const fileRef = useRef(null);
  const sampleRef = useRef(null);
  const clientFiles = item.files.filter((f) => !f.isSample);
  const sampleFiles = item.files.filter((f) => f.isSample);
  const [preview, setPreview] = useState(null); // { file, url } while the viewer is open
  const openPreview = async (f) => {
    setPreview({ file: f, url: null });
    try { setPreview({ file: f, url: await onPreviewUrl(f) }); }
    catch { setPreview(null); }
  };

  // Per-item comment thread — loaded when the drawer opens on an item.
  const [comments, setComments] = useState([]);
  const [loadingC, setLoadingC] = useState(false);
  const [sendingC, setSendingC] = useState(false);
  const [commentErr, setCommentErr] = useState("");
  useEffect(() => {
    if (!onListComments) return;
    let live = true;
    setLoadingC(true);
    onListComments(item.id).then((c) => { if (live) setComments(c); }).catch(() => {}).finally(() => { if (live) setLoadingC(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);
  const sendComment = async (body) => {
    setSendingC(true);
    setCommentErr("");
    try { await onAddComment(item.id, body); setComments(await onListComments(item.id)); }
    catch (e) { setCommentErr(e?.message || "ส่งความคิดเห็นไม่สำเร็จ"); }
    finally { setSendingC(false); }
  };
  const [note, setNote] = useState(item.note || "");
  const [reason, setReason] = useState("");
  const [rejectedSet, setRejectedSet] = useState(() => new Set(item.files.filter((f) => f.rejected).map((f) => f.id)));
  const toggleReject = (id) => setRejectedSet((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const [firmNote, setFirmNote] = useState(item.firmNote || "");
  const [editing, setEditing] = useState(false);
  const [editDesc, setEditDesc] = useState(item.description || "");
  const [editDue, setEditDue] = useState(item.dueDate ? new Date(item.dueDate).toISOString().slice(0, 10) : "");
  const s = STATUS[item.status];
  return (
    <>
      <div className="tk-scrim" onClick={onClose} />
      <aside className="tk-drawer" role="dialog" aria-label="Item detail">
        <div className="tk-drawer-top">
          <div>
            <span className="tk-ref big">{item.ref}</span>
            <Pill status={item.status} />
          </div>
          <button className="tk-icon" onClick={onClose}>✕</button>
        </div>

        {editing && role === "firm" && onUpdateItem ? (
          <div className="tk-block" style={{ marginBottom: 12 }}>
            <p className="tk-block-h">แก้ไขรายการ</p>
            <label className="tk-field"><span>ชื่อรายการ</span>
              <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} /></label>
            <label className="tk-field"><span>กำหนดส่ง (due date)</span>
              <input type="date" value={editDue} onChange={(e) => setEditDue(e.target.value)} /></label>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="tk-btn primary" disabled={busy || !editDesc.trim()}
                onClick={() => { onUpdateItem(item.id, { description: editDesc.trim(), dueDate: editDue ? new Date(editDue).getTime() : null }); setEditing(false); }}>บันทึก</button>
              <button className="tk-btn ghost" onClick={() => { setEditing(false); setEditDesc(item.description || ""); }}>ยกเลิก</button>
            </div>
          </div>
        ) : (
          <>
            <h3 className="tk-drawer-title">
              {item.description}
              {role === "firm" && onUpdateItem && (
                <button type="button" className="tk-link" style={{ marginLeft: 8, fontSize: 12 }} onClick={() => setEditing(true)}>แก้ไข</button>
              )}
            </h3>
            <p className="tk-drawer-meta">{item.category} · {item.required ? "Required" : "Optional"} · Due {fmtDate(item.dueDate)}{isOverdue(item) && <span className="tk-od"> (overdue)</span>}</p>
          </>
        )}

        {item.status === "returned" && item.note && (
          <div className="tk-callout rust"><b>Returned by firm:</b> {item.note}</div>
        )}

        {/* Files */}
        <div className="tk-block">
          <p className="tk-block-h">Documents</p>
          {clientFiles.length === 0 && <p className="tk-muted">No files yet.</p>}
          <ul className="tk-filelist">
            {clientFiles.map((f, i) => (
              <li key={i}>
                <span className="tk-fileicon"><Icon name="doc" size={16} /></span>
                <span className="tk-fileinfo"><b>{f.name}</b><i>{fmtSize(f.size)} · {fmtDate(f.uploadedAt)}</i></span>
                {f.rejected && <span className="tk-file-rejected">ต้องแก้ไข</span>}
                {role === "firm" && f.downloadedAt && (
                  <span className="tk-dl-done" title={`โหลดแล้วเมื่อ ${fmtDate(f.downloadedAt)}`}>✓</span>
                )}
                {onPreviewUrl && isPreviewable(f) && (
                  <button className="tk-x" onClick={() => openPreview(f)}>ดู</button>
                )}
                {role === "firm" && onDownload && (
                  <button className="tk-x" disabled={busy} onClick={() => onDownload(f)}>{f.downloadedAt ? "โหลดซ้ำ" : "download"}</button>
                )}
                {role === "client" && item.status !== "accepted" && (
                  <button className="tk-x" onClick={() => onRemoveFile(item.id, i)}>remove</button>
                )}
              </li>
            ))}
          </ul>
          {role === "client" && item.status !== "accepted" && (
            <>
              <input ref={fileRef} type="file" multiple style={{ display: "none" }}
                onChange={(e) => { if (e.target.files.length) onUpload(item.id, e.target.files); e.target.value = ""; }} />
              <button className="tk-btn primary full" onClick={() => fileRef.current?.click()}>↑ Upload document</button>
            </>
          )}
        </div>

        {/* Sample / reference files (firm-uploaded, visible to the client) */}
        {role === "firm" && onUploadSample && (
          <div className="tk-block">
            <p className="tk-block-h"><Icon name="paperclip" size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />รายการที่เลือก / ตัวอย่าง · ลูกค้าเห็นได้</p>
            {sampleFiles.length === 0 && <p className="tk-muted">ยังไม่มี — อัปโหลดไฟล์ที่ต้องการให้ลูกค้าเห็น (เช่น รายการสุ่มที่เลือก)</p>}
            <ul className="tk-filelist">
              {sampleFiles.map((f) => (
                <li key={f.id}>
                  <span className="tk-fileicon"><Icon name="paperclip" size={16} /></span>
                  <span className="tk-fileinfo"><b>{f.name}</b><i>{fmtSize(f.size)} · {fmtDate(f.uploadedAt)}</i></span>
                  {onPreviewUrl && isPreviewable(f) && <button className="tk-x" onClick={() => openPreview(f)}>ดู</button>}
                  {onDownload && <button className="tk-x" disabled={busy} onClick={() => onDownload(f)}>download</button>}
                  {onRemoveSample && <button className="tk-x" disabled={busy} onClick={() => onRemoveSample(f)}>remove</button>}
                </li>
              ))}
            </ul>
            <input ref={sampleRef} type="file" multiple style={{ display: "none" }}
              onChange={(e) => { if (e.target.files.length) onUploadSample(item.id, e.target.files); e.target.value = ""; }} />
            <button className="tk-btn full" disabled={busy} onClick={() => sampleRef.current?.click()}>↑ อัปโหลด sample</button>
          </div>
        )}

        {/* Firm-internal note (not shown to clients) */}
        {role === "firm" && onSaveNote && (
          <div className="tk-block">
            <p className="tk-block-h">หมายเหตุถึงลูกค้า · ลูกค้าเห็นได้</p>
            <textarea className="tk-note" placeholder="ข้อความ/คำแนะนำถึงลูกค้าสำหรับข้อนี้…"
              value={firmNote} onChange={(e) => setFirmNote(e.target.value)} />
            <button className="tk-btn full" disabled={busy || firmNote === (item.firmNote || "")}
              onClick={() => onSaveNote(item.id, firmNote.trim())}>
              {busy ? "กำลังบันทึก…" : "บันทึกโน้ต"}
            </button>
          </div>
        )}

        {/* Per-item conversation with the client */}
        {onListComments && (
          <div className="tk-block">
            <p className="tk-block-h"><Icon name="chat" size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />การสนทนา · ลูกค้าเห็นได้</p>
            <CommentThread comments={comments} onSend={sendComment} busy={sendingC} loading={loadingC} meSide="Firm" />
            {commentErr && <p className="tk-muted" style={{ color: "#EF4444", marginTop: 6 }}>{commentErr}</p>}
          </div>
        )}

        {/* Firm actions */}
        {role === "firm" && (
          <div className="tk-block">
            <p className="tk-block-h">Review</p>
            {item.status !== "accepted" ? (
              <>
                {item.status === "submitted" && (
                  <button className="tk-btn full" onClick={() => onSetStatus(item.id, "review", "Firm", "Started review")}>Start review</button>
                )}
                <button className="tk-btn primary full"
                  onClick={() => { if (confirm("ยืนยันรับ (Accept) เอกสารข้อนี้?")) onSetStatus(item.id, "accepted", "Firm", "Accepted"); }}>
                  <Tick size={13} /> Accept{item.files.length === 0 ? " (รับเอกสารจริง/ไม่มีไฟล์)" : ""}
                </button>
                {item.files.length > 0 && (
                  <div className="tk-reject">
                    <p className="tk-reject-h">เลือกไฟล์ที่ต้องแก้ไข (partial) — ไม่เลือก = ส่งกลับทั้งข้อ</p>
                    {item.files.map((f) => (
                      <label key={f.id} className="tk-reject-row">
                        <input type="checkbox" checked={rejectedSet.has(f.id)} onChange={() => toggleReject(f.id)} />
                        <span>{f.name}</span>
                      </label>
                    ))}
                  </div>
                )}
                <select className="tk-return-reason" value={reason}
                  onChange={(e) => { setReason(e.target.value); if (e.target.value) setNote(e.target.value); }}>
                  <option value="">— เลือกเหตุผลส่งกลับ (หรือพิมพ์เอง) —</option>
                  <option value="เอกสารไม่ครบ">เอกสารไม่ครบ</option>
                  <option value="เอกสารไม่ถูกต้อง">เอกสารไม่ถูกต้อง</option>
                  <option value="เอกสารไม่ชัดเจน / อ่านไม่ออก">เอกสารไม่ชัดเจน / อ่านไม่ออก</option>
                  <option value="ผิดงวด / ผิดปี">ผิดงวด / ผิดปี</option>
                  <option value="ต้องการฉบับเซ็น / ประทับตรา">ต้องการฉบับเซ็น / ประทับตรา</option>
                </select>
                <textarea className="tk-note" placeholder="เหตุผลที่ส่งกลับ (ส่งถึงลูกค้า)…" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="tk-btn rust full" disabled={!note.trim()}
                  onClick={() => onReturn(item.id, note.trim(), [...rejectedSet], item.files.map((f) => f.id).filter((id) => !rejectedSet.has(id)))}>
                  ↩ Return to client{rejectedSet.size > 0 ? ` (${rejectedSet.size} ไฟล์)` : ""}
                </button>
              </>
            ) : (
              <button className="tk-btn ghost full" onClick={() => onSetStatus(item.id, "reopened", "Firm", "Reopened", { note: "" })}>Reopen item</button>
            )}
            {canDelete && (
              <button className="tk-btn danger full"
                onClick={() => { if (confirm("ย้ายรายการนี้ไปกล่อง Archived? (กู้คืนได้ภายหลัง)")) onDelete(item.id); }}>ลบ (ย้ายไป Archived)</button>
            )}
          </div>
        )}

        {/* History */}
        <div className="tk-block">
          <p className="tk-block-h">Activity</p>
          <ol className="tk-timeline">
            {item.history.slice().reverse().map((h, i) => (
              <li key={i}><span className="dot" /><span className="t"><b>{h.action}</b> · {h.by}</span><i>{fmtDate(h.at)}</i></li>
            ))}
          </ol>
        </div>
      </aside>
      {preview && <FilePreviewModal file={preview.file} url={preview.url} onClose={() => setPreview(null)} />}
    </>
  );
}

function GenerateModal({ onClose, onCreate, busy, source }) {
  const flatten = (t) => t.groups.flatMap(([category, rows]) =>
    rows.map(([description, required]) => ({ id: uid(), category, description, required, include: true })));
  const fromSource = () => (source?.items || []).map((it) => ({ id: uid(), category: it.category || "General", description: it.description, required: it.required ?? true, include: true }));
  const [tplKey, setTplKey] = useState(source ? "__source__" : TEMPLATES[0].key);
  const [items, setItems] = useState(() => source ? fromSource() : flatten(TEMPLATES[0]));
  const [client, setClient] = useState(source?.client || "");
  const [periodEnd, setPeriodEnd] = useState(() => {
    if (source?.periodEnd) { const d = new Date(source.periodEnd); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10); }
    return new Date(new Date().getFullYear() - 1, 11, 31).toISOString().slice(0, 10);
  });
  const [due, setDue] = useState(new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10));
  const [code, setCode] = useState("");
  const [clientEmail, setClientEmail] = useState(source?.clientEmail || "");
  const [sendInvite, setSendInvite] = useState(true);
  const [retDays, setRetDays] = useState(90);
  const [autoDelete, setAutoDelete] = useState(true);
  const [newCat, setNewCat] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [clientGroups, setClientGroups] = useState([]);
  const [groupId, setGroupId] = useState(source?.groupId || "");
  useEffect(() => { firmApi.listClientGroups().then(setClientGroups).catch(() => {}); }, []);
  const tplName = tplKey === "__source__" ? (source?.template || "PBC") : (TEMPLATES.find((t) => t.key === tplKey)?.name || "PBC");
  const included = items.filter((i) => i.include);
  const ready = client.trim() && code.length === 16 && included.length > 0;

  const changeTpl = (key) => {
    setTplKey(key);
    if (key === "__source__") setItems(fromSource());
    else setItems(flatten(TEMPLATES.find((t) => t.key === key)));
  };
  const toggle = (id) => setItems((p) => p.map((i) => (i.id === id ? { ...i, include: !i.include } : i)));
  const allOn = items.length > 0 && items.every((i) => i.include);
  const toggleAll = () => setItems((p) => p.map((i) => ({ ...i, include: !allOn })));
  const editDesc = (id, description) => setItems((p) => p.map((i) => (i.id === id ? { ...i, description } : i)));
  const removeCustom = (id) => setItems((p) => p.filter((i) => i.id !== id));
  const addCustom = () => {
    const d = newDesc.trim(); if (!d) return;
    setItems((p) => [...p, { id: uid(), category: newCat.trim() || "อื่นๆ", description: d, required: true, include: true, custom: true }]);
    setNewDesc("");
  };
  const groups = useMemo(() => {
    const m = new Map();
    items.forEach((it) => { if (!m.has(it.category)) m.set(it.category, []); m.get(it.category).push(it); });
    return [...m.entries()];
  }, [items]);

  const create = () => {
    if (!ready) return;
    onCreate({
      client: client.trim(), template: tplName,
      periodEnd: new Date(periodEnd).getTime(), baseDue: new Date(due).getTime(),
      code, retDays, autoDelete,   // raw code — the DB hashes it (create_engagement)
      clientEmail: clientEmail.trim(),
      sendInvite: sendInvite && !!clientEmail.trim(),
      groupId: groupId || null,
      items: included.map((i) => ({ category: i.category, description: i.description, required: i.required })),
    });
  };
  return (
    <Modal title={source ? "สร้างพอร์ทัลปีถัดไป (Roll-forward)" : "Generate request list"} onClose={onClose} wide>
      {source && <p className="tk-tplblurb" style={{ marginTop: 0 }}>คัดลอกจาก <b>{source.client}</b> — ปรับงวด/รหัสใหม่ให้แล้ว ตรวจรายการแล้วกดสร้างได้เลย (ทุกข้อเริ่มที่ "รออัปโหลด")</p>}
      <div className="tk-field-row">
        <label className="tk-field"><span>Template</span>
          <select value={tplKey} onChange={(e) => changeTpl(e.target.value)}>
            {source && <option value="__source__">จากพอร์ทัลเดิม · {source.template}</option>}
            {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
          </select>
        </label>
        <label className="tk-field"><span>Client name</span>
          <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="e.g. Northwind Trading Co." /></label>
      </div>
      {clientGroups.length > 0 && (
        <label className="tk-field"><span>กลุ่มลูกค้า (ไม่บังคับ)</span>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
            <option value="">— ไม่มี (พอร์ทัลเดี่ยว) —</option>
            {clientGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          {groupId && <span className="tk-hint" style={{ marginTop: 4 }}>อยู่ในกลุ่มแล้วจะเข้าผ่านลิงก์กลุ่มเท่านั้น (ลิงก์เดี่ยวปิด)</span>}
        </label>
      )}

      <div className="imp-summary" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span>เลือกไว้ <b>{included.length}</b> / {items.length} รายการ · {groups.length} หมวด — ติ๊กเลือก/เอาออก หรือแก้ข้อความได้</span>
        {items.length > 0 && (
          <button type="button" className="tk-link" style={{ whiteSpace: "nowrap" }} onClick={toggleAll}>
            {allOn ? "ยกเลิกทั้งหมด" : "เลือกทั้งหมด"}
          </button>
        )}
      </div>
      <div className="imp-scroll">
        {groups.length === 0 && (
          <p className="tk-muted" style={{ textAlign: "center", padding: "24px 12px", margin: 0 }}>
            ยังไม่มีรายการ — เพิ่มรายการเอกสารที่ต้องการด้านล่าง
          </p>
        )}
        {groups.map(([cat, rows]) => (
          <div key={cat} className="imp-group">
            <div className="imp-cat">{cat}</div>
            {rows.map((it) => (
              <div key={it.id} className={`imp-row ${it.include ? "" : "off"}`}>
                <input type="checkbox" checked={it.include} onChange={() => toggle(it.id)} />
                <input className="imp-text" value={it.description} onChange={(e) => editDesc(it.id, e.target.value)} />
                {it.custom && <button className="tk-x" onClick={() => removeCustom(it.id)}>ลบ</button>}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="tk-field-row" style={{ marginTop: 10 }}>
        <label className="tk-field"><span>เพิ่มข้อเอง — หมวด</span><input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="เช่น อื่นๆ" /></label>
        <label className="tk-field" style={{ flex: 2 }}><span>รายละเอียด</span>
          <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addCustom()} placeholder="เอกสารที่ต้องการเพิ่ม…" /></label>
        <button className="tk-btn" style={{ alignSelf: "flex-end", marginBottom: 13 }} disabled={!newDesc.trim()} onClick={addCustom}>+ เพิ่ม</button>
      </div>

      <div className="tk-field-row">
        <label className="tk-field"><span>Period end</span><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label>
        <label className="tk-field"><span>Default due date</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      </div>
      <label className="tk-field"><span>อีเมลลูกค้า (ไม่บังคับ · สำหรับแจ้งเตือน)</span>
        <input type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} placeholder="client@company.com" /></label>
      {clientEmail.trim() && (
        <label className="tk-check" style={{ alignSelf: "flex-start", paddingBottom: 4 }}>
          <input type="checkbox" checked={sendInvite} onChange={(e) => setSendInvite(e.target.checked)} /> ส่งอีเมลแจ้งลูกค้าทันทีหลังสร้าง
        </label>
      )}
      <label className="tk-field"><span>รหัสเข้าพอร์ทัล (16 หลัก)</span>
        <PasscodeInput value={code} onChange={setCode} />
        <button type="button" className="tk-link" onClick={() => setCode(genCode())}>สุ่มรหัสให้</button>
      </label>
      <div className="tk-field-row">
        <label className="tk-field"><span>อายุพอร์ทัล (retention)</span>
          <select value={String(retDays)} onChange={(e) => setRetDays(e.target.value === "null" ? null : Number(e.target.value))}>
            {RETENTION_OPTIONS.map((o) => <option key={String(o.days)} value={String(o.days)}>{o.label}</option>)}
          </select>
        </label>
        <label className="tk-check"><input type="checkbox" checked={autoDelete} onChange={(e) => setAutoDelete(e.target.checked)} /> ลบอัตโนมัติเมื่อหมดอายุ</label>
      </div>
      <div className="tk-modal-actions">
        <button className="tk-btn ghost" onClick={onClose}>Cancel</button>
        <button className="tk-btn primary" disabled={!ready || busy} onClick={create}>
          {busy ? "กำลังสร้าง…" : `Generate ${included.length} items`}
        </button>
      </div>
    </Modal>
  );
}

function AddItemModal({ eng, onClose, onAdd }) {
  const cats = [...new Set(eng.items.map((i) => i.category))];
  const [category, setCategory] = useState(cats[0] || "General");
  const [newCat, setNewCat] = useState("");
  const [description, setDescription] = useState("");
  const [required, setRequired] = useState(true);
  const [due, setDue] = useState(new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10));
  const finalCat = newCat.trim() || category;
  return (
    <Modal title="Add request item" onClose={onClose}>
      <label className="tk-field"><span>Section</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {cats.map((c) => <option key={c}>{c}</option>)}
        </select>
      </label>
      <label className="tk-field"><span>…or new section</span><input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="leave blank to use the one above" /></label>
      <label className="tk-field"><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What should the client provide?" /></label>
      <div className="tk-field-row">
        <label className="tk-field"><span>Due date</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        <label className="tk-check"><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Required</label>
      </div>
      <div className="tk-modal-actions">
        <button className="tk-btn ghost" onClick={onClose}>Cancel</button>
        <button className="tk-btn primary" disabled={!description.trim()}
          onClick={() => onAdd({ category: finalCat, description: description.trim(), required, dueDate: new Date(due).getTime() })}>Add item</button>
      </div>
    </Modal>
  );
}

function ImportModal({ draft, onClose, onImport }) {
  const [client, setClient] = useState(draft.meta.client || "");
  const [periodEnd, setPeriodEnd] = useState(toDateInput(parseYearEnd(draft.meta.yearEnd)));
  const [due, setDue] = useState(toDateInput(Date.now() + 14 * DAY));
  const [items, setItems] = useState(draft.items.map((i) => ({ ...i })));
  const [code, setCode] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [retDays, setRetDays] = useState(90);
  const [autoDelete, setAutoDelete] = useState(true);

  const update = (id, patch) => setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const included = items.filter((i) => i.include);
  const recv = included.filter((i) => i.status === "accepted").length;
  const groups = useMemo(() => {
    const m = new Map();
    items.forEach((it) => { if (!m.has(it.category)) m.set(it.category, []); m.get(it.category).push(it); });
    return [...m.entries()];
  }, [items]);

  return (
    <Modal title="ตรวจทานก่อนสร้างลิสต์" onClose={onClose} wide>
      <p className="tk-tplblurb">อ่านจากไฟล์ Excel แล้ว — แก้ไข/เอารายการออกได้ตามต้องการ จากนั้นกดยืนยันเพื่อสร้างลิสต์ลงพอร์ทัล</p>

      <div className="tk-field-row">
        <label className="tk-field"><span>ชื่อลูกค้า (Client)</span><input value={client} onChange={(e) => setClient(e.target.value)} placeholder="ชื่อบริษัท" /></label>
        <label className="tk-field"><span>Period end</span><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label>
        <label className="tk-field"><span>กำหนดส่ง (ทุกข้อ)</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
      </div>
      <label className="tk-field"><span>อีเมลลูกค้า (ไม่บังคับ · สำหรับแจ้งเตือน)</span>
        <input type="email" value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} placeholder="client@company.com" /></label>
      {(draft.meta.preparedBy || draft.meta.wpRef) && (
        <p className="tk-detected">
          {draft.meta.preparedBy && <span>Prepared by: <b>{draft.meta.preparedBy}</b></span>}
          {draft.meta.wpRef && <span>W/P ref: <b>{draft.meta.wpRef}</b></span>}
        </p>
      )}

      <div className="imp-summary">
        เลือกไว้ <b>{included.length}</b> รายการ · {groups.length} หมวด ·
        <span className="ok"> ได้รับแล้ว {recv}</span> · <span className="wait">ค้างรับ {included.length - recv}</span>
      </div>

      <div className="imp-scroll">
        {groups.map(([cat, rows]) => (
          <div key={cat} className="imp-group">
            <div className="imp-cat">{cat}</div>
            {rows.map((it) => (
              <div key={it.id} className={`imp-row ${it.include ? "" : "off"}`}>
                <input type="checkbox" checked={it.include} onChange={(e) => update(it.id, { include: e.target.checked })} />
                <input className="imp-text" value={it.text} onChange={(e) => update(it.id, { text: e.target.value })} />
                <select className="imp-status" value={it.status} onChange={(e) => update(it.id, { status: e.target.value })}>
                  <option value="outstanding">ค้างรับ</option>
                  <option value="accepted">ได้รับแล้ว</option>
                </select>
              </div>
            ))}
          </div>
        ))}
      </div>

      <label className="tk-field"><span>รหัสเข้าพอร์ทัล (16 หลัก)</span>
        <PasscodeInput value={code} onChange={setCode} />
        <button type="button" className="tk-link" onClick={() => setCode(genCode())}>สุ่มรหัสให้</button>
      </label>
      <div className="tk-field-row">
        <label className="tk-field"><span>อายุพอร์ทัล (retention)</span>
          <select value={String(retDays)} onChange={(e) => setRetDays(e.target.value === "null" ? null : Number(e.target.value))}>
            {RETENTION_OPTIONS.map((o) => <option key={String(o.days)} value={String(o.days)}>{o.label}</option>)}
          </select>
        </label>
        <label className="tk-check"><input type="checkbox" checked={autoDelete} onChange={(e) => setAutoDelete(e.target.checked)} /> ลบอัตโนมัติเมื่อหมดอายุ</label>
      </div>

      <div className="tk-modal-actions">
        <button className="tk-btn ghost" onClick={onClose}>ยกเลิก</button>
        <button className="tk-btn primary" disabled={!included.length || !client.trim() || code.length !== 16}
          onClick={() => onImport({ client: client.trim(), periodEnd: new Date(periodEnd).getTime(), baseDue: new Date(due).getTime(), items: included, code, retDays, autoDelete, clientEmail: clientEmail.trim(), sendInvite: !!clientEmail.trim() })}>
          ยืนยันสร้างลิสต์ ({included.length})
        </button>
      </div>
    </Modal>
  );
}

// Bulk reminder: pick categories, pick which portals (that have an email),
// and send one "outstanding docs" reminder email to each — no per-engagement
// visits. Portals without an email on file are listed but can't be sent.
function ReminderModal({ candidates, onClose }) {
  const CATS = [
    { key: "overdue", label: "เกินกำหนด", dot: "#EF4444" },
    { key: "soon", label: "ใกล้ครบกำหนด", dot: "#F59E0B" },
    { key: "outstanding", label: "รออัปโหลด (ทั้งหมด)", dot: "#64748B" },
  ];
  const [cats, setCats] = useState(() => new Set(["overdue", "soon", "outstanding"]));
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  const matches = useMemo(() => candidates.filter((c) => [...cats].some((k) => c[k] > 0)), [candidates, cats]);
  const withEmail = matches.filter((c) => c.clientEmail);
  const noEmail = matches.filter((c) => !c.clientEmail);

  // Re-select every matching portal with an email whenever the categories change.
  useEffect(() => {
    setSel(new Set(candidates.filter((c) => c.clientEmail && [...cats].some((k) => c[k] > 0)).map((c) => c.id)));
  }, [cats, candidates]);

  const toggleCat = (k) => setCats((p) => { const s = new Set(p); if (s.has(k)) s.delete(k); else s.add(k); return s.size ? s : p; });
  const toggleOne = (id) => setSel((p) => { const s = new Set(p); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const allSel = withEmail.length > 0 && withEmail.every((c) => sel.has(c.id));
  const toggleAll = () => setSel(allSel ? new Set() : new Set(withEmail.map((c) => c.id)));

  const send = async () => {
    if (!sel.size || busy) return;
    setBusy(true);
    let ok = 0, fail = 0;
    for (const id of sel) {
      try { await firmApi.notify(id, "reminder"); ok++; } catch { fail++; }
    }
    setBusy(false); setDone({ ok, fail });
  };

  const chip = (on) => ({
    display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 12px", borderRadius: 20,
    cursor: "pointer", fontSize: 13, fontWeight: 600, border: "1px solid",
    borderColor: on ? "var(--pine)" : "var(--line)", background: on ? "var(--pine-tint)" : "#fff",
    color: on ? "var(--pine)" : "var(--ink-soft)",
  });

  return (
    <Modal title="ส่ง reminder ให้ลูกค้า" onClose={onClose} wide>
      {done ? (
        <div style={{ textAlign: "center", padding: "16px 8px" }}>
          <div style={{ width: 52, height: 52, borderRadius: "50%", background: "rgba(18,179,154,.12)", color: "#12B39A", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Icon name="check" size={28} /></div>
          <p style={{ fontSize: 15, margin: "8px 0 4px" }}>ส่งอีเมลเตือนแล้ว <b>{done.ok}</b> ฉบับ{done.fail > 0 && <> · ล้มเหลว <b style={{ color: "#EF4444" }}>{done.fail}</b></>}</p>
          <button className="tk-btn primary" style={{ marginTop: 12 }} onClick={onClose}>เสร็จสิ้น</button>
        </div>
      ) : (
        <>
          <p className="tk-tplblurb" style={{ marginTop: 0 }}>เลือกหมวดที่จะเตือน แล้วเลือกพอร์ทัลที่จะส่ง — แต่ละพอร์ทัลจะได้อีเมลรวมรายการเอกสารที่ยังไม่ได้อัปโหลด 1 ฉบับ (ไม่ต้องเข้าทีละงาน)</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {CATS.map((c) => (
              <button key={c.key} type="button" onClick={() => toggleCat(c.key)} style={chip(cats.has(c.key))}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: c.dot }} />{c.label}
              </button>
            ))}
          </div>

          <div className="imp-summary" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>จะส่งถึง <b>{sel.size}</b> / {withEmail.length} พอร์ทัล</span>
            {withEmail.length > 0 && <button type="button" className="tk-link" onClick={toggleAll}>{allSel ? "ไม่เลือกทั้งหมด" : "เลือกทั้งหมด"}</button>}
          </div>

          <div className="imp-scroll" style={{ maxHeight: "36vh" }}>
            {withEmail.length === 0 && (
              <p className="tk-muted" style={{ textAlign: "center", padding: 20, margin: 0 }}>
                {noEmail.length ? "พอร์ทัลที่ตรงกับหมวดที่เลือกยังไม่ระบุอีเมล (ดูด้านล่าง)" : "ไม่มีพอร์ทัลที่ตรงกับหมวดที่เลือก"}
              </p>
            )}
            {withEmail.map((c) => (
              <label key={c.id} className="imp-row" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggleOne(c.id)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.client}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
                    {c.overdue > 0 && <span style={{ color: "#EF4444", fontWeight: 600 }}>เกินกำหนด {c.overdue} · </span>}
                    {c.soon > 0 && <span style={{ color: "#b4791b", fontWeight: 600 }}>ใกล้ครบ {c.soon} · </span>}
                    รออัปโหลด {c.outstanding} · {c.clientEmail}
                  </div>
                </div>
              </label>
            ))}
          </div>

          {noEmail.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#b4791b", marginBottom: 6 }}>⚠ ยังไม่ระบุอีเมล ({noEmail.length}) — ส่งไม่ได้ ต้องเพิ่มอีเมลที่ ⚙ ตั้งค่าพอร์ทัลของงานนั้นก่อน</div>
              <div className="imp-scroll" style={{ maxHeight: "16vh", background: "rgba(245,158,11,.05)" }}>
                {noEmail.map((c) => (
                  <div key={c.id} className="imp-row" style={{ opacity: 0.9 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{c.client}</div>
                      <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>รออัปโหลด {c.outstanding} รายการ</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="tk-modal-actions" style={{ marginTop: 16 }}>
            <button className="tk-btn" onClick={onClose}>ยกเลิก</button>
            <button className="tk-btn primary" disabled={!sel.size || busy} onClick={send}>
              {busy ? "กำลังส่ง…" : `ส่ง reminder (${sel.size})`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// Manage client groups: create a group, share one group link, and assign
// which portals belong to it (grouped portals are group-link-only).
// Drill-in list for a "สิ่งที่ต้องจัดการวันนี้" status card. Each row jumps
// straight to that item inside its portal.
function StatusListModal({ kind, items, onClose, onOpenItem }) {
  const meta = {
    overdue: { title: "รายการที่เกินกำหนด" },
    soon: { title: "รายการที่ใกล้ครบกำหนด" },
    review: { title: "รายการที่รอตรวจ" },
  }[kind] || { title: "รายการ" };
  // group items by engagement (preserve incoming order)
  const groups = [];
  const byId = new Map();
  items.forEach((it) => {
    let g = byId.get(it.engagementId);
    if (!g) { g = { engagementId: it.engagementId, client: it.client, items: [] }; byId.set(it.engagementId, g); groups.push(g); }
    g.items.push(it);
  });
  return (
    <Modal title={meta.title} onClose={onClose} wide>
      <p className="tk-tplblurb" style={{ marginTop: 0 }}>คลิกที่รายการเพื่อไปยังข้อนั้นในพอร์ทัลได้เลย · {items.length} รายการ · {groups.length} พอร์ทัล</p>
      <div className="imp-scroll" style={{ maxHeight: "58vh" }}>
        {items.length === 0 ? (
          <p className="tk-muted" style={{ padding: 20, textAlign: "center", margin: 0 }}>ไม่มีรายการ</p>
        ) : groups.map((g) => (
          <div key={g.engagementId} className="nv-slg">
            <div className="nv-slg-head"><span className="nm">{g.client}</span><span className="ct">{g.items.length} รายการ</span></div>
            {g.items.map((it) => (
              <button key={it.id} className="nv-sl-row" onClick={() => onOpenItem(it.engagementId, it.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="nv-sl-name">{it.description}</div>
                  <div className="nv-sl-sub">
                    {it.dueDate ? `กำหนดส่ง ${fmtDate(it.dueDate)}` : "ไม่มีกำหนดส่ง"}
                    {kind === "overdue" && it.days ? <span style={{ color: "#EF4444", fontWeight: 600 }}> · เกิน {it.days} วัน</span> : null}
                    {kind === "soon" && it.days ? <span style={{ color: "#b4791b", fontWeight: 600 }}> · เหลือ {it.days} วัน</span> : null}
                  </div>
                </div>
                <span className="nv-sl-chev">›</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ClientGroupsModal({ onClose, onChanged }) {
  const [groups, setGroups] = useState(null);
  const [engs, setEngs] = useState([]);
  const [sel, setSel] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  const reload = async () => {
    try {
      const [g, e] = await Promise.all([firmApi.listClientGroups(), firmApi.listEngagements()]);
      setGroups(g); setEngs(e);
    } catch (ex) { setErr(ex.message || "โหลดไม่สำเร็จ"); }
  };
  useEffect(() => { reload(); }, []);

  const doRun = async (fn) => {
    setBusy(true); setErr("");
    try { await fn(); await reload(); onChanged?.(); }
    catch (e) { setErr(e.message || "ดำเนินการไม่สำเร็จ"); }
    finally { setBusy(false); }
  };
  const create = () => { if (code.length !== 16) return; doRun(async () => { const id = await firmApi.createClientGroup({ name: name.trim(), code }); setName(""); setCode(""); setCreating(false); setSel(id); }); };
  const toggleEng = (e) => doRun(() => firmApi.setEngagementGroup(e.id, e.groupId === sel ? null : sel));
  const del = (id) => { if (!confirm("ลบกลุ่มนี้? พอร์ทัลในกลุ่มจะกลับเป็นพอร์ทัลเดี่ยว")) return; doRun(async () => { await firmApi.deleteClientGroup(id); if (sel === id) setSel(null); }); };
  const resetCode = (id) => { if (!confirm("สุ่มรหัสกลุ่มใหม่? รหัสเดิมจะใช้ไม่ได้ทันที")) return; const c = genCode(); doRun(async () => { await firmApi.setGroupCode(id, c); alert("รหัสกลุ่มใหม่ (ส่งให้ลูกค้าแยกช่องทาง):\n\n" + c.replace(/(.{4})/g, "$1 ").trim()); }); };

  const selGroup = (groups || []).find((g) => g.id === sel);
  const link = selGroup ? `${location.origin}/client.html?g=${selGroup.id}` : "";
  const memberCount = (gid) => engs.filter((e) => e.groupId === gid).length;

  return (
    <Modal title="กลุ่มลูกค้า — แชร์หลายพอร์ทัลด้วยลิงก์เดียว" onClose={onClose} wide>
      {err && <p className="tk-lock-err">{err}</p>}
      {groups === null ? (
        <p className="tk-muted">กำลังโหลด…</p>
      ) : (
        <>
          {creating ? (
            <div style={{ border: "1px solid var(--line)", borderRadius: 12, padding: "14px 16px", marginBottom: 4 }}>
              <label className="tk-field"><span>ชื่อกลุ่ม</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น ABC Group" autoFocus /></label>
              <label className="tk-field" style={{ marginBottom: 4 }}><span>รหัสกลุ่ม (16 หลัก)</span>
                <PasscodeInput value={code} onChange={setCode} /></label>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 10 }}>
                <button type="button" className="tk-link" onClick={() => setCode(genCode())}>สุ่มรหัสให้</button>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="tk-btn" onClick={() => { setCreating(false); setErr(""); }}>ยกเลิก</button>
                  <button className="tk-btn primary" disabled={code.length !== 16 || busy} onClick={create}>สร้างกลุ่ม</button>
                </div>
              </div>
            </div>
          ) : (
            <button className="tk-btn primary" onClick={() => setCreating(true)}>＋ สร้างกลุ่มใหม่</button>
          )}

          {groups.length === 0 ? (
            <p className="tk-muted" style={{ marginTop: 12 }}>ยังไม่มีกลุ่ม — สร้างกลุ่มแรกด้านบน</p>
          ) : (
            <ul className="tk-rows" style={{ marginTop: 12 }}>
              {groups.map((g) => (
                <li key={g.id} className={`tk-row ${sel === g.id ? "open" : ""}`} style={{ cursor: "pointer" }} onClick={() => setSel(sel === g.id ? null : g.id)}>
                  <div className="tk-desc"><span className="tk-desc-main">{g.name}</span><span className="tk-desc-sub">{memberCount(g.id)} พอร์ทัล</span></div>
                  <button className="tk-x" onClick={(e) => { e.stopPropagation(); del(g.id); }}>ลบ</button>
                </li>
              ))}
            </ul>
          )}

          {selGroup && (
            <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <label className="tk-field"><span>ลิงก์กลุ่ม (ส่งรหัสกลุ่มแยกช่องทาง)</span>
                <input readOnly value={link} onFocus={(e) => e.target.select()} /></label>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                <button className="tk-btn" onClick={() => { navigator.clipboard?.writeText(link).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "คัดลอกแล้ว ✓" : <><Icon name="link" size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />คัดลอกลิงก์</>}</button>
                <button className="tk-btn ghost" onClick={() => resetCode(selGroup.id)}>สุ่มรหัสกลุ่มใหม่</button>
              </div>
              <p className="tk-hint" style={{ marginBottom: 8 }}>ติ๊กพอร์ทัลที่จะอยู่ในกลุ่มนี้ — พอร์ทัลในกลุ่มจะเข้าผ่านลิงก์กลุ่มเท่านั้น (ลิงก์เดี่ยวปิด)</p>
              <div className="imp-scroll" style={{ maxHeight: "34vh" }}>
                {engs.length === 0 ? <p className="tk-muted" style={{ padding: 16, margin: 0 }}>ยังไม่มีพอร์ทัล</p> : engs.map((e) => {
                  const inThis = e.groupId === sel;
                  const inOther = e.groupId && e.groupId !== sel;
                  return (
                    <label key={e.id} className="imp-row" style={{ cursor: "pointer" }}>
                      <input type="checkbox" checked={inThis} disabled={busy} onChange={() => toggleEng(e)} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{e.client}</div>
                        <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>{e.template}{inOther && <span style={{ color: "#b4791b" }}> · อยู่ในกลุ่มอื่น (ติ๊กเพื่อย้ายมา)</span>}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function LineModal({ onClose }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = () => firmApi.lineStatus().then(setStatus).catch((e) => { setErr(e.message || ""); setStatus({ linked: false, code: null }); });
  useEffect(() => { load(); }, []);
  const run = async (fn) => { setBusy(true); setErr(""); try { await fn(); await load(); } catch (e) { setErr(e.message || "ไม่สำเร็จ"); } finally { setBusy(false); } };

  return (
    <Modal title="แจ้งเตือนผ่าน LINE" onClose={onClose}>
      {status === null ? (
        <p className="tk-muted">กำลังโหลด…</p>
      ) : status.linked ? (
        <>
          <div className="tk-callout note" style={{ marginBottom: 14 }}>✅ เชื่อมต่อ LINE แล้ว — เมื่อลูกค้าอัปโหลดเอกสาร ระบบจะแจ้งเตือนใน LINE ของคุณ</div>
          <button className="tk-btn danger full" disabled={busy} onClick={() => { if (confirm("ยกเลิกการเชื่อม LINE?")) run(() => firmApi.lineUnlink()); }}>ยกเลิกการเชื่อม LINE</button>
        </>
      ) : (
        <>
          <p className="tk-tplblurb" style={{ marginTop: 0 }}>เชื่อม LINE เพื่อรับแจ้งเตือนเมื่อลูกค้าอัปโหลดเอกสาร</p>
          <ol style={{ fontSize: 13, lineHeight: 1.9, paddingLeft: 18, margin: "0 0 12px" }}>
            <li>เพิ่มเพื่อนบอท <b>Tickmark</b> ใน LINE (หรือเชิญเข้ากลุ่ม)</li>
            <li>กด “สร้างรหัส” แล้ว<b>ส่งรหัสนั้นในแชต</b>กับบอท</li>
            <li>บอทตอบ “เชื่อมต่อสำเร็จ” = เสร็จ</li>
          </ol>
          {status.code && (
            <div className="tk-callout note" style={{ textAlign: "center", marginBottom: 12 }}>
              ส่งรหัสนี้ให้บอทใน LINE:<br />
              <b style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, letterSpacing: 2 }}>{status.code}</b>
            </div>
          )}
          <button className="tk-btn primary full" disabled={busy} onClick={() => run(() => firmApi.lineGenerateCode())}>
            {busy ? "…" : status.code ? "สร้างรหัสใหม่" : "สร้างรหัสเชื่อมต่อ"}
          </button>
        </>
      )}
      {err && <p className="tk-lock-err">{err}</p>}
    </Modal>
  );
}

function ArchivedModal({ eng, canManage, onClose, onChanged }) {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const reload = () => firmApi.listArchived(eng.id).then(setItems).catch((e) => { setErr(e.message || ""); setItems([]); });
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn) => {
    setBusy(true); setErr("");
    try { await fn(); await reload(); onChanged && onChanged(); } catch (e) { setErr(e.message || "ไม่สำเร็จ"); } finally { setBusy(false); }
  };

  return (
    <Modal title="รายการที่ลบ (Archived)" onClose={onClose} wide>
      <p className="tk-tplblurb" style={{ marginTop: 0 }}>รายการที่ถูกลบจะมาอยู่ที่นี่ — กู้คืน หรือลบถาวรได้</p>
      {err && <p className="tk-lock-err">{err}</p>}
      {items === null ? (
        <p className="tk-muted">กำลังโหลด…</p>
      ) : items.length === 0 ? (
        <p className="tk-none">ไม่มีรายการที่ลบ</p>
      ) : (
        <ul className="tk-arch-list">
          {items.map((it) => (
            <li key={it.id}>
              <div className="tk-arch-info">
                <b>{it.ref} · {it.description}</b>
                <i>{it.category} · {it.files.length} ไฟล์</i>
              </div>
              {canManage && (
                <>
                  <button className="tk-btn" disabled={busy} onClick={() => act(() => firmApi.restoreItem(it.id))}>กู้คืน</button>
                  <button className="tk-btn danger" disabled={busy}
                    onClick={() => { if (confirm("ลบถาวร? รวมไฟล์ทั้งหมด — กู้คืนไม่ได้อีก")) act(() => firmApi.purgeItem(it.id)); }}>ลบถาวร</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ShareModal({ eng, onClose }) {
  const [members, setMembers] = useState(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const reload = () => firmApi.listPortalMembers(eng.id).then(setMembers).catch((e) => { setErr(e.message || ""); setMembers([]); });
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn) => {
    setBusy(true); setErr("");
    try { await fn(); await reload(); } catch (e) { setErr(e.message || "ไม่สำเร็จ"); } finally { setBusy(false); }
  };
  const add = () => { if (email.trim()) act(async () => { await firmApi.addPortalMember(eng.id, email.trim(), role); setEmail(""); }); };

  return (
    <Modal title="แชร์พอร์ทัล / จัดการสมาชิก" onClose={onClose}>
      <p className="tk-tplblurb" style={{ marginTop: 0 }}>เพิ่มผู้ใช้ฝั่งสำนักงานเข้าพอร์ทัลนี้ · เจ้าของ = สิทธิ์เต็ม · สมาชิก = จำกัด (ลบ item ไม่ได้จนกว่าจะอนุญาต)</p>
      <div className="tk-field-row">
        <label className="tk-field" style={{ flex: 2 }}><span>อีเมลผู้ใช้ (ต้องมีบัญชีแล้ว)</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()} placeholder="colleague@firm.com" /></label>
        <label className="tk-field"><span>บทบาท</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">สมาชิก</option>
            <option value="owner">เจ้าของ</option>
          </select></label>
        <button className="tk-btn primary" style={{ alignSelf: "flex-end", marginBottom: 13 }} disabled={busy || !email.trim()} onClick={add}>+ เพิ่ม</button>
      </div>
      {err && <p className="tk-lock-err">{err}</p>}

      <p className="tk-block-h">สมาชิก ({members ? members.length : "…"})</p>
      <ul className="tk-member-list">
        {(members || []).map((m) => (
          <li key={m.userId}>
            <span className="tk-member-email">{m.email}</span>
            <select value={m.role} disabled={busy}
              onChange={(e) => act(() => firmApi.setPortalMember(eng.id, m.userId, e.target.value, m.canDelete))}>
              <option value="member">สมาชิก</option>
              <option value="owner">เจ้าของ</option>
            </select>
            {m.role !== "owner" && (
              <label className="tk-check" style={{ fontSize: 12, padding: 0 }}>
                <input type="checkbox" checked={m.canDelete} disabled={busy}
                  onChange={(e) => act(() => firmApi.setPortalMember(eng.id, m.userId, m.role, e.target.checked))} /> ลบ item ได้
              </label>
            )}
            <button className="tk-x" disabled={busy} onClick={() => act(() => firmApi.removePortalMember(eng.id, m.userId))}>เอาออก</button>
          </li>
        ))}
      </ul>
      <p className="tk-lock-foot" style={{ marginTop: 10 }}>ผู้ใช้ที่จะเพิ่มต้องสมัคร + ได้รับอนุมัติในระบบก่อน จึงเชิญเข้าได้</p>
    </Modal>
  );
}

function ZipModal({ eng, busy, onClose, onDownload }) {
  const allFiles = (eng.items || []).flatMap((it) => it.files);
  const total = allFiles.length;
  const news = allFiles.filter((f) => !f.downloadedAt).length;
  const opts = [
    { onlyNew: false, icon: "folder", label: "ดาวน์โหลดทั้งหมด", desc: "ทุกไฟล์ในพอร์ทัลนี้ (จัดโฟลเดอร์ตามหมวด)", n: total, disabled: total === 0 },
    { onlyNew: true, icon: "inbox", label: "เฉพาะที่ยังไม่ได้โหลด", desc: "ข้ามไฟล์ที่เคยโหลดไปแล้ว", n: news, disabled: news === 0 },
  ];
  return (
    <Modal title="ดาวน์โหลดไฟล์ (.zip)" onClose={onClose}>
      <p className="tk-tplblurb" style={{ marginTop: 0 }}>มีไฟล์ทั้งหมด <b>{total}</b> · ยังไม่ได้โหลด <b>{news}</b></p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {opts.map((o) => (
          <button key={String(o.onlyNew)} className="tk-notify-opt" disabled={busy || o.disabled} onClick={() => onDownload(o.onlyNew)}>
            <span className="ic"><Icon name={o.icon} size={17} /></span>
            <span className="body">
              <b>{o.label}<i className="cnt">{o.n}</i></b>
              <em>{o.disabled ? "— ไม่มีไฟล์" : o.desc}</em>
            </span>
            <span className="go">{busy ? "…" : "โหลด ›"}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function NotifyModal({ eng, busy, onClose, onSend }) {
  const returned = (eng.items || []).filter((i) => i.status === "returned").length;
  const outstanding = (eng.items || []).filter((i) => i.status === "outstanding").length;
  const opts = [
    { kind: "invite", icon: "folder", label: "แจ้งเปิดพอร์ทัล (เชิญอัปโหลด)", desc: "ส่งลิงก์พอร์ทัล + ขอให้เริ่มอัปโหลดเอกสาร" },
    { kind: "returned", icon: "return", label: "เตือนเอกสารที่ต้องแก้ไข", desc: "รวมทุกข้อที่ส่งกลับ (returned) เป็นเมลเดียว", n: returned, disabled: returned === 0 },
    { kind: "reminder", icon: "clock", label: "เตือนเอกสารที่ยังไม่ส่ง", desc: "รวมทุกข้อที่ยังค้าง (outstanding) เป็นเมลเดียว", n: outstanding, disabled: outstanding === 0 },
  ];
  return (
    <Modal title="แจ้งเตือนลูกค้า" onClose={onClose}>
      <p className="tk-tplblurb" style={{ marginTop: 0 }}>ส่งถึง <b>{eng.clientEmail}</b> · เลือกอย่างเดียว ส่งทีละเมล (ประหยัดโควตา)</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {opts.map((o) => (
          <button key={o.kind} className="tk-notify-opt" disabled={busy || o.disabled} onClick={() => onSend(o.kind)}>
            <span className="ic"><Icon name={o.icon} size={17} /></span>
            <span className="body">
              <b>{o.label}{o.n != null && <i className="cnt">{o.n}</i>}</b>
              <em>{o.disabled ? "— ไม่มีรายการ" : o.desc}</em>
            </span>
            <span className="go">{busy ? "…" : "ส่ง ›"}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose, wide }) {
  return (
    <>
      <div className="tk-scrim" onClick={onClose} />
      <div className={`tk-modal${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
        <div className="tk-modal-head"><h3>{title}</h3><button className="tk-icon" onClick={onClose}>✕</button></div>
        <div className="tk-modal-body">{children}</div>
      </div>
    </>
  );
}

/* ---------- Styles ------------------------------------------------------ */
// Styles now live in src/portal.css (imported at the top of this file and
// shared with the client portal). Kept as a no-op so existing <Style /> JSX
// stays valid without duplicating the stylesheet.
function Style() {
  return null;
}
