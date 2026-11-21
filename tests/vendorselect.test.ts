import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VENDORS, ga4Properties, selectedEventCount, sessionGa4Property, sessionVendors } from "../extension/src/shared/vendors";
import { guessVendor } from "../extension/src/vendors/tagHint";
import { buildPayload } from "../extension/src/minimize";
import { adsConversion, ecommerceWithAds, ecommercePlan, session } from "../fixtures/sessions";

describe("selection helpers", () => {
  it("defaults to GA4 and counts only the selected vendors", () => {
    expect(DEFAULT_VENDORS).toEqual(["ga4"]);
    expect(sessionVendors({})).toEqual(["ga4"]);
    const s = { eventCount: 7, vendor_counts: { ga4: 5, google_ads: 2 } };
    expect(selectedEventCount({ ...s })).toBe(5);
    expect(selectedEventCount({ ...s, vendors: ["ga4", "google_ads"] })).toBe(7);
    expect(selectedEventCount({ ...s, vendors: ["google_ads"] })).toBe(2);
    expect(selectedEventCount({ ...s, vendors: [] })).toBe(0);
    expect(selectedEventCount({ eventCount: 4 })).toBe(4); // session from before per-vendor counts
  });
});

describe("X18: one GA4 property at a time", () => {
  const ev = (t: number, property: string, vendor = "ga4") => ({ vendor, property, t } as any);

  it("lists distinct GA4 properties in first-seen order, ignoring other vendors", () => {
    const events = [ev(2, "G-TWO"), ev(1, "G-ONE"), ev(3, "G-ONE"), ev(0, "AW-1", "google_ads")];
    expect(ga4Properties(events)).toEqual(["G-ONE", "G-TWO"]);
  });

  it("a single property (or none) needs no selection", () => {
    expect(sessionGa4Property({}, ["G-ONE"])).toBeUndefined();
    expect(sessionGa4Property({}, [])).toBeUndefined();
  });

  it("defaults to the first property seen, until the user picks another", () => {
    const props = ["G-ONE", "G-TWO"];
    expect(sessionGa4Property({}, props)).toBe("G-ONE");
    expect(sessionGa4Property({ ga4_property: "G-TWO" }, props)).toBe("G-TWO");
  });

  it("falls back to the first property if the stored choice is no longer present", () => {
    expect(sessionGa4Property({ ga4_property: "G-GONE" }, ["G-ONE", "G-TWO"])).toBe("G-ONE");
  });

  it("scoping events to one property keeps every other vendor untouched", () => {
    const events = [ev(0, "G-ONE"), ev(1, "G-TWO"), ev(2, "AW-1", "google_ads")];
    const scoped = events.filter((e) => e.vendor !== "ga4" || e.property === "G-ONE");
    expect(scoped.map((e) => e.property)).toEqual(["G-ONE", "AW-1"]);
  });
});

describe("guessVendor", () => {
  it("names common trackers so unparsed rows are readable", () => {
    expect(guessVendor("https://analytics.tiktok.com/api/v2/pixel/act")).toBe("TikTok");
    expect(guessVendor("https://bat.bing.com/actionp/0?x=1")).toBe("Microsoft Ads");
    expect(guessVendor("https://sslwidget.criteo.com/event?a=1")).toBe("Criteo");
    expect(guessVendor("https://www.facebook.com/tr?id=1")).toBe("Meta");
    expect(guessVendor("https://www.google-analytics.com/collect?v=1&tid=UA-1-1")).toBe("Universal Analytics (legacy)");
    expect(guessVendor("https://www.google-analytics.com/j/collect?v=1")).toBe("Universal Analytics (legacy)");
    expect(guessVendor("https://shop.example/whatever")).toBeUndefined();
    expect(guessVendor("nope")).toBeUndefined();
  });
});

describe("selection in the audit", () => {
  const all = () => ecommerceWithAds();
  it("a GA4-only audit ignores Google Ads events and the cross-vendor rules", () => {
    const evs = all();
    evs[evs.length - 1].params.value = 99; // would be a GA4/Ads mismatch
    const ga4Only = buildPayload({ session: session(), events: evs.filter((e) => e.vendor === "ga4"), plan: ecommercePlan });
    expect(ga4Only.events.every((e) => e.vendor === "ga4")).toBe(true);
    expect(ga4Only.rule_findings.some((f) => f.vendor === "google_ads")).toBe(false);
    const both = buildPayload({ session: session(), events: evs, plan: ecommercePlan });
    expect(both.events.some((e) => e.vendor === "google_ads")).toBe(true);
    expect(both.rule_findings.some((f) => f.category === "cross_vendor_mismatch")).toBe(true);
  });
  it("selecting only Google Ads over a GA4-less session is an empty audit, not 19 failures", () => {
    const p = buildPayload({ session: session(), events: all().filter((e) => e.vendor === "google_ads"), plan: ecommercePlan });
    expect(p.stats.raw_events).toBe(1);
    void adsConversion;
  });
});

describe("capture keeps per-vendor counts and the default choice", () => {
  const store: Record<string, unknown> = {};
  let local: Record<string, unknown>;
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    local = {};
    (globalThis as any).chrome = {
      storage: {
        session: { get: async (k: string) => ({ [k]: structuredClone(store[k]) }), set: async (o: object) => void Object.assign(store, structuredClone(o)), remove: async (k: string) => void delete store[k] },
        local: { get: async (k: string) => ({ [k]: local[k] }) },
      },
      tabs: { get: async (id: number) => ({ id, url: "https://shop.example/" }) },
      action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    };
    vi.resetModules();
  });
  const GA = "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2";
  const ADS = "https://www.googleadservices.com/pagead/conversion/123456789/?label=L&value=5&currency_code=EUR&oid=T1";
  const req = (url: string, requestId: string, over: object = {}) => ({ requestId, url, method: "POST", tabId: 7, type: "ping", timeStamp: Date.now() + 500, body: "en=page_view", ...over });

  it("new sessions start GA4-only unless the user chose otherwise", async () => {
    let c = await import("../extension/src/background/capture");
    expect((await c.startSession(7)).vendors).toEqual(["ga4"]);
    local.default_vendors = ["ga4", "google_ads"];
    vi.resetModules();
    c = await import("../extension/src/background/capture");
    expect((await c.startSession(7)).vendors).toEqual(["ga4", "google_ads"]);
  });
  it("everything is captured; counts and the badge follow the selection", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(req(GA, "r1", { body: "en=page_view\nen=scroll" }) as any);
    await c.handleRequest(req(ADS, "r2", { type: "image", method: "GET", body: undefined }) as any);
    let s = (await c.loadSession())!;
    expect(s.eventCount).toBe(3);
    expect(s.vendor_counts).toEqual({ ga4: 2, google_ads: 1 });
    expect(selectedEventCount(s)).toBe(2);
    const badge = (chrome as any).action.setBadgeText as ReturnType<typeof vi.fn>;
    expect(badge.mock.calls.at(-1)![0].text).toBe("2"); // GA4 only

    await c.updateSession((m) => { m.vendors = ["ga4", "google_ads"]; });
    s = (await c.loadSession())!;
    expect(selectedEventCount(s)).toBe(3);
    expect(badge.mock.calls.at(-1)![0].text).toBe("3");
    await c.updateSession((m) => { m.vendors = []; });
    expect(badge.mock.calls.at(-1)![0].text).toBe("");
  });
});
