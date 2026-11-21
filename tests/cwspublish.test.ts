// The Chrome Web Store step (mocked API) and the release workflow's guardrails.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { SECRET_NAMES, publishToStore } from "../scripts/cws-publish.mjs";

const dir = mkdtempSync(join(tmpdir(), "cws-"));
const zip = join(dir, "intellitrack-9.9.9.zip");
writeFileSync(zip, "PK fake zip");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// placeholder values only
const ENV = { CWS_PUBLISHER_ID: "pub-placeholder", CWS_EXTENSION_ID: "abcdefghijklmnopabcdefghijklmnop", CWS_CLIENT_ID: "client-placeholder", CWS_CLIENT_SECRET: "secret-placeholder", CWS_REFRESH_TOKEN: "refresh-placeholder" };

type Call = { url: string; init?: RequestInit };
function mockStore(script: Record<string, (c: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const c = { url, init };
    calls.push(c);
    const key = Object.keys(script).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected call ${url}`);
    const r = script[key](c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { f, calls };
}
const run = (f: unknown, env: Record<string, string> = ENV) => {
  const out: string[] = [];
  return publishToStore({ zip, env, fetch: f, log: (s: string) => out.push(s), sleep: async () => {}, pollMs: 0 }).then((r: { code: number; state?: string; skipped?: boolean }) => ({ ...r, out: out.join("\n") }));
};
const ok = {
  "oauth2.googleapis.com/token": () => ({ body: { access_token: "ya29.placeholder-token", expires_in: 3600 } }),
  ":upload": () => ({ body: { uploadState: "SUCCEEDED" } }),
  ":publish": () => ({ body: { state: "PENDING_REVIEW" } }),
};

describe("publishToStore", () => {
  it("skips with a notice when any secret is missing, and makes no calls", async () => {
    const { f, calls } = mockStore({});
    const r = await run(f, { ...ENV, CWS_REFRESH_TOKEN: "" });
    expect(r).toMatchObject({ code: 0, skipped: true });
    expect(r.out).toMatch(/::notice.*skipped.*CWS_REFRESH_TOKEN/);
    expect(calls).toHaveLength(0);
  });

  it("gets a token, uploads to the v2 endpoint, then publishes", async () => {
    const { f, calls } = mockStore(ok);
    const r = await run(f);
    expect(r).toMatchObject({ code: 0, state: "PENDING_REVIEW" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://chromewebstore.googleapis.com/upload/v2/publishers/pub-placeholder/items/abcdefghijklmnopabcdefghijklmnop:upload",
      "https://chromewebstore.googleapis.com/v2/publishers/pub-placeholder/items/abcdefghijklmnopabcdefghijklmnop:publish",
    ]);
    const form = new URLSearchParams(String(calls[0].init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect((calls[1].init?.headers as Record<string, string>).authorization).toBe("Bearer ya29.placeholder-token");
  });

  it("polls fetchStatus while the upload is in progress", async () => {
    let polls = 0;
    const { f, calls } = mockStore({ ...ok, ":upload": () => ({ body: { uploadState: "IN_PROGRESS" } }), ":fetchStatus": () => ({ body: { lastAsyncUploadState: ++polls < 3 ? "IN_PROGRESS" : "SUCCEEDED" } }) });
    expect((await run(f)).code).toBe(0);
    expect(calls.filter((c) => c.url.endsWith(":fetchStatus"))).toHaveLength(3);
  });

  it("fails on a rejected upload or publish, without printing any secret or the token", async () => {
    const leaky = { error: { message: `bad request for secret-placeholder with ya29.placeholder-token` } };
    for (const bad of [
      { ...ok, "oauth2.googleapis.com/token": () => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad refresh-placeholder" } }) },
      { ...ok, ":upload": () => ({ status: 400, body: leaky }) },
      { ...ok, ":upload": () => ({ body: { uploadState: "FAILED", itemError: [{ error_detail: "version must be higher" }] } }) },
      { ...ok, ":publish": () => ({ status: 403, body: leaky }) },
    ]) {
      const r = await run(mockStore(bad).f);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/::error/);
      for (const v of [...Object.values(ENV), "ya29.placeholder-token"]) expect(r.out).not.toContain(v);
    }
  });
});

describe("release workflow", () => {
  const wf = readFileSync(".github/workflows/release.yml", "utf8");
  const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));

  it("runs only on pushed v* tags, never on pull requests, and only on this repository", () => {
    expect(on).toMatch(/push:\s*\n\s*tags: \["v\*"\]/);
    expect(on).not.toMatch(/pull_request|workflow_run|branches:/);
    expect(wf).toContain("if: github.repository == 'eddiejaques/intellitrack'");
  });

  it("runs the steps in order: install, checks, tag = version, package, e2e on the zip, GitHub Release, store", () => {
    const order = ["npm ci", "npm run typecheck && npm test && npm run build", 'TAG="${GITHUB_REF_NAME#v}"', "npm run package", "npm run e2e -- --from-zip", "gh release create", "node scripts/cws-publish.mjs"];
    const at = order.map((s) => wf.indexOf(s));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("uses the store secrets only in the store step, by name", () => {
    const store = wf.slice(wf.indexOf("Upload and publish to the Chrome Web Store"));
    for (const n of SECRET_NAMES) {
      expect(store).toContain(`${n}: \${{ secrets.${n} }}`);
      expect(wf.indexOf(`secrets.${n}`)).toBeGreaterThan(wf.indexOf("Upload and publish to the Chrome Web Store"));
    }
  });
});
