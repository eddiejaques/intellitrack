import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal chrome mock: storage.session + tabs.get
const store: Record<string, unknown> = {};
(globalThis as any).chrome = {
  storage: {
    session: {
      get: async (k: string) => ({ [k]: structuredClone(store[k]) }),
      set: async (o: Record<string, unknown>) => void Object.assign(store, structuredClone(o)),
    },
  },
  tabs: { get: async (id: number) => ({ id, url: "https://shop.example/" }) },
};

const URL_ = "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2&dl=https%3A%2F%2Fshop.example%2F";
const req = (over: Record<string, unknown> = {}) => ({
  requestId: "r1", url: URL_, method: "POST", tabId: 7, type: "ping", timeStamp: Date.now() + 1000,
  body: "en=page_view\nen=scroll", ...over,
});

describe("capture", () => {
  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; vi.resetModules(); });

  it("ignores requests when not recording, other tabs, and non-GA4", async () => {
    const c = await import("../extension/src/background/capture");
    await c.handleRequest(req() as any);
    expect(await c.loadSession()).toBeUndefined();
    await c.startSession(7);
    await c.handleRequest(req({ tabId: 8 }) as any);
    await c.handleRequest(req({ url: "https://x.example/other" }) as any);
    expect((await c.loadSession())!.eventCount).toBe(0);
  });

  it("stores events with unique ids, counts them, tags the current step, and joins status by requestId", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const s = await c.startSession(7);
    await c.handleRequest(req() as any);
    await c.addMarker("Add to cart");
    await c.handleRequest(req({ requestId: "r2", body: "en=add_to_cart" }) as any);
    await c.handleCompleted("r1", 7, 204);
    await c.handleError("r2", 7, "net::ERR_BLOCKED_BY_CLIENT");

    const meta = (await c.loadSession())!;
    expect(meta.eventCount).toBe(3);
    const evs = await st.getEvents(s.id);
    expect(evs.map((e) => e.id)).toEqual(["evt_0001", "evt_0002", "evt_0003"]);
    expect(evs.map((e) => e.raw_ref)).toEqual(["req_0001", "req_0001", "req_0002"]);
    expect(evs.map((e) => e.page.step)).toEqual([undefined, undefined, "S1"]);
    expect(evs[0].transport.status).toBe(204);
    expect(evs[1].transport.status).toBe(204);
    expect(evs[2].transport.error).toBe("net::ERR_BLOCKED_BY_CLIENT");
  });

  it("handles a burst of concurrent requests without losing or duplicating IDs", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const s = await c.startSession(7);
    await Promise.all(Array.from({ length: 25 }, (_, i) => c.handleRequest(req({ requestId: `c${i}`, body: "en=a\nen=b" }) as any)));
    expect((await c.loadSession())!.eventCount).toBe(50);
    const ids = new Set((await st.getEvents(s.id)).map((e) => e.id));
    expect(ids.size).toBe(50);
  });

  it("recovers state after a 'service worker restart' (fresh module, same storage.session)", async () => {
    let c = await import("../extension/src/background/capture");
    const s = await c.startSession(7);
    await c.handleRequest(req() as any);
    vi.resetModules(); // simulate worker teardown: module state gone, storage.session + IDB remain
    c = await import("../extension/src/background/capture");
    await c.handleRequest(req({ requestId: "r9", body: "en=purchase" }) as any);
    const meta = (await c.loadSession())!;
    expect(meta.id).toBe(s.id);
    expect(meta.eventCount).toBe(3);
    const st = await import("../extension/src/background/store");
    expect((await st.getEvents(s.id)).map((e) => e.id)).toEqual(["evt_0001", "evt_0002", "evt_0003"]);
  });

  it("attributes worker-originated hits (tabId -1) by origin, and learns new origins on navigation", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(req({ tabId: -1, initiator: "https://shop.example", requestId: "w1", body: "en=a" }) as any);
    await c.handleRequest(req({ tabId: -1, initiator: "https://pay.example", requestId: "w2", body: "en=b" }) as any);
    expect((await c.loadSession())!.eventCount).toBe(1);
    await c.noteTabUrl(7, "https://pay.example/checkout");
    await c.handleRequest(req({ tabId: -1, initiator: "https://pay.example", requestId: "w3", body: "en=c" }) as any);
    expect((await c.loadSession())!.eventCount).toBe(2);
  });

  it("stops recording after stop, and a new session resets counters", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(req() as any);
    await c.stopSession();
    await c.handleRequest(req({ requestId: "late" }) as any);
    expect((await c.loadSession())!.eventCount).toBe(2);
    const s2 = await c.startSession(7);
    expect(s2.eventCount).toBe(0);
    expect(s2.nextEvt).toBe(1);
  });
});
