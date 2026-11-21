import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("site/privacy.html", "utf8");
const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const manifest = JSON.parse(readFileSync("extension/static/manifest.json", "utf8"));

describe("privacy policy page (site/privacy.html)", () => {
  const must: [string, RegExp][] = [
    ["recording only after Start", /records nothing until you press Start/i],
    ["only recorded tabs", /Other tabs are never recorded/i],
    ["local storage in IndexedDB", /IndexedDB/],
    ["no telemetry", /No telemetry/i],
    ["page structure for planning", /Journey planning/i],
    ["redacted audit payload after preview", /preview and confirm before it is sent/i],
    ["API key stored unencrypted", /stored unencrypted in chrome\.storage\.local/i],
    ["how to delete data", /How to delete your data/i],
    ["no sale or transfer", /do not sell or transfer user data/i],
    ["a contact", /github\.com\/eddiejaques\/intellitrack\/issues/],
  ];
  for (const [what, re] of must) it(`states: ${what}`, () => expect(text).toMatch(re));

  it("explains every permission the manifest asks for", () => {
    for (const p of manifest.permissions as string[]) expect(text, p).toContain(p);
    if (manifest.host_permissions?.length) expect(text).toMatch(/Access to all sites/);
    if (manifest.optional_host_permissions?.length) expect(text).toMatch(/Optional site access/);
  });

  it("contains no email address and loads nothing from elsewhere", () => {
    expect(html).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(html).not.toMatch(/<script|<link[^>]+stylesheet|<img/i);
  });
});
