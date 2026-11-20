import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store: Record<string, unknown> = {};
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  (globalThis as any).chrome = {
    storage: { session: { get: async (k: string) => ({ [k]: structuredClone(store[k]) }), set: async (o: object) => void Object.assign(store, structuredClone(o)) }, local: { get: async () => ({}) } },
    tabs: { get: async (id: number) => ({ id, url: "https://www.shop.example/home" }) },
  };
  vi.resetModules();
});

const ga = (dl: string) => `https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2&dl=${encodeURIComponent(dl)}`;
const worker = (url: string, over: object = {}) => ({ requestId: "w1", url, method: "POST", tabId: -1, initiator: "https://cdn.assets-example.net", type: "ping", timeStamp: Date.now() + 500, body: "en=page_view", ...over });

describe("hits from workers (service worker / shared worker, tabId -1)", () => {
  it("hitDocumentOrigin reads the page a hit describes", async () => {
    const { hitDocumentOrigin } = await import("../extension/src/background/capture");
    expect(hitDocumentOrigin(ga("https://www.shop.example/cart?x=1"))).toBe("https://www.shop.example");
    expect(hitDocumentOrigin("https://x.example/p?url=https%3A%2F%2Fa.example%2F")).toBe("https://a.example");
    expect(hitDocumentOrigin("https://x.example/p?page_location=https%3A%2F%2Fb.example%2F")).toBe("https://b.example");
    expect(hitDocumentOrigin("https://x.example/p")).toBeUndefined();
    expect(hitDocumentOrigin("nope")).toBeUndefined();
  });

  it("a worker hit is attributed when its dl is the recorded site, even from a CDN initiator", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(worker(ga("https://www.shop.example/cart")) as any);
    const s = (await c.loadSession())!;
    expect(s.eventCount).toBe(1);
    expect(s.unattributed).toBeUndefined();
  });

  it("a worker hit about another site is not counted, but never silently dropped", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(worker(ga("https://mail.other.example/inbox"), { requestId: "a" }) as any);
    await c.handleRequest(worker(ga("https://mail.other.example/inbox"), { requestId: "b" }) as any);
    await c.handleRequest(worker("https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2", { requestId: "c", initiator: undefined }) as any); // no dl at all
    const s = (await c.loadSession())!;
    expect(s.eventCount).toBe(0);
    expect(s.unattributed?.count).toBe(3);
    expect(s.unattributed?.initiators).toEqual(["https://cdn.assets-example.net", "(no initiator)"]);
  });

  it("non-vendor worker traffic and other tabs are ignored without noise", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(worker("https://x.example/collect-custom") as any); // unparsed tracker from a worker: not claimed
    await c.handleRequest({ ...worker(ga("https://www.shop.example/")), tabId: 99 } as any); // another tab
    const s = (await c.loadSession())!;
    expect(s.eventCount).toBe(0);
    expect(s.unattributed).toBeUndefined();
  });
});
