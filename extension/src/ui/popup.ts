import { liveChecklist } from "../planner/plan";
import { loadConfig, validateConfig } from "../llm/config";
import { guardWorker, pageUrl } from "./session";
import { showVersion } from "./version";

showVersion(document.getElementById("version"));
import { saveVendors, vendorPicker } from "./vendorPicker";
import { DEFAULT_VENDORS, selectedEventCount, sessionVendors } from "../shared/vendors";
import type { PlanResult } from "../background/planner";
import type { StoredEvent } from "../background/store";
import type { CoverageEntry, Message, SessionMeta } from "../shared/types";
import { contextLabel } from "../shared/siteContext";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(m: Message): Promise<T> => chrome.runtime.sendMessage(m);
const openSettings = () => void chrome.runtime.openOptionsPage();

type El = HTMLElement;
function h(tag: string, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...kids: (string | El)[]): El {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (typeof v === "boolean") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids);
  return el;
}
const btn = (label: string, cls: string, onclick: () => void | Promise<void>) => h("button", { class: `btn ${cls}`, onclick: () => void onclick() }, label);

let session: SessionMeta | undefined;
let activeTabId: number | undefined;
let events: StoredEvent[] = [];
/** transient planner UI state: consent prompt, confirm prompt, manual picker or an error */
let planUi: PlanResult | undefined;
let planning = false;
/** the default choice for the next session, shown while nothing is recording */
let defaultVendors: string[] = DEFAULT_VENDORS;

// ---------------------------------------------------------------- planning
async function requestPlan(confirmed = false) {
  planning = true;
  planUi = undefined;
  renderPlan();
  try {
    planUi = await send<PlanResult>({ type: "plan", confirmed });
  } catch (e) {
    planUi = { status: "error", kind: "unknown", message: e instanceof Error ? e.message : String(e) };
  }
  planning = false;
  await refresh();
}

const MANUAL: PlanResult = { status: "manual", reason: "never", message: "Pick the site type to audit against." };

function manualPicker(): El {
  const sel = h("select", {}) as HTMLSelectElement;
  for (const [v, l] of [["ecommerce", "E-commerce"], ["lead_generation", "Lead generation"], ["content", "Content / publisher"], ["other", "Other"]]) {
    sel.append(h("option", { value: v }, l));
  }
  return h("div", { class: "row" }, sel, btn("Use", "secondary", async () => {
    await send({ type: "manualPlan", siteType: sel.value as "ecommerce" });
    planUi = undefined;
    await refresh();
  }));
}

const card = (...kids: (string | El)[]) => h("div", { class: "card stack" }, ...kids);

function renderPrompt(): El | undefined {
  if (planning) return card(h("div", { class: "row" }, h("span", { class: "dot rec" }), h("span", { class: "muted" }, "Asking your LLM for a journey plan…")));
  const r = planUi;
  if (!r || r.status === "ok") return undefined;

  if (r.status === "needs_consent") {
    const choose = (value: "always" | "ask" | "never") => async () => {
      await send({ type: "setConsent", origin: r.origin, value });
      if (value === "never") { planUi = MANUAL; await refresh(); } else await requestPlan(false);
    };
    return card(
      h("h3", {}, `Share page info from ${new URL(r.origin).host}?`),
      h("p", { class: "muted" }, "Only the page's structure goes to your LLM: title, headings, nav labels, form field types. No form values, no URL query."),
      h("div", { class: "row wrap" }, btn("Always", "primary sm", choose("always")), btn("Ask each time", "secondary sm", choose("ask")), btn("Never", "ghost sm", choose("never"))));
  }
  if (r.status === "needs_confirm") {
    return card(
      h("h3", {}, `Send this to ${new URL(r.destination).host}?`),
      h("pre", { class: "json" }, JSON.stringify(r.context, null, 2)),
      h("div", { class: "row" }, btn("Send", "primary sm", () => requestPlan(true)), btn("Don't send", "ghost sm", () => { planUi = MANUAL; renderPlan(); }), h("span", { class: "spacer" }), h("span", { class: "chip mono" }, `${r.provider} · ${r.model}`)));
  }
  if (r.status === "manual") {
    return card(
      h("p", { class: r.reason === "no_config" ? "" : "muted" }, r.message),
      r.reason === "no_config" ? btn("Set up your LLM", "secondary sm", openSettings) : h("span", {}),
      manualPicker());
  }
  return card(h("div", { class: "note err" }, r.message), h("p", { class: "muted" }, "You can pick the site type yourself instead."), manualPicker());
}

// ---------------------------------------------------------------- plan view
const stateClass = (s: CoverageEntry["status"]) => (s === "matched" ? "done" : s === "partial" ? "partial" : "");

function renderPlan() {
  const root = $("plan");
  const rec = session?.status === "recording";
  const prompt = renderPrompt();
  const plan = session?.plan;
  const kids: El[] = [];
  if (prompt) kids.push(prompt);

  if (plan && session) {
    const sel = session.selection ?? { journeys: plan.journeys.map((j) => j.id), excluded_steps: [] };
    const live = liveChecklist(plan, events);
    const src = session.plan_meta?.source === "llm" ? `${session.plan_meta.provider} · ${session.plan_meta.model}` : "chosen by you";
    const save = async (journeys: string[], excluded: string[]) => {
      await send({ type: "setSelection", journeys, excludedSteps: excluded });
      await refresh();
    };

    const body: El[] = [
      h("div", { class: "plan-head" },
        h("h2", {}, "Journey plan"), h("span", { class: "spacer" }),
        h("span", { class: "chip accent" }, `${plan.site_type.replace("_", " ")} · ${Math.round((plan.confidence ?? 1) * 100)}%`)),
    ];
    if (plan.rationale) body.push(h("p", { class: "muted" }, plan.rationale));

    for (const j of plan.journeys) {
      const jOn = sel.journeys.includes(j.id);
      const j$ = h("div", { class: "journey" },
        h("div", { class: "journey-head" }, h("span", {}, j.name), h("span", { class: "spacer" }),
          h("input", { type: "checkbox", class: "switch", checked: jOn, title: "Include this journey",
            onchange: (e) => void save((e.target as HTMLInputElement).checked ? [...sel.journeys, j.id] : sel.journeys.filter((x) => x !== j.id), sel.excluded_steps) })));
      for (const s of j.steps) {
        const on = jOn && !sel.excluded_steps.includes(s.id);
        const c = live.find((x) => x.step === s.id);
        j$.append(h("div", { class: `step ${on ? "" : "off"}` },
          h("span", { class: `state ${on ? stateClass(c?.status ?? "missing") : ""}` }),
          h("div", {}, h("div", { class: "name" }, s.name),
            h("div", { class: "evs" }, ...s.expect.map((x) => h("span", { class: "chip mono" }, x.event)))),
          h("div", { class: "actions" },
            rec && on ? btn("Mark", "ghost sm", async () => { await send({ type: "marker", name: s.name, stepId: s.id }); await refresh(); }) : h("span", {}),
            h("input", { type: "checkbox", class: "switch", checked: !sel.excluded_steps.includes(s.id), disabled: !jOn, title: "Include this step",
              onchange: (e) => void save(sel.journeys, (e.target as HTMLInputElement).checked ? sel.excluded_steps.filter((x) => x !== s.id) : [...sel.excluded_steps, s.id]) }))));
      }
      body.push(j$);
    }
    body.push(h("div", { class: "row" },
      rec ? btn("Re-plan", "ghost sm", () => requestPlan(false)) : h("span", {}),
      h("span", { class: "spacer" }), h("span", { class: "hint" }, src)));
    kids.push(h("section", { class: "card stack" }, ...body));
  } else if (rec && !prompt) {
    kids.push(card(
      h("p", { class: "muted" }, "Tell IntelliTrack what journey to expect on this site."),
      h("div", { class: "row" }, btn("Plan with LLM", "secondary sm", () => requestPlan(false)), btn("Pick site type", "ghost sm", () => { planUi = MANUAL; renderPlan(); }))));
  }
  root.replaceChildren(...kids);
}

// ---------------------------------------------------------------- shell
function render() {
  const rec = session?.status === "recording";
  $("status").textContent = rec ? "Recording" : session ? "Stopped" : "Ready";
  $("dot").className = `dot ${rec ? "rec" : session ? "done" : ""}`;
  $("count").textContent = String(session ? selectedEventCount(session) : 0);
  const where = contextLabel(session?.site_context?.pages, activeTabId);
  $("site-context").textContent = where ?? "";
  $("site-context").classList.toggle("hide", !where);
  const chosen = session ? sessionVendors(session) : defaultVendors;
  $("vendors").replaceChildren(vendorPicker(chosen, session?.vendor_counts, async (next) => {
    await saveVendors(next, { sessionId: session?.id, asDefault: true });
    defaultVendors = next;
    await refresh();
  }, "Audit"));
  const t = $<HTMLButtonElement>("toggle");
  t.textContent = rec ? "Stop recording" : "Start recording";
  t.className = `btn block ${rec ? "secondary" : "primary"}`;
  $<HTMLButtonElement>("preview").disabled = !session;
  $("clear").classList.toggle("hide", !(session && !rec));
  // free-text markers only when there is no plan to mark steps from
  $("free-marker").classList.toggle("hide", !(rec && !session?.plan));
  $("markers").replaceChildren(...(session?.markers ?? []).map((m) => h("span", { class: "chip" }, `${m.id} · ${m.name}`)));
  renderPlan();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    try { const r = await chrome.storage.local.get("default_vendors"); if (Array.isArray(r.default_vendors)) defaultVendors = r.default_vendors; } catch { /* ignore */ }
    session = await send<SessionMeta | undefined>({ type: "getState" });
    try { activeTabId = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id; } catch { /* no tabs API */ }
    events = session?.plan ? await send<StoredEvent[]>({ type: "getEvents", sessionId: session.id }) : [];
  } finally {
    refreshing = false;
  }
  render();
}

async function showLlmStatus() {
  const el = $("llm-status");
  try {
    const c = await loadConfig();
    if (c && validateConfig(c).length === 0) {
      el.replaceChildren(h("span", {}, `${c.provider} · ${c.model}`), h("span", { class: "spacer" }), h("button", { onclick: openSettings }, "Change"));
      return;
    }
  } catch { /* storage unavailable */ }
  el.replaceChildren(h("span", {}, "No LLM yet · rules-only audit works"), h("span", { class: "spacer" }), h("button", { onclick: openSettings }, "Set up →"));
}

$("toggle").addEventListener("click", async () => {
  const s = await send<SessionMeta | undefined>({ type: "getState" });
  if (s?.status === "recording") {
    await send({ type: "stop" });
    planUi = undefined;
    await refresh();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  void openPanel(tab.windowId); // needs the click's user gesture, so before any slow await
  planUi = undefined;
  await send({ type: "start", tabId: tab.id });
  await refresh();
  await requestPlan(false);
});
$("marker").addEventListener("click", async () => {
  const input = $<HTMLInputElement>("marker-name");
  await send({ type: "marker", name: input.value.trim() || "Step" });
  input.value = "";
  await refresh();
});
/** The popup closes as soon as you click the page; the side panel stays open and updates live. */
async function openPanel(windowId?: number) {
  try {
    const id = windowId ?? (await chrome.windows.getCurrent()).id;
    if (id !== undefined) await chrome.sidePanel.open({ windowId: id });
  } catch { /* side panel unavailable: the session log page still works */ }
}
$("panel").addEventListener("click", () => void openPanel());
$("settings").addEventListener("click", openSettings);
$("clear").addEventListener("click", async () => { await send({ type: "clear" }); planUi = undefined; await refresh(); });
$("history").addEventListener("click", () => void chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") }));
$("preview").addEventListener("click", () => void chrome.tabs.create({ url: pageUrl("preview.html", session?.id) }));

// live count + live checklist: session state is mirrored in storage.session on every captured batch
chrome.storage.session.onChanged.addListener((c) => { if (c.session) void refresh(); });

void showLlmStatus();
void guardWorker(document.querySelector(".wrap")!, "prepend").then((stale) => { if (!stale) void refresh(); });
