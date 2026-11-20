import type { Message, SessionMeta, SessionSummary } from "../shared/types";

export const send = <T>(m: Message): Promise<T> => chrome.runtime.sendMessage(m);

/** Pages are scoped to one session: ?session=ID. Without it: the current one, else the latest. */
export async function resolveSession(): Promise<SessionMeta | undefined> {
  const id = new URLSearchParams(location.search).get("session");
  if (id) return send<SessionMeta | undefined>({ type: "getSession", sessionId: id });
  const cur = await send<SessionMeta | undefined>({ type: "getState" });
  if (cur) return cur;
  return (await send<SessionSummary[]>({ type: "listSessions" }))[0]?.session;
}

export const pageUrl = (page: string, sessionId?: string) =>
  chrome.runtime.getURL(page) + (sessionId ? `?session=${encodeURIComponent(sessionId)}` : "");

export const siteLabel = (s: Pick<SessionMeta, "site" | "origins">) => s.site?.host || s.origins.find((o) => o.startsWith("http"))?.replace(/^https?:\/\//, "") || "unknown site";

export function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return same ? `Today, ${time}` : `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

export function fmtDuration(s: Pick<SessionMeta, "startedAt" | "endedAt" | "status">): string {
  const sec = Math.max(0, Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

/** True when this page was built together with the running background worker. */
export function isCurrentWorker(reply: unknown, build: string): boolean {
  return !!reply && typeof reply === "object" && (reply as { build?: string }).build === build;
}

/**
 * After a rebuild, pages load the new files at once but the background worker keeps running the
 * old code until the extension is reloaded. Pages then get empty answers and look broken.
 * Returns true (after explaining) when that is the case, so the caller can stop.
 */
export async function guardWorker(root: HTMLElement, mode: "replace" | "prepend" = "replace"): Promise<boolean> {
  let ok = false;
  try { ok = isCurrentWorker(await send({ type: "hello" }), __BUILD_ID__); } catch { ok = false; }
  if (ok) return false;
  const card = document.createElement("div");
  card.className = "card stack";
  card.innerHTML = '<h3>IntelliTrack was updated, but it is still running the old version</h3>' +
    '<p class="muted">Open <code>chrome://extensions</code>, click the reload icon on IntelliTrack, then reopen this page. Your sessions are kept.</p>';
  if (mode === "prepend") root.prepend(card); else root.replaceChildren(card);
  return true;
}
