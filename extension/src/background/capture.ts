import { vendors } from "../vendors";
import type { Marker, RawRequest, SessionMeta } from "../shared/types";
import { applyBadge, clearBadge } from "./badge";
import { putEvents, putSession, updateTransport, type StoredEvent } from "./store";

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
    if (!s || s.status !== "recording" || s.tabId !== tabId) return;
    const o = originOf(url);
    if (o && !s.origins.includes(o)) {
      s.origins.push(o);
      await saveSession(s);
    }
  });
}

function belongsToSession(s: SessionMeta, req: Pick<RawRequest, "tabId" | "initiator">): boolean {
  if (req.tabId === s.tabId) return true;
  if (req.tabId === -1 && req.initiator) return s.origins.includes(req.initiator);
  return false;
}

/** Quick pre-filter so we don't touch the session store for unrelated traffic. */
export function mightBeTracking(url: string): boolean {
  return vendors.some((v) => v.urlHint.test(url));
}

export function handleRequest(req: RawRequest): Promise<void> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || s.status !== "recording" || !belongsToSession(s, req)) return;
    const matcher = vendors.find((v) => v.match(req));
    if (!matcher) return;
    const parsed = matcher.parse(req);
    if (parsed.length === 0) return;

    const t = (req.timeStamp - s.startedAt) / 1000;
    const rawRef = `req_${String(s.nextReq++).padStart(4, "0")}`;
    const step = s.markers.length ? s.markers[s.markers.length - 1].id : undefined;
    const rows: StoredEvent[] = parsed.map((p) => {
      const id = `evt_${String(s.nextEvt++).padStart(4, "0")}`;
      return {
        ...p,
        id,
        t: Math.max(0, t),
        page: { ...p.page, step },
        raw_ref: rawRef,
        sessionId: s.id,
        requestId: req.requestId,
        key: `${s.id}/${id}`,
      };
    });
    s.eventCount += rows.length;
    // Counters first: if the worker dies between the writes, IDs are skipped, never reused.
    await saveSession(s);
    await putEvents(rows);
  });
}

export function handleCompleted(requestId: string, tabId: number, status: number, initiator?: string): Promise<void> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || !belongsToSession(s, { tabId, initiator })) return;
    await updateTransport(s.id, requestId, { status });
  });
}

export function handleError(requestId: string, tabId: number, error: string, initiator?: string): Promise<void> {
  return serialize(async () => {
    const s = await loadSession();
    if (!s || !belongsToSession(s, { tabId, initiator })) return;
    await updateTransport(s.id, requestId, { error });
  });
}
