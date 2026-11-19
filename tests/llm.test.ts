import { describe, expect, it, vi } from "vitest";
import { validate, sanitizeSchema } from "../extension/src/llm/schema";
import { extractJson } from "../extension/src/llm/json";
import { completeValidated } from "../extension/src/llm/complete";
import { createProvider, testConnection } from "../extension/src/llm";
import { joinUrl, scrub } from "../extension/src/llm/http";
import { defaultConfig, ensureHostPermission, validateConfig } from "../extension/src/llm/config";
import { LLMError, type LLMConfig, type LLMProvider, type ProviderId } from "../extension/src/llm/types";

const SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    sev: { enum: ["low", "high"] },
    tags: { type: "array", items: { type: "string" }, minItems: 1 },
  },
  required: ["score", "sev"],
  additionalProperties: false,
};

describe("validate", () => {
  it("accepts valid and reports readable paths for invalid", () => {
    expect(validate(SCHEMA, { score: 5, sev: "low", tags: ["a"] })).toEqual([]);
    const e = validate(SCHEMA, { score: 101, sev: "mid", tags: [], extra: 1 });
    expect(e).toEqual(expect.arrayContaining([
      "$.score: above maximum 100",
      expect.stringContaining("$.sev: must be one of"),
      "$.tags: fewer than 1 items",
      '$: unexpected property "extra"',
    ]));
    expect(validate(SCHEMA, { sev: "low" })).toEqual(['$: missing required property "score"']);
    expect(validate(SCHEMA, { score: 1.5, sev: "low" })[0]).toMatch(/expected integer/);
    expect(validate(SCHEMA, [])[0]).toMatch(/expected object, got array/);
  });
  it("supports anyOf, oneOf, $ref, nullable types and additionalProperties schemas", () => {
    const s = {
      definitions: { ev: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
      type: "object",
      properties: {
        e: { $ref: "#/definitions/ev" },
        v: { anyOf: [{ type: "string" }, { type: "number" }] },
        n: { type: ["string", "null"] },
        m: { type: "object", additionalProperties: { type: "number" } },
        o: { oneOf: [{ type: "string" }, { type: "string", minLength: 1 }] },
      },
    };
    expect(validate(s, { e: { id: "x" }, v: 3, n: null, m: { a: 1 } })).toEqual([]);
    const bad = validate(s, { e: {}, v: true, n: 1, m: { a: "x" }, o: "z" });
    expect(bad.length).toBe(5);
  });
  it("anyOf sub-schemas don't inherit the root's type/required", () => {
    const s = { type: "object", required: ["a"], properties: { a: { anyOf: [{ type: "string" }, { type: "null" }] } } };
    expect(validate(s, { a: null })).toEqual([]);
  });
});

describe("sanitizeSchema", () => {
  it("strips unsupported keywords, closes objects, doesn't mutate", () => {
    const orig = JSON.parse(JSON.stringify(SCHEMA));
    const s = sanitizeSchema(SCHEMA) as any;
    expect(SCHEMA).toEqual(orig);
    expect(s.properties.score).toEqual({ type: "integer" });
    expect(s.properties.tags.minItems).toBe(1); // minItems 0/1 is supported natively
    expect((sanitizeSchema({ type: "array", minItems: 3, items: { type: "string" } }) as any).minItems).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.sev.enum).toEqual(["low", "high"]);
    // a property literally named "pattern" survives
    expect((sanitizeSchema({ type: "object", properties: { pattern: { type: "string" } } }) as any).properties.pattern).toBeDefined();
  });
});

describe("extractJson", () => {
  it("handles fences, prose, nested braces in strings, and arrays", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go:\n{"a":"}{","b":{"c":2}}\nHope that helps')).toEqual({ a: "}{", b: { c: 2 } });
    expect(extractJson("[1,2]")).toEqual([1, 2]);
  });
  it("throws typed errors", () => {
    expect(() => extractJson("  ")).toThrowError(expect.objectContaining({ kind: "empty" }));
    expect(() => extractJson("nope")).toThrowError(expect.objectContaining({ kind: "parse" }));
    expect(() => extractJson('{"a":')).toThrowError(expect.objectContaining({ kind: "parse" }));
  });
});

describe("completeValidated", () => {
  const req = { system: "s", user: "u", jsonSchema: SCHEMA };
  const prov = (...replies: (string | Error)[]) => {
    const complete = vi.fn(async (_r: { system: string; user: string; jsonSchema: object }) => { const r = replies.shift()!; if (r instanceof Error) throw r; return r; });
    return { complete } satisfies LLMProvider;
  };

  it("returns first valid reply without retry", async () => {
    const p = prov('{"score":1,"sev":"low"}');
    expect(await completeValidated(p, req)).toEqual({ value: { score: 1, sev: "low" }, attempts: 1 });
    expect(p.complete).toHaveBeenCalledTimes(1);
  });
  it("retries once with the validation error, then succeeds", async () => {
    const p = prov('{"score":500,"sev":"low"}', '{"score":50,"sev":"low"}');
    const r = await completeValidated(p, req);
    expect(r.attempts).toBe(2);
    const second = p.complete.mock.calls[1][0].user;
    expect(second).toContain("$.score: above maximum 100");
    expect(second.startsWith("u")).toBe(true);
  });
  it("retries on unparseable output", async () => {
    const p = prov("I cannot do that", '{"score":1,"sev":"high"}');
    expect((await completeValidated(p, req)).attempts).toBe(2);
  });
  it("fails cleanly after one retry", async () => {
    const p = prov('{"score":-1,"sev":"low"}', '{"sev":"x"}');
    await expect(completeValidated(p, req)).rejects.toMatchObject({ kind: "validation", details: expect.any(Array) });
    expect(p.complete).toHaveBeenCalledTimes(2);
  });
  it("does not retry transport errors", async () => {
    const p = prov(new LLMError("auth", "HTTP 401"));
    await expect(completeValidated(p, req)).rejects.toMatchObject({ kind: "auth" });
    expect(p.complete).toHaveBeenCalledTimes(1);
  });
});

// ---------- adapters against a mocked network ----------
const cfg = (provider: ProviderId, over: Partial<LLMConfig> = {}): LLMConfig => ({
  ...defaultConfig(provider), model: "m-1", api_key: "sk-secret-key-123456", ...over,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; init: RequestInit };
function mockFetch(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => { const c = { url, init: init ?? {} }; calls.push(c); return respond(c); });
  return { fn: fn as any, calls };
}
const hdr = (c: Call, k: string) => new Headers(c.init.headers as HeadersInit).get(k);
const body = (c: Call) => JSON.parse(c.init.body as string);
const REQ = { system: "SYS", user: "USER", jsonSchema: SCHEMA };

describe("anthropic adapter", () => {
  const ok = (text: string, stop = "end_turn") => json({ id: "m", type: "message", role: "assistant", model: "m-1", content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });
  it("sends native structured output with browser-access header and returns text", async () => {
    const m = mockFetch(() => ok('{"score":1,"sev":"low"}'));
    const out = await createProvider(cfg("anthropic"), m.fn).complete(REQ);
    expect(out).toBe('{"score":1,"sev":"low"}');
    const c = m.calls[0];
    expect(c.url).toBe("https://api.anthropic.com/v1/messages");
    // the official SDK picks the auth header; accept either form
    expect(hdr(c, "x-api-key") ?? hdr(c, "authorization")).toContain("sk-secret-key-123456");
    expect(hdr(c, "anthropic-dangerous-direct-browser-access")).toBe("true");
    const b = body(c);
    expect(b).toMatchObject({ model: "m-1", max_tokens: 4000, system: "SYS", messages: [{ role: "user", content: "USER" }] });
    expect(b.output_config.format.type).toBe("json_schema");
    expect(b.output_config.format.schema.properties.score).toEqual({ type: "integer" });
    expect(b).not.toHaveProperty("temperature");
  });
  it("tolerates a /v1 suffix on the base URL", async () => {
    const m = mockFetch(() => ok("{}"));
    await createProvider(cfg("anthropic", { base_url: "https://gw.example/v1/" }), m.fn).complete(REQ);
    expect(m.calls[0].url).toBe("https://gw.example/v1/messages");
  });
  it("maps refusal, truncation, 401, 500", async () => {
    await expect(createProvider(cfg("anthropic"), mockFetch(() => ok("", "refusal")).fn).complete(REQ)).rejects.toMatchObject({ kind: "refusal" });
    await expect(createProvider(cfg("anthropic"), mockFetch(() => ok("{", "max_tokens")).fn).complete(REQ)).rejects.toMatchObject({ kind: "truncated" });
    const e401 = createProvider(cfg("anthropic"), mockFetch(() => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key sk-secret-key-123456" } }, 401)).fn).complete(REQ);
    await expect(e401).rejects.toMatchObject({ kind: "auth", status: 401 });
    await e401.catch((e) => expect(e.message).not.toContain("sk-secret-key-123456"));
    await expect(createProvider(cfg("anthropic"), mockFetch(() => json({ type: "error", error: { type: "api_error", message: "boom" } }, 500)).fn).complete(REQ)).rejects.toMatchObject({ kind: "http", status: 500 });
  });
});

describe("openai adapter", () => {
  const ok = (content: string | null, extra: Record<string, unknown> = {}, finish = "stop") => json({ choices: [{ message: { content, ...extra }, finish_reason: finish }] });
  it("native: json_schema response format + max_completion_tokens + bearer", async () => {
    const m = mockFetch(() => ok('{"score":1,"sev":"low"}'));
    expect(await createProvider(cfg("openai"), m.fn).complete(REQ)).toBe('{"score":1,"sev":"low"}');
    const c = m.calls[0];
    expect(c.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(hdr(c, "authorization")).toBe("Bearer sk-secret-key-123456");
    const b = body(c);
    expect(b.max_completion_tokens).toBe(4000);
    expect(b).not.toHaveProperty("max_tokens");
    expect(b.response_format.type).toBe("json_schema");
    expect(b.messages).toEqual([{ role: "system", content: "SYS" }, { role: "user", content: "USER" }]);
  });
  it("compatible: no response_format, schema in prompt, max_tokens, optional key, no doubled /v1", async () => {
    const m = mockFetch(() => ok('{"a":1}'));
    await createProvider(cfg("openai_compatible", { base_url: "http://localhost:11434/v1", api_key: "" }), m.fn).complete(REQ);
    const c = m.calls[0];
    expect(c.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(hdr(c, "authorization")).toBeNull();
    const b = body(c);
    expect(b.response_format).toBeUndefined();
    expect(b.max_tokens).toBe(4000);
    expect(b.messages[0].content).toContain("JSON Schema");
    expect(b.messages[0].content.startsWith("SYS")).toBe(true);
  });
  it("maps length, refusal, empty content, 401", async () => {
    await expect(createProvider(cfg("openai"), mockFetch(() => ok("{", {}, "length")).fn).complete(REQ)).rejects.toMatchObject({ kind: "truncated" });
    await expect(createProvider(cfg("openai"), mockFetch(() => ok(null, { refusal: "no" })).fn).complete(REQ)).rejects.toMatchObject({ kind: "refusal" });
    expect(await createProvider(cfg("openai"), mockFetch(() => ok(null)).fn).complete(REQ)).toBe("");
    await expect(createProvider(cfg("openai"), mockFetch(() => json({ error: { message: "bad key" } }, 401)).fn).complete(REQ)).rejects.toMatchObject({ kind: "auth" });
  });
  it("non-JSON body from a wrong base URL gives a helpful parse error", async () => {
    const m = mockFetch(() => new Response("<html>nope</html>", { status: 200 }));
    await expect(createProvider(cfg("openai_compatible", { base_url: "https://x.example" }), m.fn).complete(REQ)).rejects.toMatchObject({ kind: "parse" });
  });
});

describe("gemini adapter", () => {
  const ok = (text: string, finish = "STOP") => json({ candidates: [{ content: { parts: [{ text }] }, finishReason: finish }] });
  it("uses generateContent with JSON mime type and x-goog-api-key", async () => {
    const m = mockFetch(() => ok('{"score":1,"sev":"low"}'));
    expect(await createProvider(cfg("gemini", { model: "gem-x" }), m.fn).complete(REQ)).toBe('{"score":1,"sev":"low"}');
    const c = m.calls[0];
    expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gem-x:generateContent");
    expect(hdr(c, "x-goog-api-key")).toBe("sk-secret-key-123456");
    expect(c.url).not.toContain("sk-secret");
    const b = body(c);
    expect(b.generationConfig).toEqual({ responseMimeType: "application/json", maxOutputTokens: 4000 });
    expect(b.systemInstruction.parts[0].text).toContain("SYS");
    expect(b.contents).toEqual([{ role: "user", parts: [{ text: "USER" }] }]);
  });
  it("skips thought parts; maps MAX_TOKENS, safety, blocked prompt", async () => {
    const withThought = json({ candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: '{"a":1}' }] } }] });
    expect(await createProvider(cfg("gemini"), mockFetch(() => withThought).fn).complete(REQ)).toBe('{"a":1}');
    await expect(createProvider(cfg("gemini"), mockFetch(() => ok("{", "MAX_TOKENS")).fn).complete(REQ)).rejects.toMatchObject({ kind: "truncated" });
    await expect(createProvider(cfg("gemini"), mockFetch(() => ok("", "SAFETY")).fn).complete(REQ)).rejects.toMatchObject({ kind: "refusal" });
    await expect(createProvider(cfg("gemini"), mockFetch(() => json({ promptFeedback: { blockReason: "OTHER" } })).fn).complete(REQ)).rejects.toMatchObject({ kind: "refusal" });
    await expect(createProvider(cfg("gemini"), mockFetch(() => json({ error: { message: "API key not valid" } }, 400)).fn).complete(REQ)).rejects.toMatchObject({ kind: "http", status: 400 });
  });
});

describe("transport failures", () => {
  it.each(["openai", "openai_compatible", "gemini", "anthropic"] as ProviderId[])("%s: timeout and network errors are typed", async (p) => {
    const hang = mockFetch((c) => new Promise<Response>((_, rej) => (c.init.signal as AbortSignal).addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    await expect(createProvider(cfg(p, { timeout_s: 0.05, base_url: p === "openai_compatible" ? "https://gw.example" : defaultConfig(p).base_url }), hang.fn).complete(REQ)).rejects.toMatchObject({ kind: "timeout" });
    const down = mockFetch(() => { throw new TypeError("Failed to fetch"); });
    await expect(createProvider(cfg(p, { base_url: p === "openai_compatible" ? "https://gw.example" : defaultConfig(p).base_url }), down.fn).complete(REQ)).rejects.toMatchObject({ kind: "network" });
  });
});

describe("testConnection (all 4 providers, mocked)", () => {
  const replies: Record<ProviderId, (ok: string) => Response> = {
    anthropic: (t) => json({ id: "m", type: "message", role: "assistant", model: "m", content: [{ type: "text", text: t }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }),
    openai: (t) => json({ choices: [{ message: { content: t }, finish_reason: "stop" }] }),
    openai_compatible: (t) => json({ choices: [{ message: { content: t }, finish_reason: "stop" }] }),
    gemini: (t) => json({ candidates: [{ content: { parts: [{ text: t }] }, finishReason: "STOP" }] }),
  };
  it.each(Object.keys(replies) as ProviderId[])("%s passes", async (p) => {
    const m = mockFetch(() => replies[p]('{"ok":true}'));
    const base = p === "openai_compatible" ? { base_url: "https://gw.example" } : {};
    const r = await testConnection(cfg(p, base), m.fn);
    expect(r).toMatchObject({ ok: true, attempts: 1 });
  });
  it.each(Object.keys(replies) as ProviderId[])("%s: invalid reply triggers the retry, then a clean failure", async (p) => {
    const base = p === "openai_compatible" ? { base_url: "https://gw.example" } : {};
    const once = mockFetch(() => replies[p]("not json at all"));
    const fail = await testConnection(cfg(p, base), once.fn);
    expect(fail).toMatchObject({ ok: false, kind: "validation" });
    expect(once.calls).toHaveLength(2);
    let n = 0;
    const flaky = mockFetch(() => replies[p](n++ === 0 ? "oops" : '{"ok":true}'));
    expect(await testConnection(cfg(p, base), flaky.fn)).toMatchObject({ ok: true, attempts: 2 });
  });
  it("reports auth errors without leaking the key", async () => {
    const m = mockFetch(() => json({ error: { message: "Incorrect API key provided: sk-secret-key-123456" } }, 401));
    const r = await testConnection(cfg("openai"), m.fn);
    expect(r).toMatchObject({ ok: false, kind: "auth" });
    expect(JSON.stringify(r)).not.toContain("sk-secret-key-123456");
  });
});

describe("helpers", () => {
  it("joinUrl", () => {
    expect(joinUrl("https://a.example", "/v1/chat/completions")).toBe("https://a.example/v1/chat/completions");
    expect(joinUrl("https://a.example/v1/", "/v1/chat/completions")).toBe("https://a.example/v1/chat/completions");
    expect(joinUrl("https://a.example/openai", "/v1/chat/completions")).toBe("https://a.example/openai/v1/chat/completions");
  });
  it("scrub", () => {
    expect(scrub("bad key abcdef123456!", "abcdef123456")).not.toContain("abcdef123456");
    expect(scrub("key sk-abcdefghijk12345")).toContain("[redacted-key]");
  });
  it("validateConfig", () => {
    expect(validateConfig(cfg("anthropic"))).toEqual([]);
    expect(validateConfig(cfg("openai", { api_key: "" }))).toContain("API key is required.");
    expect(validateConfig(cfg("openai_compatible", { api_key: "", base_url: "http://localhost:11434" }))).toEqual([]);
    expect(validateConfig(cfg("openai_compatible", { base_url: "http://evil.example" }))[0]).toMatch(/https/);
    expect(validateConfig(cfg("anthropic", { base_url: "nope" }))[0]).toMatch(/valid URL/);
    expect(validateConfig(cfg("anthropic", { max_output_tokens: 10 })).length).toBe(1);
    expect(validateConfig(cfg("anthropic", { model: " " }))).toContain("Model is required.");
  });
  it("ensureHostPermission asks only when the origin isn't already granted", async () => {
    const contains = vi.fn(async () => false);
    const request = vi.fn(async () => true);
    (globalThis as any).chrome = { permissions: { contains, request } };
    expect(await ensureHostPermission("https://gw.example/v1")).toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: ["https://gw.example/*"] });
    contains.mockResolvedValueOnce(true);
    request.mockClear();
    expect(await ensureHostPermission("https://gw.example")).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
