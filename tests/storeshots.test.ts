import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { frameHtml, meetsStoreSpec, pngInfo } from "../scripts/store-screenshots.mjs";

const DIR = "docs/screenshots/store";

describe("Chrome Web Store screenshots", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();

  it("there are 5", () => {
    expect(files).toEqual(["1-popup.png", "2-live-panel.png", "3-session-log.png", "4-audit-preview.png", "5-report.png"]);
  });

  for (const f of files) {
    it(`${f} is 1280×800, 24-bit RGB PNG without alpha`, () => {
      expect(pngInfo(readFileSync(`${DIR}/${f}`))).toEqual({ width: 1280, height: 800, bitDepth: 8, colorType: 2 });
    });
  }

  it("the spec check rejects alpha, other sizes and non-PNGs", () => {
    expect(meetsStoreSpec({ width: 1280, height: 800, bitDepth: 8, colorType: 6 })).toBe(false);
    expect(meetsStoreSpec({ width: 640, height: 400, bitDepth: 8, colorType: 2 })).toBe(false);
    expect(() => pngInfo(Buffer.from("not a png at all, really not"))).toThrow("not a PNG");
  });

  it("captions are escaped", () => {
    expect(frameHtml("AAAA", "<b>x</b>", "a & b")).toContain("&lt;b>x&lt;/b>");
  });
});
