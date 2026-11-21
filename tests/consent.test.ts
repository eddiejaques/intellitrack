import { describe, expect, it } from "vitest";
import { consentIssues } from "../extension/src/shared/consent";
import { ev, resetIds } from "../fixtures/sessions";

describe("consentIssues (X2)", () => {
  it("a clean session (consent on every hit) has no issues", () => {
    resetIds();
    const evs = [ev(0, "page_view"), ev(1, "view_item"), ev(2, "add_to_cart")];
    expect(consentIssues(evs)).toEqual([]);
  });

  it("no consent signal on any hit: one high-severity issue, no others", () => {
    resetIds();
    const evs = [ev(0, "page_view", { consent: {} }), ev(1, "view_item", { consent: {} })];
    const issues = consentIssues(evs);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "no_signals", severity: "high" });
    expect(issues[0].events.map((e) => e.id)).toEqual(evs.map((e) => e.id));
  });

  it("a hit before any consent default was set is its own high-severity issue", () => {
    resetIds();
    const early = ev(0, "page_view", { consent: {} });
    const later = ev(1, "view_item"); // has the default gcs
    const issues = consentIssues([early, later]);
    const before = issues.find((i) => i.kind === "before_default")!;
    expect(before.severity).toBe("high");
    expect(before.events.map((e) => e.id)).toEqual([early.id]);
    expect(issues.some((i) => i.kind === "partial_missing")).toBe(false);
  });

  it("a signal missing on a hit scattered after the default is medium, not before_default", () => {
    resetIds();
    const evs = [ev(0, "page_view"), ev(1, "view_item", { consent: {} }), ev(2, "add_to_cart")];
    const issues = consentIssues(evs);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: "partial_missing", severity: "medium" });
    expect(issues[0].events.map((e) => e.id)).toEqual([evs[1].id]);
  });

  it("user_id sent while analytics_storage is denied is flagged regardless of other issues", () => {
    resetIds();
    const denied = ev(0, "login", { consent: { gcs: "G100" }, user: { client_id: "1.1", user_id: "u1" } });
    const issues = consentIssues([denied]);
    expect(issues.some((i) => i.kind === "uid_denied" && i.severity === "high" && i.events[0].id === denied.id)).toBe(true);
  });

  it("covers Google Ads hits too, not only GA4", () => {
    resetIds();
    const adsNoConsent = ev(0, "conversion", { vendor: "google_ads", property: "AW-1", consent: {} });
    const issues = consentIssues([adsNoConsent]);
    expect(issues[0]).toMatchObject({ kind: "no_signals", severity: "high" });
  });

  it("ignores vendors other than GA4 and Google Ads", () => {
    resetIds();
    const other = ev(0, "pageview", { vendor: "meta", consent: {} });
    expect(consentIssues([other])).toEqual([]);
  });
});
