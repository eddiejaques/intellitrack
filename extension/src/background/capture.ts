import { vendors } from "../vendors";
import { looksLikeTag } from "../vendors/tagHint";
import type { Marker, RawRequest, SessionMeta } from "../shared/types";
import { DEFAULT_VENDORS } from "../shared/vendors";
import { applyBadge, clearBadge } from "./badge";
import { patchRequest, putEvents, putRequest, putSession, updateTransport, type StoredEvent } from "./store";

const KEY = "session";

/** Session state lives in chrome.storage.session so it survives service-worker suspension. */
export async function loadSession(): Promise<SessionMeta | undefined> {
  const r = await chrome.storage.session.get(KEY);
  return r[KEY] as SessionMeta | undefined;
}

async function saveSession(s: SessionMeta): Promise<void> {
  await chrome.storage.session.set({ [KEY]: s });
  await putSession(s);
  await applyBadge(s);
}

/** Re-apply the badge from persisted state, e.g. when the service worker wakes or the browser starts. */
export async function restoreBadge(): Promise<void> {
  await applyBadge(await loadSession());
}

/** Forget the current session (its data stays in IndexedDB) and blank its badge. */
export function clearSession(): Promise<void> {
  return serialize(async () => {
    const s = await loadSession();
    await chrome.storage.session.remove(KEY);
    await clearBadge(s?.tabId);
  });
}

function originOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * All state mutations go through one promise chain, so concurrent webRequest callbacks
 * can't interleave their read-modify-write of the session counters.
 */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/** The user's default vendor choice (set in the popup). Falls back to GA4. */
export async function defaultVendors(): Promise<string[]> {
  try {
    const r = await chrome.storage.local.get("default_vendors");
    const v = r.default_vendors;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  } catch { /* storage unavailable */ }
  return DEFAULT_VENDORS;
}

export function startSession(tabId: number): Promise<SessionMeta> {
  return serialize(async () => {
    const prev = await loadSession();
    if (prev?.status === "recording") {
      prev.status = "stopped";
      prev.endedAt = Date.now();
      await saveSession(prev);
    }
    // a new session resets the counter, including on the tab the old one was recording
    if (prev) await clearBadge(prev.tabId);
    const tab = await chrome.tabs.get(tabId);
    const o = originOf(tab.url);
    let host = "";
    try { host = new URL(tab.url ?? "").host; } catch { /* about:blank etc. */ }
    const s: SessionMeta = {
      id: `ses_${Date.now().toString(36)}`,
      tabId,
      startedAt: Date.now(),
      status: "recording",
      origins: o ? [o] : [],
      eventCount: 0,
      nextEvt: 1,
      nextReq: 1,
      markers: [],
      plan_calls: 0,
      tabIds: [tabId],
      vendors: await defaultVendors(),
      vendor_counts: {},
      site: o ? { origin: o, host, title: tab.title?.slice(0, 120), url: tab.url?.split("#")[0].slice(0, 300) } : undefined,
    };
    await saveSession(s);
    return s;
  });
}

export function stopSession(): Promise<SessionMeta | undefined> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || s.status !== "recording") return s;
    s.status = "stopped";
    s.endedAt = Date.now();
    await saveSession(s);
    return s;
  });
}

/** Load, mutate and save the session in the same serialized queue as capture. Never hold it across a network call. */
export function updateSession<T>(fn: (s: SessionMeta) => T): Promise<T | undefined> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s) return undefined;
    const r = fn(s);
    await saveSession(s);
    return r;
  });
}

/** `stepId` ties the marker to a plan step; without it markers are numbered S1, S2, ... */
export function addMarker(name: string, stepId?: string): Promise<Marker | undefined> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || s.status !== "recording") return undefined;
    const m: Marker = { id: stepId ?? `S${s.markers.length + 1}`, name, t: (Date.now() - s.startedAt) / 1000 };
    s.markers.push(m);
    await saveSession(s);
    return m;
  });
}

/** Track navigations of the recorded tab so first-party worker hits can be attributed by origin. */
export function noteTabUrl(tabId: number, url: string): Promise<void> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || s.status !== "recording" || !recordedTabs(s).includes(tabId)) return;
    const o = originOf(url);
    if (o && !s.origins.includes(o)) {
      s.origins.push(o);
      await saveSession(s);
    }
  });
}

/**
 * Which page does this hit describe? GA4 carries it in `dl`, Google Ads in `url`. Requests made by
 * a service worker or shared worker have no tab (tabId -1) and an initiator that can be a CDN
 * origin, so the page the hit is about is the only reliable way to attribute them.
 */
export function hitDocumentOrigin(url: string): string | undefined {
  try {
    const q = new URL(url).searchParams;
    const loc = q.get("dl") ?? q.get("url") ?? q.get("page_location");
    return loc ? new URL(loc).origin : undefined;
  } catch {
    return undefined;
  }
}

const MAX_FOLLOWED_TABS = 10;
export const recordedTabs = (s: Pick<SessionMeta, "tabId" | "tabIds">): number[] => s.tabIds ?? [s.tabId];

/**
 * Sites like shops open products and checkouts in a new tab. A tab opened by a recorded tab joins
 * the recording, so the journey does not vanish after the first click.
 */
export function followTab(openerTabId: number, newTabId: number): Promise<boolean> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || s.status !== "recording") return false;
    const tabs = recordedTabs(s);
    if (!tabs.includes(openerTabId) || tabs.includes(newTabId) || tabs.length >= MAX_FOLLOWED_TABS) return false;
    s.tabIds = [...tabs, newTabId];
    await saveSession(s);
    return true;
  });
}

function belongsToSession(s: SessionMeta, req: Pick<RawRequest, "tabId" | "initiator">): boolean {
  if (recordedTabs(s).includes(req.tabId)) return true;
  if (req.tabId === -1 && req.initiator) return s.origins.includes(req.initiator);
  return false;
}

/** Quick pre-filter so we don't touch the session store for unrelated traffic. */
/**
 * The ID in a Google tag library URL (gtag/js?id=G-..., gtm.js?id=GTM-...), on Google's host or a
 * first-party one. A loaded GA4 tag that never sends a hit is a fault we can only see from this.
 */
const TAG_LIBRARY = /\/(?:gtag\/js|gtm\.js)\?(?:[^#]*&)?id=((?:G|GTM|AW|GT|DC)-[A-Za-z0-9]+)/i;
export function tagLibraryId(url: string): string | undefined {
  return TAG_LIBRARY.exec(url)?.[1]?.toUpperCase();
}

export function noteTagLoad(req: Pick<RawRequest, "url" | "tabId" | "initiator">): Promise<void> {
  return serialize(async () => {
    const id = tagLibraryId(req.url);
    const s = await loadSession();
    if (!id || !s || s.status !== "recording" || !belongsToSession(s, req)) return;
    s.tag_loads = { ...s.tag_loads, [id]: (s.tag_loads?.[id] ?? 0) + 1 };
    await saveSession(s);
  });
}

export function mightBeTracking(url: string, type?: string): boolean {
  return vendors.some((v) => v.urlHint.test(url)) || looksLikeTag(url, type);
}

const MAX_STORED_REQUESTS = 3000;
const BODY_LIMIT = 4000;
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return ""; } };

export function handleRequest(req: RawRequest): Promise<void> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || s.status !== "recording") return;
    const matcher = vendors.find((v) => v.match(req));
    let mine = belongsToSession(s, req);
    if (!mine && req.tabId === -1 && matcher) {
      // From a worker: attribute by the page the hit says it is about, and never lose track of the rest.
      const doc = hitDocumentOrigin(req.url);
      if (doc && s.origins.includes(doc)) mine = true;
      else {
        const u = s.unattributed ?? { count: 0, initiators: [] };
        u.count++;
        const who = req.initiator ?? "(no initiator)";
        if (!u.initiators.includes(who) && u.initiators.length < 5) u.initiators.push(who);
        s.unattributed = u;
        await saveSession(s);
        return;
      }
    }
    if (!mine) return;
    if (!matcher && !looksLikeTag(req.url, req.type)) return;

    const t = Math.max(0, (req.timeStamp - s.startedAt) / 1000);
    const step = s.markers.length ? s.markers[s.markers.length - 1].id : undefined;
    let rows: StoredEvent[] = [];

    if (matcher) {
      const parsed = matcher.parse(req);
      if (parsed.length > 0) {
        const rawRef = `req_${String(s.nextReq++).padStart(4, "0")}`;
        rows = parsed.map((p) => {
          const id = `evt_${String(s.nextEvt++).padStart(4, "0")}`;
          return { ...p, id, t, page: { ...p.page, step }, raw_ref: rawRef, sessionId: s.id, requestId: req.requestId, key: `${s.id}/${id}` };
        });
        s.eventCount += rows.length;
        s.vendor_counts = { ...s.vendor_counts, [matcher.id]: (s.vendor_counts?.[matcher.id] ?? 0) + rows.length };
      }
    }

    // Every tag-like request is logged, recognised or not, so raw tags can always be inspected.
    const logIt = (s.request_count ?? 0) < MAX_STORED_REQUESTS;
    if (logIt) {
      s.request_count = (s.request_count ?? 0) + 1;
      if (!matcher) s.unrecognized_count = (s.unrecognized_count ?? 0) + 1;
    }
    // Counters first: if the worker dies between the writes, IDs are skipped, never reused.
    await saveSession(s);
    if (rows.length) await putEvents(rows);
    if (logIt) {
      await putRequest({
        key: `${s.id}/${req.requestId}`, sessionId: s.id, requestId: req.requestId, t,
        url: req.url.slice(0, BODY_LIMIT), host: hostOf(req.url), method: req.method, type: req.type,
        vendor: matcher?.id ?? "unrecognized", events: rows.length, step,
        body: req.body ? req.body.slice(0, BODY_LIMIT) : undefined,
      });
    }
  });
}

export function handleCompleted(requestId: string, tabId: number, status: number, initiator?: string): Promise<void> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || !belongsToSession(s, { tabId, initiator })) return;
    await updateTransport(s.id, requestId, { status });
    await patchRequest(s.id, requestId, { status });
  });
}

export function handleError(requestId: string, tabId: number, error: string, initiator?: string): Promise<void> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || !belongsToSession(s, { tabId, initiator })) return;
    await updateTransport(s.id, requestId, { error });
    await patchRequest(s.id, requestId, { error });
  });
}
