import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import { blockerLine, loadCards, nextCard, normEntry, parseTaskFile, render } from "../scripts/kanban-lib.mjs";

const PLAN = `
| **T1** | Skeleton | x | Capture matches | — | Code complete (tests pass) |
| **T2** | Rules | x | Rules flag faults | T1 | Done |

### Prioritization

| Prio | ID | Item | Type | Size | Why at this position | Depends on |
|---|---|---|---|---|---|---|
| 1 | B1 | **Ads** | vendor | M | why | MVP |
| 2 | B2 | **dataLayer observer** | capture | M | why | MVP |
| 3 | B3 | Lead-gen | rules | S | why | MVP |
| — | T-1 | Move B2 | triggered | — | trigger | — |
`;

describe("kanban board", () => {
  it("reads the old string state and the new object state", () => {
    expect(normEntry("review")).toEqual({ status: "review" });
    expect(normEntry({ status: "blocked", branch: "b2-x" })).toEqual({ status: "blocked", branch: "b2-x" });
    expect(normEntry(undefined)).toEqual({ status: "backlog" });
    expect(() => normEntry("doing")).toThrow(/unknown status/);
  });

  it("parses ad-hoc task cards", () => {
    expect(parseTaskFile("X1", "# X1: Fix the badge\nType: bug\nSize: S\n")).toMatchObject({ id: "X1", item: "Fix the badge", type: "bug", size: "S", adhoc: true });
  });

  it("picks an in-progress card first, then Ready by priority, ad-hoc cards before planned ones", () => {
    let cards = loadCards(PLAN, { B3: "ready", B2: { status: "ready" } }, {});
    expect(nextCard(cards).id).toBe("B2");
    cards = loadCards(PLAN, { B3: "ready", B2: "ready", X1: "ready" }, { X1: "# X1: bug" });
    expect(nextCard(cards).id).toBe("X1");
    cards = loadCards(PLAN, { B3: "in_progress", X1: "ready" }, { X1: "# X1: bug" });
    expect(nextCard(cards).id).toBe("B3");
    cards = loadCards(PLAN, { B2: "ready", B3: { status: "ready", prio: -1 } }, {});
    expect(nextCard(cards).id).toBe("B3");
    expect(nextCard(loadCards(PLAN, {}, {}))).toBeUndefined();
  });

  it("ignores task files for ids that aren't ad-hoc and attaches them to planned cards", () => {
    const { backlog } = loadCards(PLAN, { B2: "ready" }, { B2: "# B2\n## Acceptance criteria\n- x" });
    expect(backlog.filter((b: { id: string }) => b.id === "B2")).toHaveLength(1);
    expect(backlog.find((b: { id: string }) => b.id === "B2").hasTask).toBe(true);
  });

  it("renders Ready, Blocked (with the question) and Review (with the branch)", () => {
    const tasks = { X1: "# X1: needs key\n\n## Blocked: 2026-11-20\n- Which provider key should the test use?\n", B2: "# B2" };
    const cards = loadCards(PLAN, { X1: { status: "blocked", branch: "x1-key" }, B2: "ready", B1: { status: "review", branch: "b1-ads", note: "adds Ads" } }, tasks);
    const md = render(cards, tasks);
    expect(md).toMatch(/### Ready \(1\)\n\n- \*\*B2\*\* dataLayer observer \(M\)/);
    expect(md).toMatch(/### Blocked \(needs you\) \(1\)[\s\S]*x1-key[\s\S]*Which provider key/);
    expect(md).toMatch(/### Review[\s\S]*\*\*B1\*\* Ads · `b1-ads`\n  - adds Ads/);
    expect(md).toMatch(/Next for the dev agent\n\n\*\*B2\*\*/);
  });

  it("flags Ready cards that have no task file", () => {
    const md = render(loadCards(PLAN, { B3: "ready" }, {}), {});
    expect(md).toContain("⚠ no tasks/B3.md");
  });

  it("takes the latest Blocked section's first line", () => {
    expect(blockerLine("## Blocked: a\n- old\n## Answer\nok\n## Blocked: b\n\n- new question")).toBe("new question");
    expect(blockerLine("# X1")).toBe("");
  });
});

describe("new cards and the Ready gate", () => {
  it("a scaffolded card has no real criteria until they're written", async () => {
    // @ts-expect-error plain .mjs module without types
    const { newTaskTemplate, hasCriteria } = await import("../scripts/kanban-lib.mjs");
    const t = newTaskTemplate("X3", "Badge turns red", "ui", "S");
    expect(t).toMatch(/^# X3: Badge turns red\nType: ui\nSize: S/);
    expect(hasCriteria(t)).toBe(false);
    expect(hasCriteria(t.replace("- [ ] _Checkable", "- [ ] Badge is red when silentGa4 is non-empty\n- [ ] _Checkable"))).toBe(true);
    expect(hasCriteria("## Notes\n- [ ] not criteria")).toBe(false);
  });
});
