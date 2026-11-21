import type { NormalizedEvent } from "./types";

/** X2: one consent problem, with the hits it's about. Severity follows the rule engine's scale. */
export interface ConsentIssue {
  kind: "no_signals" | "before_default" | "partial_missing" | "uid_denied";
  severity: "high" | "medium";
  title: string;
  detail: string;
  recommendation: string;
  events: NormalizedEvent[];
}

/** Google's `gcs` consent string: `G1` + ad_storage + analytics_storage, each `0` or `1`. */
function gcsFlags(gcs: string): { ad: boolean; analytics: boolean } | undefined {
  const m = /^G1([01])([01])/.exec(gcs);
  return m ? { ad: m[1] === "1", analytics: m[2] === "1" } : undefined;
}

const hasSignal = (e: Pick<NormalizedEvent, "consent">) => !!(e.consent.gcs || e.consent.gcd);

/**
 * Pure function over a session's events (GA4 and Google Ads hits only). Shared by the live view
 * (as soon as a hit arrives) and the rule engine (`rules/universal.ts`'s `consentRule`), so the two
 * never disagree. Covers:
 *  - no consent signal (`gcs`/`gcd`) on any hit;
 *  - a hit with no signal that fired before the first hit that has one ("before any default was set");
 *  - a signal missing on some other hits, scattered through the session;
 *  - a user_id sent while analytics_storage is denied.
 * The CMP-still-open case from the card is skipped: X1 only records which CMP is present on a page,
 * not whether its banner was still showing and unanswered when a hit fired.
 */
export function consentIssues(events: NormalizedEvent[]): ConsentIssue[] {
  const ga = events.filter((e) => e.vendor === "ga4" || e.vendor === "google_ads").sort((a, b) => a.t - b.t);
  if (ga.length === 0) return [];

  const missing = ga.filter((e) => !hasSignal(e));
  if (missing.length === ga.length) {
    return [{
      kind: "no_signals", severity: "high",
      title: "No consent signals on any hit",
      detail: "None of the hits carry gcs/gcd. Google consent mode is not implemented, or consent state is not reaching the tag.",
      recommendation: "Implement Consent Mode v2 and send the default and updated consent state before any hit.",
      events: missing,
    }];
  }

  const out: ConsentIssue[] = [];
  const firstWithSignal = ga.find(hasSignal);
  const before = firstWithSignal ? missing.filter((e) => e.t < firstWithSignal.t) : [];
  if (before.length) {
    out.push({
      kind: "before_default", severity: "high",
      title: "Hit(s) sent before any consent default was set",
      detail: `${before.length} hit(s) fired before the first consent signal appeared on this session's hits (hit ${firstWithSignal!.id}).`,
      recommendation: "Call gtag('consent', 'default', …) before any tag can fire — ideally synchronously, at the top of <head>.",
      events: before,
    });
  }

  const beforeIds = new Set(before.map((e) => e.id));
  const scattered = missing.filter((e) => !beforeIds.has(e.id));
  if (scattered.length) {
    out.push({
      kind: "partial_missing", severity: "medium",
      title: "Consent signals missing on some hits",
      detail: `${scattered.length} of ${ga.length} hits have no gcs/gcd while others do. Some tags may be firing outside consent mode.`,
      recommendation: "Make sure every Google tag is gated by the same consent configuration.",
      events: scattered,
    });
  }

  const deniedWithUid = ga.filter((e) => {
    const f = e.consent.gcs ? gcsFlags(e.consent.gcs) : undefined;
    return f && !f.analytics && !!e.user.user_id;
  });
  if (deniedWithUid.length) {
    out.push({
      kind: "uid_denied", severity: "high",
      title: "user_id sent while analytics consent is denied",
      detail: `${deniedWithUid.length} hit(s) carry a user_id with analytics_storage denied.`,
      recommendation: "Do not set user_id until analytics consent is granted.",
      events: deniedWithUid,
    });
  }

  return out;
}
