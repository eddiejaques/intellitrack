import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("extension/static", "dist", { recursive: true });

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
  format: "iife",
  target: "chrome120",
  outdir: "dist",
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
