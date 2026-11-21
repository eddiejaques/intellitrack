/** What a page is made of, for deciding its page type and the site's purpose (X1). Structure only. */
export interface PageFacts {
  schema_types: string[];
  og_type: string;
  /** input types per form (no names, no values) */
  forms: string[][];
  elements: {
    price: boolean;
    add_to_cart: boolean;
    article: boolean;
    search: boolean;
    password: boolean;
    payment: boolean;
    address: boolean;
  };
  /** consent banners / CMPs found in the DOM or script URLs */
  cmp: string[];
  /** shop or CMS platforms found in the DOM or script URLs */
  platform: string[];
}

/**
 * Runs inside the page via chrome.scripting.executeScript({ func }) in the ISOLATED world, so it is
 * serialised and must not reference anything outside its own body, and page globals (window.Shopify,
 * window.OneTrust) are invisible: everything is read from the DOM and script URLs. It reads no form
 * values, no input names, no URL query and no cookies.
 */
export function extractPageFacts(): PageFacts {
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const has = (sel: string) => { try { return !!document.querySelector(sel); } catch { return false; } };
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content ?? "";

  const types: string[] = [];
  const collect = (node: unknown, depth: number): void => {
    if (depth > 8) return;
    if (Array.isArray(node)) return node.forEach((n) => collect(n, depth + 1));
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const t = o["@type"];
    if (typeof t === "string") types.push(t);
    else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.push(x));
    for (const v of Object.values(o)) if (v && typeof v === "object") collect(v, depth + 1);
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try { collect(JSON.parse(s.textContent ?? ""), 0); } catch { /* ignore malformed JSON-LD */ }
  });
  document.querySelectorAll("[itemtype]").forEach((el) => {
    const m = /schema\.org\/(\w+)/.exec(el.getAttribute("itemtype") ?? "");
    if (m) types.push(m[1]);
  });

  const forms = [...document.forms].slice(0, 6).map((f) =>
    [...f.elements]
      .map((el) => (el.tagName.toLowerCase() === "input" ? (el as HTMLInputElement).type || "text" : el.tagName.toLowerCase()))
      .filter((t) => t !== "hidden" && t !== "button" && t !== "submit" && t !== "fieldset")
      .slice(0, 20));

  const buttonText = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [class*="add-to-cart"], [class*="addtocart"]')]
    .slice(0, 200)
    .map((b) => ((b as HTMLInputElement).value || b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60));
  const addToCart = buttonText.some((t) => /add to (cart|bag|basket)|in den warenkorb|ajouter au panier|añadir al carrito|aggiungi al carrello|buy now|jetzt kaufen/i.test(t))
    || has('form[action*="cart/add"], [name="add-to-cart"], [data-action="add-to-cart"], button[name="add"]');

  const priceText = /(?:[€$£₹¥]\s?\d)|(?:\d[\d.,]*\s?(?:€|EUR|USD|GBP|INR|CHF))/;
  const price = has('[itemprop="price"], meta[property="product:price:amount"], meta[property="og:price:amount"]')
    || [...document.querySelectorAll('[class*="price"], [id*="price"]')].slice(0, 30).some((el) => priceText.test(el.textContent ?? ""));

  const auto = (re: RegExp) => [...document.querySelectorAll<HTMLInputElement>("input[autocomplete], select[autocomplete]")].some((i) => re.test(i.getAttribute("autocomplete") ?? ""));

  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean).join(" ");
  const cmp: string[] = [];
  if (has("#onetrust-banner-sdk, #onetrust-consent-sdk") || /cdn\.cookielaw\.org|optanon/i.test(scripts)) cmp.push("OneTrust");
  if (has("#CybotCookiebotDialog") || /consent\.cookiebot\.(com|eu)/i.test(scripts)) cmp.push("Cookiebot");
  if (has("#usercentrics-root, #usercentrics-cmp-ui") || /usercentrics\.eu/i.test(scripts)) cmp.push("Usercentrics");
  if (has("#didomi-host") || /privacy-center\.org|didomi/i.test(scripts)) cmp.push("Didomi");
  if (has('[class*="qc-cmp2"]') || /quantcast\.(mgr\.consensu\.org|com\/choice)|cmp\.quantcast/i.test(scripts)) cmp.push("Quantcast");
  if (!cmp.length) {
    const banner = [...document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]')]
      .slice(0, 20)
      .some((el) => el.querySelector("button, a") && /cookie|consent|einwilligung/i.test(el.textContent ?? ""));
    if (banner) cmp.push("cookie banner");
  }

  const gen = meta('meta[name="generator"]');
  const platform: string[] = [];
  if (/cdn\.shopify\.com|shopifycdn/i.test(scripts) || has('link[href*="cdn.shopify.com"]') || /shopify/i.test(gen)) platform.push("Shopify");
  if (/woocommerce/i.test(gen) || has("body.woocommerce, body.woocommerce-page, .woocommerce")) platform.push("WooCommerce");
  if (has('script[type="text/x-magento-init"], [data-mage-init]') || /magento/i.test(gen)) platform.push("Magento");
  if (/shopware/i.test(gen) || has('[data-shopware], meta[name="shopware"]')) platform.push("Shopware");
  if (/bigcommerce/i.test(scripts + gen)) platform.push("BigCommerce");
  if (/prestashop/i.test(gen)) platform.push("PrestaShop");
  if (/wordpress/i.test(gen) && !platform.includes("WooCommerce")) platform.push("WordPress");
  if (/wix\.com|parastorage/i.test(scripts + gen)) platform.push("Wix");
  if (/squarespace/i.test(scripts + gen)) platform.push("Squarespace");
  if (/hubspot/i.test(gen)) platform.push("HubSpot");

  return {
    schema_types: uniq(types).slice(0, 15),
    og_type: meta('meta[property="og:type"]').slice(0, 40),
    forms,
    elements: {
      price,
      add_to_cart: addToCart,
      article: has("article, [itemprop='articleBody'], meta[property='article:published_time']"),
      search: has('input[type="search"], form[role="search"], [role="search"]'),
      password: has('input[type="password"]'),
      payment: auto(/cc-(number|exp|csc|name)/) || has('iframe[src*="stripe"], iframe[name*="card"], iframe[title*="card" i]'),
      address: auto(/(shipping|billing).*(address-line1|street-address|postal-code)|^address-line1$|^street-address$/),
    },
    cmp,
    platform,
  };
}
