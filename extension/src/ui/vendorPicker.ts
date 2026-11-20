import { VENDOR_OPTIONS, vendorLabel } from "../shared/vendors";
import type { Message } from "../shared/types";

const send = <T>(m: Message): Promise<T> => chrome.runtime.sendMessage(m);

/**
 * Toggle pills for the vendors to judge a session on. `counts` are events per vendor seen so far
 * (shown on the pill). Every vendor is captured regardless; this only changes views and audits.
 */
export function vendorPicker(selected: string[], counts: Record<string, number> | undefined, onToggle: (next: string[]) => void, label?: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "pills";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Vendors to audit");
  if (label) { const l = document.createElement("span"); l.className = "label"; l.textContent = label; wrap.append(l); }
  // known vendors first, then anything else that was seen
  const ids = [...VENDOR_OPTIONS.map((v) => v.id), ...Object.keys(counts ?? {}).filter((id) => !VENDOR_OPTIONS.some((v) => v.id === id))];
  for (const id of ids) {
    const on = selected.includes(id);
    const n = counts?.[id];
    const b = document.createElement("button");
    b.type = "button";
    b.className = `pill ${on ? "on" : ""}`.trim();
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? `Click to leave ${vendorLabel(id)} out` : `Click to include ${vendorLabel(id)}`;
    b.textContent = n !== undefined && n > 0 ? `${vendorLabel(id)} · ${n}` : vendorLabel(id);
    b.addEventListener("click", () => onToggle(on ? selected.filter((x) => x !== id) : [...selected, id]));
    wrap.append(b);
  }
  return wrap;
}

/** Persist a choice for one session and/or as the default for new sessions. */
export const saveVendors = (vendors: string[], opts: { sessionId?: string; asDefault?: boolean }) =>
  send<string[]>({ type: "setVendors", vendors, sessionId: opts.sessionId, asDefault: opts.asDefault });
