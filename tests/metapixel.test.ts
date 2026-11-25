import { describe, expect, it } from "vitest";
import { isMetaPixel, parseMeta } from "../extension/src/vendors/metaPixel";
import { metaRules } from "../extension/src/rules/meta";
import { vendors } from "../extension/src/vendors";
import { runRules } from "../extension/src/rules";
import { buildPayload, findRawPii } from "../extension/src/minimize";
import { decodeBody } from "../extension/src/background/body";
import { VENDOR_OPTIONS } from "../extension/src/shared/vendors";
import { session } from "../fixtures/sessions";
import type { NormalizedEvent, RawRequest } from "../extension/src/shared/types";

// SYNTHETIC pings written from Meta's documented pixel request (placeholder pixel ID). Replace with
// real captures before the vendor is called verified.
const PIXEL = "1234567890123456";
const TR = "https://www.facebook.com/tr/";
const req = (url: string, over: Partial<RawRequest> = {}): RawRequest => ({ requestId: "1", url, method: "GET", tabId: 1, type: "image", timeStamp: 0, ...over });
const ping = (o: Record<string, string>) => `${TR}?${new URLSearchParams({ id: PIXEL, ...o })}`;
const PURCHASE = ping({ ev: "Purchase", eid: "order-1001-purchase", dl: "https://shop.example/thanks?o=1", rl: "https://shop.example/checkout", if: "false", ts: "1764000000000", "cd[value]": "59.80", "cd[currency]": "EUR", "cd[content_ids]": '["SKU-1","SKU-2"]', "cd[content_type]": "product", sw: "1512", v: "2.9.200" });
const ev = (o: Record<string, string>, i = 0): NormalizedEvent => ({ ...parseMeta(req(ping(o)))[0], id: `evt_${i}`, t: i, raw_ref: `r${i}` });

describe("meta pixel matcher", () => {
  it("matches facebook.com/tr pings; rejects the script and look-alikes", () => {
    expect(isMetaPixel({ url: PURCHASE })).toBe(true);
    expect(isMetaPixel({ url: `https://facebook.com/tr?id=${PIXEL}&ev=PageView` })).toBe(true);
    expect(isMetaPixel({ url: "https://connect.facebook.net/en_US/fbevents.js" })).toBe(false);
    expect(isMetaPixel({ url: "https://www.facebook.com/tracking/x" })).toBe(false);
    expect(isMetaPixel({ url: "https://notfacebook.com/tr/?id=1&ev=PageView" })).toBe(false);
    expect(isMetaPixel({ url: "https://shop.example/g/collect?v=2&tid=G-1" })).toBe(false);
    expect(isMetaPixel({ url: "nope" })).toBe(false);
    expect(parseMeta(req("https://shop.example/tr/?id=1&ev=Purchase"))).toEqual([]);
  });

  it("is registered, selectable, and no other vendor claims its pings", () => {
    expect(vendors.filter((v) => v.urlHint.test(PURCHASE) && v.match(req(PURCHASE))).map((v) => v.id)).toEqual(["meta_pixel"]);
    expect(vendors.find((v) => v.id === "meta_pixel")?.piiPolicy).toBe("hashed_only");
    expect(VENDOR_OPTIONS.find((v) => v.id === "meta_pixel")?.label).toBe("Meta Pixel");
  });
});

describe("meta pixel parser", () => {
  it("maps id, ev, eid and the known cd[...] fields; drops bookkeeping", () => {
    const [e] = parseMeta(req(PURCHASE));
    expect(e.vendor).toBe("meta_pixel");
    expect(e.property).toBe(PIXEL);
    expect(e.event).toBe("Purchase");
    expect(e.params).toEqual({ event_id: "order-1001-purchase", value: 59.8, currency: "EUR", content_ids: '["SKU-1","SKU-2"]', content_type: "product" });
    expect(e.page).toEqual({ path: "/thanks", query: "o=1" });
  });

  it("keeps a non-numeric value as text, and skips a ping with no event", () => {
    expect(parseMeta(req(ping({ ev: "Purchase", "cd[value]": "n/a" })))[0].params.value).toBe("n/a");
    expect(parseMeta(req(ping({})))).toEqual([]);
  });

  it("reads POST pings from the body, including form-encoded bodies Chrome reports as formData", () => {
    const fields = Object.fromEntries(new URL(PURCHASE).searchParams);
    const body = decodeBody({ formData: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [v]])) });
    const [post] = parseMeta(req(TR, { method: "POST", type: "ping", body }));
    const [get] = parseMeta(req(PURCHASE));
    expect({ ...post, transport: undefined }).toEqual({ ...get, transport: undefined });
    expect(decodeBody(undefined)).toBeUndefined();
    expect(decodeBody({ raw: [{ bytes: new TextEncoder().encode("a=1").buffer as ArrayBuffer }] })).toBe("a=1");
  });

  it("keeps Advanced Matching fields only so the PII rule can judge them (hashed only)", () => {
    const hashed = ev({ ev: "Lead", eid: "l-1", "ud[em]": "a".repeat(64) });
    expect(hashed.params["ud[em]"]).toBe("a".repeat(64));
    expect(runRules([hashed]).findings.filter((f) => f.category === "pii")).toEqual([]);

    const plain = ev({ ev: "Lead", eid: "l-2", "ud[em]": "jane.doe@example.com" }, 1);
    const pii = runRules([plain]).findings.filter((f) => f.category === "pii");
    expect(pii).toHaveLength(1);
    expect(pii[0]).toMatchObject({ severity: "critical", vendor: "meta_pixel" });

    const p = buildPayload({ session: session(), events: [plain] });
    expect(JSON.stringify(p)).not.toContain("jane.doe");
    expect(findRawPii(p)).toEqual([]);
  });
});

describe("meta pixel eventID rule", () => {
  it("flags conversion events sent without an eventID", () => {
    const evs = [ev({ ev: "Purchase", "cd[value]": "10", "cd[currency]": "EUR" }, 0), ev({ ev: "Lead" }, 1), ev({ ev: "CompleteRegistration", eid: " " }, 2), ev({ ev: "AddToCart" }, 3)];
    const f = metaRules(evs);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "medium", vendor: "meta_pixel", category: "missing_param" });
    expect(f[0].detail).toContain("CAPI dedup will double-count if the server also sends this event");
    expect(f[0].evidence).toEqual(["evt_0", "evt_1", "evt_2", "evt_3"]);
    expect(runRules(evs).findings.some((x) => x.title === "Meta Pixel conversion without an eventID")).toBe(true);
  });

  it("is clean when every conversion has an eventID", () => {
    expect(metaRules([ev({ ev: "Purchase", eid: "p-1" }), ev({ ev: "Lead", eid: "l-1" }, 1)])).toEqual([]);
  });

  it("never flags non-conversion events such as PageView", () => {
    expect(metaRules([ev({ ev: "PageView" }), ev({ ev: "ViewContent" }, 1), ev({ ev: "SubscribedButtonClick" }, 2)])).toEqual([]);
  });
});
