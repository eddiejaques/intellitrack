import type { NormalizedItem, ParsedEvent, RawRequest, VendorMatcher } from "../shared/types";

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** GA4 collect hit: path ends in /g/collect, v=2, tid=G-*, on any host (sGTM / first-party). */
export function isGa4Request(req: Pick<RawRequest, "url">): boolean {
  const u = safeUrl(req.url);
  if (!u || !u.pathname.endsWith("/g/collect")) return false;
  const tid = u.searchParams.get("tid") ?? "";
  return u.searchParams.get("v") === "2" && tid.startsWith("G-");
}

function num(v: string): number | string {
  if (v.trim() === "") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

const ITEM_KEYS: Record<string, string> = {
  id: "item_id",
  nm: "item_name",
  br: "item_brand",
  ca: "item_category",
  ca2: "item_category2",
  ca3: "item_category3",
  ca4: "item_category4",
  ca5: "item_category5",
  va: "item_variant",
  pr: "price",
  qt: "quantity",
  ln: "item_list_name",
  li: "item_list_id",
  lp: "index",
  cp: "coupon",
  ds: "discount",
  af1: "affiliation",
};

/** Parse a `prN` value like "idSKU1~nmBlue Shirt~pr29.9~qt1". Segments are `~`-separated, key = prefix. */
export function parseItem(raw: string): NormalizedItem {
  const item: NormalizedItem = {};
  for (const seg of raw.split("~")) {
    if (!seg) continue;
    const key3 = ITEM_KEYS[seg.slice(0, 3)] ? seg.slice(0, 3) : undefined;
    const key2 = ITEM_KEYS[seg.slice(0, 2)] ? seg.slice(0, 2) : undefined;
    const key = key3 ?? key2;
    if (key) {
      item[ITEM_KEYS[key]] = num(seg.slice(key.length)) as string | number;
      continue;
    }
    // custom item params: k<N><name> / v<N><value>
    const custom = /^([kv])(\d+)(.*)$/.exec(seg);
    if (custom) item[`${custom[1] === "k" ? "key" : "val"}${custom[2]}`] = custom[3];
  }
  return item;
}

function parseLine(
  shared: URLSearchParams,
  line: URLSearchParams,
): { event: string; params: Record<string, string | number>; items: NormalizedItem[] } {
  // line params override URL params
  const merged = new Map<string, string>();
  for (const [k, v] of shared) merged.set(k, v);
  for (const [k, v] of line) merged.set(k, v);

  const params: Record<string, string | number> = {};
  const itemEntries: [number, NormalizedItem][] = [];
  for (const [k, v] of merged) {
    if (k === "cu") params.currency = v;
    else if (k.startsWith("epn.")) params[k.slice(4)] = num(v);
    else if (k.startsWith("ep.")) params[k.slice(3)] = v;
    else {
      const m = /^pr(\d+)$/.exec(k);
      if (m) itemEntries.push([Number(m[1]), parseItem(v)]);
    }
  }
  itemEntries.sort((a, b) => a[0] - b[0]);
  return { event: merged.get("en") ?? "(unknown)", params, items: itemEntries.map((e) => e[1]) };
}

export function parseGa4(req: RawRequest): ParsedEvent[] {
  const u = safeUrl(req.url);
  if (!u) return [];
  const shared = u.searchParams;
  // Event-level keys in the URL belong to the first event only when the body is empty (GET hit);
  // for batched POSTs the URL carries only shared params, and each body line is one event.
  const lines = (req.body ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

  const shell = {
    vendor: "ga4",
    property: shared.get("tid") ?? undefined,
    page: {
      path: pathOf(shared.get("dl")),
      query: queryOf(shared.get("dl")),
      title: shared.get("dt") ?? undefined,
    },
    user: {
      client_id: shared.get("cid") ?? undefined,
      user_id: shared.get("uid") ?? undefined,
    },
    consent: { gcs: shared.get("gcs") ?? undefined, gcd: shared.get("gcd") ?? undefined },
    transport: { type: req.type, method: req.method },
  };

  const lineParams = lines.length ? lines.map((l) => new URLSearchParams(l)) : [new URLSearchParams()];
  const out: ParsedEvent[] = [];
  for (const lp of lineParams) {
    const { event, params, items } = parseLine(lines.length ? stripEventKeys(shared) : shared, lp);
    out.push({
      ...shell,
      page: {
        ...shell.page,
        path: pathOf(lp.get("dl")) ?? shell.page.path,
        query: lp.has("dl") ? queryOf(lp.get("dl")) : shell.page.query,
        title: lp.get("dt") ?? shell.page.title,
      },
      user: { ...shell.user },
      consent: { ...shell.consent },
      transport: { ...shell.transport },
      event,
      params,
      items,
    });
  }
  return out;
}

/** For batched hits: ignore the URL's own `en` so a body line without `en` isn't mislabeled. Also drops ep, epn and prN keys. */
function stripEventKeys(sp: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of sp) {
    if (k === "en" || k === "cu" || k.startsWith("ep.") || k.startsWith("epn.") || /^pr\d+$/.test(k)) continue;
    out.append(k, v);
  }
  return out;
}

function queryOf(dl: string | null): string | undefined {
  if (!dl) return undefined;
  const u = safeUrl(dl);
  return u && u.search.length > 1 ? u.search.slice(1) : undefined;
}

function pathOf(dl: string | null): string | undefined {
  if (!dl) return undefined;
  const u = safeUrl(dl);
  return u ? u.pathname : undefined;
}

export const ga4: VendorMatcher = {
  id: "ga4",
  label: "Google Analytics 4",
  kind: "analytics",
  match: isGa4Request,
  parse: parseGa4,
  piiPolicy: "never",
};
