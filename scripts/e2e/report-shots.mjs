// Manual, one-off helper (not run by `npm run e2e`): records a short session, runs a rules-only
// report, and screenshots report.html at 380px in light and dark, to verify X3's short findings.
//   node scripts/e2e/report-shots.mjs /tmp/out-dir
import { createServer } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const SITE = fileURLToPath(new URL("./site/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/ga/")) { res.writeHead(204).end(); return; }
  const file = join(SITE, path === "/" ? "home.html" : path);
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" }).end(body);
}).listen(8124);

const out = process.argv[2] ?? "/tmp/report-shots";
mkdirSync(out, { recursive: true });

const b = await launch();
try {
  await b.goto("http://localhost:8124/home.html", 1000);
  const tab = await b.tabId("http://localhost:8124");
  const s = await b.msg({ type: "start", tabId: tab });
  await b.goto("http://localhost:8124/cart.html", 9000);
  await b.goto("http://localhost:8124/noconsent.html", 1500);
  await b.msg({ type: "stop" });
  await b.extGoto(`preview.html?session=${s.id}`, 1200);
  await b.ext(`document.getElementById("rules-only").click()`);
  await sleep(1500);
  for (const theme of ["light", "dark"]) {
    await b.screenshot(`${out}/report-${theme}-380.png`, 380, 1400, undefined, theme);
  }
  console.log(`screenshots in ${out}`);
} finally {
  b.close();
  server.close();
}
