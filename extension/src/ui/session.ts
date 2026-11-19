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
