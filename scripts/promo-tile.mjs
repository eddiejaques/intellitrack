// Chrome Web Store small promo tile: `npm run promo-tile` (after `npm run build`).
// Renders a 440×280 tile from HTML in headless Chrome and writes a 24-bit PNG without alpha to
// docs/store-graphics/small-promo-tile.png. Opaque background only, so the PNG has no alpha channel.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./e2e/cdp.mjs";
import { pngInfo } from "./store-screenshots.mjs";

export const TILE_W = 440;
export const TILE_H = 280;
export const meetsTileSpec = (i) => i.width === TILE_W && i.height === TILE_H && i.bitDepth === 8 && i.colorType === 2;

export function tileHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${TILE_W}px;height:${TILE_H}px;overflow:hidden}
    body{background:linear-gradient(135deg,#4f46e5 0%,#3730a3 100%);color:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
      display:flex;flex-direction:column;justify-content:center;padding:0 40px;box-sizing:border-box}
    .brand{display:flex;align-items:center;gap:16px;margin-bottom:18px}
    .brand svg{width:64px;height:64px;flex:none}
    .name{font-size:40px;font-weight:700;letter-spacing:-.5px}
    .tag{font-size:21px;line-height:1.35;color:#e0e7ff;max-width:360px}
    .chips{display:flex;gap:8px;margin-top:20px}
    .chip{font-size:13px;font-weight:600;padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.16);color:#fff}
  </style></head><body>
    <div class="brand"><svg viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="7" fill="#ffffff"/>
      <circle cx="14" cy="14" r="7.4" fill="none" stroke="#4f46e5" stroke-width="2.6"/><circle cx="14" cy="14" r="2.9" fill="#4f46e5"/></svg>
      <div class="name">IntelliTrack</div></div>
    <div class="tag">Record your GA4 and Google Ads tags, then audit them.</div>
    <div class="chips"><span class="chip">GA4</span><span class="chip">Google Ads</span><span class="chip">Your own LLM</span></div>
  </body></html>`;
}

async function main() {
  const out = resolve(process.argv[2] ?? "docs/store-graphics/small-promo-tile.png");
  mkdirSync(dirname(out), { recursive: true });
  const b = await launch();
  try {
    await b.screenshot(out, TILE_W, TILE_H, `data:text/html;base64,${Buffer.from(tileHtml()).toString("base64")}`);
  } finally {
    b.close();
  }
  const i = pngInfo(readFileSync(out));
  const ok = meetsTileSpec(i);
  console.log(`${ok ? "OK  " : "BAD "} ${out}  ${i.width}x${i.height} depth ${i.bitDepth} colour type ${i.colorType}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
