// =====================================================================
//  Security-critical isolation tests for supabase/functions/portal/index.ts
//  — the ONE entry point every client (no login, just a 16-digit code)
//  talks to. This file used to have zero test coverage.
//
//  WHY THIS HARNESS EXISTS (approach chosen over a pure-logic extraction):
//  portal/index.ts is a Deno file — it imports supabase-js from an esm.sh
//  URL, reads secrets via `Deno.env.get`, and calls `Deno.serve(handler)`
//  at module load time. None of that exists under Node/Vitest. Rather than
//  moving decision logic out of index.ts into a shared module (risking a
//  behaviour-changing refactor of the most security-sensitive file in the
//  repo), this harness shims JUST the environment:
//    - `vi.mock` replaces the esm.sh supabase-js import with a tiny fake
//      admin client (below) that answers `.from(table)...` chains from a
//      FIFO queue the test fills in per table, in the exact order the
//      production code is known (by reading index.ts) to call it.
//    - `vi.mock` replaces "../_shared/r2.ts" and "../_shared/line.ts"
//      (both of which also read Deno.env.get at import time) with plain
//      vi.fn() stubs.
//    - `vi.stubGlobal("Deno", ...)` provides `env.get` (dummy secrets) and
//      `serve` (captures the handler function instead of starting a server).
//  We then `await import(".../portal/index.ts")` — the REAL, unmodified
//  file — and call the captured handler directly with real Fetch API
//  `Request` objects (Node ships Request/Response/crypto.subtle natively,
//  confirmed working under this repo's jsdom test environment).
//
//  Net effect: zero lines of production code changed to make this file
//  testable. Every test below exercises the actual shipped decision logic,
//  not a re-implementation of it — so this file cannot silently drift from
//  what index.ts really does. `_shared/uploadPolicy.ts` (imported by
//  index.ts) is intentionally left UNMOCKED so its real quota/extension
//  logic runs too.
// =====================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  queueFrom, queueRpc, resetHarness, getCalls, admin,
  presignGetMock, presignPutMock, deleteObjectsMock, headObjectMock, linePushMock,
} = vi.hoisted(() => {
  const tableQueues = new Map();
  const rpcQueues = new Map();
  const calls = [];

  function shift(map, key, label) {
    const q = map.get(key);
    if (!q || !q.length) {
      throw new Error(`portal-edge harness: no mocked response queued for ${label} "${key}"`);
    }
    return q.shift();
  }

  // A minimal stand-in for a supabase-js query builder. Every method just
  // records the call and returns itself so any chain shape works; whatever
  // eventually gets `await`-ed (directly, or via a terminal method like
  // .maybeSingle()/.upsert()/.insert()) dequeues the next response queued
  // for that table. This mirrors real supabase-js closely enough (every
  // await point resolves to a real value) without reimplementing filtering —
  // tests assert the FILTER ARGUMENTS the code passed via `.ops`, which is
  // actually a stronger check for isolation bugs than a real filtering fake
  // would give us "for free".
  function builder(table) {
    const record = { table, ops: [] };
    calls.push(record);
    const resolve = () => shift(tableQueues, table, "table");
    const chain = {
      select: (...a) => { record.ops.push(["select", ...a]); return chain; },
      eq: (...a) => { record.ops.push(["eq", ...a]); return chain; },
      in: (...a) => { record.ops.push(["in", ...a]); return chain; },
      not: (...a) => { record.ops.push(["not", ...a]); return chain; },
      order: (...a) => { record.ops.push(["order", ...a]); return chain; },
      maybeSingle: () => Promise.resolve(resolve()),
      upsert: (...a) => { record.ops.push(["upsert", ...a]); return Promise.resolve(resolve()); },
      insert: (...a) => { record.ops.push(["insert", ...a]); return Promise.resolve(resolve()); },
      update: (...a) => { record.ops.push(["update", ...a]); return chain; },
      delete: (...a) => { record.ops.push(["delete", ...a]); return chain; },
      then: (onFulfilled, onRejected) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
    };
    return chain;
  }

  const admin = {
    from: (table) => builder(table),
    rpc: (name, args) => {
      calls.push({ rpc: name, args });
      return Promise.resolve(shift(rpcQueues, name, "rpc"));
    },
  };

  function queueFrom(table, response) {
    if (!tableQueues.has(table)) tableQueues.set(table, []);
    tableQueues.get(table).push(response);
  }
  function queueRpc(name, response) {
    if (!rpcQueues.has(name)) rpcQueues.set(name, []);
    rpcQueues.get(name).push(response);
  }
  function resetHarness() {
    tableQueues.clear();
    rpcQueues.clear();
    calls.length = 0;
  }

  return {
    queueFrom, queueRpc, resetHarness, getCalls: () => calls, admin,
    presignGetMock: vi.fn().mockResolvedValue("https://signed.example/get"),
    presignPutMock: vi.fn().mockResolvedValue("https://signed.example/put"),
    deleteObjectsMock: vi.fn().mockResolvedValue(undefined),
    headObjectMock: vi.fn(),
    linePushMock: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("https://esm.sh/@supabase/supabase-js@2", () => ({ createClient: () => admin }));
vi.mock("../supabase/functions/_shared/r2.ts", () => ({
  presignGet: (...a) => presignGetMock(...a),
  presignPut: (...a) => presignPutMock(...a),
  deleteObjects: (...a) => deleteObjectsMock(...a),
  headObject: (...a) => headObjectMock(...a),
}));
vi.mock("../supabase/functions/_shared/line.ts", () => ({ linePush: (...a) => linePushMock(...a) }));

let handler;
vi.stubGlobal("Deno", {
  env: {
    get: (k) =>
      ({ SUPABASE_URL: "https://project.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key" }[k] || ""),
  },
  serve: (fn) => { handler = fn; },
});

await import("../supabase/functions/portal/index.ts");

async function callAction(body) {
  const req = new Request("https://portal.test/portal", { method: "POST", body: JSON.stringify(body) });
  const res = await handler(req);
  return { status: res.status, body: await res.json() };
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function callsFor(table) {
  return getCalls().filter((c) => c.table === table);
}
function eqArgsOf(call, name) {
  return call.ops.filter((op) => op[0] === "eq" && op[1] === name).map((op) => op[2]);
}

// Queues a valid portal_sessions row for whatever raw token string the test
// then sends. The mock doesn't verify the hash matches (it's a dumb FIFO
// queue) — the "looked up by hash" guarantee is asserted explicitly in its
// own test below by inspecting the recorded `eq("token_hash", ...)` call.
function seedSession({ engagement_id = null, group_id = null, expires_at = FUTURE } = {}) {
  const token = `raw-session-token-${Math.random().toString(36).slice(2)}`;
  queueFrom("portal_sessions", { data: { engagement_id, group_id, expires_at }, error: null });
  return token;
}

const FUTURE = new Date(Date.now() + 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();

beforeEach(() => {
  resetHarness();
  presignGetMock.mockClear().mockResolvedValue("https://signed.example/get");
  presignPutMock.mockClear().mockResolvedValue("https://signed.example/put");
  deleteObjectsMock.mockClear().mockResolvedValue(undefined);
  headObjectMock.mockClear();
  linePushMock.mockClear().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------
// Guarantee #2 — sessionForToken: expired tokens rejected, lookup by hash
// ---------------------------------------------------------------------
describe("sessionForToken — every non-unlock action requires a live session", () => {
  it("rejects when no session row matches the token (401 session expired)", async () => {
    queueFrom("portal_sessions", { data: null, error: null });
    const { status, body } = await callAction({ action: "data", token: "unknown-token" });
    expect(status).toBe(401);
    expect(body.error).toBe("session expired");
  });

  it("rejects a token whose session row exists but has already expired (401)", async () => {
    queueFrom("portal_sessions", { data: { engagement_id: "E1", group_id: null, expires_at: PAST }, error: null });
    const { status, body } = await callAction({ action: "data", token: "stale-token" });
    expect(status).toBe(401);
    expect(body.error).toBe("session expired");
  });

  it("looks the token up by its SHA-256 hash — the raw token is never used as a query value", async () => {
    const token = "a-raw-plaintext-token";
    queueFrom("portal_sessions", { data: null, error: null });
    await callAction({ action: "data", token });
    const [call] = callsFor("portal_sessions");
    const hashesQueried = eqArgsOf(call, "token_hash");
    expect(hashesQueried).toEqual([await sha256Hex(token)]);
    expect(hashesQueried[0]).not.toBe(token);
  });
});

// ---------------------------------------------------------------------
// Guarantee #1 (highest priority) — resolveEngagement isolation
// ---------------------------------------------------------------------
describe("resolveEngagement — the cross-portal / cross-group pivot guard", () => {
  it("a single-portal session pins its engagement id and ignores an attacker-supplied engagement_id in the body", async () => {
    const token = seedSession({ engagement_id: "E1", group_id: null });
    queueFrom("engagements", {
      data: { id: "E1", client: "ACME", template: "Audit", period_end: "2026-12-31", expires_at: null }, error: null,
    });
    // `data` is period-scoped. An annual audit portal has exactly one period
    // (the periods migration backfills one per pre-existing engagement), which
    // is what this fixture represents.
    queueFrom("periods", { data: [{ id: "P1", period_key: "2026-12", status: "open" }], error: null });
    queueFrom("request_items", { data: [], error: null });
    queueFrom("item_comments", { data: [], error: null });

    const { status } = await callAction({ action: "data", token, engagement_id: "E2-attacker-supplied" });

    expect(status).toBe(200);
    const [engagementsCall] = callsFor("engagements");
    expect(eqArgsOf(engagementsCall, "id")).toEqual(["E1"]); // E2 from the body was never used
    // The period list was scoped to the SESSION's engagement too, not the body's.
    const [periodsCall] = callsFor("periods");
    expect(eqArgsOf(periodsCall, "engagement_id")).toEqual(["E1"]);
  });

  it("a group session with no engagement_id in the body is forbidden and never hits the DB to resolve one", async () => {
    const token = seedSession({ engagement_id: null, group_id: "G1" });
    const { status, body } = await callAction({ action: "data", token });
    expect(status).toBe(403);
    expect(body.error).toBe("forbidden");
    expect(callsFor("engagements")).toHaveLength(0);
  });

  it("a group session cannot pivot into an engagement that belongs to a DIFFERENT group", async () => {
    const token = seedSession({ engagement_id: null, group_id: "G1" });
    queueFrom("engagements", { data: { group_id: "G-OTHER" }, error: null });
    const { status, body } = await callAction({ action: "data", token, engagement_id: "E-in-other-group" });
    expect(status).toBe(403);
    expect(body.error).toBe("forbidden");
  });

  it("a group session cannot reach an ungrouped (standalone) engagement", async () => {
    const token = seedSession({ engagement_id: null, group_id: "G1" });
    queueFrom("engagements", { data: { group_id: null }, error: null });
    const { status, body } = await callAction({ action: "data", token, engagement_id: "E-standalone" });
    expect(status).toBe(403);
    expect(body.error).toBe("forbidden");
  });

  it("a group session cannot reach a non-existent engagement id", async () => {
    const token = seedSession({ engagement_id: null, group_id: "G1" });
    queueFrom("engagements", { data: null, error: null });
    const { status } = await callAction({ action: "data", token, engagement_id: "does-not-exist" });
    expect(status).toBe(403);
  });

  it("a group session CAN reach an engagement confirmed to be in its own group", async () => {
    const token = seedSession({ engagement_id: null, group_id: "G1" });
    queueFrom("engagements", { data: { group_id: "G1" }, error: null }); // resolveEngagement's membership check
    queueFrom("engagements", {
      data: { id: "E1", client: "ACME", template: "Audit", period_end: null, expires_at: null }, error: null,
    }); // the "data" action's own fetch, once resolved
    queueFrom("periods", { data: [{ id: "P1", period_key: "2026-12", status: "open" }], error: null });
    queueFrom("request_items", { data: [], error: null });
    queueFrom("item_comments", { data: [], error: null });

    const { status } = await callAction({ action: "data", token, engagement_id: "E1" });
    expect(status).toBe(200);
  });

  it("group_data is refused for a single-portal (non-group) session", async () => {
    const token = seedSession({ engagement_id: "E1", group_id: null });
    const { status, body } = await callAction({ action: "group_data", token });
    expect(status).toBe(403);
    expect(body.error).toBe("not a group session");
  });
});

// ---------------------------------------------------------------------
// Guarantee #3 — unlock: throttle arithmetic + grouped-engagement guard
// ---------------------------------------------------------------------
describe("unlock — brute-force throttle and the grouped-engagement guard", () => {
  it("a wrong code increments the failure counter without locking, below the threshold", async () => {
    queueFrom("engagements", { data: { group_id: null }, error: null });
    queueFrom("unlock_throttle", { data: { failed: 2, locked_until: null }, error: null });
    queueRpc("verify_portal_code", { data: false, error: null });
    queueFrom("unlock_throttle", { error: null }); // upsert

    const { status, body } = await callAction({ action: "unlock", engagement_id: "E1", code: "1".repeat(16) });
    expect(status).toBe(401);
    expect(body.error).toBe("wrong code");

    const [, payload] = callsFor("unlock_throttle")[1].ops.find((op) => op[0] === "upsert");
    expect(payload).toMatchObject({ engagement_id: "E1", failed: 3, locked_until: null });
  });

  it("the 5th consecutive failure locks the engagement for 15 minutes and resets the counter to 0", async () => {
    queueFrom("engagements", { data: { group_id: null }, error: null });
    queueFrom("unlock_throttle", { data: { failed: 4, locked_until: null }, error: null });
    queueRpc("verify_portal_code", { data: false, error: null });
    queueFrom("unlock_throttle", { error: null });

    const before = Date.now();
    const { status } = await callAction({ action: "unlock", engagement_id: "E1", code: "1".repeat(16) });
    expect(status).toBe(401);

    const [, payload] = callsFor("unlock_throttle")[1].ops.find((op) => op[0] === "upsert");
    expect(payload.failed).toBe(0);
    const lockedUntilMs = new Date(payload.locked_until).getTime();
    expect(lockedUntilMs).toBeGreaterThanOrEqual(before + 15 * 60_000 - 2000);
    expect(lockedUntilMs).toBeLessThanOrEqual(before + 15 * 60_000 + 5000);
  });

  it("refuses further attempts with 429 while locked, without even checking the code", async () => {
    queueFrom("engagements", { data: { group_id: null }, error: null });
    queueFrom("unlock_throttle", { data: { failed: 5, locked_until: FUTURE }, error: null });

    const { status, body } = await callAction({ action: "unlock", engagement_id: "E1", code: "1".repeat(16) });
    expect(status).toBe(429);
    expect(body.error).toMatch(/too many attempts/);
    expect(getCalls().some((c) => c.rpc === "verify_portal_code")).toBe(false);
  });

  it("refuses the single-portal unlock path for a grouped engagement (409), before touching the throttle", async () => {
    queueFrom("engagements", { data: { group_id: "G1" }, error: null });
    const { status, body } = await callAction({ action: "unlock", engagement_id: "E1", code: "1".repeat(16) });
    expect(status).toBe(409);
    expect(body.grouped).toBe(true);
    expect(callsFor("unlock_throttle")).toHaveLength(0);
  });

  it("a correct code clears the throttle and mints a session stored ONLY as a token hash", async () => {
    queueFrom("engagements", { data: { group_id: null }, error: null });
    queueFrom("unlock_throttle", { data: { failed: 3, locked_until: null }, error: null });
    queueRpc("verify_portal_code", { data: true, error: null });
    queueFrom("unlock_throttle", { error: null }); // clear upsert
    queueFrom("portal_sessions", { error: null }); // insert

    const { status, body } = await callAction({ action: "unlock", engagement_id: "E1", code: "1".repeat(16) });
    expect(status).toBe(200);
    expect(body.token).toBeTruthy();

    const [, clearPayload] = callsFor("unlock_throttle")[1].ops.find((op) => op[0] === "upsert");
    expect(clearPayload).toEqual({ engagement_id: "E1", failed: 0, locked_until: null });

    const [, insertPayload] = callsFor("portal_sessions")[0].ops.find((op) => op[0] === "insert");
    expect(insertPayload.token_hash).toBe(await sha256Hex(body.token));
    expect(insertPayload.token_hash).not.toBe(body.token);
    expect(insertPayload.engagement_id).toBe("E1");
  });
});

// ---------------------------------------------------------------------
// Guarantee #4 — confirm: path scoping, forged size, idempotency
// ---------------------------------------------------------------------
describe("confirm — storage_path scoping, authoritative size, idempotent replay", () => {
  it.each([
    ["another item in the SAME engagement", "E1/OTHER-ITEM/evil.pdf"],
    ["another engagement entirely", "OTHER-ENGAGEMENT/I1/evil.pdf"],
    ["a bare filename with no folder at all", "evil.pdf"],
  ])("rejects a forged storage_path pointing at %s (400, R2 never touched)", async (_label, storage_path) => {
    const token = seedSession({ engagement_id: "E1" });
    queueFrom("request_items", { data: { id: "I1", status: "outstanding" }, error: null });

    const { status, body } = await callAction({ action: "confirm", token, item_id: "I1", storage_path });
    expect(status).toBe(400);
    expect(body.error).toBe("invalid path");
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it("ignores a forged client-declared size — the authoritative R2 size decides the 50MB limit", async () => {
    const token = seedSession({ engagement_id: "E1" });
    const storage_path = "E1/I1/huge-file.pdf";
    queueFrom("request_items", { data: { id: "I1", status: "outstanding" }, error: null });
    queueFrom("item_files", { data: null, error: null }); // not already recorded
    headObjectMock.mockResolvedValue({ size: 60 * 1024 * 1024, contentType: "application/pdf", etag: "abc" });

    const { status, body } = await callAction({
      action: "confirm", token, item_id: "I1", storage_path, size: 10, // attacker lies: claims 10 bytes
    });
    expect(status).toBe(413);
    expect(body.error).toMatch(/ใหญ่เกิน/);
    expect(deleteObjectsMock).toHaveBeenCalledWith([storage_path]); // rejected upload binned
  });

  it("rejects (and bins) an upload that would exceed the portal's authoritative quota", async () => {
    const token = seedSession({ engagement_id: "E1" });
    const storage_path = "E1/I1/small-but-over-quota.pdf";
    queueFrom("request_items", { data: { id: "I1", status: "outstanding" }, error: null });
    queueFrom("item_files", { data: null, error: null });
    headObjectMock.mockResolvedValue({ size: 1024, contentType: "application/pdf", etag: "x" });
    queueFrom("item_files", { data: [{ size: 2 * 1024 * 1024 * 1024 - 512 }], error: null }); // near the 2GB cap

    const { status } = await callAction({ action: "confirm", token, item_id: "I1", storage_path });
    expect(status).toBe(413);
    expect(deleteObjectsMock).toHaveBeenCalledWith([storage_path]);
  });

  it("a repeated confirm for an already-recorded storage_path is idempotent (no re-verify, no duplicate row)", async () => {
    const token = seedSession({ engagement_id: "E1" });
    const storage_path = "E1/I1/doc.pdf";
    queueFrom("request_items", { data: { id: "I1", status: "outstanding" }, error: null });
    queueFrom("item_files", { data: { id: "already-recorded-file-id" }, error: null });

    const { status, body } = await callAction({ action: "confirm", token, item_id: "I1", storage_path });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(headObjectMock).not.toHaveBeenCalled(); // never re-checks R2 for a known object
  });

  it("records the R2-authoritative size/type on a fresh confirm, never the client-declared ones", async () => {
    const token = seedSession({ engagement_id: "E1" });
    const storage_path = "E1/I1/doc.pdf";
    queueFrom("request_items", { data: { id: "I1", status: "outstanding" }, error: null });
    queueFrom("item_files", { data: null, error: null }); // not recorded
    headObjectMock.mockResolvedValue({ size: 4096, contentType: "application/pdf", etag: "real-etag" });
    queueFrom("item_files", { data: [], error: null }); // existing sizes for quota check
    queueFrom("item_files", { error: null }); // insert
    queueFrom("request_items", { error: null }); // status -> submitted
    queueFrom("item_history", { error: null }); // history insert
    queueFrom("engagements", { data: { client: "ACME" }, error: null }); // LINE block: client name
    queueFrom("portal_members", { data: [], error: null }); // LINE block: no linked members, stops here

    const { status } = await callAction({
      action: "confirm", token, item_id: "I1", storage_path, name: "doc.pdf", size: 1, type: "text/plain",
    });
    expect(status).toBe(200);

    const [, payload] = callsFor("item_files")[2].ops.find((op) => op[0] === "insert"); // 3rd item_files call = insert
    expect(payload.size).toBe(4096); // authoritative, not the client's `1`
    expect(payload.type).toBe("application/pdf"); // authoritative, not the client's `text/plain`
  });
});

// ---------------------------------------------------------------------
// Guarantee #5 — file_id actions scoped to the resolved engagement
// ---------------------------------------------------------------------
describe("file_id lookups are scoped to the resolved engagement", () => {
  it("sample_url returns 404 (never a URL) for a file_id outside this portal, scoped by the SESSION's engagement", async () => {
    const token = seedSession({ engagement_id: "E1" });
    queueFrom("item_files", { data: null, error: null }); // scoped query finds nothing for E1
    const { status, body } = await callAction({ action: "sample_url", token, file_id: "F-from-other-engagement" });
    expect(status).toBe(404);
    expect(body.url).toBeUndefined();
    const [call] = callsFor("item_files");
    expect(eqArgsOf(call, "engagement_id")).toEqual(["E1"]); // never a body-supplied engagement id
  });

  it("file_url returns 404 for a file_id from another portal", async () => {
    const token = seedSession({ engagement_id: "E1" });
    queueFrom("item_files", { data: null, error: null });
    const { status } = await callAction({ action: "file_url", token, file_id: "F-from-other-engagement" });
    expect(status).toBe(404);
  });

  it("remove_file 404s for a file_id that does not belong to the resolved item", async () => {
    const token = seedSession({ engagement_id: "E1" });
    queueFrom("request_items", { data: { id: "I1", status: "outstanding" }, error: null });
    queueFrom("item_files", { data: null, error: null });
    const { status } = await callAction({ action: "remove_file", token, item_id: "I1", file_id: "F-elsewhere" });
    expect(status).toBe(404);
  });

  it("sample_url succeeds and returns a presigned URL when the file IS in this portal and IS a sample", async () => {
    const token = seedSession({ engagement_id: "E1" });
    queueFrom("item_files", { data: { id: "F1", storage_path: "E1/I1/sample.pdf", is_sample: true }, error: null });
    const { status, body } = await callAction({ action: "sample_url", token, file_id: "F1" });
    expect(status).toBe(200);
    expect(body.url).toBe("https://signed.example/get");
  });
});

// ---------------------------------------------------------------------
// Harness sanity (not a security guarantee, just proves the shim itself
// answers the un-authenticated actions correctly)
// ---------------------------------------------------------------------
describe("harness sanity", () => {
  it("answers the deployment health check without touching the database", async () => {
    const { status, body } = await callAction({ action: "health" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, service: "portal" });
    expect(getCalls()).toHaveLength(0);
  });

  it("rejects an unknown action with 400", async () => {
    const token = seedSession({ engagement_id: "E1" });
    const { status, body } = await callAction({ action: "not-a-real-action", token });
    expect(status).toBe(400);
    expect(body.error).toBe("unknown action");
  });
});
