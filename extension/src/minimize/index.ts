import type {
  Finding,
  CoverageEntry,
  JourneyPlan,
  MinimizedEvent,
  NormalizedEvent,
  NormalizedItem,
  Payload,
  SessionMeta,
} from "../shared/types";
import { normalizePath, redactString, redactValue } from "./redact";
import { runRules, type RuleOptions } from "../rules";

import { NOISE_EVENTS } from "./noise";
export { NOISE_EVENTS };
const CACHE_BUSTERS = new Set(["_z", "_p", "_s", "_fv", "_nsi", "_ss"]);
const DUP_WINDOW_S = 0.5;

export interface MinimizeOptions {
  maxEvents?: number;
}

function redactParams(p: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (CACHE_BUSTERS.has(k)) continue;
    out[redactString("key", k)] = redactValue(k, v);
  }
  return out;
}

function redactItems(items: NormalizedItem[]): NormalizedItem[] {
  return items.map((it) => {
    const o: NormalizedItem = {};
    for (const [k, v] of Object.entries(it)) if (v !== undefined) o[k] = redactValue(k, v);
    return o;
  });
}

const sig = (e: Pick<MinimizedEvent, "property" | "event" | "params" | "items" | "page" | "step">) =>
  JSON.stringify([e.property, e.event, e.params, e.items, e.page, e.step]);

export function minimize(
  events: NormalizedEvent[],
  opts: MinimizeOptions = {},
): Pick<Payload, "pages" | "events" | "stats"> & { client_id_stable: boolean } {
  const maxEvents = opts.maxEvents ?? 150;
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const noise: Record<string, number> = {};
  const pageIndex = new Map<string, string>();
  const pages: Payload["pages"] = [];
  const pageId = (path?: string, title?: string): string | undefined => {
    if (path === undefined) return undefined;
    const norm = normalizePath(path);
    let id = pageIndex.get(norm);
    if (!id) {
      id = `P${pages.length + 1}`;
      pageIndex.set(norm, id);
      pages.push({ id, path: norm, title: title ? redactString("title", title) : undefined });
    }
    return id;
  };

  const kept: MinimizedEvent[] = [];
  const lastBySig = new Map<string, MinimizedEvent & { _t: number }>();
  let dupDropped = 0;

  for (const e of sorted) {
    if (NOISE_EVENTS.has(e.event)) {
      noise[e.event] = (noise[e.event] ?? 0) + 1;
      continue;
    }
    const m: MinimizedEvent = {
      id: e.id,
      t: Math.round(e.t * 100) / 100,
      vendor: e.vendor,
      property: e.property,
      event: redactString("event", e.event),
      page: pageId(e.page.path, e.page.title),
      step: e.page.step,
      params: redactParams(e.params),
      items: redactItems(e.items),
      user: {
        client_id: e.user.client_id ? "[present]" : "[absent]",
        user_id: e.user.user_id ? "[present]" : "[absent]",
      },
      consent: e.consent,
      transport: { status: e.transport.status, error: e.transport.error },
    };
    const k = sig(m);
    const prev = lastBySig.get(k);
    if (prev && e.t - prev._t <= DUP_WINDOW_S) {
      prev.dup_dropped = (prev.dup_dropped ?? 0) + 1;
      if ((prev.dup_ids?.length ?? 0) < 5) (prev.dup_ids ??= []).push(e.id);
      prev._t = e.t;
      dupDropped++;
      continue;
    }
    const entry = Object.assign(m, { _t: e.t });
    lastBySig.set(k, entry);
    kept.push(m);
  }
  for (const m of kept) delete (m as { _t?: number })._t;

  let out = kept;
  let collapsed = 0;
  if (kept.length > maxEvents) {
    const groups = new Map<string, MinimizedEvent>();
    out = [];
    for (const m of kept) {
      const k = sig(m);
      const g = groups.get(k);
      if (!g) {
        groups.set(k, { ...m, count: 1, ids: [m.id] });
        out.push(groups.get(k)!);
      } else {
        g.count = (g.count ?? 1) + 1;
        if ((g.ids?.length ?? 0) < 10) g.ids!.push(m.id);
        collapsed++;
      }
    }
    // single events don't need count/ids noise
    for (const g of out) if (g.count === 1) { delete g.count; delete g.ids; }
  }

  const cids = new Set(events.map((e) => e.user.client_id).filter(Boolean));
  return {
    pages,
    events: out,
    client_id_stable: cids.size <= 1,
    stats: { raw_events: events.length, noise_counts: noise, duplicates_dropped: dupDropped, collapsed_events: collapsed },
  };
}

export interface BuildPayloadInput {
  session: Pick<SessionMeta, "startedAt" | "endedAt" | "markers">;
  events: NormalizedEvent[];
  plan?: JourneyPlan;
  rules?: RuleOptions;
  minimize?: MinimizeOptions;
}

/** Rules run on the full, unredacted events (they need raw values); only the redacted result leaves. */
export function buildPayload(input: BuildPayloadInput): Payload {
  // A step the user marked is "reached" even if it fired nothing - that is exactly a missing-event case.
  const markerIds = input.session.markers.map((m) => m.id);
  const { findings, coverage } = runRules(input.events, {
    plan: input.plan,
    ...(markerIds.length ? { reachedSteps: markerIds } : {}),
    ...input.rules,
  });
  const m = minimize(input.events, input.minimize);
  // Only cite events the recipient can actually see.
  const known = new Set<string>();
  for (const e of m.events) [e.id, ...(e.ids ?? []), ...(e.dup_ids ?? [])].forEach((i) => known.add(i));
  const sentFindings = findings.map((f) => ({ ...f, evidence: f.evidence.filter((i) => known.has(i)) }));
  const end = input.session.endedAt ?? Date.now();
  return {
    schema: "payload_v1",
    session: {
      duration_s: Math.round((end - input.session.startedAt) / 100) / 10,
      markers: input.session.markers.map((k) => ({ id: k.id, name: redactString("marker", k.name), t: Math.round(k.t * 10) / 10 })),
      properties: [...new Set(input.events.map((e) => e.property).filter((p): p is string => !!p))],
      client_id_stable: m.client_id_stable,
    },
    plan: input.plan,
    pages: m.pages,
    events: m.events,
    stats: m.stats,
    rule_findings: sentFindings,
    journey_coverage: coverage,
  };
}

/** Last-line safety net: any string in the payload that still looks like personal data. */
export function findRawPii(payload: Payload): string[] {
  const leaks: string[] = [];
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      if (email.test(v)) leaks.push(`${path}: email`);
      else if (/^[a-f0-9]{32,}$/i.test(v)) leaks.push(`${path}: raw hash`);
      else if (/^\+\d[\d\s().-]{7,}$/.test(v)) leaks.push(`${path}: phone`);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(payload, "payload");
  return leaks;
}

export type { Finding, CoverageEntry };
