import { LLMError, type FetchLike } from "./types";

export function scrub(text: string, secret?: string): string {
  let t = text;
  if (secret && secret.length >= 6) t = t.split(secret).join("[redacted-key]");
  return t.replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})/g, "[redacted-key]");
}

/** Join a base URL and an API path without doubling a version prefix ("https://x/v1" + "/v1/chat/..."). */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const m = /\/(v1|v1beta)$/.exec(b);
  if (m && path.startsWith(`/${m[1]}/`)) return b + path.slice(m[1].length + 1);
  return b + path;
}

export function classifyStatus(status: number): "auth" | "http" {
  return status === 401 || status === 403 ? "auth" : "http";
}

export function errorMessageFrom(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === "string") return m;
  } catch { /* not JSON */ }
  return body;
}

export interface PostOptions {
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  fetchImpl: FetchLike;
  apiKey?: string;
}

export async function postJson(url: string, o: PostOptions): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
  let res: Response;
  try {
    res = await o.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...o.headers },
      body: JSON.stringify(o.body),
      signal: ctl.signal,
    });
  } catch (e) {
    if (ctl.signal.aborted) throw new LLMError("timeout", `No response within ${Math.round(o.timeoutMs / 1000)} s.`);
    throw new LLMError("network", scrub(`Could not reach ${new URL(url).origin}: ${e instanceof Error ? e.message : String(e)}`, o.apiKey));
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const msg = scrub(errorMessageFrom(text).slice(0, 300), o.apiKey);
    throw new LLMError(classifyStatus(res.status), `HTTP ${res.status}: ${msg}`, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LLMError("parse", "The endpoint did not return JSON (is the base URL correct?).", res.status);
  }
}
