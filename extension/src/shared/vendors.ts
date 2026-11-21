import type { SessionMeta } from "./types";

/** Vendors the user can pick. GA4 is the default; others are opt-in. Order = display order. */
export const VENDOR_OPTIONS: { id: string; label: string }[] = [
  { id: "ga4", label: "GA4" },
  { id: "google_ads", label: "Google Ads" },
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
