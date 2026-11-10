// =====================================================================
//  clientI18n — plain-object i18n for the CLIENT bundle only.
//
//  Scope: `src/ClientPortal.jsx` (the login-less view a client sees) and
//  nothing else. The firm-side app (`pbc-portal.jsx`) is never translated —
//  the firm is Thai. No library — a new dependency is forbidden here (a
//  Windows-generated lockfile omits Linux native binaries and silently
//  breaks the Cloudflare build), so this is a hand-rolled dictionary + a
//  tiny lookup/interpolation helper.
//
//  `lang` is always exactly 'th' or 'en' — it comes from the loaded
//  engagement's `language` column (default 'th'). Before an engagement has
//  loaded (the lock screen, and the brief window before the first
//  successful fetch), there is nothing to read the language FROM, so
//  callers default to 'th' — see ClientPortal.jsx's SinglePortal/
//  GroupCompany for where that default is applied.
//
//  Every key here is UI chrome — labels, buttons, empty states, error
//  fallbacks. Never put user data (client/company names, filenames,
//  category names, the firm's own note/comment text, a client's own
//  revision-request text) in this dictionary or run it through t() —
//  that text is not chrome, it's content, and translating it would put
//  words in someone's mouth they never said.
// =====================================================================

export const DICT = {
  /* ---- chrome (top bar) ---- */
  "shell.secure": { th: "การเชื่อมต่อปลอดภัย", en: "Secure connection" },
  "shell.exit": { th: "ออกจากพอร์ทัล", en: "Exit portal" },

  /* ---- loading ---- */
  "list.loading": { th: "กำลังโหลดรายการเอกสาร…", en: "Loading document list…" },

  /* ---- LINE (Android) in-app browser can't reach the camera ---- */
  "line.hint": {
    th: "อยู่ในแอป LINE — ถ่ายรูปเอกสารไม่ได้ กดเพื่อเปิดในเบราว์เซอร์",
    en: "You're in the LINE app — the camera won't work here. Tap to open in your browser",
  },
  "line.openBrowser": { th: "เปิดในเบราว์เซอร์", en: "Open in browser" },

  /* ---- portal header ---- */
  "chead.periodEnd": { th: "งวดสิ้นสุด {date} · {n} รายการ", en: "Period ending {date} · {n} items" },
  "chead.acceptedBefore": { th: "ตรวจรับแล้ว ", en: "Accepted " },
  "chead.acceptedAfter": { th: " / {total} รายการ", en: " / {total} items" },
  "chead.pending": { th: " · รอตรวจ {n}", en: " · pending review {n}" },

  /* ---- requests / deliverables segment + period switcher ---- */
  "view.requests": { th: "เอกสารที่ต้องส่ง", en: "Documents to submit" },
  "view.deliverables": { th: "งานส่งมอบ", en: "Deliverables" },
  "period.select": { th: "เลือกงวด", en: "Select period" },
  "period.closedTag": { th: "ปิดงวด", en: "Closed" },
  "period.closedOpt": { th: "ปิดแล้ว", en: "Closed" },
  "period.closedNote": {
    th: "งวดนี้ปิดแล้ว — ดูเอกสารเดิมได้ตามปกติ แต่อัปโหลดเพิ่มไม่ได้ หากต้องการส่งเอกสารเพิ่มเติม กรุณาติดต่อสำนักงาน",
    en: "This period is closed — existing documents remain viewable, but new uploads are disabled. Please contact the firm if you need to submit anything further.",
  },

  /* ---- empty / no-match states ---- */
  "list.empty": { th: "ยังไม่มีรายการเอกสารในพอร์ทัลนี้", en: "There are no document requests in this portal yet." },
  "list.noMatch": { th: "ไม่มีรายการที่ตรงกับตัวกรองนี้", en: "No items match this filter." },

  /* ---- search ---- */
  "search.placeholder": { th: "ค้นหาเอกสาร…", en: "Search documents…" },

  /* ---- alert cards ---- */
  "alert.overdueBefore": { th: "มี ", en: "" },
  "alert.overdueAfter": { th: " รายการเกินกำหนดส่ง", en: " item(s) past due" },
  "alert.clickToView": { th: "คลิกเพื่อดู", en: "click to view" },
  "alert.commentsBefore": { th: "มี ", en: "" },
  "alert.commentsAfter": { th: " ความคิดเห็นใหม่จากสำนักงาน", en: " new comment(s) from the firm" },
  "alert.clickToRead": { th: "คลิกเพื่ออ่าน", en: "click to read" },

  /* ---- filters ---- */
  "filter.clear": { th: "ล้าง ✕", en: "Clear ✕" },
  "filter.status": { th: "สถานะ", en: "Status" },
  "filter.allStatus": { th: "ทุกสถานะ · {n}", en: "All statuses · {n}" },
  "filter.category": { th: "หมวดเอกสาร", en: "Category" },
  "filter.allCategory": { th: "ทุกหมวด · {n}", en: "All categories · {n}" },
  "filter.needsAction": { th: "⚠ ต้องดำเนินการ", en: "⚠ Needs action" },
  "filter.overdue": { th: "เกินกำหนด", en: "Overdue" },
  "filter.oneItem": { th: "1 รายการ", en: "1 selected" },
  "filter.selectedCount": { th: "เลือก {n} รายการ", en: "{n} selected" },

  /* ---- status labels (request items) ---- */
  "status.outstanding": { th: "รออัปโหลด", en: "Awaiting upload" },
  "status.submitted": { th: "รอตรวจ", en: "Submitted" },
  "status.review": { th: "กำลังตรวจ", en: "Under review" },
  "status.accepted": { th: "ตรวจรับแล้ว", en: "Accepted" },
  "status.returned": { th: "ส่งกลับแก้ไข", en: "Returned for revision" },
  "status.reopened": { th: "เปิดใหม่", en: "Reopened" },
  "status.overdue": { th: "เกินกำหนด", en: "Overdue" },

  "file.noExt": { th: "ไฟล์", en: "FILE" },

  /* ---- generic counters / footer ---- */
  "common.itemsCount": { th: "{n} รายการ", en: "{n} item(s)" },
  "common.cancel": { th: "ยกเลิก", en: "Cancel" },
  "footer.secure": {
    th: "เอกสารถูกเก็บอย่างปลอดภัย · เข้าถึงได้เฉพาะพอร์ทัลของคุณ",
    en: "Documents are stored securely — accessible only through your portal.",
  },
  "footer.secureGroup": {
    th: "เอกสารถูกเก็บอย่างปลอดภัย · เข้าถึงได้เฉพาะกลุ่มของคุณ",
    en: "Documents are stored securely — accessible only through your group.",
  },

  /* ---- deliverables ---- */
  "deliv.emptyTitle": { th: "ยังไม่มีงานส่งมอบสำหรับงวดนี้", en: "No deliverables for this period yet." },
  "deliv.emptySub": {
    th: "เมื่อสำนักงานส่งเอกสารหรือรายงานให้ จะแสดงไว้ที่นี่",
    en: "When the firm sends documents or a report, they will appear here.",
  },
  "deliv.new": { th: "ใหม่", en: "New" },
  "deliv.revisionTag": { th: "ฉบับแก้ไขที่ {n}", en: "Revision {n}" },
  "deliv.dueBy": { th: "กำหนดส่งภายใน {date}", en: "Due by {date}" },
  "deliv.deliveredOn": { th: "ส่งเมื่อ {date}", en: "Delivered on {date}" },
  "deliv.noteFromFirm": { th: "หมายเหตุจากสำนักงาน:", en: "Note from the firm:" },
  "deliv.yourRevisionRequest": { th: "คุณขอให้แก้ไข:", en: "You asked for a revision:" },
  "deliv.revisionAck": {
    th: "สำนักงานได้รับคำขอแล้วและกำลังดำเนินการแก้ไข — ไม่ต้องทำอะไรเพิ่มในตอนนี้",
    en: "The firm has received your request and is working on it — no action is needed from you right now.",
  },
  "deliv.olderRounds": { th: "ฉบับก่อนหน้า ({n})", en: "Earlier versions ({n})" },
  "deliv.firstRound": { th: "ฉบับแรก", en: "First version" },
  "deliv.roundN": { th: "แก้ไขครั้งที่ {n}", en: "Revision {n}" },
  "deliv.view": { th: "ดู", en: "View" },
  "deliv.download": { th: "ดาวน์โหลด", en: "Download" },
  "deliv.chipAcked": { th: "✓ รับทราบแล้ว", en: "✓ Acknowledged" },
  "deliv.chipRequested": { th: "◐ รอสำนักงานแก้ไข", en: "◐ Awaiting the firm's revision" },
  "deliv.chipNew": { th: "● ยังไม่ได้เปิด", en: "● Not yet opened" },
  "deliv.chipWaiting": { th: "◐ รอการรับทราบ", en: "◐ Awaiting acknowledgement" },
  "deliv.ackedOn": { th: "รับทราบแล้ว · {date}", en: "Acknowledged · {date}" },
  "deliv.confirmText": {
    th: "เมื่อกดยืนยัน ระบบจะบันทึกว่าคุณได้รับเอกสารนี้แล้ว และไม่สามารถยกเลิกภายหลังได้",
    en: "Once confirmed, the system will record that you have received this document, and this cannot be undone afterward.",
  },
  "deliv.confirmAck": { th: "ยืนยันรับทราบ", en: "Confirm acknowledgement" },
  "deliv.saving": { th: "กำลังบันทึก…", en: "Saving…" },
  "deliv.revisionPrompt": {
    th: "บอกสำนักงานว่าอยากให้แก้ไขอะไร เช่น “ยอดในใบเสร็จไม่ตรงกับที่จ่ายจริง” หรือ “ชื่อ/เลขผู้เสียภาษีสะกดผิด”",
    en: "Tell the firm what needs to be corrected — for example “the amount on the receipt does not match what was actually paid” or “the name / tax ID is misspelled.”",
  },
  "deliv.revisionPlaceholder": { th: "พิมพ์รายละเอียดที่ต้องการให้แก้ไข…", en: "Describe what needs to be corrected…" },
  "deliv.sendRevision": { th: "ส่งคำขอแก้ไข", en: "Send revision request" },
  "deliv.sending": { th: "กำลังส่ง…", en: "Sending…" },
  "deliv.ackBtn": { th: "กดรับทราบ", en: "Acknowledge" },
  "deliv.revBtn": { th: "ขอแก้ไข", en: "Request revision" },
  "comments.label": { th: "ความคิดเห็น", en: "Comments" },

  /* ---- request rows ---- */
  "row.filesCount": { th: "{n} ไฟล์", en: "{n} file(s)" },
  "row.due": { th: "กำหนดส่ง {date}", en: "Due {date}" },
  "row.overdueBy": { th: " · เกิน {n} วัน", en: " · {n} day(s) overdue" },
  "row.returnedByFirm": { th: "ส่งกลับจากสำนักงาน:", en: "Returned by the firm:" },
  "row.sampleHeading": { th: "รายการที่สำนักงานเลือก / ตัวอย่าง:", en: "Reference / sample provided by the firm:" },
  "row.needsFix": { th: "ต้องแก้ไข", en: "Needs revision" },
  "row.remove": { th: "ลบ", en: "Remove" },
  "row.uploading": { th: "กำลังอัปโหลด…", en: "Uploading…" },
  "row.dropLead": { th: "ลากไฟล์มาวางที่นี่ หรือ ", en: "Drag files here, or " },
  "row.chooseFile": { th: "เลือกไฟล์", en: "choose a file" },
  "row.uploadMore": { th: "↑ อัปโหลดเพิ่ม", en: "↑ Upload more" },
  "row.takePhoto": { th: "ถ่ายรูป", en: "Take photo" },
  "row.periodClosedInline": { th: "งวดนี้ปิดแล้ว จึงอัปโหลดเพิ่มไม่ได้ในขณะนี้", en: "This period is closed, so new uploads are disabled." },

  /* ---- confirm dialogs ---- */
  "confirm.removeFile": { th: "ลบไฟล์นี้ออกจากพอร์ทัล?", en: "Remove this file from the portal?" },

  /* ---- error fallbacks (never a raw server message is guaranteed, so these
     are what shows when the server didn't send one) ---- */
  "err.load": { th: "โหลดข้อมูลไม่สำเร็จ", en: "Could not load data." },
  "err.openFile": { th: "เปิดไฟล์ไม่สำเร็จ", en: "Could not open the file." },
  "err.ack": { th: "รับทราบไม่สำเร็จ", en: "Could not record acknowledgement." },
  "err.sendRevision": { th: "ส่งคำขอแก้ไขไม่สำเร็จ", en: "Could not send the revision request." },
  "err.sendComment": { th: "ส่งความคิดเห็นไม่สำเร็จ", en: "Could not send the comment." },
  "err.upload": { th: "อัปโหลดไม่สำเร็จ", en: "Upload failed." },
  "err.removeFile": { th: "ลบไฟล์ไม่สำเร็จ", en: "Could not remove the file." },
  "err.openPreview": { th: "เปิดตัวอย่างไม่สำเร็จ", en: "Could not open the preview." },

  /* ---- client group ---- */
  "group.defaultName": { th: "กลุ่มลูกค้า", en: "Client group" },
  "group.selectCompany": { th: "เลือกบริษัทเพื่อดูและอัปโหลดเอกสาร · {n} บริษัท", en: "Select a company to view and upload documents · {n} companies" },
  "group.noCompanies": { th: "ยังไม่มีบริษัทในกลุ่มนี้", en: "There are no companies in this group yet." },
  "group.accepted": { th: "ตรวจรับ {n}", en: "Accepted {n}" },
  "group.pendingReview": { th: "รอตรวจ {n}", en: "Pending review {n}" },
  "group.awaitingUpload": { th: "รออัปโหลด {n}", en: "Awaiting upload {n}" },
  "group.noItemsYet": { th: "ยังไม่มีรายการ", en: "No items yet" },
  "group.open": { th: "เปิด →", en: "Open →" },
  "group.back": { th: "← กลับไปหน้ากลุ่ม", en: "← Back to group" },
};

// lang is expected to be exactly 'th' | 'en'; anything else falls back to
// 'th' the same way an unrecognised `engagements.cadence` value falls back
// to 'once' on the firm side — permissive, never a crash.
export function t(lang, key, params) {
  const entry = DICT[key];
  if (!entry) return key; // missing key: surface the id rather than throw
  const str = (lang === "en" ? entry.en : entry.th) ?? entry.th ?? "";
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : ""));
}
