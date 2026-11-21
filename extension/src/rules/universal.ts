import { vendors } from "../vendors";
import { detectPii, type PiiKind } from "../minimize/redact";
import { NOISE_EVENTS } from "../minimize/noise";
import type { NormalizedEvent } from "../shared/types";
import { consentIssues } from "../shared/consent";
import { CONVERSION_EVENTS, ids, uniq, type RawFinding } from "./util";

type Policy = "never" | "hashed_only" | "expected";
const policyOf = (vendor: string): Policy => vendors.find((v) => v.id === vendor)?.piiPolicy ?? "never";

interface Hit { loc: string; kind: PiiKind; ev: NormalizedEvent }

function scanPii(e: NormalizedEvent): Hit[] {
  const hits: Hit[] = [];
  const add = (loc: string, key: string, value: unknown) => {
    if (typeof value !== "string") return;
    for (const kind of detectPii(key, value)) hits.push({ loc, kind, ev: e });
  };
  for (const [k, v] of Object.entries(e.params)) add(`parameter "${safe(k)}"`, k, v);
  e.items.forEach((it) => {
    for (const [k, v] of Object.entries(it)) add(`item field "${safe(k)}"`, k, v);
  });
  if (e.page.title) add("page title", "title", e.page.title);
  if (e.page.path) add("page path", "path", e.page.path);
  if (e.page.query) {
    for (const [k, v] of new URLSearchParams(e.page.query)) add(`page URL query "${safe(k)}"`, k, v);
    // emails that survived in a key or a malformed query
    add("page URL query", "query", e.page.query);
  }
  add("user_id", "user_id", e.user.user_id);
  return hits;
}

/** Param names can themselves hold data; never echo more than a short, email-free label. */
function safe(name: string): string {
  return /@/.test(name) ? "[redacted-name]" : name.slice(0, 40);
}

export function piiRule(events: NormalizedEvent[]): RawFinding[] {
  const out: RawFinding[] = [];
  const groups = new Map<string, Hit[]>();
  for (const e of events) for (const h of scanPii(e)) {
    const k = `${e.vendor}|${h.kind}|${h.loc}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  for (const [k, hs] of groups) {
    const [vendor, kind, loc] = k.split("|") as [string, PiiKind, string];
    const policy = policyOf(vendor);
    if (policy === "expected") continue;
    const evs = hs.map((h) => h.ev);
    if (kind === "email" || kind === "phone") {
      out.push({
        severity: "critical", vendor, category: "pii",
        title: `Plaintext ${kind} sent to ${vendor.toUpperCase()}`,
        detail: `A plaintext ${kind} appears in ${loc} on ${evs.length} event(s). ${vendor.toUpperCase()} does not allow personal data${policy === "hashed_only" ? " unless it is hashed" : ""}.`,
        evidence: ids(evs),
        recommendation: policy === "hashed_only"
          ? `Hash the value (SHA-256, normalised) before sending, or stop sending it.`
          : `Stop sending this value. Remove it at the source (data layer / tag) and check the property for already-collected data.`,
      });
    } else if (kind === "hash_invalid") {
      out.push({
        severity: "high", vendor, category: "pii",
        title: "Hashed identifier has the wrong length",
        detail: `${loc} looks like a hash but is not a 64-character SHA-256 (${evs.length} event(s)). It cannot be matched.`,
        evidence: ids(evs),
        recommendation: "Hash with SHA-256 after trimming and lower-casing the input.",
      });
    } else if (kind === "sha256" && policy === "never") {
      out.push({
        severity: "medium", vendor, category: "pii",
        title: `Hashed identifier sent to ${vendor.toUpperCase()}`,
        detail: `${loc} holds a SHA-256 value on ${evs.length} event(s). Hashing does not make personal data allowed in ${vendor.toUpperCase()}.`,
        evidence: ids(evs),
        recommendation: "Confirm this is not a hashed email/phone. If it is, remove it from this tag.",
      });
    }
  }
  return out;
}

/** Thin wrapper: the actual checks are the pure `consentIssues`, shared with the live view (X2). */
export function consentRule(events: NormalizedEvent[]): RawFinding[] {
  return consentIssues(events).map((i) => ({
    severity: i.severity, vendor: "ga4", category: "consent",
    title: i.title, detail: i.detail, recommendation: i.recommendation,
    evidence: ids(i.events),
  }));
}

export function identityRule(events: NormalizedEvent[]): RawFinding[] {
  const out: RawFinding[] = [];
  const ga = events.filter((e) => e.vendor === "ga4");
  const cids = uniq(ga.map((e) => e.user.client_id).filter(Boolean));
  if (cids.length > 1) {
    const first = ga.filter((e) => e.user.client_id !== cids[0]);
    out.push({
      severity: "high", vendor: "ga4", category: "identity",
      title: "client_id changed during the session",
      detail: `${cids.length} different client IDs were used. Each change splits one visitor into several users and sessions.`,
      evidence: ids(first),
      recommendation: "Check cookie handling, cross-domain linking and any consent flow that resets the _ga cookie.",
    });
  }
  const props = uniq(ga.map((e) => e.property).filter(Boolean));
  if (props.length > 1) {
    out.push({
      severity: "medium", vendor: "ga4", category: "identity",
      title: `${props.length} GA4 properties receive data`,
      detail: `Measurement IDs seen: ${props.join(", ")}. Verify each is intended (e.g. a leftover test property).`,
      evidence: ids(ga.filter((e) => e.property === props[1])),
      recommendation: "Remove unintended measurement IDs, or document the multi-property set-up.",
    });
  }
  return out;
}

const canonical = (e: NormalizedEvent) => JSON.stringify([e.vendor, e.event, e.params, e.items]);

export function duplicateRule(events: NormalizedEvent[]): RawFinding[] {
  const out: RawFinding[] = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);

  // duplicate conversions: same event + same transaction/ID, any distance apart
  const conv = new Map<string, NormalizedEvent[]>();
  for (const e of sorted) {
    if (!CONVERSION_EVENTS.has(e.event)) continue;
    const key = e.params.transaction_id !== undefined && (e.event === "purchase" || e.vendor === "google_ads")
      ? `${e.vendor}|${e.event}|${e.params.label ?? ""}|${e.params.transaction_id}`
      : `${e.vendor}|${e.event}|${canonical(e)}`;
    conv.set(key, [...(conv.get(key) ?? []), e]);
  }
  const flagged = new Set<string>();
  for (const evs of conv.values()) {
    if (evs.length < 2) continue;
    evs.forEach((e) => flagged.add(e.id));
    const name = evs[0].event;
    out.push({
      severity: name === "purchase" ? "critical" : "high", vendor: evs[0].vendor, category: "duplicate",
      title: `Duplicate ${name} conversion`,
      detail: `${name} fired ${evs.length} times with identical ${evs[0].params.transaction_id !== undefined && (name === "purchase" || evs[0].vendor === "google_ads") ? "transaction_id" : "parameters"}. Conversions and revenue are over-counted.`,
      evidence: ids(evs),
      recommendation: "Fire the conversion once per transaction: guard against page reloads and double-bound triggers.",
    });
  }

  // double-fired within 500 ms (any non-heartbeat event)
  const last = new Map<string, NormalizedEvent>();
  const dbl = new Map<string, NormalizedEvent[]>();
  for (const e of sorted) {
    if (NOISE_EVENTS.has(e.event) || flagged.has(e.id)) continue;
    const k = canonical(e);
    const prev = last.get(k);
    if (prev && e.t - prev.t <= 0.5) dbl.set(e.event, [...(dbl.get(e.event) ?? []), prev, e]);
    last.set(k, e);
  }
  for (const [name, evs] of dbl) {
    const u = uniq(evs.map((e) => e.id)).map((id) => evs.find((e) => e.id === id)!);
    out.push({
      severity: "medium", vendor: u[0].vendor, category: "duplicate",
      title: `${name} double-fired`,
      detail: `${name} was sent more than once with identical parameters within 500 ms (${u.length} events). Typically two tags or two triggers firing for the same action.`,
      evidence: ids(u),
      recommendation: "Find the second tag/trigger (GTM preview) and remove or deduplicate it.",
    });
  }
  return out;
}

export function deliveryRule(events: NormalizedEvent[]): RawFinding[] {
  const out: RawFinding[] = [];
  const blocked = events.filter((e) => e.transport.error?.includes("BLOCKED_BY_CLIENT"));
  const failed = events.filter((e) => !blocked.includes(e) && (e.transport.error || (e.transport.status ?? 0) >= 400));
  if (failed.length) {
    out.push({
      severity: "high", vendor: failed[0].vendor, category: "delivery",
      title: "Hits failed to send",
      detail: `${failed.length} event(s) got an error or HTTP status >= 400 (${uniq(failed.map((e) => e.transport.error ?? String(e.transport.status))).slice(0, 3).join(", ")}). This data is lost.`,
      evidence: ids(failed),
      recommendation: "Check the collection endpoint (sGTM container/URL, CORS, certificates).",
    });
  }
  if (blocked.length) {
    out.push({
      severity: "low", vendor: blocked[0].vendor, category: "delivery",
      title: "Hits blocked by the browser or an extension",
      detail: `${blocked.length} event(s) were blocked client-side (net::ERR_BLOCKED_BY_CLIENT), most likely an ad blocker. Not necessarily a site fault.`,
      evidence: ids(blocked),
      recommendation: "If this is the tester's own blocker, re-run without it. A first-party sGTM endpoint reduces blocking.",
    });
  }
  return out;
}

export function namingRule(events: NormalizedEvent[]): RawFinding[] {
  const bad = events.filter((e) => e.event !== "(unknown)" && !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(e.event));
  const unknown = events.filter((e) => e.event === "(unknown)");
  const out: RawFinding[] = [];
  if (bad.length) {
    out.push({
      severity: "low", vendor: bad[0].vendor, category: "naming",
      title: "Event names break GA4 naming rules",
      detail: `Event names must start with a letter, use letters/digits/underscores and be at most 40 characters. Offending: ${uniq(bad.map((e) => e.event.slice(0, 40))).slice(0, 5).join(", ")}.`,
      evidence: ids(bad),
      recommendation: "Rename these events; GA4 drops or truncates invalid names.",
    });
  }
  if (unknown.length) {
    out.push({
      severity: "medium", vendor: unknown[0].vendor, category: "naming",
      title: "Hits without an event name",
      detail: `${unknown.length} hit line(s) had no \`en\` parameter.`,
      evidence: ids(unknown),
      recommendation: "Every GA4 hit needs an event name; check the tag configuration.",
    });
  }
  return out;
}

export const universalRules = [piiRule, consentRule, identityRule, duplicateRule, deliveryRule, namingRule];
