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
  let pushes = await b.msg({ type: "getPushes", sessionId: s1.id });
  check(pushes.some((p) => p.command === "config" && p.name === "G-TEST123456"), "gtag config push on the cart page is recorded");
  const cartDoc = pushes.find((p) => p.name === "view_cart")?.documentId;
  check(!!cartDoc && events.some((e) => e.event === "view_cart" && e.documentId === cartDoc), "pushed view_cart and its GA4 hit share the page load (sent)", true);

  // 1b. dataLayer: a page pushes events that nothing sends; they show as "not sent"
  await b.goto("http://localhost:8123/datalayer.html", 2500);
  pushes = await b.msg({ type: "getPushes", sessionId: s1.id });
  const never = pushes.find((p) => p.name === "never_sent_test");
  console.log(`dataLayer pushes: ${pushes.map((p) => `${p.command}:${p.name ?? "-"}`).join(", ")}`);
  check(!!never, "a push to a dataLayer created after page start is recorded");
  check(pushes.some((p) => p.kind === "gtag" && p.command === "event" && p.name === "generate_lead"), "gtag('event', …) pushed as arguments is recorded");
  check(!!never && never.payload.user_email === "[email:plaintext]" && !JSON.stringify(pushes).includes("jane.doe@example.com"), "pushed email is redacted before storage");
  check(JSON.stringify(await b.evalPage("[window.__ret1, window.__ret2]")) === "[1,3]", "dataLayer.push still returns the array length");
  await b.extGoto(`viewer.html?session=${s1.id}`);
  await b.ext(`document.getElementById("tab-pushes").click()`);
  await sleep(300);
  const verdict = await b.ext(`[...document.querySelectorAll("tr")].find((r) => r.textContent.includes("never_sent_test"))?.dataset.push ?? "missing row"`);
  const label = await b.ext(`[...document.querySelectorAll("tr")].find((r) => r.textContent.includes("never_sent_test"))?.lastElementChild.textContent ?? ""`);
  check(verdict === "not_sent" && label === "not sent", `session log shows never_sent_test as "not sent" (got ${verdict} / ${label})`);
  await b.extGoto("options.html");
  await b.msg({ type: "stop" });

  // 1c. tabs that are not recorded never get the observer
  const other = await b.otherTab("http://localhost:8123/datalayer.html", 1500);
  check(await other("window.__intellitrack_dl === undefined && !Object.getOwnPropertyDescriptor(window.dataLayer, 'push')"), "unrecorded tab: dataLayer.push is not hooked");
  await b.goto("http://localhost:8123/datalayer.html", 1500);
  check(await b.evalPage("window.__intellitrack_dl === undefined"), "recorded tab after Stop: a new page load is not hooked");

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
