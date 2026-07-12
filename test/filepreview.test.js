import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isPreviewable, previewKind, FilePreviewModal } from "../src/FilePreview.jsx";

describe("previewKind / isPreviewable", () => {
  it("detects images by mime or extension", () => {
    expect(previewKind({ type: "image/png", name: "x" })).toBe("image");
    expect(previewKind({ type: "", name: "scan.JPG" })).toBe("image");
    expect(previewKind({ type: "", name: "logo.webp" })).toBe("image");
  });
  it("detects PDFs by mime or extension", () => {
    expect(previewKind({ type: "application/pdf", name: "x" })).toBe("pdf");
    expect(previewKind({ type: "", name: "Statement.PDF" })).toBe("pdf");
  });
  it("treats office / unknown files as not previewable", () => {
    expect(previewKind({ type: "application/vnd.ms-excel", name: "tb.xlsx" })).toBe("other");
    expect(isPreviewable({ type: "", name: "notes.docx" })).toBe(false);
    expect(isPreviewable({ type: "application/pdf", name: "a.pdf" })).toBe(true);
    expect(isPreviewable({ type: "image/gif", name: "a" })).toBe(true);
  });
});

describe("FilePreviewModal render", () => {
  const html = (file, url) =>
    renderToStaticMarkup(React.createElement(FilePreviewModal, { file, url, onClose() {} }));

  it("renders an <img> for images", () => {
    const out = html({ type: "image/png", name: "a.png" }, "https://r2/x?sig=1");
    expect(out).toContain("<img");
    expect(out).toContain("https://r2/x?sig=1");
    expect(out).not.toContain("<iframe");
  });
  it("renders an <iframe> for PDFs", () => {
    const out = html({ type: "application/pdf", name: "a.pdf" }, "https://r2/y?sig=2");
    expect(out).toContain("<iframe");
    expect(out).toContain("https://r2/y?sig=2");
  });
  it("shows a loading state before the url resolves", () => {
    const out = html({ type: "application/pdf", name: "a.pdf" }, null);
    expect(out).toContain("กำลังโหลด");
    expect(out).not.toContain("<iframe");
  });
  it("offers a download fallback for non-previewable files", () => {
    const out = html({ type: "", name: "tb.xlsx" }, "https://r2/z");
    expect(out).toContain("ดาวน์โหลด");
    expect(out).not.toContain("<iframe");
  });
});
