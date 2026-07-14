// Regression cover for the orphan bug: every path that deletes an item_files row
// must delete the R2 object FIRST and abort if that fails. storage_path is the
// only record an object exists, so dropping the row after a failed R2 delete
// strands the file in the bucket permanently.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const del = vi.fn();
const selectFiles = vi.fn();

// from("item_files").select("storage_path").eq(...)  -> { data, error }
// from("engagements").delete().eq(...)               -> { error }
// from("request_items").delete().eq(...)             -> { error }
const from = vi.fn((table) => ({
  select: () => ({ eq: () => selectFiles(table) }),
  delete: () => ({ eq: (_c, id) => del(table, id) }),
}));

vi.mock("../lib/supabaseClient.js", () => ({
  supabase: { from: (t) => from(t), functions: { invoke: (...a) => invoke(...a) } },
  PORTAL_FN_URL: "https://example.test/portal",
  SUPABASE_ANON_KEY: "anon",
}));

const { firmApi } = await import("../lib/portalApi.js");

beforeEach(() => {
  vi.clearAllMocks();
  selectFiles.mockResolvedValue({ data: [{ storage_path: "e1/i1/tb.xlsx" }], error: null });
  del.mockResolvedValue({ error: null });
});

describe("deleteEngagement", () => {
  it("deletes the R2 objects before the engagement row", async () => {
    invoke.mockResolvedValue({ data: { ok: true }, error: null });

    await firmApi.deleteEngagement("e1");

    expect(invoke).toHaveBeenCalledWith("firmfiles", {
      body: { action: "delete", storage_paths: ["e1/i1/tb.xlsx"] },
    });
    expect(del).toHaveBeenCalledWith("engagements", "e1");
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(del.mock.invocationCallOrder[0]);
  });

  it("keeps the DB rows when the function returns a transport error", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "forbidden" } });

    await expect(firmApi.deleteEngagement("e1")).rejects.toThrow(/forbidden/);
    expect(del).not.toHaveBeenCalled();
  });

  // functions.invoke resolves (does not throw) on a 200 that carries an error
  // body, which is exactly how the original bug slipped through.
  it("keeps the DB rows when the function replies 200 with an error body", async () => {
    invoke.mockResolvedValue({ data: { error: "R2 delete failed for 1/1 object(s)" }, error: null });

    await expect(firmApi.deleteEngagement("e1")).rejects.toThrow(/R2 delete failed/);
    expect(del).not.toHaveBeenCalled();
  });

  it("skips the storage call when the portal has no files", async () => {
    selectFiles.mockResolvedValue({ data: [], error: null });

    await firmApi.deleteEngagement("e1");

    expect(invoke).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("engagements", "e1");
  });
});

describe("purgeItem", () => {
  it("keeps the item row when the R2 delete fails", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(firmApi.purgeItem("i1")).rejects.toThrow(/boom/);
    expect(del).not.toHaveBeenCalled();
  });
});

describe("removeSample", () => {
  it("keeps the file row when the R2 delete fails", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "boom" } });

    await expect(firmApi.removeSample("f1", "e1/i1/sample.pdf")).rejects.toThrow(/boom/);
    expect(del).not.toHaveBeenCalled();
  });
});
