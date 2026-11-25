import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAdsConversion, parseAds } from "../extension/src/vendors/googleAds";
import { vendors } from "../extension/src/vendors";
import { runRules } from "../extension/src/rules";
import { buildPayload, findRawPii } from "../extension/src/minimize";
import { adsConversion, ecommerceClean, ecommercePlan, ecommerceWithAds, session } from "../fixtures/sessions";
import type { Finding, RawRequest } from "../extension/src/shared/types";

// SYNTHETIC URLs written from Google's documented gtag conversion ping. Replace with real
// captures before B1 is Done (plan §9: Ready criteria for vendor items).
const BASE = "https://www.googleadservices.com/pagead/conversion/123456789/";
const URL1 = `${BASE}?random=1&cv=11&fst=1&bg=ffffff&guid=ON&async=1&gtm=45je&label=AbCdEf_gh&value=29.9&currency_code=EUR&oid=T-1001&url=https%3A%2F%2Fshop.example%2Fthanks%3Ffoo%3D1&ref=https%3A%2F%2Fshop.example%2F&gcs=G111`;
const req = (url: string, over: Partial<RawRequest> = {}): RawRequest => ({ requestId: "1", url, method: "GET", tabId: 1, type: "image", timeStamp: 0, ...over });
const find = (fs: Finding[], re: RegExp) => fs.filter((f) => re.test(f.title));

describe("google ads matcher", () => {
  it("matches gtag, AW-prefixed, first-party 1p and proxied paths; rejects look-alikes", () => {
    expect(isAdsConversion({ url: URL1 })).toBe(true);
    expect(isAdsConversion({ url: "https://www.googleadservices.com/pagead/conversion/AW-123456789/?label=x" })).toBe(true);
    expect(isAdsConversion({ url: "https://www.google.com/pagead/1p-conversion/123456789/?label=x" })).toBe(true);
    expect(isAdsConversion({ url: "https://metrics.shop.example/pagead/conversion/123456789/?label=x" })).toBe(true);
    expect(isAdsConversion({ url: "https://www.google.com/pagead/viewthroughconversion/123456789/" })).toBe(false);
    expect(isAdsConversion({ url: "https://www.google.com/pagead/conversion/abc/" })).toBe(false);
    expect(isAdsConversion({ url: "https://x.example/g/collect?v=2&tid=G-1" })).toBe(false);
    expect(isAdsConversion({ url: "nope" })).toBe(false);
  });
  it("is registered, GA4 and Ads never claim the same request", () => {
    expect(vendors.map((v) => v.id)).toEqual(["ga4", "google_ads", "adobe_analytics"]);
    const ga = "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123";
    expect(vendors.filter((v) => v.match(req(URL1))).map((v) => v.id)).toEqual(["google_ads"]);
    expect(vendors.filter((v) => v.match(req(ga))).map((v) => v.id)).toEqual(["ga4"]);
    expect(vendors.every((v) => v.urlHint instanceof RegExp)).toBe(true);
  });
});

describe("parseAds", () => {
  it("normalizes label, value, currency, order id, property and page; drops bookkeeping noise", () => {
    const [e, ...rest] = parseAds(req(URL1));
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({ vendor: "google_ads", property: "AW-123456789", event: "conversion" });
    expect(e.params).toEqual({ label: "AbCdEf_gh", value: 29.9, currency: "EUR", transaction_id: "T-1001" });
    expect(e.page).toEqual({ path: "/thanks", query: "foo=1" });
    expect(e.consent.gcs).toBe("G111");
    expect(e.transport).toEqual({ type: "image", method: "GET" });
  });
  it("keeps identifier-like params (enhanced conversions) and nothing else", () => {
    const hash = "a".repeat(64);
    const [e] = parseAds(req(`https://www.google.com/pagead/1p-conversion/123456789/?label=L&value=5&em=${hash}&ph=%2B31612345678&random=9&foo=bar`));
    expect(e.params.em).toBe(hash);
    expect(e.params.ph).toBe("+31612345678");
    expect(e.params).not.toHaveProperty("random");
    expect(e.params).not.toHaveProperty("foo");
  });
  it("tolerates missing params and non-numeric value", () => {
    const [e] = parseAds(req(`${BASE}?value=abc`));
    expect(e.params).toEqual({ value: "abc" });
    expect(e.page).toEqual({});
  });
  it("returns nothing for non-conversion URLs", () => {
    expect(parseAds(req("https://x.example/"))).toEqual([]);
  });
});

describe("capture integration", () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as any).chrome = {
      storage: { session: { get: async (k: string) => ({ [k]: structuredClone(store[k]) }), set: async (o: object) => void Object.assign(store, structuredClone(o)) } },
      tabs: { get: async (id: number) => ({ id, url: "https://shop.example/" }) },
    };
    vi.resetModules();
  });
  it("prefilter lets Ads pings through, and a recorded ping becomes a stored event", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    expect(c.mightBeTracking(URL1)).toBe(true);
    expect(c.mightBeTracking("https://shop.example/app.js")).toBe(false);
    const s = await c.startSession(7);
    await c.handleRequest({ ...req(URL1), tabId: 7, timeStamp: Date.now() + 500 });
    await c.handleCompleted("1", 7, 200);
    const evs = await st.getEvents(s.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ vendor: "google_ads", event: "conversion", transport: { status: 200 } });
    expect((await c.loadSession())!.eventCount).toBe(1);
  });
});

describe("google ads rules", () => {
  const bad = (fs: Finding[]) => fs.filter((f) => ["critical", "high", "medium"].includes(f.severity));

  it("clean GA4 + Ads journey raises nothing", () => {
    expect(bad(runRules(ecommerceWithAds(), { plan: ecommercePlan }).findings)).toEqual([]);
  });
  it("a site without Ads is unaffected", () => {
    expect(runRules(ecommerceClean(), { plan: ecommercePlan }).findings.filter((f) => f.vendor === "google_ads")).toEqual([]);
  });
  it("value and currency mismatch between GA4 purchase and Ads conversion", () => {
    const evs = ecommerceWithAds();
    evs[evs.length - 1].params.value = 31.9;
    expect(find(runRules(evs).findings, /value differs/)).toHaveLength(1);
    const evs2 = ecommerceWithAds();
    evs2[evs2.length - 1].params.currency = "USD";
    expect(find(runRules(evs2).findings, /different currencies/)).toHaveLength(1);
    // sub-cent rounding is not a mismatch
    const evs3 = ecommerceWithAds();
    evs3[evs3.length - 1].params.value = 29.904;
    expect(find(runRules(evs3).findings, /value differs/)).toHaveLength(0);
  });
  it("GA4 purchase with no Ads conversion, and Ads conversion with no GA4 purchase", () => {
    const evs = ecommerceWithAds();
    evs[evs.length - 1].params.transaction_id = "T-OTHER";
    const fs = runRules(evs).findings;
    expect(find(fs, /purchase without a matching Google Ads/)).toHaveLength(1);
    expect(find(fs, /conversion without a matching GA4/)).toHaveLength(1);
  });
  it("duplicate Ads conversion for one order is critical-grade duplicate", () => {
    const evs = ecommerceWithAds();
    evs.push(adsConversion(40, { value: 29.9 }));
    const f = find(runRules(evs).findings, /Duplicate conversion/);
    expect(f).toHaveLength(1);
    expect(f[0].vendor).toBe("google_ads");
    expect(f[0].severity).toBe("high");
  });
  it("two different conversion actions for one order are not duplicates", () => {
    const evs = ecommerceWithAds();
    evs.push(adsConversion(15.3, { label: "OtherLabel" }));
    expect(find(runRules(evs).findings, /Duplicate/)).toHaveLength(0);
  });
  it("missing label, value without currency, missing order id", () => {
    const evs = ecommerceWithAds();
    const a = evs[evs.length - 1];
    delete a.params.label; delete a.params.currency; delete a.params.transaction_id;
    const fs = runRules(evs).findings;
    expect(find(fs, /without a label/)[0].severity).toBe("high");
    expect(find(fs, /without currency/)).toHaveLength(1);
    expect(find(fs, /without a transaction ID/)).toHaveLength(1);
  });

  it("enhanced conversions: plaintext email is critical, valid sha256 is fine, bad hash is high", () => {
    const evs = ecommerceWithAds();
    const a = evs[evs.length - 1];
    a.params.em = "jane.doe@example.com";
    const plain = find(runRules(evs).findings, /Plaintext email/);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ severity: "critical", vendor: "google_ads" });
    expect(plain[0].recommendation).toMatch(/Hash the value/);
    expect(JSON.stringify(plain)).not.toContain("jane.doe");

    const ok = ecommerceWithAds();
    ok[ok.length - 1].params.em = "b".repeat(64);
    expect(runRules(ok).findings.filter((f) => f.category === "pii")).toEqual([]);

    const badHash = ecommerceWithAds();
    badHash[badHash.length - 1].params.em = "c".repeat(40);
    expect(runRules(badHash).findings.filter((f) => f.category === "pii")[0].severity).toBe("high");
  });

  it("the payload redacts Ads identifiers too", () => {
    const evs = ecommerceWithAds();
    evs[evs.length - 1].params.em = "jane.doe@example.com";
    evs[evs.length - 1].page.query = "email=jane.doe%40example.com";
    const p = buildPayload({ session: session(), events: evs, plan: ecommercePlan });
    expect(JSON.stringify(p)).not.toContain("jane.doe");
    expect(findRawPii(p)).toEqual([]);
    expect(p.events.find((e) => e.vendor === "google_ads")!.params.em).toBe("[email:plaintext]");
  });
});
