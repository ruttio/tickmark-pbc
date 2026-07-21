import { afterEach, describe, expect, it, vi } from "vitest";
import { compressImage, isCompressibleImage, toJpegName, JPEG_QUALITY, MAX_DIMENSION } from "../src/imageCompress.js";

// jsdom has no real decode/encode pipeline, so createImageBitmap and the
// canvas 2D context/toBlob are stubbed per-test to exercise compressImage's
// branches (success, decode failure, no-improvement) without a real browser.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const bigFile = (name, size, type = "image/jpeg") => {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
};

describe("isCompressibleImage", () => {
  it("accepts raster photo formats", () => {
    for (const name of ["a.jpg", "a.JPEG", "a.png", "a.webp", "a.bmp", "a.heic"]) {
      expect(isCompressibleImage({ name })).toBe(true);
    }
  });

  it("rejects vector, animated, and non-image formats", () => {
    for (const name of ["a.svg", "a.gif", "a.pdf", "a.docx", "a.xlsx", "a.zip"]) {
      expect(isCompressibleImage({ name })).toBe(false);
    }
  });
});

describe("toJpegName", () => {
  it("swaps the extension, preserves dots inside the stem, and copes with no extension", () => {
    expect(toJpegName("bill.png")).toBe("bill.jpg");
    expect(toJpegName("photo.HEIC")).toBe("photo.jpg");
    expect(toJpegName("ภ.พ.30.png")).toBe("ภ.พ.30.jpg");
    expect(toJpegName("scan")).toBe("scan.jpg");
    expect(toJpegName("")).toBe("image.jpg");
  });
});

describe("compressImage", () => {
  it("passes non-image files through untouched without decoding anything", async () => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const file = bigFile("statement.pdf", 1000, "application/pdf");

    const out = await compressImage(file);
    expect(out).toBe(file);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("downscales and recompresses a large photo to a smaller JPEG, keeping the filename", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() }));
    const ctx = { fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: null };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb, type, quality) {
      expect(type).toBe("image/jpeg");
      expect(quality).toBe(JPEG_QUALITY);
      cb(new Blob([new Uint8Array(1000)], { type: "image/jpeg" }));
    });

    const original = bigFile("receipt.jpg", 5_000_000);
    const out = await compressImage(original);

    expect(out).not.toBe(original);
    expect(out.name).toBe("receipt.jpg");
    expect(out.type).toBe("image/jpeg");
    expect(out.size).toBeLessThan(original.size);
    // Long edge scaled down to the configured max dimension.
    const canvas = HTMLCanvasElement.prototype.getContext.mock.instances[0];
    expect(Math.max(canvas.width, canvas.height)).toBe(MAX_DIMENSION);
  });

  // Re-encoding produces JPEG bytes, so a .png/.heic input must come back named
  // .jpg — otherwise the ZIP export (which writes files by name) hands the firm
  // files whose extension lies about their contents.
  it("renames the file to .jpg when it re-encodes a non-JPEG source", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 4000, height: 3000, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb) {
      cb(new Blob([new Uint8Array(1000)], { type: "image/jpeg" }));
    });

    const out = await compressImage(bigFile("ใบเสร็จ.png", 5_000_000, "image/png"));
    expect(out.name).toBe("ใบเสร็จ.jpg");
    expect(out.type).toBe("image/jpeg");
  });

  it("falls back to the original file when decoding fails (e.g. unsupported HEIC)", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("no decoder")));
    const file = bigFile("photo.heic", 4_000_000, "image/heic");

    const out = await compressImage(file);
    expect(out).toBe(file);
  });

  it("never returns a bigger file — keeps the original if the re-encode doesn't shrink it", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 400, height: 300, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() });
    const original = bigFile("tiny.png", 500);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb) {
      cb(new Blob([new Uint8Array(original.size + 50)], { type: "image/jpeg" })); // "compressed" is bigger
    });

    const out = await compressImage(original);
    expect(out).toBe(original);
  });

  it("falls back to the original if canvas.toBlob yields nothing", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 800, height: 600, close: vi.fn() }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() });
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (cb) { cb(null); });

    const file = bigFile("weird.bmp", 2_000_000, "image/bmp");
    const out = await compressImage(file);
    expect(out).toBe(file);
  });

  it("skips SVG even though it is in ALLOWED_EXT", async () => {
    const createImageBitmap = vi.fn();
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const file = bigFile("logo.svg", 1000, "image/svg+xml");

    const out = await compressImage(file);
    expect(out).toBe(file);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});
