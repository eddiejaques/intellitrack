import { decodeRawBody } from "./body";
import {
  addMarker,
  clearSession,
  restoreBadge,
  handleCompleted,
  handleError,
  handleRequest,
  loadSession,
  mightBeTracking,
  noteTabUrl,
  startSession,
  stopSession,
  updateSession,
} from "./capture";
import { getEvents, getReport, putReport } from "./store";
import { createProvider, testConnection } from "../llm";
import { loadConfig } from "../llm/config";
import { getConsent, setConsent } from "../llm/consent";
import { extractPageContext } from "../content/pageContext";
import { runAudit } from "./audit";
import { applyTemplate, runPlanner, type PlannerDeps } from "./planner";
import type { Message, RawRequest } from "../shared/types";

const plannerDeps: PlannerDeps = {
  loadSession,
  updateSession,
  loadConfig,
  getConsent,
  async extractContext(tabId) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: extractPageContext });
    if (!r?.result) throw new Error("no result from page");
    return r.result;
  },
  async detectedVendors(sessionId) {
    const seen = new Map<string, { vendor: string; property: string }>();
    for (const e of await getEvents(sessionId)) if (e.property) seen.set(`${e.vendor}|${e.property}`, { vendor: e.vendor, property: e.property });
    return [...seen.values()];
  },
  provider: (cfg) => createProvider(cfg),
  now: () => Date.now(),
};

// The worker may have been suspended: rebuild the badge from persisted state on every wake.
void restoreBadge();
chrome.runtime.onStartup.addListener(() => void restoreBadge());

// Listeners must be registered at the top level so events wake the service worker.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (!mightBeTracking(d.url)) return;
    const req: RawRequest = {
      requestId: d.requestId,
      url: d.url,
      method: d.method,
      tabId: d.tabId,
      initiator: d.initiator,
      type: d.type,
      timeStamp: d.timeStamp,
      body: decodeRawBody(d.requestBody?.raw as { bytes?: ArrayBuffer }[] | undefined),
    };
    void handleRequest(req);
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (mightBeTracking(d.url)) void handleCompleted(d.requestId, d.tabId, d.statusCode, d.initiator);
  },
  { urls: ["<all_urls>"] },
);

chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (mightBeTracking(d.url)) void handleError(d.requestId, d.tabId, d.error, d.initiator);
  },
  { urls: ["<all_urls>"] },
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) void noteTabUrl(tabId, info.url);
  // per-tab badge text can be reset by navigation; put it back
  if (info.status === "loading" || info.status === "complete") void restoreBadge();
});

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "start":
        return startSession(msg.tabId);
      case "stop":
        return stopSession();
      case "clear":
        return clearSession();
      case "marker":
        return addMarker(msg.name, msg.stepId);
      case "plan":
        return runPlanner(plannerDeps, { confirmed: msg.confirmed });
      case "manualPlan":
        return applyTemplate(plannerDeps, msg.siteType);
      case "setSelection":
        return updateSession((s) => { s.selection = { journeys: msg.journeys, excluded_steps: msg.excludedSteps }; return true; });
      case "setConsent":
        return setConsent(msg.origin, msg.value);
      case "audit": {
        const s = await loadSession();
        if (!s) throw new Error("No session");
        const report = await runAudit({ loadConfig, provider: (c) => createProvider(c), now: () => Date.now() }, s.id, msg.payload, msg.useLLM);
        await putReport(report);
        return report;
      }
      case "getReport":
        return getReport(msg.sessionId);
      case "getState":
        return loadSession();
      case "getEvents":
        return getEvents(msg.sessionId);
      case "testConnection":
        return testConnection(msg.config);
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true; // async response
});
