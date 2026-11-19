import { extractJson } from "./json";
import { validate } from "./schema";
import { LLMError, type LLMProvider } from "./types";

export interface ValidatedResult<T = unknown> {
  value: T;
  /** 1 = first reply was valid, 2 = valid after the retry */
  attempts: number;
}

/**
 * Call the provider, parse and schema-validate the reply. On a parse/validation failure, retry
 * once with the errors appended; after that, fail cleanly. Transport errors (auth, http, timeout,
 * truncation...) are not retried here: they would fail the same way.
 */
export async function completeValidated<T = unknown>(
  provider: LLMProvider,
  req: { system: string; user: string; jsonSchema: object },
  /** semantic checks a JSON Schema can't express; failures are fed back in the retry like schema errors */
  check?: (value: T) => string[],
): Promise<ValidatedResult<T>> {
  let user = req.user;
  let errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const text = await provider.complete({ ...req, user });
    try {
      const value = extractJson(text);
      errors = validate(req.jsonSchema, value);
      if (errors.length === 0 && check) errors = check(value as T);
      if (errors.length === 0) return { value: value as T, attempts: attempt };
    } catch (e) {
      if (!(e instanceof LLMError) || (e.kind !== "parse" && e.kind !== "empty")) throw e;
      errors = [e.message];
    }
    user =
      `${req.user}\n\n---\nYour previous response was rejected by the schema validator:\n` +
      errors.map((x) => `- ${x}`).join("\n") +
      `\n\nYour previous response (truncated):\n${text.slice(0, 1500)}\n\nReturn a corrected JSON object only.`;
  }
  throw new LLMError("validation", "The model's response did not match the expected format after one retry.", undefined, errors);
}
