import { buildPayload, findRawPii } from "../minimize";
import { loadConfig, validateConfig } from "../llm/config";
import { sessionPlan } from "../planner/plan";
import type { StoredEvent } from "../background/store";
import type { AuditReport, JourneyPlan, Message, Payload, SessionMeta } from "../shared/types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(m: Message): Promise<T> => chrome.runtime.sendMessage(m);

let session: SessionMeta | undefined;
let events: StoredEvent[] = [];
let payload: Payload | undefined;

function el(tag: string, cls = "", ...kids: (string | HTMLElement)[]): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...kids);
  return e;
}
const td = (...k: (string | HTMLElement)[]) => el("td", "", ...k);

function parsePlan(text: string): JourneyPlan | undefined | Error {
  if (!text.trim()) return undefined;
  try {
    const p = JSON.parse(text) as JourneyPlan;
    if (!p || !Array.isArray(p.journeys)) throw new Error("plan needs a journeys array");
    return p;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

function render(plan?: JourneyPlan) {
  if (!session) return;
  payload = buildPayload({ session, events, plan });
  $("fcount").textContent = `· ${payload.rule_findings.length}`;
  $("findings").replaceChildren(
    ...(payload.rule_findings.length
      ? payload.rule_findings.map((f) =>
          el("article", `finding ${f.severity}`,
            el("div", "f-head", el("span", `badge ${f.severity}`, f.severity), el("span", "f-title", f.title), el("span", "chip", f.category)),
            el("div", "", f.detail),
            el("div", "f-fix", el("b", "", "Fix: "), f.recommendation),
            f.evidence.length ? el("div", "f-ev", ...f.evidence.map((id) => el("span", "chip mono", id))) : el("span")))
      : [el("div", "card flat muted", "No findings from the rule engine.")]),
  );
  $("coverage").replaceChildren(
    ...(payload.journey_coverage.length
      ? payload.journey_coverage.map((c) =>
          el("tr", "", td(`${c.step} ${c.step_name}`), td(...c.expected.map((x) => el("span", "chip mono", x))), td(...(c.observed.length ? c.observed.map((x) => el("span", "chip mono", x)) : ["–"])), td(el("span", `chip ${c.status}`, c.status.replace("_", " ")))))
      : [el("tr", "", el("td", "muted", "No plan applied yet."))]),
  );
  const leaks = findRawPii(payload);
  const note = $("privacy");
  note.className = `note ${leaks.length ? "err" : "ok"}`;
  note.textContent = leaks.length ? `Possible raw personal data in the payload: ${leaks.join("; ")}` : "Privacy check passed: no raw personal data in the payload.";
  const json = JSON.stringify(payload, null, 2);
  $("payload").textContent = json;
  $("psize").textContent = `· ${(json.length / 1024).toFixed(1)} KB, ~${Math.round(json.length / 4)} tokens`;
  $<HTMLButtonElement>("send").disabled = leaks.length > 0 || !configOk;
}

let configOk = false;
async function showDestination() {
  let text = "No LLM configured: open Settings to add one. You can still run a rules-only report.";
  try {
    const c = await loadConfig();
    if (c && validateConfig(c).length === 0) {
      configOk = true;
      text = `Will send the payload below to ${new URL(c.base_url).origin} (${c.provider}, model ${c.model}). Nothing else leaves your browser.`;
    }
  } catch { /* storage unavailable */ }
  $("dest").textContent = text;
  if (payload) $<HTMLButtonElement>("send").disabled = findRawPii(payload).length > 0 || !configOk;
}

async function run(useLLM: boolean) {
  if (!payload) return;
  $<HTMLButtonElement>("send").disabled = true;
  $<HTMLButtonElement>("rules-only").disabled = true;
  $("run-msg").textContent = useLLM ? "Waiting for your LLM…" : "Building report…";
  try {
    // The payload object that was previewed is the one sent: nothing is rebuilt in between.
    const r = (await chrome.runtime.sendMessage({ type: "audit", payload, useLLM } satisfies Message)) as AuditReport | { error: string };
    if ("error" in r) throw new Error(r.error);
    location.href = chrome.runtime.getURL("report.html");
  } catch (e) {
    $("run-msg").textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    $<HTMLButtonElement>("rules-only").disabled = false;
    $<HTMLButtonElement>("send").disabled = !configOk;
  }
}
$("send").addEventListener("click", () => void run(true));
$("rules-only").addEventListener("click", () => void run(false));

async function main() {
  session = await send<SessionMeta | undefined>({ type: "getState" });
  if (!session) {
    $("payload").textContent = "No session recorded yet.";
    return;
  }
  events = await send<StoredEvent[]>({ type: "getEvents", sessionId: session.id });
  const plan = sessionPlan(session);
  if (plan) $<HTMLTextAreaElement>("plan").value = JSON.stringify(plan, null, 2);
  render(plan);
  await showDestination();
}

$("apply").addEventListener("click", async () => {
  const text = $<HTMLTextAreaElement>("plan").value;
  const parsed = parsePlan(text);
  if (parsed instanceof Error) {
    $("plan-msg").textContent = `Invalid plan: ${parsed.message}`;
    return;
  }
  $("plan-msg").textContent = parsed ? "Plan applied." : "No plan: universal rules only.";
  render(parsed);
});

$("export").addEventListener("click", () => {
  if (!payload) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  a.download = `${session?.id ?? "session"}-payload.json`;
  a.click();
});

void main();
