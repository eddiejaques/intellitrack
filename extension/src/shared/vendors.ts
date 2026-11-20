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
