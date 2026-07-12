import { describe, it, expect } from "vitest";
import { scrubUrl } from "../lib/sentry.jsx";

// The privacy-critical piece: client-portal links carry the engagement id and
// (briefly) an access token in the query string — Sentry must never store them.
describe("scrubUrl", () => {
  it("strips the query string (engagement id + token)", () => {
    expect(scrubUrl("https://app/client.html?e=abc&t=secrettoken")).toBe(
      "https://app/client.html?[scrubbed]"
    );
    expect(scrubUrl("https://app/client.html?g=grp123")).toBe(
      "https://app/client.html?[scrubbed]"
    );
  });
  it("leaves query-less URLs untouched", () => {
    expect(scrubUrl("https://app/index.html")).toBe("https://app/index.html");
  });
  it("null-guards non-strings", () => {
    expect(scrubUrl(undefined)).toBe(undefined);
    expect(scrubUrl(null)).toBe(null);
  });
});
