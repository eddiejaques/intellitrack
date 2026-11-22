import { describe, expect, it } from "vitest";
import { runRules } from "../extension/src/rules";
import { adsConversion, ecommerceClean, ecommercePlan, ecommerceWithAds, leadGenClean, leadGenPlan } from "../fixtures/sessions";
import type { Finding } from "../extension/src/shared/types";

/**
 * X3: rule text must fit the short-finding format. Seeds every kind of fault the rule engine can
 * raise on the existing fixtures (one per describe block in rules.test.ts / googleads.test.ts) and
 * checks every finding's title and recommendation against the schema's limits.
 */
function allFindings(): Finding[] {
  const out: Finding[] = [];

  // missing event, wrong value, no currency, no transaction_id
  const missing = ecommerceClean().filter((e) => e.event !== "add_to_cart" && e.event !== "purchase");
  out.push(...runRules(missing, { plan: ecommercePlan, reachedSteps: ["S1", "S2", "S3", "S4"] }).findings);

  const wrongValue = ecommerceClean();
  wrongValue[4].params.value = 999;
  delete wrongValue[4].params.transaction_id;
  delete wrongValue[4].params.currency;
  out.push(...runRules(wrongValue).findings);

  // duplicate purchase, PII, consent (missing everywhere), client_id + property change, failed/blocked
  const dup = ecommerceClean();
  dup.push({ ...dup[4], id: "evt_dup", params: { ...dup[4].params, email: "jane@example.com" } });
  dup[1].consent = {};
  dup[1].transport = { type: "ping", method: "POST", error: "net::ERR_BLOCKED_BY_CLIENT" };
  dup[2].transport = { type: "ping", method: "POST", status: 500 };
  dup[3].user.client_id = "999.888";
  dup[4].property = "G-OTHER9";
  out.push(...runRules(dup).findings);

  // consent missing everywhere (its own high-severity shape, distinct from "missing on some")
  out.push(...runRules(ecommerceClean().map((e) => ({ ...e, consent: {} }))).findings);

  // cart-items mismatch, out-of-order events
  const itemsDiffer = ecommerceClean();
  itemsDiffer[4].items = [{ item_id: "SKU9", item_name: "Other", price: 29.9, quantity: 1 }];
  out.push(...runRules(itemsDiffer, { plan: ecommercePlan }).findings);
  const outOfOrder = ecommerceClean();
  outOfOrder[3].t = 3;
  outOfOrder[2].t = 9;
  out.push(...runRules(outOfOrder, { plan: ecommercePlan }).findings);

  // lead-gen partial params
  const leadPartial = leadGenClean();
  leadPartial[2].params = {};
  out.push(...runRules(leadPartial, { plan: leadGenPlan }).findings);

  // naming
  const badName = ecommerceClean();
  badName[0].event = "Invalid Event Name!";
  out.push(...runRules(badName).findings);

  // Google Ads: value/currency mismatch, orphaned conversion, missing label/transaction_id
  const adsEvs = ecommerceWithAds();
  adsEvs[adsEvs.length - 1].params.value = 999;
  adsEvs[adsEvs.length - 1].params.currency = "USD";
  out.push(...runRules(adsEvs, { plan: ecommercePlan }).findings);
  const noLabelOrTx = adsConversion(10);
  delete noLabelOrTx.params.label;
  delete noLabelOrTx.params.transaction_id;
  out.push(...runRules([noLabelOrTx]).findings);
  out.push(...runRules([...ecommerceClean(), adsConversion(999, {}, { property: "AW-999" })]).findings);

  return out;
}

describe("rule output fits the short-finding format (X3)", () => {
  const findings = allFindings();
  it("found a realistic variety of findings to check (sanity)", () => {
    expect(findings.length).toBeGreaterThan(10);
    expect(new Set(findings.map((f) => f.category)).size).toBeGreaterThan(4);
  });
  it("every title is at most 90 characters", () => {
    const over = findings.filter((f) => f.title.length > 90);
    expect(over.map((f) => `${f.title.length}: ${f.title}`)).toEqual([]);
  });
  it("every recommendation is at most 120 characters", () => {
    const over = findings.filter((f) => f.recommendation.length > 120);
    expect(over.map((f) => `${f.recommendation.length}: ${f.recommendation}`)).toEqual([]);
  });
});
