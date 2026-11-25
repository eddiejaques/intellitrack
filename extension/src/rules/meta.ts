import type { NormalizedEvent } from "../shared/types";
import { ids, type RawFinding } from "./util";

/** Meta standard events that count as conversions, and so must dedupe against a server-side CAPI copy. */
export const META_CONVERSIONS = new Set(["Purchase", "Lead", "CompleteRegistration", "AddToCart"]);

/** B5: Meta Pixel hygiene. The common fault: conversions without an eventID, which breaks CAPI dedup. */
export function metaRules(events: NormalizedEvent[]): RawFinding[] {
  const noId = events.filter((e) => e.vendor === "meta_pixel" && META_CONVERSIONS.has(e.event) && !String(e.params.event_id ?? "").trim());
  if (noId.length === 0) return [];
  const names = [...new Set(noId.map((e) => e.event))].join(", ");
  return [{
    severity: "medium", vendor: "meta_pixel", category: "missing_param",
    title: "Meta Pixel conversion without an eventID",
    detail: `${noId.length} conversion event(s) (${names}) have no eventID: CAPI dedup will double-count if the server also sends this event.`,
    evidence: ids(noId),
    recommendation: "Pass the same eventID to fbq('track', …, { eventID }) and to the Conversions API call for that event.",
  }];
}
