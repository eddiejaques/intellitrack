import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { runPlanner, applyTemplate, type PlannerDeps } from "../extension/src/background/planner";
import { confirmedPlan, liveChecklist } from "../extension/src/planner/plan";
import { templatePlan } from "../extension/src/planner/templates";
import { JOURNEY_PLAN_SCHEMA, checkPlan } from "../extension/src/shared/schemas";
import { validate } from "../extension/src/llm/schema";
import { defaultConfig } from "../extension/src/llm/config";
import type { LLMConfig, LLMProvider } from "../extension/src/llm/types";
import type { JourneyPlan, SessionMeta } from "../extension/src/shared/types";
import { ecommerceClean, ecommercePlan } from "../fixtures/sessions";

const cfg: LLMConfig = { ...defaultConfig("anthropic"), api_key: "k-123456", model: "m" };
const ctx = { domain: "shop.example", path_pattern: "/", title: "Shop", meta_description: "", og_type: "", schema_types: ["Product"], forms: [], headings: [], nav_labels: [] };

const goodPlan: JourneyPlan = JSON.parse(JSON.stringify(ecommercePlan));

function setup(over: { session?: Partial<SessionMeta>; config?: LLMConfig | undefined; consent?: "always" | "ask" | "never" | undefined; replies?: string[]; now?: () => number } = {}) {
  let session: SessionMeta | undefined = {
    id: "ses_1", tabId: 1, startedAt: 0, status: "recording", origins: ["https://shop.example"],
    eventCount: 0, nextEvt: 1, nextReq: 1, markers: [], plan_calls: 0, ...over.session,
  };
  const replies = [...(over.replies ?? [JSON.stringify(goodPlan)])];
  const complete = vi.fn(async (_r: { system: string; user: string; jsonSchema: object }) => replies.shift() ?? "{}");
  const deps: PlannerDeps = {
    loadSession: async () => session && structuredClone(session),
    updateSession: async (fn) => { if (!session) return undefined; return fn(session); },
    loadConfig: async () => ("config" in over ? over.config : cfg),
    getConsent: async () => ("consent" in over ? over.consent : "always"),
    extractContext: async () => structuredClone(ctx),
    detectedVendors: async () => [{ vendor: "ga4", property: "G-ABC123" }],
    provider: () => ({ complete }) as LLMProvider,
    now: over.now ?? (() => 1_000_000),
  };
  return { deps, complete, get session() { return session; } };
}

describe("templates and schema", () => {
  it.each(["ecommerce", "lead_generation", "content", "other"] as const)("%s template satisfies the plan schema", (t) => {
    const p = templatePlan(t);
    expect(validate(JOURNEY_PLAN_SCHEMA, p)).toEqual([]);
    expect(checkPlan(p)).toEqual([]);
  });
  it("checkPlan rejects step ids reused across journeys", () => {
    const p = templatePlan("ecommerce");
    p.journeys.push({ id: "J2", name: "again", steps: [{ id: "S1", name: "x", expect: [{ vendor: "ga4", event: "page_view" }] }] });
    expect(checkPlan(p)[0]).toMatch(/step id "S1" is used twice/);
  });
  it("schema rejects unknown vendors and bad event names", () => {
    const p = templatePlan("other");
    (p.journeys[0].steps[0].expect[0] as any).vendor = "braze";
    p.journeys[0].steps[0].expect[0].event = "Page View";
    expect(validate(JOURNEY_PLAN_SCHEMA, p).length).toBe(2);
  });
});

describe("runPlanner flow", () => {
  it("not recording / no session", async () => {
    const t = setup({ session: { status: "stopped" } });
    expect(await runPlanner(t.deps)).toMatchObject({ status: "error", kind: "no_session" });
  });
  it("no LLM configured -> manual", async () => {
    expect(await runPlanner(setup({ config: undefined }).deps)).toMatchObject({ status: "manual", reason: "no_config" });
    expect(await runPlanner(setup({ config: { ...cfg, api_key: "" } }).deps)).toMatchObject({ status: "manual", reason: "no_config" });
  });
  it("first visit asks for consent and calls nothing", async () => {
    const t = setup({ consent: undefined });
    expect(await runPlanner(t.deps)).toEqual({ status: "needs_consent", origin: "https://shop.example" });
    expect(t.complete).not.toHaveBeenCalled();
  });
  it("'never' goes manual without calling the LLM or counting a call", async () => {
    const t = setup({ consent: "never" });
    expect(await runPlanner(t.deps)).toMatchObject({ status: "manual", reason: "never" });
    expect(t.complete).not.toHaveBeenCalled();
    expect(t.session!.plan_calls).toBe(0);
  });
  it("'ask' returns the exact context to preview, and only sends once confirmed", async () => {
    const t = setup({ consent: "ask" });
    const r = await runPlanner(t.deps);
    expect(r).toMatchObject({ status: "needs_confirm", destination: "https://api.anthropic.com", provider: "anthropic" });
    if (r.status === "needs_confirm") expect(r.context.vendors_detected).toEqual([{ vendor: "ga4", property: "G-ABC123" }]);
    expect(t.complete).not.toHaveBeenCalled();
    expect(await runPlanner(t.deps, { confirmed: true })).toMatchObject({ status: "ok" });
    expect(t.complete).toHaveBeenCalledTimes(1);
  });
  it("'always' plans, stores plan + default selection + provenance, sends only the context", async () => {
    const t = setup();
    const r = await runPlanner(t.deps);
    expect(r.status).toBe("ok");
    expect(t.session!.plan).toEqual(goodPlan);
    expect(t.session!.selection).toEqual({ journeys: ["J1"], excluded_steps: [] });
    expect(t.session!.plan_meta).toMatchObject({ source: "llm", provider: "anthropic", model: "m", prompt_version: "plan_v1" });
    const call = t.complete.mock.calls[0][0];
    expect(call.system).toContain("senior web-analytics consultant");
    expect(call.user).toContain("shop.example");
    expect(call.user).toContain("untrusted data");
  });
  it("a plan with duplicate step ids triggers the retry with the explanation", async () => {
    const bad = JSON.parse(JSON.stringify(goodPlan)) as JourneyPlan;
    bad.journeys.push({ id: "J2", name: "dup", steps: [{ id: "S1", name: "x", expect: [{ vendor: "ga4", event: "page_view" }] }] });
    const t = setup({ replies: [JSON.stringify(bad), JSON.stringify(goodPlan)] });
    expect((await runPlanner(t.deps)).status).toBe("ok");
    expect(t.complete).toHaveBeenCalledTimes(2);
    expect(t.complete.mock.calls[1][0].user).toContain('step id "S1" is used twice');
  });
  it("an LLM that keeps failing yields a clean error (user can still pick manually)", async () => {
    const t = setup({ replies: ["nope", "still nope"] });
    expect(await runPlanner(t.deps)).toMatchObject({ status: "error", kind: "validation" });
    expect(t.session!.plan).toBeUndefined();
  });

  it("enforces the call budget (failed calls count) and the minimum interval", async () => {
    let now = 1_000_000;
    const c = { ...cfg, plan_call_budget: { max_per_session: 2, min_interval_s: 30 } };
    const t = setup({ config: c, replies: ["bad", "bad", JSON.stringify(goodPlan), JSON.stringify(goodPlan)], now: () => now });
    expect((await runPlanner(t.deps)).status).toBe("error"); // call 1 (fails validation after its own retry)
    const tooSoon = await runPlanner(t.deps);
    expect(tooSoon).toMatchObject({ status: "error", kind: "too_soon", retry_after_s: 30 });
    expect(t.session!.plan_calls).toBe(1); // rejected attempt isn't counted
    now += 31_000;
    expect((await runPlanner(t.deps)).status).toBe("ok"); // call 2
    now += 31_000;
    expect(await runPlanner(t.deps)).toMatchObject({ status: "error", kind: "budget_exceeded" });
    expect(t.session!.plan_calls).toBe(2);
  });

  it("context extraction failure is reported, nothing sent", async () => {
    const t = setup();
    t.deps.extractContext = async () => { throw new Error("Cannot access chrome:// pages"); };
    expect(await runPlanner(t.deps)).toMatchObject({ status: "error", kind: "context" });
    expect(t.complete).not.toHaveBeenCalled();
  });
});

describe("manual template, selection, live checklist", () => {
  it("applyTemplate stores the plan as 'template'", async () => {
    const t = setup();
    const p = await applyTemplate(t.deps, "lead_generation");
    expect(p?.site_type).toBe("lead_generation");
    expect(t.session!.plan_meta?.source).toBe("template");
    expect(t.session!.selection?.journeys).toEqual(["J1"]);
  });
  it("confirmedPlan keeps only picked journeys and steps", () => {
    const p: JourneyPlan = { ...ecommercePlan, journeys: [...ecommercePlan.journeys, { id: "J2", name: "Other", steps: [{ id: "S9", name: "x", expect: [{ vendor: "ga4", event: "search" }] }] }] };
    const c = confirmedPlan(p, { journeys: ["J1"], excluded_steps: ["S3"] });
    expect(c.journeys.map((j) => j.id)).toEqual(["J1"]);
    expect(c.journeys[0].steps.map((s) => s.id)).toEqual(["S1", "S2", "S4"]);
    expect(confirmedPlan(p, { journeys: ["J2"], excluded_steps: ["S9"] }).journeys).toEqual([]);
    expect(confirmedPlan(p)).toBe(p);
  });
  it("liveChecklist ticks as events arrive, ignoring markers", () => {
    const evs = ecommerceClean();
    const at = (n: number) => liveChecklist(ecommercePlan, evs.filter((e) => e.event !== "user_engagement").slice(0, n));
    expect(at(0).map((c) => c.status)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(at(2).map((c) => c.status)).toEqual(["matched", "missing", "missing", "missing"]);
    expect(at(5).map((c) => c.status)).toEqual(["matched", "matched", "matched", "matched"]);
    // partial: add_to_cart without items
    const partial = evs.map((e) => (e.event === "add_to_cart" ? { ...e, items: [] } : e));
    expect(liveChecklist(ecommercePlan, partial).find((c) => c.step === "S2")!.status).toBe("partial");
  });
});
