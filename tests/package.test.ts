// The built manifest carries package.json's version, and the store zip passes its checks.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { checkPackage, packageExtension } from "../scripts/package.mjs";
import { versionLabel } from "../extension/src/ui/version";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let tmp: string, zip: string;
const list = (z: string) => execFileSync("unzip", ["-Z1", z], { encoding: "utf8" }).split("\n").filter(Boolean);

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "it-pkg-"));
  zip = packageExtension({ outDir: join(tmp, "dist"), releaseDir: join(tmp, "release") });
}, 60_000);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** zip a folder with the given files into a throwaway zip */
function makeZip(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  const z = join(tmp, `${name}.zip`);
  execFileSync("zip", ["-q", "-r", z, "."], { cwd: dir });
  return z;
}
const goodManifest = { manifest_version: 3, name: "x", version: "1.2.3", icons: { 16: "icons/i.png" }, background: { service_worker: "background.js" } };

describe("version", () => {
  it("the built manifest's version is package.json's", () => {
    const m = JSON.parse(readFileSync(join(tmp, "dist", "manifest.json"), "utf8"));
    expect(m.version).toBe(pkg.version);
    // the source manifest no longer carries its own copy that could drift
    expect(JSON.parse(readFileSync("extension/static/manifest.json", "utf8")).version).toBeUndefined();
  });

  it("labels the version for the popup and Settings", () => {
    expect(versionLabel("0.2.0")).toBe("IntelliTrack v0.2.0");
    expect(versionLabel(undefined)).toBe("IntelliTrack v?");
  });
});

describe("package", () => {
  it("zips dist into release/intellitrack-X.Y.Z.zip with the manifest at its root", () => {
    expect(zip.endsWith(`release/intellitrack-${pkg.version}.zip`)).toBe(true);
    const entries = list(zip);
    expect(entries).toContain("manifest.json");
    expect(entries).toContain("background.js");
    expect(entries.some((e) => e.endsWith(".map"))).toBe(false);
    expect(entries.some((e) => /(^|\/)(tests?|fixtures)\//.test(e) || e.endsWith(".ts"))).toBe(false);
  });

  it("the real zip passes every check (MV3, icons, no maps/tests, no remote code)", () => {
    expect(checkPackage(zip)).toEqual([]);
  });

  it("catches a bad package", () => {
    const icons = { "icons/i.png": "png", "background.js": "1" };
    expect(checkPackage(makeZip("nested", { "dist/manifest.json": JSON.stringify(goodManifest) }))).toEqual(["manifest.json is not at the root of the zip"]);
    expect(checkPackage(makeZip("badjson", { "manifest.json": "{ nope" }))[0]).toMatch(/not valid JSON/);
    expect(checkPackage(makeZip("mv2", { ...icons, "manifest.json": JSON.stringify({ ...goodManifest, manifest_version: 2 }) }))).toEqual(["manifest_version is 2, expected 3"]);
    expect(checkPackage(makeZip("noicon", { "background.js": "1", "manifest.json": JSON.stringify(goodManifest) }))).toEqual(["icon icons/i.png named in the manifest is missing"]);
    const junk = checkPackage(makeZip("junk", { ...icons, "manifest.json": JSON.stringify(goodManifest), "background.js.map": "{}", "tests/a.test.js": "", "src/x.ts": "" }));
    expect(junk.join("\n")).toMatch(/source map/);
    expect(junk.join("\n")).toMatch(/tests\/a\.test\.js/);
    expect(junk.join("\n")).toMatch(/src\/x\.ts/);
  });

  it("catches remotely hosted code", () => {
    const base = { "icons/i.png": "png", "manifest.json": JSON.stringify(goodManifest) };
    const cases: Record<string, string>[] = [
      { "background.js": 'importScripts("https://cdn.example.com/lib.js")' },
      { "background.js": "1", "page.html": '<script src="https://cdn.example.com/a.js"></script>' },
      { "background.js": 'await import("https://cdn.example.com/m.js")' },
    ];
    cases.forEach((c, i) => expect(checkPackage(makeZip(`remote${i}`, { ...base, ...c })).join("\n")).toMatch(/loads remote code/));
    // URLs as data (API endpoints, tag hosts matched by regex) are not code loading
    expect(checkPackage(makeZip("data-url", { ...base, "background.js": 'fetch("https://api.anthropic.com/v1/messages")' }))).toEqual([]);
  });
});
