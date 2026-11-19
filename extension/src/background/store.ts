import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AuditReport, NormalizedEvent, RequestRow, SessionMeta } from "../shared/types";

export type StoredEvent = NormalizedEvent & { sessionId: string; requestId: string; key: string };

interface IntelliDB extends DBSchema {
  sessions: { key: string; value: SessionMeta };
  reports: { key: string; value: AuditReport };
  requests: { key: string; value: RequestRow; indexes: { by_session: string } };
  events: {
    key: string;
    value: StoredEvent;
    indexes: { by_session: string; by_request: [string, string] };
  };
}

let dbp: Promise<IDBPDatabase<IntelliDB>> | undefined;

export function getDb(name = "intellitrack"): Promise<IDBPDatabase<IntelliDB>> {
  dbp ??= openDB<IntelliDB>(name, 3, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore("sessions", { keyPath: "id" });
        const ev = db.createObjectStore("events", { keyPath: "key" });
        ev.createIndex("by_session", "sessionId");
        ev.createIndex("by_request", ["sessionId", "requestId"]);
      }
      if (oldVersion < 2) db.createObjectStore("reports", { keyPath: "session_id" });
      if (oldVersion < 3) db.createObjectStore("requests", { keyPath: "key" }).createIndex("by_session", "sessionId");
    },
  });
  return dbp;
}

export async function putSession(s: SessionMeta): Promise<void> {
  await (await getDb()).put("sessions", s);
}

export async function putEvents(evts: StoredEvent[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("events", "readwrite");
  await Promise.all([...evts.map((e) => tx.store.put(e)), tx.done]);
}

export async function getEvents(sessionId: string): Promise<StoredEvent[]> {
  const all = await (await getDb()).getAllFromIndex("events", "by_session", sessionId);
  return all.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
}

export async function updateTransport(
  sessionId: string,
  requestId: string,
  patch: { status?: number; error?: string },
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("events", "readwrite");
  const rows = await tx.store.index("by_request").getAll([sessionId, requestId]);
  for (const r of rows) await tx.store.put({ ...r, transport: { ...r.transport, ...patch } });
  await tx.done;
  return rows.length;
}

export async function listSessions(): Promise<SessionMeta[]> {
  const all = await (await getDb()).getAll("sessions");
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function putReport(r: AuditReport): Promise<void> {
  await (await getDb()).put("reports", r);
}

export async function getReport(sessionId: string): Promise<AuditReport | undefined> {
  return (await getDb()).get("reports", sessionId);
}

export async function putRequest(r: RequestRow): Promise<void> {
  await (await getDb()).put("requests", r);
}

export async function getRequests(sessionId: string): Promise<RequestRow[]> {
  const all = await (await getDb()).getAllFromIndex("requests", "by_session", sessionId);
  return all.sort((a, b) => a.t - b.t);
}

/** Status of a request arrives later (onCompleted / onErrorOccurred). */
export async function patchRequest(sessionId: string, requestId: string, patch: { status?: number; error?: string }): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("requests", "readwrite");
  const row = await tx.store.get(`${sessionId}/${requestId}`);
  if (row) await tx.store.put({ ...row, ...patch });
  await tx.done;
}

export async function getSession(id: string): Promise<SessionMeta | undefined> {
  return (await getDb()).get("sessions", id);
}

/** Everything that belongs to one session. */
export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["sessions", "events", "requests", "reports"], "readwrite");
  await tx.objectStore("sessions").delete(id);
  await tx.objectStore("reports").delete(id);
  for (const store of ["events", "requests"] as const) {
    const keys = await tx.objectStore(store).index("by_session").getAllKeys(id);
    await Promise.all(keys.map((k) => tx.objectStore(store).delete(k)));
  }
  await tx.done;
}

export async function listReports(): Promise<AuditReport[]> {
  return (await getDb()).getAll("reports");
}
