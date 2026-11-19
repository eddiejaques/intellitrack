import type { CoverageEntry, Finding, JourneyPlan, NormalizedEvent } from "../shared/types";
import { adsRules } from "./ads";
import { ecommerceRules, isEcommerceSession } from "./ecommerce";
import { planRule, type PlanRuleOptions } from "./plan";
import { universalRules } from "./universal";
import { SEVERITY_ORDER, type RawFinding } from "./util";

export interface RuleOptions extends PlanRuleOptions {
  plan?: JourneyPlan;
}

/** Runs locally on unredacted events. Findings never embed raw values (only names, counts, event IDs). */
export function runRules(
  events: NormalizedEvent[],
  opts: RuleOptions = {},
): { findings: Finding[]; coverage: CoverageEntry[] } {
  const raw: RawFinding[] = [];
  for (const r of universalRules) raw.push(...r(events));

  let coverage: CoverageEntry[] = [];
  if (opts.plan) {
    const p = planRule(events, opts.plan, opts);
    raw.push(...p.findings);
    coverage = p.coverage;
  }
  raw.push(...adsRules(events));
  const ecom = opts.plan ? opts.plan.site_type === "ecommerce" : isEcommerceSession(events);
  if (ecom) raw.push(...ecommerceRules(events));

  const findings = raw
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
    .map(({ f }, n): Finding => ({ ...f, id: `R${n + 1}`, source: "rule" }));
  return { findings, coverage };
}
