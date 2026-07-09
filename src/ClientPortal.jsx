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
import { useEffect, useMemo, useRef, useState } from "react";
import { clientApi } from "../lib/portalApi.js";
import { SUPABASE_CONFIGURED } from "../lib/supabaseClient.js";
import "./portal.css";

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
  b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB";
const isOverdue = (it) => it.status !== "accepted" && it.dueDate && it.dueDate < Date.now();
const fileExt = (name) => (name.includes(".") ? name.split(".").pop().slice(0, 4).toUpperCase() : "ไฟล์");

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

/* ======================================================================= */
export default function ClientPortal() {
  const engagementId = useMemo(() => new URLSearchParams(location.search).get("e") || "", []);

  const [phase, setPhase] = useState("init"); // init | locked | loading | ready
  const [token, setToken] = useState(null);
  const [eng, setEng] = useState(null);
  const [items, setItems] = useState([]);
  const [loadErr, setLoadErr] = useState("");

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

  async function load(tok) {
    setPhase("loading");
    setLoadErr("");
    try {
      const { engagement, items } = await clientApi.fetchData(tok);
      setEng(engagement);
      setItems(items);
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
    setPhase("locked");
  }

  async function refresh() {
    if (token) await load(token);
  }

  /* ---- render ---- */
  if (phase === "nolink")
    return (
      <Shell secure>
        <div className="nv-lockwrap">
          <div className="nv-lockcard">
            <div className="nv-lock-hd">
              <span className="nv-lock-ic">🔗</span>
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
        onUploaded={refresh}
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
          {secure && <span className="nv-secure"><span className="lk">🔒</span>การเชื่อมต่อปลอดภัย</span>}
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

  const submit = async () => {
    if (code.length !== 16 || busy) return;
    setBusy(true);
    setErr("");
    try {
      await onUnlock(code);
    } catch (e) {
      if (e.status === 429) setErr("กรอกผิดหลายครั้งเกินไป — โปรดลองใหม่ภายหลัง (~15 นาที)");
      else if (e.status === 401) setErr("รหัสไม่ถูกต้อง — กรุณาลองใหม่อีกครั้ง");
      else setErr(e.message || "เข้าพอร์ทัลไม่สำเร็จ");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const codeDisplayGroups = Array.from({ length: 4 }, (_, i) => {
    const part = code.slice(i * 4, i * 4 + 4);
    return part ? part.padEnd(4, "0") : "0000";
  });

  return (
    <div className="nv-lockwrap">
      <div className="nv-lockcard">
        <div className="nv-lock-hd">
          <span className="nv-lock-ic">🔒</span>
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
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <span className="nv-otp" aria-hidden="true">
              {codeDisplayGroups.map((part, i) => (
                <span className={`nv-otp-box ${code.length > i * 4 ? "on" : ""}`} key={i}>{part}</span>
              ))}
            </span>
          </label>
          {err && <p className="nv-lock-err">{err}</p>}
          <button className="nv-lock-cta" disabled={code.length !== 16 || busy} onClick={submit}>
            {busy ? "กำลังตรวจสอบ…" : <>เข้าสู่พอร์ทัล →</>}
          </button>
          <p className="nv-lock-note">
            <span style={{ flex: "none" }}>🔒</span>
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

/* ---------- the request list + uploads (3c) ---------------------------- */
function ClientList({ phase, eng, items, loadErr, token, onUploaded }) {
  const [filter, setFilter] = useState("all");
  const [catFilter, setCatFilter] = useState(null);
  const [q, setQ] = useState("");

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
      const passStatus =
        filter === "all" ? true
          : filter === "overdue" ? isOverdue(it)
            : filter === "action" ? needsAction(it)
              : it.status === filter;
      const passCat = !catFilter || it.category === catFilter;
      const passText = !s || `${it.ref} ${it.description}`.toLowerCase().includes(s);
      return passStatus && passCat && passText;
    });
    const m = new Map();
    filtered.forEach((it) => {
      if (!m.has(it.category)) m.set(it.category, []);
      m.get(it.category).push(it);
    });
    return [...m.entries()];
  }, [items, filter, catFilter, q]);

  const accepted = items.filter((i) => i.status === "accepted").length;
  const pending = items.filter((i) => i.status === "submitted" || i.status === "review").length;
  const pct = items.length ? Math.round((accepted / items.length) * 100) : 0;
  const firstOverdue = items.find(isOverdue);

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
              <div className="bar">
                <span className="a" style={{ width: `${pct}%` }} />
                <span className="p" style={{ width: `${Math.round((pending / items.length) * 100)}%` }} />
              </div>
              <span className="pc">{pct}%</span>
            </div>
          )}
        </div>
      )}

      {loadErr && <p className="nv-lock-err" style={{ textAlign: "center" }}>{loadErr}</p>}

      {items.length === 0 ? (
        <div className="nv-list"><div style={{ padding: "40px 16px", textAlign: "center", color: "#64748B", fontSize: 13 }}>ยังไม่มีรายการเอกสารในพอร์ทัลนี้</div></div>
      ) : (
        <div className="nv-work">
          {/* LEFT: search, alert, status filters, category groups */}
          <aside className="nv-aside">
            <div className="nv-isearch"><span>⌕</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ค้นหาเอกสาร…" /></div>
            {stats.overdue > 0 && (
              <div className="nv-alert" onClick={() => { setFilter("overdue"); setCatFilter(null); }}>
                <span className="ic">⚠</span>
                <span>มี <b>{stats.overdue}</b> รายการเกินกำหนดส่ง{firstOverdue && ` — ${firstOverdue.description}`} · คลิกเพื่อดู</span>
              </div>
            )}
            <div className="nv-asf">
              <label className="nv-asf-l">สถานะ</label>
              <select className="nv-fb-sel nv-asf-sel" value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">ทุกสถานะ · {items.length}</option>
                {stats.action > 0 && <option value="action">⚠ ต้องดำเนินการ · {stats.action}</option>}
                {STATUS_ORDER.map((s) => <option key={s} value={s}>{TH[s]} · {stats.by[s]}</option>)}
                <option value="overdue">เกินกำหนด · {stats.overdue}</option>
              </select>
            </div>
            {cats.length > 0 && (
              <div className="nv-asf">
                <label className="nv-asf-l">หมวดเอกสาร</label>
                <select className="nv-fb-sel nv-asf-sel" value={catFilter || ""} onChange={(e) => setCatFilter(e.target.value || null)}>
                  <option value="">ทุกหมวด · {items.length}</option>
                  {cats.map((c) => <option key={c.cat} value={c.cat}>{c.cat} · {c.count}</option>)}
                </select>
              </div>
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
                      <ClientRow key={it.id} item={it} index={idx + 1} token={token} onUploaded={onUploaded} />
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

function ClientRow({ item, index, token, onUploaded }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const canUpload = item.status !== "accepted";

  const upload = async (fileList) => {
    const files = Array.from(fileList);
    if (!files.length) return;
    setBusy(true);
    setErr("");
    try {
      // Sequential so a failure is attributable to one file.
      for (const f of files) await clientApi.uploadDocument(token, item.id, f);
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
      await clientApi.removeFile(token, item.id, fileId);
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
    try { window.open(await clientApi.sampleUrl(token, fileId), "_blank"); }
    catch (e) { setErr(e.message || "เปิดไฟล์ไม่สำเร็จ"); }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDrag(false);
    if (canUpload && e.dataTransfer.files?.length) upload(e.dataTransfer.files);
  };

  return (
    <div className={`nv-crow ${rowCls}`}>
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
          <div className="nv-cnote note"><b>📝 หมายเหตุจากสำนักงาน:</b> {item.firmNote}</div>
        )}

        {sampleFiles.length > 0 && (
          <div className="nv-cnote note">
            <b>📎 รายการที่สำนักงานเลือก / ตัวอย่าง:</b>
            <ul className="nv-fchips">
              {sampleFiles.map((f) => (
                <li key={f.id} className="nv-fchip">
                  <span className="nv-ftype">{fileExt(f.name)}</span>
                  <span className="nv-finfo"><b>{f.name}</b><i>{fmtSize(f.size)}</i></span>
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
                {canUpload && <button className="nv-fx" disabled={busy} onClick={() => remove(f.id)}>ลบ</button>}
              </li>
            ))}
          </ul>
        )}

        {canUpload && (
          <>
            <input ref={fileRef} type="file" multiple style={{ display: "none" }}
              onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
            {clientFiles.length === 0 ? (
              <div className={`nv-drop ${drag ? "drag" : ""}`}
                onClick={() => !busy && fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={onDrop}>
                <div className="t">{busy ? "กำลังอัปโหลด…" : <>ลากไฟล์มาวางที่นี่ หรือ <b>เลือกไฟล์</b></>}</div>
                <div className="h">PDF, JPG, PNG, XLSX</div>
              </div>
            ) : (
              <button className="nv-upbtn" disabled={busy} onClick={() => fileRef.current?.click()}>
                {busy ? "กำลังอัปโหลด…" : "↑ อัปโหลดเพิ่ม"}
              </button>
            )}
          </>
        )}
        {err && <p className="nv-lock-err" style={{ marginTop: 6 }}>{err}</p>}
      </div>
      <span className={`nv-st ${chip.tone} nv-crow-st`}>{chip.label}</span>
    </div>
  );
}
