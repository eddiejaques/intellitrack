import { detectPii } from "../minimize/redact";
import type { ParsedEvent, RawRequest, VendorMatcher } from "../shared/types";

/**
 * Meta Pixel (fbevents.js) pings:
 *   https://www.facebook.com/tr/?id=<pixel id>&ev=Purchase&eid=<event id>&dl=<page>&cd[value]=…&cd[currency]=…
 * Long hits (big carts) go as POST to the same path with the same `k=v&…` fields as the body.
 *
 * NOTE (plan §9 "Ready" criteria): field names follow Meta's documented pixel ping; synthetic
 * fixtures only, confirm against a live capture. Unknown fields are dropped unless they carry
 * personal data (Advanced Matching `ud[…]`), which the PII rule then judges (hashed_only).
 */
const HOST = /(^|\.)facebook\.com$/i;
const PATH = /^\/tr\/?$/;

/** wire name -> normalized name */
const KNOWN: Record<string, string> = {
  eid: "event_id",
  "cd[value]": "value",
  "cd[currency]": "currency",
  "cd[content_ids]": "content_ids",
  "cd[content_type]": "content_type",
};

function safeUrl(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

export function isMetaPixel(req: Pick<RawRequest, "url">): boolean {
  const u = safeUrl(req.url);
  return !!u && HOST.test(u.hostname) && PATH.test(u.pathname);
}

export function parseMeta(req: RawRequest): ParsedEvent[] {
  const u = safeUrl(req.url);
  if (!u || !isMetaPixel(req)) return [];
  const f = new URLSearchParams(u.search);
  if (req.body?.includes("=")) for (const [k, v] of new URLSearchParams(req.body)) f.set(k, v);
  const ev = f.get("ev");
  if (!ev) return []; // not an event ping (e.g. a bare /tr/ load)

  const params: Record<string, string | number> = {};
  for (const [k, v] of f) {
    const name = KNOWN[k];
    if (name) {
      if (v === "") continue;
      const n = name === "value" ? Number(v) : NaN;
      params[name] = name === "value" && Number.isFinite(n) ? n : v;
    } else if (detectPii(k, v).length > 0) {
      params[k] = v;
    }
  }

  const page = safeUrl(f.get("dl") ?? "");
  return [{
    vendor: "meta_pixel",
    property: f.get("id") ?? undefined,
    event: ev,
    page: {
      path: page?.pathname,
      query: page && page.search.length > 1 ? page.search.slice(1) : undefined,
    },
    params,
    items: [],
    user: {},
    consent: {},
    transport: { type: req.type, method: req.method },
  }];
}

export const metaPixel: VendorMatcher = {
  id: "meta_pixel",
  label: "Meta Pixel",
  kind: "ads",
  urlHint: /facebook\.com\/tr\b/,
  match: isMetaPixel,
  parse: parseMeta,
  // Advanced Matching: personal data is allowed only as a SHA-256 hash.
  piiPolicy: "hashed_only",
};
