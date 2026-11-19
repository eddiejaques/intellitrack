import type { PageContext } from "../extension/src/content/pageContext";
import type { JourneyPlan, NormalizedEvent } from "../extension/src/shared/types";
import { ALL_STEPS, ecommerceClean, ecommercePlan, ev, leadGenClean, leadGenPlan, resetIds, session, sessionWith } from "./sessions";

// ---------------------------------------------------------------- planner eval (T4)
export interface PlannerCase {
  name: string;
  context: PageContext;
  site_type: string;
  /** hand-written gold plan; recall of its events is the score */
  gold: JourneyPlan;
}

const base = { meta_description: "", og_type: "", schema_types: [] as string[], forms: [] as { field_types: string[] }[], headings: [] as string[], nav_labels: [] as string[] };

const contentGold: JourneyPlan = {
  site_type: "content", confidence: 0.9, rationale: "Articles with a newsletter form.", global_expectations: [],
  journeys: [{ id: "J1", name: "Read and subscribe", steps: [
    { id: "S1", name: "Article", expect: [{ vendor: "ga4", event: "page_view" }] },
    { id: "S2", name: "Read", expect: [{ vendor: "ga4", event: "scroll" }] },
    { id: "S3", name: "Newsletter", expect: [{ vendor: "ga4", event: "sign_up" }] },
  ] }],
};

export const plannerCases: PlannerCase[] = [
  {
    name: "ecommerce",
    site_type: "ecommerce",
    gold: ecommercePlan,
    context: { ...base, domain: "shop.example", path_pattern: "/products/:id", title: "Blue Shirt | Example Shop",
      meta_description: "Soft cotton shirt in blue. Free returns.", og_type: "product",
      schema_types: ["Product", "Offer", "BreadcrumbList"], forms: [{ field_types: ["select-one", "number"] }],
      headings: ["Blue Shirt", "Details", "Reviews"], nav_labels: ["Men", "Women", "Sale", "Cart", "Account"] },
  },
  {
    name: "lead_generation",
    site_type: "lead_generation",
    gold: leadGenPlan,
    context: { ...base, domain: "saas.example", path_pattern: "/pricing", title: "Pricing | Acme Analytics",
      meta_description: "Plans for teams. Book a demo.", og_type: "website",
      schema_types: ["Organization", "SoftwareApplication"], forms: [{ field_types: ["text", "email", "tel", "select"] }],
      headings: ["Pricing", "Talk to sales", "Enterprise"], nav_labels: ["Product", "Pricing", "Customers", "Book a demo", "Log in"] },
  },
  {
    name: "content",
    site_type: "content",
    gold: contentGold,
    context: { ...base, domain: "news.example", path_pattern: "/2026/11/:id", title: "How cities are changing | The Daily Example",
      meta_description: "Long read on urban planning.", og_type: "article",
      schema_types: ["NewsArticle", "Person", "Organization"], forms: [{ field_types: ["email"] }],
      headings: ["How cities are changing", "Subscribe to our newsletter"], nav_labels: ["World", "Politics", "Culture", "Opinion", "Subscribe"] },
  },
];

// ---------------------------------------------------------------- audit eval (T5)
export interface Fault {
  /** found by the rule engine in the final report */
  rule?: { category: string; title?: RegExp };
  /** must be found by the LLM itself (rules cannot see it) */
  llm?: { text: RegExp };
}
export interface AuditCase {
  name: string;
  events: NormalizedEvent[];
  plan: JourneyPlan;
  session: ReturnType<typeof session>;
  faults: Fault[];
  /** a clean run: any high/critical LLM finding is a false positive */
  clean?: boolean;
}

export function auditCases(): AuditCase[] {
  const cases: AuditCase[] = [];

  cases.push({ name: "ecommerce_clean", events: ecommerceClean(), plan: ecommercePlan, session: session(), faults: [], clean: true });

  { const evs = ecommerceClean().filter((e) => e.event !== "add_to_cart");
    cases.push({ name: "missing_add_to_cart", events: evs, plan: ecommercePlan, session: session(), faults: [{ rule: { category: "missing_event", title: /add_to_cart/ } }] }); }

  { const evs = ecommerceClean();
    evs[3].params.user_email = "jane.doe@example.com";
    evs[3].page.query = "email=jane.doe%40example.com";
    cases.push({ name: "plaintext_email", events: evs, plan: ecommercePlan, session: session(), faults: [{ rule: { category: "pii" } }] }); }

  { const evs = ecommerceClean();
    evs.push({ ...evs[4], id: "evt_dup", t: 40 });
    cases.push({ name: "duplicate_purchase", events: evs, plan: ecommercePlan, session: session(), faults: [{ rule: { category: "duplicate", title: /purchase/i } }] }); }

  { const evs = ecommerceClean();
    evs[4].params.value = 35.9;
    cases.push({ name: "wrong_value", events: evs, plan: ecommercePlan, session: session(), faults: [{ rule: { category: "wrong_value" } }] }); }

  { // Identical to a valid submit on the wire; only the user's own step name reveals it. LLM territory.
    resetIds();
    const pg = (step: string) => ({ path: "/demo", title: "Demo", step });
    const evs = [ev(1, "page_view", { page: pg("S1") }), ev(6, "form_start", { page: pg("S2") }),
      ev(12, "generate_lead", { page: pg("S3"), params: { value: 100, currency: "EUR" } })];
    cases.push({
      name: "lead_on_invalid_submit", events: evs, plan: leadGenPlan,
      session: sessionWith([{ id: "S1", name: "Landing", t: 0 }, { id: "S2", name: "Start form", t: 5 }, { id: "S3", name: "Submit form with required fields left empty (validation errors shown, nothing sent)", t: 11 }]),
      faults: [{ llm: { text: /invalid|empty|required|validation|should not|failed|error/i } }],
    });
  }
  void leadGenClean; void ALL_STEPS;
  return cases;
}
