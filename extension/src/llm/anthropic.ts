import Anthropic from "@anthropic-ai/sdk";
import { scrub } from "./http";
import { sanitizeSchema } from "./schema";
import { LLMError, type FetchLike, type LLMConfig, type LLMProvider } from "./types";

/** Anthropic Messages API via the official SDK, using native structured outputs (output_config.format). */
export function anthropicProvider(cfg: LLMConfig, fetchImpl: FetchLike): LLMProvider {
  const client = new Anthropic({
    apiKey: cfg.api_key,
    // The SDK appends /v1/messages itself.
    baseURL: cfg.base_url.replace(/\/+$/, "").replace(/\/v1$/, ""),
    dangerouslyAllowBrowser: true, // calls go straight from the user's browser to their own endpoint
    fetch: fetchImpl as unknown as typeof fetch,
    timeout: cfg.timeout_s * 1000,
    maxRetries: 0,
  });
  return {
    async complete({ system, user, jsonSchema }) {
      try {
        const res = await client.messages.create({
          model: cfg.model,
          max_tokens: cfg.max_output_tokens,
          system,
          messages: [{ role: "user", content: user }],
          output_config: { format: { type: "json_schema", schema: sanitizeSchema(jsonSchema) as Record<string, unknown> } },
        });
        if (res.stop_reason === "refusal") throw new LLMError("refusal", "The model declined to answer this request.");
        if (res.stop_reason === "max_tokens") throw new LLMError("truncated", "The response hit the output token limit. Raise max output tokens.");
        return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      } catch (e) {
        throw mapAnthropicError(e, cfg.api_key);
      }
    },
  };
}

function mapAnthropicError(e: unknown, key: string): unknown {
  if (e instanceof LLMError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new LLMError("timeout", "The request timed out.");
  if (e instanceof Anthropic.APIConnectionError) return new LLMError("network", scrub(`Could not reach the endpoint: ${e.message}`, key));
  if (e instanceof Anthropic.APIError) {
    const status = e.status;
    return new LLMError(status === 401 || status === 403 ? "auth" : "http", scrub(`HTTP ${status}: ${e.message}`.slice(0, 400), key), status);
  }
  return e;
}
