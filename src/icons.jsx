// Shared line-icon set (stroke 1.7, currentColor) — replaces emoji across the
// firm + client apps for a consistent, professional look. Approved via preview.
// Usage: <Icon name="chat" size={16} className="…" />
import React from "react";

const P = {
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  folder: '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/>',
  paperclip: '<path d="M21 8.5 12.5 17a4 4 0 0 1-6-6l8-8a3 3 0 0 1 4 4l-8 8a1.5 1.5 0 0 1-2-2l7-7"/>',
  upload: '<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  return: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a4 4 0 0 1 4 4v3"/>',
  reopen: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v5h5"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
  note: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v5M14 11v5"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  hourglass: '<path d="M6 2h12M6 22h12"/><path d="M6 2c0 4 3 6 6 10 3-4 6-6 6-10"/><path d="M6 22c0-4 3-6 6-10 3 4 6 6 6 10"/>',
  alert: '<path d="M10.3 3.5 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.5a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M6 21v-1a6 6 0 0 1 12 0v1"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="1.5"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 8-8"/><path d="m16 6 3 3M19 3l2 2"/>',
  external: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  line: '<rect x="3" y="4" width="18" height="13" rx="4"/><path d="m8 21 3-4"/><path d="M8 9v4M8 9l3 4V9M13 9v4h2M18 9v4"/>',
};

export function Icon({ name, size = 16, className, strokeWidth = 1.7, style }) {
  const d = P[name];
  if (!d) return null;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style} aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}
