// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractPageFacts, type PageFacts } from "../extension/src/content/pageFacts";
import { classifyPage, contextLabel, inferSite, siteSignals, type PageEntry, type PageType } from "../extension/src/shared/siteContext";
import { capturePage, createScheduler, upsertPage, MAX_PAGES, type SiteContextDeps } from "../extension/src/background/siteContext";
import { runRules } from "../extension/src/rules";
import { buildPayload, findRawPii } from "../extension/src/minimize";
import { ecommerceClean, ev, session } from "../fixtures/sessions";
import type { SessionMeta } from "../extension/src/shared/types";

function facts(html: string): PageFacts {
  document.documentElement.innerHTML = html;
  return extractPageFacts();
}
const page = (path: string, page_type: PageType, over: Partial<PageEntry> = {}): PageEntry =>
  ({ path, page_type, reason: "test", tabId: 1, t: 0, cmp: [], platform: [], ...over });

describe("classifyPage: one fixture per page type", () => {
  const cases: [PageType, string, string][] = [
    ["home", "/", "<body><h1>Welcome</h1><a href='/blog'>Blog</a></body>"],
    ["listing", "/collections/shirts", "<body><h1>Shirts</h1><div class='price'>€19.90</div></body>"],
    ["product", "/blue-shirt", `<head><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"19.90"}}</script></head><body><h1>Blue shirt</h1></body>`],
    ["cart", "/cart", "<body><h1>Your cart</h1></body>"],
    ["checkout", "/secure/step-2", `<body><form><input autocomplete="cc-number"><input autocomplete="cc-exp"></form></body>`],
    ["confirmation", "/checkout/order-received/123", "<body><h1>Thank you</h1></body>"],
    ["content", "/2026/05/how-we-measure", `<head><meta property="og:type" content="article"></head><body><article><h1>How we measure</h1></article></body>`],
    ["lead_form", "/contact-us", "<body><form><input type='text'><input type='email'><textarea></textarea></form></body>"],
    ["account", "/my-account", "<body><form><input type='email'><input type='password'></form></body>"],
    ["search", "/search", "<body><form role='search'><input type='search'></form></body>"],
    ["other", "/legal-stuff", "<body><p>Terms</p></body>"],
  ];
  for (const [type, path, html] of cases) {
    it(`${type}: ${path}`, () => expect(classifyPage(path, facts(html)).type).toBe(type));
  }

  it("the e2e test pages: home, product and cart by path alone", () => {
    expect(classifyPage("/home.html").type).toBe("home");
    expect(classifyPage("/index.html").type).toBe("home");
    expect(classifyPage("/product.html").type).toBe("product");
    expect(classifyPage("/cart.html").type).toBe("cart");
  });

  it("uses page elements when the path says nothing", () => {
    const f = facts("<body><h1>Sofa</h1><span class='product-price'>499,00 €</span><button>Add to cart</button></body>");
    expect(f.elements).toMatchObject({ price: true, add_to_cart: true });
    expect(classifyPage("/sofa-grey-3-seater", f)).toEqual({ type: "product", reason: "price and add-to-cart button" });
    // a form asking for contact details on an otherwise plain page
    expect(classifyPage("/talk-to-sales", facts("<form><input type='text'><input type='email'><input type='tel'></form>")).type).toBe("lead_form");
  });

  it("/products alone is a listing, /products/<handle> a product", () => {
    expect(classifyPage("/products").type).toBe("listing");
    expect(classifyPage("/products/blue-shirt").type).toBe("product");
  });
});

describe("extractPageFacts", () => {
  it("detects consent banners and platforms from the DOM and script URLs only", () => {
    const f = facts(`<head><meta name="generator" content="WooCommerce 8.1"><script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"></script></head>
      <body class="woocommerce"><div id="CybotCookiebotDialog"></div></body>`);
    expect(f.cmp).toEqual(["OneTrust", "Cookiebot"]);
    expect(f.platform).toEqual(["WooCommerce"]);
    expect(facts(`<head><script src="https://cdn.shopify.com/s/trekkie.js"></script></head><body></body>`).platform).toEqual(["Shopify"]);
    expect(facts(`<body><script type="text/x-magento-init">{}</script></body>`).platform).toEqual(["Magento"]);
  });

  it("falls back to a generic cookie banner heuristic", () => {
    expect(facts(`<body><div class="cookie-notice">We use cookies <button>OK</button></div></body>`).cmp).toEqual(["cookie banner"]);
    expect(facts(`<body><p>No banner</p></body>`).cmp).toEqual([]);
  });

  it("collects structure only: no form values, input names or text", () => {
    const f = facts(`<body><form><input type="email" name="secret_name" value="jane@x.io"><input type="hidden" value="t0k3n"></form><p>Call jane@x.io</p></body>`);
    expect(f.forms).toEqual([["email"]]);
    const json = JSON.stringify(f);
    for (const s of ["jane", "secret_name", "t0k3n"]) expect(json).not.toContain(s);
  });
});

describe("inferSite", () => {
  it("ecommerce from shop pages, a shop platform or shop events", () => {
    expect(inferSite([page("/", "home"), page("/p/1", "product")]).type).toBe("ecommerce");
    expect(inferSite([page("/", "home", { platform: ["Shopify"] })]).type).toBe("ecommerce");
    expect(inferSite([page("/", "home")], [{ event: "add_to_cart" }])).toMatchObject({ type: "ecommerce", why: "add_to_cart fired" });
  });
  it("lead generation, content and other", () => {
    expect(inferSite([page("/", "home"), page("/contact", "lead_form")]).type).toBe("lead_generation");
    expect(inferSite([page("/", "home"), page("/blog/a", "content")]).type).toBe("content");
    expect(inferSite([page("/", "home")]).type).toBe("other");
  });
  it("site signals come from tag loads and every page seen", () => {
    expect(siteSignals([page("/", "home", { cmp: ["OneTrust"] }), page("/a", "content", { cmp: ["OneTrust"], platform: ["WordPress"] })],
      { "GTM-ABC": 1, "G-XYZ": 2, "AW-123": 1 })).toEqual({
      tags: { gtm: ["GTM-ABC"], ga4: ["G-XYZ"], ads: ["AW-123"] }, cmp: ["OneTrust"], platform: ["WordPress"],
    });
  });
  it("contextLabel names the site and the newest page of the tab", () => {
    const pages = [page("/", "home", { t: 1, tabId: 1 }), page("/p/1", "product", { t: 2, tabId: 1 }), page("/cart", "cart", { t: 3, tabId: 2 })];
    expect(contextLabel(pages, 1)).toBe("Shop · product page");
    expect(contextLabel(pages)).toBe("Shop · cart");
    expect(contextLabel([])).toBeUndefined();
  });
});

describe("capture during recording", () => {
  const facts0: PageFacts = { schema_types: [], og_type: "", forms: [], elements: { price: false, add_to_cart: false, article: false, search: false, password: false, payment: false, address: false }, cmp: ["Didomi"], platform: [] };
  function deps(url: string, s: Partial<SessionMeta> = {}) {
    let state = { id: "s1", tabId: 1, status: "recording", startedAt: 0, markers: [], origins: [], eventCount: 0, nextEvt: 0, nextReq: 0, ...s } as SessionMeta;
    const d: SiteContextDeps & { state: () => SessionMeta; set: (p: Partial<SessionMeta>) => void } = {
      loadSession: async () => state,
      updateSession: async (fn) => fn(state),
      tabUrl: async () => url,
      extract: async () => facts0,
      now: () => 42,
      state: () => state,
      set: (p) => { state = { ...state, ...p }; },
    };
    return d;
  }

  it("stores the page type by normalised path, never the query or hash", async () => {
    const d = deps("https://shop.example/cart?email=jane%40x.io#top");
    const e = await capturePage(1, d);
    expect(e).toMatchObject({ path: "/cart", page_type: "cart", cmp: ["Didomi"], tabId: 1, t: 42 });
    expect(JSON.stringify(d.state().site_context)).not.toContain("jane");
  });

  it("ignores tabs that are not recorded, stopped sessions, and a Stop that lands mid-capture", async () => {
    expect(await capturePage(7, deps("https://a.example/"))).toBeUndefined();
    expect(await capturePage(1, deps("https://a.example/", { status: "stopped" }))).toBeUndefined();
    expect(await capturePage(1, deps("chrome://newtab/"))).toBeUndefined();
    const d = deps("https://a.example/");
    d.extract = async () => { d.set({ status: "stopped" }); return facts0; };
    expect(await capturePage(1, d)).toBeUndefined();
    expect(d.state().site_context).toBeUndefined();
  });

  it("captures followed tabs too", async () => {
    expect(await capturePage(5, deps("https://a.example/product/1", { tabIds: [1, 5] }))).toMatchObject({ page_type: "product", tabId: 5 });
  });

  it("a hash change or reload of the same page replaces its entry; pages are capped", () => {
    const s = { site_context: { pages: [] } } as unknown as SessionMeta;
    upsertPage(s, page("/a", "other", { t: 1 }));
    upsertPage(s, page("/a", "content", { t: 2 }));
    expect(s.site_context!.pages).toEqual([page("/a", "content", { t: 2 })]);
    for (let i = 0; i < MAX_PAGES + 5; i++) upsertPage(s, page(`/p${i}`, "other"));
    expect(s.site_context!.pages).toHaveLength(MAX_PAGES);
  });

  it("debounces: several URL changes in a row capture once", async () => {
    const d = deps("https://a.example/");
    let reads = 0;
    d.extract = async () => { reads++; return facts0; };
    const schedule = createScheduler(d, 10);
    schedule(1); schedule(1); schedule(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(reads).toBe(1);
  });
});

describe("e-commerce rules follow the page type", () => {
  const contentSession = () => [
    ev(0, "page_view", { page: { path: "/" } }),
    ev(1, "page_view", { page: { path: "/blog/how-we-measure" } }),
    ev(2, "scroll", { page: { path: "/blog/how-we-measure" }, params: { percent_scrolled: 90 } }),
    // a custom event carrying a value but no currency: not an e-commerce event, on a content page
    ev(3, "newsletter_signup", { page: { path: "/blog/how-we-measure" }, params: { value: 1 } }),
  ];
  const contentPages = { "/": "home", "/blog/how-we-measure": "content" } as const;
  const ecom = (fs: { category: string; title: string }[]) => fs.filter((f) => /currency|items|value|transaction_id/.test(f.title));

  it("silent on a content-page session, even if the site is a shop", () => {
    expect(ecom(runRules(contentSession(), { site: "content", pageTypes: contentPages }).findings)).toEqual([]);
    expect(ecom(runRules(contentSession(), { site: "ecommerce", pageTypes: contentPages }).findings)).toEqual([]);
  });

  it("still fires on a product page", () => {
    const evs = [ev(0, "page_view", { page: { path: "/p/1" } }), ev(1, "wishlist_add", { page: { path: "/p/1" }, params: { value: 19.9 } })];
    const fs = runRules(evs, { site: "ecommerce", pageTypes: { "/p/:id": "product" } }).findings;
    expect(fs.map((f) => f.title)).toContain("value sent without currency");
  });

  it("e-commerce events are checked wherever they fire", () => {
    const evs = [ev(0, "add_to_cart", { page: { path: "/blog/gift-guide" }, params: { value: 10 } })];
    const fs = runRules(evs, { site: "content", pageTypes: { "/blog/gift-guide": "content" } }).findings;
    expect(fs.map((f) => f.title)).toContain("value sent without currency");
  });

  it("without captured pages, nothing changes", () => {
    expect(runRules(ecommerceClean())).toEqual(runRules(ecommerceClean(), {}));
  });
});

describe("audit payload", () => {
  it("carries a site block and a page_type per page", () => {
    const events = [ev(0, "page_view", { page: { path: "/" } }), ev(1, "view_item", { page: { path: "/p/123" } })];
    const p = buildPayload({
      session: { ...session(), tag_loads: { "G-ABC123": 1, "GTM-XYZ": 1 }, site_context: { pages: [page("/", "home", { cmp: ["OneTrust"] }), page("/p/:id", "product")] } },
      events,
    });
    expect(p.site).toMatchObject({ type: "ecommerce", signals: { tags: { gtm: ["GTM-XYZ"], ga4: ["G-ABC123"] }, cmp: ["OneTrust"] } });
    expect(p.site!.why).toContain("product");
    expect(p.pages.map((x) => [x.path, x.page_type])).toEqual([["/", "home"], ["/p/:id", "product"]]);
    const byId = Object.fromEntries(p.pages.map((x) => [x.id, x.page_type]));
    expect(p.events.map((e) => byId[e.page!])).toEqual(["home", "product"]);
    expect(findRawPii(p)).toEqual([]);
  });

  it("older sessions without page context have no site block", () => {
    const p = buildPayload({ session: session(), events: ecommerceClean() });
    expect(p.site).toBeUndefined();
    expect(p.pages.every((x) => x.page_type === undefined)).toBe(true);
  });
});
