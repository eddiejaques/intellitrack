import type { NormalizedEvent } from "../shared/types";
import { ids, num, type RawFinding } from "./util";

const sameMoney = (a: number, b: number) => Math.abs(a - b) <= 0.01 + 0.005 * Math.max(a, b);

/** Google Ads conversion hygiene, and the first cross-vendor check: GA4 purchase vs Ads conversion. */
export function adsRules(events: NormalizedEvent[]): RawFinding[] {
  const ads = events.filter((e) => e.vendor === "google_ads" && e.event === "conversion");
  if (ads.length === 0) return [];
  const out: RawFinding[] = [];
  const purchases = events.filter((e) => e.vendor === "ga4" && e.event === "purchase");

  const noLabel = ads.filter((e) => !e.params.label);
  if (noLabel.length) {
    out.push({
      severity: "high", vendor: "google_ads", category: "missing_param",
      title: "Google Ads conversion without a label",
      detail: `${noLabel.length} conversion ping(s) carry no conversion label, so Ads cannot attribute them to a conversion action.`,
      evidence: ids(noLabel),
      recommendation: "Set the conversion label in the Google Ads conversion tag.",
    });
  }
  const noCurrency = ads.filter((e) => e.params.value !== undefined && !e.params.currency);
  if (noCurrency.length) {
    out.push({
      severity: "medium", vendor: "google_ads", category: "missing_param",
      title: "Google Ads conversion value without currency",
      detail: `${noCurrency.length} conversion ping(s) send a value but no currency code.`,
      evidence: ids(noCurrency),
      recommendation: "Send currency_code together with value.",
    });
  }

  if (purchases.length === 0) return out;

  const noId = ads.filter((e) => e.params.transaction_id === undefined && e.params.value !== undefined);
  if (noId.length) {
    out.push({
      severity: "medium", vendor: "google_ads", category: "missing_param",
      title: "Google Ads conversion without a transaction ID",
      detail: `${noId.length} valued conversion ping(s) have no order ID, so Ads cannot deduplicate them and they cannot be matched to GA4 purchases.`,
      evidence: ids(noId),
      recommendation: "Pass the order ID (transaction_id) to the conversion tag.",
    });
  }

  const byId = new Map<string, NormalizedEvent[]>();
  for (const e of ads) if (e.params.transaction_id !== undefined) byId.set(String(e.params.transaction_id), [...(byId.get(String(e.params.transaction_id)) ?? []), e]);
  if (byId.size === 0) return out;

  const mismatched: NormalizedEvent[] = [];
  const currencyOff: NormalizedEvent[] = [];
  const noAds: NormalizedEvent[] = [];
  const seen = new Set<string>();
  for (const p of purchases) {
    const tid = p.params.transaction_id === undefined ? undefined : String(p.params.transaction_id);
    seen.add(tid ?? "");
    const match = tid !== undefined ? byId.get(tid) : undefined;
    if (!match) { noAds.push(p); continue; }
    for (const a of match) {
      const av = num(a.params.value), pv = num(p.params.value);
      if (av !== undefined && pv !== undefined && !sameMoney(av, pv)) mismatched.push(p, a);
      const ac = a.params.currency, pc = p.params.currency;
      if (ac && pc && String(ac).toUpperCase() !== String(pc).toUpperCase()) currencyOff.push(p, a);
    }
  }
  if (mismatched.length) {
    out.push({
      severity: "high", vendor: "google_ads", category: "cross_vendor_mismatch",
      title: "GA4 purchase value differs from the Google Ads conversion value",
      detail: "For the same transaction ID, GA4 and Google Ads report different values. Bidding optimises on the Ads value, reporting on the GA4 one.",
      evidence: ids(mismatched),
      recommendation: "Send the same value (items total) to both tags, from one source.",
    });
  }
  if (currencyOff.length) {
    out.push({
      severity: "high", vendor: "google_ads", category: "cross_vendor_mismatch",
      title: "GA4 and Google Ads use different currencies for the same transaction",
      detail: "The currency differs between the GA4 purchase and the Ads conversion for one transaction ID.",
      evidence: ids(currencyOff),
      recommendation: "Use one currency source for both tags.",
    });
  }
  if (noAds.length) {
    out.push({
      severity: "medium", vendor: "google_ads", category: "cross_vendor_mismatch",
      title: "GA4 purchase without a matching Google Ads conversion",
      detail: `${noAds.length} GA4 purchase(s) have no Ads conversion with the same transaction ID, although Ads conversions are firing on this site.`,
      evidence: ids(noAds),
      recommendation: "Check the Ads conversion trigger on the order confirmation page.",
    });
  }
  const orphans = [...byId].filter(([tid]) => !seen.has(tid)).flatMap(([, evs]) => evs);
  if (orphans.length) {
    out.push({
      severity: "medium", vendor: "google_ads", category: "cross_vendor_mismatch",
      title: "Google Ads conversion without a matching GA4 purchase",
      detail: `${orphans.length} Ads conversion(s) carry a transaction ID that no GA4 purchase has.`,
      evidence: ids(orphans),
      recommendation: "Confirm both tags fire for the same order, with the same transaction ID.",
    });
  }
  return out;
}
