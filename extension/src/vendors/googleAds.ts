import { detectPii } from "../minimize/redact";
import type { ParsedEvent, RawRequest, VendorMatcher } from "../shared/types";

/**
 * Google Ads conversion pings (gtag / GTM Conversion Linker, first-party or direct):
 *   .../pagead/conversion/AW-123456789/?label=...&value=...&currency_code=...&oid=...
 *   .../pagead/1p-conversion/123456789/?...        (enhanced conversions, first-party)
 *
 * NOTE (plan §9 "Ready" criteria): parameter names below come from Google's documented gtag
 * conversion ping. They must be confirmed against a live capture; the parser is deliberately
 * tolerant (unknown parameters are ignored unless they carry personal data).
 */
const PATH = /\/pagead\/(?:1p-)?conversion\/(?:AW-)?(\d{6,})/;

/** wire name -> normalized name */
const KNOWN: Record<string, string> = {
  label: "label",
  value: "value",
  currency_code: "currency",
  currency: "currency",
  oid: "transaction_id",
  transaction_id: "transaction_id",
};

function safeUrl(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

export function isAdsConversion(req: Pick<RawRequest, "url">): boolean {
  const u = safeUrl(req.url);
  return !!u && PATH.test(u.pathname);
}

export function parseAds(req: RawRequest): ParsedEvent[] {
  const u = safeUrl(req.url);
  const m = u && PATH.exec(u.pathname);
  if (!u || !m) return [];
  const q = u.searchParams;

  const params: Record<string, string | number> = {};
  for (const [k, v] of q) {
    const name = KNOWN[k];
    if (name) {
      if (v === "") continue;
      const n = name === "value" ? Number(v) : NaN;
      params[name] = name === "value" && Number.isFinite(n) ? n : v;
    } else if (detectPii(k, v).length > 0) {
      // Enhanced conversions: identifiers ride in assorted parameters. Keep only those that look
      // like personal data so the PII rule can judge them; everything else is bookkeeping noise.
      params[k] = v;
    }
  }

  const page = safeUrl(q.get("url") ?? "");
  return [{
    vendor: "google_ads",
    property: `AW-${m[1]}`,
    event: "conversion",
    page: {
      path: page?.pathname,
      query: page && page.search.length > 1 ? page.search.slice(1) : undefined,
    },
    params,
    items: [],
    user: {},
    consent: { gcs: q.get("gcs") ?? undefined, gcd: q.get("gcd") ?? undefined },
    transport: { type: req.type, method: req.method },
  }];
}

export const googleAds: VendorMatcher = {
  id: "google_ads",
  label: "Google Ads conversion",
  kind: "ads",
  urlHint: /\/pagead\/(?:1p-)?conversion\//,
  match: isAdsConversion,
  parse: parseAds,
  // Enhanced conversions: personal data is allowed only as a SHA-256 hash.
  piiPolicy: "hashed_only",
};
