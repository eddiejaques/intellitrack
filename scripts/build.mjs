import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
// OUTDIR lets tests build somewhere else; the extension is always loaded from dist/
const out = process.env.OUTDIR || "dist";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync("extension/static", out, { recursive: true });

// package.json is the only place the release version lives; the built manifest gets it from there
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const manifestPath = join(out, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
writeFileSync(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");

const opts = {
  entryPoints: {
    background: "extension/src/background/index.ts",
    popup: "extension/src/ui/popup.ts",
    viewer: "extension/src/ui/viewer.ts",
    preview: "extension/src/ui/preview.ts",
    options: "extension/src/ui/options.ts",
    report: "extension/src/ui/report.ts",
    panel: "extension/src/ui/panel.ts",
    sessions: "extension/src/ui/sessions.ts",
  },
  bundle: true,
  loader: { ".md": "text" },
  // pages and the background worker are built together; a mismatch means the worker is stale
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  format: "iife",
  target: "chrome120",
  outdir: out,
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
} else {
  await build(opts);
}
