import { mountLogView } from "./logview";
import { pageUrl, send } from "./session";
import { selectedEventCount } from "../shared/vendors";
import type { SessionMeta } from "../shared/types";

const count = document.getElementById("count")!;
const label = document.getElementById("label")!;
const dot = document.getElementById("dot")!;
const toggle = document.getElementById("toggle") as HTMLButtonElement;
const audit = document.getElementById("audit") as HTMLAnchorElement;

/** The header always describes the session the table below is showing. */
function paint(s?: SessionMeta) {
  const rec = s?.status === "recording";
  count.textContent = String(s ? selectedEventCount(s) : 0);
  label.textContent = rec ? "Recording" : s ? "Stopped" : "Ready";
  dot.className = `dot ${rec ? "rec" : s ? "done" : ""}`;
  toggle.textContent = rec ? "Stop recording" : "Start on current tab";
  toggle.className = `btn sm ${rec ? "secondary" : "primary"}`;
  const canAudit = !!s && !rec && selectedEventCount(s) > 0;
  audit.classList.toggle("hide", !canAudit);
  if (canAudit) audit.href = pageUrl("preview.html", s!.id);
}

toggle.addEventListener("click", async () => {
  const s = await send<SessionMeta | undefined>({ type: "getState" });
  if (s?.status === "recording") await send({ type: "stop" });
  else {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined) await send({ type: "start", tabId: tab.id });
  }
});
mountLogView(document.getElementById("log")!, { onSession: paint });
