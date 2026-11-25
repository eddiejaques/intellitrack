// X20: rough CPU/memory overhead of a recorded tab vs the same tab not recorded, in real Chrome.
//   npm run build && node scripts/e2e/perf.mjs [--runs 3]
// Serves scripts/e2e/site on :8123 (the pages hardcode it; don't run it alongside `npm run e2e`) and runs the same journey (home → product → cart → dataLayer →
// SPA) alternately without and with a recording. Per run it reads the tab's CDP Performance metrics
// (script/task time, JS heap) and CPU-profiles the tab and the background worker, so time can be
// attributed to capture steps. Numbers are indicative (headless, one machine), not a benchmark.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, sleep } from "./cdp.mjs";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

// the build is minified: map worker frames back to their source file + function via the source map
const swMap = new TraceMap(readFileSync("dist/background.js.map", "utf8"));

const SITE = fileURLToPath(new URL("./site/", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript" };
const PORT = 8123;
const BURST = 200; // extra GA4 hits fired on the last page, to see the cost per event
const server = createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/ga/")) { res.writeHead(204).end(); return; }
  const file = join(SITE, path === "/" ? "home.html" : path);
  let body;
  try { body = readFileSync(file); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "text/plain" }).end(body);
}).listen(PORT);

const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg >= 0 ? Number(process.argv[runsArg + 1]) : 3;
const JOURNEY = [["home.html", 1500], ["product.html", 2500], ["cart.html", 5000], ["datalayer.html", 2500], ["spa.html", 2500]];

const b = await launch({ port: 9334 });
const { send, page } = b;

// attach to the IntelliTrack service worker
const { targetInfos } = await send("Target.getTargets");
let sw;
for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.includes(b.extId))) {
  sw = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
}
if (!sw) throw new Error("service worker not found");
await send("Performance.enable", {}, page.sid);
await send("Profiler.enable", {}, page.sid);
await send("Profiler.enable", {}, sw);
await send("Profiler.setSamplingInterval", { interval: 200 }, page.sid);
await send("Profiler.setSamplingInterval", { interval: 200 }, sw);

const metrics = async () => Object.fromEntries((await send("Performance.getMetrics", {}, page.sid)).metrics.map((m) => [m.name, m.value]));
const swHeap = async () => (await send("Runtime.getHeapUsage", {}, sw)).usedSize;
const gc = async () => { for (const s of [page.sid, sw]) await send("HeapProfiler.collectGarbage", {}, s).catch(() => {}); };

/** self time (ms) per function, from a CDP CPU profile; idle/program/GC kept apart */
function selfTimes(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000));
  const out = new Map();
  for (const [id, ms] of dt) {
    const f = byId.get(id).callFrame;
    let file = f.url ? f.url.replace(/^.*\//, "") : "(no url)";
    let fn = f.functionName || "(anonymous)";
    if (file === "background.js") {
      const o = originalPositionFor(swMap, { line: f.lineNumber + 1, column: f.columnNumber });
      if (o.source) { file = o.source.replace(/^.*?extension\/src\//, "").replace(/^.*node_modules\//, "npm:"); fn = o.name ?? fn; }
    }
    const key = `${fn} · ${file}`;
    out.set(key, (out.get(key) ?? 0) + ms);
  }
  return out;
}
const add = (into, from) => { for (const [k, v] of from) into.set(k, (into.get(k) ?? 0) + v); };

async function journey(record) {
  await b.goto(`http://localhost:${PORT}/home.html`, 800);
  const tab = await b.tabId(`http://localhost:${PORT}`);
  await gc();
  let script = 0, task = 0, pageHeap = 0;
  const pageSelf = new Map();
  await send("Profiler.start", {}, sw);
  if (record) await b.msg({ type: "start", tabId: tab });
  // tab metrics reset with each document, so take them per page: right after commit, then at the end
  for (const [p, ms] of JOURNEY) {
    await b.goto(`http://localhost:${PORT}/${p}`);
    const a = await metrics();
    await send("Profiler.start", {}, page.sid); // the tab's profile doesn't survive a navigation
    await sleep(ms);
    if (p === "spa.html") {
      await b.evalPage(`for (let i = 0; i < ${BURST}; i++) fetch("http://localhost:${PORT}/ga/perf?v=2&tid=G-PERF0000001&cid=1.2&en=perf_event&ep.n=" + i, { method: "POST", keepalive: true }).catch(() => {})`);
      await sleep(4000);
    }
    add(pageSelf, selfTimes((await send("Profiler.stop", {}, page.sid)).profile));
    const z = await metrics();
    script += (z.ScriptDuration - a.ScriptDuration) * 1000;
    task += (z.TaskDuration - a.TaskDuration) * 1000;
    pageHeap = Math.max(pageHeap, z.JSHeapUsedSize);
  }
  let events = 0;
  if (record) {
    const st = await b.msg({ type: "getState" });
    events = st.eventCount;
    await b.msg({ type: "stop" });
  }
  const swProf = (await send("Profiler.stop", {}, sw)).profile;
  await gc();
  return {
    record, events,
    script, task, pageHeap,
    swHeap: await swHeap(),
    pageSelf,
    swSelf: selfTimes(swProf),
  };
}

const results = [];
try {
  await journey(false); // warm-up: caches, gtag.js download, worker start
  for (let i = 0; i < RUNS; i++) for (const rec of [false, true]) results.push(await journey(rec));
} finally {
  b.close();
  server.close();
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const busy = (m) => [...m].filter(([k]) => !/^\((idle|program|garbage collector|root)\)/.test(k)).reduce((a, [, v]) => a + v, 0);
for (const rec of [false, true]) {
  const rs = results.filter((r) => r.record === rec);
  console.log(`\n${rec ? "RECORDING" : "NOT RECORDING"} (${rs.length} runs${rec ? `, ~${Math.round(avg(rs.map((r) => r.events)))} events each` : ""})`);
  console.log(`  tab:    script ${avg(rs.map((r) => r.script)).toFixed(0)} ms, all tasks ${avg(rs.map((r) => r.task)).toFixed(0)} ms, peak JS heap ${MB(avg(rs.map((r) => r.pageHeap)))}`);
  console.log(`  worker: busy ${avg(rs.map((r) => busy(r.swSelf))).toFixed(0)} ms, heap ${MB(avg(rs.map((r) => r.swHeap)))}`);
  for (const [label, key] of [["tab", "pageSelf"], ["worker", "swSelf"]]) {
    const sum = new Map();
    for (const r of rs) add(sum, r[key]);
    const top = [...sum].filter(([k]) => !/^\((idle|program|root)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    console.log(`  top ${label} self time (avg per run):`);
    for (const [k, v] of top) console.log(`    ${(v / rs.length).toFixed(1).padStart(7)} ms  ${k}`);
  }
}
process.exit(0);
