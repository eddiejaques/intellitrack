import { extractPageFacts, type PageFacts } from "../content/pageFacts";
import { normalizePath } from "../minimize/redact";
import { classifyPage, type PageEntry } from "../shared/siteContext";
import type { SessionMeta } from "../shared/types";
import { loadSession, recordedTabs, updateSession } from "./capture";

/** Wait this long after the last load / URL change of a tab before reading its page (SPAs settle). */
export const CAPTURE_DEBOUNCE_MS = 1500;
export const MAX_PAGES = 100;

export interface SiteContextDeps {
  loadSession: () => Promise<SessionMeta | undefined>;
  updateSession: <T>(fn: (s: SessionMeta) => T) => Promise<T | undefined>;
  tabUrl: (tabId: number) => Promise<string | undefined>;
  extract: (tabId: number) => Promise<PageFacts | undefined>;
  now: () => number;
}

const isRecorded = (s: SessionMeta | undefined, tabId: number): s is SessionMeta =>
  !!s && s.status === "recording" && recordedTabs(s).includes(tabId);

/** Add or replace the page entry for this path (a hash change or reload of the same page replaces it). */
export function upsertPage(s: SessionMeta, entry: PageEntry): void {
  const pages = (s.site_context ??= { pages: [] }).pages;
  const i = pages.findIndex((p) => p.path === entry.path);
  if (i >= 0) pages[i] = entry;
  else if (pages.length < MAX_PAGES) pages.push(entry);
}

/** Read the tab's page and store its type. Does nothing unless the tab is being recorded, before and after the read. */
export async function capturePage(tabId: number, deps: SiteContextDeps): Promise<PageEntry | undefined> {
  const before = await deps.loadSession();
  if (!isRecorded(before, tabId)) return undefined;
  const url = await deps.tabUrl(tabId);
  let u: URL;
  try { u = new URL(url ?? ""); } catch { return undefined; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  let facts: PageFacts | undefined;
  try { facts = await deps.extract(tabId); } catch { facts = undefined; /* page closed, navigated or not scriptable */ }
  if (!facts) return undefined;
  // only the path, normalised the same way the audit payload normalises event paths; never the query
  const path = normalizePath(u.pathname);
  const { type, reason } = classifyPage(u.pathname, facts);
  const entry: PageEntry = { path, page_type: type, reason, tabId, t: deps.now(), cmp: facts.cmp, platform: facts.platform };
  return deps.updateSession((s) => {
    // Stop, or a new session, may have landed while the page was being read
    if (!isRecorded(s, tabId) || s.id !== before.id) return undefined;
    upsertPage(s, entry);
    return entry;
  });
}

export function createScheduler(deps: SiteContextDeps, delayMs = CAPTURE_DEBOUNCE_MS) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return (tabId: number) => {
    clearTimeout(timers.get(tabId));
    timers.set(tabId, setTimeout(() => {
      timers.delete(tabId);
      void capturePage(tabId, deps);
    }, delayMs));
  };
}

const chromeDeps: SiteContextDeps = {
  loadSession,
  updateSession,
  async tabUrl(tabId) {
    try { return (await chrome.tabs.get(tabId)).url; } catch { return undefined; }
  },
  async extract(tabId) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageFacts });
    return r?.result as PageFacts | undefined;
  },
  now: () => Date.now(),
};

/** Schedule a capture of this tab's page: call on load complete and on every URL change (SPA navigation). */
export const schedulePageCapture = createScheduler(chromeDeps);
