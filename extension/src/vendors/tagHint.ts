/**
 * Does this request look like a tracking hit, whether or not a vendor parser claims it?
 * Used to record "unrecognized" tags so they can be inspected (and a parser added) instead of
 * silently disappearing. Cheap by design: runs on every request of the recorded tab.
 */
const SKIP_TYPES = new Set(["main_frame", "sub_frame", "stylesheet", "script", "font", "media", "object", "websocket"]);

const TRACKER_HOST = new RegExp(
  "(^|\\.)(" + [
    "google-analytics\\.com", "analytics\\.google\\.com", "googletagmanager\\.com", "doubleclick\\.net", "googleadservices\\.com",
    "facebook\\.(com|net)", "tiktok\\.com", "snapchat\\.com", "sc-static\\.net", "pinterest\\.com", "licdn\\.com", "linkedin\\.com",
    "bat\\.bing\\.com", "clarity\\.ms", "hotjar\\.(com|io)", "criteo\\.(com|net)", "adnxs\\.com", "taboola\\.com", "outbrain\\.com",
    "omtrdc\\.net", "demdex\\.net", "2o7\\.net", "adobedc\\.net", "segment\\.(io|com)", "mixpanel\\.com", "amplitude\\.com",
    "braze\\.com", "appboy\\.com", "klaviyo\\.com", "hubspot\\.(com|net)", "matomo\\.cloud", "piwik\\.pro", "plausible\\.io",
    "tiqcdn\\.com", "tealiumiq\\.com", "mparticle\\.com", "heap(analytics)?\\.com", "fullstory\\.com", "quantserve\\.com",
    "scorecardresearch\\.com", "ioam\\.de", "ivwbox\\.de", "adition\\.com", "awin1\\.com", "webgains\\.com", "trbo\\.com",
    "emetriq\\.de", "etracker\\.(com|de)", "econda(-monitor)?\\.de", "yieldlab\\.net", "ads-twitter\\.com", "salesforce\\.com",
    "evergage\\.com", "igodigital\\.com", "pardot\\.com", "usercentrics\\.eu",
  ].join("|") + ")$", "i");

const TAG_PATH = /(?:^|[/_.-])(collect|track(?:ing|er)?|pixel|beacon|telemetry|pageview|page_view|conversion|analytics|metrics|ingest|hit)(?:[/_.?-]|$)/i;

export function looksLikeTag(url: string, type = "other"): boolean {
  if (SKIP_TYPES.has(type)) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (type === "ping") return true; // sendBeacon / <a ping>
  if (TRACKER_HOST.test(u.hostname)) return true;
  return TAG_PATH.test(u.pathname);
}

/** Best-effort name for an unparsed tag request, so the raw log is readable. Not a parser. */
const GUESSES: [RegExp, string][] = [
  [/(^|\.)(google-analytics\.com|analytics\.google\.com)$/i, "Google Analytics"],
  [/(^|\.)googletagmanager\.com$/i, "Google Tag Manager"],
  [/(^|\.)(doubleclick\.net|googleadservices\.com)$/i, "Google Ads / DV360"],
  [/(^|\.)facebook\.(com|net)$/i, "Meta"],
  [/(^|\.)tiktok\.com$/i, "TikTok"],
  [/(^|\.)bing\.com$/i, "Microsoft Ads"],
  [/(^|\.)criteo\.(com|net)$/i, "Criteo"],
  [/(^|\.)pinterest\.com$/i, "Pinterest"],
  [/(^|\.)(linkedin|licdn)\.com$/i, "LinkedIn"],
  [/(^|\.)(snapchat\.com|sc-static\.net)$/i, "Snapchat"],
  [/(^|\.)(omtrdc\.net|demdex\.net|2o7\.net|adobedc\.net)$/i, "Adobe"],
  [/(^|\.)(segment\.(io|com))$/i, "Segment"],
  [/(^|\.)(braze\.com|appboy\.com)$/i, "Braze"],
  [/(^|\.)hotjar\.(com|io)$/i, "Hotjar"],
  [/(^|\.)clarity\.ms$/i, "Microsoft Clarity"],
  [/(^|\.)(taboola|outbrain)\.com$/i, "Native ads"],
  [/(^|\.)nr-data\.net$|(^|\.)newrelic\.com$/i, "New Relic"],
];
export function guessVendor(url: string): string | undefined {
  try {
    const u = new URL(url);
    for (const [re, name] of GUESSES) if (re.test(u.hostname)) return name === "Google Analytics" && !/\/g\/collect/.test(u.pathname) && /\/collect/.test(u.pathname) ? "Universal Analytics (legacy)" : name;
  } catch { /* ignore */ }
  return undefined;
}
