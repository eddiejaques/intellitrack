import type { LLMConfig, ProviderId } from "./types";

export const PROVIDERS: { id: ProviderId; label: string; base_url: string; model_hint: string }[] = [
  { id: "anthropic", label: "Anthropic (Claude)", base_url: "https://api.anthropic.com", model_hint: "claude-sonnet-5-5" },
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com", model_hint: "a model ID from your OpenAI account" },
  { id: "gemini", label: "Google Gemini", base_url: "https://generativelanguage.googleapis.com", model_hint: "a Gemini model ID, e.g. gemini-…" },
  { id: "openai_compatible", label: "OpenAI-compatible (LiteLLM, OpenRouter, Azure, Ollama, gateway)", base_url: "", model_hint: "the model name your gateway expects" },
];

export const defaultConfig = (provider: ProviderId = "anthropic"): LLMConfig => ({
  provider,
  base_url: PROVIDERS.find((p) => p.id === provider)!.base_url,
  model: provider === "anthropic" ? "claude-sonnet-5-5" : "",
  api_key: "",
  max_output_tokens: 4000,
  timeout_s: 120,
  plan_call_budget: { max_per_session: 5, min_interval_s: 30 },
});

/** X14: a "selection" for response length in Settings, on top of the raw `max_output_tokens` field. */
export const RESPONSE_LENGTH_PRESETS = [
  { id: "short", label: "Short (1,000 tokens)", tokens: 1000 },
  { id: "medium", label: "Medium (4,000 tokens)", tokens: 4000 },
  { id: "long", label: "Long (16,000 tokens)", tokens: 16000 },
  { id: "very_long", label: "Very long (64,000 tokens, for long pages)", tokens: 64000 },
] as const;

/** Which preset a stored token value matches, or "custom" when it doesn't match any preset exactly. */
export function responseLengthOf(maxOutputTokens: number): string {
  return RESPONSE_LENGTH_PRESETS.find((p) => p.tokens === maxOutputTokens)?.id ?? "custom";
}

export function validateConfig(c: LLMConfig): string[] {
  const errs: string[] = [];
  let url: URL | undefined;
  try { url = new URL(c.base_url); } catch { errs.push("Base URL is not a valid URL."); }
  if (url) {
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) errs.push("Base URL must use https (http is allowed only for localhost).");
  }
  if (!c.model.trim()) errs.push("Model is required.");
  if (!c.api_key.trim() && c.provider !== "openai_compatible") errs.push("API key is required.");
  if (!Number.isInteger(c.max_output_tokens) || c.max_output_tokens < 256 || c.max_output_tokens > 64000) errs.push("Max output tokens must be a whole number from 256 to 64000.");
  if (!(c.timeout_s >= 5 && c.timeout_s <= 600)) errs.push("Timeout must be 5-600 seconds.");
  const b = c.plan_call_budget;
  if (!Number.isInteger(b.max_per_session) || b.max_per_session < 1 || b.max_per_session > 50) errs.push("Plan calls per session must be 1-50.");
  if (!(b.min_interval_s >= 0 && b.min_interval_s <= 3600)) errs.push("Minimum interval must be 0-3600 seconds.");
  return errs;
}

const KEY = "llm_config";

/** Stored in chrome.storage.local only: never storage.sync, never a content script. */
export async function loadConfig(): Promise<LLMConfig | undefined> {
  const r = await chrome.storage.local.get(KEY);
  return r[KEY] as LLMConfig | undefined;
}
export async function saveConfig(c: LLMConfig): Promise<void> {
  await chrome.storage.local.set({ [KEY]: c });
}

/**
 * Make sure the extension may call the configured endpoint. A no-op while `<all_urls>` is granted;
 * if the broad permission is ever dropped (e.g. a store build), this asks for just that origin.
 * Must be called from a user gesture (the Save button).
 */
export async function ensureHostPermission(baseUrl: string): Promise<boolean> {
  const origin = `${new URL(baseUrl).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}
