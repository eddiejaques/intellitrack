import { selectedEventCount } from "../shared/vendors";
import type { SessionMeta } from "../shared/types";

const GREEN = "#15803d";
const GREY = "#6b7280";

/** Badges are ~4 characters wide: exact up to 999, then 1k, 2k ... */
export function badgeText(count: number): string {
  if (count <= 0) return "";
  return count < 1000 ? String(count) : `${Math.min(99, Math.floor(count / 1000))}k`;
}

/**
 * Mirror a session onto the toolbar icon of the recorded tab only (tab-scoped, so other tabs stay
 * blank). Called from every persisted session change and again when the worker wakes, so the
 * count always comes from chrome.storage.session and never from in-memory state.
 * Never throws: a closed tab or a missing chrome.action must not break capture.
 */
export async function applyBadge(s: Pick<SessionMeta, "tabId" | "eventCount" | "status" | "vendors" | "vendor_counts"> | undefined): Promise<void> {
  if (!s) return;
  try {
    const action = chrome.action;
    if (!action) return;
    await action.setBadgeText({ tabId: s.tabId, text: badgeText(selectedEventCount(s)) });
    await action.setBadgeBackgroundColor({ tabId: s.tabId, color: s.status === "recording" ? GREEN : GREY });
  } catch {
    /* tab closed or API unavailable */
  }
}

export async function clearBadge(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) return;
  try {
    await chrome.action?.setBadgeText({ tabId, text: "" });
  } catch {
    /* tab closed */
  }
}
