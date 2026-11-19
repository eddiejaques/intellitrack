import type { JourneyPlan } from "./types";

const EVENT_NAME = "^[a-z][a-z0-9_]{0,39}$";

export const JOURNEY_PLAN_SCHEMA = {
  type: "object",
  properties: {
    site_type: { enum: ["ecommerce", "lead_generation", "content", "other"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string", maxLength: 300 },
    journeys: {
      type: "array", minItems: 1, maxItems: 3,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string", maxLength: 80 },
          steps: {
            type: "array", minItems: 1, maxItems: 8,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string", maxLength: 80 },
                page_hint: { type: "string", maxLength: 120 },
                expect: {
                  type: "array", minItems: 1, maxItems: 6,
                  items: {
                    type: "object",
                    properties: {
                      vendor: { enum: ["ga4"] },
                      event: { type: "string", pattern: EVENT_NAME },
                      params: { type: "array", items: { type: "string" } },
                    },
                    required: ["vendor", "event"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["id", "name", "expect"],
              additionalProperties: false,
            },
          },
        },
        required: ["id", "name", "steps"],
        additionalProperties: false,
      },
    },
    global_expectations: { type: "array", maxItems: 6, items: { type: "string", maxLength: 160 } },
  },
  required: ["site_type", "confidence", "rationale", "journeys", "global_expectations"],
  additionalProperties: false,
} as const;

/** Things a JSON Schema can't say: IDs must be unique across the whole plan (markers map to step IDs). */
export function checkPlan(plan: JourneyPlan): string[] {
  const errs: string[] = [];
  const jIds = new Set<string>();
  const sIds = new Set<string>();
  for (const j of plan.journeys) {
    if (jIds.has(j.id)) errs.push(`journey id "${j.id}" is used twice`);
    jIds.add(j.id);
    for (const s of j.steps) {
      if (sIds.has(s.id)) errs.push(`step id "${s.id}" is used twice; step ids must be unique across ALL journeys (S1, S2, S3, ... continuing across journeys)`);
      sIds.add(s.id);
    }
  }
  return errs;
}

export const FINDING_CATEGORIES = [
  "missing_event", "missing_param", "wrong_value", "duplicate", "consent", "pii", "naming",
  "cross_vendor_mismatch", "delivery", "identity", "ordering",
] as const;

export const AUDIT_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "object",
      properties: { headline: { type: "string", maxLength: 200 } },
      required: ["headline"],
      additionalProperties: false,
    },
    findings: {
      type: "array", maxItems: 12,
      items: {
        type: "object",
        properties: {
          severity: { enum: ["critical", "high", "medium", "low", "info"] },
          vendor: { type: "string" },
          category: { enum: [...FINDING_CATEGORIES] },
          title: { type: "string", maxLength: 120 },
          detail: { type: "string", maxLength: 600 },
          evidence: { type: "array", items: { type: "string", pattern: "^evt_" } },
          recommendation: { type: "string", maxLength: 400 },
        },
        required: ["severity", "vendor", "category", "title", "detail", "evidence", "recommendation"],
        additionalProperties: false,
      },
    },
    rule_reviews: {
      type: "array", maxItems: 30,
      items: {
        type: "object",
        properties: {
          rule_id: { type: "string", pattern: "^R\\d+$" },
          verdict: { enum: ["confirmed", "disputed", "needs_context"] },
          explanation: { type: "string", maxLength: 400 },
          evidence: { type: "array", items: { type: "string", pattern: "^evt_" } },
        },
        required: ["rule_id", "verdict", "explanation", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "findings", "rule_reviews"],
  additionalProperties: false,
} as const;

export interface AuditLLMOutput {
  summary: { headline: string };
  findings: {
    severity: "critical" | "high" | "medium" | "low" | "info";
    vendor: string;
    category: (typeof FINDING_CATEGORIES)[number];
    title: string;
    detail: string;
    evidence: string[];
    recommendation: string;
  }[];
  rule_reviews: { rule_id: string; verdict: "confirmed" | "disputed" | "needs_context"; explanation: string; evidence: string[] }[];
}
