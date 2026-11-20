import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { silentGa4 } from "../extension/src/shared/vendors";
import { guessVendor } from "../extension/src/vendors/tagHint";

describe("tag library IDs", () => {
  it("reads the ID from gtag.js / gtm.js on Google's host or a first-party host", async () => {
    const { tagLibraryId } = await import("../extension/src/background/capture");
    expect(tagLibraryId("https://www.googletagmanager.com/gtag/js?id=G-E8KQCL36FY&cx=c&gtm=4e6bh1")).toBe("G-E8KQCL36FY");
    expect(tagLibraryId("https://www.googletagmanager.com/gtm.js?id=GTM-TMVM2DP4")).toBe("GTM-TMVM2DP4");
    expect(tagLibraryId("https://www.googletagmanager.com/gtag/js?id=AW-16468999325&cx=c")).toBe("AW-16468999325");
    expect(tagLibraryId("https://metrics.shop.example/gtm.js?l=dataLayer&id=GTM-ABC123")).toBe("GTM-ABC123");
    expect(tagLibraryId("https://www.googletagmanager.com/gtag/js?id=g-lower1")).toBe("G-LOWER1");
    expect(tagLibraryId("https://shop.example/app.js?id=G-NOTATAG")).toBeUndefined();
    expect(tagLibraryId("https://www.google-analytics.com/g/collect?v=2&tid=G-X")).toBeUndefined();
  });
});

describe("silentGa4", () => {
  it("lists GA4 IDs that loaded but produced no GA4 events", () => {
    const loads = { "GTM-TMVM2DP4": 1, "G-E8KQCL36FY": 1, "AW-16468999325": 1, "G-SECOND01": 2 };
    expect(silentGa4(loads, [])).toEqual(["G-E8KQCL36FY", "G-SECOND01"]);
    expect(silentGa4(loads, [{ vendor: "ga4", property: "G-SECOND01" }])).toEqual(["G-E8KQCL36FY"]);
    expect(silentGa4(loads, [{ vendor: "google_ads", property: "G-E8KQCL36FY" }])).toEqual(["G-E8KQCL36FY", "G-SECOND01"]);
    expect(silentGa4(undefined, [])).toEqual([]);
  });
});

describe("guessVendor for Google tag internals", () => {
  it("names ccm pings and tag diagnostics so they are not mistaken for GA4", () => {
    expect(guessVendor("https://www.google.com/ccm/collect?tid=AW-16468999325&en=page_view")).toBe("Google tag ccm · AW-16468999325");
    expect(guessVendor("https://www.google.com/ccm/collect?ae=g&en=page_view")).toBe("Google tag ccm (no ID)");
    expect(guessVendor("https://www.googletagmanager.com/a?v=3&t=l")).toBe("Google tag diagnostics");
  });
});

describe("noteTagLoad", () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as any).chrome = {
      storage: { session: { get: async (k: string) => ({ [k]: structuredClone(store[k]) }), set: async (o: object) => void Object.assign(store, structuredClone(o)) }, local: { get: async () => ({}) } },
      tabs: { get: async (id: number) => ({ id, url: "https://shop.example/" }) },
    };
    vi.resetModules();
  });
  it("counts tag loads in recorded tabs only, and only while recording", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.noteTagLoad({ url: "https://www.googletagmanager.com/gtag/js?id=G-E8KQCL36FY", tabId: 7 });
    await c.noteTagLoad({ url: "https://www.googletagmanager.com/gtag/js?id=G-E8KQCL36FY", tabId: 7 });
    await c.noteTagLoad({ url: "https://www.googletagmanager.com/gtm.js?id=GTM-TMVM2DP4", tabId: 7 });
    await c.noteTagLoad({ url: "https://www.googletagmanager.com/gtag/js?id=G-OTHERTAB", tabId: 99 });
    expect((await c.loadSession())!.tag_loads).toEqual({ "G-E8KQCL36FY": 2, "GTM-TMVM2DP4": 1 });
    await c.stopSession();
    await c.noteTagLoad({ url: "https://www.googletagmanager.com/gtag/js?id=G-LATE00001", tabId: 7 });
    expect((await c.loadSession())!.tag_loads).not.toHaveProperty("G-LATE00001");
  });
});
