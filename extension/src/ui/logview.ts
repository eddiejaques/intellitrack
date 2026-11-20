import type { StoredEvent } from "../background/store";
import type { Message, RequestRow, SessionMeta } from "../shared/types";
import { fmtDuration, fmtWhen, guardWorker, resolveSession, siteLabel } from "./session";
import { saveVendors, vendorPicker } from "./vendorPicker";
import { selectedEventCount, sessionVendors, vendorLabel } from "../shared/vendors";
import { guessVendor } from "../vendors/tagHint";

const send = <T>(m: Message): Promise<T> => chrome.runtime.sendMessage(m);

type K = string | HTMLElement;
function h(tag: string, cls = "", ...kids: K[]): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...kids);
  return el;
}
const chip = (t: string, cls = "") => h("span", `chip ${cls}`.trim(), t);
const fmtT = (t: number) => `${t.toFixed(1)}s`;

/** Decode a query string or form body into rows; pretty-print JSON; otherwise show as-is. */
function decodeBody(body: string): HTMLElement {
  const t = body.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return h("pre", "json", JSON.stringify(JSON.parse(t), null, 2)); } catch { /* not JSON */ }
  }
  if (/^[^\s=&]+=/.test(t)) {
    const lines = t.split("\n").filter(Boolean);
    return h("div", "stack", ...lines.map((line, i) => paramTable(new URLSearchParams(line), lines.length > 1 ? `hit ${i + 1}` : "")));
  }
  return h("pre", "json", body);
}

function paramTable(sp: URLSearchParams, title = ""): HTMLElement {
  const rows = [...sp].map(([k, v]) => h("tr", "", h("td", "mono", k), h("td", "mono", v)));
  const tb = h("table", "kv", h("tbody", "", ...rows));
  return h("div", "", title ? h("div", "muted", title) : h("span"), rows.length ? tb : h("div", "muted", "no parameters"));
}

function vendorChip(v: string, url?: string, selected = true): HTMLElement {
  if (v === "unrecognized") {
    const guess = url ? guessVendor(url) : undefined;
    return chip(guess ? `not parsed · ${guess}` : "not parsed", "partial");
  }
  return chip(selected ? vendorLabel(v) : `${vendorLabel(v)} (left out)`, selected ? "accent" : "no_data");
}

function statusChip(r: { status?: number; error?: string }): HTMLElement {
  if (r.error) return chip(r.error.replace("net::ERR_", ""), "missing");
  if (r.status === undefined) return chip("…", "not_reached");
  return chip(String(r.status), r.status >= 400 ? "missing" : "matched");
}

function expandable(summary: HTMLElement, detail: () => HTMLElement): HTMLElement[] {
  const d = h("tr", "detail hide", h("td", "", detail()));
  (d.firstChild as HTMLElement).setAttribute("colspan", String(summary.children.length));
  summary.classList.add("clickable");
  summary.addEventListener("click", () => d.classList.toggle("hide"));
  return [summary, d];
}

function tagRow(r: RequestRow, selected: string[]): HTMLElement[] {
  let path = r.url;
  try { const u = new URL(r.url); path = u.pathname + (u.search ? "?…" : ""); } catch { /* keep raw */ }
  const row = h("tr", "",
    h("td", "mono muted nowrap", fmtT(r.t)),
    h("td", "", h("div", "row wrap", vendorChip(r.vendor, r.url, r.vendor === "unrecognized" || selected.includes(r.vendor)), h("span", "mono muted", r.method)), h("div", "host", r.host), h("div", "muted mono path", path)),
    h("td", "", statusChip(r)));
  return expandable(row, () => {
    const kids: K[] = [h("div", "mono wrap-url", r.url)];
    try { const u = new URL(r.url); if (u.search) kids.push(h("h3", "", "Query parameters"), paramTable(u.searchParams)); } catch { /* skip */ }
    if (r.body) kids.push(h("h3", "", "Body"), decodeBody(r.body));
    if (r.vendor === "unrecognized") kids.push(h("div", "note info", "No IntelliTrack parser claims this request yet. It is shown raw. Export the session and send it over to get this vendor supported."));
    return h("div", "stack", ...kids);
  });
}

function eventRow(e: StoredEvent): HTMLElement[] {
  const row = h("tr", "",
    h("td", "mono muted nowrap", fmtT(e.t)),
    h("td", "", h("div", "row wrap", h("strong", "", e.event), e.page.step ? chip(e.page.step) : h("span")), h("div", "row wrap", chip(vendorLabel(e.vendor), "accent"), chip(e.property ?? "", "mono"))),
    h("td", "", statusChip(e.transport)));
  return expandable(row, () => h("div", "stack",
    h("div", "muted", `${e.id} · ${e.page.path ?? ""}`),
    Object.keys(e.params).length ? paramTable(new URLSearchParams(Object.entries(e.params).map(([k, v]) => [k, String(v)])), "Parameters") : h("span"),
    e.items.length ? h("div", "", h("div", "muted", "Items"), h("pre", "json", JSON.stringify(e.items, null, 2))) : h("span"),
    h("div", "muted", `consent ${JSON.stringify(e.consent)} · client ${e.user.client_id ?? "–"}`)));
}

export interface LogViewOptions {
  /** full-page viewer shows an export button */
  exportable?: boolean;
  /** called whenever the shown session changes (the panel header follows it) */
  onSession?: (s: SessionMeta | undefined) => void;
}

export function mountLogView(root: HTMLElement, opts: LogViewOptions = {}) {
  let tab: "tags" | "events" = "tags";
  let onlyUnparsed = false;
  let filter = "";
  let session: SessionMeta | undefined;
  let events: StoredEvent[] = [];
  let requests: RequestRow[] = [];
  let timer: number | undefined;

  const summary = h("div", "row wrap");
  const pickers = h("div", "");
  const note = h("div", "");
  const tabs = h("div", "seg");
  const search = h("input") as HTMLInputElement;
  search.type = "text";
  search.placeholder = "Filter by host, event, URL…";
  search.addEventListener("input", () => { filter = search.value.toLowerCase(); paint(); });
  const unparsedBox = h("input") as HTMLInputElement;
  unparsedBox.type = "checkbox";
  unparsedBox.className = "switch";
  unparsedBox.addEventListener("change", () => { onlyUnparsed = unparsedBox.checked; paint(); });
  const toolbar = h("div", "row", search, h("label", "row muted nowrap", unparsedBox, "Not parsed only"));
  const body = h("div", "card table-card scroll");
  root.replaceChildren(h("div", "stack", summary, note, pickers, tabs, toolbar, body));

  async function load() {
    session = await resolveSession();
    if (session) {
      [events, requests] = await Promise.all([
        send<StoredEvent[]>({ type: "getEvents", sessionId: session.id }),
        send<RequestRow[]>({ type: "getRequests", sessionId: session.id }),
      ]);
    } else { events = []; requests = []; }
    paint();
    // keep polling only while a recording is running
    window.clearTimeout(timer);
    if (session?.status === "recording") timer = window.setTimeout(() => void load(), 1000);
  }

  function paint() {
    opts.onSession?.(session);
    const rec = session?.status === "recording";
    const unparsed = requests.filter((r) => r.vendor === "unrecognized").length;
    const un = session?.unattributed;
    note.replaceChildren(...(un?.count ? [h("div", "note warn", `${un.count} GA4/Ads hit(s) came from a service worker or another browsing context and could not be tied to this tab, so they are not counted. Initiator(s): ${un.initiators.join(", ")}.`)] : []));
    summary.replaceChildren(
      session ? h("strong", "", siteLabel(session)) : h("span"),
      session ? h("span", "muted", `${fmtWhen(session.startedAt)} · ${fmtDuration(session)}`) : h("span"),
      h("span", `chip ${rec ? "missing" : ""}`.trim(), rec ? "● recording" : session ? "stopped" : "no session"),
      (session?.tabIds?.length ?? 0) > 1 ? chip(`${session!.tabIds!.length} tabs`, "accent") : h("span"),
      chip(`${selectedEventCount(session ?? { eventCount: 0 })} events`, "accent"), chip(`${requests.length} tag requests`), unparsed ? chip(`${unparsed} not parsed`, "partial") : h("span"));
    if (session) {
      const sel = sessionVendors(session);
      const counts: Record<string, number> = {};
      for (const e of events) counts[e.vendor] = (counts[e.vendor] ?? 0) + 1;
      pickers.replaceChildren(vendorPicker(sel, counts, async (next) => {
        await saveVendors(next, { sessionId: session!.id });
        await load();
      }, "Audit"));
    } else pickers.replaceChildren();

    const mk = (id: "tags" | "events", label: string) => {
      const b = h("button", `seg-btn ${tab === id ? "on" : ""}`.trim(), label);
      b.addEventListener("click", () => { tab = id; paint(); });
      return b;
    };
    tabs.replaceChildren(mk("tags", `Tags · ${requests.length}`), mk("events", `Events · ${session ? selectedEventCount(session) : 0}`));
    unparsedBox.parentElement!.classList.toggle("hide", tab !== "tags");

    const match = (...parts: (string | undefined)[]) => !filter || parts.some((p) => (p ?? "").toLowerCase().includes(filter));
    if (tab === "tags") {
      const sel = session ? sessionVendors(session) : [];
      const rows = requests.filter((r) => (!onlyUnparsed || r.vendor === "unrecognized") && match(r.url, r.vendor, r.host, r.body));
      body.replaceChildren(rows.length
        ? h("table", "", h("thead", "", h("tr", "", ...["Time", "Request", "Status"].map((t) => h("th", "", t)))), h("tbody", "", ...rows.flatMap((r) => tagRow(r, sel))))
        : empty(rec, requests.length > 0));
    } else {
      const sel = session ? sessionVendors(session) : [];
      const rows = events.filter((e) => sel.includes(e.vendor) && match(e.event, e.vendor, e.property, e.page.path));
      body.replaceChildren(rows.length
        ? h("table", "", h("thead", "", h("tr", "", ...["Time", "Event", "Status"].map((t) => h("th", "", t)))), h("tbody", "", ...rows.flatMap(eventRow)))
        : empty(rec, events.length > 0));
    }
    if (opts.exportable && !root.querySelector("#export-log")) {
      const b = h("button", "btn secondary sm nowrap", "Export JSON");
      b.id = "export-log";
      b.addEventListener("click", () => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify({ session, events, requests }, null, 2)], { type: "application/json" }));
        a.download = `${session?.id ?? "session"}.json`;
        a.click();
      });
      toolbar.append(b);
    }
  }

  function empty(recording: boolean, filteredOut: boolean): HTMLElement {
    if (filteredOut) return h("div", "empty", "Nothing matches the filter.");
    if (!session) return h("div", "empty", "No session yet. Press Start recording in the IntelliTrack popup.");
    return h("div", "empty", recording
      ? "Listening… no tag requests yet. Browse the page. If the site shows a cookie banner, accept it: many shops only fire analytics after consent."
      : "No tag requests were captured in this session.");
  }

  // follow live updates only when showing the session that is being recorded
  chrome.storage.session.onChanged.addListener((c) => { if (c.session && (!session || session.status === "recording" || (c.session.newValue as SessionMeta | undefined)?.id === session.id)) void load(); });
  void guardWorker(root).then((stale) => { if (!stale) void load(); });
}
