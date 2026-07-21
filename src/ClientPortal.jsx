// =====================================================================
//  ClientPortal — the login-less view a CLIENT sees.
//
//  ISOLATION GUARANTEE (why Client A can never see Client B's documents):
//    1. The entrance is per-client: client.html?e=<engagement_uuid>. The
//       engagement_id is only ever used for ONE thing — the unlock call.
//    2. unlock() requires the correct 16-digit code for THAT engagement.
//       Wrong code → 401; 5 wrong tries → 429 (15-min lock, enforced in the DB).
//    3. On success the server mints a session token BOUND to that one
//       engagement (portal_sessions.engagement_id). From then on every call
//       sends ONLY the token — never an engagement_id. The Edge Function
//       resolves the engagement from the token, so the client cannot pivot
//       to another portal by tampering with the URL or request body.
//    4. This component never imports or holds the firm's data. It is a
//       separate Vite entry (separate bundle) from the firm app.
//
//    => Editing the URL to Client B's id just lands on B's lock screen,
//       which still demands B's 16-digit code. No code, no data.
// =====================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clientApi } from "../lib/portalApi.js";
import { SUPABASE_CONFIGURED } from "../lib/supabaseClient.js";
import { FilePreviewModal, isPreviewable } from "./FilePreview.jsx";
import { CommentThread } from "./CommentThread.jsx";
import { ALLOWED_EXT, fileError } from "./uploadRules.js";
import { compressImage } from "./imageCompress.js";
import { Icon } from "./icons.jsx";
import { isPastDueDate } from "../lib/dateUtils.js";
import "./portal.css";
import "./deliverables.css";

/* ---------- status model (mirrors the firm app) ------------------------ */
const STATUS = {
  outstanding: { label: "Awaiting upload", glyph: "○", tone: "neutral" },
  submitted: { label: "Submitted", glyph: "↑", tone: "amber" },
  review: { label: "Under review", glyph: "◐", tone: "amberDeep" },
  accepted: { label: "Accepted", glyph: "✓", tone: "pine" },
  returned: { label: "Returned", glyph: "↩", tone: "rust" },
  reopened: { label: "Reopened", glyph: "↻", tone: "amber" },
};
const STATUS_ORDER = ["outstanding", "submitted", "review", "accepted", "returned", "reopened"];

// Thai labels + navy/mint chip tones + filter dots for the client view.
const TH = { outstanding: "รออัปโหลด", submitted: "รอตรวจ", review: "กำลังตรวจ", accepted: "ตรวจรับแล้ว", returned: "ส่งกลับแก้ไข", reopened: "เปิดใหม่" };
const CST = { outstanding: "slate", submitted: "amber", review: "amber", accepted: "mint", returned: "amber", reopened: "slate" };
const DOT = { outstanding: "#64748B", submitted: "#F59E0B", review: "#F59E0B", accepted: "#12B39A", returned: "#F59E0B", reopened: "#64748B" };
// Items the CLIENT still has to act on (upload / fix / re-send).
const needsAction = (it) => ["outstanding", "returned", "reopened"].includes(it.status) || isOverdue(it);
// Navy/mint status pill (accounts for overdue).
function clientChip(it) {
  if (isOverdue(it)) return { tone: "red", label: "⚠ เกินกำหนด" };
  return { tone: CST[it.status], label: `${STATUS[it.status].glyph} ${TH[it.status]}` };
}

/* ---------- small helpers ---------------------------------------------- */
const onlyDigits = (s) => s.replace(/\D+/g, "").slice(0, 16);
const groupDigits = (s) => s.replace(/(.{4})/g, "$1 ").trim();
const fmtDate = (ts) =>
  !ts ? "—" : new Date(ts).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
const fmtSize = (b) =>
  b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(0) + " KB"
    : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB" : (b / 1073741824).toFixed(2) + " GB";
const isOverdue = (it) => it.status !== "accepted" && isPastDueDate(it.dueDate);
const fileExt = (name) => (name.includes(".") ? name.split(".").pop().slice(0, 4).toUpperCase() : "ไฟล์");

// `accept` for the upload <input>, derived from uploadRules.js's ALLOWED_EXT
// so the two lists can't drift apart (one source of truth for what's allowed).
const ACCEPT_ATTR = ALLOWED_EXT.map((e) => `.${e}`).join(",");

// The client has no login, so "which firm comments have I read" lives in
// localStorage per engagement: { itemId: seenAtMs }.
const seenKey = (engId) => `cseen_${engId}`;
const getSeen = (engId) => { try { return JSON.parse(localStorage.getItem(seenKey(engId)) || "{}"); } catch { return {}; } };
const writeSeen = (engId, map) => { try { localStorage.setItem(seenKey(engId), JSON.stringify(map)); } catch { /* private mode */ } };

// Session token cache (per engagement, this tab only). Survives a refresh
// within the 8h window so the client isn't re-prompted on every reload.
const tokenKey = (engId) => `pbc:client:session:${engId}`;
function loadToken(engId) {
  try {
    const raw = sessionStorage.getItem(tokenKey(engId));
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (!token || (expiresAt && expiresAt < Date.now())) return null;
    return token;
  } catch {
    return null;
  }
}
function saveToken(engId, token, expiresAt) {
  try {
    sessionStorage.setItem(tokenKey(engId), JSON.stringify({ token, expiresAt }));
  } catch {}
}
function clearToken(engId) {
  try {
    sessionStorage.removeItem(tokenKey(engId));
  } catch {}
}

/* ---------- presentational bits ---------------------------------------- */
function Tick({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className="tk-glyph">
      <path d="M3 13.5l5.2 5.5L21 4.5" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// One load cycle's worth of period-aware data: the active period's items,
// the full period list (for the switcher), and that period's deliverables.
// Shared by SinglePortal and GroupCompany so their near-identical `load()`
// functions can't drift on how periods/deliverables get resolved against
// fetchData's server-chosen `activePeriodId` (omit periodId → newest OPEN
// period, falling back to newest overall once every month is closed).
// Deliverables are best-effort: a hiccup there must never block the
// (more important) request list from loading.
async function loadPeriodContext(token, engagementId, periodId) {
  const [{ engagement, items, activePeriodId }, periods] = await Promise.all([
    clientApi.fetchData(token, engagementId, periodId),
    clientApi.listPeriods(token, engagementId),
  ]);
  let deliverables = [];
  try {
    deliverables = await clientApi.listDeliverables(token, engagementId, activePeriodId);
  } catch {
    /* deliverables tab will just show its empty state until a refresh works */
  }
  return { engagement, items, activePeriodId, periods, deliverables };
}

/* ======================================================================= */
export default function ClientPortal() {
  const { engagementId, groupId } = useMemo(() => {
    const p = new URLSearchParams(location.search);
    return { engagementId: p.get("e") || "", groupId: p.get("g") || "" };
  }, []);
  if (groupId && !engagementId) return <GroupPortal groupId={groupId} />;
  return <SinglePortal engagementId={engagementId} />;
}

/* ---------- single-portal flow (client.html?e=…) ----------------------- */
function SinglePortal({ engagementId }) {
  const [phase, setPhase] = useState("init"); // init | locked | loading | ready
  const [token, setToken] = useState(null);
  const [eng, setEng] = useState(null);
  const [items, setItems] = useState([]);
  const [loadErr, setLoadErr] = useState("");
  const [periods, setPeriods] = useState([]);
  const [activePeriodId, setActivePeriodId] = useState(null);
  const [deliverables, setDeliverables] = useState([]);

  // Try a cached session on first paint.
  useEffect(() => {
    if (!engagementId) {
      setPhase("nolink");
      return;
    }
    const cached = loadToken(engagementId);
    if (cached) {
      setToken(cached);
      void load(cached);
    } else {
      setPhase("locked");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engagementId]);

  // periodId omitted (null) → server resolves the newest open period and
  // reports it back as activePeriodId; passed explicitly → the client asked
  // to look at a specific month via the period switcher.
  async function load(tok, periodId = null) {
    setPhase("loading");
    setLoadErr("");
    try {
      const r = await loadPeriodContext(tok, engagementId, periodId);
      setEng(r.engagement);
      setItems(r.items);
      setActivePeriodId(r.activePeriodId);
      setPeriods(r.periods);
      setDeliverables(r.deliverables);
      setPhase("ready");
    } catch (e) {
      // Session gone/expired → back to the lock screen.
      if (e.status === 401) {
        clearToken(engagementId);
        setToken(null);
        setPhase("locked");
      } else {
        setLoadErr(e.message || "โหลดข้อมูลไม่สำเร็จ");
        setPhase("ready");
      }
    }
  }

  async function handleUnlock(code) {
    const { token: tok, expiresAt } = await clientApi.unlock(engagementId, code);
    saveToken(engagementId, tok, expiresAt);
    setToken(tok);
    await load(tok);
  }

  function lock() {
    clearToken(engagementId);
    setToken(null);
    setEng(null);
    setItems([]);
    setPeriods([]);
    setActivePeriodId(null);
    setDeliverables([]);
    setPhase("locked");
  }

  // Stay on whichever period the client was looking at (uploads etc. don't
  // change the active period; only the switcher does, via changePeriod).
  async function refresh() {
    if (token) await load(token, activePeriodId);
  }

  function changePeriod(periodId) {
    if (token) void load(token, periodId);
  }

  // Opening a file stamps viewed_at server-side (that's the whole point —
  // "was told" vs "actually looked"); mirror it locally so the row's state
  // flips immediately instead of waiting on a round trip.
  function markDeliverableOpened(deliverableId) {
    setDeliverables((ds) => ds.map((d) => (d.id === deliverableId ? { ...d, viewedAt: d.viewedAt || Date.now() } : d)));
  }

  async function ackDeliverable(deliverableId) {
    await clientApi.ackDeliverable(token, deliverableId, engagementId);
    setDeliverables((ds) => ds.map((d) => (d.id === deliverableId ? { ...d, status: "acknowledged", acknowledgedAt: Date.now() } : d)));
  }

  // The client's "this isn't right" verb — mirrors the firm's returnItem for
  // request items. Server clears acknowledged_at too (asking for a fix
  // withdraws any prior ack of this revision); mirror that locally as well
  // so the row can't show both "acknowledged" and "revision requested" at
  // once even for the instant before the next refresh.
  async function requestRevision(deliverableId, note) {
    await clientApi.requestDeliverableRevision(token, deliverableId, engagementId, note);
    setDeliverables((ds) => ds.map((d) => (d.id === deliverableId
      ? { ...d, status: "revision_requested", revisionNote: note, acknowledgedAt: null }
      : d)));
  }

  /* ---- render ---- */
  if (phase === "nolink")
    return (
      <Shell secure>
        <div className="nv-lockwrap">
          <div className="nv-lockcard">
            <div className="nv-lock-hd">
              <span className="nv-lock-ic"><Icon name="link" size={28} /></span>
              <div className="nv-lock-eyebrow">Secure document access</div>
              <div className="nv-lock-title">ลิงก์ไม่สมบูรณ์</div>
            </div>
            <div className="nv-lock-body">
              <p className="nv-lock-lead">ลิงก์เข้าพอร์ทัลไม่ถูกต้อง — โปรดเปิดจากลิงก์ที่สำนักงานส่งให้ (ต้องมีรหัสพอร์ทัลใน URL)</p>
            </div>
          </div>
        </div>
      </Shell>
    );

  if (phase === "init")
    return (
      <Shell>
        <div className="tk-boot" style={{ color: "#64748B" }}>Loading…</div>
      </Shell>
    );

  if (phase === "locked")
    return (
      <Shell secure>
        <LockScreen onUnlock={handleUnlock} />
      </Shell>
    );

  return (
    <Shell onLock={lock}>
      <ClientList
        phase={phase}
        eng={eng}
        items={items}
        loadErr={loadErr}
        token={token}
        engagementId={engagementId}
        onUploaded={refresh}
        periods={periods}
        activePeriodId={activePeriodId}
        onPeriodChange={changePeriod}
        deliverables={deliverables}
        onDeliverableOpened={markDeliverableOpened}
        onAck={ackDeliverable}
        onRequestRevision={requestRevision}
      />
    </Shell>
  );
}

/* ---------- chrome (navy top bar) -------------------------------------- */
function Shell({ children, onLock, secure = false }) {
  return (
    <div className="tk-root nv">
      <div className="nv-top">
        <div className="nv-brand">
          <span className="mk"><Tick size={17} /></span>
          <span className="wd">Tickmark</span>
          <span className="nv-pill">PBC Portal</span>
        </div>
        <div className="nv-top-right">
          {secure && <span className="nv-secure"><span className="lk"><Icon name="lock" size={12} /></span>การเชื่อมต่อปลอดภัย</span>}
          {onLock && (
            <span className="nv-icon" title="ออกจากพอร์ทัล" onClick={onLock}>⎋</span>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

/* ---------- lock screen (3a) ------------------------------------------- */
function LockScreen({ onUnlock }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);

  const submit = async () => {
    if (code.length !== 16 || busy) return;
    setBusy(true);
    setErr("");
    try {
      await onUnlock(code);
    } catch (e) {
      if (e.status === 429) setErr("กรอกผิดหลายครั้งเกินไป — โปรดลองใหม่ภายหลัง (~15 นาที)");
      else if (e.status === 409) setErr("พอร์ทัลนี้อยู่ในกลุ่ม — โปรดเข้าผ่านลิงก์กลุ่มที่สำนักงานส่งให้");
      else if (e.status === 401) setErr("รหัสไม่ถูกต้อง — กรุณาลองใหม่อีกครั้ง");
      else setErr(e.message || "เข้าพอร์ทัลไม่สำเร็จ");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  // The box the caret sits in while typing (−1 = none: unfocused or complete).
  const activeIdx = focused && code.length < 16 ? Math.floor(code.length / 4) : -1;

  return (
    <div className="nv-lockwrap">
      <div className="nv-lockcard">
        <div className="nv-lock-hd">
          <span className="nv-lock-ic"><Icon name="lock" size={28} /></span>
          <div className="nv-lock-eyebrow">Secure document access</div>
          <div className="nv-lock-title">เอกสารที่ต้องจัดเตรียม</div>
        </div>
        <div className="nv-lock-body">
          <p className="nv-lock-lead">กรอกรหัส 16 หลักที่สำนักงานส่งให้ทางอีเมลเพื่อปลดล็อกพอร์ทัลเอกสารของคุณ</p>
          <label className="nv-otp-entry">
            <input
              className="nv-otp-native"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={groupDigits(code)}
              aria-label="รหัสเข้าพอร์ทัล 16 หลัก"
              onChange={(e) => {
                setCode(onlyDigits(e.target.value));
                setErr("");
              }}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <span className="nv-otp" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => {
                const typed = code.slice(i * 4, i * 4 + 4);
                const isCaret = i === activeIdx;
                return (
                  <span className={`nv-otp-box ${typed ? "on" : ""} ${isCaret ? "caret" : ""}`} key={i}>
                    {isCaret ? <>{typed}<i className="nv-caret" /></> : (typed ? typed.padEnd(4, "0") : "0000")}
                  </span>
                );
              })}
            </span>
          </label>
          {err && <p className="nv-lock-err">{err}</p>}
          <button className="nv-lock-cta" disabled={code.length !== 16 || busy} onClick={submit}>
            {busy ? "กำลังตรวจสอบ…" : <>เข้าสู่พอร์ทัล →</>}
          </button>
          <p className="nv-lock-note">
            <span style={{ flex: "none" }}><Icon name="lock" size={13} /></span>
            รหัสนี้ใช้ได้เฉพาะพอร์ทัลของคุณเท่านั้น — ไม่ต้องสมัครสมาชิก
          </p>
          {!SUPABASE_CONFIGURED && (
            <p className="nv-lock-demo">
              ⚠ ยังไม่ได้ตั้งค่า backend — คัดลอก <b>.env.example</b> เป็น <b>.env.local</b> แล้วใส่ค่าจาก Supabase
              (การกดปลดล็อกจะยัง fail จนกว่าจะตั้งค่า + deploy Edge Function)
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- multi-select filter card (status / category) --------------- */
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

/* ---------- the request list + uploads (3c) ---------------------------- */
function ClientList({
  phase, eng, items, loadErr, token, engagementId, onUploaded,
  periods, activePeriodId, onPeriodChange,
  deliverables, onDeliverableOpened, onAck, onRequestRevision,
}) {
  // Which of the two segment views is showing. Local (not lifted) — nothing
  // outside this component needs to know, and it's fine for it to reset to
  // "requests" whenever a fresh portal/company mounts.
  const [view, setView] = useState("requests"); // "requests" | "deliverables"
  const [statusSel, setStatusSel] = useState([]);   // status filters (empty = all; may include "action"/"overdue")
  const [catSel, setCatSel] = useState([]);          // category filters (empty = all)
  const [q, setQ] = useState("");
  const [seen, setSeen] = useState(() => getSeen(engagementId));   // read firm-comments (localStorage)
  const [openCommentsId, setOpenCommentsId] = useState(null);       // item whose thread the unread card opened
  const markItemSeen = (itemId) => {
    const m = { ...getSeen(engagementId), [itemId]: Date.now() };
    writeSeen(engagementId, m); setSeen(m);
  };
  // Items with a firm comment newer than the client last read it.
  const unreadC = useMemo(
    () => items.filter((it) => it.lastFirmCommentAt && (!seen[it.id] || it.lastFirmCommentAt > seen[it.id])),
    [items, seen],
  );

  const stats = useMemo(() => {
    const by = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    items.forEach((it) => { by[it.status] = (by[it.status] || 0) + 1; });
    return { by, overdue: items.filter(isOverdue).length, action: items.filter(needsAction).length };
  }, [items]);

  // Category list (all items) with count + a worst-status dot for the left panel.
  const cats = useMemo(() => {
    const arr = []; const m = new Map();
    items.forEach((it) => {
      let c = m.get(it.category);
      if (!c) { c = { cat: it.category, count: 0, overdue: 0, action: 0 }; m.set(it.category, c); arr.push(c); }
      c.count++; if (isOverdue(it)) c.overdue++; if (needsAction(it)) c.action++;
    });
    return arr;
  }, [items]);

  const grouped = useMemo(() => {
    const s = q.trim().toLowerCase();
    const filtered = items.filter((it) => {
      const passStatus = statusSel.length === 0 || statusSel.some((f) =>
        f === "overdue" ? isOverdue(it) : f === "action" ? needsAction(it) : it.status === f);
      const passCat = catSel.length === 0 || catSel.includes(it.category);
      const passText = !s || `${it.ref} ${it.description}`.toLowerCase().includes(s);
      return passStatus && passCat && passText;
    });
    const m = new Map();
    filtered.forEach((it) => {
      if (!m.has(it.category)) m.set(it.category, []);
      m.get(it.category).push(it);
    });
    return [...m.entries()];
  }, [items, statusSel, catSel, q]);

  const accepted = items.filter((i) => i.status === "accepted").length;
  const pending = items.filter((i) => i.status === "submitted" || i.status === "review").length;
  const pct = items.length ? Math.round((accepted / items.length) * 100) : 0;
  const firstOverdue = items.find(isOverdue);

  // The period the server actually served. A one-off audit portal has
  // exactly one period, so periods.length <= 1 is the "no switcher, no
  // period UI at all" case — it degrades to fully invisible below.
  const activePeriod = useMemo(
    () => periods.find((p) => p.id === activePeriodId) || null,
    [periods, activePeriodId],
  );
  const periodClosed = activePeriod?.status === "closed";
  // Monthly bookkeeping is the only engagement type that runs month after
  // month and sends work back. An audit portal shows the request list alone,
  // exactly as it did before periods existed.
  const monthly = eng?.cadence === "monthly";
  // "Unopened" = the client hasn't looked at a single file in it yet — the
  // literal reading of "unopened" for the segment-toggle badge, distinct
  // from "not yet acknowledged" (a deliverable can be opened but still
  // awaiting the confirm step). Gated on status === 'delivered' (not just
  // !viewedAt) so a 'revision_requested' deliverable never counts here: a
  // client can ask for a fix without having opened a file first (viewedAt
  // stays null), and the whole point of that status is "the ball is in the
  // firm's court" — badging it as something the client still owes would say
  // the opposite of what's true and undo the calm the status is meant to
  // convey. 'acknowledged' is excluded the same way (its viewedAt is set);
  // when a new revision lands, both viewedAt and status reset, so it becomes
  // unopened again exactly as it should.
  const unopenedCount = useMemo(() => deliverables.filter((d) => d.status === "delivered" && !d.viewedAt).length, [deliverables]);

  if (phase === "loading" && !eng)
    return <div className="nv-page"><div className="tk-boot" style={{ color: "#64748B" }}>กำลังโหลดรายการเอกสาร…</div></div>;

  return (
    <div className="nv-page">
      {eng && (
        <div className="nv-chead">
          <div className="nv-chead-l">
            <span className="nv-chead-name">{eng.client}</span>
            <span className="nv-chead-type">{eng.template}</span>
            <span className="nv-chead-meta">งวดสิ้นสุด {fmtDate(eng.periodEnd)} · {items.length} รายการ</span>
          </div>
          {items.length > 0 && (
            <div className="nv-chead-prog">
              <div className="row">
                <div className="bar">
                  <span className="a" style={{ width: `${pct}%` }} />
                  <span className="p" style={{ width: `${Math.round((pending / items.length) * 100)}%` }} />
                </div>
                <span className="pc">{pct}%</span>
              </div>
              <div className="cap">
                ตรวจรับแล้ว <b>{accepted}</b> / {items.length} รายการ
                {pending > 0 && <span className="pend"> · รอตรวจ {pending}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {loadErr && <p className="nv-lock-err" style={{ textAlign: "center" }}>{loadErr}</p>}

      {/* Only a monthly-bookkeeping portal has months to switch between or work
          sent back to show. A one-off audit portal is a single request list and
          nothing else, so it keeps the plain pre-periods layout — no toggle, no
          month picker, nothing new for a client to interpret. */}
      {monthly && (
        <ViewBar
          view={view} setView={setView} unopenedCount={unopenedCount}
          periods={periods} activePeriodId={activePeriodId} onPeriodChange={onPeriodChange}
        />
      )}

      {periodClosed && (
        <div className="dv-closed-note">
          <span className="ic"><Icon name="lock" size={14} /></span>
          <span>งวดนี้ปิดแล้ว — ดูเอกสารเดิมได้ตามปกติ แต่อัปโหลดเพิ่มไม่ได้ หากต้องการส่งเอกสารเพิ่มเติม กรุณาติดต่อสำนักงาน</span>
        </div>
      )}

      {view === "deliverables" && monthly ? (
        <DeliverablesList deliverables={deliverables} token={token} engagementId={engagementId} onOpened={onDeliverableOpened} onAck={onAck} onRequestRevision={onRequestRevision} />
      ) : items.length === 0 ? (
        <div className="nv-list"><div style={{ padding: "40px 16px", textAlign: "center", color: "#64748B", fontSize: 13 }}>ยังไม่มีรายการเอกสารในพอร์ทัลนี้</div></div>
      ) : (
        <div className="nv-work">
          {/* LEFT: search, alert, status filters, category groups */}
          <aside className="nv-aside">
            <div className="nv-isearch"><span>⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาเอกสาร…" /></div>
            {stats.overdue > 0 && (
              <div className="nv-alert" onClick={() => { setStatusSel(["overdue"]); setCatSel([]); }}>
                <span className="ic">⚠</span>
                <span>มี <b>{stats.overdue}</b> รายการเกินกำหนดส่ง{firstOverdue && ` — ${firstOverdue.description}`} · คลิกเพื่อดู</span>
              </div>
            )}
            {unreadC.length > 0 && (
              <div className="nv-alert cmt" onClick={() => { setOpenCommentsId(unreadC[0].id); setStatusSel([]); setCatSel([]); setQ(""); }}>
                <span className="ic"><Icon name="chat" size={14} /></span>
                <span>มี <b>{unreadC.length}</b> ความคิดเห็นใหม่จากสำนักงาน — {unreadC[0].description} · คลิกเพื่ออ่าน</span>
              </div>
            )}
            <MultiFilter label="สถานะ" placeholder={`ทุกสถานะ · ${items.length}`} selected={statusSel} onChange={setStatusSel}
              options={[
                ...(stats.action > 0 ? [{ value: "action", label: "⚠ ต้องดำเนินการ", count: stats.action, dot: "#EF4444" }] : []),
                ...STATUS_ORDER.map((s) => ({ value: s, label: TH[s], count: stats.by[s], dot: DOT[s] })),
                { value: "overdue", label: "เกินกำหนด", count: stats.overdue, dot: "#EF4444" },
              ]} />
            {cats.length > 0 && (
              <MultiFilter label="หมวดเอกสาร" placeholder={`ทุกหมวด · ${items.length}`} selected={catSel} onChange={setCatSel}
                options={cats.map((c) => ({ value: c.cat, label: c.cat, count: c.count }))} />
            )}
          </aside>

          {/* RIGHT: document request list */}
          <div>
            {grouped.length === 0 ? (
              <div className="nv-list"><div style={{ padding: "32px 16px", textAlign: "center", color: "#64748B", fontSize: 13 }}>ไม่มีรายการที่ตรงกับตัวกรองนี้</div></div>
            ) : (
              grouped.map(([cat, rows]) => (
                <div key={cat}>
                  <div className="nv-ghead">
                    <span className="gt">{cat}</span><span className="gline" />
                    <span className="gn">{rows.filter((i) => i.status === "accepted").length}/{rows.length}</span>
                  </div>
                  <div className="nv-list">
                    {rows.map((it, idx) => (
                      <ClientRow key={it.id} item={it} index={idx + 1} token={token} engagementId={engagementId} onUploaded={onUploaded}
                        autoOpen={openCommentsId === it.id} onSeen={() => markItemSeen(it.id)} periodClosed={periodClosed} />
                    ))}
                  </div>
                </div>
              ))
            )}
            <p className="nv-cfoot">เอกสารถูกเก็บอย่างปลอดภัย · เข้าถึงได้เฉพาะพอร์ทัลของคุณ</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- segment toggle (requests / deliverables) + period switcher --
   Lives directly under the portal header regardless of which view is
   active or whether the request list is empty, since it's the only way to
   reach the deliverables tab. The period switcher degrades to nothing when
   there's only one period (annual audit portals never see it). --------- */
function ViewBar({ view, setView, unopenedCount, periods, activePeriodId, onPeriodChange }) {
  return (
    <div className="dv-bar">
      <div className="nv-seg dv-view-seg">
        <button className={view === "requests" ? "on" : ""} onClick={() => setView("requests")}>เอกสารที่ต้องส่ง</button>
        <button className={view === "deliverables" ? "on" : ""} onClick={() => setView("deliverables")}>
          งานส่งมอบ
          {unopenedCount > 0 && <span className="dv-badge">{unopenedCount}</span>}
        </button>
      </div>
      <PeriodSwitcher periods={periods} activePeriodId={activePeriodId} onChange={onPeriodChange} />
    </div>
  );
}

// Single-select month picker built from the same dropdown shell as
// MultiFilter (.nv-msf/.nv-msf-panel/.nv-msf-opt) so it inherits identical
// focus/hover/backdrop behaviour. Sorted by the numeric `sort` field, never
// by `label` (Thai display text isn't chronological) and never by
// `periodKey` alone (kept internal — never shown to the client).
function PeriodSwitcher({ periods, activePeriodId, onChange }) {
  const [open, setOpen] = useState(false);
  if (periods.length <= 1) return null; // one-off / annual portal → no period UI at all
  // A handful of periods at most — a plain sort per render is cheap enough
  // that memoizing it would just be ceremony (and can't sit before the
  // early return above without violating the rules of hooks anyway).
  const sorted = [...periods].sort((a, b) => b.sort - a.sort);
  const active = periods.find((p) => p.id === activePeriodId) || sorted[0];
  return (
    <div className="nv-msf dv-persw">
      <button className="nv-msf-btn" onClick={() => setOpen((o) => !o)}>
        <span className="nv-msf-val">
          {active?.label || "เลือกงวด"}
          {active?.status === "closed" && <span className="dv-closedtag">ปิดงวด</span>}
        </span>
        <span className="nv-msf-cv">▾</span>
      </button>
      {open && (
        <>
          <div className="nv-backdrop" onClick={() => setOpen(false)} />
          <div className="nv-msf-panel">
            {sorted.map((p) => (
              <button key={p.id} className={`nv-msf-opt ${p.id === activePeriodId ? "on" : ""}`}
                onClick={() => { onChange(p.id); setOpen(false); }}>
                <span className="nv-msf-ck">{p.id === activePeriodId ? "✓" : ""}</span>
                <span className="nv-msf-opt-lb">{p.label}</span>
                {p.status === "closed" && <span className="nv-msf-opt-ct">ปิดแล้ว</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- deliverables view — what the firm sent back ---------------- */
function DeliverablesList({ deliverables, token, engagementId, onOpened, onAck, onRequestRevision }) {
  const grouped = useMemo(() => {
    const m = new Map();
    [...deliverables].sort((a, b) => a.sort - b.sort).forEach((d) => {
      if (!m.has(d.category)) m.set(d.category, []);
      m.get(d.category).push(d);
    });
    return [...m.entries()];
  }, [deliverables]);

  // The common early case — the firm hasn't sent anything back yet this
  // period — must read as normal, not broken. No alarm color, no "error"
  // framing, just a calm explanation of what will appear here later.
  if (deliverables.length === 0) {
    return (
      <div className="nv-list">
        <div className="dv-empty">
          <span className="ic"><Icon name="inbox" size={20} /></span>
          <div>ยังไม่มีงานส่งมอบสำหรับงวดนี้</div>
          <div className="sub">เมื่อสำนักงานส่งเอกสารหรือรายงานให้ จะแสดงไว้ที่นี่</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {grouped.map(([cat, rows]) => (
        <div key={cat}>
          <div className="nv-ghead">
            <span className="gt">{cat}</span><span className="gline" />
            <span className="gn">{rows.length} รายการ</span>
          </div>
          <div className="nv-list">
            {rows.map((d) => (
              <DeliverableRow key={d.id} item={d} token={token} engagementId={engagementId} onOpened={onOpened} onAck={onAck} onRequestRevision={onRequestRevision} />
            ))}
          </div>
        </div>
      ))}
      <p className="nv-cfoot">เอกสารถูกเก็บอย่างปลอดภัย · เข้าถึงได้เฉพาะพอร์ทัลของคุณ</p>
    </div>
  );
}

function DeliverableRow({ item, token, engagementId, onOpened, onAck, onRequestRevision }) {
  const [preview, setPreview] = useState(null);
  const [err, setErr] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [requesting, setRequesting] = useState(false); // the "ขอแก้ไข" note form is open
  const [revNote, setRevNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [showC, setShowC] = useState(false);
  const [comments, setComments] = useState([]);
  const [loadingC, setLoadingC] = useState(false);
  const [sendingC, setSendingC] = useState(false);

  // Four states, visually distinct: unopened (new — the whole point of this
  // view), opened-but-not-acknowledged (waiting on the CLIENT), revision
  // requested (waiting on the FIRM — the client already acted, by asking),
  // and acknowledged (done, quiet). Tones follow DESIGN.md's semantic map:
  // info-blue = new information, mint = accepted/complete. "requested" gets
  // the same amber as "wait" — this codebase already overloads amber for
  // both "pending, it's your turn" (request items' returned/reopened) and
  // "pending, it's THEIRS" (request items' submitted/review); the DESIGN.md
  // rule that copy must never rely on color alone is exactly what lets that
  // work here too. What actually keeps "requested" from reading as a
  // client to-do is structural, not color: no action buttons render at all,
  // just their own note read back and a quiet reassurance line below.
  const unopened = item.status === "delivered" && !item.viewedAt;
  const stateCls = item.status === "acknowledged" ? "done"
    : item.status === "revision_requested" ? "requested"
    : unopened ? "new" : "wait";
  const chipTone = stateCls === "done" ? "mint" : stateCls === "new" ? "info" : "amber";
  const chipLabel = stateCls === "done" ? "✓ รับทราบแล้ว"
    : stateCls === "requested" ? "◐ รอสำนักงานแก้ไข"
    : stateCls === "new" ? "● ยังไม่ได้เปิด" : "◐ รอการรับทราบ";

  const openFile = async (f) => {
    setErr("");
    try {
      const url = await clientApi.deliverableFileUrl(token, f.id, engagementId);
      onOpened(item.id);
      if (isPreviewable(f)) setPreview({ file: f, url });
      else window.open(url, "_blank");
    } catch (e) {
      setErr(e.message || "เปิดไฟล์ไม่สำเร็จ");
    }
  };

  const confirmAck = async () => {
    setBusy(true);
    setErr("");
    try {
      await onAck(item.id);
      setConfirming(false);
    } catch (e) {
      setErr(e.message || "รับทราบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const submitRevision = async () => {
    const note = revNote.trim();
    if (!note || busy) return; // API rejects an empty note — never let an empty one reach it
    setBusy(true);
    setErr("");
    try {
      await onRequestRevision(item.id, note);
      setRequesting(false);
      setRevNote("");
    } catch (e) {
      setErr(e.message || "ส่งคำขอแก้ไขไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  // Same shape as ClientRow's thread wiring, on deliverable_comments instead
  // of item_comments. Unlike request items, listDeliverables doesn't return
  // a comment count (no deliverable-side equivalent of item_comments(count)
  // / last_firm_comment_at yet), so the toggle can't show "(n)" until it's
  // actually been opened once this session — an API gap, not a UI choice.
  const loadComments = async () => {
    setLoadingC(true);
    try { setComments(await clientApi.listDeliverableComments(token, item.id, engagementId)); }
    catch { /* keep prior */ }
    finally { setLoadingC(false); }
  };
  const toggleComments = () => {
    const next = !showC;
    setShowC(next);
    if (next) loadComments();
  };
  const sendComment = async (body) => {
    setSendingC(true);
    try { await clientApi.addDeliverableComment(token, item.id, engagementId, body); await loadComments(); }
    catch (e) { setErr(e.message || "ส่งความคิดเห็นไม่สำเร็จ"); }
    finally { setSendingC(false); }
  };

  return (
    <div className={`nv-crow dv-drow ${stateCls}`}>
      <div className="nv-crow-main">
        <div className="nv-crow-name">
          {item.title}
          {unopened && <span className="dv-new">ใหม่</span>}
          {/* "Make the revision legible": a corrected release must say so,
              not just silently replace the files — the client may remember
              asking for a fix and needs to see that this is that answer. */}
          {item.revision > 1 && <span className="dv-closedtag">ฉบับแก้ไขที่ {item.revision}</span>}
        </div>
        <div className="nv-crow-sub">
          <span className="dv-cat">{item.category}</span>
          {item.dueDate != null && <span className="dv-meta">กำหนดส่งภายใน {fmtDate(item.dueDate)}</span>}
          {item.deliveredAt != null && <span className="dv-meta">ส่งเมื่อ {fmtDate(item.deliveredAt)}</span>}
        </div>

        {item.note && (
          <div className="nv-cnote note">
            <b><Icon name="note" size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />หมายเหตุจากสำนักงาน:</b> {item.note}
          </div>
        )}

        {/* The client's own request, read back to them — so they know it
            was received and nothing is expected of them right now. Reuses
            the same .nv-cnote.note box request-item firm notes use, since
            it's the same kind of thing: a quoted note attached to the row. */}
        {item.status === "revision_requested" && (
          <div className="nv-cnote note">
            <b><Icon name="return" size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />คุณขอให้แก้ไข:</b> {item.revisionNote}
            <div className="dv-revnote-sub">สำนักงานได้รับคำขอแล้วและกำลังดำเนินการแก้ไข — ไม่ต้องทำอะไรเพิ่มในตอนนี้</div>
          </div>
        )}

        {item.files.length > 0 && (
          <ul className="nv-fchips">
            {item.files.map((f) => (
              <li key={f.id} className="nv-fchip">
                <span className="nv-ftype">{fileExt(f.name)}</span>
                <span className="nv-finfo"><b>{f.name}</b><i>{fmtSize(f.size)}</i></span>
                <button className="nv-fx" onClick={() => openFile(f)}>{isPreviewable(f) ? "ดู" : "ดาวน์โหลด"}</button>
              </li>
            ))}
          </ul>
        )}

        {item.status === "acknowledged" ? (
          <div className="dv-acked"><Icon name="check" size={13} />รับทราบแล้ว · {fmtDate(item.acknowledgedAt)}</div>
        ) : item.status === "revision_requested" ? null /* the note above says it all — no action, no button */ : confirming ? (
          // A deliberate two-step confirm, not a single click — acknowledging
          // is meaningful in a tax context and can't be undone, but the copy
          // stays plain rather than alarming.
          <div className="dv-ackconfirm">
            <p>เมื่อกดยืนยัน ระบบจะบันทึกว่าคุณได้รับเอกสารนี้แล้ว และไม่สามารถยกเลิกภายหลังได้</p>
            <div className="dv-ackbtns">
              <button className="nv-btn" disabled={busy} onClick={() => setConfirming(false)}>ยกเลิก</button>
              <button className="nv-upbtn" style={{ marginTop: 0 }} disabled={busy} onClick={confirmAck}>
                {busy ? "กำลังบันทึก…" : "ยืนยันรับทราบ"}
              </button>
            </div>
          </div>
        ) : requesting ? (
          // The note is required server-side (an empty rejection tells the
          // firm nothing), so the form leads with a concrete prompt rather
          // than a blank box — what a small-business owner actually has to
          // say is usually "this number is wrong" or "this name is
          // misspelled," so naming those examples up front makes writing a
          // real reason the easy path instead of a hurdle to get past.
          <div className="dv-revform">
            <p className="lead">บอกสำนักงานว่าอยากให้แก้ไขอะไร เช่น &ldquo;ยอดในใบเสร็จไม่ตรงกับที่จ่ายจริง&rdquo; หรือ &ldquo;ชื่อ/เลขผู้เสียภาษีสะกดผิด&rdquo;</p>
            <textarea
              value={revNote}
              onChange={(e) => setRevNote(e.target.value.slice(0, 2000))}
              placeholder="พิมพ์รายละเอียดที่ต้องการให้แก้ไข…"
              rows={3}
              disabled={busy}
              autoFocus
            />
            <div className="dv-ackbtns">
              <button className="nv-btn" disabled={busy} onClick={() => { setRequesting(false); setRevNote(""); }}>ยกเลิก</button>
              <button className="nv-upbtn" style={{ marginTop: 0 }} disabled={busy || !revNote.trim()} onClick={submitRevision}>
                {busy ? "กำลังส่ง…" : "ส่งคำขอแก้ไข"}
              </button>
            </div>
          </div>
        ) : (
          <div className="dv-actions">
            <button className="dv-ackbtn" onClick={() => setConfirming(true)}>กดรับทราบ</button>
            <button className="dv-revbtn" onClick={() => setRequesting(true)}>
              <Icon name="return" size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />ขอแก้ไข
            </button>
          </div>
        )}

        <div className="nv-crow-comments">
          <button type="button" className={`nv-clink ${showC && comments.length ? "has" : ""}`} onClick={toggleComments}>
            <Icon name="chat" size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />ความคิดเห็น{showC && comments.length ? ` (${comments.length})` : ""} {showC ? "▲" : "▼"}
          </button>
          {showC && <CommentThread comments={comments} onSend={sendComment} busy={sendingC} loading={loadingC} meSide="Client" />}
        </div>

        {err && <p className="nv-lock-err" style={{ marginTop: 6 }}>{err}</p>}
      </div>
      <span className={`nv-st ${chipTone} nv-crow-st`}>{chipLabel}</span>
      {preview && <FilePreviewModal file={preview.file} url={preview.url} onClose={() => setPreview(null)} />}
    </div>
  );
}

function ClientRow({ item, index, token, engagementId, onUploaded, autoOpen, onSeen, periodClosed = false }) {
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const rowRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState(null); // { file, url } while the viewer is open
  const [showC, setShowC] = useState(false);
  const [comments, setComments] = useState([]);
  const [loadingC, setLoadingC] = useState(false);
  const [sendingC, setSendingC] = useState(false);
  // Uploads are refused server-side once the period is closed — say so
  // calmly below instead of letting the client discover it as an error.
  const canUpload = item.status !== "accepted" && !periodClosed;

  const loadComments = async () => {
    setLoadingC(true);
    try { setComments(await clientApi.listComments(token, item.id, engagementId)); }
    catch { /* keep prior */ }
    finally { setLoadingC(false); }
  };
  const toggleComments = () => {
    const next = !showC;
    setShowC(next);
    if (next) { loadComments(); onSeen?.(); }
  };
  // Opened from the unread-comment card → expand, load, mark read, scroll to it.
  useEffect(() => {
    if (!autoOpen) return;
    setShowC(true); loadComments(); onSeen?.();
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpen]);
  const sendComment = async (body) => {
    setSendingC(true);
    try { await clientApi.addComment(token, item.id, engagementId, body); await loadComments(); }
    catch (e) { setErr(e.message || "ส่งความคิดเห็นไม่สำเร็จ"); }
    finally { setSendingC(false); }
  };

  const upload = async (fileList) => {
    const files = Array.from(fileList);
    if (!files.length) return;
    // Advisory pre-check (the Edge Function enforces the same rules authoritatively).
    for (const f of files) {
      const bad = fileError(f);
      if (bad) { setErr(`${f.name}: ${bad}`); return; }
    }
    setBusy(true);
    setErr("");
    try {
      // Sequential so a failure is attributable to one file. Images are
      // downscaled/recompressed client-side first (imageCompress.js) — phone
      // photos of receipts run 3-8MB and clients upload dozens a month, so
      // this is what keeps a portal under its 2GB quota. Non-images and any
      // image compression treats as unsafe (SVG, HEIC it can't decode, or a
      // result that isn't actually smaller) pass through untouched.
      for (const f of files) {
        const toSend = await compressImage(f);
        await clientApi.uploadDocument(token, item.id, toSend, engagementId);
      }
      await onUploaded();
    } catch (e) {
      if (e.status === 401) {
        await onUploaded(); // load() will detect 401 and bounce to lock
        return;
      }
      setErr(e.message || "อัปโหลดไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (fileId) => {
    if (!confirm("ลบไฟล์นี้ออกจากพอร์ทัล?")) return;
    setBusy(true);
    setErr("");
    try {
      await clientApi.removeFile(token, item.id, fileId, engagementId);
      await onUploaded();
    } catch (e) {
      if (e.status === 401) { await onUploaded(); return; }
      setErr(e.message || "ลบไฟล์ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  };

  const clientFiles = item.files.filter((f) => !f.isSample);
  const sampleFiles = item.files.filter((f) => f.isSample);
  const od = isOverdue(item);
  const chip = clientChip(item);
  const rowCls = item.status === "accepted" ? "acc" : od ? "od" : "";

  const openSample = async (fileId) => {
    try { window.open(await clientApi.sampleUrl(token, fileId, engagementId), "_blank"); }
    catch (e) { setErr(e.message || "เปิดไฟล์ไม่สำเร็จ"); }
  };

  // In-page preview (PDF / image) for any file in this portal.
  const openPreview = async (f) => {
    setPreview({ file: f, url: null }); // open immediately with a loading state
    try {
      const url = await clientApi.fileUrl(token, f.id, engagementId);
      setPreview({ file: f, url });
    } catch (e) {
      setPreview(null);
      setErr(e.message || "เปิดตัวอย่างไม่สำเร็จ");
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDrag(false);
    if (canUpload && e.dataTransfer.files?.length) upload(e.dataTransfer.files);
  };

  return (
    <div ref={rowRef} className={`nv-crow ${rowCls}`}>
      <span className="nv-crow-no">{index}</span>
      <div className="nv-crow-main">
        <div className="nv-crow-name">{item.description}{item.required && <span className="req" title="Required">•</span>}</div>
        <div className="nv-crow-sub">
          {clientFiles.length > 0 && <span className="f">{clientFiles.length} ไฟล์</span>}
          <span className={`due ${od ? "od" : ""}`}>
            กำหนดส่ง {fmtDate(item.dueDate)}
            {od && item.dueDate && ` · เกิน ${Math.max(1, Math.floor((Date.now() - item.dueDate) / 86400000))} วัน`}
          </span>
        </div>

        {item.status === "returned" && item.note && (
          <div className="nv-cnote rust"><b>ส่งกลับจากสำนักงาน:</b> {item.note}</div>
        )}
        {item.firmNote && (
          <div className="nv-cnote note"><b><Icon name="note" size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />หมายเหตุจากสำนักงาน:</b> {item.firmNote}</div>
        )}

        {sampleFiles.length > 0 && (
          <div className="nv-cnote note">
            <b><Icon name="paperclip" size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />รายการที่สำนักงานเลือก / ตัวอย่าง:</b>
            <ul className="nv-fchips">
              {sampleFiles.map((f) => (
                <li key={f.id} className="nv-fchip">
                  <span className="nv-ftype">{fileExt(f.name)}</span>
                  <span className="nv-finfo"><b>{f.name}</b><i>{fmtSize(f.size)}</i></span>
                  {isPreviewable(f) && <button className="nv-fx" onClick={() => openPreview(f)}>ดู</button>}
                  <button className="nv-fx" onClick={() => openSample(f.id)}>ดาวน์โหลด</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {clientFiles.length > 0 && (
          <ul className="nv-fchips">
            {clientFiles.map((f) => (
              <li key={f.id} className="nv-fchip">
                <span className="nv-ftype">{fileExt(f.name)}</span>
                <span className="nv-finfo"><b>{f.name}</b><i>{fmtSize(f.size)} · {fmtDate(f.uploadedAt)}</i></span>
                {f.rejected && <span className="nv-frej">ต้องแก้ไข</span>}
                {isPreviewable(f) && <button className="nv-fx" onClick={() => openPreview(f)}>ดู</button>}
                {canUpload && <button className="nv-fx" disabled={busy} onClick={() => remove(f.id)}>ลบ</button>}
              </li>
            ))}
          </ul>
        )}

        {canUpload && (
          <>
            <input ref={fileRef} type="file" accept={ACCEPT_ATTR} multiple style={{ display: "none" }}
              onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
            {/* Separate, single-shot input dedicated to the camera. `capture`
                and `multiple` don't compose safely across browsers: iOS
                Safari drops the "Photo Library" option from its picker the
                moment `capture` is present (camera-only, one shot, no
                gallery multi-select), while putting `capture` on the SAME
                input clients use to pick several existing receipts from
                their gallery would silently break that flow. Keeping this
                as its own input/button means the gallery input above always
                keeps full multi-select, and this one is free to be
                camera-only. */}
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }}
              onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: clientFiles.length === 0 ? 0 : 8 }}>
              {clientFiles.length === 0 ? (
                <div className={`nv-drop ${drag ? "drag" : ""}`} style={{ flex: "1 1 220px", marginTop: 0 }}
                  onClick={() => !busy && fileRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={onDrop}>
                  <div className="t">{busy ? "กำลังอัปโหลด…" : <>ลากไฟล์มาวางที่นี่ หรือ <b>เลือกไฟล์</b></>}</div>
                  <div className="h">PDF, JPG, PNG, XLSX</div>
                </div>
              ) : (
                <button className="nv-upbtn" style={{ marginTop: 0 }} disabled={busy} onClick={() => fileRef.current?.click()}>
                  {busy ? "กำลังอัปโหลด…" : "↑ อัปโหลดเพิ่ม"}
                </button>
              )}
              <button type="button" className="nv-fx" style={{ margin: 0 }} disabled={busy} onClick={() => !busy && cameraRef.current?.click()}>
                <Icon name="camera" size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />ถ่ายรูป
              </button>
            </div>
          </>
        )}
        {periodClosed && item.status !== "accepted" && (
          <div className="dv-closed-inline">งวดนี้ปิดแล้ว จึงอัปโหลดเพิ่มไม่ได้ในขณะนี้</div>
        )}
        <div className="nv-crow-comments">
          <button type="button" className={`nv-clink ${(showC ? comments.length : item.commentCount) ? "has" : ""}`} onClick={toggleComments}>
            <Icon name="chat" size={13} style={{ verticalAlign: "-2px", marginRight: 5 }} />ความคิดเห็น{(showC ? comments.length : item.commentCount) ? ` (${showC ? comments.length : item.commentCount})` : ""} {showC ? "▲" : "▼"}
          </button>
          {showC && <CommentThread comments={comments} onSend={sendComment} busy={sendingC} loading={loadingC} meSide="Client" />}
        </div>
        {err && <p className="nv-lock-err" style={{ marginTop: 6 }}>{err}</p>}
      </div>
      <span className={`nv-st ${chip.tone} nv-crow-st`}>{chip.label}</span>
      {preview && <FilePreviewModal file={preview.file} url={preview.url} onClose={() => setPreview(null)} />}
    </div>
  );
}

/* ======================================================================= */
/* ---------- group flow (client.html?g=…) — one code, many portals ------ */
function GroupPortal({ groupId }) {
  const cacheId = "g_" + groupId; // distinct sessionStorage namespace from single portals
  const [phase, setPhase] = useState("init"); // init | locked | loading | ready
  const [token, setToken] = useState(null);
  const [data, setData] = useState(null);      // { group, companies }
  const [activeId, setActiveId] = useState(null); // drilled-in engagement id
  const [loadErr, setLoadErr] = useState("");

  useEffect(() => {
    const cached = loadToken(cacheId);
    if (cached) { setToken(cached); void loadGroup(cached); }
    else setPhase("locked");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  async function loadGroup(tok) {
    setPhase("loading"); setLoadErr("");
    try {
      const d = await clientApi.groupData(tok);
      setData(d); setPhase("ready");
    } catch (e) {
      if (e.status === 401) { clearToken(cacheId); setToken(null); setPhase("locked"); }
      else { setLoadErr(e.message || "โหลดข้อมูลไม่สำเร็จ"); setPhase("ready"); }
    }
  }

  async function handleUnlock(code) {
    const { token: tok, expiresAt } = await clientApi.groupUnlock(groupId, code);
    saveToken(cacheId, tok, expiresAt);
    setToken(tok);
    await loadGroup(tok);
  }
  function lock() { clearToken(cacheId); setToken(null); setData(null); setActiveId(null); setPhase("locked"); }

  if (phase === "init") return <Shell><div className="tk-boot" style={{ color: "#64748B" }}>Loading…</div></Shell>;
  if (phase === "locked") return <Shell secure><LockScreen onUnlock={handleUnlock} /></Shell>;

  if (activeId) {
    return (
      <Shell onLock={lock}>
        <GroupCompany token={token} engagementId={activeId}
          onBack={() => { setActiveId(null); void loadGroup(token); }} />
      </Shell>
    );
  }
  return (
    <Shell onLock={lock}>
      <GroupDashboard data={data} loadErr={loadErr} onOpen={setActiveId} />
    </Shell>
  );
}

function GroupDashboard({ data, loadErr, onOpen }) {
  const companies = data?.companies || [];
  return (
    <div className="nv-page">
      <div className="nv-phead">
        <div>
          <h2>{data?.group?.name || "กลุ่มลูกค้า"}</h2>
          <div className="sub">เลือกบริษัทเพื่อดูและอัปโหลดเอกสาร · {companies.length} บริษัท</div>
        </div>
      </div>
      {loadErr && <p className="nv-lock-err" style={{ textAlign: "center" }}>{loadErr}</p>}
      {companies.length === 0 ? (
        <div className="nv-list"><div style={{ padding: "40px 16px", textAlign: "center", color: "#64748B", fontSize: 13 }}>ยังไม่มีบริษัทในกลุ่มนี้</div></div>
      ) : (
        <div className="nv-eng-grid">
          {companies.map((c) => <GroupCompanyCard key={c.id} c={c} onOpen={() => onOpen(c.id)} />)}
        </div>
      )}
      <p className="nv-cfoot">เอกสารถูกเก็บอย่างปลอดภัย · เข้าถึงได้เฉพาะกลุ่มของคุณ</p>
    </div>
  );
}

function GroupCompanyCard({ c, onOpen }) {
  const done = c.pct >= 100 && c.total > 0;
  const outstanding = (c.by?.outstanding || 0) + (c.by?.reopened || 0);
  const review = (c.by?.submitted || 0) + (c.by?.review || 0);
  const tags = [];
  if (c.accepted > 0) tags.push({ tone: "mint", txt: `ตรวจรับ ${c.accepted}` });
  if (review > 0) tags.push({ tone: "amber", txt: `รอตรวจ ${review}` });
  if (outstanding > 0) tags.push({ tone: "slate", txt: `รออัปโหลด ${outstanding}` });
  return (
    <button className="nv-card" onClick={onOpen}>
      <div>
        <div className="nv-card-top">
          <div style={{ minWidth: 0 }}>
            <div className="nv-card-type">{c.template}</div>
            <div className="nv-card-name">{c.client}</div>
          </div>
          <div className={`nv-card-pct ${done ? "done" : ""}`}><b>{c.pct}</b><i>%</i></div>
        </div>
        <div className="nv-card-sub">งวดสิ้นสุด {fmtDate(c.periodEnd)} · {c.total} รายการ</div>
      </div>
      <div className="nv-bar"><span style={{ width: `${c.pct}%` }} /></div>
      <div className="nv-tags">
        {tags.length ? tags.map((t, i) => <span key={i} className={`nv-tag2 ${t.tone}`}>{t.txt}</span>)
          : <span className="nv-tag2 slate">ยังไม่มีรายการ</span>}
      </div>
      <div className="nv-card-foot">
        <span className="open">เปิด →</span>
        <span style={{ color: "#94A3B8", fontSize: 15 }}>›</span>
      </div>
    </button>
  );
}

// Drill into one company within a group session: load its items and reuse the
// standard document list, passing engagementId through to the upload calls.
function GroupCompany({ token, engagementId, onBack }) {
  const [eng, setEng] = useState(null);
  const [items, setItems] = useState([]);
  const [phase, setPhase] = useState("loading");
  const [loadErr, setLoadErr] = useState("");
  const [periods, setPeriods] = useState([]);
  const [activePeriodId, setActivePeriodId] = useState(null);
  const [deliverables, setDeliverables] = useState([]);

  const load = useCallback(async (periodId = null) => {
    setPhase("loading"); setLoadErr("");
    try {
      const r = await loadPeriodContext(token, engagementId, periodId);
      setEng(r.engagement); setItems(r.items); setActivePeriodId(r.activePeriodId);
      setPeriods(r.periods); setDeliverables(r.deliverables);
      setPhase("ready");
    } catch (e) {
      setLoadErr(e.message || "โหลดข้อมูลไม่สำเร็จ"); setPhase("ready");
    }
  }, [token, engagementId]);
  useEffect(() => { void load(); }, [load]);

  function markDeliverableOpened(deliverableId) {
    setDeliverables((ds) => ds.map((d) => (d.id === deliverableId ? { ...d, viewedAt: d.viewedAt || Date.now() } : d)));
  }
  async function ackDeliverable(deliverableId) {
    await clientApi.ackDeliverable(token, deliverableId, engagementId);
    setDeliverables((ds) => ds.map((d) => (d.id === deliverableId ? { ...d, status: "acknowledged", acknowledgedAt: Date.now() } : d)));
  }
  async function requestRevision(deliverableId, note) {
    await clientApi.requestDeliverableRevision(token, deliverableId, engagementId, note);
    setDeliverables((ds) => ds.map((d) => (d.id === deliverableId
      ? { ...d, status: "revision_requested", revisionNote: note, acknowledgedAt: null }
      : d)));
  }

  return (
    <>
      <div className="nv-page" style={{ paddingBottom: 0 }}>
        <button className="nv-tbtn" style={{ color: "#123563", background: "#fff", border: "1px solid #E5E7EB" }} onClick={onBack}>← กลับไปหน้ากลุ่ม</button>
      </div>
      <ClientList
        phase={phase} eng={eng} items={items} loadErr={loadErr} token={token} engagementId={engagementId}
        onUploaded={() => load(activePeriodId)}
        periods={periods} activePeriodId={activePeriodId} onPeriodChange={(id) => load(id)}
        deliverables={deliverables} onDeliverableOpened={markDeliverableOpened} onAck={ackDeliverable}
        onRequestRevision={requestRevision}
      />
    </>
  );
}
