export interface RawRequest {
  requestId: string;
  url: string;
  method: string;
  tabId: number;
  initiator?: string;
  type: string;
  /** ms epoch */
  timeStamp: number;
  /** decoded request body (text), if any */
  body?: string;
}

export interface NormalizedItem {
  item_id?: string;
  item_name?: string;
  item_brand?: string;
  item_category?: string;
  item_variant?: string;
  price?: number;
  quantity?: number;
  [k: string]: string | number | undefined;
}

export interface NormalizedEvent {
  id: string;
  /** seconds since session start */
  t: number;
  vendor: string;
  property?: string;
  event: string;
  page: { path?: string; query?: string; title?: string; step?: string };
  params: Record<string, string | number>;
  items: NormalizedItem[];
  user: { client_id?: string; user_id?: string };
  consent: { gcs?: string; gcd?: string };
  transport: { type: string; method: string; status?: number; error?: string };
  raw_ref: string;
}

export interface VendorMatcher {
  id: string;
  label: string;
  kind: "analytics" | "ads" | "cdp" | "engagement" | "personalization";
  /** cheap URL test used to skip unrelated traffic before any parsing or session work */
  urlHint: RegExp;
  match(req: RawRequest): boolean;
  /** one request -> N events; id/t/page.step/raw_ref are filled in by the capture layer */
  parse(req: RawRequest): ParsedEvent[];
  piiPolicy: "never" | "hashed_only" | "expected";
}

export type ParsedEvent = Omit<NormalizedEvent, "id" | "t" | "raw_ref">;

/** One captured tag request, parsed or not. This is what the raw tag log shows. */
export interface RequestRow {
  key: string;
  sessionId: string;
  requestId: string;
  /** seconds since session start */
  t: number;
  url: string;
  host: string;
  method: string;
  type: string;
  /** a registered vendor id, or "unrecognized" when no parser claimed it */
  vendor: string;
  /** number of events parsed out of this request */
  events: number;
  status?: number;
  error?: string;
  /** request body, truncated (local only; never part of the audit payload) */
  body?: string;
  step?: string;
}

export interface Marker {
  id: string;
  name: string;
  /** seconds since session start */
  t: number;
}

export interface SessionMeta {
  id: string;
  tabId: number;
  startedAt: number;
  endedAt?: number;
  status: "recording" | "stopped";
  /** origins considered "the recorded tab" for attributing worker-originated hits */
  origins: string[];
  eventCount: number;
  nextEvt: number;
  nextReq: number;
  markers: Marker[];
  /** T4: the journey plan for this session, the user's selection, and planner bookkeeping */
  plan?: JourneyPlan;
  plan_meta?: { source: "llm" | "template"; provider?: string; model?: string; prompt_version?: string; at: number };
  selection?: { journeys: string[]; excluded_steps: string[] };
  plan_calls?: number;
  last_plan_at?: number;
  /** where the recording started: used to group sessions by site in the history */
  site?: { origin: string; host: string; title?: string; url?: string };
  /** tag requests stored / of which no vendor parser recognised */
  request_count?: number;
  unrecognized_count?: number;
}

export type Message =
  | { type: "start"; tabId: number }
  | { type: "stop" }
  | { type: "clear" }
  | { type: "marker"; name: string; stepId?: string }
  | { type: "plan"; confirmed?: boolean }
  | { type: "manualPlan"; siteType: "ecommerce" | "lead_generation" | "content" | "other" }
  | { type: "setSelection"; journeys: string[]; excludedSteps: string[] }
  | { type: "setConsent"; origin: string; value: "always" | "ask" | "never" }
  | { type: "audit"; sessionId: string; payload: Payload; useLLM: boolean; diagnostics?: AuditDiagnostics }
  | { type: "getReport"; sessionId: string }
  | { type: "getSession"; sessionId: string }
  | { type: "listSessions" }
  | { type: "deleteSession"; sessionId: string }
  | { type: "getState" }
  | { type: "getEvents"; sessionId: string }
  | { type: "getRequests"; sessionId: string }
  | { type: "testConnection"; config: import("../llm/types").LLMConfig };

// ---- T2: plan, findings, payload -------------------------------------------

export interface PlanExpectation {
  vendor: string;
  event: string;
  /** parameter names that must be present (use "items" for the items array) */
  params?: string[];
}
export interface PlanStep {
  id: string;
  name: string;
  page_hint?: string;
  expect: PlanExpectation[];
}
export interface PlanJourney {
  id: string;
  name: string;
  steps: PlanStep[];
}
export interface JourneyPlan {
  site_type: string;
  confidence?: number;
  rationale?: string;
  journeys: PlanJourney[];
  global_expectations?: string[];
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingCategory =
  | "missing_event"
  | "missing_param"
  | "wrong_value"
  | "duplicate"
  | "consent"
  | "pii"
  | "naming"
  | "cross_vendor_mismatch"
  | "delivery"
  | "identity"
  | "ordering";

export interface Finding {
  id: string;
  severity: Severity;
  vendor: string;
  category: FindingCategory;
  title: string;
  detail: string;
  evidence: string[];
  recommendation: string;
  source: "rule" | "llm";
  /** LLM's verdict on a rule finding (only set on rule findings after an LLM review) */
  review?: { verdict: "confirmed" | "disputed" | "needs_context"; explanation: string; evidence: string[] };
}

export interface CoverageEntry {
  journey: string;
  step: string;
  step_name: string;
  expected: string[];
  observed: string[];
  status: "matched" | "partial" | "missing" | "not_reached" | "no_data";
}

export interface MinimizedEvent {
  id: string;
  t: number;
  vendor: string;
  property?: string;
  event: string;
  /** page index into Payload.pages */
  page?: string;
  step?: string;
  params: Record<string, string | number>;
  items: NormalizedItem[];
  user: { client_id: "[present]" | "[absent]"; user_id: string };
  consent: { gcs?: string; gcd?: string };
  transport: { status?: number; error?: string };
  /** repeats collapsed into this event (incl. itself) */
  count?: number;
  /** near-simultaneous exact duplicates that were dropped */
  dup_dropped?: number;
  /** IDs of collapsed events (capped) */
  ids?: string[];
  /** IDs of the near-simultaneous duplicates that were dropped (capped) */
  dup_ids?: string[];
}

export interface Payload {
  schema: "payload_v1";
  session: {
    duration_s: number;
    markers: { id: string; name: string; t: number }[];
    properties: string[];
    client_id_stable: boolean;
  };
  plan?: JourneyPlan;
  pages: { id: string; path: string; title?: string }[];
  events: MinimizedEvent[];
  stats: {
    raw_events: number;
    noise_counts: Record<string, number>;
    duplicates_dropped: number;
    collapsed_events: number;
  };
  rule_findings: Finding[];
  journey_coverage: CoverageEntry[];
}

// ---- T5: audit report --------------------------------------------------------

/** Capture-side facts that explain an empty or odd session. Not part of the LLM payload. */
export interface AuditDiagnostics {
  tag_requests: number;
  not_parsed: number;
  duration_s?: number;
}

export interface SessionSummary {
  session: SessionMeta;
  report?: { score: number; headline: string; created_at: number; inconclusive?: boolean; llm: AuditReport["llm"]["status"] };
}

export interface AuditReport {
  schema: "audit_report_v1";
  session_id: string;
  created_at: number;
  /** 0-100, computed locally and deterministically from the final findings */
  score: number;
  /** nothing was captured, so there is nothing to judge: no score, no LLM call */
  inconclusive?: boolean;
  diagnostics?: AuditDiagnostics;
  headline: string;
  plan?: JourneyPlan;
  journey_coverage: CoverageEntry[];
  findings: Finding[];
  stats: Payload["stats"];
  llm: {
    status: "ok" | "failed" | "skipped";
    provider?: string;
    model?: string;
    prompt_version?: string;
    attempts?: number;
    error?: string;
    /** LLM findings removed: unknown evidence IDs, no evidence, or duplicates of rule findings */
    dropped_findings: number;
    dropped_reasons: string[];
  };
}
