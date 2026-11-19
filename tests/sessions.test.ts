import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPayload } from "../extension/src/minimize";
import { buildReport, runAudit, type AuditDeps } from "../extension/src/background/audit";
import { runPlanner, type PlannerDeps } from "../extension/src/background/planner";
import { defaultConfig } from "../extension/src/llm/config";
import type { LLMConfig, LLMProvider } from "../extension/src/llm/types";
import type { JourneyPlan, SessionMeta } from "../extension/src/shared/types";
import { ecommercePlan, session } from "../fixtures/sessions";

const cfg: LLMConfig = { ...defaultConfig("anthropic"), api_key: "k-123456", model: "m" };

let clock = 0; // fake-indexeddb is shared across tests: keep session IDs unique
describe("session history storage", () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    (globalThis as any).chrome = {
      storage: { session: { get: async (k: string) => ({ [k]: structuredClone(store[k]) }), set: async (o: object) => void Object.assign(store, structuredClone(o)), remove: async (k: string) => void delete store[k] } },
      tabs: { get: async (id: number) => ({ id, url: id === 1 ? "https://www.xxxlutz.de/cart#sidebar" : "https://shop.example/", title: id === 1 ? "Warenkorb" : "Shop" }) },
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_700_000_000_000 + 1_000_000 * ++clock));
    vi.resetModules();
  });

  const req = (url: string, over: object = {}) => ({ requestId: "r", url, method: "POST", tabId: 1, type: "ping", timeStamp: Date.now() + 100, body: "en=page_view", ...over });

  it("each Start is its own session, kept side by side with its own data, and tagged with the site", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const GA = "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2";

    const a = await c.startSession(1);
    await c.handleRequest(req(GA, { tabId: 1 }) as any);
    await c.stopSession();
    vi.setSystemTime(Date.now() + 5000);
    const b = await c.startSession(2);
    await c.handleRequest(req(GA, { tabId: 2, requestId: "r2", body: "en=a\nen=b" }) as any);
    await c.handleRequest(req("https://x.example/collect", { tabId: 2, requestId: "r3" }) as any);
    await c.stopSession();
    vi.setSystemTime(Date.now() + 5000);
    const c3 = await c.startSession(1); // same website again

    expect(new Set([a.id, b.id, c3.id]).size).toBe(3);
    expect(a.site).toMatchObject({ host: "www.xxxlutz.de", origin: "https://www.xxxlutz.de", title: "Warenkorb" });
    expect(a.site?.url).toBe("https://www.xxxlutz.de/cart"); // hash dropped
    const list = await st.listSessions();
    expect(list.map((s) => s.id)).toEqual([c3.id, b.id, a.id]); // newest first
    expect(list.find((s) => s.id === a.id)).toMatchObject({ eventCount: 1, status: "stopped" });
    expect(list.find((s) => s.id === b.id)).toMatchObject({ eventCount: 2, request_count: 2, unrecognized_count: 1 });
    // data is isolated per session
    expect((await st.getEvents(a.id)).length).toBe(1);
    expect((await st.getEvents(b.id)).length).toBe(2);
    expect((await st.getEvents(c3.id)).length).toBe(0);
    expect((await st.getSession(b.id))?.site?.host).toBe("shop.example");
  });

  it("deleting a session removes only its own events, tags and report", async () => {
    const c = await import("../extension/src/background/capture");
    const st = await import("../extension/src/background/store");
    const GA = "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&cid=1.2";
    const a = await c.startSession(1);
    await c.handleRequest(req(GA) as any);
    await c.stopSession();
    vi.setSystemTime(Date.now() + 5000);
    const b = await c.startSession(2);
    await c.handleRequest(req(GA, { tabId: 2, requestId: "r2" }) as any);
    await st.putReport(buildReport(a.id, buildPayload({ session: session(), events: [], plan: ecommercePlan }), { skipped: true }));
    await st.putReport(buildReport(b.id, buildPayload({ session: session(), events: [], plan: ecommercePlan }), { skipped: true }));

    await st.deleteSession(a.id);
    expect(await st.getSession(a.id)).toBeUndefined();
    expect(await st.getEvents(a.id)).toEqual([]);
    expect(await st.getRequests(a.id)).toEqual([]);
    expect(await st.getReport(a.id)).toBeUndefined();
    expect((await st.getEvents(b.id)).length).toBe(1);
    expect((await st.getRequests(b.id)).length).toBe(1);
    expect(await st.getReport(b.id)).toBeDefined();
    expect((await st.listReports()).map((r) => r.session_id)).toEqual([b.id]);
  });
});

describe("one journey by default", () => {
  it("audits the first journey only; the others stay available in the picker", async () => {
    const plan: JourneyPlan = { ...ecommercePlan, journeys: ["J1", "J2", "J3"].map((id, i) => ({ id, name: `Journey ${id}`, steps: [{ id: `S${i + 1}`, name: "x", expect: [{ vendor: "ga4", event: "page_view" }] }] })) };
    let sess: SessionMeta = { id: "s", tabId: 1, startedAt: 0, status: "recording", origins: ["https://shop.example"], eventCount: 0, nextEvt: 1, nextReq: 1, markers: [], plan_calls: 0 };
    const deps: PlannerDeps = {
      loadSession: async () => structuredClone(sess), updateSession: async (fn) => fn(sess), loadConfig: async () => cfg, getConsent: async () => "always",
      extractContext: async () => ({ domain: "d", path_pattern: "/", title: "t", meta_description: "", og_type: "", schema_types: [], forms: [], headings: [], nav_labels: [] }),
      detectedVendors: async () => [], provider: () => ({ complete: async () => JSON.stringify(plan) }) as LLMProvider, now: () => 1,
    };
    expect((await runPlanner(deps)).status).toBe("ok");
    expect(sess.plan?.journeys).toHaveLength(3);
    expect(sess.selection).toEqual({ journeys: ["J1"], excluded_steps: [] });
  });
});

describe("an empty session is inconclusive, not 19 failures", () => {
  const empty = () => buildPayload({ session: session(), events: [], plan: ecommercePlan });

  it("payload has no findings and 'no data' coverage", () => {
    const p = empty();
    expect(p.rule_findings).toEqual([]);
    expect(p.stats.raw_events).toBe(0);
    expect(p.journey_coverage).toHaveLength(4);
    expect(p.journey_coverage.every((c) => c.status === "no_data")).toBe(true);
  });
  it("the audit never calls the LLM and the report is inconclusive with diagnostics", async () => {
    const complete = vi.fn(async () => "{}");
    const d: AuditDeps = { loadConfig: async () => cfg, provider: () => ({ complete }) as LLMProvider, now: () => 1 };
    const r = await runAudit(d, "s", empty(), true, { tag_requests: 3, not_parsed: 2, duration_s: 38 });
    expect(complete).not.toHaveBeenCalled();
    expect(r).toMatchObject({ inconclusive: true, findings: [], headline: expect.stringMatching(/Nothing was captured/), diagnostics: { tag_requests: 3, not_parsed: 2 } });
    expect(r.llm.status).toBe("skipped");
  });
  it("a session with events is unaffected", () => {
    const p = buildPayload({ session: session(), events: [{ id: "evt_1", t: 1, vendor: "ga4", property: "G-1", event: "page_view", page: {}, params: {}, items: [], user: {}, consent: {}, transport: { type: "ping", method: "POST" }, raw_ref: "r" }], plan: ecommercePlan });
    expect(buildReport("s", p, { skipped: true }).inconclusive).toBeUndefined();
  });
});
