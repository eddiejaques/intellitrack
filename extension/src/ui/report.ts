import { reportToMarkdown } from "../background/markdown";
import type { AuditReport, Finding, Message } from "../shared/types";
import { fmtDuration, fmtWhen, guardWorker, pageUrl, resolveSession, siteLabel } from "./session";

const send = <T>(m: Message): Promise<T> => chrome.runtime.sendMessage(m);

function h(tag: string, cls = "", ...kids: (string | HTMLElement | SVGElement)[]): HTMLElement {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.append(...kids);
  return el;
}
const chip = (t: string, cls = "") => h("span", `chip ${cls}`.trim(), t);

function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
}

function ring(score: number): HTMLElement {
  const R = 40, C = 2 * Math.PI * R;
  const color = score >= 85 ? "var(--ok)" : score >= 60 ? "var(--sev-medium)" : "var(--sev-critical)";
  const wrap = h("div", "ring");
  wrap.innerHTML = `<svg viewBox="0 0 96 96" aria-hidden="true"><circle class="track" cx="48" cy="48" r="${R}" fill="none" stroke-width="8"/><circle class="bar" cx="48" cy="48" r="${R}" fill="none" stroke-width="8" stroke="${color}" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - score / 100)}"/></svg>`;
  const num = h("div", "num");
  num.append(h("span", "", String(score)));
  wrap.append(num);
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `Score ${score} out of 100`);
  return wrap;
}

function findingEl(f: Finding): HTMLElement {
  return h("article", `finding ${f.severity}`,
    h("div", "f-head", h("span", `badge ${f.source === "llm" ? "llm" : ""}`.trim(), f.source === "llm" ? "LLM" : "rule"), h("span", "f-title", f.title)),
    h("div", "", f.detail),
    h("div", "f-fix", h("b", "", "Fix: "), f.recommendation),
    f.evidence.length ? h("div", "f-ev", ...f.evidence.map((e) => chip(e, "mono"))) : h("span"),
    f.review ? h("div", "f-review", `LLM review · ${f.review.verdict}: ${f.review.explanation}`) : h("span"));
}

function inconclusiveView(r: AuditReport, sid: string): HTMLElement[] {
  const d = r.diagnostics;
  const steps: string[] = [];
  if (d && d.tag_requests === 0) steps.push("No tag requests were seen at all. Make sure you pressed Start before loading or interacting with the page, and that an ad blocker is not stopping analytics.");
  if (d?.unattributed) steps.push(`${d.unattributed} GA4/Ads hit(s) came from a service worker or another browsing context and could not be tied to this tab. Open the session log to see which contexts sent them.`);
  if (d && d.not_parsed > 0) steps.push(`${d.not_parsed} tag request(s) were logged but IntelliTrack can't parse them yet. Open the session log and expand them: they may be a vendor that isn't supported, or GA4 sent in an unusual way.`);
  steps.push("Many European sites fire analytics only after cookie consent. Accept the banner, then keep browsing.");
  steps.push("Interact with the page (open a product, add to cart). A single page load may send nothing you can see.");
  const logLink = h("a", "btn secondary sm", "Open session log") as HTMLAnchorElement;
  logLink.href = pageUrl("viewer.html", sid);
  return [
    h("div", "card hero-report", h("div", "ring", h("div", "num", h("span", "muted", "–"))),
      h("div", "stack", h("div", "headline", "Nothing was captured, so there is nothing to audit yet."),
        h("div", "row wrap", chip(new Date(r.created_at).toLocaleString()), chip(sid, "mono")))),
    h("section", "card stack", h("h2", "", "What to check"), h("ol", "muted", ...steps.map((t) => h("li", "", t))),
      d ? h("div", "row wrap", chip(`${d.tag_requests} tag requests`), chip(`${d.not_parsed} not parsed`), d.duration_s ? chip(`${d.duration_s}s recorded`) : h("span")) : h("span"), logLink),
  ];
}

function render(r: AuditReport) {
  const root = document.getElementById("root")!;
  root.className = "";
  if (r.inconclusive) {
    root.replaceChildren(...inconclusiveView(r, r.session_id).map((k) => { k.style.marginTop = "16px"; return k; }));
    return;
  }
  const kids: HTMLElement[] = [];

  kids.push(h("div", "card hero-report",
    ring(r.score),
    h("div", "stack", h("div", "headline", r.headline),
      h("div", "row wrap", chip(new Date(r.created_at).toLocaleString()), chip(r.session_id, "mono")))));

  if (r.llm.status === "failed") kids.push(h("div", "note warn", `LLM review failed: ${r.llm.error ?? "unknown error"}. Showing rule findings only.`));
  else if (r.llm.status === "skipped") kids.push(h("div", "note info", "Rule-based audit. Nothing was sent to an LLM."));
  else kids.push(h("div", "note info", `Reviewed by ${r.llm.provider} · ${r.llm.model} (${r.llm.prompt_version}${r.llm.attempts === 2 ? ", one retry" : ""}).`));
  if (r.llm.dropped_findings) {
    const d = h("details", "disclosure", h("summary", "", `${r.llm.dropped_findings} LLM finding(s) discarded`), h("ul", "muted", ...r.llm.dropped_reasons.map((x) => h("li", "", x))));
    kids.push(d);
  }

  const actions = h("div", "row", h("button", "btn secondary", "Export Markdown"), h("button", "btn secondary", "Export JSON"));
  (actions.children[0] as HTMLElement).id = "md";
  (actions.children[1] as HTMLElement).id = "json";
  kids.push(actions);

  if (r.plan) {
    kids.push(h("section", "stack", h("h2", "", "Measured against this plan"),
      h("div", "card flat", h("div", "row wrap", chip(r.plan.site_type.replace("_", " "), "accent"), h("span", "muted", r.plan.rationale ?? "")))));
  }
  if (r.journey_coverage.length) {
    const tb = h("tbody");
    for (const c of r.journey_coverage) {
      tb.append(h("tr", "", h("td", "", `${c.step} ${c.step_name}`), h("td", "", ...c.expected.map((x) => chip(x, "mono"))),
        h("td", "", ...(c.observed.length ? c.observed.map((x) => chip(x, "mono")) : ["–"])), h("td", "", chip(c.status.replace("_", " "), c.status))));
    }
    const table = h("table", "", h("thead", "", h("tr", "", ...["Step", "Expected", "Observed", "Status"].map((t) => h("th", "", t)))), tb);
    kids.push(h("section", "stack", h("h2", "", "Journey coverage"), h("div", "card table-card", table)));
  }

  const body = h("section", "", h("h2", "", `Findings · ${r.findings.length}`));
  if (!r.findings.length) body.append(h("div", "note ok", "No findings. Tracking matches the plan."));
  for (const sev of ["critical", "high", "medium", "low", "info"]) {
    const fs = r.findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    body.append(h("div", "group-title", h("span", `badge ${sev}`, sev), h("span", "count", String(fs.length))), h("div", "cards", ...fs.map(findingEl)));
  }
  kids.push(body);

  root.replaceChildren(...kids.map((k) => { k.style.marginTop = k.tagName === "SECTION" ? "" : "16px"; return k; }));
  document.getElementById("md")!.addEventListener("click", () => download(`${r.session_id}-audit.md`, reportToMarkdown(r), "text/markdown"));
  document.getElementById("json")!.addEventListener("click", () => download(`${r.session_id}-audit.json`, JSON.stringify(r, null, 2), "application/json"));
}

async function main() {
  if (await guardWorker(document.getElementById("root")!)) return;
  const s = await resolveSession();
  if (s) document.getElementById("who")!.replaceChildren(`${siteLabel(s)} · ${fmtWhen(s.startedAt)} · ${fmtDuration(s)}`);
  const r = s ? await send<AuditReport | undefined>({ type: "getReport", sessionId: s.id }) : undefined;
  if (!r || !s) {
    const root = document.getElementById("root")!;
    root.replaceChildren(h("div", "card stack", h("p", "muted", s ? "This session has no report yet." : "No session found."),
      s ? Object.assign(h("a", "btn primary sm", "Preview & audit this session"), { href: pageUrl("preview.html", s.id) }) : h("span")));
    return;
  }
  render(r);
}
void main();
