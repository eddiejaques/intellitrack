import type { SessionSummary } from "../shared/types";
import { fmtDuration, fmtWhen, pageUrl, send, siteLabel } from "./session";

type K = string | HTMLElement;
function h(tag: string, cls = "", ...kids: K[]): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...kids);
  return el;
}
const chip = (t: string, cls = "") => h("span", `chip ${cls}`.trim(), t);
const link = (label: string, page: string, id: string, cls = "btn ghost sm") => {
  const a = h("a", cls, label) as HTMLAnchorElement;
  a.href = pageUrl(page, id);
  return a;
};

let all: SessionSummary[] = [];
let filter = "";
let timer: number | undefined;

function scoreEl(r: SessionSummary["report"]): HTMLElement {
  if (!r) return h("span", "score none", "no audit");
  if (r.inconclusive) return h("span", "score none", "inconclusive");
  return h("span", `score ${r.score >= 85 ? "good" : r.score >= 60 ? "mid" : "bad"}`, String(r.score));
}

function sessionRow(x: SessionSummary): HTMLElement {
  const s = x.session;
  const rec = s.status === "recording";
  const del = h("button", "btn ghost sm", "Delete");
  del.addEventListener("click", async () => {
    if (!confirm(`Delete this session from ${siteLabel(s)}? Its tags, plan and report are removed.`)) return;
    await send({ type: "deleteSession", sessionId: s.id });
    await load();
  });
  return h("article", "sess",
    h("span", `dot ${rec ? "rec" : "done"}`),
    h("div", "",
      h("div", "row wrap", h("span", "when", fmtWhen(s.startedAt)), h("span", "muted", `· ${rec ? "recording" : fmtDuration(s)}`), s.plan ? chip(s.plan.site_type.replace("_", " "), "accent") : h("span")),
      h("div", "meta", chip(`${s.eventCount} events`, s.eventCount ? "accent" : "missing"), chip(`${s.request_count ?? 0} tag requests`),
        (s.unrecognized_count ?? 0) ? chip(`${s.unrecognized_count} not parsed`, "partial") : h("span"),
        s.site?.title ? h("span", "muted", s.site.title) : h("span"))),
    h("div", "side", scoreEl(x.report),
      link("Log", "viewer.html", s.id),
      link(x.report ? "Report" : "Audit", x.report ? "report.html" : "preview.html", s.id, "btn secondary sm"),
      x.report ? link("Re-audit", "preview.html", s.id) : h("span"),
      del));
}

function paint() {
  const list = document.getElementById("list")!;
  const rows = all.filter((x) => !filter || siteLabel(x.session).toLowerCase().includes(filter));
  if (!rows.length) {
    list.replaceChildren(h("div", "card flat muted", all.length ? "No sessions match." : "No sessions yet. Open IntelliTrack on a page and press Start recording."));
    return;
  }
  const groups = new Map<string, SessionSummary[]>();
  for (const x of rows) groups.set(siteLabel(x.session), [...(groups.get(siteLabel(x.session)) ?? []), x]);
  list.replaceChildren(...[...groups].map(([site, items]) =>
    h("section", "group", h("div", "group-head", h("span", "site", site), chip(`${items.length} session${items.length > 1 ? "s" : ""}`)), ...items.map(sessionRow))));
}

async function load() {
  all = await send<SessionSummary[]>({ type: "listSessions" });
  paint();
  window.clearTimeout(timer);
  if (all.some((x) => x.session.status === "recording")) timer = window.setTimeout(() => void load(), 2000);
}

document.getElementById("filter")!.addEventListener("input", (e) => { filter = (e.target as HTMLInputElement).value.toLowerCase(); paint(); });
void load();
