import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module without types
import * as lib from "../scripts/kanban-lib.mjs";

const { checkMove, formatComment, hasCriteria, itemToCard, legacyCards, newCardBody, nextCard, normEntry, parseComment, parseTaskFile, parseTitle } = lib;

/** A project item as the GraphQL query in gh-board.mjs returns it. */
function item(title: string, f: { Status?: string; Prio?: number; Size?: string; Branch?: string } = {}, extra: Record<string, unknown> = {}) {
  const fv = [];
  if (f.Status) fv.push({ name: f.Status, field: { name: "Status" } });
  if (f.Prio !== undefined) fv.push({ number: f.Prio, field: { name: "Prio" } });
  if (f.Size) fv.push({ name: f.Size, field: { name: "Size" } });
  if (f.Branch) fv.push({ text: f.Branch, field: { name: "Branch" } });
  return {
    id: `PVTI_${title}`,
    fieldValues: { nodes: fv },
    content: { number: 7, title, body: "", state: "OPEN", url: "u", labels: { nodes: [{ name: "type:bug" }] }, closedByPullRequestsReferences: { nodes: [] }, ...extra },
  };
}

describe("cards from the GitHub project", () => {
  it("reads ID, title and fields; ignores items without an ID'd issue title", () => {
    expect(parseTitle("B2: dataLayer observer")).toEqual({ id: "B2", title: "dataLayer observer" });
    expect(parseTitle("T-1: Move B2")).toEqual({ id: "T-1", title: "Move B2" });
    expect(parseTitle("fix the badge")).toBeUndefined();
    const c = itemToCard(item("X3: Short findings", { Status: "In progress", Prio: 2, Size: "M", Branch: "x3-short" }));
    expect(c).toMatchObject({ id: "X3", title: "Short findings", number: 7, status: "in_progress", prio: 2, size: "M", branch: "x3-short", type: "bug", merged: false });
    expect(itemToCard(item("no id here"))).toBeUndefined();
    expect(itemToCard({ id: "draft", fieldValues: { nodes: [] }, content: {} })).toBeUndefined();
    expect(itemToCard(item("X1: new")).status).toBe("backlog");
  });

  it("sees a merged PR that closes the issue", () => {
    const c = itemToCard(item("B2: x", { Status: "Review" }, { closedByPullRequestsReferences: { nodes: [{ number: 50, url: "p", merged: true, state: "MERGED", headRefName: "b2-x" }] } }));
    expect(c.merged).toBe(true);
    expect(c.prs[0]).toMatchObject({ number: 50, branch: "b2-x" });
  });

  it("picks an in-progress card first, then Ready by prio, then by id", () => {
    const mk = (id: string, status: string, prio: number) => ({ id, status, prio });
    expect(nextCard([mk("B3", "ready", 6), mk("B2", "ready", 5)]).id).toBe("B2");
    expect(nextCard([mk("X2", "ready", 0), mk("X10", "ready", 0), mk("B2", "ready", 5)]).id).toBe("X2");
    expect(nextCard([mk("B2", "ready", -1), mk("B3", "in_progress", 6)]).id).toBe("B3");
    expect(nextCard([mk("B2", "review", 0), mk("B3", "backlog", 0)])).toBeUndefined();
  });
});

describe("moving cards", () => {
  const card = (o: Record<string, unknown>) => ({ id: "X1", number: 8, status: "backlog", hasCriteria: true, merged: false, ...o });

  it("Done only when the card's PR is merged, even with --force", () => {
    expect(checkMove(card({}), "done")).toMatch(/Done only when its PR \("Closes #8"\) is merged into main/);
    expect(checkMove(card({}), "done", [], { force: true })).toMatch(/merged into main/);
    expect(checkMove(card({ merged: true, status: "review" }), "done")).toBeUndefined();
  });

  it("Ready needs acceptance criteria unless forced", () => {
    expect(checkMove(card({ hasCriteria: false }), "ready")).toMatch(/acceptance criterion/);
    expect(checkMove(card({ hasCriteria: false }), "ready", [], { force: true })).toBeUndefined();
    expect(checkMove(card({}), "ready")).toBeUndefined();
  });

  it("WIP limit 1", () => {
    const others = [{ id: "B2", status: "in_progress" }];
    expect(checkMove(card({}), "in_progress", others)).toMatch(/B2 is already in progress/);
    expect(checkMove(card({ id: "B2", status: "in_progress" }), "in_progress", others)).toBeUndefined();
    expect(checkMove(card({}), "doing")).toMatch(/status must be one of/);
  });

  it("criteria: placeholders and other sections don't count", () => {
    const body = newCardBody();
    expect(hasCriteria(body)).toBe(false);
    expect(hasCriteria(body.replace("- [ ] _Checkable", "- [ ] Badge is red when GA4 is silent\n- [ ] _Checkable"))).toBe(true);
    expect(hasCriteria("## Notes\n- [ ] not criteria")).toBe(false);
  });
});

describe("comments: same GitHub account, so the agent tags its own", () => {
  it("round-trips author and kind", () => {
    const a = formatComment("agent", "blocked", "Which provider key should the test use?");
    expect(a).toBe("**[agent · blocked]**\n\nWhich provider key should the test use?");
    expect(parseComment(a)).toEqual({ author: "agent", kind: "blocked", body: "Which provider key should the test use?" });
    expect(parseComment(formatComment("pm", "feedback", "Rename the tab"))).toEqual({ author: "pm", kind: "feedback", body: "Rename the tab" });
    expect(formatComment("pm", "note", "  plain  ")).toBe("plain");
    expect(parseComment("Looks good **[agent · note]**")).toEqual({ author: "pm", kind: "note", body: "Looks good **[agent · note]**" });
    expect(() => formatComment("pm", "shout", "x")).toThrow(/kind must be/);
    expect(() => formatComment("pm", "note", " ")).toThrow(/needs text/);
  });
});

describe("migration from the old file board", () => {
  const PLAN = `
| **T1** | **Skeleton** | MV3 scaffold | Capture matches | — | Code complete (tests pass) |
| **T2** | Rules | x | Rules flag faults | T1 | Done |

### Prioritization

| Prio | ID | Item | Type | Size | Why at this position | Depends on |
|---|---|---|---|---|---|---|
| 1 | B1 | **Ads** | vendor | M | why ads | MVP |
| 2 | B2 | **dataLayer observer** | capture | M | why dl | MVP |
| — | T-1 | Move B2 | triggered | — | T1 gate fails | — |
`;

  it("reads the old string state and the object state", () => {
    expect(normEntry("review")).toEqual({ status: "review" });
    expect(normEntry(undefined)).toEqual({ status: "backlog" });
    expect(() => normEntry("doing")).toThrow(/unknown status/);
  });

  it("splits a task file into header lines and body", () => {
    expect(parseTaskFile("# X5: dataLayer\nType: rules\nSize: M\nDepends on: B2\n\n## Goal\nx\n")).toEqual({ title: "dataLayer", type: "rules", size: "M", deps: "B2", body: "## Goal\nx\n" });
  });

  it("keeps every card, its status, branch, note, prio and deps", () => {
    const cards = legacyCards(PLAN, { B2: { status: "review", branch: "b2-datalayer", note: "long note" }, X1: { status: "ready", prio: -1 } }, {
      B2: "# B2: dataLayer observer (MAIN world)\nType: capture\nSize: M\n\n## Goal\ndl\n\n## Acceptance criteria\n- [ ] wraps push\n",
      X1: "# X1: Fix the badge\nType: bug\nSize: S\n\n## Acceptance criteria\n- [ ] red\n",
    });
    expect(cards.map((c: { id: string }) => c.id)).toEqual(["T1", "T2", "X1", "B1", "B2", "T-1"]);
    const by = Object.fromEntries(cards.map((c: { id: string }) => [c.id, c]));
    expect(by.T1).toMatchObject({ status: "review", type: "mvp", prio: 0 });
    expect(by.T1.body).toContain("- [ ] Capture matches");
    expect(by.T2).toMatchObject({ status: "done", deps: "T1" });
    expect(by.X1).toMatchObject({ title: "Fix the badge", type: "bug", size: "S", status: "ready", prio: -1 });
    expect(by.B1).toMatchObject({ title: "Ads", status: "backlog", prio: 1, deps: "MVP" });
    expect(by.B1.body).toMatch(/^Depends on: MVP\n\n## Goal\nwhy ads/);
    expect(by.B2).toMatchObject({ title: "dataLayer observer (MAIN world)", branch: "b2-datalayer", note: "long note", status: "review" });
    expect(by.B2.body).toContain("- [ ] wraps push");
    expect(by["T-1"]).toMatchObject({ type: "triggered", prio: 1000 });
  });
});
