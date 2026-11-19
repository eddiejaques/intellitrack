import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

// Mirror esbuild's `.md` -> text loader so prompts can live as markdown files.
export default defineConfig({
  plugins: [{
    name: "md-text",
    transform(_code, id) {
      if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(readFileSync(id, "utf8"))};`, map: null };
    },
  }],
  test: { include: ["tests/**/*.test.ts"] },
});
