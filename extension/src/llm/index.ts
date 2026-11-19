import { anthropicProvider } from "./anthropic";
import { completeValidated } from "./complete";
import { geminiProvider } from "./gemini";
import { openaiProvider } from "./openai";
import { LLMError, type FetchLike, type LLMConfig, type LLMProvider } from "./types";

export { completeValidated } from "./complete";
export { LLMError } from "./types";
export type { LLMConfig, LLMProvider, ProviderId } from "./types";

export function createProvider(cfg: LLMConfig, fetchImpl: FetchLike = (u, i) => fetch(u, i)): LLMProvider {
  switch (cfg.provider) {
    case "anthropic": return anthropicProvider(cfg, fetchImpl);
    case "openai": return openaiProvider(cfg, fetchImpl, true);
    case "openai_compatible": return openaiProvider(cfg, fetchImpl, false);
    case "gemini": return geminiProvider(cfg, fetchImpl);
    default: throw new LLMError("config", `Unknown provider "${String((cfg as LLMConfig).provider)}".`);
  }
}

export type TestResult =
  | { ok: true; latency_ms: number; attempts: number }
  | { ok: false; kind: string; message: string; details?: string[] };

const PING_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};

/** Same path as real calls: adapter + schema validation + retry. */
export async function testConnection(cfg: LLMConfig, fetchImpl?: FetchLike): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const r = await completeValidated<{ ok: boolean }>(createProvider(cfg, fetchImpl), {
      system: "You are a connectivity check for a browser extension.",
      user: 'Reply with the JSON object {"ok": true}.',
      jsonSchema: PING_SCHEMA,
    });
    if (r.value.ok !== true) return { ok: false, kind: "validation", message: 'The model replied, but not with {"ok": true}.' };
    return { ok: true, latency_ms: Date.now() - t0, attempts: r.attempts };
  } catch (e) {
    if (e instanceof LLMError) return { ok: false, kind: e.kind, message: e.message, details: e.details };
    return { ok: false, kind: "network", message: e instanceof Error ? e.message : String(e) };
  }
}
