import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store: Record<string, unknown> = {};
// per-tab badge as the browser would hold it
let badge: Record<number, { text?: string; color?: string }>;
let closedTabs: Set<number>;
const action = {
  setBadgeText: vi.fn(async ({ tabId, text }: { tabId: number; text: string }) => {
    if (closedTabs.has(tabId)) throw new Error("No tab with id");
    (badge[tabId] ??= {}).text = text;
  }),
  setBadgeBackgroundColor: vi.fn(async ({ tabId, color }: { tabId: number; color: string }) => {
    if (closedTabs.has(tabId)) throw new Error("No tab with id");
    (badge[tabId] ??= {}).color = color;
  }),
};
const setChrome = (withAction = true) => {
  (globalThis as any).chrome = {
    storage: { session: {
      get: async (k: string) => ({ [k]: structuredClone(store[k]) }),
      set: async (o: Record<string, unknown>) => void Object.assign(store, structuredClone(o)),
      remove: async (k: string) => void delete store[k],
    } },
    tabs: { get: async (id: number) => ({ id, url: "https://shop.example/" }) },
    ...(withAction ? { action } : {}),
  };
};

const URL_ = "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2&dl=https%3A%2F%2Fshop.example%2F";
const req = (over: Record<string, unknown> = {}) => ({
  requestId: "r1", url: URL_, method: "POST", tabId: 7, type: "ping", timeStamp: Date.now() + 1000, body: "en=page_view\nen=scroll", ...over,
});

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  badge = {};
  closedTabs = new Set();
  action.setBadgeText.mockClear();
  action.setBadgeBackgroundColor.mockClear();
  setChrome();
  vi.resetModules();
});

describe("badgeText", () => {
  it("exact below 1000, blank at zero, compact above", async () => {
    const { badgeText } = await import("../extension/src/background/badge");
    expect([badgeText(0), badgeText(1), badgeText(42), badgeText(999), badgeText(1000), badgeText(12_345), badgeText(500_000)]).toEqual(["", "1", "42", "999", "1k", "12k", "99k"]);
  });
});

describe("toolbar badge (T6)", () => {
  it("shows the exact running count on the recorded tab only, green while recording", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    expect(badge[7]).toEqual({ text: "", color: "#15803d" });
    await c.handleRequest(req() as any); // batched hit = 2 events
    expect(badge[7].text).toBe("2");
    await c.handleRequest(req({ requestId: "r2", body: "en=add_to_cart" }) as any);
    expect(badge[7].text).toBe("3");
    await c.handleRequest(req({ requestId: "r3", tabId: 8 }) as any); // other tab: ignored
    await c.handleCompleted("r1", 7, 204); // status updates don't touch the count
    expect(badge[7].text).toBe("3");
    expect(Object.keys(badge)).toEqual(["7"]); // unrecorded tabs never get a badge
  });

  it("matches the stored event count after a burst", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await Promise.all(Array.from({ length: 20 }, (_, i) => c.handleRequest(req({ requestId: `b${i}`, body: "en=a\nen=b" }) as any)));
    expect(badge[7].text).toBe("40");
    expect((await c.loadSession())!.eventCount).toBe(40);
  });

  it("survives service-worker suspension: rebuilt from storage.session, not memory", async () => {
    let c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(req() as any);
    vi.resetModules(); // worker torn down
    badge = {}; // and the badge was lost (e.g. navigation reset it)
    c = await import("../extension/src/background/capture");
    await c.restoreBadge();
    expect(badge[7]).toEqual({ text: "2", color: "#15803d" });
    await c.handleRequest(req({ requestId: "after", body: "en=purchase" }) as any);
    expect(badge[7].text).toBe("3");
  });

  it("stop keeps the final count in grey; a new session resets it and blanks the old tab", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(req() as any);
    await c.stopSession();
    expect(badge[7]).toEqual({ text: "2", color: "#6b7280" });
    await c.handleRequest(req({ requestId: "late" }) as any);
    expect(badge[7].text).toBe("2"); // not recording: no change
    (globalThis as any).chrome.tabs.get = async (id: number) => ({ id, url: "https://other.example/" });
    await c.startSession(9);
    expect(badge[7].text).toBe(""); // old tab cleared
    expect(badge[9]).toEqual({ text: "", color: "#15803d" });
  });

  it("clear removes the session and blanks the badge", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    await c.handleRequest(req() as any);
    await c.clearSession();
    expect(badge[7].text).toBe("");
    expect(await c.loadSession()).toBeUndefined();
    await c.restoreBadge(); // nothing to restore, no throw
  });

  it("capture keeps working when the tab is gone or chrome.action is missing", async () => {
    let c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const s = await c.startSession(7);
    closedTabs.add(7);
    await c.handleRequest(req() as any);
    expect((await st.getEvents(s.id)).length).toBe(2);

    vi.resetModules();
    setChrome(false);
    c = await import("../extension/src/background/capture");
    await c.handleRequest(req({ requestId: "x", body: "en=a" }) as any);
    expect((await c.loadSession())!.eventCount).toBe(3);
  });
});

describe("T4 session helpers", () => {
  it("markers can be tied to a plan step id", async () => {
    const c = await import("../extension/src/background/capture");
    await c.startSession(7);
    expect((await c.addMarker("Add to cart", "S2"))!.id).toBe("S2");
    expect((await c.loadSession())!.markers.map((m) => m.id)).toEqual(["S2"]);
  });
  it("updateSession mutates and persists, and returns undefined without a session", async () => {
    const c = await import("../extension/src/background/capture");
    expect(await c.updateSession(() => 1)).toBeUndefined();
    await c.startSession(7);
    expect(await c.updateSession((s) => { s.plan_calls = 3; return "ok"; })).toBe("ok");
    expect((await c.loadSession())!.plan_calls).toBe(3);
  });
});
