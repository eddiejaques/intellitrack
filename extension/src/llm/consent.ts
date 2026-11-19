export type SiteConsent = "always" | "ask" | "never";
const KEY = "site_consent";

/** May page info (structure only, no PII) be sent to the configured provider for this site? */
export async function getConsent(origin: string): Promise<SiteConsent | undefined> {
  const r = await chrome.storage.local.get(KEY);
  return (r[KEY] as Record<string, SiteConsent> | undefined)?.[origin];
}

export async function setConsent(origin: string, value: SiteConsent): Promise<void> {
  const r = await chrome.storage.local.get(KEY);
  await chrome.storage.local.set({ [KEY]: { ...(r[KEY] as object | undefined), [origin]: value } });
}
