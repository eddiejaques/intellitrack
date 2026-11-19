import type { JourneyPlan } from "../shared/types";

export type SiteType = "ecommerce" | "lead_generation" | "content" | "other";

const s = (id: string, name: string, hint: string, expect: JourneyPlan["journeys"][0]["steps"][0]["expect"]) =>
  ({ id, name, page_hint: hint, expect });
const ga = (event: string, params?: string[]) => ({ vendor: "ga4", event, ...(params ? { params } : {}) });

/** Used when the user picks the site type by hand (consent "Never", no LLM configured, or LLM failed). */
export function templatePlan(site: SiteType): JourneyPlan {
  switch (site) {
    case "ecommerce":
      return {
        site_type: "ecommerce", confidence: 1, rationale: "Chosen manually: standard GA4 ecommerce funnel.",
        journeys: [{
          id: "J1", name: "Purchase",
          steps: [
            s("S1", "Product page", "/products/:id", [ga("page_view"), ga("view_item", ["items", "currency", "value"])]),
            s("S2", "Add to cart", "", [ga("add_to_cart", ["items", "currency", "value"])]),
            s("S3", "Checkout", "/checkout", [ga("begin_checkout", ["items", "currency", "value"])]),
            s("S4", "Purchase", "/thank-you", [ga("purchase", ["transaction_id", "items", "currency", "value"])]),
          ],
        }],
        global_expectations: ["consent signals on all Google hits", "no personal data in any payload"],
      };
    case "lead_generation":
      return {
        site_type: "lead_generation", confidence: 1, rationale: "Chosen manually: standard GA4 lead-generation funnel.",
        journeys: [{
          id: "J1", name: "Lead form",
          steps: [
            s("S1", "Landing", "/", [ga("page_view")]),
            s("S2", "Form start", "", [ga("form_start")]),
            s("S3", "Form submit", "", [ga("generate_lead", ["value", "currency"])]),
          ],
        }],
        global_expectations: ["consent signals on all Google hits", "no personal data in any payload"],
      };
    case "content":
      return {
        site_type: "content", confidence: 1, rationale: "Chosen manually: standard GA4 publisher journey.",
        journeys: [{
          id: "J1", name: "Read and subscribe",
          steps: [
            s("S1", "Article", "/:slug", [ga("page_view")]),
            s("S2", "Engaged reading", "", [ga("scroll")]),
            s("S3", "Newsletter sign-up", "", [ga("sign_up")]),
          ],
        }],
        global_expectations: ["consent signals on all Google hits", "no personal data in any payload"],
      };
    default:
      return {
        site_type: "other", confidence: 1, rationale: "Chosen manually: generic page-view journey.",
        journeys: [{ id: "J1", name: "Browse", steps: [s("S1", "Landing", "/", [ga("page_view")]), s("S2", "Key action", "", [ga("page_view")])] }],
        global_expectations: ["consent signals on all Google hits", "no personal data in any payload"],
      };
  }
}
