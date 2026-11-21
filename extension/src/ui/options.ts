import { PROVIDERS, defaultConfig, ensureHostPermission, loadConfig, saveConfig, validateConfig } from "../llm/config";
import type { LLMConfig, ProviderId } from "../llm/types";
import type { Message } from "../shared/types";
import type { TestResult } from "../llm";
import { showVersion } from "./version";

showVersion(document.getElementById("version"));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

function show(text: string, cls: "ok" | "err" | "muted") {
  const el = $("msg");
  el.className = cls === "muted" ? "muted" : `note ${cls}`;
  el.textContent = text;
}

function fill(c: LLMConfig) {
  $<HTMLSelectElement>("provider").value = c.provider;
  input("base_url").value = c.base_url;
  input("model").value = c.model;
  input("api_key").value = c.api_key;
  input("max_output_tokens").value = String(c.max_output_tokens);
  input("timeout_s").value = String(c.timeout_s);
  input("max_per_session").value = String(c.plan_call_budget.max_per_session);
  input("min_interval_s").value = String(c.plan_call_budget.min_interval_s);
  $("model-hint").textContent = `Use ${PROVIDERS.find((p) => p.id === c.provider)!.model_hint}.`;
}

function read(): LLMConfig {
  return {
    provider: $<HTMLSelectElement>("provider").value as ProviderId,
    base_url: input("base_url").value.trim(),
    model: input("model").value.trim(),
    api_key: input("api_key").value.trim(),
    max_output_tokens: Number(input("max_output_tokens").value),
    timeout_s: Number(input("timeout_s").value),
    plan_call_budget: { max_per_session: Number(input("max_per_session").value), min_interval_s: Number(input("min_interval_s").value) },
  };
}

async function init() {
  $<HTMLSelectElement>("provider").replaceChildren(
    ...PROVIDERS.map((p) => Object.assign(document.createElement("option"), { value: p.id, textContent: p.label })),
  );
  let current = defaultConfig();
  try { current = (await loadConfig()) ?? current; } catch { /* storage unavailable */ }
  fill(current);

  $<HTMLSelectElement>("provider").addEventListener("change", () => {
    const prev = read();
    const next = defaultConfig(prev.provider);
    // Keep what the user typed; only swap values that are still another provider's defaults.
    const wasDefaultUrl = PROVIDERS.some((p) => p.base_url === prev.base_url) || !prev.base_url;
    const wasDefaultModel = !prev.model || prev.model === defaultConfig("anthropic").model;
    fill({ ...prev, base_url: wasDefaultUrl ? next.base_url : prev.base_url, model: wasDefaultModel ? next.model : prev.model });
  });

  $("save").addEventListener("click", async () => {
    const c = read();
    const errs = validateConfig(c);
    if (errs.length) return show(errs.join("\n"), "err");
    try {
      if (!(await ensureHostPermission(c.base_url))) return show("Permission to call that endpoint was not granted.", "err");
      await saveConfig(c);
      show("Saved.", "ok");
    } catch (e) {
      show(`Could not save: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  });

  $("test").addEventListener("click", async () => {
    const c = read();
    const errs = validateConfig(c);
    if (errs.length) return show(errs.join("\n"), "err");
    show("Testing…", "muted");
    try {
      if (!(await ensureHostPermission(c.base_url))) return show("Permission to call that endpoint was not granted.", "err");
      const r = (await chrome.runtime.sendMessage({ type: "testConnection", config: c } satisfies Message)) as TestResult;
      if (r.ok) show(`Connected in ${r.latency_ms} ms${r.attempts > 1 ? " (needed one retry to get valid JSON)" : ""}.`, "ok");
      else show(`${r.message}${r.details?.length ? `\n- ${r.details.join("\n- ")}` : ""}`, "err");
    } catch (e) {
      show(`Test failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  });
}

void init();
