import type { JourneyPlan, NormalizedEvent, SessionMeta } from "../extension/src/shared/types";

let n = 0;
export function ev(t: number, event: string, over: Partial<NormalizedEvent> & { params?: NormalizedEvent["params"] } = {}): NormalizedEvent {
  n++;
  return {
    id: `evt_${String(n).padStart(4, "0")}`,
    t,
    vendor: "ga4",
    property: "G-ABC123",
    event,
    page: { path: "/", title: "Shop", step: undefined },
    params: {},
    items: [],
    user: { client_id: "111.222" },
    consent: { gcs: "G111", gcd: "13l3l3l3l1" },
    transport: { type: "ping", method: "POST", status: 204 },
    raw_ref: `req_${n}`,
    ...over,
  };
}
export const resetIds = () => { n = 0; };

const SHIRT = { item_id: "SKU1", item_name: "Blue Shirt", price: 29.9, quantity: 1 };

/** Clean e-commerce journey with markers S1..S4. */
export function ecommerceClean(): NormalizedEvent[] {
  resetIds();
  const pg = (path: string, step: string) => ({ path, title: "Shop", step });
  return [
    ev(1, "page_view", { page: pg("/products/42", "S1") }),
    ev(2, "view_item", { page: pg("/products/42", "S1"), params: { currency: "EUR", value: 29.9 }, items: [SHIRT] }),
    ev(5, "add_to_cart", { page: pg("/products/42", "S2"), params: { currency: "EUR", value: 29.9 }, items: [SHIRT] }),
    ev(9, "begin_checkout", { page: pg("/checkout", "S3"), params: { currency: "EUR", value: 29.9 }, items: [SHIRT] }),
    ev(15, "purchase", { page: pg("/thanks", "S4"), params: { currency: "EUR", value: 29.9, transaction_id: "T-1001" }, items: [SHIRT] }),
    ev(16, "user_engagement"),
    ev(17, "user_engagement"),
  ];
}

export const ecommercePlan: JourneyPlan = {
  site_type: "ecommerce",
  confidence: 0.9,
  rationale: "Product pages with offers and a cart.",
  global_expectations: ["consent signals on all Google hits", "no personal data in any payload"],
  journeys: [{
    id: "J1", name: "Purchase",
    steps: [
      { id: "S1", name: "Product page", page_hint: "/products/:id", expect: [{ vendor: "ga4", event: "page_view" }, { vendor: "ga4", event: "view_item", params: ["items", "currency", "value"] }] },
      { id: "S2", name: "Add to cart", expect: [{ vendor: "ga4", event: "add_to_cart", params: ["items", "value", "currency"] }] },
      { id: "S3", name: "Checkout", expect: [{ vendor: "ga4", event: "begin_checkout" }] },
      { id: "S4", name: "Purchase", expect: [{ vendor: "ga4", event: "purchase", params: ["transaction_id", "value", "currency", "items"] }] },
    ],
  }],
};

export function leadGenClean(): NormalizedEvent[] {
  resetIds();
  const pg = (step: string) => ({ path: "/demo", title: "Demo", step });
  return [
    ev(1, "page_view", { page: pg("S1") }),
    ev(6, "form_start", { page: pg("S2") }),
    ev(12, "generate_lead", { page: pg("S3"), params: { value: 100, currency: "EUR" } }),
  ];
}

export const leadGenPlan: JourneyPlan = {
  site_type: "lead_generation",
  confidence: 0.8,
  rationale: "B2B pricing page with a demo request form.",
  global_expectations: ["consent signals on all Google hits", "no personal data in any payload"],
  journeys: [{
    id: "J1", name: "Demo request",
    steps: [
      { id: "S1", name: "Landing", expect: [{ vendor: "ga4", event: "page_view" }] },
      { id: "S2", name: "Form start", expect: [{ vendor: "ga4", event: "form_start" }] },
      { id: "S3", name: "Form submit", expect: [{ vendor: "ga4", event: "generate_lead", params: ["value", "currency"] }] },
    ],
  }],
};

export const session = (): Pick<SessionMeta, "startedAt" | "endedAt" | "markers"> => ({
  startedAt: 1_000_000, endedAt: 1_030_000,
  markers: [{ id: "S1", name: "Product", t: 0 }, { id: "S2", name: "Add to cart", t: 4 }, { id: "S3", name: "Checkout", t: 8 }, { id: "S4", name: "Purchase", t: 14 }],
});

export const ALL_STEPS = ["S1", "S2", "S3", "S4"];

export const sessionWith = (markers: SessionMeta["markers"]): Pick<SessionMeta, "startedAt" | "endedAt" | "markers"> => ({
  startedAt: 1_000_000, endedAt: 1_030_000, markers,
});
