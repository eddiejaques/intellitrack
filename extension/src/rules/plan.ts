import type { CoverageEntry, JourneyPlan, NormalizedEvent, PlanExpectation, PlanStep } from "../shared/types";
import { CONVERSION_EVENTS, hasParam, ids, type RawFinding } from "./util";

export interface PlanRuleOptions {
  /** limit evaluation to these journey IDs (default: all) */
  selectedJourneys?: string[];
  /** step IDs the user reached, i.e. the markers pressed (default: derived from events' page.step) */
  reachedSteps?: string[];
}

const matches = (e: NormalizedEvent, x: PlanExpectation) => e.vendor === (x.vendor || "ga4") && e.event === x.event;

/**
 * Step scoping: events carry `page.step` = the marker active when they fired. Marker IDs are matched
 * to plan step IDs. If the session used no markers at all, every step is evaluated against the whole
 * session (and treated as reached).
 */
export function planRule(
  events: NormalizedEvent[],
  plan: JourneyPlan,
  opts: PlanRuleOptions = {},
): { findings: RawFinding[]; coverage: CoverageEntry[] } {
  const findings: RawFinding[] = [];
  const coverage: CoverageEntry[] = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const stepInfo = sorted.some((e) => e.page.step);
  const reached = new Set([
    ...(opts.reachedSteps ?? []),
    ...sorted.map((e) => e.page.step).filter((s): s is string => !!s),
  ]);
  const journeys = plan.journeys.filter((j) => !opts.selectedJourneys || opts.selectedJourneys.includes(j.id));

  for (const j of journeys) {
    let prevT = -Infinity;
    for (const step of j.steps) {
      const isReached = !stepInfo || reached.has(step.id);
      const expected = step.expect.map((x) => x.event);
      if (!isReached) {
        coverage.push({ journey: j.id, step: step.id, step_name: step.name, expected, observed: [], status: "not_reached" });
        continue;
      }
      const scope = stepInfo ? sorted.filter((e) => e.page.step === step.id) : sorted;
      const observed: string[] = [];
      let matchedCount = 0;
      const stepMatches: NormalizedEvent[] = [];

      for (const x of step.expect) {
        const found = scope.filter((e) => matches(e, x));
        if (found.length === 0) {
          const conv = CONVERSION_EVENTS.has(x.event);
          findings.push({
            severity: conv ? "critical" : "high", vendor: x.vendor || "ga4", category: "missing_event",
            title: `Missing ${x.event} at "${step.name}"`,
            detail: `Journey "${j.name}", step ${step.id} expects ${x.event}, but it was not captured${stepInfo ? " during this step" : ""}.`,
            evidence: [],
            recommendation: `Check the trigger for ${x.event} on ${step.page_hint ?? "this step"} and confirm it fires in GTM preview / DebugView.`,
          });
          continue;
        }
        observed.push(x.event);
        stepMatches.push(...found);
        const required = x.params ?? [];
        const lacking = required.filter((p) => !found.some((e) => hasParam(e, p)));
        if (lacking.length) {
          const conv = CONVERSION_EVENTS.has(x.event);
          findings.push({
            severity: conv ? "high" : "medium", vendor: x.vendor || "ga4", category: "missing_param",
            title: `${x.event} is missing ${lacking.join(", ")}`,
            detail: `At "${step.name}", ${x.event} was captured but lacks required parameter(s): ${lacking.join(", ")}.`,
            evidence: ids(found),
            recommendation: `Add ${lacking.join(", ")} to the ${x.event} tag.`,
          });
        } else matchedCount++;
      }

      const status: CoverageEntry["status"] =
        observed.length === 0 ? "missing" : matchedCount === step.expect.length ? "matched" : "partial";
      coverage.push({ journey: j.id, step: step.id, step_name: step.name, expected, observed, status });
      prevT = orderCheck(step, j.name, stepMatches, prevT, findings);
    }
  }
  return { findings, coverage };
}

/** Greedy order check: a step's event must occur at/after the previous step's matched event. */
function orderCheck(
  step: PlanStep,
  journeyName: string,
  matched: NormalizedEvent[],
  prevT: number,
  findings: RawFinding[],
): number {
  if (matched.length === 0) return prevT;
  const ok = matched.filter((e) => e.t >= prevT).sort((a, b) => a.t - b.t);
  if (ok.length > 0) return ok[0].t;
  findings.push({
    severity: "medium", vendor: matched[0].vendor, category: "ordering",
    title: `"${step.name}" events fired before the previous step`,
    detail: `In journey "${journeyName}", the events for step ${step.id} only occur earlier than the events of the step before it.`,
    evidence: ids(matched),
    recommendation: "Check whether the tag fires too early (e.g. on page load rather than on the user action).",
  });
  return prevT;
}
