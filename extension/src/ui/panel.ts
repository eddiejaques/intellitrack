import { mountLogView } from "./logview";
import type { Message, SessionMeta } from "../shared/types";

const send = <T>(m: Message): Promise<T> => chrome.runtime.sendMessage(m);
const count = document.getElementById("count")!;
const label = document.getElementById("label")!;
const dot = document.getElementById("dot")!;
const toggle = document.getElementById("toggle") as HTMLButtonElement;

function paint(s?: SessionMeta) {
  const rec = s?.status === "recording";
  count.textContent = String(s?.eventCount ?? 0);
  label.textContent = rec ? "Recording" : s ? "Stopped" : "Ready";
  dot.className = `dot ${rec ? "rec" : s ? "done" : ""}`;
  toggle.textContent = rec ? "Stop recording" : "Start on current tab";
  toggle.className = `btn sm ${rec ? "secondary" : "primary"}`;
}

toggle.addEventListener("click", async () => {
  const s = await send<SessionMeta | undefined>({ type: "getState" });
  if (s?.status === "recording") await send({ type: "stop" });
  else {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id !== undefined) await send({ type: "start", tabId: tab.id });
  }
  paint(await send<SessionMeta | undefined>({ type: "getState" }));
});
chrome.storage.session.onChanged.addListener((c) => { if (c.session) paint(c.session.newValue as SessionMeta | undefined); });
void send<SessionMeta | undefined>({ type: "getState" }).then(paint);
mountLogView(document.getElementById("log")!);
