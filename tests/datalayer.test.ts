// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDataLayerObserver, type RawPush } from "../extension/src/content/dataLayer";
import { describePush, isGa4EventPush, pushLabel, redactDeep, sentStatus, toPushFields, type DataLayerRow } from "../extension/src/shared/datalayer";

const w = window as any;
function reset() {
  delete w.__intellitrack_dl;
  delete w.dataLayer;
  delete w.myLayer;
  document.head.innerHTML = "";
}

describe("dataLayer observer (page side)", () => {
  // each test gets its own sink, so observers left over from earlier tests can't write into it
  let got: RawPush[];
  let emit: (p: RawPush) => void;
  beforeEach(() => { reset(); const mine: RawPush[] = []; got = mine; emit = (p) => void mine.push(p); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); reset(); });

  it("records object pushes and keeps push's return value", () => {
    w.dataLayer = [];
    installDataLayerObserver([], emit);
    const n = w.dataLayer.push({ event: "view_item_list", ecommerce: { items: [{ item_id: "SKU1" }] } });
    expect(n).toBe(1);
    expect(w.dataLayer).toHaveLength(1);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "object", layer: "dataLayer", payload: { event: "view_item_list", ecommerce: { items: [{ item_id: "SKU1" }] } } });
    expect(got[0].replayed).toBeUndefined();
  });

  it("recognises gtag arguments objects", () => {
    installDataLayerObserver([], emit);
    w.dataLayer = w.dataLayer || [];
    function gtag(..._a: unknown[]) { w.dataLayer.push(arguments); } // eslint-disable-line prefer-rest-params
    gtag("event", "add_to_cart", { value: 9.5, currency: "EUR" });
    gtag("config", "G-TEST000001");
    expect(got.map((g) => [g.kind, g.payload])).toEqual([
      ["gtag", ["event", "add_to_cart", { value: 9.5, currency: "EUR" }]],
      ["gtag", ["config", "G-TEST000001"]],
    ]);
  });

  it("hooks a dataLayer created after it runs, and replays items already in an array", () => {
    installDataLayerObserver([], emit);
    expect(got).toHaveLength(0);
    w.dataLayer = [{ event: "early" }]; // created late, with an item already in it
    w.dataLayer.push({ event: "late" });
    expect(got.map((g) => [(g.payload as any).event, g.replayed ?? false])).toEqual([["early", true], ["late", false]]);
  });

  it("still records after GTM/gtag.js assign their own push, without recursion or double counting", () => {
    w.dataLayer = [];
    installDataLayerObserver([], emit);
    // what GTM does: keep the push it found, install its own that calls it
    const arr = w.dataLayer;
    const found = arr.push;
    const processed: unknown[] = [];
    arr.push = function (...xs: unknown[]) { const r = found.apply(arr, xs); processed.push(...xs); return r; };
    const r = arr.push({ event: "purchase" });
    expect(r).toBe(1);
    expect(arr).toHaveLength(1);
    expect(processed).toEqual([{ event: "purchase" }]);
    expect(got).toHaveLength(1);
    // a second library on top
    const found2 = arr.push;
    arr.push = function (...xs: unknown[]) { return found2.apply(arr, xs); };
    arr.push({ event: "refund" });
    expect(arr).toHaveLength(2);
    expect(got.map((g) => (g.payload as any).event)).toEqual(["purchase", "refund"]);
  });

  it("passes through what the page's push throws", () => {
    w.dataLayer = [];
    installDataLayerObserver([], emit);
    w.dataLayer.push = () => { throw new TypeError("boom"); };
    expect(() => w.dataLayer.push({ event: "x" })).toThrow("boom");
    expect(got).toHaveLength(1);
  });

  it("finds a renamed dataLayer from gtm.js?l=…, also when the script is added later", async () => {
    installDataLayerObserver([], emit);
    w.myLayer = [{ "gtm.start": 1, event: "gtm.js" }];
    const s = document.createElement("script");
    s.src = "https://www.googletagmanager.com/gtm.js?id=GTM-TEST01&l=myLayer";
    document.head.append(s);
    await vi.advanceTimersByTimeAsync(0); // MutationObserver callback
    w.myLayer.push({ event: "sign_up" });
    expect(got.map((g) => [g.layer, (g.payload as any).event])).toEqual([["myLayer", "gtm.js"], ["myLayer", "sign_up"]]);
  });

  it("makes payloads safe to clone: functions, elements, dates, cycles", () => {
    w.dataLayer = [];
    installDataLayerObserver([], emit);
    const cyc: any = { a: 1 };
    cyc.self = cyc;
    w.dataLayer.push({ event: "gtm.click", "gtm.element": document.body, eventCallback: () => 1, when: new Date(0), cyc });
    expect(got[0].payload).toEqual({ event: "gtm.click", "gtm.element": "[element body]", eventCallback: "[function]", when: "1970-01-01T00:00:00.000Z", cyc: { a: 1, self: "[circular]" } });
    expect(() => structuredClone(got[0])).not.toThrow();
  });

  it("is self-contained, so it survives serialisation by executeScript", () => {
    const standalone = new Function(`return (${installDataLayerObserver.toString()})`)();
    w.dataLayer = [];
    standalone([], emit);
    w.dataLayer.push({ event: "serialised" });
    expect(got).toHaveLength(1);
  });

  it("installs once per page", () => {
    w.dataLayer = [];
    expect(installDataLayerObserver([], emit)).toBe(true);
    expect(installDataLayerObserver([], emit)).toBe(false);
    w.dataLayer.push({ event: "once" });
    expect(got).toHaveLength(1);
  });
});

describe("dataLayer records (background side)", () => {
  it("redacts PII in pushed payloads", () => {
    const f = toPushFields({ at: 1, kind: "object", payload: { event: "sign_up", user_data: { email: "jane@example.com", phone_number: "+44 20 7946 0000" }, note: "mail me at a@b.co" } })!;
    expect(f.payload).toEqual({ event: "sign_up", user_data: { email: "[email:plaintext]", phone_number: "[phone:plaintext]" }, note: "mail me at [email:plaintext]" });
    expect(JSON.stringify(redactDeep(["event", "login", { method: "x@y.com" }]))).not.toContain("x@y.com");
  });

  it("rejects junk and caps payload size", () => {
    expect(toPushFields(null)).toBeUndefined();
    expect(toPushFields({ at: "now", kind: "object", payload: {} })).toBeUndefined();
    expect(toPushFields({ at: 1, kind: "evil", payload: {} })).toBeUndefined();
    const big = toPushFields({ at: 1, kind: "object", payload: { blob: Array.from({ length: 50 }, () => "x".repeat(500)) } })!;
    expect(big.payload).toHaveProperty("[truncated]");
    expect(toPushFields({ at: 1, kind: "object", payload: {}, layer: "<script>" })!.layer).toBe("dataLayer");
  });

  it("names events from the event key or the gtag command", () => {
    expect(describePush("object", { event: "add_to_cart" })).toEqual({ command: "push", name: "add_to_cart" });
    expect(describePush("gtag", ["event", "purchase", {}])).toEqual({ command: "event", name: "purchase" });
    expect(describePush("gtag", ["consent", "default", {}])).toEqual({ command: "consent", name: "default" });
    expect(pushLabel({ kind: "gtag", command: "config", name: "G-TEST000001" })).toBe("config G-TEST000001");
    expect(pushLabel({ kind: "object", command: "push" })).toBe("(no event)");
    expect(isGa4EventPush({ kind: "object", command: "push", name: "gtm.dom" })).toBe(false);
    expect(isGa4EventPush({ kind: "gtag", command: "config", name: "G-TEST000001" })).toBe(false);
    expect(isGa4EventPush({ kind: "object", command: "push", name: "view_item_list" })).toBe(true);
    // Google Ads-only conversions are not GA4 events; a mixed send_to still is
    expect(isGa4EventPush({ kind: "gtag", command: "event", name: "conversion", payload: ["event", "conversion", { send_to: "AW-123456789/AbC" }] })).toBe(false);
    expect(isGa4EventPush({ kind: "gtag", command: "event", name: "purchase", payload: ["event", "purchase", { send_to: ["AW-123456789/AbC", "G-TEST000001"] }] })).toBe(true);
    expect(isGa4EventPush({ kind: "gtag", command: "event", name: "purchase", payload: ["event", "purchase", { value: 1 }] })).toBe(true);
  });

  it("matches pushed GA4 events to sent hits within the same page load", () => {
    const row = (id: string, name: string, documentId: string | undefined, path = "/products/:id", kind: "gtag" | "object" = "object"): DataLayerRow => ({
      key: id, id, sessionId: "s", t: 0, tabId: 7, documentId, path, layer: "dataLayer", kind,
      command: kind === "gtag" ? "event" : "push", name, payload: {},
    });
    const pushes = [
      row("a", "view_item", "DOC1"),
      row("b", "add_to_cart", "DOC1", "/products/:id", "gtag"),
      row("c", "view_item", "DOC2"), // reload of the same page: the hit came from DOC1 only
      row("d", "gtm.load", "DOC1"),
      row("e", "page_view", "DOC3", "/cart"),
      { ...row("f", "view_item_list", "DOC0"), replayed: true, before_recording: true },
    ];
    const events = [
      { vendor: "ga4", event: "view_item", documentId: "DOC1", page: { path: "/products/123" } },
      { vendor: "ga4", event: "add_to_cart", documentId: "DOCX", page: { path: "/products/123" } },
      { vendor: "google_ads", event: "page_view", documentId: "DOC3", page: { path: "/cart" } },
      { vendor: "ga4", event: "page_view", page: { path: "/cart" } }, // from a service worker: no documentId
    ];
    const v = sentStatus(pushes, events);
    expect(Object.fromEntries(v)).toEqual({ a: "sent", b: "not_sent", c: "not_sent", e: "sent" });
  });
});

describe("handleDataLayerPush", () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.resetModules();
    (globalThis as any).chrome = {
      storage: {
        session: {
          get: async (k: string) => ({ [k]: structuredClone(store[k]) }),
          set: async (o: Record<string, unknown>) => void Object.assign(store, structuredClone(o)),
        },
      },
      tabs: { get: async (id: number) => ({ id, url: "https://shop.example/" }) },
    };
  });

  it("stores redacted pushes from the recorded tab's top frame only", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const raw = { at: Date.now(), kind: "object", payload: { event: "generate_lead", email: "jane@example.com" } };
    const from = { tabId: 7, frameId: 0, documentId: "DOC1", url: "https://shop.example/products/12345?x=1" };
    expect(await c.handleDataLayerPush(from, raw)).toBe(false); // not recording
    const s = await c.startSession(7);
    expect(await c.handleDataLayerPush({ ...from, tabId: 8 }, raw)).toBe(false); // other tab
    expect(await c.handleDataLayerPush({ ...from, frameId: 3 }, raw)).toBe(false); // iframe
    expect(await c.handleDataLayerPush(from, raw)).toBe(true);
    expect(await c.isRecordedTab(7)).toBe(true);
    expect(await c.isRecordedTab(8)).toBe(false);
    const rows = await st.getPushes(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "dl_0001", name: "generate_lead", command: "push", documentId: "DOC1", path: "/products/:id", payload: { email: "[email:plaintext]" } });
    expect(JSON.stringify(rows)).not.toContain("jane@example.com");
    await st.deleteSession(s.id);
    expect(await st.getPushes(s.id)).toHaveLength(0);
  });

  it("flags replayed pushes from a page loaded before Start, but not from pages loaded after", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const s = await c.startSession(7);
    const from = { tabId: 7, frameId: 0, documentId: "DOC1", url: "https://shop.example/" };
    await c.handleDataLayerPush(from, { at: Date.now(), kind: "object", payload: { event: "view_item" }, replayed: true, origin: s.startedAt - 5000 });
    await c.handleDataLayerPush({ ...from, documentId: "DOC2" }, { at: Date.now(), kind: "object", payload: { event: "view_item" }, replayed: true, origin: s.startedAt + 10 });
    const rows = await st.getPushes(s.id);
    expect(rows.map((r) => r.before_recording ?? false)).toEqual([true, false]);
    expect(Object.fromEntries(sentStatus(rows, []))).toEqual({ [rows[1].key]: "not_sent" });
  });

  it("puts the page load id on captured GA4 events", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const s = await c.startSession(7);
    await c.handleRequest({
      requestId: "r1", method: "POST", tabId: 7, type: "ping", timeStamp: Date.now(), documentId: "DOC1",
      url: "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2&en=view_item&dl=https%3A%2F%2Fshop.example%2F",
    });
    const [e] = await st.getEvents(s.id);
    expect(e).toMatchObject({ event: "view_item", documentId: "DOC1", tabId: 7 });
  });
});
