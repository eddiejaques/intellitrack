// README usage-explainer slide: `npm run usage-slide` (after `npm run build`).
// Renders a single 1920×1080 (16:9) PNG from HTML in headless Chrome, showing the four-step
// "how to use it" flow in the clearest terms, and writes a 24-bit PNG without alpha to
// docs/store-graphics/usage-slide.png. Opaque background only, so the PNG has no alpha channel.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./e2e/cdp.mjs";
import { pngInfo } from "./store-screenshots.mjs";

export const SLIDE_W = 1920;
export const SLIDE_H = 1080;
export const meetsSlideSpec = (i) => i.width === SLIDE_W && i.height === SLIDE_H && i.bitDepth === 8 && i.colorType === 2;

/** The four steps shown on the slide, in order. Kept short so each reads at a glance. */
export const STEPS = [
  { n: "1", title: "Install", body: "Load the unlisted Chrome Web Store build, or load dist/ unpacked. Pin it to the toolbar." },
  { n: "2", title: "Start recording", body: "Open the panel on the site you want to check and click Start. No setup, no login required." },
  { n: "3", title: "Browse the journey", body: "Click through as a shopper would: product → cart → checkout. IntelliTrack captures every tag fired." },
  { n: "4", title: "Review the audit", body: "Click Audit. Your own LLM key reviews the session and reports what's missing, wrong, or at risk." },
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function slideHtml() {
  const steps = STEPS.map(
    (s) => `<div class="step">
      <div class="num">${esc(s.n)}</div>
      <div class="body"><h2>${esc(s.title)}</h2><p>${esc(s.body)}</p></div>
    </div>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;background:#12153a;
      font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;box-sizing:border-box}
    .wrap{display:flex;flex-direction:column;height:100%;padding:72px 96px;box-sizing:border-box}
    .brand{display:flex;align-items:center;gap:20px;margin-bottom:12px}
    .brand svg{width:72px;height:72px;flex:none}
    .name{font-size:44px;font-weight:700;letter-spacing:-.5px}
    .tag{font-size:26px;color:#c7cdf5;margin:0 0 48px}
    .steps{display:flex;gap:40px;flex:1}
    .step{flex:1;background:rgba(255,255,255,.06);border-radius:20px;padding:36px 32px;display:flex;flex-direction:column}
    .num{width:56px;height:56px;border-radius:50%;background:#4f46e5;color:#fff;font-size:26px;font-weight:700;
      display:flex;align-items:center;justify-content:center;margin-bottom:24px}
    .step h2{font-size:28px;margin:0 0 14px}
    .step p{font-size:19px;line-height:1.5;color:#dfe2f7;margin:0}
  </style></head><body><div class="wrap">
    <div class="brand"><svg viewBox="0 0 28 28" aria-hidden="true"><rect width="28" height="28" rx="7" fill="#ffffff"/>
      <circle cx="14" cy="14" r="7.4" fill="none" stroke="#4f46e5" stroke-width="2.6"/><circle cx="14" cy="14" r="2.9" fill="#4f46e5"/></svg>
      <div class="name">IntelliTrack</div></div>
    <p class="tag">Record your tags, then audit them with your own LLM — in four steps.</p>
    <div class="steps">${steps}</div>
  </div></body></html>`;
}

async function main() {
  const out = resolve(process.argv[2] ?? "docs/store-graphics/usage-slide.png");
  mkdirSync(dirname(out), { recursive: true });
  const b = await launch();
  try {
    await b.screenshot(out, SLIDE_W, SLIDE_H, `data:text/html;base64,${Buffer.from(slideHtml()).toString("base64")}`);
  } finally {
    b.close();
  }
  const i = pngInfo(readFileSync(out));
  const ok = meetsSlideSpec(i);
  console.log(`${ok ? "OK  " : "BAD "} ${out}  ${i.width}x${i.height} depth ${i.bitDepth} colour type ${i.colorType}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
