import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { meetsTileSpec, tileHtml } from "../scripts/promo-tile.mjs";
// @ts-expect-error plain .mjs module without types
import { pngInfo } from "../scripts/store-screenshots.mjs";

describe("Chrome Web Store small promo tile", () => {
  it("is 440×280, 24-bit RGB PNG without alpha", () => {
    expect(pngInfo(readFileSync("docs/store-graphics/small-promo-tile.png"))).toEqual({ width: 440, height: 280, bitDepth: 8, colorType: 2 });
  });
  it("the spec check rejects alpha and other sizes", () => {
    expect(meetsTileSpec({ width: 440, height: 280, bitDepth: 8, colorType: 6 })).toBe(false);
    expect(meetsTileSpec({ width: 1400, height: 560, bitDepth: 8, colorType: 2 })).toBe(false);
    expect(meetsTileSpec({ width: 440, height: 280, bitDepth: 8, colorType: 2 })).toBe(true);
  });
  it("the tile is self-contained: no external images, fonts or scripts", () => {
    expect(tileHtml()).not.toMatch(/https?:\/\/|<script|<img|<link/i);
  });
});
