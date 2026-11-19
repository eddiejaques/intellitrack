import { joinUrl, postJson } from "./http";
import { jsonInstruction, sanitizeSchema } from "./schema";
import { LLMError, type FetchLike, type LLMConfig, type LLMProvider } from "./types";

interface ChatResponse {
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
}

/**
 * OpenAI Chat Completions. `native` = api.openai.com (json_schema response format, max_completion_tokens).
 * Otherwise (LiteLLM, OpenRouter, Azure, Ollama, gateways) use the lowest common denominator:
 * plain chat completions, JSON requested in the prompt, `max_tokens`.
 */
export function openaiProvider(cfg: LLMConfig, fetchImpl: FetchLike, native: boolean): LLMProvider {
  return {
    async complete({ system, user, jsonSchema }) {
      const headers: Record<string, string> = {};
      if (cfg.api_key) headers.authorization = `Bearer ${cfg.api_key}`;
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages: [
          { role: "system", content: native ? system : `${system}\n\n${jsonInstruction(jsonSchema)}` },
          { role: "user", content: user },
        ],
      };
      if (native) {
        body.max_completion_tokens = cfg.max_output_tokens;
        body.response_format = {
          type: "json_schema",
          json_schema: { name: "response", schema: sanitizeSchema(jsonSchema), strict: false },
        };
      } else {
        body.max_tokens = cfg.max_output_tokens;
      }
      const res = (await postJson(joinUrl(cfg.base_url, "/v1/chat/completions"), {
        headers, body, timeoutMs: cfg.timeout_s * 1000, fetchImpl, apiKey: cfg.api_key,
      })) as ChatResponse;
      const choice = res.choices?.[0];
      if (choice?.message?.refusal) throw new LLMError("refusal", `The model refused: ${choice.message.refusal.slice(0, 200)}`);
      if (choice?.finish_reason === "length") throw new LLMError("truncated", "The response hit the output token limit. Raise max output tokens.");
      return choice?.message?.content ?? "";
    },
  };
}
