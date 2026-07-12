// =====================================================================
//  Sentry — production error monitoring for both apps (firm + client).
//
//  We use @sentry/browser (errors only) + a hand-rolled React error boundary
//  instead of @sentry/react, so the replay / feedback / tracing integrations
//  (and their ~135 kB + CSS) never reach the bundle — the client portal stays
//  lean for clients on mobile.
//
//  The DSN is PUBLIC by design (like the Supabase anon key): it only lets a
//  browser SEND events to this project. Region: EU (…ingest.de.sentry.io).
//
//  PRIVACY (this is an audit/accounting app — client data must not leak):
//    • sendDefaultPii:false  → no IP / user identifiers attached
//    • ui.input breadcrumbs dropped → never captures typed passcodes/values
//    • URLs scrubbed          → client-portal links carry engagement/token ids
//    • user object stripped   → no email/name leaves the browser
// =====================================================================
import React from "react";
import { init, captureException } from "@sentry/browser";

const DSN =
  "https://83e1d16b865e945c3ebe1221f2470d70@o4511722485121024.ingest.de.sentry.io/4511722504061008";

// Drop the query string — client portal URLs look like
// `client.html?e=<engagement_id>&t=<token>`, which we never want to store.
export function scrubUrl(url) {
  return typeof url === "string" ? url.replace(/\?.*$/, "?[scrubbed]") : url;
}

// app: "firm" | "client" — tags every event so the two surfaces are separable.
export function initSentry(app) {
  // Only report from the real deployment; never localhost/dev noise.
  const host = typeof window !== "undefined" ? window.location.hostname : "";
  if (!host || host === "localhost" || host === "127.0.0.1") return;

  init({
    dsn: DSN,
    environment: "production",
    sendDefaultPii: false, // no IP / user identifiers
    initialScope: { tags: { app } },
    beforeBreadcrumb(crumb) {
      if (crumb?.category === "ui.input") return null; // never record typed values (passcodes!)
      if (crumb?.data?.url) crumb.data.url = scrubUrl(crumb.data.url);
      return crumb;
    },
    beforeSend(event) {
      delete event.user; // never send email/name/IP
      if (event.request) {
        if (event.request.url) event.request.url = scrubUrl(event.request.url);
        delete event.request.cookies;
        delete event.request.data;
        delete event.request.query_string;
      }
      return event;
    },
  });
}

// Minimal React error boundary → renders `fallback` and reports the crash.
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, info) {
    captureException(error, { extra: { componentStack: info?.componentStack } });
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
