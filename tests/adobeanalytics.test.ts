import { describe, expect, it } from "vitest";
import { isAdobeHit, MAX_VALUE, parseAdobe, parseProducts } from "../extension/src/vendors/adobeAnalytics";
import { vendors } from "../extension/src/vendors";
import { runRules } from "../extension/src/rules";
import { buildPayload, findRawPii } from "../extension/src/minimize";
import { VENDOR_OPTIONS, auditEvents, sessionAuditVendor } from "../extension/src/shared/vendors";
import { session } from "../fixtures/sessions";
import type { NormalizedEvent, RawRequest } from "../extension/src/shared/types";

// SYNTHETIC hits written from Adobe's documented AppMeasurement query parameters (placeholder rsid
// and hosts). Replace with real captures before the vendor is called verified.
const RSID = "examplersid-prod";
const FP = `https://smetrics.shop.example/b/ss/${RSID}/1/JS-2.22.0/s12345678901234`;
const req = (url: string, over: Partial<RawRequest> = {}): RawRequest => ({ requestId: "1", url, method: "GET", tabId: 1, type: "image", timeStamp: 0, ...over });
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const asEvent = (p: ReturnType<typeof parseAdobe>[number], i = 0): NormalizedEvent => ({ ...p, id: `evt_${i}`, t: i, raw_ref: `r${i}` });

const PAGE_HIT = `${FP}?${q({ AQB: "1", ndh: "1", pageName: "shop:product:blue-shirt", g: "https://shop.example/p/blue-shirt?utm_source=news", ch: "shop", v1: "logged_in", c2: "product", mid: "12345678901234567890", AQE: "1" })}`;

describe("adobe analytics matcher", () => {
  it("matches /b/ss/ on first-party CNAMEs and Adobe's own hosts; rejects look-alikes", () => {
    expect(isAdobeHit({ url: PAGE_HIT })).toBe(true);
    expect(isAdobeHit({ url: `https://example.sc.omtrdc.net/b/ss/${RSID}/1/JS-2.22.0/s1?AQB=1` })).toBe(true);
    expect(isAdobeHit({ url: `https://example.112.2o7.net/b/ss/${RSID},${RSID}-global/1/H.27/s1` })).toBe(true);
    expect(isAdobeHit({ url: "https://shop.example/b/sss/x" })).toBe(false);
    expect(isAdobeHit({ url: "https://shop.example/g/collect?v=2&tid=G-1" })).toBe(false);
    expect(isAdobeHit({ url: "nope" })).toBe(false);
  });

  it("is registered, selectable, and no other vendor claims its hits", () => {
    expect(vendors.find((v) => v.id === "adobe_analytics")?.piiPolicy).toBe("never");
    expect(vendors.filter((v) => v.urlHint.test(PAGE_HIT) && v.match(req(PAGE_HIT))).map((v) => v.id)).toEqual(["adobe_analytics"]);
    expect(VENDOR_OPTIONS.find((v) => v.id === "adobe_analytics")?.label).toBe("Adobe Analytics");
  });
});

describe("adobe analytics parser", () => {
  it("turns a page-view hit into one event with the report suite as the property", () => {
    const [e] = parseAdobe(req(PAGE_HIT));
    expect(e.vendor).toBe("adobe_analytics");
    expect(e.property).toBe(RSID);
    expect(e.event).toBe("page_view");
    expect(e.page).toEqual({ path: "/p/blue-shirt", query: "utm_source=news", title: "shop:product:blue-shirt" });
    expect(e.params).toEqual({ pageName: "shop:product:blue-shirt", channel: "shop", v1: "logged_in", c2: "product" });
    expect(e.user.client_id).toBe("12345678901234567890");
  });

  it("names link-tracking hits and keeps the link name", () => {
    const [e] = parseAdobe(req(`${FP}?${q({ pe: "lnk_d", pev2: "brochure.pdf", g: "https://shop.example/" })}`));
    expect(e.event).toBe("download_link");
    expect(e.params.link_name).toBe("brochure.pdf");
    expect(parseAdobe(req(`${FP}?${q({ pe: "lnk_o", pev2: "cta" })}`))[0].event).toBe("custom_link");
    expect(parseAdobe(req(`${FP}?${q({ pe: "lnk_e" })}`))[0].event).toBe("exit_link");
  });

  it("parses purchase fields and products into items", () => {
    const hit = `${FP}?${q({ events: "purchase,event5=2", purchaseID: "ORDER-1001", cc: "EUR", products: ";SKU-1;2;59.80,shirts;SKU-2;1;19.90;event5=1" })}`;
    const [e] = parseAdobe(req(hit));
    expect(e.params).toMatchObject({ events: "purchase,event5=2", purchaseID: "ORDER-1001", currency: "EUR" });
    expect(e.params.products).toBeUndefined(); // kept structured, as items
    expect(e.items).toEqual([{ item_id: "SKU-1", quantity: 2, price: 59.8 }, { item_id: "SKU-2", item_category: "shirts", quantity: 1, price: 19.9 }]);
    expect(parseProducts("")).toEqual([]);
  });

  it("reads POST hits from the body exactly like GET hits", () => {
    const body = new URL(PAGE_HIT).search.slice(1);
    const [post] = parseAdobe(req(FP, { method: "POST", type: "xmlhttprequest", body }));
    const [get] = parseAdobe(req(PAGE_HIT));
    expect({ ...post, transport: undefined }).toEqual({ ...get, transport: undefined });
    expect(post.transport).toEqual({ type: "xmlhttprequest", method: "POST" });
  });

  it("keeps custom context data (nested prefixes resolved) and drops Adobe's own a.* data", () => {
    const body = "AQB=1&c.=&a.=&activitymap.=&page=home&link=Buy&.activitymap&Launches=3&.a&cart.=&step=shipping&.cart&env=prod&.c&pageName=checkout&AQE=1";
    const [e] = parseAdobe(req(FP, { method: "POST", body }));
    expect(e.params).toEqual({ "c.cart.step": "shipping", "c.env": "prod", pageName: "checkout" });
  });

  it("cuts long values", () => {
    const [e] = parseAdobe(req(`${FP}?${q({ v10: "x".repeat(5000) })}`));
    expect(String(e.params.v10).length).toBe(MAX_VALUE + 1);
  });

  it("strips a large POST to a small event that keeps every allowlisted field", () => {
    const noise: Record<string, string> = {
      AQB: "1", ndh: "1", pf: "1", t: "25/10/2026 14:3:12 3 -60", fid: "0A1B2C3D4E5F6789-0123456789ABCDEF",
      ce: "UTF-8", cdp: "3", mcorgid: "0000000000000000000000@AdobeOrg", aamlh: "6", aamb: "Z".repeat(120),
      r: `https://www.search.example/?q=${"long+referrer+terms+".repeat(20)}`, s: "2560x1440", c: "24", j: "1.6", v: "N",
      k: "Y", bw: "1512", bh: "864", lrt: "120", AQE: "1",
    };
    const ctx = ["c.=", "a.=", "activitymap.=", `page=${"shop%3Acheckout%3Ashipping".repeat(4)}`, `link=${"Continue%20to%20payment".repeat(4)}`,
      `region=${"checkout-form-wrapper".repeat(6)}`, "pageIDType=1", ".activitymap", "Launches=12", "DaysSinceFirstUse=40",
      `AppID=${"ShopApp%201.2.3%20(456)".repeat(3)}`, "media.=", ...Array.from({ length: 40 }, (_, i) => `field${i}=${"m".repeat(60)}`), ".media", ".a",
      "env=prod", ".c"];
    const kept: Record<string, string> = { pageName: "shop:checkout:shipping", g: "https://shop.example/checkout/shipping", ch: "checkout",
      events: "scCheckout,event12", v1: "logged_in", v5: "D=pageName", v12: "express", c1: "checkout", c3: "de-DE", purchaseID: "ORDER-1001", cc: "EUR" };
    const body = `${q(noise)}&${ctx.join("&")}&${q(kept)}&${Array.from({ length: 60 }, (_, i) => `x${i}=${"n".repeat(80)}`).join("&")}`;
    const [e] = parseAdobe(req(FP, { method: "POST", body }));
    const rawSize = FP.length + body.length;
    const storedSize = JSON.stringify(e).length;
    expect(rawSize).toBeGreaterThan(8000);
    expect(storedSize / rawSize).toBeLessThanOrEqual(0.1);
    expect(e.params).toEqual({ pageName: "shop:checkout:shipping", channel: "checkout", events: "scCheckout,event12", v1: "logged_in", v5: "D=pageName",
      v12: "express", c1: "checkout", c3: "de-DE", purchaseID: "ORDER-1001", currency: "EUR", "c.env": "prod" });
    expect(e.page.path).toBe("/checkout/shipping");
  });
});

describe("adobe analytics privacy and audit", () => {
  const leaky = () => [
    asEvent(parseAdobe(req(`${FP}?${q({ pageName: "account", g: "https://shop.example/account", v3: "jane.doe@example.com", c4: "+49 170 1234567" })}`))[0], 0),
    asEvent(parseAdobe(req(FP, { method: "POST", body: "c.=&user.=&mail=jane.doe@example.com&.user&.c&pageName=home" }))[0], 1),
  ];

  it("plaintext email or phone in an eVar, prop or context data is a critical PII finding", () => {
    const pii = runRules(leaky()).findings.filter((f) => f.category === "pii");
    expect(pii.length).toBeGreaterThanOrEqual(3);
    expect(pii.every((f) => f.severity === "critical" && f.vendor === "adobe_analytics")).toBe(true);
  });

  it("the payload redacts them before anything is sent", () => {
    const p = buildPayload({ session: session(), events: leaky() });
    expect(JSON.stringify(p)).not.toContain("jane.doe");
    expect(JSON.stringify(p)).not.toContain("1234567");
    expect(findRawPii(p)).toEqual([]);
    expect(p.events[0].params.v3).toBe("[email:plaintext]");
    expect(p.events[0].params.c4).toBe("[phone:plaintext]");
    expect(p.events[1].params["c.user.mail"]).toBe("[email:plaintext]");
  });

  it("can be the one vendor in the audit (X21)", () => {
    const evs = [...leaky(), { ...leaky()[0], vendor: "ga4", id: "evt_9" }];
    expect(sessionAuditVendor({ audit_vendor: "adobe_analytics" }, { ga4: 1, adobe_analytics: 2 })).toBe("adobe_analytics");
    expect(sessionAuditVendor({}, { adobe_analytics: 2 })).toBe("adobe_analytics");
    const p = buildPayload({ session: session(), events: auditEvents(evs, "adobe_analytics") });
    expect(p.events.length).toBe(2);
    expect(p.events.every((e) => e.vendor === "adobe_analytics")).toBe(true);
  });
});
