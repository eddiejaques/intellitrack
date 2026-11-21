import type { NormalizedEvent } from "../shared/types";
import { ids, num, type RawFinding } from "./util";
import { COMMERCE_PAGES, type PageType } from "../shared/siteContext";

export const ECOM_EVENTS = new Set([
  "view_item", "view_item_list", "select_item", "add_to_cart", "remove_from_cart", "view_cart",
  "begin_checkout", "add_shipping_info", "add_payment_info", "purchase", "refund",
]);
const CART_STAGE = new Set(["add_to_cart", "view_cart", "begin_checkout", "add_payment_info", "add_shipping_info"]);

export function isEcommerceSession(events: NormalizedEvent[]): boolean {
  return events.some((e) => ["add_to_cart", "begin_checkout", "purchase"].includes(e.event));
}

const itemSum = (e: NormalizedEvent): number | undefined => {
  let sum = 0;
  for (const it of e.items) {
    const price = num(it.price);
    if (price === undefined) return undefined;
    sum += price * (num(it.quantity) ?? 1);
  }
  return sum;
};

/**
 * E-commerce parameter checks apply to e-commerce events wherever they fire, and (when page types are
 * known) to any event on a product, listing, cart, checkout or confirmation page. A home or content
 * page with only page_view / scroll / engagement events is never checked for items, value or currency.
 */
export function inEcommerceScope(e: NormalizedEvent, pageType?: (e: NormalizedEvent) => PageType | undefined): boolean {
  if (e.vendor !== "ga4") return false;
  if (ECOM_EVENTS.has(e.event)) return true;
  const t = pageType?.(e);
  return t !== undefined && COMMERCE_PAGES.has(t) && (e.params.value !== undefined || e.items.length > 0);
}

export function ecommerceRules(events: NormalizedEvent[], pageType?: (e: NormalizedEvent) => PageType | undefined): RawFinding[] {
  const out: RawFinding[] = [];
  const ec = events.filter((e) => inEcommerceScope(e, pageType)).sort((a, b) => a.t - b.t);

  // value ≈ Σ(price × quantity)
  const wrong: NormalizedEvent[] = [];
  const noCurrency: NormalizedEvent[] = [];
  const noPrice: NormalizedEvent[] = [];
  for (const e of ec) {
    const value = num(e.params.value);
    if (value === undefined) continue;
    if (e.params.currency === undefined || e.params.currency === "") noCurrency.push(e);
    if (e.items.length === 0) continue;
    const sum = itemSum(e);
    if (sum === undefined) { noPrice.push(e); continue; }
    if (Math.abs(value - sum) > 0.01 + 0.005 * sum) wrong.push(e);
  }
  if (wrong.length) {
    const e = wrong[0];
    out.push({
      severity: wrong.some((w) => w.event === "purchase") ? "high" : "medium", vendor: "ga4", category: "wrong_value",
      title: "value does not match the items",
      detail: `On ${wrong.length} event(s) value differs from Σ(price × quantity) of items, e.g. ${e.event} has value ${e.params.value} but items sum to ${itemSum(e)}. Shipping, tax or discounts may be included — GA4 expects the items total.`,
      evidence: ids(wrong),
      recommendation: "Compute value from the same item prices and quantities sent in items[].",
    });
  }
  if (noCurrency.length) {
    out.push({
      severity: noCurrency.some((e) => e.event === "purchase") ? "high" : "medium", vendor: "ga4", category: "missing_param",
      title: "value sent without currency",
      detail: `${noCurrency.length} event(s) send value but no currency; GA4 ignores revenue without it.`,
      evidence: ids(noCurrency),
      recommendation: "Send currency (ISO 4217, e.g. EUR) with every event that has value.",
    });
  }
  if (noPrice.length) {
    out.push({
      severity: "medium", vendor: "ga4", category: "missing_param",
      title: "items without price",
      detail: `${noPrice.length} event(s) have items lacking a numeric price, so value cannot be verified.`,
      evidence: ids(noPrice),
      recommendation: "Send price (unit price) and quantity for every item.",
    });
  }

  const purchases = ec.filter((e) => e.event === "purchase");
  const noTx = purchases.filter((e) => e.params.transaction_id === undefined || e.params.transaction_id === "");
  if (noTx.length) {
    out.push({
      severity: "high", vendor: "ga4", category: "missing_param",
      title: "purchase without transaction_id",
      detail: `${noTx.length} purchase event(s) have no transaction_id; GA4 cannot deduplicate them.`,
      evidence: ids(noTx),
      recommendation: "Send a unique transaction_id with every purchase.",
    });
  }

  // items consistent from cart to purchase
  const cartIds = new Map<string, number | undefined>();
  const cartEvents = ec.filter((e) => CART_STAGE.has(e.event));
  for (const p of purchases) {
    const before = cartEvents.filter((c) => c.t <= p.t);
    if (before.length === 0) continue;
    for (const c of before) for (const it of c.items) if (it.item_id !== undefined) cartIds.set(String(it.item_id), num(it.price));
    const unknown = p.items.filter((it) => it.item_id !== undefined && !cartIds.has(String(it.item_id)));
    const changed = p.items.filter((it) => {
      const cp = it.item_id !== undefined ? cartIds.get(String(it.item_id)) : undefined;
      const pp = num(it.price);
      return cp !== undefined && pp !== undefined && Math.abs(cp - pp) > 0.01;
    });
    if (unknown.length || changed.length) {
      out.push({
        severity: "medium", vendor: "ga4", category: "wrong_value",
        title: "Purchase items differ from cart items",
        detail: `${unknown.length} purchased item(s) never appeared in a cart-stage event and ${changed.length} changed price between cart and purchase.`,
        evidence: ids([p, ...before.slice(-3)]),
        recommendation: "Build items[] for every ecommerce event from the same cart source of truth.",
      });
    }
  }
  return out;
}
