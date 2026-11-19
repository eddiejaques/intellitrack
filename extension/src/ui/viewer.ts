import type { Message, SessionMeta } from "../shared/types";
import type { StoredEvent } from "../background/store";

const send = <T>(m: Message): Promise<T> => chrome.runtime.sendMessage(m);

async function main() {
  const s = await send<SessionMeta | undefined>({ type: "getState" });
  const rows = document.getElementById("rows")!;
  if (!s) {
    document.getElementById("summary")!.textContent = "No session recorded yet.";
    return;
  }
  document.getElementById("sid")!.textContent = s.id;
  const events = await send<StoredEvent[]>({ type: "getEvents", sessionId: s.id });
  document.getElementById("summary")!.textContent = `· ${events.length} events · ${s.status}`;

  for (const e of events) {
    const tr = document.createElement("tr");
    const status = e.transport.error ?? e.transport.status ?? "…";
    const cells = [e.id, e.t.toFixed(2), e.page.step ?? "", e.event, e.property ?? "", String(status)];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.appendChild(td);
    }
    const td = document.createElement("td");
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify({ page: e.page, params: e.params, items: e.items, user: e.user, consent: e.consent }, null, 1);
    td.appendChild(pre);
    tr.appendChild(td);
    rows.appendChild(tr);
  }

  document.getElementById("export")!.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ session: s, events }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${s.id}.json`;
    a.click();
  });
}

void main();
