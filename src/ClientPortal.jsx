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
};

/* ---------- small helpers ---------------------------------------------- */
const onlyDigits = (s) => s.replace(/\D+/g, "").slice(0, 16);
const groupDigits = (s) => s.replace(/(.{4})/g, "$1 ").trim();
const fmtDate = (ts) =>
  !ts ? "—" : new Date(ts).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
const fmtSize = (b) =>
  b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(0) + " KB" : (b / 1048576).toFixed(1) + " MB";
const isOverdue = (it) => it.status !== "accepted" && it.dueDate && it.dueDate < Date.now();

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
function Pill({ status }) {
  const s = STATUS[status] || STATUS.outstanding;
  return (
    <span className={`tk-pill ${s.tone}`}>
      <span className="g">{s.glyph}</span>
      {s.label}
    </span>
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
      <Shell>
        <div className="tk-lock">
          <div className="tk-lock-card">
            <div className="tk-lock-icon">🔗</div>
            <h2>ลิงก์ไม่สมบูรณ์</h2>
            <p className="tk-muted">ลิงก์เข้าพอร์ทัลไม่ถูกต้อง — โปรดเปิดจากลิงก์ที่สำนักงานส่งให้ (ต้องมีรหัสพอร์ทัลใน URL)</p>
          </div>
        </div>
      </Shell>
    );

  if (phase === "init")
    return (
      <Shell>
        <div className="tk-boot">Loading…</div>
      </Shell>
    );

  if (phase === "locked")
    return (
      <Shell>
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

/* ---------- chrome ----------------------------------------------------- */
function Shell({ children, onLock }) {
  return (
    <div className="tk-root">
      <header className="tk-top">
        <div className="tk-brand">
          <Tick size={20} />
          <span className="tk-word">Tickmark</span>
          <span className="tk-tag">PBC portal</span>
        </div>
        <div className="tk-top-right">
          {onLock && (
            <button className="tk-icon" title="ออกจากพอร์ทัล" onClick={onLock}>
              🔒
            </button>
          )}
        </div>
      </header>
      {children}
    </div>
  );
}

/* ---------- lock screen ------------------------------------------------ */
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

  return (
    <div className="tk-lock">
      <div className="tk-lock-card">
        <div className="tk-lock-icon">🔒</div>
        <p className="tk-lock-eyebrow">เอกสารที่ต้องจัดเตรียม</p>
        <h2>เข้าสู่พอร์ทัล</h2>
        <p className="tk-muted">กรอกรหัส 16 หลักที่สำนักงานส่งให้เพื่อเข้าพอร์ทัลของคุณ</p>
        <input
          className="tk-code-input"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={groupDigits(code)}
          placeholder="0000 0000 0000 0000"
          onChange={(e) => {
            setCode(onlyDigits(e.target.value));
            setErr("");
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {err && <p className="tk-lock-err">{err}</p>}
        <button className="tk-btn primary full" disabled={code.length !== 16 || busy} onClick={submit}>
          {busy ? "กำลังตรวจสอบ…" : "ปลดล็อกเข้าพอร์ทัล"}
        </button>
        {!SUPABASE_CONFIGURED && (
          <p className="tk-lock-demo">
            ⚠ ยังไม่ได้ตั้งค่า backend — คัดลอก <b>.env.example</b> เป็น <b>.env.local</b> แล้วใส่ค่าจาก Supabase
            (การกดปลดล็อกจะยัง fail จนกว่าจะตั้งค่า + deploy Edge Function)
          </p>
        )}
        <p className="tk-lock-foot">รหัสนี้ใช้ได้เฉพาะพอร์ทัลของคุณเท่านั้น</p>
      </div>
    </div>
  );
}

/* ---------- the request list + uploads --------------------------------- */
function ClientList({ phase, eng, items, loadErr, token, onUploaded }) {
  const grouped = useMemo(() => {
    const m = new Map();
    items.forEach((it) => {
      if (!m.has(it.category)) m.set(it.category, []);
      m.get(it.category).push(it);
    });
    return [...m.entries()];
  }, [items]);

  const accepted = items.filter((i) => i.status === "accepted").length;
  const pct = items.length ? Math.round((accepted / items.length) * 100) : 0;

  if (phase === "loading" && !eng)
    return (
      <main className="tk-main">
        <div className="tk-boot">กำลังโหลดรายการเอกสาร…</div>
      </main>
    );

  return (
    <main className="tk-main">
      {eng && (
        <section className="tk-head">
          <div>
            <p className="tk-eyebrow">{eng.template}</p>
            <h1 className="tk-client">{eng.client}</h1>
            <p className="tk-meta">
              Period end <b>{fmtDate(eng.periodEnd)}</b> · {items.length} items
            </p>
          </div>
          <div className="tk-progress">
            <div className="tk-pct">
              <span>{pct}</span>
              <i>%</i>
            </div>
            <p className="tk-progress-cap">
              {accepted} of {items.length} accepted
            </p>
          </div>
        </section>
      )}

      <section className="tk-toolbar">
        <p className="tk-hint">
          อัปโหลดเอกสารตามรายการด้านล่าง — แต่ละรายการจะเปลี่ยนเป็น <b>Submitted</b> เมื่อแนบไฟล์
          จากนั้นสำนักงานจะตรวจรับหรือส่งกลับพร้อมหมายเหตุ
        </p>
      </section>

      {loadErr && <p className="tk-lock-err" style={{ textAlign: "center" }}>{loadErr}</p>}

      {grouped.length === 0 ? (
        <p className="tk-none">ยังไม่มีรายการเอกสารในพอร์ทัลนี้</p>
      ) : (
        grouped.map(([cat, rows]) => (
          <section key={cat} className="tk-group">
            <div className="tk-group-head">
              <span className="tk-cat">{cat}</span>
              <span className="tk-rule" />
              <span className="tk-count">
                {rows.filter((i) => i.status === "accepted").length}/{rows.length}
              </span>
            </div>
            <ul className="tk-rows">
              {rows.map((it) => (
                <ClientRow key={it.id} item={it} token={token} onUploaded={onUploaded} />
              ))}
            </ul>
          </section>
        ))
      )}

      <footer className="tk-foot">เอกสารถูกเก็บอย่างปลอดภัย · เข้าถึงได้เฉพาะพอร์ทัลของคุณ</footer>
    </main>
  );
}

function ClientRow({ item, token, onUploaded }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
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

  return (
    <li className="tk-row" style={{ cursor: "default", flexWrap: "wrap" }}>
      <span className="tk-ref">{item.ref}</span>
      <div className="tk-desc">
        <span className="tk-desc-main">
          {item.description}
          {item.required && <i className="tk-req" title="Required">•</i>}
        </span>
        <span className="tk-desc-sub">
          {item.files.length > 0 && (
            <span className="tk-files-mini">
              {item.files.length} file{item.files.length > 1 ? "s" : ""}
            </span>
          )}
          <span className={`tk-due ${isOverdue(item) ? "od" : ""}`}>Due {fmtDate(item.dueDate)}</span>
        </span>

        {item.status === "returned" && item.note && (
          <div className="tk-callout rust" style={{ marginTop: 8 }}>
            <b>ส่งกลับจากสำนักงาน:</b> {item.note}
          </div>
        )}

        {item.files.length > 0 && (
          <ul className="tk-filelist" style={{ marginTop: 8 }}>
            {item.files.map((f) => (
              <li key={f.id}>
                <span className="tk-fileicon">▤</span>
                <span className="tk-fileinfo">
                  <b>{f.name}</b>
                  <i>{fmtSize(f.size)} · {fmtDate(f.uploadedAt)}</i>
                </span>
              </li>
            ))}
          </ul>
        )}

        {canUpload && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                upload(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              className="tk-btn primary"
              style={{ marginTop: 8 }}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? "กำลังอัปโหลด…" : "↑ อัปโหลดเอกสาร"}
            </button>
          </>
        )}
        {err && <p className="tk-lock-err" style={{ marginTop: 6 }}>{err}</p>}
      </div>
      <Pill status={item.status} />
    </li>
  );
}
