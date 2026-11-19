import { completeValidated } from "../llm/complete";
import { validateConfig } from "../llm/config";
import type { SiteConsent } from "../llm/consent";
import { LLMError, type LLMConfig, type LLMProvider } from "../llm/types";
import type { PageContext } from "../content/pageContext";
import { JOURNEY_PLAN_SCHEMA, checkPlan } from "../shared/schemas";
import type { JourneyPlan, SessionMeta } from "../shared/types";
import { templatePlan, type SiteType } from "../planner/templates";
import planPrompt from "../../../shared/prompts/plan_v1.md";

export const PLAN_PROMPT_VERSION = "plan_v1";

export type PlanResult =
  | { status: "ok"; plan: JourneyPlan }
  | { status: "needs_consent"; origin: string }
  | { status: "needs_confirm"; context: PageContext; destination: string; provider: string; model: string }
  | { status: "manual"; reason: "never" | "no_config"; message: string }
  | { status: "error"; kind: string; message: string; retry_after_s?: number };

export interface PlannerDeps {
  loadSession(): Promise<SessionMeta | undefined>;
  updateSession<T>(fn: (s: SessionMeta) => T): Promise<T | undefined>;
  loadConfig(): Promise<LLMConfig | undefined>;
  getConsent(origin: string): Promise<SiteConsent | undefined>;
  extractContext(tabId: number): Promise<PageContext>;
  detectedVendors(sessionId: string): Promise<{ vendor: string; property: string }[]>;
  provider(cfg: LLMConfig): LLMProvider;
  now(): number;
}

/** One planning call: prompt + page context -> validated plan. Shared by the extension and the eval script. */
export async function requestPlan(provider: LLMProvider, context: PageContext): Promise<{ plan: JourneyPlan; attempts: number }> {
  const { value, attempts } = await completeValidated<JourneyPlan>(
    provider,
    {
      system: planPrompt,
      user: `Page context (untrusted data):\n${JSON.stringify(context)}\n\nPropose the journey plan.`,
      jsonSchema: JOURNEY_PLAN_SCHEMA,
    },
    checkPlan,
  );
  return { plan: value, attempts };
}

export async function runPlanner(deps: PlannerDeps, opts: { confirmed?: boolean } = {}): Promise<PlanResult> {
  const s = await deps.loadSession();
  if (!s || s.status !== "recording") return { status: "error", kind: "no_session", message: "Start recording first." };

  const cfg = await deps.loadConfig();
  if (!cfg || validateConfig(cfg).length > 0) {
    return { status: "manual", reason: "no_config", message: "No LLM is configured (Settings). Pick the site type by hand." };
  }

  const origin = s.origins[0];
  if (!origin) return { status: "error", kind: "no_origin", message: "Cannot tell which site this tab is on." };
  const consent = await deps.getConsent(origin);
  if (!consent) return { status: "needs_consent", origin };
  if (consent === "never") return { status: "manual", reason: "never", message: "Page info is not shared with the LLM for this site. Pick the site type by hand." };

  let context: PageContext;
  try {
    context = await deps.extractContext(s.tabId);
    context.vendors_detected = await deps.detectedVendors(s.id);
  } catch (e) {
    return { status: "error", kind: "context", message: `Could not read the page: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (consent === "ask" && !opts.confirmed) {
    return { status: "needs_confirm", context, destination: new URL(cfg.base_url).origin, provider: cfg.provider, model: cfg.model };
  }

  // Reserve a call in the budget before the (slow) network request; failed calls count too.
  const now = deps.now();
  const reservation = await deps.updateSession((sess) => {
    const used = sess.plan_calls ?? 0;
    if (used >= cfg.plan_call_budget.max_per_session) {
      return { ok: false as const, kind: "budget_exceeded", message: `Plan call budget used up (${cfg.plan_call_budget.max_per_session} per session). Pick the site type by hand or start a new session.` };
    }
    const wait = sess.last_plan_at ? Math.ceil(cfg.plan_call_budget.min_interval_s - (now - sess.last_plan_at) / 1000) : 0;
    if (wait > 0) return { ok: false as const, kind: "too_soon", message: `Re-plan is rate limited. Try again in ${wait} s.`, retry_after_s: wait };
    sess.plan_calls = used + 1;
    sess.last_plan_at = now;
    return { ok: true as const };
  });
  if (!reservation) return { status: "error", kind: "no_session", message: "The session ended." };
  if (!reservation.ok) return { status: "error", kind: reservation.kind, message: reservation.message, retry_after_s: "retry_after_s" in reservation ? reservation.retry_after_s : undefined };

  try {
    const { plan: value } = await requestPlan(deps.provider(cfg), context);
    await deps.updateSession((sess) => {
      sess.plan = value;
      sess.selection = { journeys: value.journeys.map((j) => j.id), excluded_steps: [] };
      sess.plan_meta = { source: "llm", provider: cfg.provider, model: cfg.model, prompt_version: PLAN_PROMPT_VERSION, at: deps.now() };
    });
    return { status: "ok", plan: value };
  } catch (e) {
    if (e instanceof LLMError) return { status: "error", kind: e.kind, message: e.message };
    return { status: "error", kind: "unknown", message: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyTemplate(deps: Pick<PlannerDeps, "updateSession" | "now">, site: SiteType): Promise<JourneyPlan | undefined> {
  const plan = templatePlan(site);
  const ok = await deps.updateSession((sess) => {
    sess.plan = plan;
    sess.selection = { journeys: plan.journeys.map((j) => j.id), excluded_steps: [] };
    sess.plan_meta = { source: "template", at: deps.now() };
    return true;
  });
  return ok ? plan : undefined;
}
