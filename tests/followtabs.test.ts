import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store: Record<string, unknown> = {};
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  (globalThis as any).chrome = {
    storage: { session: { get: async (k: string) => ({ [k]: structuredClone(store[k]) }), set: async (o: object) => void Object.assign(store, structuredClone(o)) }, local: { get: async () => ({}) } },
    tabs: { get: async (id: number) => ({ id, url: "https://www.shop.example/" }) },
  };
  vi.resetModules();
});
const GA = "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2&dl=https%3A%2F%2Fwww.shop.example%2Fp%2F1";
const req = (tabId: number, requestId: string) => ({ requestId, url: GA, method: "POST", tabId, type: "ping", timeStamp: Date.now() + 300, body: "en=page_view" });

describe("follow tabs opened by the recorded tab", () => {
  it("a tab opened from the recorded tab joins; unrelated tabs do not", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    expect(await c.followTab(7, 8)).toBe(true);   // product opened in a new tab
    expect(await c.followTab(8, 9)).toBe(true);   // which opens checkout in another
    expect(await c.followTab(50, 51)).toBe(false); // opened by an unrelated tab
    expect(await c.followTab(7, 8)).toBe(false);   // already followed
    await c.handleRequest(req(7, "a") as any);
    await c.handleRequest(req(8, "b") as any);
    await c.handleRequest(req(9, "c") as any);
    await c.handleRequest(req(51, "d") as any);
    await c.handleRequest(req(99, "e") as any);
    const s = (await c.loadSession())!;
    expect(s.tabIds).toEqual([7, 8, 9]);
    expect(s.eventCount).toBe(3);
  });

  it("does not follow after stop, and is capped", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    for (let i = 0; i < 20; i++) await c.followTab(7, 100 + i);
    expect((await c.loadSession())!.tabIds).toHaveLength(10);
    await c.stopSession();
    expect(await c.followTab(7, 500)).toBe(false);
  });

  it("origins are learned for followed tabs too (so worker hits from them attribute)", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.followTab(7, 8);
    await c.noteTabUrl(8, "https://pay.shop.example/checkout");
    expect((await c.loadSession())!.origins).toContain("https://pay.shop.example");
    await c.noteTabUrl(77, "https://stranger.example/");
    expect((await c.loadSession())!.origins).not.toContain("https://stranger.example");
  });

  it("sessions from before this feature still work (tab list falls back to the start tab)", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.updateSession((s) => { delete s.tabIds; });
    await c.handleRequest(req(7, "a") as any);
    expect((await c.loadSession())!.eventCount).toBe(1);
  });
});
