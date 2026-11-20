import { normalizePath, redactValue } from "../minimize/redact";
import type { RawPush } from "../content/dataLayer";

/** One item the page pushed to its data layer, as stored with the session (payload already redacted). */
export interface DataLayerRow {
  key: string;
  sessionId: string;
  id: string;
  /** seconds since session start */
  t: number;
  tabId: number;
  /** Chrome's id for the page load the push came from; GA4 hits carry the same id */
  documentId?: string;
  /** normalised path of the page (`/products/:id`) */
  path?: string;
  /** the global the array lives on (usually `dataLayer`) */
  layer: string;
  /** "push" for object pushes; the gtag command (`event`, `config`, `consent`, `js`, `set`, …) otherwise */
  command: string;
  /** the `event` key of an object push, or the gtag command's first argument */
  name?: string;
  kind: RawPush["kind"];
  payload: unknown;
  replayed?: boolean;
  step?: string;
}

const MAX_PAYLOAD_CHARS = 20000;

/** Deep copy with every string value passed through the PII redaction used for events. */
export function redactDeep(v: unknown, key = "", depth = 0): unknown {
  if (typeof v === "string" || typeof v === "number") return redactValue(key, v);
  if (v === null || typeof v === "boolean") return v;
  if (depth > 8) return "[…]";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactDeep(x, key, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 51)) out[k] = redactDeep(x, k, depth + 1);
    return out;
  }
  return null;
}

/** Event name and command, read from what was pushed. */
export function describePush(kind: RawPush["kind"], payload: unknown): { command: string; name?: string } {
  if (kind === "gtag" && Array.isArray(payload)) {
    const command = typeof payload[0] === "string" ? payload[0] : "(gtag)";
    const a = payload[1];
    return { command, name: typeof a === "string" ? a : undefined };
  }
  if (kind === "object" && payload && typeof payload === "object") {
    const e = (payload as Record<string, unknown>).event;
    return { command: "push", name: typeof e === "string" ? e : undefined };
  }
  return { command: kind === "gtag" ? "(gtag)" : "push" };
}

/**
 * Check and redact a push reported by a page. The page can post anything, so the shape is
 * validated and the payload is size-capped. Returns undefined for junk.
 */
export function toPushFields(raw: unknown): (Pick<DataLayerRow, "layer" | "command" | "name" | "kind" | "payload" | "replayed"> & { at: number }) | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Partial<RawPush>;
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return undefined;
  if (r.kind !== "gtag" && r.kind !== "object" && r.kind !== "other") return undefined;
  let payload = redactDeep(r.payload);
  if (JSON.stringify(payload ?? null).length > MAX_PAYLOAD_CHARS) payload = { "[truncated]": `payload over ${MAX_PAYLOAD_CHARS} characters` };
  const { command, name } = describePush(r.kind, payload);
  const layer = typeof r.layer === "string" && /^[A-Za-z_$][\w$]{0,60}$/.test(r.layer) ? r.layer : "dataLayer";
  return {
    at: r.at,
    layer,
    command: command.slice(0, 60),
    name: name?.slice(0, 120),
    kind: r.kind,
    payload,
    replayed: r.replayed === true ? true : undefined,
  };
}

export const pagePath = (url?: string): string | undefined => {
  if (!url) return undefined;
  try { return normalizePath(new URL(url).pathname); } catch { return undefined; }
};

/**
 * Is this push a GA4 event that should have been sent? gtag('event', …) and dataLayer pushes with an
 * `event` key, except GTM's own lifecycle events (gtm.js, gtm.dom, gtm.load, gtm.click, …).
 */
export function isGa4EventPush(p: Pick<DataLayerRow, "command" | "name" | "kind">): boolean {
  if (!p.name) return false;
  if (p.kind === "gtag") return p.command === "event";
  return p.command === "push" && !p.name.startsWith("gtm.");
}

/** Label for the log: `add_to_cart`, `config G-XXXX`, `consent default`, `(no event)`. */
export function pushLabel(p: Pick<DataLayerRow, "command" | "name" | "kind">): string {
  if (p.kind === "gtag") return p.command === "event" ? p.name ?? "event" : [p.command, p.name].filter(Boolean).join(" ");
  return p.name ?? "(no event)";
}

export interface SentEvent {
  vendor: string;
  event: string;
  documentId?: string;
  tabId?: number;
  page: { path?: string };
}

/**
 * "sent" / "not sent" for every GA4 event push (by row key); other pushes get no verdict.
 * A push counts as sent when a GA4 event with the same name came from the same page load. Page
 * loads are matched by Chrome's documentId; hits without one (from a service worker) fall back to
 * the same page path.
 */
export function sentStatus(pushes: DataLayerRow[], events: SentEvent[]): Map<string, "sent" | "not_sent"> {
  const ga4 = events.filter((e) => e.vendor === "ga4");
  const byDoc = new Set<string>();
  const byPath = new Set<string>();
  const byPathNoDoc = new Set<string>();
  for (const e of ga4) {
    const k = `${pagePath(`http://x${e.page.path ?? "/"}`)}|${e.event}`;
    byPath.add(k);
    if (e.documentId) byDoc.add(`${e.documentId}|${e.event}`);
    else byPathNoDoc.add(k);
  }
  const out = new Map<string, "sent" | "not_sent">();
  for (const p of pushes) {
    if (!isGa4EventPush(p)) continue;
    const k = `${p.path ?? "/"}|${p.name}`;
    const sent = p.documentId ? byDoc.has(`${p.documentId}|${p.name}`) || byPathNoDoc.has(k) : byPath.has(k);
    out.set(p.key, sent ? "sent" : "not_sent");
  }
  return out;
}
