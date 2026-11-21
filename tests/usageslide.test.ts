import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { meetsSlideSpec, slideHtml, STEPS } from "../scripts/usage-slide.mjs";
// @ts-expect-error plain .mjs module without types
import { pngInfo } from "../scripts/store-screenshots.mjs";

describe("README usage-explainer slide", () => {
  it("is 1920×1080, 24-bit RGB PNG without alpha", () => {
    expect(pngInfo(readFileSync("docs/store-graphics/usage-slide.png"))).toEqual({ width: 1920, height: 1080, bitDepth: 8, colorType: 2 });
  });
  it("the spec check rejects alpha and other sizes", () => {
    expect(meetsSlideSpec({ width: 1920, height: 1080, bitDepth: 8, colorType: 6 })).toBe(false);
    expect(meetsSlideSpec({ width: 1280, height: 720, bitDepth: 8, colorType: 2 })).toBe(false);
    expect(meetsSlideSpec({ width: 1920, height: 1080, bitDepth: 8, colorType: 2 })).toBe(true);
  });
  it("the slide is self-contained: no external images, fonts or scripts", () => {
    expect(slideHtml()).not.toMatch(/https?:\/\/|<script|<img|<link/i);
  });
  it("has exactly four steps, each readable at a glance", () => {
    expect(STEPS).toHaveLength(4);
    for (const s of STEPS) {
      expect(s.title.length).toBeLessThanOrEqual(30);
      expect(s.body.length).toBeLessThanOrEqual(120);
    }
  });
});
