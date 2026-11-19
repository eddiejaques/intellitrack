import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { looksLikeTag } from "../extension/src/vendors/tagHint";
import { isGa4Request, parseGa4 } from "../extension/src/vendors/ga4";
import type { RawRequest } from "../extension/src/shared/types";

describe("looksLikeTag", () => {
  it("accepts beacons, known tracker hosts and tracking-looking paths", () => {
    expect(looksLikeTag("https://example.com/whatever", "ping")).toBe(true);
    expect(looksLikeTag("https://www.facebook.com/tr?id=1&ev=PageView", "image")).toBe(true);
    expect(looksLikeTag("https://sdk.iad-01.braze.com/api/v3/data/", "xmlhttprequest")).toBe(true);
    expect(looksLikeTag("https://x.example/analytics/pixel.gif?uid=abc", "image")).toBe(true);
    expect(looksLikeTag("https://metrics.shop.example/collect", "fetch")).toBe(true);
    expect(looksLikeTag("https://x.example/api/track/event", "xmlhttprequest")).toBe(true);
    expect(looksLikeTag("https://bat.bing.com/action/0?ti=1", "image")).toBe(true);
  });
  it("ignores page assets, scripts, documents and non-http", () => {
    expect(looksLikeTag("https://shop.example/", "main_frame")).toBe(false);
    expect(looksLikeTag("https://www.googletagmanager.com/gtm.js?id=GTM-1", "script")).toBe(false);
    expect(looksLikeTag("https://shop.example/static/app.css", "stylesheet")).toBe(false);
    expect(looksLikeTag("https://shop.example/img/sofa.jpg", "image")).toBe(false);
    expect(looksLikeTag("https://shop.example/api/cart", "xmlhttprequest")).toBe(false);
    expect(looksLikeTag("chrome-extension://abc/x", "ping")).toBe(false);
    expect(looksLikeTag("not a url", "ping")).toBe(false);
  });
});

describe("GA4 on a custom server-side path", () => {
  const sgtm = "https://metrics.shop.example/ga/x7f3?v=2&tid=G-ABC123&cid=1.2&gtm=45je&gcs=G111";
  it("is recognised by its parameters alone", () => {
    expect(isGa4Request({ url: sgtm })).toBe(true);
    expect(isGa4Request({ url: "https://metrics.shop.example/ga/x7f3?v=2&tid=G-ABC123" })).toBe(false); // no cid: not enough
    expect(isGa4Request({ url: "https://x.example/ga?v=2&tid=UA-1-1&cid=1" })).toBe(false);
    expect(isGa4Request({ url: "https://x.example/ga?v=1&tid=G-1&cid=1" })).toBe(false);
    const [e] = parseGa4({ requestId: "1", url: `${sgtm}&en=page_view`, method: "POST", tabId: 1, type: "ping", timeStamp: 0 } as RawRequest);
    expect(e).toMatchObject({ event: "page_view", property: "G-ABC123" });
  });
});

describe("tag request log", () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as any).chrome = {
      storage: { session: { get: async (k: string) => ({ [k]: structuredClone(store[k]) }), set: async (o: object) => void Object.assign(store, structuredClone(o)) } },
      tabs: { get: async (id: number) => ({ id, url: "https://shop.example/" }) },
    };
    vi.resetModules();
  });
  const GA = "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2&dl=https%3A%2F%2Fshop.example%2Fcart";
  const req = (url: string, over: Partial<RawRequest> = {}): RawRequest => ({ requestId: "r1", url, method: "POST", tabId: 7, type: "ping", timeStamp: Date.now() + 1000, ...over });

  it("logs recognised and unrecognised tags, counts them, and patches status later", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const s = await c.startSession(7);
    await c.handleRequest(req(GA, { body: "en=page_view\nen=scroll" }));
    await c.handleRequest(req("https://x.example/collect-custom", { requestId: "r2", body: "x=1" }));
    await c.handleRequest(req("https://shop.example/img/a.jpg", { requestId: "r3", type: "image", method: "GET" })); // not a tag
    await c.handleCompleted("r1", 7, 204);
    await c.handleError("r2", 7, "net::ERR_BLOCKED_BY_CLIENT");

    const meta = (await c.loadSession())!;
    expect(meta).toMatchObject({ eventCount: 2, request_count: 2, unrecognized_count: 1 });
    const rows = await st.getRequests(s.id);
    expect(rows.map((r) => [r.vendor, r.events, r.status ?? r.error])).toEqual([["ga4", 2, 204], ["unrecognized", 0, "net::ERR_BLOCKED_BY_CLIENT"]]);
    expect(rows[1]).toMatchObject({ host: "x.example", method: "POST", body: "x=1" });
  });

  it("ignores other tabs and stopped sessions, and caps what it stores", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    expect(await c.mightBeTracking("https://x.example/collect-custom", "ping")).toBe(true);
    const s = await c.startSession(7);
    await c.handleRequest(req("https://x.example/collect-custom", { tabId: 9 }));
    expect((await st.getRequests(s.id)).length).toBe(0);
    await c.updateSession((m) => { m.request_count = 3000; });
    await c.handleRequest(req("https://x.example/collect-custom", { requestId: "over" }));
    expect((await st.getRequests(s.id)).length).toBe(0); // cap reached: not stored
    await c.stopSession();
    await c.updateSession((m) => { m.request_count = 0; });
    await c.handleRequest(req("https://x.example/collect-custom", { requestId: "late" }));
    expect((await st.getRequests(s.id)).length).toBe(0);
  });

  it("a GA4 hit on a renamed server-side path becomes events, not an unrecognised row", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const s = await c.startSession(7);
    await c.handleRequest(req("https://metrics.shop.example/ga/x7f3?v=2&tid=G-ABC123&cid=1.2&en=page_view"));
    const m = (await c.loadSession())!;
    expect(m.eventCount).toBe(1);
    expect(m.unrecognized_count ?? 0).toBe(0);
    expect((await st.getRequests(s.id))[0].vendor).toBe("ga4");
  });
});
