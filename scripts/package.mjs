// npm run package: build, then zip dist/ into release/intellitrack-X.Y.Z.zip for the Chrome Web Store,
// and check the zip before anyone uploads it. Exit 1 if a check fails.
//   OUTDIR / RELEASE_DIR override dist/ and release/ (used by the tests).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const unzipList = (zip) => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
const unzipRead = (zip, entry) => execFileSync("unzip", ["-p", zip, entry], { encoding: "utf8", maxBuffer: 64 << 20 });

/** Script URLs that would load remotely hosted code, which MV3 (and the store) forbid. */
const REMOTE_CODE = [
  /<script[^>]+src\s*=\s*["']?(?:https?:)?\/\//i, // <script src="https://…"> in a page
  /importScripts\s*\(\s*["'`](?:https?:)?\/\//, // worker importing a remote script
  /\bimport\s*\(\s*["'`](?:https?:)?\/\//, // dynamic import of a URL
  /\bimport\s[^;]*?from\s*["'`]https?:\/\//, // static import of a URL
];

/** Problems with a packaged zip; empty when it is fit to upload. */
export function checkPackage(zip) {
  const problems = [];
  const entries = unzipList(zip);
  if (!entries.includes("manifest.json")) return ["manifest.json is not at the root of the zip"];
  let m;
  try { m = JSON.parse(unzipRead(zip, "manifest.json")); } catch (e) { return [`manifest.json is not valid JSON: ${e.message}`]; }
  if (m.manifest_version !== 3) problems.push(`manifest_version is ${m.manifest_version}, expected 3`);
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version)) problems.push(`manifest version "${m.version}" is not X.Y.Z`);
  const icons = [...Object.values(m.icons ?? {}), ...Object.values(m.action?.default_icon ?? {})];
  for (const icon of new Set(icons)) if (!entries.includes(icon)) problems.push(`icon ${icon} named in the manifest is missing`);
  const local = [m.background?.service_worker, m.action?.default_popup, m.options_ui?.page, m.side_panel?.default_path].filter(Boolean);
  for (const f of local) {
    if (/^(?:https?:)?\/\//.test(f)) problems.push(`manifest points at remote code: ${f}`);
    else if (!entries.includes(f)) problems.push(`${f} named in the manifest is missing`);
  }
  for (const e of entries) {
    if (e.endsWith(".map")) problems.push(`source map in the zip: ${e}`);
    if (/(^|\/)(tests?|fixtures|node_modules|src)\//.test(e) || /\.(ts|mts|tsx)$/.test(e) || /\.test\./.test(e)) problems.push(`source, test or fixture file in the zip: ${e}`);
    if (/(^|\/)\.DS_Store$/.test(e)) problems.push(`stray file in the zip: ${e}`);
    if (/\.(m?js|html)$/.test(e)) {
      const text = unzipRead(zip, e);
      for (const re of REMOTE_CODE) if (re.test(text)) { problems.push(`${e} loads remote code (${re.source.slice(0, 40)}…)`); break; }
    }
  }
  return problems;
}

/** Build and zip. Returns the zip path. */
export function packageExtension({ outDir = process.env.OUTDIR || "dist", releaseDir = process.env.RELEASE_DIR || "release" } = {}) {
  execFileSync(process.execPath, ["scripts/build.mjs"], { env: { ...process.env, OUTDIR: outDir }, stdio: ["ignore", "ignore", "pipe"] }); // build errors surface in the thrown error
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  mkdirSync(releaseDir, { recursive: true });
  const zip = resolve(releaseDir, `intellitrack-${version}.zip`);
  rmSync(zip, { force: true });
  execFileSync("zip", ["-q", "-r", "-X", zip, ".", "-x", "*.map", "-x", "*.DS_Store"], { cwd: outDir });
  return zip;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zip = packageExtension();
  const problems = checkPackage(zip);
  if (problems.length) {
    console.error(`${zip} failed its checks:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`${join("release", zip.split("/").pop())} (${unzipList(zip).length} files) passed: manifest at root, MV3, icons present, no source maps, no tests, no remote code`);
}
