// Drives Chrome for Testing over CDP with the built extension (dist/) loaded.
// Install the browser once with: npx playwright install chromium   (or set CHROME=/path/to/chrome)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  // where `npx playwright install chromium` puts Chrome for Testing: macOS, then Linux (CI)
  for (const base of [join(process.env.HOME ?? "", "Library/Caches/ms-playwright"), process.env.PLAYWRIGHT_BROWSERS_PATH, join(process.env.HOME ?? "", ".cache/ms-playwright")]) {
    if (!base || !existsSync(base)) continue;
    const dirs = readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const p of [
        join(base, d, "chrome-mac-arm64", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        join(base, d, "chrome-mac", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
        join(base, d, "chrome-linux64", "chrome"),
        join(base, d, "chrome-linux", "chrome"),
      ]) if (existsSync(p)) return p;
    }
  }
  throw new Error("Chrome for Testing not found: run `npx playwright install chromium` or set CHROME");
}

/**
 * Launch Chrome with the extension and return helpers:
 *   page: { sid, reqs } the tab we browse with (all its network requests are logged in reqs)
 *   ext(expr): evaluate in an extension page (chrome.* APIs available), awaiting promises
 *   msg(obj): chrome.runtime.sendMessage to the background worker
 *   goto(url), click(selector), screenshot(file, width, height, extPage?)
 */
export async function launch({ dist = resolve("dist"), port = 9333 } = {}) {
  if (!existsSync(join(dist, "manifest.json"))) throw new Error(`no build in ${dist}: run npm run build`);
  const proc = spawn(findChrome(), ["--headless=new", "--no-sandbox", "--disable-gpu", `--user-data-dir=${mkdtempSync(join(tmpdir(), "it-"))}`,
    `--remote-debugging-port=${port}`, `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--window-size=1400,900", "about:blank"], { stdio: "ignore" });
  process.on("exit", () => proc.kill());

  let ver;
  for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  if (!ver) throw new Error("Chrome did not start");
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else listeners.forEach((l) => l(d));
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (d) => (d.error ? rej(new Error(`${method}: ${d.error.message}`)) : res(d.result)));
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });

  // find the IntelliTrack service worker (by manifest name, not by position)
  await send("Target.setDiscoverTargets", { discover: true });
  let extId;
  for (let i = 0; i < 60 && !extId; i++) {
    const { targetInfos } = await send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      try {
        const sid = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
        const r = await send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true }, sid);
        if (r.result?.value === "IntelliTrack") { extId = new URL(t.url).host; break; }
      } catch {}
    }
    if (!extId) await sleep(300);
  }
  if (!extId) throw new Error("extension did not load");

  const attach = async () => {
    const t = await send("Target.createTarget", { url: "about:blank" });
    const sid = (await send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
    await send("Page.enable", {}, sid);
    return sid;
  };
  const page = { sid: await attach(), reqs: [] };
  listeners.push((d) => {
    if (d.sessionId === page.sid && d.method === "Network.requestWillBeSent") page.reqs.push({ url: d.params.request.url, method: d.params.request.method, type: d.params.type });
  });
  await send("Network.enable", {}, page.sid);

  const es = await attach();
  await send("Page.navigate", { url: `chrome-extension://${extId}/options.html` }, es);
  await sleep(1500);
  const evalIn = async (sid, expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sid);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  const ext = (expr) => evalIn(es, expr);
  const msg = (obj) => ext(`chrome.runtime.sendMessage(${JSON.stringify(obj)})`);
  const goto = async (url, waitMs = 0) => { await send("Page.navigate", { url }, page.sid); if (waitMs) await sleep(waitMs); };
  const tabId = async (prefix) => (await ext(`chrome.tabs.query({}).then(t=>t.map(x=>({id:x.id,url:x.url})))`)).find((t) => (t.url ?? "").startsWith(prefix))?.id;
  const click = (selector) => evalIn(page.sid, `document.querySelector(${JSON.stringify(selector)}).click()`);
  const screenshot = async (file, width, height, extPage) => {
    // extPage: an extension page (popup.html), or a full http(s)/data: URL
    if (extPage) { await send("Page.navigate", { url: /^(https?|data):/.test(extPage) ? extPage : `chrome-extension://${extId}/${extPage}` }, es); await sleep(1500); }
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, es);
    await sleep(500);
    const shot = await send("Page.captureScreenshot", { format: "png" }, es);
    (await import("node:fs")).writeFileSync(file, Buffer.from(shot.data, "base64"));
  };
  /** open an extension page in the helper tab (ext() then runs there) */
  const extGoto = async (extPage, waitMs = 1500) => { await send("Page.navigate", { url: `chrome-extension://${extId}/${extPage}` }, es); await sleep(waitMs); };
  /** open a URL in a fresh tab nobody records; returns an evaluate function for it */
  const otherTab = async (url, waitMs = 0) => {
    const sid = await attach();
    await send("Page.navigate", { url }, sid);
    if (waitMs) await sleep(waitMs);
    return (expr) => evalIn(sid, expr);
  };
  return { send, extId, page, ext, extGoto, otherTab, msg, goto, tabId, click, screenshot, evalPage: (e) => evalIn(page.sid, e), close: () => proc.kill() };
}
