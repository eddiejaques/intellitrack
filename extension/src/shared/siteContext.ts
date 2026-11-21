import type { PageFacts } from "../content/pageFacts";

export const PAGE_TYPES = [
  "home", "listing", "product", "cart", "checkout", "confirmation", "content", "lead_form", "account", "search", "other",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];
export type SiteType = "ecommerce" | "lead_generation" | "content" | "other";

/** Page types where e-commerce parameters (items, value, currency) are expected. */
export const COMMERCE_PAGES: ReadonlySet<PageType> = new Set(["product", "listing", "cart", "checkout", "confirmation"]);
const SHOP_PLATFORMS = new Set(["Shopify", "WooCommerce", "Magento", "Shopware", "BigCommerce", "PrestaShop"]);
/** add_to_cart, begin_checkout, purchase: the events that make a session e-commerce on their own */
const SHOP_EVENTS = new Set(["add_to_cart", "begin_checkout", "purchase"]);
const LEAD_EVENTS = new Set(["generate_lead", "form_submit", "sign_up", "qualify_lead"]);

/** One captured page of a recording. Keyed by the same normalised path the audit payload uses. */
export interface PageEntry {
  path: string;
  page_type: PageType;
  /** short reason the classifier gave, for the viewer and tests */
  reason: string;
  tabId: number;
  /** ms since epoch, when it was last captured */
  t: number;
  cmp: string[];
  platform: string[];
}

export interface SiteSignals {
  tags: { gtm: string[]; ga4: string[]; ads: string[] };
  cmp: string[];
  platform: string[];
}

export interface SiteInfo {
  type: SiteType;
  why: string;
  signals: SiteSignals;
}

const segs = (path: string) =>
  path.toLowerCase().split("/").filter(Boolean).map((s) => s.replace(/\.(html?|php|aspx?|jsp)$/, ""));
const anySeg = (ss: string[], re: RegExp) => ss.some((s) => re.test(s));

/**
 * Decides what kind of page this is from its path, schema.org types, og:type and page elements.
 * Pure. Path keywords for the late funnel (confirmation, checkout, cart) come first because they are
 * the most explicit; page elements come last because they are the noisiest.
 */
export function classifyPage(path: string, facts?: Partial<PageFacts>): { type: PageType; reason: string } {
  const ss = segs(path);
  const types = new Set((facts?.schema_types ?? []).map((t) => t.toLowerCase()));
  const og = (facts?.og_type ?? "").toLowerCase();
  const el = facts?.elements;
  const r = (type: PageType, reason: string) => ({ type, reason });

  if (anySeg(ss, /^(thank-?you|thanks|danke|order-?(received|confirmation|complete|success)|confirmation|checkout-?success|success|bestellbestaetigung)$/)) return r("confirmation", "path");
  if (anySeg(ss, /^(checkout|kasse|payment|shipping|onepage)$/) || types.has("checkoutpage")) return r("checkout", ss.length ? "path" : "schema");
  if (anySeg(ss, /^(cart|basket|bag|warenkorb|panier|carrito|carrello|shopping-?cart)$/)) return r("cart", "path");
  if (el?.payment || el?.address) return r("checkout", "payment or address fields");
  if (ss.length === 0 || (ss.length === 1 && /^(home|index|start|default|homepage)$/.test(ss[0]))) return r("home", "path");
  if (anySeg(ss, /^(account|my-?account|login|log-?in|signin|sign-?in|register|signup|sign-?up|profile|konto|anmelden)$/)) return r("account", "path");
  if (anySeg(ss, /^(search|suche|recherche|buscar|results)$/) || types.has("searchresultspage")) return r("search", ss.length ? "path" : "schema");
  if (types.has("product") || og === "product" || og === "og:product") return r("product", "schema");
  const pIdx = ss.findIndex((s) => /^(products?|produkte?|item|p|dp|artikel)$/.test(s));
  if (pIdx >= 0 && (ss[pIdx] !== "products" || pIdx < ss.length - 1)) return r("product", "path");
  if (types.has("itemlist") || types.has("collectionpage") || types.has("offercatalog")) return r("listing", "schema");
  if (anySeg(ss, /^(products|collections?|category|categories|c|shop|catalog|catalogue|kategorie|store|sale)$/)) return r("listing", "path");
  if (el?.price && el.add_to_cart) return r("product", "price and add-to-cart button");
  if (types.has("contactpage") || anySeg(ss, /^(contact|contact-us|kontakt|quote|get-a-quote|demo|request-a-demo|book-a-demo|enquiry|inquiry|get-started|lead)$/)) return r("lead_form", types.has("contactpage") ? "schema" : "path");
  if (el?.password) return r("account", "password field");
  if (types.has("article") || types.has("blogposting") || types.has("newsarticle") || og === "article") return r("content", "schema");
  if (anySeg(ss, /^(blog|news|article|articles|post|posts|magazine|journal|guide|guides|help|faq|about|about-us|ratgeber|stories)$/)) return r("content", "path");
  if (leadForm(facts?.forms ?? [])) return r("lead_form", "form fields");
  if (el?.article) return r("content", "article markup");
  return r("other", "no signal");
}

/** A form that asks for contact details: an email or phone field plus at least one more field. */
function leadForm(forms: string[][]): boolean {
  return forms.some((f) => !f.includes("password") && !f.includes("search") && (f.includes("email") || f.includes("tel")) && f.length >= 3);
}

export function siteSignals(pages: Pick<PageEntry, "cmp" | "platform">[], tagLoads?: Record<string, number>): SiteSignals {
  const ids = Object.keys(tagLoads ?? {});
  const pick = (re: RegExp) => ids.filter((i) => re.test(i)).sort();
  return {
    tags: { gtm: pick(/^GTM-/), ga4: pick(/^G-/), ads: pick(/^AW-/) },
    cmp: [...new Set(pages.flatMap((p) => p.cmp))].sort(),
    platform: [...new Set(pages.flatMap((p) => p.platform))].sort(),
  };
}

/** The site's purpose from the pages seen (and the events, when known). Pure. */
export function inferSite(
  pages: Pick<PageEntry, "page_type" | "cmp" | "platform">[],
  events: { event: string }[] = [],
  tagLoads?: Record<string, number>,
): SiteInfo {
  const signals = siteSignals(pages, tagLoads);
  const count = (t: PageType) => pages.filter((p) => p.page_type === t).length;
  const shopPages = [...COMMERCE_PAGES].filter((t) => t !== "listing" && count(t) > 0);
  const shopPlatform = signals.platform.filter((p) => SHOP_PLATFORMS.has(p));
  const shopEvents = [...new Set(events.map((e) => e.event).filter((e) => SHOP_EVENTS.has(e)))];
  const why = (parts: string[]) => parts.filter(Boolean).join("; ");

  if (shopPages.length || shopPlatform.length || shopEvents.length) {
    return {
      type: "ecommerce", signals,
      why: why([
        shopPages.length ? `pages seen: ${shopPages.join(", ")}` : "",
        shopPlatform.length ? `${shopPlatform.join(", ")} store` : "",
        shopEvents.length ? `${shopEvents.join(", ")} fired` : "",
      ]),
    };
  }
  const leadEvents = [...new Set(events.map((e) => e.event).filter((e) => LEAD_EVENTS.has(e)))];
  if (count("lead_form") || leadEvents.length) {
    return { type: "lead_generation", signals, why: why([count("lead_form") ? "contact or lead form page seen" : "", leadEvents.length ? `${leadEvents.join(", ")} fired` : ""]) };
  }
  if (count("content")) return { type: "content", signals, why: `${count("content")} content page(s) and no shop or lead pages` };
  return { type: "other", signals, why: pages.length ? "no shop, lead or content pages seen" : "no pages captured" };
}

export const SITE_LABEL: Record<SiteType, string> = { ecommerce: "Shop", lead_generation: "Lead gen", content: "Content site", other: "Site" };
export const PAGE_LABEL: Record<PageType, string> = {
  home: "home page", listing: "listing page", product: "product page", cart: "cart", checkout: "checkout", confirmation: "order confirmation",
  content: "content page", lead_form: "lead form", account: "account page", search: "search results", other: "other page",
};

/** "Shop · product page": the site type and the page type of the newest page seen in this tab (or any tab). */
export function contextLabel(pages: PageEntry[] | undefined, tabId?: number): string | undefined {
  if (!pages?.length) return undefined;
  const newest = (ps: PageEntry[]) => ps.reduce((a, b) => (b.t > a.t ? b : a));
  const inTab = tabId === undefined ? [] : pages.filter((p) => p.tabId === tabId);
  const page = newest(inTab.length ? inTab : pages);
  return `${SITE_LABEL[inferSite(pages).type]} · ${PAGE_LABEL[page.page_type]}`;
}
