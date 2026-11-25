import type { CoverageEntry, Finding, JourneyPlan, NormalizedEvent } from "../shared/types";
import { adsRules } from "./ads";
import { metaRules } from "./meta";
import { ecommerceRules, isEcommerceSession } from "./ecommerce";
import { planRule, type PlanRuleOptions } from "./plan";
import { universalRules } from "./universal";
import { SEVERITY_ORDER, type RawFinding } from "./util";
import { normalizePath } from "../minimize/redact";
import type { PageType, SiteType } from "../shared/siteContext";

export interface RuleOptions extends PlanRuleOptions {
  plan?: JourneyPlan;
  /** X1: the inferred site type, used when there is no confirmed plan */
  site?: SiteType;
  /** X1: page type per normalised path, from the pages captured during recording */
  pageTypes?: Record<string, PageType>;
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
  raw.push(...metaRules(events));
  const ecom = opts.plan
    ? opts.plan.site_type === "ecommerce"
    : isEcommerceSession(events) || opts.site === "ecommerce";
  const types = opts.pageTypes;
  const pageType = types ? (e: NormalizedEvent) => (e.page.path === undefined ? undefined : types[normalizePath(e.page.path)]) : undefined;
  if (ecom) raw.push(...ecommerceRules(events, pageType));

  const findings = raw
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
    .map(({ f }, n): Finding => ({ ...f, id: `R${n + 1}`, source: "rule" }));
  return { findings, coverage };
}
