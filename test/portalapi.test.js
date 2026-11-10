import { afterEach, describe, expect, it, vi } from "vitest";
import { clientApi, mapEngagement, mapFile, mapHistory, mapItem } from "../lib/portalApi.js";

const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: vi.fn().mockResolvedValue(body),
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("portal row mappers", () => {
  it("maps file values and backend defaults", () => {
    expect(mapFile({
      id: "f1", name: "tb.xlsx", size: "42", type: null,
      storage_path: "e/i/tb.xlsx", uploaded_at: "2026-07-14T01:00:00Z",
      firm_downloaded_at: null, rejected: 1, is_sample: 0,
    })).toEqual({
      id: "f1", name: "tb.xlsx", size: 42, type: "", storagePath: "e/i/tb.xlsx",
      uploadedAt: Date.parse("2026-07-14T01:00:00Z"), downloadedAt: null,
      rejected: true, isSample: false,
    });
  });

  it("maps nested item relations and comment counts", () => {
    const item = mapItem({
      id: "i1", ref: "01", category: "", description: "Bank statement", required: 1,
      due_date: "2026-07-20", status: "outstanding", note: null, firm_note: null,
      archived_at: null, sort: null,
      item_files: [{ id: "f1", name: "a.pdf", size: 3, storage_path: "e/i/a.pdf" }],
      item_history: [{ at: "2026-07-14T00:00:00Z", by: "Firm", action: "Requested" }],
      item_comments: [{ count: 2 }], last_firm_comment_at: "2026-07-14T02:00:00Z",
    });
    expect(item).toMatchObject({
      id: "i1", category: "General", required: true, note: "", firmNote: "",
      sort: 0, commentCount: 2, archivedAt: null,
    });
    expect(item.files).toHaveLength(1);
    expect(item.history).toEqual([mapHistory({ at: "2026-07-14T00:00:00Z", by: "Firm", action: "Requested" })]);
  });

  it("maps engagement dates and optional fields", () => {
    expect(mapEngagement({
      id: "e1", client: "ACME", client_email: null, template: "Audit",
      period_end: "2026-12-31", expires_at: null, auto_delete: 0,
      firm_seen_at: null, created_at: "2026-07-14T00:00:00Z", group_id: null,
    })).toMatchObject({
      id: "e1", client: "ACME", clientEmail: "", template: "Audit",
      periodEnd: Date.parse("2026-12-31"), expiresAt: null, autoDelete: false, groupId: null,
    });
  });
});

describe("clientApi transport", () => {
  it("sanitizes unlock codes and maps the expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ token: "tok", expires_at: "2026-07-14T08:00:00Z" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(clientApi.unlock("eng-1", "1234 5678-9012 3456")).resolves.toEqual({
      token: "tok", expiresAt: Date.parse("2026-07-14T08:00:00Z"),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      action: "unlock", engagement_id: "eng-1", code: "1234567890123456",
    });
  });

  it("surfaces backend messages and HTTP status codes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "wrong code" }, { ok: false, status: 401 })));
    await expect(clientApi.unlock("eng-1", "0".repeat(16))).rejects.toMatchObject({
      message: "wrong code", status: 401,
    });
  });

  it("uploads bytes before confirming the authoritative storage path", async () => {
    const file = new File(["abc"], "workpaper.pdf", { type: "application/pdf" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ path: "e1/i1/object.pdf", put_url: "https://upload.example" }))
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(clientApi.uploadDocument("tok", "i1", file, "e1")).resolves.toEqual({
      storagePath: "e1/i1/object.pdf",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://upload.example",
      expect.objectContaining({ method: "PUT", body: file }),
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      action: "confirm", token: "tok", engagement_id: "e1", item_id: "i1",
      storage_path: "e1/i1/object.pdf",
    });
  });

  it("does not confirm when the object upload fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ path: "e1/i1/object.pdf", put_url: "https://upload.example" }))
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(clientApi.uploadDocument("tok", "i1", new File(["x"], "a.pdf"), "e1"))
      .rejects.toThrow("upload failed (503)");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
