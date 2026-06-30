import { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import { firmApi } from "./lib/portalApi.js";
import { SUPABASE_CONFIGURED } from "./lib/supabaseClient.js";
import "./src/portal.css"; // shared stylesheet (also used by the client portal)

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
};
const STATUS_ORDER = ["outstanding", "submitted", "review", "accepted", "returned"];

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
const onlyDigits = (s) => s.replace(/\D+/g, "").slice(0, 16);
const groupDigits = (s) => s.replace(/(.{4})/g, "$1 ").trim();
const genCode = () => Array.from({ length: 16 }, () => Math.floor(Math.random() * 10)).join("");

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
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}
function isOverdue(item) {
  return item.status !== "accepted" && item.dueDate && item.dueDate < Date.now();
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

function cellStr(row, i) {
  const v = row ? row[i] : undefined;
  return v == null ? "" : String(v).trim();
}
function mapImportStatus(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s) return "outstanding";
  if (RECEIVED_WORDS.some((w) => s.includes(w.toLowerCase()))) return "accepted";
  return "outstanding";
}
function toDateInput(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseYearEnd(raw) {
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
function findMeta(aoa, labels) {
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
function parsePBC(aoa) {
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
  const [profile, setProfile] = useState(undefined); // undefined = loading, then { approved, ... } | null
  const [engagements, setEngagements] = useState([]); // summary list (no items)
  const [currentId, setCurrentId] = useState(null);
  const [eng, setEng] = useState(null);               // detail of currentId (items + files + history)
  const [openItem, setOpenItem] = useState(null);     // item id for drawer
  const [modal, setModal] = useState(null);           // 'generate' | 'add' | 'import' | 'settings'
  const [importDraft, setImportDraft] = useState(null);
  const importRef = useRef(null);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);            // a backend mutation is in flight
  const [err, setErr] = useState("");
  const [view, setView] = useState("dashboard");      // 'dashboard' | 'engagement'
  const [dash, setDash] = useState(null);             // engagements + progress for the dashboard

  /* ---- auth session ---- */
  useEffect(() => {
    let alive = true;
    firmApi.getSession().then((s) => { if (alive) setSession(s); });
    const unsub = firmApi.onAuthChange((s) => { if (alive) setSession(s); });
    return () => { alive = false; unsub(); };
  }, []);

  /* ---- load the signed-in user's profile (for the approval gate) ---- */
  useEffect(() => {
    let alive = true;
    if (!session) { setProfile(undefined); return; }
    firmApi.getProfile()
      .then((p) => { if (alive) setProfile(p); })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /* ---- dashboard: all portals + their progress ---- */
  const loadDashboard = async () => {
    setErr("");
    try { setDash(await firmApi.listEngagementsWithProgress()); }
    catch (e) { setErr(e.message || "โหลดภาพรวมไม่สำเร็จ"); }
  };
  useEffect(() => {
    if (session && profile?.approved && view === "dashboard") loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, profile, view]);

  // navigation between the dashboard and a single engagement
  const openEngagement = (id) => { setCurrentId(id); setOpenItem(null); setView("engagement"); };
  const goDashboard = () => { setOpenItem(null); setView("dashboard"); };

  /* ---- load the selected portal's detail when it changes ---- */
  const reloadDetail = async () => {
    if (!currentId) { setEng(null); return; }
    setErr("");
    try { setEng(await firmApi.getEngagement(currentId)); }
    catch (e) { setErr(e.message || "โหลดพอร์ทัลไม่สำเร็จ"); }
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

  const generateEngagement = ({ tplKey, client, periodEnd, baseDue, code, retDays, autoDelete }) =>
    run(async () => {
      const t = TEMPLATES.find((x) => x.key === tplKey);
      const id = await firmApi.createEngagement(
        { client, template: t.name, periodEnd, code, retentionDays: retDays, autoDelete },
        buildItems(t, baseDue)
      );
      setModal(null);
      await reloadList(id);
      setView("engagement");
    });

  const importEngagement = ({ client, periodEnd, baseDue, items, code, retDays, autoDelete }) =>
    run(async () => {
      const id = await firmApi.createEngagement(
        { client, template: "นำเข้าจาก Excel (PBC)", periodEnd, code, retentionDays: retDays, autoDelete },
        items.map((it, i) => ({
          ref: String(i + 1).padStart(2, "0"), category: it.category || "General",
          description: it.text, required: true, dueDate: baseDue, status: it.status, sort: i,
        }))
      );
      setModal(null); setImportDraft(null); setOpenItem(null);
      await reloadList(id);
      setView("engagement");
    });

  const addItem = ({ category, description, required, dueDate }) =>
    run(async () => {
      const sort = eng?.items?.length || 0;
      await firmApi.addItem(eng.id, { ref: String(sort + 1).padStart(2, "0"), category, description, required, dueDate }, sort);
      setModal(null);
    }, reloadDetail);

  const deleteItem = (itemId) =>
    run(() => firmApi.deleteItem(itemId), async () => { setOpenItem(null); await reloadDetail(); });

  const setEngPasscode = (id, code) => run(() => firmApi.setPortalCode(id, code));
  const setEngRetention = (id, days, autoDelete) =>
    run(() => firmApi.setRetention(id, { expiresAt: expiryFromDays(days, eng?.createdAt || Date.now()), autoDelete }), reloadDetail);
  const extendEng = (id, days) =>
    run(() => firmApi.setRetention(id, { expiresAt: Math.max(Date.now(), eng?.expiresAt || Date.now()) + days * DAY, autoDelete: eng?.autoDelete }), reloadDetail);
  const deleteEng = (id) =>
    run(() => firmApi.deleteEngagement(id), async () => { setOpenItem(null); setModal(null); setView("dashboard"); await reloadList(); });

  // Private bucket -> short-lived signed URL, opened in a new tab.
  const downloadFile = (f) =>
    run(async () => { const url = await firmApi.signedDownloadUrl(f.storagePath, 60); window.open(url, "_blank"); });

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
    const items = (eng?.items || []).filter((it) => filter === "all" || it.status === filter);
    const map = new Map();
    items.forEach((it) => { if (!map.has(it.category)) map.set(it.category, []); map.get(it.category).push(it); });
    return [...map.entries()];
  }, [eng, filter]);

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
  if (!session) return <AuthScreen />;
  if (profile === undefined) return <div className="tk-boot">Loading…</div>;
  if (!profile || !profile.approved)
    return <PendingApprovalScreen email={session.user?.email} onSignOut={signOut} />;

  return (
    <div className="tk-root">
      {/* Top bar */}
      <header className="tk-top">
        <div className="tk-brand">
          <Tick size={20} />
          <span className="tk-word">Tickmark</span>
          <span className="tk-tag">PBC portal · firm</span>
        </div>
        <div className="tk-top-right">
          {view === "engagement" && (
            <button className="tk-btn ghost" onClick={goDashboard}>← ภาพรวม</button>
          )}
          {view === "engagement" && engagements.length > 0 && (
            <select className="tk-select" value={currentId || ""} onChange={(e) => openEngagement(e.target.value)}>
              {engagements.map((e) => {
                const x = engExpiry(e);
                const tag = x.state === "expired" ? " · หมดอายุ" : x.state === "soon" ? ` · เหลือ ${x.daysLeft} วัน` : "";
                return <option key={e.id} value={e.id}>{e.client}{tag}</option>;
              })}
            </select>
          )}
          <button className="tk-btn primary" onClick={() => setModal("generate")}><Tick size={13} /> New portal</button>
          <span style={{ fontSize: 12, color: "#9db8ac", fontFamily: "'JetBrains Mono', monospace" }}>{session.user?.email}</span>
          <button className="tk-icon" title="ออกจากระบบ" onClick={signOut}>⎋</button>
        </div>
      </header>

      {err && (
        <div className="tk-purge">{err}<button onClick={() => setErr("")}>✕</button></div>
      )}

      {view === "dashboard" ? (
        <FirmDashboard dash={dash} onOpen={openEngagement} onNew={() => setModal("generate")} />
      ) : !eng ? (
        <div className="tk-boot">กำลังโหลดพอร์ทัล…</div>
      ) : engExpiry(eng).state === "expired" ? (
        <ExpiredScreen key={eng.id} eng={eng} role="firm"
          onExtend={(days) => extendEng(eng.id, days)}
          onDelete={() => deleteEng(eng.id)} />
      ) : (
        <main className="tk-main">
          {/* Engagement header + progress ledger */}
          <section className="tk-head">
            <div>
              <p className="tk-eyebrow">{eng.template}</p>
              <h1 className="tk-client">{eng.client}</h1>
              <p className="tk-meta">
                Period end <b>{fmtDate(eng.periodEnd)}</b> · {stats.total} items
                {stats.overdue > 0 && <span className="tk-od"> · {stats.overdue} overdue</span>}
              </p>
              {(() => {
                const x = engExpiry(eng);
                if (x.state === "none") return null;
                const cls = x.state === "soon" ? "soon" : "ok";
                return (
                  <p className={`tk-expiry ${cls}`}>
                    🗓 หมดอายุ {fmtDate(eng.expiresAt)} · เหลือ {x.daysLeft} วัน
                    {eng.autoDelete && <span className="tk-expiry-auto"> · ลบอัตโนมัติเมื่อหมดอายุ</span>}
                  </p>
                );
              })()}
            </div>
            <div className="tk-progress">
              <div className="tk-pct"><span>{stats.pct}</span><i>%</i></div>
              <div className="tk-ledger" aria-hidden="true">
                {eng.items.map((it) => (
                  <span key={it.id} className={`cell ${it.status === "accepted" ? "done" : isOverdue(it) ? "od" : it.status === "outstanding" ? "" : "wip"}`} />
                ))}
              </div>
              <p className="tk-progress-cap">{stats.by.accepted} of {stats.total} accepted</p>
            </div>
          </section>

          {/* Dashboard chips / filter */}
          <section className="tk-chips">
            <Chip active={filter === "all"} onClick={() => setFilter("all")} label="All" n={stats.total} tone="neutral" />
            {STATUS_ORDER.map((s) => (
              <Chip key={s} active={filter === s} onClick={() => setFilter(filter === s ? "all" : s)}
                label={STATUS[s].label} n={stats.by[s]} tone={STATUS[s].tone} glyph={STATUS[s].glyph} />
            ))}
          </section>

          {/* Toolbar */}
          <section className="tk-toolbar">
            <button className="tk-btn primary" onClick={() => setModal("generate")}><Tick size={13} /> Generate request list</button>
            <button className="tk-btn" onClick={() => importRef.current?.click()}>⤓ นำเข้าจาก Excel</button>
            <button className="tk-btn" onClick={() => setModal("add")}>+ Add item</button>
            <button className="tk-btn ghost" onClick={exportCSV}>↓ Export CSV</button>
            <button className="tk-btn ghost" onClick={() => {
              const link = `${location.origin}/client.html?e=${eng.id}`;
              navigator.clipboard?.writeText(link).catch(() => {});
              alert("คัดลอกลิงก์สำหรับลูกค้าแล้ว (ส่งรหัส 16 หลักแยกช่องทาง):\n\n" + link);
            }}>🔗 ลิงก์ลูกค้า</button>
            <button className="tk-btn ghost" onClick={() => setModal("settings")}>⚙ ตั้งค่าพอร์ทัล</button>
            {busy && <span className="tk-hint">กำลังบันทึก…</span>}
            <input ref={importRef} type="file" accept=".xlsx,.xls" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files[0]; if (f) handleImportFile(f); e.target.value = ""; }} />
          </section>

          {/* Grouped list */}
          {grouped.length === 0 ? (
            <p className="tk-none">No items match this filter.</p>
          ) : grouped.map(([cat, items]) => (
            <section key={cat} className="tk-group">
              <div className="tk-group-head">
                <span className="tk-cat">{cat}</span>
                <span className="tk-rule" />
                <span className="tk-count">{items.filter((i) => i.status === "accepted").length}/{items.length}</span>
              </div>
              <ul className="tk-rows">
                {items.map((it) => (
                  <li key={it.id} className={`tk-row ${openItem === it.id ? "open" : ""}`} onClick={() => setOpenItem(it.id)}>
                    <span className="tk-ref">{it.ref}</span>
                    <div className="tk-desc">
                      <span className="tk-desc-main">{it.description}{it.required && <i className="tk-req" title="Required">•</i>}</span>
                      <span className="tk-desc-sub">
                        {it.files.length > 0 && <span className="tk-files-mini">{it.files.length} file{it.files.length > 1 ? "s" : ""}</span>}
                        <span className={`tk-due ${isOverdue(it) ? "od" : ""}`}>Due {fmtDate(it.dueDate)}</span>
                      </span>
                    </div>
                    <Pill status={it.status} />
                    <span className="tk-chev">›</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <footer className="tk-foot">Firm workspace · {eng.items.length} items · backed by Supabase (RLS-scoped)</footer>
        </main>
      )}

      {/* Item drawer */}
      {drawerItem && (
        <Drawer item={drawerItem} role="firm" busy={busy} onClose={() => setOpenItem(null)}
          onSetStatus={setStatus} onDelete={deleteItem} onDownload={downloadFile} />
      )}

      {/* Modals */}
      {modal === "generate" && <GenerateModal busy={busy} onClose={() => setModal(null)} onCreate={generateEngagement} />}
      {modal === "add" && eng && <AddItemModal eng={eng} onClose={() => setModal(null)} onAdd={addItem} />}
      {modal === "import" && importDraft && (
        <ImportModal draft={importDraft} onClose={() => { setModal(null); setImportDraft(null); }} onImport={importEngagement} />
      )}
      {modal === "settings" && eng && (
        <PortalSettingsModal eng={eng} onClose={() => setModal(null)}
          onSavePasscode={(code) => setEngPasscode(eng.id, code)}
          onSaveRetention={(days, autoDelete) => setEngRetention(eng.id, days, autoDelete)}
          onDelete={() => deleteEng(eng.id)} />
      )}
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

  const ready = email.trim() && password.length >= 6 && (mode === "signin" || firmName.trim());

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setErr(""); setInfo("");
    try {
      if (mode === "signup") {
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
    <div className="tk-root">
      <header className="tk-top">
        <div className="tk-brand">
          <Tick size={20} />
          <span className="tk-word">Tickmark</span>
          <span className="tk-tag">PBC portal · firm</span>
        </div>
      </header>
      <div className="tk-lock">
        <div className="tk-lock-card" style={{ textAlign: "left" }}>
          <div className="tk-lock-icon" style={{ textAlign: "center" }}>🏢</div>
          <h2 style={{ textAlign: "center" }}>{mode === "signin" ? "เข้าสู่ระบบสำนักงาน" : "สมัครสำนักงานใหม่"}</h2>
          <p className="tk-muted" style={{ textAlign: "center", marginBottom: 18 }}>
            {mode === "signin" ? "สำหรับพนักงานสำนักงาน — เห็นเฉพาะงานของสำนักงานคุณ" : "สร้างบัญชีสำนักงานของคุณเพื่อเริ่มสร้างพอร์ทัล"}
          </p>

          {mode === "signup" && (
            <>
              <label className="tk-field"><span>ชื่อสำนักงาน (Firm)</span>
                <input value={firmName} onChange={(e) => setFirmName(e.target.value)} placeholder="เช่น Tickmark & Co." /></label>
              <label className="tk-field"><span>ชื่อผู้ใช้ (ไม่บังคับ)</span>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="เช่น Jane CPA" /></label>
            </>
          )}
          <label className="tk-field"><span>อีเมล</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@firm.com" /></label>
          <label className="tk-field"><span>รหัสผ่าน (≥ 6 ตัว)</span>
            <input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()} placeholder="••••••••" /></label>

          {err && <p className="tk-lock-err">{err}</p>}
          {info && <p className="tk-lock-demo">{info}</p>}

          <button className="tk-btn primary full" disabled={!ready || busy} onClick={submit}>
            {busy ? "กำลังดำเนินการ…" : mode === "signin" ? "เข้าสู่ระบบ" : "สมัครและเริ่มใช้งาน"}
          </button>
          <button type="button" className="tk-link" style={{ display: "block", margin: "12px auto 0" }}
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setErr(""); setInfo(""); }}>
            {mode === "signin" ? "ยังไม่มีบัญชี? สมัครสำนักงานใหม่" : "มีบัญชีแล้ว? เข้าสู่ระบบ"}
          </button>
          {!SUPABASE_CONFIGURED && (
            <p className="tk-lock-demo" style={{ marginTop: 12 }}>⚠ ยังไม่ได้ตั้งค่า backend (.env.local)</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Account pending approval ----------------------------------- */
function PendingApprovalScreen({ email, onSignOut }) {
  return (
    <div className="tk-root">
      <header className="tk-top">
        <div className="tk-brand">
          <Tick size={20} />
          <span className="tk-word">Tickmark</span>
          <span className="tk-tag">PBC portal · firm</span>
        </div>
        <div className="tk-top-right">
          <button className="tk-icon" title="ออกจากระบบ" onClick={onSignOut}>⎋</button>
        </div>
      </header>
      <div className="tk-lock">
        <div className="tk-lock-card">
          <div className="tk-lock-icon">⏳</div>
          <h2>บัญชีรอการอนุมัติ</h2>
          <p className="tk-muted">
            สมัครสำเร็จแล้ว — บัญชี <b>{email}</b> กำลังรอผู้ดูแลระบบอนุมัติ
            เมื่อได้รับอนุมัติแล้วจึงจะเริ่มสร้างพอร์ทัลได้
          </p>
          <p className="tk-lock-foot">โปรดติดต่อผู้ดูแลระบบ หรือลองเข้าสู่ระบบใหม่อีกครั้งภายหลัง</p>
          <button className="tk-btn full" onClick={onSignOut}>ออกจากระบบ</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Firm dashboard: all portals + progress + search ------------ */
function FirmDashboard({ dash, onOpen, onNew }) {
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const list = dash || [];
    const s = q.trim().toLowerCase();
    if (!s) return list;
    return list.filter((e) => `${e.client} ${e.template}`.toLowerCase().includes(s));
  }, [dash, q]);

  const totals = useMemo(() => {
    const list = dash || [];
    const items = list.reduce((n, e) => n + (e.total || 0), 0);
    const accepted = list.reduce((n, e) => n + (e.accepted || 0), 0);
    return { count: list.length, items, accepted, pct: items ? Math.round((accepted / items) * 100) : 0 };
  }, [dash]);

  if (dash === null) return <div className="tk-boot">กำลังโหลดภาพรวม…</div>;

  return (
    <main className="tk-main">
      <section className="tk-head">
        <div>
          <p className="tk-eyebrow">ภาพรวมทั้งหมด</p>
          <h1 className="tk-client">Engagements</h1>
          <p className="tk-meta">
            {totals.count} พอร์ทัล · <b>{totals.accepted}</b>/{totals.items} รายการรับแล้ว · {totals.pct}%
          </p>
        </div>
        <button className="tk-btn primary" onClick={onNew}><Tick size={13} /> New portal</button>
      </section>

      <section className="tk-toolbar">
        <input className="tk-search" type="search" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 ค้นหาชื่อลูกค้า หรือ template…" />
        {q && <span className="tk-hint">พบ {filtered.length} จาก {dash.length}</span>}
      </section>

      {dash.length === 0 ? (
        <div className="tk-empty">
          <Tick size={40} />
          <h2>ยังไม่มีพอร์ทัล</h2>
          <p>สร้างพอร์ทัลแรกจาก template เพื่อเริ่มงาน</p>
          <button className="tk-btn primary" onClick={onNew}>Generate request list</button>
        </div>
      ) : filtered.length === 0 ? (
        <p className="tk-none">ไม่พบพอร์ทัลที่ตรงกับ “{q}”</p>
      ) : (
        <div className="tk-dash-grid">
          {filtered.map((e) => <EngagementCard key={e.id} e={e} onOpen={() => onOpen(e.id)} />)}
        </div>
      )}
    </main>
  );
}

function EngagementCard({ e, onOpen }) {
  const x = engExpiry(e);
  const tone = e.pct >= 100 ? "done" : e.pct > 0 ? "wip" : "";
  return (
    <button className="tk-dash-card" onClick={onOpen}>
      <div className="tk-dash-top">
        <div className="tk-dash-titles">
          <p className="tk-eyebrow" style={{ margin: 0 }}>{e.template}</p>
          <h3>{e.client}</h3>
        </div>
        <span className="tk-dash-pct"><b>{e.pct}</b><i>%</i></span>
      </div>
      <div className={`tk-dash-bar ${tone}`}><span style={{ width: `${e.pct}%` }} /></div>
      <p className="tk-dash-sub">
        <span>{e.accepted}/{e.total} รับแล้ว</span>
        {x.state !== "none" && (
          <span className={x.state === "expired" ? "od" : x.state === "soon" ? "soon" : ""}>
            {" · "}{x.state === "expired" ? "หมดอายุ" : `เหลือ ${x.daysLeft} วัน`}
          </span>
        )}
      </p>
      <div className="tk-dash-chips">
        {STATUS_ORDER.filter((s) => e.by?.[s]).map((s) => (
          <span key={s} className={`tk-pill ${STATUS[s].tone}`}>
            <span className="g">{STATUS[s].glyph}</span>{e.by[s]}
          </span>
        ))}
      </div>
    </button>
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
          <div className="tk-lock-icon">🔒</div>
          <h2>พอร์ทัลนี้ยังไม่ได้ตั้งรหัส</h2>
          <p className="tk-muted">โปรดติดต่อทางสำนักงาน (Firm) เพื่อให้ตั้งรหัสเข้าพอร์ทัลก่อนใช้งาน</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tk-lock">
      <div className="tk-lock-card">
        <div className="tk-lock-icon">🔒</div>
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
            <button className="tk-btn danger full"
              onClick={() => { if (confirm("ลบพอร์ทัลนี้และเอกสารทั้งหมดอย่างถาวร?")) onDelete(); }}>
              ลบพอร์ทัลนี้ถาวร
            </button>
          </>
        ) : (
          <p className="tk-muted">โปรดติดต่อทางสำนักงาน (Firm) หากยังต้องการส่งเอกสารเพิ่มเติม</p>
        )}
      </div>
    </div>
  );
}

function PortalSettingsModal({ eng, onClose, onSavePasscode, onSaveRetention, onDelete }) {
  const base = eng.createdAt || Date.now();
  const currentDays = eng.expiresAt ? Math.round((eng.expiresAt - base) / DAY) : null;
  const matched = RETENTION_OPTIONS.find((o) => o.days === currentDays);
  const [days, setDays] = useState(matched ? matched.days : null);
  const [autoDelete, setAutoDelete] = useState(!!eng.autoDelete);
  const [showPass, setShowPass] = useState(false);
  const [code, setCode] = useState("");
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

      <div style={{ height: 18 }} />
      <p className="tk-block-h">ลบพอร์ทัล</p>
      <button className="tk-btn danger full"
        onClick={() => { if (confirm(`ลบพอร์ทัลของ ${eng.client} และเอกสารทั้งหมดอย่างถาวร?`)) onDelete(); }}>
        ลบพอร์ทัลนี้ถาวร
      </button>
    </Modal>
  );
}

function Drawer({ item, role, onClose, onUpload, onRemoveFile, onSetStatus, onDelete, onDownload, busy }) {
  const fileRef = useRef(null);
  const [note, setNote] = useState(item.note || "");
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

        <h3 className="tk-drawer-title">{item.description}</h3>
        <p className="tk-drawer-meta">{item.category} · {item.required ? "Required" : "Optional"} · Due {fmtDate(item.dueDate)}{isOverdue(item) && <span className="tk-od"> (overdue)</span>}</p>

        {item.status === "returned" && item.note && (
          <div className="tk-callout rust"><b>Returned by firm:</b> {item.note}</div>
        )}

        {/* Files */}
        <div className="tk-block">
          <p className="tk-block-h">Documents</p>
          {item.files.length === 0 && <p className="tk-muted">No files yet.</p>}
          <ul className="tk-filelist">
            {item.files.map((f, i) => (
              <li key={i}>
                <span className="tk-fileicon">▤</span>
                <span className="tk-fileinfo"><b>{f.name}</b><i>{fmtSize(f.size)} · {fmtDate(f.uploadedAt)}</i></span>
                {role === "firm" && onDownload && (
                  <button className="tk-x" disabled={busy} onClick={() => onDownload(f)}>download</button>
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

        {/* Firm actions */}
        {role === "firm" && (
          <div className="tk-block">
            <p className="tk-block-h">Review</p>
            {["submitted", "review"].includes(item.status) ? (
              <>
                {item.status === "submitted" && (
                  <button className="tk-btn full" onClick={() => onSetStatus(item.id, "review", "Firm", "Started review")}>Start review</button>
                )}
                <button className="tk-btn primary full" onClick={() => onSetStatus(item.id, "accepted", "Firm", "Accepted")}>{<Tick size={13} />} Accept</button>
                <textarea className="tk-note" placeholder="Reason for return (sent to client)…" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="tk-btn rust full" disabled={!note.trim()}
                  onClick={() => { onSetStatus(item.id, "returned", "Firm", "Returned", { note: note.trim() }); }}>↩ Return to client</button>
              </>
            ) : item.status === "accepted" ? (
              <button className="tk-btn ghost full" onClick={() => onSetStatus(item.id, "outstanding", "Firm", "Reopened", { note: "" })}>Reopen item</button>
            ) : (
              <p className="tk-muted">Waiting on the client to upload a document.</p>
            )}
            <button className="tk-btn danger full" onClick={() => onDelete(item.id)}>Delete item</button>
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
    </>
  );
}

function GenerateModal({ onClose, onCreate, busy }) {
  const [tplKey, setTplKey] = useState(TEMPLATES[0].key);
  const [client, setClient] = useState("");
  const [periodEnd, setPeriodEnd] = useState(new Date(new Date().getFullYear() - 1, 11, 31).toISOString().slice(0, 10));
  const [due, setDue] = useState(new Date(Date.now() + 14 * DAY).toISOString().slice(0, 10));
  const [code, setCode] = useState("");
  const [retDays, setRetDays] = useState(90);
  const [autoDelete, setAutoDelete] = useState(true);
  const tpl = TEMPLATES.find((t) => t.key === tplKey);
  const count = tpl.groups.reduce((n, [, rows]) => n + rows.length, 0);
  const ready = client.trim() && code.length === 16;
  const create = () => {
    if (!ready) return;
    onCreate({
      tplKey, client: client.trim(),
      periodEnd: new Date(periodEnd).getTime(), baseDue: new Date(due).getTime(),
      code, retDays, autoDelete,   // raw code — the DB hashes it (create_engagement)
    });
  };
  return (
    <Modal title="Generate request list" onClose={onClose}>
      <label className="tk-field"><span>Template</span>
        <select value={tplKey} onChange={(e) => setTplKey(e.target.value)}>
          {TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select>
      </label>
      <p className="tk-tplblurb">{tpl.blurb} <b>{count} items</b> across {tpl.groups.length} sections.</p>
      <label className="tk-field"><span>Client name</span>
        <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="e.g. Northwind Trading Co." />
      </label>
      <div className="tk-field-row">
        <label className="tk-field"><span>Period end</span><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label>
        <label className="tk-field"><span>Default due date</span><input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
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
        <button className="tk-btn ghost" onClick={onClose}>Cancel</button>
        <button className="tk-btn primary" disabled={!ready || busy} onClick={create}>
          {busy ? "กำลังสร้าง…" : `Generate ${count} items`}
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
          onClick={() => onImport({ client: client.trim(), periodEnd: new Date(periodEnd).getTime(), baseDue: new Date(due).getTime(), items: included, code, retDays, autoDelete })}>
          ยืนยันสร้างลิสต์ ({included.length})
        </button>
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
