export type ProviderId = "anthropic" | "openai" | "gemini" | "openai_compatible";

export interface LLMConfig {
  provider: ProviderId;
  base_url: string;
  model: string;
  api_key: string;
  max_output_tokens: number;
  timeout_s: number;
  plan_call_budget: { max_per_session: number; min_interval_s: number };
}

export interface LLMRequest {
  system: string;
  user: string;
  /** JSON Schema the response must satisfy */
  jsonSchema: object;
}

/** Adapters only translate request/response shapes. They contain no prompt logic. */
export interface LLMProvider {
  complete(req: LLMRequest): Promise<string>;
}

export type LLMErrorKind =
  | "config" | "auth" | "http" | "timeout" | "network"
  | "refusal" | "truncated" | "empty" | "parse" | "validation";

export class LLMError extends Error {
  constructor(
    public kind: LLMErrorKind,
    message: string,
    public status?: number,
    public details?: string[],
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
