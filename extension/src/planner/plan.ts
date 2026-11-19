import type { CoverageEntry, JourneyPlan, NormalizedEvent, SessionMeta } from "../shared/types";
import { planRule } from "../rules/plan";

export interface Selection {
  journeys: string[];
  excluded_steps: string[];
}

/** The plan the user confirmed: only picked journeys, minus de-selected steps. This is the yardstick. */
export function confirmedPlan(plan: JourneyPlan, sel?: Selection): JourneyPlan {
  if (!sel) return plan;
  const journeys = plan.journeys
    .filter((j) => sel.journeys.includes(j.id))
    .map((j) => ({ ...j, steps: j.steps.filter((s) => !sel.excluded_steps.includes(s.id)) }))
    .filter((j) => j.steps.length > 0);
  return { ...plan, journeys };
}

export const sessionPlan = (s: Pick<SessionMeta, "plan" | "selection">): JourneyPlan | undefined =>
  s.plan ? confirmedPlan(s.plan, s.selection) : undefined;

/**
 * Live checklist, computed locally on every update (no LLM call). Whole-session scope: a step ticks
 * as soon as its expected event has been captured anywhere. "missing" here means "not yet".
 */
export function liveChecklist(plan: JourneyPlan, events: NormalizedEvent[]): CoverageEntry[] {
  const flat = events.map((e) => ({ ...e, page: { ...e.page, step: undefined } }));
  return planRule(flat, plan).coverage;
}
