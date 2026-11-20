// End-to-end smoke test in real Chrome: serves scripts/e2e/site on :8123, records journeys with the
// built extension and checks what was captured. Exit code 1 on a failed check.
//   npm run build && npm run e2e
// Checks marked (network) need internet, because the page loads the real gtag.js; they warn instead of fail offline.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";

const SITE = fileURLToPath(new URL("./site/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/ga/")) { res.writeHead(204).end(); return; } // fake server-side GTM endpoint
  const file = join(SITE, path === "/" ? "home.html" : path);
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" }).end(body);
}).listen(8123);

let failed = 0;
const check = (ok, label, network = false) => {
  if (!ok && !network) failed++;
  console.log(`${ok ? "PASS" : network ? "WARN" : "FAIL"}  ${label}${!ok && network ? " (needs internet)" : ""}`);
};

const b = await launch();
try {
  // 1. cart page: gtag GA4, a custom-path server-side GA4 hit, a Google Ads conversion
  await b.goto("http://localhost:8123/home.html", 1500);
  const tab = await b.tabId("http://localhost:8123");
  const s1 = await b.msg({ type: "start", tabId: tab });
  await b.goto("http://localhost:8123/cart.html", 9000);
  let state = await b.msg({ type: "getState" });
  let events = await b.msg({ type: "getEvents", sessionId: s1.id });
  const names = events.map((e) => `${e.vendor}:${e.event}`);
  console.log(`session ${s1.id}: ${events.length} events: ${names.join(", ")}`);
  check(state.eventCount === events.length && events.length > 0, "badge count matches stored events");
  check(names.includes("ga4:add_to_cart"), "GA4 hit on a custom server-side path is captured");
  check(events.some((e) => e.vendor === "google_ads"), "Google Ads conversion is captured");
  check(names.includes("ga4:view_cart"), "gtag.js GA4 view_cart is captured", true);
  const rows = await b.msg({ type: "getRequests", sessionId: s1.id });
  check(rows.some((r) => r.vendor === "unrecognized"), "unparsed tag-like requests are logged");
  await b.msg({ type: "stop" });

  // 2. a product opened in a new tab from the recorded tab is followed
  await b.goto("http://localhost:8123/home.html", 1500);
  const s2 = await b.msg({ type: "start", tabId: tab });
  await b.goto("http://localhost:8123/home.html", 2500);
  await b.click("#p");
  await sleep(6000);
  events = await b.msg({ type: "getEvents", sessionId: s2.id });
  check(events.some((e) => e.event === "view_item"), "events from a followed new tab are captured", true);
  await b.msg({ type: "stop" });

  // 3. sessions stay separate
  const list = await b.msg({ type: "listSessions" });
  check(list.length >= 2 && new Set(list.map((x) => x.session.id)).size === list.length, "each recording is its own session");

  if (process.env.SHOT) {
    for (const [p, w] of [["viewer.html", 1100], ["panel.html", 420], ["sessions.html", 1000], ["popup.html", 380]]) await b.screenshot(`${process.env.SHOT}/${p.replace(".html", "")}.png`, w, 760, p);
    console.log(`screenshots in ${process.env.SHOT}`);
  }
} catch (e) {
  failed++;
  console.log("FAIL ", e.message);
} finally {
  b.close();
  server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
