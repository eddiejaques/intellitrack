// Bundle scripts/eval.ts (it imports extension code and .md prompts) and run it under Node.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";

await build({
  entryPoints: ["scripts/eval.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: ".eval/eval.mjs",
  loader: { ".md": "text" },
  packages: "external",
  logLevel: "warning",
});
const r = spawnSync(process.execPath, [".eval/eval.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
