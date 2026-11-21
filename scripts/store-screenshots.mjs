// Chrome Web Store screenshots: `npm run screenshots` (after `npm run build`).
// Records a short journey on the local test shop (placeholder IDs only, never a real site) and writes
// five 1280×800 24-bit PNGs (no alpha) to docs/screenshots/store/. Narrow pages (popup, side panel)
// are centred on a plain background with a caption so the frame isn't mostly empty.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./e2e/cdp.mjs";

export const STORE_W = 1280;
export const STORE_H = 800;

/** Width, height, bit depth and colour type from a PNG's IHDR. Colour type 2 = RGB (no alpha), 6 = RGBA. */
export function pngInfo(buf) {
  const sig = "89504e470d0a1a0a";
  if (buf.subarray(0, 8).toString("hex") !== sig || buf.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bitDepth: buf[24], colorType: buf[25] };
}

/** Meets the store's screenshot spec: 1280×800, 8 bits per channel, RGB without alpha. */
export const meetsStoreSpec = (i) => i.width === STORE_W && i.height === STORE_H && i.bitDepth === 8 && i.colorType === 2;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** A 1280×800 page showing a narrow screenshot next to a caption. Opaque background, so no alpha. */
export function frameHtml(pngBase64, title, caption) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${STORE_W}px;height:${STORE_H}px;background:#eef0f7;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2337}
    .wrap{display:flex;align-items:center;justify-content:center;gap:72px;height:100%}
    .txt{max-width:460px}.txt h1{font-size:40px;line-height:1.15;margin:0 0 16px}.txt p{font-size:20px;line-height:1.5;margin:0;color:#4a5070}
    img{border-radius:14px;box-shadow:0 18px 50px rgba(31,35,55,.22);max-height:720px}
  </style></head><body><div class="wrap"><div class="txt"><h1>${esc(title)}</h1><p>${esc(caption)}</p></div>
  <img src="data:image/png;base64,${pngBase64}"></div></body></html>`;
}

async function main() {
  const out = resolve(process.argv[2] ?? "docs/screenshots/store");
  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "it-shots-"));
  const SITE = fileURLToPath(new URL("./e2e/site/", import.meta.url));
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path.startsWith("/ga/")) { res.writeHead(204).end(); return; }
    let body;
    try { body = readFileSync(join(SITE, path === "/" ? "home.html" : path)); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": extname(path) === ".js" ? "text/javascript" : "text/html" }).end(body);
  }).listen(8123);

  const b = await launch();
  const written = [];
  const full = async (name, page) => {
    const f = join(out, name);
    await b.screenshot(f, STORE_W, STORE_H, page);
    written.push(f);
  };
  const framed = async (name, page, w, h, title, caption) => {
    const raw = join(tmp, name);
    await b.screenshot(raw, w, h, page);
    const html = frameHtml(readFileSync(raw).toString("base64"), title, caption);
    await full(name, `data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  };
  try {
    await b.goto("http://localhost:8123/home.html", 1500);
    const tab = await b.tabId("http://localhost:8123");
    const s = await b.msg({ type: "start", tabId: tab });
    await b.goto("http://localhost:8123/product.html", 4000);
    await b.goto("http://localhost:8123/cart.html", 7000);
    await framed("1-popup.png", "popup.html", 380, 640, "Record a real journey", "Start recording on any site. IntelliTrack captures GA4 and Google Ads tags as you browse, and shows the journey it expects.");
    await framed("2-live-panel.png", "panel.html", 420, 760, "Watch tags arrive live", "The side panel counts events and lists every tag request while you click through the site.");
    await b.extGoto("options.html", 500); // messages need an extension page in the helper tab
    await b.msg({ type: "stop" });
    await full("3-session-log.png", `viewer.html?session=${s.id}`);
    await full("4-audit-preview.png", `preview.html?session=${s.id}`);
    // rules-only: nothing is sent anywhere
    await b.ext(`document.getElementById("rules-only").click()`);
    await sleep(2500);
    await full("5-report.png", `report.html?session=${s.id}`);
  } finally {
    b.close();
    server.close();
  }
  let bad = 0;
  for (const f of written) {
    const i = pngInfo(readFileSync(f));
    const ok = meetsStoreSpec(i);
    if (!ok) bad++;
    console.log(`${ok ? "OK  " : "BAD "} ${f}  ${i.width}x${i.height} depth ${i.bitDepth} colour type ${i.colorType}`);
  }
  process.exit(bad || written.length !== 5 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
