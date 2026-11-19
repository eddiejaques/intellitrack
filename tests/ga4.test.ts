import { describe, expect, it } from "vitest";
import { isGa4Request, parseGa4, parseItem } from "../extension/src/vendors/ga4";
import { decodeRawBody } from "../extension/src/background/body";
import type { RawRequest } from "../extension/src/shared/types";

const base = (over: Partial<RawRequest>): RawRequest => ({
  requestId: "1", url: "", method: "POST", tabId: 1, type: "ping", timeStamp: 0, ...over,
});

const URL_SHARED =
  "https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&gtm=45je&cid=111.222&gcs=G111&gcd=13l3l3l3l1&dl=https%3A%2F%2Fshop.example%2Fproducts%2F42%3Futm_source%3Dx&dt=Blue%20Shirt&_p=999";

describe("isGa4Request", () => {
  it("matches standard and sGTM hosts", () => {
    expect(isGa4Request({ url: URL_SHARED })).toBe(true);
    expect(isGa4Request({ url: "https://metrics.shop.example/g/collect?v=2&tid=G-XYZ" })).toBe(true);
    expect(isGa4Request({ url: "https://metrics.shop.example/prefix/g/collect?v=2&tid=G-XYZ" })).toBe(true);
  });
  it("rejects UA, wrong tid, non-collect, junk", () => {
    expect(isGa4Request({ url: "https://www.google-analytics.com/collect?v=1&tid=UA-1-1" })).toBe(false);
    expect(isGa4Request({ url: "https://x.example/g/collect?v=2&tid=AW-1" })).toBe(false);
    expect(isGa4Request({ url: "https://x.example/g/collect?v=1&tid=G-1" })).toBe(false);
    expect(isGa4Request({ url: "https://x.example/other?v=2&tid=G-1" })).toBe(false);
    expect(isGa4Request({ url: "not a url" })).toBe(false);
  });
});

describe("parseGa4", () => {
  it("parses a single GET hit with event keys in the URL", () => {
    const url = URL_SHARED + "&en=page_view&ep.page_type=pdp&epn.value=29.9&_et=100";
    const [e, ...rest] = parseGa4(base({ url, method: "GET", type: "image" }));
    expect(rest).toHaveLength(0);
    expect(e.event).toBe("page_view");
    expect(e.property).toBe("G-ABC123");
    expect(e.params).toEqual({ page_type: "pdp", value: 29.9 });
    expect(e.user.client_id).toBe("111.222");
    expect(e.consent).toEqual({ gcs: "G111", gcd: "13l3l3l3l1" });
    expect(e.page).toEqual({ path: "/products/42", query: "utm_source=x", title: "Blue Shirt" });
    expect(e.params.currency).toBeUndefined();
  });

  it("splits a batched POST body into one event per line, sharing URL params", () => {
    const body = [
      "en=page_view&ep.page_type=pdp",
      "en=add_to_cart&cu=EUR&epn.value=29.9&pr1=idSKU1~nmBlue Shirt~pr29.9~qt1",
      "en=user_engagement&_et=4200",
    ].join("\n");
    const evs = parseGa4(base({ url: URL_SHARED, body }));
    expect(evs.map((e) => e.event)).toEqual(["page_view", "add_to_cart", "user_engagement"]);
    expect(evs.every((e) => e.property === "G-ABC123" && e.user.client_id === "111.222")).toBe(true);
    expect(evs[1].items).toEqual([{ item_id: "SKU1", item_name: "Blue Shirt", price: 29.9, quantity: 1 }]);
    expect(evs[1].params.value).toBe(29.9);
    expect(evs[1].params.currency).toBe("EUR");
    expect(evs[1].params).not.toHaveProperty("cu");
    // transport is per-event, not shared by reference
    evs[0].transport.status = 500;
    expect(evs[1].transport.status).toBeUndefined();
  });

  it("does not let URL-level en/ep leak onto batched body lines", () => {
    const evs = parseGa4(base({ url: URL_SHARED + "&en=page_view&ep.x=1", body: "en=scroll\nep.y=2" }));
    expect(evs[0].event).toBe("scroll");
    expect(evs[0].params).toEqual({});
    expect(evs[1].event).toBe("(unknown)");
    expect(evs[1].params).toEqual({ y: "2" });
  });

  it("orders multiple items by index and handles CRLF bodies", () => {
    const body = "en=purchase&ep.transaction_id=T1&pr2=idB~pr5~qt2&pr1=idA~pr10~qt1\r\n";
    const [e] = parseGa4(base({ url: URL_SHARED, body }));
    expect(e.items.map((i) => i.item_id)).toEqual(["A", "B"]);
    expect(e.params.transaction_id).toBe("T1");
  });

  it("per-line dl/dt override URL page info", () => {
    const [e] = parseGa4(base({ url: URL_SHARED, body: "en=page_view&dl=https%3A%2F%2Fshop.example%2Fcart&dt=Cart" }));
    expect(e.page).toEqual({ path: "/cart", title: "Cart" });
  });
});

describe("parseItem", () => {
  it("parses core, category and custom keys", () => {
    expect(parseItem("idS1~nmShirt~brAcme~caApparel~ca2Tops~vaBlue~pr9.5~qt3~k0size~v0L")).toEqual({
      item_id: "S1", item_name: "Shirt", item_brand: "Acme", item_category: "Apparel",
      item_category2: "Tops", item_variant: "Blue", price: 9.5, quantity: 3, key0: "size", val0: "L",
    });
  });
});

describe("decodeRawBody", () => {
  it("concatenates chunks before decoding (multi-byte char split across chunks)", () => {
    const bytes = new TextEncoder().encode("en=page_view&dt=Café");
    const cut = bytes.length - 2; // splits the 2-byte "é"
    const a = bytes.slice(0, cut).buffer;
    const b = bytes.slice(cut).buffer;
    expect(decodeRawBody([{ bytes: a }, { bytes: b }])).toBe("en=page_view&dt=Café");
  });
  it("returns undefined for no body", () => {
    expect(decodeRawBody(undefined)).toBeUndefined();
    expect(decodeRawBody([])).toBeUndefined();
  });
});
