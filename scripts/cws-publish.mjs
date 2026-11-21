// Upload a packaged zip to the Chrome Web Store and publish it, with the Chrome Web Store API v2.
//   node scripts/cws-publish.mjs release/intellitrack-X.Y.Z.zip
// Credentials come only from the environment (GitHub Actions secrets): CWS_PUBLISHER_ID,
// CWS_EXTENSION_ID, CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN. None of them, nor the access
// token, is ever printed. With any of them missing, the upload is skipped (exit 0) with a notice.
// Exit 1 when the store rejects the upload or the publish.
//
// API: https://developer.chrome.com/docs/webstore/using-api (v2; v1.1 is superseded).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SECRET_NAMES = ["CWS_PUBLISHER_ID", "CWS_EXTENSION_ID", "CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN"];
const API = "https://chromewebstore.googleapis.com";

/**
 * @param {{ zip: string, env?: Record<string,string|undefined>, fetch?: typeof fetch, log?: (s: string) => void, sleep?: (ms: number) => Promise<void>, pollMs?: number, maxPolls?: number }} o
 * @returns {Promise<{ code: number, state?: string, skipped?: boolean }>}
 */
export async function publishToStore({ zip, env = process.env, fetch: f = fetch, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 5000, maxPolls = 24 }) {
  const missing = SECRET_NAMES.filter((n) => !env[n]);
  if (missing.length) {
    log(`::notice title=Chrome Web Store upload skipped::Secrets not set: ${missing.join(", ")}. The GitHub Release with the zip was still created. See docs/release.md, "One-time setup".`);
    return { code: 0, skipped: true };
  }
  const item = `publishers/${encodeURIComponent(env.CWS_PUBLISHER_ID)}/items/${encodeURIComponent(env.CWS_EXTENSION_ID)}`;
  // Error bodies from Google never contain our secrets, but cap and scrub them anyway.
  const secrets = SECRET_NAMES.map((n) => env[n]).filter((v) => v && v.length > 3);
  const scrub = (s) => secrets.reduce((t, v) => t.split(v).join("***"), String(s)).slice(0, 600);
  const fail = (msg) => { log(`::error title=Chrome Web Store::${scrub(msg)}`); return { code: 1 }; };
  const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };

  const tokRes = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.CWS_CLIENT_ID, client_secret: env.CWS_CLIENT_SECRET, refresh_token: env.CWS_REFRESH_TOKEN, grant_type: "refresh_token" }).toString(),
  });
  const tok = await json(tokRes);
  if (!tokRes.ok || !tok.access_token) return fail(`could not get an access token (HTTP ${tokRes.status}): ${tok.error_description ?? tok.error ?? "no token in response"}. Check CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN.`);
  const auth = { authorization: `Bearer ${tok.access_token}` };
  secrets.push(tok.access_token);

  log(`uploading ${zip} ...`);
  const upRes = await f(`${API}/upload/v2/${item}:upload`, { method: "POST", headers: { ...auth, "content-type": "application/zip" }, body: readFileSync(zip) });
  const up = await json(upRes);
  if (!upRes.ok) return fail(`upload failed (HTTP ${upRes.status}): ${JSON.stringify(up.error ?? up)}`);
  let state = up.uploadState;
  for (let i = 0; i < maxPolls && /IN_PROGRESS/.test(state ?? ""); i++) {
    await sleep(pollMs);
    const st = await json(await f(`${API}/v2/${item}:fetchStatus`, { headers: auth }));
    state = st.lastAsyncUploadState ?? state;
  }
  if (state !== "SUCCEEDED") return fail(`upload did not succeed (state ${state ?? "unknown"}): ${JSON.stringify(up.itemError ?? up.error ?? up).slice(0, 400)}. A rejected upload usually means the version was not increased.`);
  log("upload succeeded");

  const pubRes = await f(`${API}/v2/${item}:publish`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
  const pub = await json(pubRes);
  if (!pubRes.ok) return fail(`publish failed (HTTP ${pubRes.status}): ${JSON.stringify(pub.error ?? pub)}`);
  log(`submitted for publishing: state ${pub.state ?? "unknown"}. The store reviews it before it goes live; the previous version stays live until then.`);
  return { code: 0, state: pub.state };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zip = process.argv[2];
  if (!zip) { console.error("usage: node scripts/cws-publish.mjs release/intellitrack-X.Y.Z.zip"); process.exit(2); }
  const r = await publishToStore({ zip });
  process.exit(r.code);
}
