import { LLMError } from "./types";

/** Parse a model reply as JSON, tolerating code fences and leading/trailing prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  if (!t) throw new LLMError("empty", "The model returned an empty response.");
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const candidates = [fenced?.[1] ?? t];
  const slice = balancedSlice(t);
  if (slice && slice !== candidates[0]) candidates.push(slice);
  let lastErr = "";
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new LLMError("parse", `Response was not valid JSON (${lastErr}).`);
}

/** First balanced {...} or [...] in the text, respecting strings. */
function balancedSlice(t: string): string | undefined {
  const start = t.search(/[{[]/);
  if (start < 0) return undefined;
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return t.slice(start, i + 1);
  }
  return undefined;
}
