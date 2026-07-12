import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CommentThread } from "../src/CommentThread.jsx";

const render = (props) => renderToStaticMarkup(React.createElement(CommentThread, { onSend() {}, ...props }));

describe("CommentThread", () => {
  const comments = [
    { id: "1", by: "Firm", author: "นาย ก", body: "ขอไฟล์เพิ่มครับ", at: Date.now() },
    { id: "2", by: "Client", author: null, body: "ส่งแล้วครับ", at: Date.now() },
  ];

  it("renders each comment body with its author label", () => {
    const out = render({ comments, meSide: "Firm" });
    expect(out).toContain("ขอไฟล์เพิ่มครับ");
    expect(out).toContain("ส่งแล้วครับ");
    expect(out).toContain("นาย ก"); // firm author shown
    expect(out).toContain("ลูกค้า"); // client label
  });

  it("shows an empty state when there are no comments", () => {
    expect(render({ comments: [] })).toContain("ยังไม่มีความคิดเห็น");
  });

  it("shows a loading state", () => {
    const out = render({ comments: [], loading: true });
    expect(out).toContain("กำลังโหลด");
    expect(out).not.toContain("ยังไม่มีความคิดเห็น");
  });

  it("always renders the composer input + send button", () => {
    const out = render({ comments });
    expect(out).toContain("<textarea");
    expect(out).toContain("ส่ง");
  });
});
