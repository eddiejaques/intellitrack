import type { SessionMeta } from "./types";

/** Vendors the user can pick. GA4 is the default; others are opt-in. Order = display order. */
export const VENDOR_OPTIONS: { id: string; label: string }[] = [
  { id: "ga4", label: "GA4" },
  { id: "google_ads", label: "Google Ads" },
  { id: "meta_pixel", label: "Meta Pixel" },
  { id: "adobe_analytics", label: "Adobe Analytics" },
];
export const DEFAULT_VENDORS = ["ga4"];
export const vendorLabel = (id: string) => VENDOR_OPTIONS.find((v) => v.id === id)?.label ?? id;

/** Which vendors this session is judged on. Sessions from before the selector existed: GA4. */
export const sessionVendors = (s: Pick<SessionMeta, "vendors">): string[] => s.vendors ?? DEFAULT_VENDORS;

/** Events of the selected vendors only. Older sessions have no per-vendor counts: use the total. */
export function selectedEventCount(s: Pick<SessionMeta, "eventCount" | "vendor_counts" | "vendors">): number {
  if (!s.vendor_counts) return s.eventCount;
  const sel = new Set(sessionVendors(s));
  return Object.entries(s.vendor_counts).reduce((n, [v, c]) => n + (sel.has(v) ? c : 0), 0);
}

/** GA4 measurement IDs whose tag library loaded but which produced no GA4 events. */
export function silentGa4(tagLoads: Record<string, number> | undefined, events: { vendor: string; property?: string }[]): string[] {
  const seen = new Set(events.filter((e) => e.vendor === "ga4").map((e) => (e.property ?? "").toUpperCase()));
  return Object.keys(tagLoads ?? {}).filter((id) => id.startsWith("G-") && !seen.has(id));
}

/** X18: distinct GA4 properties (measurement IDs) seen in a session's events, in first-seen order. */
export function ga4Properties(events: { vendor: string; property?: string; t?: number }[]): string[] {
  const ga4 = events.filter((e) => e.vendor === "ga4" && e.property).sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  return [...new Set(ga4.map((e) => e.property!))];
}

/**
 * X18: when a session has more than one GA4 property, the audit covers exactly one at a time (not a
 * mix of properties, and not all of them at once) so findings aren't attributed to the wrong property.
 * Defaults to the first property seen. Sessions with 0 or 1 property are unaffected (no filtering).
 */
export function sessionGa4Property(s: Pick<SessionMeta, "ga4_property">, properties: string[]): string | undefined {
  if (properties.length < 2) return undefined;
  return s.ga4_property && properties.includes(s.ga4_property) ? s.ga4_property : properties[0];
}

/**
 * X21: the audit covers exactly one vendor at a time (never zero, never a mix). The stored choice wins
 * while that vendor still has events; otherwise GA4 if it captured events, else the vendor with the
 * most events, else GA4. Independent of `vendors`, which drives the live counts and the session log.
 */
export function sessionAuditVendor(s: Pick<SessionMeta, "audit_vendor">, counts: Record<string, number>): string {
  if (s.audit_vendor && (counts[s.audit_vendor] ?? 0) > 0) return s.audit_vendor;
  if ((counts.ga4 ?? 0) > 0) return "ga4";
  let best = "ga4", n = 0;
  for (const [v, c] of Object.entries(counts)) if (c > n) { best = v; n = c; }
  return best;
}

/** X21 + X18: the events that feed the audit: one vendor, and for GA4 one property when several fired. */
export function auditEvents<E extends { vendor: string; property?: string }>(events: E[], vendor: string, ga4Property?: string): E[] {
  return events.filter((e) => e.vendor === vendor && (vendor !== "ga4" || !ga4Property || e.property === ga4Property));
}
