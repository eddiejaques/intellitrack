import { describe, expect, it } from "vitest";
import { runRules } from "../extension/src/rules";
import { buildPayload, findRawPii } from "../extension/src/minimize";
import { redactString, normalizePath, detectPii } from "../extension/src/minimize/redact";
import { ALL_STEPS, ecommerceClean, ecommercePlan, ev, leadGenClean, leadGenPlan, session } from "../fixtures/sessions";
import type { Finding } from "../extension/src/shared/types";

const find = (fs: Finding[], cat: string, re?: RegExp) => fs.filter((f) => f.category === cat && (!re || re.test(f.title)));
const bad = (fs: Finding[]) => fs.filter((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");

describe("clean fixtures: no false positives", () => {
  it("ecommerce", () => {
    const { findings, coverage } = runRules(ecommerceClean(), { plan: ecommercePlan });
    expect(bad(findings)).toEqual([]);
    expect(coverage.map((c) => c.status)).toEqual(["matched", "matched", "matched", "matched"]);
  });
  it("lead gen", () => {
    const { findings, coverage } = runRules(leadGenClean(), { plan: leadGenPlan });
    expect(bad(findings)).toEqual([]);
    expect(coverage.every((c) => c.status === "matched")).toBe(true);
  });
  it("ecommerce without a plan is detected from events and stays clean", () => {
    expect(bad(runRules(ecommerceClean()).findings)).toEqual([]);
  });
});

describe("seeded faults are flagged by rules alone", () => {
  it("missing add_to_cart", () => {
    const evs = ecommerceClean().filter((e) => e.event !== "add_to_cart");
    const { findings, coverage } = runRules(evs, { plan: ecommercePlan, reachedSteps: ALL_STEPS });
    const f = find(findings, "missing_event", /add_to_cart/);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
    expect(coverage.find((c) => c.step === "S2")!.status).toBe("missing");
  });

  it("missing purchase is critical", () => {
    const evs = ecommerceClean().filter((e) => e.event !== "purchase");
    const f = find(runRules(evs, { plan: ecommercePlan, reachedSteps: ALL_STEPS }).findings, "missing_event", /purchase/);
    expect(f[0].severity).toBe("critical");
  });

  it("plaintext email in a param and in the page URL", () => {
    const evs = ecommerceClean();
    evs[3].params.user_email = "jane.doe@example.com";
    evs[3].page.query = "email=jane.doe%40example.com&x=1";
    evs[4].page.query = "ref=jane.doe@example.com";
    const f = find(runRules(evs, { plan: ecommercePlan }).findings, "pii");
    expect(f.length).toBeGreaterThanOrEqual(2);
    expect(f.every((x) => x.severity === "critical")).toBe(true);
    expect(JSON.stringify(f)).not.toContain("jane.doe");
  });

  it("invalid hash length and valid sha256 in GA4", () => {
    const evs = ecommerceClean();
    evs[1].params.sha256_email_address = "a".repeat(40) + "a".repeat(8) + "a".repeat(0);
    evs[2].params.hashed_id = "0".repeat(64);
    const f = find(runRules(evs).findings, "pii");
    expect(f.some((x) => /wrong length/.test(x.title) && x.severity === "high")).toBe(true);
    expect(f.some((x) => /Hashed identifier sent/.test(x.title) && x.severity === "medium")).toBe(true);
  });

  it("duplicate purchase (reloaded thank-you page)", () => {
    const evs = ecommerceClean();
    evs.push({ ...evs[4], id: "evt_dup", t: 40 });
    const f = find(runRules(evs, { plan: ecommercePlan }).findings, "duplicate");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("critical");
    expect(f[0].evidence).toContain("evt_dup");
  });

  it("wrong value", () => {
    const evs = ecommerceClean();
    evs[4].params.value = 35.9; // shipping included
    const f = find(runRules(evs, { plan: ecommercePlan }).findings, "wrong_value");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("high");
  });

  it("purchase without transaction_id, value without currency", () => {
    const evs = ecommerceClean();
    delete evs[4].params.transaction_id;
    delete evs[4].params.currency;
    const fs = runRules(evs, { plan: ecommercePlan }).findings;
    expect(fs.some((f) => /without transaction_id/.test(f.title))).toBe(true);
    expect(fs.some((f) => /without currency/.test(f.title))).toBe(true);
  });

  it("partial: generate_lead without value/currency", () => {
    const evs = leadGenClean();
    evs[2].params = {};
    const { findings, coverage } = runRules(evs, { plan: leadGenPlan });
    expect(find(findings, "missing_param")[0].title).toMatch(/value, currency/);
    expect(coverage.find((c) => c.step === "S3")!.status).toBe("partial");
  });

  it("consent: missing everywhere, and missing on some", () => {
    const all = ecommerceClean().map((e) => ({ ...e, consent: {} }));
    expect(find(runRules(all).findings, "consent")[0].severity).toBe("high");
    const some = ecommerceClean();
    some[2].consent = {};
    expect(find(runRules(some).findings, "consent")[0].severity).toBe("medium");
  });

  it("client_id change and a second property", () => {
    const evs = ecommerceClean();
    evs[3].user.client_id = "999.888";
    evs[4].property = "G-OTHER9";
    const fs = find(runRules(evs).findings, "identity");
    expect(fs.map((f) => f.title).join()).toMatch(/client_id changed/);
    expect(fs.map((f) => f.title).join()).toMatch(/2 GA4 properties/);
  });

  it("double-fire within 500 ms", () => {
    const evs = ecommerceClean();
    evs.push({ ...evs[2], id: "evt_x", t: evs[2].t + 0.2 });
    expect(find(runRules(evs).findings, "duplicate", /double-fired/)).toHaveLength(1);
  });

  it("failed vs blocked hits", () => {
    const evs = ecommerceClean();
    evs[1].transport = { type: "ping", method: "POST", error: "net::ERR_BLOCKED_BY_CLIENT" };
    evs[2].transport = { type: "ping", method: "POST", status: 500 };
    const fs = find(runRules(evs).findings, "delivery");
    expect(fs.find((f) => /failed/.test(f.title))!.severity).toBe("high");
    expect(fs.find((f) => /blocked/.test(f.title))!.severity).toBe("low");
  });

  it("events out of plan order", () => {
    const evs = ecommerceClean();
    // begin_checkout (S3) fires before add_to_cart (S2)
    evs[3].t = 3; evs[2].t = 9;
    const fs = find(runRules(evs, { plan: ecommercePlan }).findings, "ordering");
    expect(fs.length).toBeGreaterThanOrEqual(1);
  });

  it("purchase items that were never in the cart", () => {
    const evs = ecommerceClean();
    evs[4].items = [{ item_id: "SKU9", item_name: "Other", price: 29.9, quantity: 1 }];
    expect(runRules(evs).findings.some((f) => /differ from cart/.test(f.title))).toBe(true);
  });

  it("through buildPayload, pressed markers make a silent step a missing event", () => {
    const evs = ecommerceClean().filter((e) => e.event !== "add_to_cart");
    const p = buildPayload({ session: session(), events: evs, plan: ecommercePlan });
    expect(p.journey_coverage.find((c) => c.step === "S2")!.status).toBe("missing");
    expect(p.rule_findings.some((f) => f.category === "missing_event")).toBe(true);
  });

  it("steps the user never reached are not_reached, not missing", () => {
    const evs = ecommerceClean().filter((e) => !["S3", "S4"].includes(e.page.step ?? ""));
    const { findings, coverage } = runRules(evs, { plan: ecommercePlan });
    expect(coverage.map((c) => c.status)).toEqual(["matched", "matched", "not_reached", "not_reached"]);
    expect(find(findings, "missing_event")).toHaveLength(0);
  });

  it("known limit: generate_lead on an invalid submit is not detectable by rules (LLM/plan territory)", () => {
    // The hit looks identical to a valid one; documented in plan T2 gate.
    expect(bad(runRules(leadGenClean(), { plan: leadGenPlan }).findings)).toEqual([]);
  });
});

describe("redaction", () => {
  it("keeps the shape of personal data", () => {
    expect(redactString("email", "a@b.com")).toBe("[email:plaintext]");
    expect(redactString("title", "Hi jane@x.io!")).toBe("Hi [email:plaintext]!");
    expect(redactString("k", "f".repeat(64))).toBe("[sha256:64hex]");
    expect(redactString("sha256_email_address", "f".repeat(40))).toBe("[hash:invalid len=40]");
    expect(redactString("phone", "+31 6 1234 5678")).toBe("[phone:plaintext]");
    expect(redactString("order_ref", "1234567890")).toBe("1234567890");
    expect(redactString("tel", "0612345678")).toBe("[phone:plaintext]");
  });
  it("detectPii", () => {
    expect(detectPii("x", "a@b.com")).toEqual(["email"]);
    expect(detectPii("transaction_id", "T-1001")).toEqual([]);
  });
  it("normalizes paths", () => {
    expect(normalizePath("/products/12345/reviews")).toBe("/products/:id/reviews");
    expect(normalizePath("/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("/u/:id");
    expect(normalizePath("/blog/my-first-post")).toBe("/blog/my-first-post");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/c/jane@x.io")).toBe("/c/:id");
  });
});

describe("payload", () => {
  it("contains no raw PII even when the session is full of it", () => {
    const evs = ecommerceClean();
    evs[0].params.email = "jane.doe@example.com";
    evs[0].page.title = "Welcome jane.doe@example.com";
    evs[0].page.path = "/account/jane.doe@example.com";
    evs[0].page.query = "email=jane.doe%40example.com";
    evs[1].params.phone = "+31612345678";
    evs[1].params.sha256_email_address = "b".repeat(40);
    evs[2].items = [{ item_id: "S", item_name: "Gift for bob@corp.co", price: 29.9, quantity: 1 }];
    evs[3].user.user_id = "bob@corp.co";
    const p = buildPayload({ session: session(), events: evs, plan: ecommercePlan });
    const json = JSON.stringify(p);
    expect(json).not.toMatch(/jane\.doe|bob@|612345678|bbbbbbbb|example\.com/);
    expect(findRawPii(p)).toEqual([]);
    expect(p.rule_findings.some((f) => f.category === "pii")).toBe(true);
    expect(json).toContain("[email:plaintext]");
    expect(p.events.find((e) => e.id === evs[3].id)!.user.user_id).toBe("[present]");
  });

  it("drops noise but counts it, normalizes pages, removes near-duplicates, and flags client_id stability", () => {
    const evs = ecommerceClean();
    const dup = { ...evs[2], id: "evt_d", t: evs[2].t + 0.1 };
    const p = buildPayload({ session: session(), events: [...evs, dup], plan: ecommercePlan });
    expect(p.stats.noise_counts).toEqual({ user_engagement: 2 });
    expect(p.stats.duplicates_dropped).toBe(1);
    expect(p.events.map((e) => e.event)).not.toContain("user_engagement");
    expect(p.events.find((e) => e.id === evs[2].id)!.dup_dropped).toBe(1);
    expect(p.pages.map((x) => x.path)).toEqual(["/products/:id", "/checkout", "/thanks"]);
    expect(p.session.client_id_stable).toBe(true);
    expect(p.events[0].user.client_id).toBe("[present]");
    expect(p.events.every((e) => !("_t" in e))).toBe(true);
  });

  it("flags unstable client_id and collapses repeats when over the token budget", () => {
    const evs = ecommerceClean();
    for (let i = 0; i < 30; i++) evs.push(ev(20 + i, "scroll", { page: { path: "/thanks", step: "S4" }, params: { percent_scrolled: 90 } }));
    evs[1].user.client_id = "other";
    const p = buildPayload({ session: session(), events: evs, minimize: { maxEvents: 10 } });
    expect(p.session.client_id_stable).toBe(false);
    const scroll = p.events.find((e) => e.event === "scroll")!;
    expect(scroll.count).toBe(30);
    expect(scroll.ids!.length).toBe(10);
    expect(p.stats.collapsed_events).toBe(29);
  });

  it("every evidence ID in rule findings exists in the raw events", () => {
    const evs = ecommerceClean();
    evs.push({ ...evs[4], id: "evt_dup", t: 40 });
    const { findings } = runRules(evs, { plan: ecommercePlan });
    const known = new Set(evs.map((e) => e.id));
    for (const f of findings) for (const id of f.evidence) expect(known.has(id)).toBe(true);
  });
});
