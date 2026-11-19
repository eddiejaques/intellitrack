// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractPageContext } from "../extension/src/content/pageContext";

function load(html: string, url: string) {
  document.documentElement.innerHTML = html;
  Object.defineProperty(window, "location", { value: new URL(url), writable: true, configurable: true });
}

describe("extractPageContext", () => {
  it("collects structure and nothing personal", () => {
    load(`<head><title>Blue Shirt | Shop</title>
      <meta name="description" content="A shirt. Questions: help@shop.example">
      <meta property="og:type" content="product">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","offers":{"@type":"Offer"}},{"@type":["BreadcrumbList"]}]}</script></head>
      <body><header><nav><a>Men</a><a>Women</a><a>Sale</a></nav></header>
      <h1>Blue Shirt</h1><h2>Reviews</h2>
      <form><input type="email" name="secret_name" value="jane@x.io"><input type="hidden" name="csrf" value="t0k3n"><select><option>1</option></select><button>Go</button></form>
      <div itemscope itemtype="https://schema.org/Organization"></div></body>`,
      "https://shop.example/products/A1B2C3D4E5/?email=jane%40x.io#frag");
    const c = extractPageContext();
    expect(c.domain).toBe("shop.example");
    expect(c.path_pattern).toBe("/products/:id/");
    expect(c.og_type).toBe("product");
    expect(c.schema_types).toEqual(expect.arrayContaining(["Product", "Offer", "BreadcrumbList", "Organization"]));
    expect(c.forms).toEqual([{ field_types: ["email", "select"] }]);
    expect(c.nav_labels).toEqual(["Men", "Women", "Sale"]);
    expect(c.headings).toEqual(["Blue Shirt", "Reviews"]);
    expect(c.meta_description).toContain("[email]");
    const json = JSON.stringify(c);
    expect(json).not.toMatch(/jane|x\.io|secret_name|csrf|t0k3n|help@|email=/);
  });

  it("survives malformed JSON-LD and empty pages", () => {
    load(`<head><title></title><script type="application/ld+json">{oops</script></head><body></body>`, "https://x.example/");
    const c = extractPageContext();
    expect(c.schema_types).toEqual([]);
    expect(c.path_pattern).toBe("/");
    expect(c.forms).toEqual([]);
  });

  it("is self-contained: its source references no outer identifiers (needed for executeScript)", () => {
    // executeScript serialises the function; a free variable would be undefined in the page.
    const src = extractPageContext.toString();
    expect(src).not.toMatch(/\b(redactString|normalizePath|import\()/);
    const fn = new Function(`return (${src})`)();
    load(`<head><title>t</title></head><body><h1>Hi</h1></body>`, "https://x.example/a");
    expect(fn().headings).toEqual(["Hi"]);
  });
});
