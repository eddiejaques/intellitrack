import type { NormalizedItem, ParsedEvent, RawRequest, VendorMatcher } from "../shared/types";

/**
 * Adobe Analytics, legacy AppMeasurement / AEP tag "image request" hits:
 *   https://<tracking server>/b/ss/<rsid[,rsid2]>/<1|0|10>/<code version>/s<random>?AQB=1&…&AQE=1
 * The tracking server is often a first-party CNAME (`smetrics.<site>`), else `*.sc.omtrdc.net` /
 * `*.2o7.net`, so the match is on the path only. Large hits are sent as POST with the same
 * `k=v&…` string as the body.
 *
 * X25: hits are big (browser fields, ActivityMap, lifecycle context data), so the parser keeps an
 * allowlist and drops the rest before anything is stored or interpreted. Field names follow Adobe's
 * documented query parameters; synthetic fixtures only, confirm against a live capture.
 */
const PATH = /\/b\/ss\/([^/?#]+)/;
/** values longer than this are cut, so one runaway eVar can't blow up the payload */
export const MAX_VALUE = 200;

/** wire name -> kept name (eVars `vN` and props `cN` are kept as-is) */
const KEEP: Record<string, string> = {
  pageName: "pageName",
  ch: "channel",
  events: "events",
  purchaseID: "purchaseID",
  cc: "currency",
  pev2: "link_name",
};
const VAR = /^(?:v|c)(\d{1,3})$/; // eVar1–250, prop1–75
const LINK: Record<string, string> = { lnk_o: "custom_link", lnk_d: "download_link", lnk_e: "exit_link" };

const cut = (v: string) => (v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}…` : v);

function safeUrl(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

export function isAdobeHit(req: Pick<RawRequest, "url">): boolean {
  const u = safeUrl(req.url);
  return !!u && PATH.test(u.pathname);
}

/** `;sku;qty;price;events;evars` entries, comma separated -> items (category, sku, qty, total price). */
export function parseProducts(s: string): NormalizedItem[] {
  return s.split(",").filter((p) => p.trim()).slice(0, 50).map((p) => {
    const [category, sku, qty, price] = p.split(";");
    const item: NormalizedItem = {};
    if (sku) item.item_id = cut(sku);
    if (category) item.item_category = cut(category);
    const q = Number(qty), pr = Number(price);
    if (qty && Number.isFinite(q)) item.quantity = q;
    if (price && Number.isFinite(pr)) item.price = pr;
    return item;
  });
}

export function parseAdobe(req: RawRequest): ParsedEvent[] {
  const u = safeUrl(req.url);
  const m = u && PATH.exec(u.pathname);
  if (!u || !m) return [];
  // POST hits carry the parameters in the body; merge (body wins) so either form parses the same.
  const pairs = [...u.searchParams];
  if (req.body?.includes("=")) pairs.push(...new URLSearchParams(req.body));

  const params: Record<string, string | number> = {};
  let pe: string | undefined, g: string | undefined, pageName: string | undefined, products: string | undefined;
  let client: string | undefined;
  // Context data is nested: `c.` opens it, `a.` … `.a` opens/closes a prefix, `.c` closes it.
  let ctx: string[] | null = null;
  for (const [k, raw] of pairs) {
    const v = raw ?? "";
    if (ctx) {
      if (k === ".c" && ctx.length === 0) { ctx = null; continue; }
      if (k.startsWith(".")) { ctx.pop(); continue; }
      if (k.endsWith(".") && v === "") { ctx.push(k.slice(0, -1)); continue; }
      const path = [...ctx, k].join(".");
      if (path === "a" || path.startsWith("a.") || v === "") continue; // Adobe's own (ActivityMap, lifecycle)
      params[`c.${cut(path)}`] = cut(v);
      continue;
    }
    if (k === "c." && v === "") { ctx = []; continue; }
    if (v === "") continue;
    if (k === "pe") pe = v;
    else if (k === "g") g = v;
    else if (k === "products") products = v;
    else if (k === "mid" || k === "aid" || k === "vid") client ??= v;
    if (k === "pageName") pageName = v;
    const keep = KEEP[k] ?? (VAR.test(k) ? k : undefined);
    if (keep) params[keep] = cut(v);
  }

  const page = safeUrl(g ?? "");
  return [{
    vendor: "adobe_analytics",
    property: m[1],
    event: pe ? (LINK[pe] ?? cut(pe)) : "page_view",
    page: {
      path: page?.pathname,
      query: page && page.search.length > 1 ? cut(page.search.slice(1)) : undefined,
      title: pageName ? cut(pageName) : undefined,
    },
    params,
    items: products ? parseProducts(products) : [],
    user: { client_id: client },
    consent: {},
    transport: { type: req.type, method: req.method },
  }];
}

export const adobeAnalytics: VendorMatcher = {
  id: "adobe_analytics",
  label: "Adobe Analytics",
  kind: "analytics",
  urlHint: /\/b\/ss\//,
  match: isAdobeHit,
  parse: parseAdobe,
  // Adobe's terms forbid personal data in report suites.
  piiPolicy: "never",
};
