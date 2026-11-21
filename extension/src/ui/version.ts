/** "IntelliTrack v0.2.0", from the installed extension's manifest (stamped from package.json at build). */
export const versionLabel = (version: string | undefined) => `IntelliTrack v${version || "?"}`;

export function showVersion(el: HTMLElement | null): void {
  if (!el) return;
  let v: string | undefined;
  try { v = chrome.runtime.getManifest().version; } catch { /* not running as an extension */ }
  el.textContent = versionLabel(v);
}
