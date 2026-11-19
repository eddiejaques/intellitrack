import { joinUrl, postJson } from "./http";
import { jsonInstruction } from "./schema";
import { LLMError, type FetchLike, type LLMConfig, type LLMProvider } from "./types";

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** Gemini generateContent with native JSON mode (responseMimeType). The schema also goes in the prompt. */
export function geminiProvider(cfg: LLMConfig, fetchImpl: FetchLike): LLMProvider {
  return {
    async complete({ system, user, jsonSchema }) {
      const url = joinUrl(cfg.base_url, `/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`);
      const res = (await postJson(url, {
        headers: { "x-goog-api-key": cfg.api_key },
        body: {
          systemInstruction: { parts: [{ text: `${system}\n\n${jsonInstruction(jsonSchema)}` }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", maxOutputTokens: cfg.max_output_tokens },
        },
        timeoutMs: cfg.timeout_s * 1000, fetchImpl, apiKey: cfg.api_key,
      })) as GeminiResponse;
      if (res.promptFeedback?.blockReason) throw new LLMError("refusal", `Blocked by Gemini: ${res.promptFeedback.blockReason}.`);
      const cand = res.candidates?.[0];
      if (cand?.finishReason === "MAX_TOKENS") throw new LLMError("truncated", "The response hit the output token limit. Raise max output tokens.");
      if (cand?.finishReason && /SAFETY|BLOCKLIST|PROHIBITED|RECITATION/.test(cand.finishReason)) {
        throw new LLMError("refusal", `Gemini stopped the response (${cand.finishReason}).`);
      }
      return (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    },
  };
}
